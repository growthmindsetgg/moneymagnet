import type { AdapterResult, Chain, HolderClassRow, HolderRow, TokenSnapshot } from "./types";
import { isEvmChain, type EvmChain } from "./chain";
import { archiveRpc, chainRpc, codeKind, makeRpc, MAX_SPAN, TRANSFER_TOPIC, addressTopic, hex, topicAddress, windowsBackward, type Rpc, type RpcLog } from "./onchain/rpc";
import { archiveWalletHistory, classifyContract, classRow, creationBlockByCode, creationSender, mintNear, monthOf, type WalletHistory } from "./onchain/holderClass";
import { infraEntry } from "./onchain/infra";
import { chainInfraEntry } from "./onchain/chainInfra";
import { fetchJson } from "./sources/http";
import { solanaRpcUrl } from "./sources/solanaCurve";
import { isProgramAddress, heliusClient } from "./timemachine/solana";
import { kvGet, kvSet } from "./kv";
import baseRpcEndpoints from "@/data/base-rpc-endpoints.json";
import monadRpcEndpoints from "@/data/monad-rpc-endpoints.json";

/** Who first sent the wallet tokens (archive search; immutable, cached for 30 days). */
async function firstReceipt(chain: EvmChain, archive: Rpc, token: string, wallet: string, fromBlock: number, head: number, deadline: number): Promise<{ block: number; from: string | null } | null> {
  const key = `first-receipt:v1:${chain}:${token}:${wallet}`;
  const hit = await kvGet<{ block: number; from: string | null }>(key).catch(() => null);
  if (hit) return hit;
  const h = await archiveWalletHistory(archive, token, wallet, { fromBlock, head, maxCalls: 130, deadline: deadline - 1_000, firstReceiptOnly: true }).catch(() => null);
  if (h?.firstReceipt) await kvSet(key, h.firstReceipt, 30 * 86_400).catch(() => undefined);
  return h?.firstReceipt ?? null;
}

/** Widest eth_getLogs span the chain's log-capable public endpoints serve. */
const logSpan = (chain: EvmChain) =>
  chain === "robinhood" ? MAX_SPAN : Math.max(...((chain === "base" ? baseRpcEndpoints : monadRpcEndpoints).endpoints as { logs: boolean; logsMaxSpan: number }[]).filter((e) => e.logs).map((e) => e.logsMaxSpan), 1_000);

/** Creation block and creation-tx sender from archive state — immutable, cached for 30 days. */
async function archiveCreation(chain: EvmChain, archive: Rpc, token: string, head: number, createdAt: string | null): Promise<{ block: number; sender: string | null } | null> {
  const key = `creation:archive:v1:${chain}:${token}`;
  const hit = await kvGet<{ block: number; sender: string | null }>(key).catch(() => null);
  if (hit) return hit;
  // Launch time known: the mint log near it (a few calls). Else bisect eth_getCode on archive state.
  const span = logSpan(chain);
  let out = createdAt ? await mintNear(chainRpc(chain), token, Math.floor(Date.parse(createdAt) / 1000), head, span).catch(() => null) : null;
  if (!out) {
    const block = await creationBlockByCode(archive, token, head).catch(() => null);
    if (block == null) return null;
    out = { block, sender: await creationSender(archive, token, block) };
  }
  if (out.sender) await kvSet(key, out, 30 * 86_400).catch(() => undefined);
  return out;
}

/** Top non-LP holders classified per run. */
export const CLASSIFIED_TOP = 5;
/** Below this share the founder rules cannot bind, so the sell history is not read. */
const FOUNDER_MIN_PCT = 20;
/** The founder softening needs this much history (days). */
export const FOUNDER_MIN_DAYS = 30;
const ZERO = "0x0000000000000000000000000000000000000000";
/** EVM addresses compare case-insensitively; Solana base58 addresses are case-sensitive. */
const key = (a: string) => (a.startsWith("0x") ? a.toLowerCase() : a);

/** Solana programs whose accounts own locked / vesting / multisig balances. */
export const SOLANA_HOLDER_PROGRAMS: Record<string, { class: "vesting" | "treasury"; label: string }> = {
  strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m: { class: "vesting", label: "vesting contract (Streamflow)" },
  LocktDzaV1W2Bm9DeZeiyz4J9zs4fRqNiYqQyracRXw: { class: "vesting", label: "vesting contract (Jupiter Lock)" },
  CChTq6PthWU82YZkbveA3WDf7s97BWhBK4Vx9bmsT743: { class: "vesting", label: "vesting contract (Bonfida)" },
  SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu: { class: "treasury", label: "treasury (multisig, Squads v3)" },
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: { class: "treasury", label: "treasury (multisig, Squads v4)" },
};

export { largestHolderLine } from "./holderLine";

interface Ctx {
  chain: Chain;
  token: string;
  s: TokenSnapshot;
  results: AdapterResult[];
  deadline: number;
}

const rawOf = <T,>(results: AdapterResult[], id: string) => results.find((r) => r.status.id === id)?.raw as T | undefined;

function deployersOf(ctx: Ctx): Set<string> {
  const set = new Set<string>();
  for (const r of ctx.results) if (r.data.deployerAddress) set.add(key(r.data.deployerAddress));
  if (ctx.s.deployerAddress) set.add(key(ctx.s.deployerAddress));
  const creation = rawOf<{ creation?: { deployer?: string } | null }>(ctx.results, "rpc")?.creation;
  if (creation?.deployer) set.add(key(creation.deployer));
  return set;
}

function isPoolish(chain: Chain, s: TokenSnapshot, address: string): boolean {
  const a = address.toLowerCase();
  if (a === ZERO || a.endsWith("dead") || s.poolAddresses.includes(a)) return true;
  if (chain === "robinhood") return !!infraEntry(a);
  if (isEvmChain(chain)) return !!chainInfraEntry(chain, a);
  return false;
}

/** The top-5 non-LP holders across the wallet and contract lists, largest first. */
function candidates(chain: Chain, s: TokenSnapshot): HolderRow[] {
  const seen = new Set<string>();
  return [...s.holders, ...s.liquidityHolders]
    .filter((h) => h.pct != null && !isPoolish(chain, s, h.address))
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
    .filter((h) => (seen.has(key(h.address)) ? false : (seen.add(key(h.address)), true)))
    .slice(0, CLASSIFIED_TOP);
}

/**
 * Classifies the top-5 non-LP holders and applies the classes to the holder math:
 * vesting / locker / staking / unclassified contracts stay excluded (listed apart, labelled); a Safe /
 * Squads treasury is counted and labelled. When the largest counted holder is the deployer, its whole
 * sell history decides the founder fields (founderNeverSold / founderSold / founderHoldDays).
 */
export async function classifyTopHolders(chain: Chain, token: string, s: TokenSnapshot, results: AdapterResult[], deadline: number): Promise<void> {
  const ctx: Ctx = { chain, token: key(token), s, results, deadline };
  const top = candidates(chain, s);
  if (!top.length) {
    s.nullReasons = { ...s.nullReasons, largestHolder: "no holder list from any source" };
    return;
  }
  const rows = isEvmChain(chain) ? await classifyEvm(ctx, chain, top) : await classifySolana(ctx, top);
  s.holderClasses = rows;
  applyHolderClasses(s, rows);
  const largest = s.holders[0] ? rows.find((r) => r.address === key(s.holders[0].address)) ?? null : null;
  s.largestHolder = largest;
  if (largest?.class === "founder" && (largest.pct ?? 0) > FOUNDER_MIN_PCT) await founderHistory(ctx, largest);
  else if (largest) {
    // Not the deployer (or below the founder rules' 20%): the normal caps apply.
    s.founderNeverSold = false;
    s.nullReasons = { ...s.nullReasons, founderSold: largest.class === "founder" ? `founder holds ≤ ${FOUNDER_MIN_PCT}% — sell history not read` : "largest holder is not the deployer" };
  }
}

/** Moves Safe treasuries into the counted list and vesting / lockers out of it, then re-derives the concentration metrics. */
export function applyHolderClasses(s: TokenSnapshot, rows: HolderClassRow[]) {
  const byAddr = new Map(rows.map((r) => [r.address, r]));
  let changed = false;
  const label = (h: HolderRow): HolderRow => {
    const r = byAddr.get(key(h.address));
    return r ? { ...h, label: r.label } : h;
  };
  const wallets: HolderRow[] = [];
  const held: HolderRow[] = [];
  for (const h of s.holders.map(label)) {
    const r = byAddr.get(key(h.address));
    if (r && !r.counted) {
      held.push({ ...h, kind: "liquidity" });
      changed = true;
    } else wallets.push(h);
  }
  for (const h of s.liquidityHolders.map(label)) {
    const r = byAddr.get(key(h.address));
    if (r?.counted) {
      wallets.push({ ...h, kind: "wallet" });
      changed = true;
    } else held.push(h);
  }
  s.holders = wallets.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  s.liquidityHolders = held.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  if (!changed) return;
  const now = new Date().toISOString();
  const top1 = s.holders[0]?.pct ?? 0;
  const top10 = Math.round(s.holders.slice(0, 10).reduce((a, h) => a + (h.pct ?? 0), 0) * 100) / 100;
  const prov = (metric: string, value: number) => {
    s.provenance = { ...s.provenance, [metric]: [...(s.provenance[metric] ?? []), { source: "holder-class", label: "Holder classification (derived)", value, fetchedAt: now, onchain: true }] };
  };
  s.top1SharePct = top1;
  s.top10SharePct = top10;
  prov("top1SharePct", top1);
  prov("top10SharePct", top10);
  s.liquidityHeldPct = Math.round(s.liquidityHolders.reduce((a, h) => a + (h.pct ?? 0), 0) * 100) / 100;
}

async function classifyEvm(ctx: Ctx, chain: EvmChain, top: HolderRow[]): Promise<HolderClassRow[]> {
  const rpc: Rpc = chain === "robinhood" ? makeRpc() : chainRpc(chain);
  const deployers = deployersOf(ctx);
  const codes = await Promise.all(top.map((h) => rpc<string>("eth_getCode", [h.address, "latest"], 10_000).catch(() => null)));
  const rows = await Promise.all(
    top.map(async (h, i): Promise<HolderClassRow> => {
      const a = h.address.toLowerCase();
      const code = codes[i];
      if (code == null) return classRow({ address: a, pct: h.pct, class: h.kind === "wallet" ? "wallet" : "contract", label: h.kind === "wallet" ? "wallet" : "unclassified contract", detail: null, unlocksAt: null, evidence: "eth_getCode failed — class from the source's contract flag" });
      if (codeKind(code) === "wallet") {
        const what = code.length > 2 ? `EIP-7702 / minimal code (${(code.length - 2) / 2} B)` : "no code (EOA)";
        if (deployers.has(a)) return classRow({ address: a, pct: h.pct, class: "founder", label: "founder wallet (deployer)", detail: null, unlocksAt: null, evidence: `${what}; equals the deployer / creator` });
        return classRow({ address: a, pct: h.pct, class: "wallet", label: "wallet", detail: null, unlocksAt: null, evidence: `${what}; not the deployer (${[...deployers].map((d) => d.slice(0, 8) + "…").join(", ") || "deployer unknown"})` });
      }
      const v = await classifyContract(rpc, a, ctx.token, code).catch((e: Error) => ({ class: "contract" as const, label: "unclassified contract", unlocksAt: null, detail: null, evidence: `classification failed: ${e.message.slice(0, 80)}` }));
      return classRow({ address: a, pct: h.pct, class: v.class, label: v.label, detail: v.detail ?? (v.unlocksAt ? `unlocks ${monthOf(v.unlocksAt)}` : null), unlocksAt: v.unlocksAt, evidence: v.evidence });
    }),
  );
  // A large EOA that no source names as deployer: the creation tx's sender is the deployer too (archive state).
  const big = rows.find((r) => r.class === "wallet" && (r.pct ?? 0) > FOUNDER_MIN_PCT);
  const archive = chain === "robinhood" ? null : archiveRpc(chain);
  if (big && archive && Date.now() < ctx.deadline - 3_000) {
    const head = Number(await archive<string>("eth_blockNumber", []));
    const created = await archiveCreation(chain, archive, ctx.token, head, ctx.s.createdAt);
    const block = created?.block ?? null;
    const sender = created?.sender ?? null;
    if (sender) {
      deployers.add(sender);
      if (sender === big.address) Object.assign(big, classRow({ ...big, class: "founder", label: "founder wallet (deployer)", evidence: `${big.evidence.split(";")[0]}; sent the creation tx (block ${block})` }));
      else {
        // Who funded it: the first Transfer into the wallet (archive bisection on balanceOf).
        const fr = await firstReceipt(chain, archive, ctx.token, big.address, block!, head, ctx.deadline);
        const from = fr?.from ?? null;
        big.evidence = `${big.evidence.split(";")[0]}; not the deployer (creation tx sent by ${sender}${[...deployers].filter((d) => d !== sender).map((d) => `, creator ${d}`).join("")})${from ? `; first tokens received from ${from} at block ${fr!.block}` : ""}`;
        if (from && deployers.has(from)) big.label = "wallet funded by the deployer";
      }
    }
  }
  if (big && chain === "robinhood" && Date.now() < ctx.deadline - 3_000) {
    const creation = rawOf<{ creation?: { creationBlock: number } | null }>(ctx.results, "rpc")?.creation;
    if (creation) {
      const head = Number(await rpc<string>("eth_blockNumber", []));
      const first = await firstInbound(rpc, ctx.token, big.address, creation.creationBlock, head).catch(() => null);
      if (first) {
        big.evidence = `${big.evidence}; first tokens received from ${first.from} at block ${first.block}`;
        if (deployers.has(first.from)) big.label = "wallet funded by the deployer";
      }
    }
  }
  return rows;
}

async function classifySolana(ctx: Ctx, top: HolderRow[]): Promise<HolderClassRow[]> {
  const deployers = deployersOf(ctx);
  const owners = top.map((h) => h.address);
  const res = await fetchJson<{ result?: { value: ({ owner: string; executable: boolean } | null)[] } }>(solanaRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [owners, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }] }),
    timeoutMs: 10_000,
  }).catch(() => null);
  const accts = res?.result?.value ?? owners.map(() => undefined);
  return top.map((h, i): HolderClassRow => {
    const a = h.address;
    const acct = accts[i];
    const program = acct?.owner ?? null;
    const known = program ? SOLANA_HOLDER_PROGRAMS[program] : undefined;
    if (known) return classRow({ address: a, pct: h.pct, class: known.class, label: known.label, detail: null, unlocksAt: null, evidence: `account owned by program ${program} — schedule not read` });
    if (acct === undefined) return classRow({ address: a, pct: h.pct, class: "wallet", label: "wallet", detail: null, unlocksAt: null, evidence: "getMultipleAccounts failed — kept as listed by the source" });
    const offCurve = isProgramAddress(a);
    if (deployers.has(a) && !offCurve) return classRow({ address: a, pct: h.pct, class: "founder", label: "founder wallet (deployer)", detail: null, unlocksAt: null, evidence: "on-curve key; equals the creator" });
    // Off-curve, not a known lock / multisig program: kept where the source put it (counted), labelled.
    return classRow({
      address: a,
      pct: h.pct,
      class: "wallet",
      label: offCurve ? "program-owned address (unclassified)" : "wallet",
      detail: null,
      unlocksAt: null,
      evidence: offCurve ? `off-curve address${program ? ` (account owner ${program})` : ""}; no lock / multisig program matched` : `on-curve key${program ? ` (account owner ${program})` : ""}; not the creator`,
    });
  });
}

/** The founder wallet's whole sell history (chain-specific), then the founder fields. */
async function founderHistory(ctx: Ctx, f: HolderClassRow): Promise<void> {
  const { s } = ctx;
  const age = s.ageHours;
  let sells: number | null = null;
  let complete = false;
  let reason: string | null = null;
  let method = "";
  let days = age != null ? Math.floor(age / 24) : null;
  try {
    if (ctx.chain === "robinhood") {
      const raw = rawOf<{ creation?: { deployer: string } | null; deployer?: { sentToContracts: string; sentToWallets: string } }>(ctx.results, "rpc");
      const swap = s.swapHolders.find((h) => h.address.toLowerCase() === f.address);
      if (raw?.creation?.deployer?.toLowerCase() === f.address && raw.deployer) {
        const sold = BigInt(raw.deployer.sentToContracts) > 0n;
        sells = (sold ? 1 : 0) + (swap?.sells ?? 0);
        complete = true;
        method = `deployer Transfer logs since creation: ${sold ? "tokens moved in swaps / into contracts" : "nothing sold or sent to a pool / router"}${swap?.sells != null ? `; HoodScan swap index: ${swap.sells} sells` : ""}`;
      } else reason = "deployer flows not read for this wallet (Robinhood RPC)";
    } else if (ctx.chain === "base" || ctx.chain === "monad") {
      const archive = archiveRpc(ctx.chain);
      if (!archive) reason = `no archive ${ctx.chain} RPC configured`;
      else {
        const head = Number(await archive<string>("eth_blockNumber", []));
        const from = (await archiveCreation(ctx.chain, archive, ctx.token, head, s.createdAt))?.block ?? 0;
        const h: WalletHistory = await archiveWalletHistory(archive, ctx.token, f.address, { fromBlock: from, head, maxCalls: 220, deadline: ctx.deadline - 1_000, isPool: (a) => isPoolish(ctx.chain, s, a) });
        let swapSells = 0;
        let swapNote = "";
        if (ctx.chain === "monad") {
          const nf = await nadfunSells(ctx.token, f.address);
          if (nf.sells == null) {
            reason = nf.note;
          } else {
            swapSells = nf.sells;
            swapNote = `; nad.fun swap history: ${nf.note}`;
          }
        }
        sells = h.toPools + swapSells;
        complete = h.complete && reason == null;
        reason = reason ?? h.reason;
        method = `${h.method}${swapNote}; ${h.transfersOut} transfers to wallets`;
        if (h.firstReceipt) {
          const b = await archive<{ timestamp: string } | null>("eth_getBlockByNumber", [hex(h.firstReceipt.block), false]).catch(() => null);
          if (b) days = Math.floor((Date.now() / 1000 - Number(b.timestamp)) / 86_400);
        }
      }
    } else {
      const r = await solanaFounderHistory(f.address, s);
      sells = r.sells;
      complete = r.complete;
      reason = r.reason;
      method = r.method;
    }
  } catch (e) {
    reason = `sell history lookup failed: ${(e as Error).message.slice(0, 80)}`;
  }
  s.founderHoldDays = days;
  f.evidence = `${f.evidence}; ${method || reason}`;
  if (sells != null && sells > 0) {
    s.founderSold = true;
    s.founderNeverSold = false;
    f.detail = `${sells} sell${sells === 1 ? "" : "s"} — founder started selling`;
    return;
  }
  if (!complete) {
    s.nullReasons = { ...s.nullReasons, founderNeverSold: reason ?? "sell history incomplete", founderSold: reason ?? "sell history incomplete" };
    f.detail = `sell history not fully read (${reason})`;
    return;
  }
  s.founderSold = false;
  s.founderNeverSold = days != null && days >= FOUNDER_MIN_DAYS;
  if (days == null) s.nullReasons = { ...s.nullReasons, founderHoldDays: "token age unknown" };
  f.detail = `0 sells in ${days ?? "?"}d`;
}

/** nad.fun's swap index for one account on one token (curve and DEX), every page. */
async function nadfunSells(token: string, account: string): Promise<{ sells: number | null; note: string }> {
  const headers = process.env.NAD_API_KEY ? { "X-API-Key": process.env.NAD_API_KEY } : undefined;
  let sells = 0;
  let buys = 0;
  for (let page = 1; page <= 5; page++) {
    const r = await fetchJson<{ swaps?: { swap_info: { event_type: string } }[]; total_count?: number }>(`https://api.nad.fun/agent/swap-history/${token}?limit=100&page=${page}&account_id=${account}`, { headers, timeoutMs: 10_000 }).catch((e: Error) => e);
    if (r instanceof Error) return { sells: null, note: `nad.fun swap history failed: ${r.message.slice(0, 80)}` };
    for (const x of r.swaps ?? []) {
      if (x.swap_info.event_type === "SELL") sells++;
      else buys++;
    }
    if ((r.swaps?.length ?? 0) < 100 || buys + sells >= (r.total_count ?? 0)) return { sells, note: `${buys} buys, ${sells} sells` };
  }
  return { sells: sells > 0 ? sells : null, note: `more than 500 swaps — only the latest 500 read` };
}

interface TokenBal {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
interface SolTx {
  meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } };
}

/** The creator's whole history when it has < 100 transactions (Helius): a token outflow paid in SOL, or into an off-curve owner, is a sell. */
async function solanaFounderHistory(creator: string, s: TokenSnapshot): Promise<{ sells: number | null; complete: boolean; reason: string | null; method: string }> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return { sells: null, complete: false, reason: "Helius key not set", method: "" };
  const call = heliusClient(key);
  const page = await call<{ data: SolTx[] }>("getTransactionsForAddress", [creator, { sortOrder: "asc", limit: 100, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
  if (page.data.length >= 100) return { sells: null, complete: false, reason: "creator has ≥ 100 transactions — whole history not read per request", method: "" };
  const mint = s.address;
  const amt = (list: TokenBal[] | undefined, owner: string) => (list ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  let sells = 0;
  let transfers = 0;
  for (const tx of page.data) {
    const m = tx.meta;
    if (!m || m.err) continue;
    if (amt(m.preTokenBalances, creator) - amt(m.postTokenBalances, creator) <= 0n) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    const i = keys.indexOf(creator);
    const solIn = i >= 0 ? m.postBalances[i] - m.preBalances[i] : 0;
    const gainers = [...new Set((m.postTokenBalances ?? []).filter((b) => b.mint === mint && b.owner && b.owner !== creator).map((b) => b.owner!))].filter((o) => amt(m.postTokenBalances, o) > amt(m.preTokenBalances, o));
    if (solIn > 0 || gainers.some(isProgramAddress)) sells++;
    else transfers++;
  }
  return { sells, complete: true, reason: null, method: `whole creator history (${page.data.length} txs, Helius): ${sells} sells / pool transfers, ${transfers} transfers to wallets` };
}

// Robinhood: the earliest Transfer into a wallet (who funded it), from filtered logs.
export async function firstInbound(rpc: Rpc, token: string, wallet: string, fromBlock: number, head: number): Promise<{ from: string; block: number } | null> {
  for (const [f, t] of windowsBackward(fromBlock, head, MAX_SPAN).reverse()) {
    const logs = await rpc<RpcLog[]>("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC, null, addressTopic(wallet)], fromBlock: hex(f), toBlock: hex(t) }]);
    if (logs.length) return { from: topicAddress(logs[0].topics[1]), block: Number(logs[0].blockNumber) };
  }
  return null;
}
