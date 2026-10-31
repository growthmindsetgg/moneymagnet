import type { AdapterResult, HolderRow, TokenSnapshot } from "../types";
import { fetchJson } from "./http";
import { heliusRpc } from "./heliusQueue";
import { isOutage } from "./retry";
import { kvGet, kvSet } from "../kv";
import { isProgramAddress } from "../timemachine/solana";
import { bondingCurveAddress, decodeCurve, PUMP_PROGRAM } from "./solanaCurve";

export const HELIUS_NOT_SET = "Helius key not set";

/** Metrics only Helius can supply here; null with "Helius key not set" when the key is missing. */
export const HELIUS_METRICS = [
  "freshWalletsTop20",
  "fundingClusterMax",
  "clusterSupplyPct",
  "creatorPriorMints",
  "creatorRugRatePct",
  "allBuyersExited",
  "uniqueBuyers",
  "makersCount",
  "devBuySharePct",
  "devBuySol",
  "snipeRatioPct",
  "deployerSoldPct",
] as const;

const LAMPORTS = 1e9;
/** Shared platform authorities that DAS reports as "creator" for every token they launch. Never a creator. */
export const PLATFORM_AUTHORITIES = new Set([
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM", // pump.fun metadata update authority (seen as "creator" on every pump.fun mint)
]);
/** Curve trades replayed per request; current balances decide "all buyers exited" beyond it. */
const MAX_TRADE_TXS = 200;

interface TokenBal {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}
export interface ParsedTx {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[]; instructions?: { parsed?: { type?: string; info?: Record<string, unknown> }; program?: string }[] } };
}

export interface CurveTradeStats {
  uniqueBuyers: number;
  sellers: number;
  sellCount: number;
  makers: number;
  creatorBought: bigint;
  creatorSold: bigint;
  creatorSolSpent: number;
  totalBought: bigint;
  snipedInFirstSlots: bigint;
  /** owner → last observed balance (raw units). */
  lastBalance: Map<string, bigint>;
  firstBuyTime: Map<string, number>;
  buyers: Set<string>;
}

const keyOf = (k: { pubkey: string } | string) => (typeof k === "string" ? k : k.pubkey);

/**
 * Turns successful bonding-curve transactions into buy/sell flows per wallet from the token-balance
 * deltas (no instruction decoding needed): the curve's balance falls on a buy and rises on a sell.
 */
export function parseCurveTrades(txs: ParsedTx[], mint: string, curve: string, creator: string | null, snipeSlots = 2): CurveTradeStats {
  const ordered = [...txs].filter((t) => t.meta && !t.meta.err).sort((a, b) => a.slot - b.slot);
  const firstSlot = ordered[0]?.slot ?? 0;
  const stats: CurveTradeStats = {
    uniqueBuyers: 0,
    sellers: 0,
    sellCount: 0,
    makers: 0,
    creatorBought: 0n,
    creatorSold: 0n,
    creatorSolSpent: 0,
    totalBought: 0n,
    snipedInFirstSlots: 0n,
    lastBalance: new Map(),
    firstBuyTime: new Map(),
    buyers: new Set(),
  };
  const sellers = new Set<string>();
  for (const tx of ordered) {
    const pre = new Map<string, bigint>();
    const post = new Map<string, bigint>();
    for (const b of tx.meta!.preTokenBalances ?? []) if (b.mint === mint && b.owner) pre.set(b.owner, (pre.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount));
    for (const b of tx.meta!.postTokenBalances ?? []) if (b.mint === mint && b.owner) post.set(b.owner, (post.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount));
    const owners = new Set([...pre.keys(), ...post.keys()]);
    const curveDelta = (post.get(curve) ?? 0n) - (pre.get(curve) ?? 0n);
    // The creation tx initialises the curve's token account (no pre-balance) and usually carries
    // the dev buy: the curve "gains" the unsold supply, but anyone else gaining tokens is buying.
    const curveCreated = !pre.has(curve) && post.has(curve);
    let sold = false;
    for (const o of owners) {
      if (o === curve) continue;
      const delta = (post.get(o) ?? 0n) - (pre.get(o) ?? 0n);
      stats.lastBalance.set(o, post.get(o) ?? 0n);
      if (delta > 0n && (curveDelta < 0n || curveCreated)) {
        stats.buyers.add(o);
        stats.totalBought += delta;
        if (!stats.firstBuyTime.has(o) && tx.blockTime) stats.firstBuyTime.set(o, tx.blockTime);
        if (tx.slot - firstSlot < snipeSlots) stats.snipedInFirstSlots += delta;
        if (o === creator) {
          stats.creatorBought += delta;
          const keys = tx.transaction.message.accountKeys.map(keyOf);
          const i = keys.indexOf(creator);
          if (i >= 0) stats.creatorSolSpent += (tx.meta!.preBalances[i] - tx.meta!.postBalances[i]) / LAMPORTS;
        }
      } else if (delta < 0n && curveDelta > 0n && !curveCreated) {
        sellers.add(o);
        sold = true;
        if (o === creator) stats.creatorSold += -delta;
      }
    }
    if (sold) stats.sellCount++;
  }
  stats.uniqueBuyers = stats.buyers.size;
  stats.sellers = sellers.size;
  stats.makers = new Set([...stats.buyers, ...sellers]).size;
  return stats;
}

/** Guide p.25 clusters: wallets funded by the same source within `windowSec` of each other. */
export function fundingClusters(funding: { wallet: string; funder: string | null; time: number | null; pct: number | null }[], windowSec = 7200) {
  const byFunder = new Map<string, { wallet: string; time: number; pct: number | null }[]>();
  for (const f of funding) {
    if (!f.funder || f.time == null) continue;
    byFunder.set(f.funder, [...(byFunder.get(f.funder) ?? []), { wallet: f.wallet, time: f.time, pct: f.pct }]);
  }
  let best: { wallet: string; time: number; pct: number | null }[] = [];
  for (const list of byFunder.values()) {
    list.sort((a, b) => a.time - b.time);
    for (let i = 0; i < list.length; i++) {
      const group = list.filter((x) => x.time >= list[i].time && x.time - list[i].time <= windowSec);
      if (group.length > best.length) best = group;
    }
  }
  return { size: best.length, supplyPct: best.reduce((a, x) => a + (x.pct ?? 0), 0), wallets: best.map((x) => x.wallet) };
}

export async function helius(mint: string): Promise<AdapterResult> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) {
    return {
      status: { id: "helius", label: "Helius", state: "skipped", message: HELIUS_NOT_SET },
      data: { nullReasons: Object.fromEntries(HELIUS_METRICS.map((m) => [m, HELIUS_NOT_SET])) },
    };
  }
  const t0 = Date.now();
  // One global queue (≤ 2 in flight, 100ms spacing, 429 backoff, 2-minute cache) for every Helius call.
  const { call: queuedCall, batch } = heliusRpc(key);
  const call = <T,>(method: string, params: unknown) => queuedCall<T>(method, params, 15_000);

  const notes: string[] = [];
  const data: Partial<TokenSnapshot> = {};
  const nullReasons: Record<string, string> = {};
  // Fields whose call hit an outage (429 / 5xx / timeout): not answers, so they may come back stale.
  const failed = new Map<string, string>();
  const lost = (fields: readonly string[]) => (e: unknown) => {
    if (isOutage(e)) for (const f of fields) if (!failed.has(f)) failed.set(f, `Helius call failed: ${(e as Error).message.slice(0, 80)}`);
    return null;
  };

  const asset = await call<{
    authorities?: { address: string }[];
    creators?: { address: string }[];
    token_info?: { supply?: number; decimals?: number; mint_authority?: string; freeze_authority?: string };
  }>("getAsset", { id: mint });
  const ti = asset.token_info;
  const decimals = ti?.decimals ?? 6;
  const supplyRaw = ti?.supply != null ? BigInt(Math.round(ti.supply)) : null;
  data.mintAuthority = ti ? !!ti.mint_authority : null;
  data.freezeAuthority = ti ? !!ti.freeze_authority : null;

  // Holders: largest token accounts → owners.
  const largest = await call<{ value: { address: string; amount: string }[] }>("getTokenLargestAccounts", [mint]);
  const accts = await call<{ value: ({ data: { parsed: { info: { owner: string } } } } | null)[] }>("getMultipleAccounts", [
    largest.value.map((a) => a.address),
    { encoding: "jsonParsed" },
  ]);
  const holders: HolderRow[] = largest.value.map((a, i) => ({
    address: accts.value[i]?.data.parsed.info.owner ?? a.address,
    qty: Number(a.amount) / 10 ** decimals,
    pct: supplyRaw ? Number((BigInt(a.amount) * 1_000_000n) / supplyRaw) / 10_000 : null,
    buys: null,
    sells: null,
    isContract: null,
  }));
  data.holders = holders;
  data.holderSource = "helius";

  // Bonding-curve trades (pre-graduation pump.fun tokens with a manageable history).
  const curve = bondingCurveAddress(mint);
  // Graduated tokens trade on an AMM: curve buyers are only the pre-graduation subset, so they
  // must not stand in for the token's unique buyers.
  const curveAcct = await call<{ value: { owner: string; data: [string, string] } | null }>("getAccountInfo", [curve, { encoding: "base64" }]).catch(lost(["uniqueBuyers"]));
  const graduated = curveAcct?.value?.owner === PUMP_PROGRAM ? decodeCurve(Uint8Array.from(Buffer.from(curveAcct.value.data[0], "base64"))).complete : false;
  // Creator = the fee payer of the mint's creation transaction (exact). DAS creators are only used
  // when they are not a shared platform authority; pump.fun metadata never names the real creator.
  // The creation tx (oldest mint signature) is also the on-chain truth for the token's age.
  let creator: string | null = asset.creators?.map((c) => c.address).find((a) => !PLATFORM_AUTHORITIES.has(a)) ?? null;
  // The creation tx straight from Helius' oldest-first history (works however long the history is).
  const firstPage = await call<{ data: ParsedTx[] }>("getTransactionsForAddress", [mint, { sortOrder: "asc", limit: 1, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]).catch(lost(["createdAt"]));
  let createTx: ParsedTx | null = firstPage?.data?.[0] ?? null;
  if (!createTx) {
    const mintSigs = await call<{ signature: string; blockTime: number | null }[]>("getSignaturesForAddress", [mint, { limit: 1000 }]).catch((e) => (lost(["createdAt"])(e), []));
    if (mintSigs.length && mintSigs.length < 1000) createTx = await call<ParsedTx>("getTransaction", [mintSigs[mintSigs.length - 1].signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]).catch(lost(["createdAt"]));
    else if (mintSigs.length >= 1000) nullReasons.createdAt = "creation tx not reachable (oldest-first history unavailable, > 1000 mint signatures)";
  }
  if (createTx?.blockTime) data.createdAt = new Date(createTx.blockTime * 1000).toISOString();
  if (!creator && createTx) {
    const payer = createTx.transaction.message.accountKeys[0];
    creator = payer ? keyOf(payer) : null;
  }
  // The creator's token balance right after creation (its dev buy inside the creation tx).
  const creatorAtCreation =
    creator && createTx?.meta ? (createTx.meta.postTokenBalances ?? []).filter((b) => b.mint === mint && b.owner === creator).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n) : null;
  if (creator) data.deployerAddress = creator;
  const sigs = await call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [curve, { limit: 1000 }]).catch((e) => (lost(CURVE_FIELDS)(e), []));
  const ok = sigs.filter((s) => !s.err);
  if (!sigs.length && failed.has("allBuyersExited")) {
    for (const m of CURVE_FIELDS) nullReasons[m] = failed.get(m)!;
  } else if (!sigs.length) {
    for (const m of ["allBuyersExited", "uniqueBuyers", "makersCount", "devBuySharePct", "devBuySol", "snipeRatioPct"]) nullReasons[m] = "no pump.fun bonding-curve history for this mint";
  } else if (sigs.length >= 1000 || ok.length > MAX_TRADE_TXS) {
    for (const m of ["allBuyersExited", "uniqueBuyers", "makersCount", "devBuySharePct", "devBuySol", "snipeRatioPct"]) nullReasons[m] = `curve history too long to replay per request (> ${MAX_TRADE_TXS} trades)`;
  } else {
    const txs = await batch<ParsedTx>(
      "getTransaction",
      ok.map((s) => [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]),
    );
    const t = parseCurveTrades(txs.filter(Boolean), mint, curve, creator);
    if (graduated) nullReasons.uniqueBuyers = "graduated — curve buyers are only the pre-graduation subset (AMM buyers not counted)";
    else data.uniqueBuyers = t.uniqueBuyers;
    data.makersCount = t.makers;
    if (creator) {
      data.devBuySharePct = t.totalBought > 0n ? Number((t.creatorBought * 10_000n) / t.totalBought) / 100 : 0;
      data.devBuySol = t.creatorSolSpent;
    } else {
      nullReasons.devBuySharePct = nullReasons.devBuySol = "creator wallet not identifiable (history older than the 1000 most recent mint transactions)";
    }
    if (creator && t.creatorBought > 0n) data.deployerSoldPct = Math.min(100, Number((t.creatorSold * 10_000n) / t.creatorBought) / 100);
    else if (creator) data.deployerSoldPct = 0; // the creator never bought on the curve: nothing sold
    if (supplyRaw) data.snipeRatioPct = Number((t.snipedInFirstSlots * 10_000n) / supplyRaw) / 100;
    const holding = [...t.buyers].filter((b) => (t.lastBalance.get(b) ?? 0n) > 0n);
    // Current on-chain balances decide when we have them: the largest token accounts right now.
    // No wallet (on-curve key) holding anything ⇒ every buyer is out, whatever the trade log says.
    // Dust (< 0.001% of supply) left after selling is not a holding.
    const walletsNow = holders.filter((h) => (h.pct ?? 0) >= 0.001 && !isProgramAddress(h.address));
    data.allBuyersExited = t.uniqueBuyers >= 5 && t.sellers > 0 && (holders.length ? walletsNow.length === 0 : holding.length === 0);
    notes.push(`${ok.length} curve trades: ${t.uniqueBuyers} buyers, ${t.sellers} sellers, ${holding.length} still holding`);
  }

  // Fresh wallets + funding sources for the top-20 holder wallets (curve excluded).
  const wallets = holders.filter((h) => h.address !== curve).slice(0, 20);
  const funding = await Promise.all(
    wallets.map(async (w) => {
      // A wallet's first transaction (and its funder) never changes: cached in KV for 7 days.
      const originKey = `helius:origin:v1:${w.address}`;
      const known = await kvGet<{ funder: string | null; firstTx: number }>(originKey);
      if (known) return { wallet: w.address, funder: known.funder, time: known.firstTx, firstTx: known.firstTx as number | null, pct: w.pct };
      const s = await call<{ signature: string; blockTime: number | null }[]>("getSignaturesForAddress", [w.address, { limit: 1000 }]).catch(lost(FUNDING_FIELDS));
      if (!s || !s.length || s.length >= 1000) return { wallet: w.address, funder: null, time: null, firstTx: null as number | null, pct: w.pct };
      const oldest = s[s.length - 1];
      const tx = await call<ParsedTx>("getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]).catch(lost(FUNDING_FIELDS));
      const transfer = tx?.transaction.message.instructions?.find((ix) => ix.parsed?.type === "transfer" && ix.parsed.info?.destination === w.address);
      const funder = (transfer?.parsed?.info?.source as string) ?? null;
      if (tx && oldest.blockTime) await kvSet(originKey, { funder, firstTx: oldest.blockTime }, 7 * 86_400);
      return { wallet: w.address, funder, time: oldest.blockTime, firstTx: oldest.blockTime, pct: w.pct };
    }),
  );
  const now = Date.now() / 1000;
  const clusters = fundingClusters(funding);
  // A wallet whose history lookup was rate limited is unknown, not "not fresh": no count from a partial set.
  if (failed.has("freshWalletsTop20")) for (const m of FUNDING_FIELDS) nullReasons[m] = failed.get(m)!;
  else {
    data.freshWalletsTop20 = funding.filter((f) => f.firstTx != null && now - f.firstTx < 24 * 3600).length;
    data.fundingClusterMax = clusters.size;
    data.clusterSupplyPct = clusters.size >= 2 ? clusters.supplyPct : 0;
  }

  // Creator's current balance: holding share, and — when the curve replay could not say — the share
  // sold since creation (balance at creation → now; derived, labelled).
  if (creator && supplyRaw) {
    const accts = await call<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>("getTokenAccountsByOwner", [creator, { mint }, { encoding: "jsonParsed" }]).catch(lost(["deployerHoldingPct"]));
    if (accts) {
      const now = accts.value.reduce((a, v) => a + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n);
      if (data.deployerHoldingPct == null) data.deployerHoldingPct = Number((now * 1_000_000n) / supplyRaw) / 10_000;
      if (data.deployerSoldPct == null && creatorAtCreation != null) {
        if (creatorAtCreation === 0n && now === 0n) data.deployerSoldPct = 0; // no dev buy, holds nothing: nothing sold
        else {
          // What left the creator's wallet: a sale when the same tx paid the creator SOL (a swap),
          // distribution otherwise (transfers to wallets are shown, not penalised) — v2.3 §5.
          const page = await call<{ data: ParsedTx[] }>("getTransactionsForAddress", [creator, { sortOrder: "desc", limit: 100, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]).catch(lost(["deployerSoldPct", "deployerDistributedPct"]));
          if (page) {
            let sold = 0n;
            let moved = 0n;
            for (const tx of page.data) {
              if (!tx.meta || tx.meta.err) continue;
              const bal = (list: TokenBal[] | undefined) => (list ?? []).filter((b) => b.mint === mint && b.owner === creator).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
              const out = bal(tx.meta.preTokenBalances) - bal(tx.meta.postTokenBalances);
              if (out <= 0n) continue;
              const i = tx.transaction.message.accountKeys.map(keyOf).indexOf(creator);
              const solIn = i >= 0 ? tx.meta.postBalances[i] - tx.meta.preBalances[i] : 0;
              const wsol = (list: TokenBal[] | undefined) => (list ?? []).filter((b) => b.mint === "So11111111111111111111111111111111111111112" && b.owner === creator).reduce((a, b) => a + Number(b.uiTokenAmount.amount), 0);
              if (solIn + wsol(tx.meta.postTokenBalances) - wsol(tx.meta.preTokenBalances) > 0) sold += out;
              else moved += out;
            }
            const base = creatorAtCreation > 0n ? creatorAtCreation : sold + moved;
            data.deployerSoldPct = base > 0n ? Math.min(100, Number((sold * 10_000n) / base) / 100) : 0;
            data.deployerDistributedPct = base > 0n ? Math.min(100, Number((moved * 10_000n) / base) / 100) : 0;
            notes.push(`creator: ${(Number(creatorAtCreation) / 10 ** decimals).toFixed(0)} at creation → ${(Number(now) / 10 ** decimals).toFixed(0)} now; sold ${data.deployerSoldPct.toFixed(1)}% in swaps, distributed ${data.deployerDistributedPct.toFixed(1)}% (last ${page.data.length} creator txs)`);
          }
        }
      }
    }
  }

  // Creator history: prior mints (DAS) and how many of them are dead on DexScreener — cached 24h per creator.
  if (creator) {
    const historyKey = `helius:creator:v1:${creator}`;
    let hist = await kvGet<{ prior: number; rugRatePct: number | null; reason?: string }>(historyKey);
    if (!hist) {
      const assets = await call<{ items: { id: string }[] }>("getAssetsByCreator", { creatorAddress: creator, onlyVerified: false, page: 1, limit: 50 }).catch(lost(["creatorPriorMints", "creatorRugRatePct"]));
      const prior = (assets?.items ?? []).map((a) => a.id).filter((id) => id !== mint).slice(0, 30);
      if (!assets) hist = null;
      else if (!prior.length) hist = { prior: 0, rugRatePct: 0 }; // no prior mints: 0 rugged (zero is data)
      else {
        const pairs = await fetchJson<{ baseToken: { address: string }; liquidity?: { usd?: number } }[]>(`https://api.dexscreener.com/tokens/v1/solana/${prior.join(",")}`).catch(() => null);
        if (pairs) {
          const liq = new Map<string, number>();
          for (const p of pairs) liq.set(p.baseToken.address, (liq.get(p.baseToken.address) ?? 0) + (p.liquidity?.usd ?? 0));
          hist = { prior: prior.length, rugRatePct: (prior.filter((id) => (liq.get(id) ?? 0) < 1000).length / prior.length) * 100 };
        } else hist = { prior: prior.length, rugRatePct: null, reason: "DexScreener lookup of prior mints failed" };
      }
      if (hist && hist.rugRatePct != null) await kvSet(historyKey, hist, 86_400);
    }
    if (!hist) nullReasons.creatorPriorMints = nullReasons.creatorRugRatePct = "Helius DAS getAssetsByCreator failed";
    else {
      data.creatorPriorMints = hist.prior;
      if (hist.rugRatePct != null) data.creatorRugRatePct = hist.rugRatePct;
      else nullReasons.creatorRugRatePct = hist.reason ?? "unknown";
    }
  } else {
    nullReasons.creatorPriorMints = nullReasons.creatorRugRatePct = "creator wallet not identifiable (DAS lists only the platform authority; creation tx beyond the last 1000 mint signatures)";
  }

  // Without the curve account the graduation state is unknown, so curve buyers cannot stand for unique buyers.
  if (failed.has("uniqueBuyers") && data.uniqueBuyers != null) {
    delete data.uniqueBuyers;
    nullReasons.uniqueBuyers = failed.get("uniqueBuyers")!;
  }
  for (const [m, reason] of failed) if ((data as Record<string, unknown>)[m] == null) nullReasons[m] ??= reason;
  const failedFields = [...failed.keys()].filter((m) => (data as Record<string, unknown>)[m] == null);

  data.nullReasons = nullReasons;
  return {
    status: {
      id: "helius",
      label: "Helius",
      state: failedFields.length ? "partial" : "ok",
      message: [notes.join(" · ") || "holders, wallet age, funding, creator history", failedFields.length ? `${failedFields.length} fields lost to a Helius outage` : ""].filter(Boolean).join(" · "),
      ms: Date.now() - t0,
    },
    data,
    raw: { creator, curve, funding, clusters },
    ...(failedFields.length ? { failedFields } : {}),
  };
}

const CURVE_FIELDS = ["allBuyersExited", "uniqueBuyers", "makersCount", "devBuySharePct", "devBuySol", "snipeRatioPct", "deployerSoldPct"] as const;
const FUNDING_FIELDS = ["freshWalletsTop20", "fundingClusterMax", "clusterSupplyPct"] as const;
