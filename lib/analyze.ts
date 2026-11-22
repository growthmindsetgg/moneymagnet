import type { AdapterResult, Chain, ScoreReport, SourceStatus, TokenSnapshot } from "./types";
import { applyZeroActivity, deadLaunchOf, deriveMetrics, emptySnapshot, mergeSnapshots } from "./snapshot";
import { scoreSnapshot, SOURCE_LABELS } from "./scoring/engine";
import { hoodscan } from "./sources/hoodscan";
import { scanhood } from "./sources/scanhood";
import { robinhoodRpc } from "./sources/rpc";
import { geckoterminal } from "./sources/geckoterminal";
import { dexscreener } from "./sources/dexscreener";
import { rugcheck } from "./sources/rugcheck";
import { helius } from "./sources/helius";
import { pumpfeed, rejectLateObservation } from "./sources/pumpfeed";
import { solanaCurve } from "./sources/solanaCurve";
import { dropDustOnlyMarkets, dropGraduatedCurveMarket, listsOnlyDust, withoutMarketFields } from "./sources/pools";
import { jupiter } from "./sources/jupiter";
import { detectChain, normalizeAddress } from "./chain";
import { historyMetrics, recordLiquidity } from "./history";
import { lpLock } from "./onchain/lplock";
import { makeRpc } from "./onchain/rpc";
import { fillFromStale, formatStaleAge, lastGoodKey, loadGood, saveGood } from "./stale";
import { applyVerification, slicesOf } from "./verify";
import { holdTier } from "./hold";
import { robinhoodSim, type PoolCandidate } from "./sources/robinhoodSim";
import { hoodscanCandles } from "./sources/hoodscanCandles";
import { hex as hexBlock, TRANSFER_TOPIC, topicAddress, type RpcLog } from "./onchain/rpc";
import { codeKind } from "./onchain/rpc";
import { infraEntry, isInfrastructure } from "./onchain/infra";
import type { HolderRow } from "./types";
import { timeMachine, unavailable, type TimeMachineResult } from "./timemachine";
import { after } from "next/server";
import { kvGet, kvSet } from "./kv";
import { collectSocial, type SocialPanel } from "./social";
import { robinx } from "./social/robinx";
import { appendScore, previousTier } from "./scoreHistory";
import { eligibility, knownNonMeme, NOT_A_CA, stockRegistry } from "./memeFilter";
import { ANALYSIS_BUDGET_MS, BudgetError, deadlineIn, remaining, sourceCap, within, type Deadline } from "./budget";
import { CHAIN_LABEL, isEvmChain, type EvmChain } from "./chain";
import { evmTokenRpc, rpcSourceId } from "./sources/evmRpc";
import { goplus } from "./sources/goplus";
import { nadfun, nadfunChart } from "./sources/nadfun";
import { evmSim, simSourceId, type EvmPool } from "./sources/evmSim";
import { baseAdapters, baseLaunchExtras } from "./sources/base";
import { ethereumAdapters } from "./sources/ethereum";
import { chainRpc } from "./onchain/rpc";
import { classifyTopHolders } from "./topHolders";
import { holderStrength } from "./holderStrengthData";
import { defaultConfig, modeFor } from "./scoring/config";

/** Wall-clock cap for the top-holder classification step (getCode + signature probes + founder history). */
const HOLDER_CLASS_MIN_MS = 5_000;
const holderClassBudgetMs = () => Number(process.env.HOLDER_CLASS_BUDGET_MS || 12_000);
/** Wall-clock cap for Holder Strength (top-20 ledgers); an unfinished read continues after the response. Below the
 *  minimum the whole read moves after the response. */
const HOLDER_STRENGTH_MIN_MS = 1_500;
/** The request budget (52s) beyond collect's analysis budget (45s): the room the post-collect steps share. */
const requestRoomMs = () => Math.max(0, REQUEST_BUDGET_MS - ANALYSIS_BUDGET_MS);
const holderStrengthBudgetMs = () => Number(process.env.HOLDER_STRENGTH_BUDGET_MS || 10_000);

export { detectChain, normalizeAddress };

/**
 * Runs an adapter and converts any throw into a failed status — one source can never sink the analysis.
 * With a deadline, the adapter is also cut off at its per-source cap or the analysis budget (lib/budget.ts).
 */
async function soft(id: string, run: () => Promise<AdapterResult>, deadline?: Deadline): Promise<AdapterResult> {
  const t0 = Date.now();
  try {
    if (!deadline) return await run();
    const cap = sourceCap(id, deadline, t0);
    return await within(Promise.resolve().then(run), cap.ms, cap.label);
  } catch (err) {
    const message = err instanceof BudgetError ? err.label : err instanceof Error ? (err.name === "TimeoutError" ? "Timed out" : err.message) : String(err);
    return { status: { id, label: SOURCE_LABELS[id] ?? id, state: "failed", message: message.slice(0, 200), ms: Date.now() - t0 }, data: {} };
  }
}

/**
 * Every adapter except HoodScan (which patches per call internally) keeps its last good output.
 * When the adapter fails outright, its fields come back from that snapshot — labelled stale with
 * their age and never older than 6h — so a source outage cannot flip the tier.
 */
const STALEABLE = new Set(["scanhood", "rpc", "geckoterminal", "dexscreener", "rugcheck", "solana-rpc", "helius", "goplus", "base-rpc", "monad-rpc", "ethereum-rpc", "nadfun"]);

export async function withLastGood(id: string, chain: Chain, address: string, result: AdapterResult, now = Date.now()): Promise<AdapterResult> {
  if (!STALEABLE.has(id)) return result;
  const key = lastGoodKey(id, chain, address);
  const hasData = Object.values(result.data).some((v) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length));
  if (result.status.state !== "failed") {
    const prev = await loadGood(key);
    // A listing of dust pools only may be a side pool of a market this indexer does not see: its market fields are not kept.
    if (hasData) await saveGood(key, prev, listsOnlyDust(result) ? withoutMarketFields(result.data) : result.data, now);
    // One call of the source hit an outage (e.g. GeckoTerminal OHLCV 429): only its fields come back
    // from the last good run, each labelled stale with its age.
    if (!result.failedFields?.length) return result;
    const fill = fillFromStale(result.data, prev, now, new Set(result.failedFields));
    const count = Object.keys(fill.staleFields).length;
    if (!count) return result;
    const nullReasons = Object.fromEntries(Object.entries(result.data.nullReasons ?? {}).filter(([k]) => !(k in fill.staleFields)));
    return {
      ...result,
      status: {
        ...result.status,
        state: "stale",
        message: `stale (${formatStaleAge(fill.oldestMinutes ?? 0)} old) for ${count} fields — ${result.status.message ?? "a call failed"}`.slice(0, 240),
      },
      data: { ...fill.data, nullReasons, staleFields: { ...result.data.staleFields, ...fill.staleFields } },
    };
  }
  const fill = fillFromStale({}, await loadGood(key), now);
  const count = Object.keys(fill.staleFields).length;
  if (!count) return result;
  return {
    status: {
      ...result.status,
      state: "stale",
      message: `stale (${formatStaleAge(fill.oldestMinutes ?? 0)} old) for ${count} fields — live call failed: ${result.status.message ?? "error"}`,
    },
    data: { ...fill.data, staleFields: fill.staleFields },
    raw: result.raw,
  };
}

export interface AnalyzeOptions {
  /** Bypass the 2-minute result cache (the "Retry sources" button). */
  fresh?: boolean;
  /** Fault injection; honored only when allowed (see simulationAllowed). */
  simulate?: "hoodscan-down";
  /** Shared secret sent by the caller; must equal HOODTIER_SIMULATE_TOKEN to simulate in production. */
  simulateToken?: string | null;
  /** The chain for an 0x address (robinhood / base / monad / ethereum); default Robinhood Chain. Ignored for Solana mints. */
  chain?: Chain;
  /** With `fresh`: the page's ?fresh= value, stored with the result so that page can show this exact run. */
  freshTag?: string;
  /** Overall analysis budget (default ANALYSIS_BUDGET_MS, 45s). */
  budgetMs?: number;
}

/** Local/e2e: HOODTIER_ALLOW_SIMULATE=1. Production: only with the secret HOODTIER_SIMULATE_TOKEN. */
export const simulationAllowed = (opts: AnalyzeOptions = {}) =>
  process.env.HOODTIER_ALLOW_SIMULATE === "1" ||
  (!!process.env.HOODTIER_SIMULATE_TOKEN && process.env.HOODTIER_SIMULATE_TOKEN.length >= 16 && opts.simulateToken === process.env.HOODTIER_SIMULATE_TOKEN);

/** Adapters in merge-priority order: earlier sources win per field. */
function adaptersFor(chain: Chain, address: string, opts: AnalyzeOptions): [string, () => Promise<AdapterResult>][] {
  if (chain === "robinhood") {
    const simulateDown = opts.simulate === "hoodscan-down" && simulationAllowed(opts);
    return [
      ["scanhood", () => scanhood(address)],
      ["rpc", () => robinhoodRpc(address)],
      ["hoodscan", () => hoodscan(address, { simulateDown })],
      ["geckoterminal", () => geckoterminal(chain, address)],
      ["dexscreener", () => dexscreener(chain, address)],
    ];
  }
  if (isEvmChain(chain)) {
    // Base / Monad / Ethereum (v3 §1): merge order = on-chain reads, the launchpad, the market indexers, then the
    // scanners. The sell simulation runs after, fed by these.
    return [
      [rpcSourceId(chain), () => evmTokenRpc(chain, address)],
      // nad.fun's creation time is the token's (a graduation creates a fresh-looking DEX pool, so pool age is not token age).
      ...(chain === "monad" ? ([["nadfun", () => nadfun(address)]] as [string, () => Promise<AdapterResult>][]) : []),
      ["dexscreener", () => dexscreener(chain, address)],
      ["geckoterminal", () => geckoterminal(chain, address)],
      ["goplus", () => goplus(chain, address)],
      ...(chain === "base" ? baseAdapters(address) : []),
      ...(chain === "ethereum" ? ethereumAdapters(address) : []),
    ];
  }
  return [
    ["rugcheck", () => rugcheck(address)],
    ["pumpfeed", () => pumpfeed(address)],
    ["helius", () => helius(address)],
    ["solana-rpc", () => solanaCurve(address)],
    ["jupiter", () => jupiter(address)],
    ["geckoterminal", () => geckoterminal(chain, address)],
    ["dexscreener", () => dexscreener(chain, address)],
  ];
}

/**
 * HoodScan's swap-index holders carry no contract flag. Pools, curves, routers and the v4 PoolManager
 * must never count as holders: classify the top 30 by the infrastructure registry and bytecode.
 */
async function classifySwapHolders(results: AdapterResult[]): Promise<void> {
  const hs = results.find((r) => r.status.id === "hoodscan");
  const rows = hs?.data.swapHolders;
  if (!hs || !rows?.length) return;
  const rpc = makeRpc();
  const top = rows.slice(0, 30);
  const kinds = await Promise.all(top.map((h) => (infraEntry(h.address) ? Promise.resolve("contract" as const) : rpc<string>("eth_getCode", [h.address, "latest"], 10_000).then(codeKind).catch(() => null))));
  hs.data.swapHolders = rows.map((h, i): HolderRow => {
    const k = i < kinds.length ? kinds[i] : null;
    const infraRow = isInfrastructure(h.address, k);
    return { ...h, isContract: k ? k === "contract" : h.isContract, kind: infraRow ? "liquidity" : "wallet", ...(infraEntry(h.address) ? { label: infraEntry(h.address)!.label } : {}) };
  });
}

/**
 * Robinhood-native launch signals (guide p.23-24):
 * - dev buy share: the deployer's buys / all tokens bought in the first 10 minutes (HoodScan swaps);
 * - fresh wallets in the top 20: wallets whose nonce is ≤ 2 at the latest block. (The spec's
 *   nonce-before-first-buy needs historical state, which the Robinhood RPC does not keep.)
 */
async function robinhoodLaunchExtras(address: string, results: AdapterResult[]): Promise<AdapterResult> {
  const t0 = Date.now();
  const data: Partial<TokenSnapshot> = {};
  const nullReasons: Record<string, string> = {};
  const notes: string[] = [];
  const rpcRes = results.find((r) => r.status.id === "rpc");
  const deployer = (rpcRes?.data.deployerAddress ?? null)?.toLowerCase() ?? null;
  const creationBlock = (rpcRes?.raw as { creation?: { creationBlock: number } | null } | undefined)?.creation?.creationBlock ?? null;
  if (!deployer || creationBlock == null) nullReasons.devBuySharePct = "deployer / creation block unknown";
  else {
    // Buys in the first 10 minutes, from the chain: Transfer logs from infrastructure (pools,
    // routers, curves) to wallets. One eth_getLogs call; exact.
    const rpc = makeRpc();
    // The window starts at the first buy (liquidity is often added minutes after creation): read the
    // first hour of logs, or the first 10 minutes if the first hour exceeds the RPC's 10k-log limit.
    const span = (blocks: number) => rpc<RpcLog[]>("eth_getLogs", [{ address, topics: [TRANSFER_TOPIC], fromBlock: hexBlock(creationBlock), toBlock: hexBlock(creationBlock + blocks) }], 30_000);
    const logs = await span(RH_BLOCKS_PER_HOUR).catch(() => span(RH_BLOCKS_PER_HOUR / 6)).catch(() => null);
    if (!logs) nullReasons.devBuySharePct = "first-10-minute Transfer logs unavailable";
    else {
      const senders = [...new Set(logs.map((l) => topicAddress(l.topics[1])))].slice(0, 25);
      const infraSender = new Map(await Promise.all(senders.map(async (a) => [a, isInfrastructure(a, codeKind(await rpc<string>("eth_getCode", [a, "latest"], 10_000).catch(() => "0x")))] as const)));
      let total = 0n;
      let dev = 0n;
      let firstBuy: number | null = null;
      for (const l of logs) {
        if (l.topics.length !== 3) continue;
        const from = topicAddress(l.topics[1]);
        const to = topicAddress(l.topics[2]);
        const block = Number(l.blockNumber);
        if (firstBuy != null && block > firstBuy + RH_BLOCKS_PER_HOUR / 6) break;
        // Mints (from 0x0) are supply creation, not buys.
        if (from === "0x0000000000000000000000000000000000000000" || !infraSender.get(from) || isInfrastructure(to, null)) continue;
        firstBuy ??= block;
        const v = l.data && l.data !== "0x" ? BigInt(l.data) : 0n;
        total += v;
        if (to === deployer) dev += v;
      }
      if (total > 0n) {
        data.devBuySharePct = Number((dev * 10_000n) / total) / 100;
        notes.push(`dev bought ${data.devBuySharePct.toFixed(1)}% of tokens bought in the first 10 min of trading (Transfer logs)`);
      } else nullReasons.devBuySharePct = "no buys in the first hour after creation";
    }
  }
  const holders = [...(results.find((r) => r.status.id === "rpc")?.data.holders ?? []), ...(results.find((r) => r.status.id === "hoodscan")?.data.swapHolders ?? [])]
    .filter((h, i, all) => h.kind === "wallet" && all.findIndex((x) => x.address === h.address) === i)
    .slice(0, 20);
  if (holders.length) {
    const rpc = makeRpc();
    const nonces = await Promise.all(holders.map((h) => rpc<string>("eth_getTransactionCount", [h.address, "latest"], 10_000).then((n) => Number(n)).catch(() => null)));
    const known = nonces.filter((n): n is number => n != null);
    if (known.length) {
      data.freshWalletsTop20 = known.filter((n) => n <= 2).length;
      notes.push(`${data.freshWalletsTop20}/${known.length} top wallets have nonce ≤ 2`);
    } else nullReasons.freshWalletsTop20 = "nonce lookups failed";
  } else nullReasons.freshWalletsTop20 = "no wallet holders known yet";
  data.nullReasons = nullReasons;
  return { status: { id: "rh-launch", label: "Robinhood launch signals", state: Object.keys(nullReasons).length ? "partial" : "ok", message: notes.join(" · ") || Object.values(nullReasons).join("; "), ms: Date.now() - t0 }, data };
}

/** Our own sell simulation (v4 quoter + transfer probes), fed by the pools and holders the other sources found. */
async function runRobinhoodSim(address: string, results: AdapterResult[]): Promise<AdapterResult> {
  const gecko = results.find((r) => r.status.id === "geckoterminal")?.raw as { pools?: { id: string; liquidityUsd: number | null; volume24hUsd: number | null }[] } | undefined;
  const ds = results.find((r) => r.status.id === "dexscreener")?.raw as { pairs?: { pairAddress: string; liquidity?: { usd?: number }; volume?: { h24?: number } }[] } | undefined;
  const hsPool = (results.find((r) => r.status.id === "hoodscan")?.raw as { token?: { meme?: { pool?: string } } } | undefined)?.token?.meme?.pool;
  const seen = new Map<string, PoolCandidate>();
  const add = (id: string | undefined, volume24hUsd: number | null, reserveUsd: number | null) => {
    if (!id) return;
    const k = id.toLowerCase();
    const prev = seen.get(k);
    seen.set(k, { id: k, volume24hUsd: Math.max(prev?.volume24hUsd ?? 0, volume24hUsd ?? 0), reserveUsd: Math.max(prev?.reserveUsd ?? 0, reserveUsd ?? 0) });
  };
  for (const p of gecko?.pools ?? []) add(p.id, p.volume24hUsd, p.liquidityUsd);
  for (const p of ds?.pairs ?? []) add(p.pairAddress, p.volume?.h24 ?? null, p.liquidity?.usd ?? null);
  add(hsPool, null, null);
  const rpcRes = results.find((r) => r.status.id === "rpc");
  const rr = rpcRes?.raw as { supplyRaw?: string | null; decimals?: number; creation?: { creationBlock: number } | null } | undefined;
  const wallets = [...(rpcRes?.data.holders ?? []), ...(results.find((r) => r.status.id === "hoodscan")?.data.swapHolders ?? [])].filter((h) => h.kind === "wallet" && (h.qty ?? 0) > 0);
  const holder = wallets[0];
  const scale = 10n ** BigInt(rr?.decimals ?? 18);
  return robinhoodSim({
    token: address,
    pools: [...seen.values()],
    holder: holder?.address ?? null,
    holders: wallets.slice(1, 8).map((h) => h.address),
    holderBalanceRaw: holder?.qty ? (BigInt(Math.floor(holder.qty)) * scale) / 2n : null,
    totalSupplyRaw: rr?.supplyRaw ? BigInt(rr.supplyRaw) : null,
    creationBlock: rr?.creation?.creationBlock ?? null,
  });
}

/**
 * Base / Monad / Ethereum after the first wave: our own sell simulation (fed by every pool and holder the sources
 * listed), nad.fun candles for curve tokens no DEX indexer charts, the deployer's current balance, and
 * Base launchpad detection.
 */
async function evmPostSteps(chain: EvmChain, address: string, results: AdapterResult[], deadline: Deadline): Promise<void> {
  const by = (id: string) => results.find((r) => r.status.id === id);
  // Token age: a launchpad's creation time is the token's. DEX indexers only know pool creation, which is
  // later (a graduation, or a fresh pool on an old token) — never the token's age, so it is dropped then.
  const created = by("nadfun")?.data.createdAt ?? by("basescan")?.data.createdAt ?? by("etherscan")?.data.createdAt;
  if (created)
    for (const id of ["dexscreener", "geckoterminal"]) {
      const r = by(id);
      if (r?.data.createdAt) r.data = { ...r.data, createdAt: undefined };
    }
  const pools = new Map<string, EvmPool>();
  const add = (id: string | undefined, liquidityUsd: number | null, kind: EvmPool["kind"] = null) => {
    if (!id) return;
    const k = id.toLowerCase();
    const prev = pools.get(k);
    pools.set(k, { id: k, liquidityUsd: Math.max(prev?.liquidityUsd ?? 0, liquidityUsd ?? 0) || null, kind: prev?.kind ?? kind });
  };
  const gecko = by("geckoterminal")?.raw as { pools?: { id: string; liquidityUsd: number | null; dexId?: string | null }[] } | undefined;
  const ds = by("dexscreener")?.raw as { pairs?: { pairAddress: string; liquidity?: { usd?: number }; labels?: string[] }[] } | undefined;
  const gp = by("goplus")?.raw as { dex?: { pair: string; liquidity_type?: string; liquidity?: string }[] } | undefined;
  const kindOf = (s: string | undefined | null): EvmPool["kind"] => (s ? (/v4/i.test(s) ? "v4" : /v3/i.test(s) ? "v3" : /v2/i.test(s) ? "v2" : null) : null);
  for (const p of gecko?.pools ?? []) add(p.id, p.liquidityUsd, kindOf(p.dexId));
  for (const p of ds?.pairs ?? []) add(p.pairAddress, p.liquidity?.usd ?? null, kindOf(p.labels?.join(" ")));
  for (const p of gp?.dex ?? []) add(p.pair, null, kindOf(p.liquidity_type));
  const rpcRaw = by(rpcSourceId(chain))?.raw as { supplyRaw?: string; decimals?: number } | undefined;
  const holders = (by("goplus")?.data.holders ?? []).filter((h) => h.kind === "wallet").map((h) => h.address);
  const nf = by("nadfun")?.raw as { version: string; marketType: string | null } | undefined;
  const createdAt = by("nadfun")?.data.createdAt ?? results.map((r) => r.data.createdAt).filter((x): x is string => !!x).sort()[0] ?? null;
  const young = createdAt != null && Date.now() - Date.parse(createdAt) < 72 * 3_600_000;
  const needChart = chain === "monad" && !!nf && by("geckoterminal")?.data.trendScore == null;
  const [sim, chart, extras] = await Promise.all([
    soft(simSourceId(chain), () => evmSim({ chain, token: address, pools: [...pools.values()], holders, supplyRaw: rpcRaw?.supplyRaw ? BigInt(rpcRaw.supplyRaw) : null, nadfun: nf ?? null }), deadline),
    needChart ? soft("nadfun-chart", () => nadfunChart(address, createdAt), deadline) : Promise.resolve(null),
    chain === "base" ? soft("base-launch", () => baseLaunchExtras(address, results, young), deadline) : Promise.resolve(null),
  ]);
  results.unshift(sim);
  if (chart) results.push(chart);
  if (extras) results.push(extras);
  // The deployer's balance now (on-chain), when a source named the deployer.
  const deployer = results.map((r) => r.data.deployerAddress).find((x): x is string => !!x);
  if (deployer && rpcRaw?.supplyRaw && BigInt(rpcRaw.supplyRaw) > 0n && remaining(deadline) > 2_000) {
    const bal = await chainRpc(chain)<string>("eth_call", [{ to: address, data: "0x70a08231" + deployer.slice(2).padStart(64, "0") }, "latest"], 8_000).catch(() => null);
    if (bal && bal.length >= 66) {
      const pct = Number((BigInt(bal.slice(0, 66)) * 1_000_000n) / BigInt(rpcRaw.supplyRaw)) / 10_000;
      const r = by(rpcSourceId(chain));
      if (r) r.data = { ...r.data, deployerHoldingPct: pct };
    }
  }
}

/** Robinhood Chain blocks arrive roughly every 0.1s (measured: ~9.8 blocks/s). */
const RH_BLOCKS_PER_HOUR = 36_000;

/**
 * Guide p.16-18: LP lock on the main pool for young, non-launchpad Robinhood tokens, read from
 * the chain (v2 LP balances or v3 position-NFT owners). Older or launchpad tokens skip it.
 */
async function robinhoodLpLock(merged: TokenSnapshot, results: AdapterResult[]): Promise<void> {
  if (merged.lpLockedPct != null || merged.isLaunchpad === true) return;
  const age = merged.ageHours ?? (merged.createdAt ? (Date.now() - Date.parse(merged.createdAt)) / 3_600_000 : null);
  if (age == null || age >= 336) return;
  const gecko = results.find((r) => r.status.id === "geckoterminal")?.raw as { mainPool?: string } | undefined;
  const pool = gecko?.mainPool;
  if (!pool || !/^0x[0-9a-fA-F]{40}$/.test(pool)) {
    merged.nullReasons = {
      ...merged.nullReasons,
      lpLockedPct: pool ? "main pool is a v4 pool id — positions live in the PoolManager and are not attributable via RPC" : "main pool unknown",
    };
    return;
  }
  try {
    const rpc = makeRpc();
    const head = Number(await rpc<string>("eth_blockNumber", []));
    const creation = (results.find((r) => r.status.id === "rpc")?.raw as { creation?: { creationBlock: number } } | undefined)?.creation;
    const from = creation?.creationBlock ?? Math.max(0, head - Math.ceil((age + 2) * RH_BLOCKS_PER_HOUR));
    const res = await lpLock(rpc, pool.toLowerCase(), from, head);
    if (res.lockedPct != null) merged.lpLockedPct = res.lockedPct;
    else merged.nullReasons = { ...merged.nullReasons, lpLockedPct: res.detail };
  } catch (err) {
    merged.nullReasons = { ...merged.nullReasons, lpLockedPct: `LP lock lookup failed: ${(err as Error).message.slice(0, 100)}` };
  }
}

export async function collect(
  chain: Chain,
  address: string,
  opts: AnalyzeOptions = {},
): Promise<{ snapshot: TokenSnapshot; sources: SourceStatus[]; raw: Record<string, unknown> }> {
  const deadline = deadlineIn(opts.budgetMs);
  const results = await Promise.all(adaptersFor(chain, address, opts).map(([id, run]) => soft(id, run, deadline).then((r) => withLastGood(id, chain, address, r))));
  // The pump.fun feed's launch observation must start at the token's launch (earliest creation time any other source reports).
  const feedAt = results.findIndex((r) => r.status.id === "pumpfeed");
  if (feedAt >= 0) {
    const created = results
      .filter((r) => r.status.id !== "pumpfeed" && r.data.createdAt)
      .map((r) => r.data.createdAt!)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    results[feedAt] = rejectLateObservation(results[feedAt], created ?? null);
  }
  // A graduated pump.fun token: a source that indexes only the dead curve pool supplies no market fields.
  if (chain === "solana" && (results.find((r) => r.status.id === "solana-rpc")?.raw as { complete?: boolean } | undefined)?.complete === true) {
    for (let i = 0; i < results.length; i++) results[i] = dropGraduatedCurveMarket(results[i]);
  }
  // An indexer that sees only dust side-pools (the real market is another indexer's pool or a launchpad curve) supplies no market fields.
  {
    const nf = results.find((r) => r.status.id === "nadfun");
    const nfCurve = /CURVE/.test((nf?.raw as { marketType?: string | null } | undefined)?.marketType ?? "");
    const dusted = dropDustOnlyMarkets(results, nfCurve ? { label: "nad.fun", volume24hUsd: nf!.data.volume24hUsd ?? null } : null);
    for (let i = 0; i < results.length; i++) results[i] = dusted[i];
  }
  if (isEvmChain(chain) && chain !== "robinhood") await evmPostSteps(chain, address, results, deadline);
  if (chain === "robinhood") {
    await within(classifySwapHolders(results), Math.min(15_000, remaining(deadline)), "holder classification").catch(() => undefined);
    const createdAt = results.find((r) => r.status.id === "rpc")?.data.createdAt ?? results.find((r) => r.status.id === "hoodscan")?.data.createdAt ?? null;
    const young = createdAt != null && Date.now() - Date.parse(createdAt) < 72 * 3_600_000;
    const [sim, candles] = await Promise.all([
      soft("rh-sim", () => runRobinhoodSim(address, results), deadline),
      // Swap candles only where GeckoTerminal has no OHLCV for the pool (common for fresh v4 pools).
      young && results.find((r) => r.status.id === "geckoterminal")?.data.trendScore == null ? soft("hs-candles", () => hoodscanCandles(address, createdAt), deadline) : Promise.resolve(null),
    ]);
    results.splice(1, 0, sim);
    if (candles) results.push(candles);
    if (young) results.push(await soft("rh-launch", () => robinhoodLaunchExtras(address, results), deadline));
  }
  // Cross-source verification: every source's reading is kept; disputes resolve to on-chain truth or
  // the most conservative value, and APIs that disagree with the chain are flagged in the Sources list.
  const { snapshot: merged, flags } = applyVerification(
    mergeSnapshots(
      emptySnapshot(chain, address),
      results.map((r) => r.data),
    ),
    slicesOf(results),
  );
  // LP lock is a young-token check (guide p.16-18), as on Robinhood Chain: < 14 days only.
  if (isEvmChain(chain) && chain !== "robinhood" && merged.lpLockedPct != null) {
    const age = merged.ageHours ?? (merged.createdAt ? (Date.now() - Date.parse(merged.createdAt)) / 3_600_000 : null);
    if (age == null || age >= 336) {
      merged.lpLockedPct = null;
      merged.nullReasons = { ...merged.nullReasons, lpLockedPct: age == null ? "token age unknown — the LP-lock check applies to tokens < 14 days" : "token is ≥ 14 days old — the LP-lock check applies to young tokens (as on Robinhood Chain)" };
    }
  }
  if (chain === "robinhood")
    await within(robinhoodLpLock(merged, results), remaining(deadline), "LP lock").catch(() => {
      merged.nullReasons = { ...merged.nullReasons, lpLockedPct: `LP lock lookup timed out: ${Math.round(deadline.budgetMs / 1000)}s analysis budget reached` };
    });

  // Liquidity + mcap history: one observation per analysis; deltas appear from the second one.
  await liquidityHistoryStep(chain, address, merged);
  const raw: Record<string, unknown> = {};
  for (const r of results) if (r.raw !== undefined) raw[r.status.id] = r.raw;
  const sources = results.map((r) => (flags[r.status.id] ? { ...r.status, flags: flags[r.status.id] } : r.status));
  // §7b zero is data: genuinely no activity ⇒ activity metrics are 0 (then the dead-launch gate re-reads them).
  const zeroed = applyZeroActivity(deriveMetrics(merged), sources);
  const snapshot = zeroed.zeroActivity.length ? { ...zeroed, launchBuyers: zeroed.uniqueBuyers ?? zeroed.buyers24h, deadLaunch: deadLaunchOf(zeroed) } : zeroed;
  await holderClassification(chain, address, snapshot, results, deadline);
  await holderStrengthStep(chain, address, snapshot, results, deadline);
  return { snapshot, sources, raw };
}

/**
 * Liquidity + mcap history: one observation per analysis; deltas appear from the second one. Only a live, complete
 * total is recorded (H11): a stale fill or an unknown total leaves the changes null with the reason.
 */
export async function liquidityHistoryStep(chain: Chain, address: string, merged: TokenSnapshot, now = Date.now()): Promise<void> {
  const liqStaleMin = merged.staleFields?.liquidityTotalUsd;
  if (merged.liquidityTotalUsd != null && liqStaleMin != null) {
    // H11: a stale fill is the last good snapshot's figure, not an observation at this moment. Recording it with
    // t = now would fake a flat (or moved) history; the change is not computed from it either.
    const reason = `liquidity this run is stale (last good snapshot, ${liqStaleMin}m old) — not recorded into the history, change not computed`;
    merged.nullReasons = { ...merged.nullReasons, liqChange24hPct: reason, liqChange7dPct: reason };
  } else if (merged.liquidityTotalUsd != null) {
    // Only a complete live total reaches here: a pool without a liquidity figure leaves liquidityTotalUsd null (C1).
    const points = await recordLiquidity(chain, address, merged.liquidityTotalUsd, now, merged.fdvUsd);
    const { nullReasons: why, ...hist } = historyMetrics(points, merged.ageHours ?? null);
    Object.assign(merged, hist);
    merged.nullReasons = { ...merged.nullReasons, ...why };
  } else {
    const reason = merged.nullReasons.liquidityTotalUsd
      ? `total pool liquidity unknown (${merged.nullReasons.liquidityTotalUsd})`
      : "no pool liquidity reported by GeckoTerminal or DexScreener";
    merged.nullReasons = { ...merged.nullReasons, liqChange24hPct: reason, liqChange7dPct: reason };
  }
}

/**
 * "Vesting diamond": the top holder is a vesting wallet and Holder Strength ≥ 80. Unknown Holder Strength leaves it
 * unknown (null with the reason), never a measured false (M13).
 */
export function vestingDiamondOf(topClass: string | null, score: number | null | undefined, why?: string | null): { value: boolean | null; reason: string | null } {
  if (topClass == null) return { value: null, reason: null };
  if (topClass !== "vesting") return { value: false, reason: null };
  if (score == null) return { value: null, reason: `top holder is a vesting wallet, but Holder Strength is unknown (${why ?? "not enough holder history"})` };
  return { value: score >= 80, reason: null };
}

/** Holder Strength (Established mode only — a Launch-mode token is too young to measure). */
async function holderStrengthStep(chain: Chain, address: string, snapshot: TokenSnapshot, results: AdapterResult[], deadline: Deadline): Promise<void> {
  const reason = (why: string) => {
    snapshot.nullReasons = { ...snapshot.nullReasons, holderStrength: why };
  };
  if (modeFor(snapshot.ageHours, defaultConfig) !== "established") return reason("token is younger than 72h — too young to measure (Launch mode: information only)");
  // Only the request budget that is really left (collect's deadline + the room after it, as for the classification);
  // with too little, the ledgers are read after the response and the factor waits for the next analysis.
  const ms = Math.min(holderStrengthBudgetMs(), remaining(deadline) + requestRoomMs() - 1_000);
  if (ms < HOLDER_STRENGTH_MIN_MS) {
    snapshot.holderStrengthPending = true;
    reason("holder histories are read in the background (no request time left) — shown from the next analysis");
    try {
      after(() => holderStrength(chain, address, snapshot, results, Date.now() + 35_000).then(() => undefined, () => undefined));
    } catch {
      // Outside a request (scripts): nothing to schedule.
    }
    return;
  }
  try {
    const hs = await within(holderStrength(chain, address, snapshot, results, Date.now() + ms), ms + 1_000, "holder strength");
    snapshot.holderStrengthDetail = hs;
    snapshot.holderStrength = hs.score;
    snapshot.holderStrengthLabel = hs.label;
    if (hs.score == null) reason(hs.nullReason ?? "not enough holder history");
    snapshot.holderStrengthPending = hs.score == null && hs.pending === true;
    const top = snapshot.holderClasses.find((h) => h.pct != null);
    // M13: unknown Holder Strength leaves "vesting diamond" unknown (null), not a measured false.
    const vd = vestingDiamondOf(top?.class ?? null, hs.score, hs.nullReason);
    snapshot.vestingDiamond = vd.value;
    if (vd.reason) snapshot.nullReasons = { ...snapshot.nullReasons, vestingDiamond: vd.reason };
  } catch (err) {
    snapshot.holderStrengthPending = err instanceof BudgetError;
    reason(err instanceof BudgetError ? `holder histories took longer than ${Math.round(ms / 1000)}s — they continue in the background` : `holder strength failed: ${(err as Error).message.slice(0, 80)}`);
  }
}

/** Top-holder classes → holder math and the founder fields. Runs on a copy; applied only when it finishes in time. */
async function holderClassification(chain: Chain, address: string, snapshot: TokenSnapshot, results: AdapterResult[], deadline: Deadline): Promise<void> {
  // At least HOLDER_CLASS_MIN_MS even when the sources used the whole collect budget (the request budget, 52s, has room).
  const ms = Math.min(holderClassBudgetMs(), Math.max(HOLDER_CLASS_MIN_MS, remaining(deadline) - 1_000));
  const work: TokenSnapshot = { ...snapshot };
  try {
    await within(classifyTopHolders(chain, address, work, results, Date.now() + ms), ms, "top-holder classification");
    const keys = ["holders", "liquidityHolders", "holderClasses", "largestHolder", "founderNeverSold", "founderSold", "founderHoldDays", "teamNeverSold", "teamSold", "teamHoldDays", "top1SharePct", "top10SharePct", "liquidityHeldPct", "nullReasons", "provenance"] as const;
    for (const k of keys) (snapshot as unknown as Record<string, unknown>)[k] = work[k];
  } catch (err) {
    const why = err instanceof BudgetError ? `top-holder classification timed out (${Math.round(Math.max(0, ms) / 1000)}s)` : `top-holder classification failed: ${(err as Error).message.slice(0, 80)}`;
    snapshot.nullReasons = { ...snapshot.nullReasons, largestHolder: why, founderNeverSold: why };
  }
}

export async function analyzeAddress(input: string, opts: AnalyzeOptions = {}): Promise<ScoreReport> {
  const chain = detectChain(input, opts.chain);
  if (!chain) throw new InvalidAddressError(input);
  const address = normalizeAddress(chain, input);
  const stocks = chain === "robinhood" ? await stockRegistry() : undefined;
  const refused = knownNonMeme(chain, address, stocks);
  if (refused) throw new NotAMemeError(refused.rejected ?? refused.reason ?? "not a memecoin", refused.reason);
  const t0 = Date.now();
  // RobinX does not depend on the other sources: it runs beside collect() (its result is cached 10 min).
  const rx = chain === "robinhood" ? robinx(address).catch((e: Error) => e) : null;
  rx?.catch(() => undefined);
  const { snapshot, sources, raw } = await collect(chain, address, opts);
  const meme = eligibility(snapshot, stocks);
  if (!meme.meme) {
    snapshot.nullReasons = { ...snapshot.nullReasons, tmWinnerSimilarity: "not a meme", tmRugSimilarity: "not a meme" };
    return { ...scoreSnapshot(snapshot, sources), raw, eligibility: meme };
  }
  // The SOCIAL panel runs beside the Time Machine; it is information only and never touches the snapshot.
  // Everything after collect() shares what is left of the request budget (route maxDuration 60s).
  const left = REQUEST_BUDGET_MS - (Date.now() - t0);
  const robinxDep = rx ? async () => { const r = await rx; if (r instanceof Error) throw r; return r; } : undefined;
  const [tm, social] = await Promise.all([
    timeMachineWithin(chain, address, snapshot.ageHours),
    left > 1_500 ? socialWithin(chain, address, snapshot, raw.dexscreener, Math.min(SOCIAL_BUDGET_MS, opts.budgetMs ?? Infinity, left - 1_000), robinxDep) : Promise.resolve(null),
  ]);
  // The ±5 rule only applies once the library can separate winners from rugs; until then the
  // Time Machine is shown as information and its similarities are not fed to scoring.
  const inputs = tmScoringInputs(tm);
  snapshot.tmWinnerSimilarity = inputs.winner;
  snapshot.tmRugSimilarity = inputs.rug;
  if (inputs.reason) snapshot.nullReasons = { ...snapshot.nullReasons, tmWinnerSimilarity: inputs.reason, tmRugSimilarity: inputs.reason };
  // A factor lost to an outage never moves the tier across a band: the last complete run's tier is held (lib/hold.ts).
  // Near a band line the previous analysis's tier is kept (hysteresis, factors.json → hysteresis).
  const previous = await previousTier(chain, address).catch(() => null);
  const report: ScoreReport = { ...(await holdTier(scoreSnapshot(snapshot, sources, undefined, { previous }), snapshot, sources)), raw, timeMachine: tm, eligibility: meme, ...(social ? { social } : {}) };
  // score_history keeps the tier with the social stage / size / quality beside it (social §6).
  await appendScore(report).catch(() => undefined);
  return report;
}

/** Time the social panel may take inside a request; past it the panel says so (nothing is estimated). */
const SOCIAL_BUDGET_MS = Number(process.env.SOCIAL_BUDGET_MS || 10_000);
/** One whole analysis, collect() included, stays inside this (route maxDuration 60s). */
const REQUEST_BUDGET_MS = Number(process.env.REQUEST_BUDGET_MS || 52_000);

async function socialWithin(chain: Chain, address: string, snapshot: TokenSnapshot, dexRaw: unknown, budgetMs: number, robinxDep?: () => Promise<import("./social/robinx").RobinxSocial>): Promise<SocialPanel | null> {
  try {
    return await within(collectSocial(chain, address, snapshot, dexRaw, robinxDep ? { robinx: robinxDep } : {}), budgetMs, "social sources timed out");
  } catch (err) {
    console.warn(`[social] ${chain}:${address} — ${(err as Error).message}`);
    return null;
  }
}

/** Time the Time Machine may take inside a request; a longer rebuild finishes after the response and is cached. */
/** What the Time Machine may feed to scoring: nothing until the library can tell winners from rugs. */
export function tmScoringInputs(tm: TimeMachineResult, min = TM_MIN_ARCHETYPES): { winner: number | null; rug: number | null; reason: string | null } {
  if (tm.status !== "ok") return { winner: null, rug: null, reason: tm.reason ?? "Time Machine unavailable" };
  if (tm.library.winners < min || tm.library.rugs < min) {
    return { winner: null, rug: null, reason: `archetype library too small to score (${tm.library.winners} winners, ${tm.library.rugs} rugs; needs ≥ ${min} of each) — shown as information only` };
  }
  return { winner: tm.winnerPct, rug: tm.rugPct, reason: null };
}

/** Winners and rugs the library needs (each) before the Time Machine may move a score. */
export const TM_MIN_ARCHETYPES = Number(process.env.TM_MIN_ARCHETYPES || 10);
const TM_REQUEST_BUDGET_MS = Number(process.env.TM_REQUEST_BUDGET_MS || 3_000);

async function timeMachineWithin(chain: Chain, address: string, ageHours: number | null): Promise<TimeMachineResult> {
  // The archetype library and the reconstructions cover Solana and Robinhood Chain only.
  if (isEvmChain(chain) && chain !== "robinhood") return unavailable(`no ${CHAIN_LABEL[chain]} archetypes in the library yet, and no ${CHAIN_LABEL[chain]} history reconstruction (public RPCs cap eth_getLogs windows)`);
  const run = timeMachine(chain, address, ageHours).catch((err: Error) => unavailable(`Time Machine failed: ${err.message.slice(0, 120)}`));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), TM_REQUEST_BUDGET_MS)));
  const res = await Promise.race([run, timeout]);
  clearTimeout(timer);
  if (res) return res;
  try {
    after(() => run.then(() => undefined));
  } catch {
    // Outside a request (scripts): the promise simply keeps running.
  }
  return unavailable(`rebuilding this token's history takes longer than ${TM_REQUEST_BUDGET_MS / 1000}s — it continues in the background and appears on the next visit`);
}

/** The address is a known non-meme (stablecoin, wrapped asset, major) — refused before fetching anything. */
export class NotAMemeError extends Error {
  /** `message` is the user-facing refusal ("stock token — HoodTier scores memecoins only"). */
  constructor(
    message: string,
    public reason: string | null = null,
  ) {
    super(message);
  }
}

export class InvalidAddressError extends Error {
  constructor(input: string) {
    super(`${NOT_A_CA} — "${input.slice(0, 60)}" is not a Robinhood Chain / Base / Monad / Ethereum (0x + 40 hex) or Solana (base58, 32–44 chars) address.`);
  }
}

// --- 2-minute result cache: in memory per instance, shared across instances through the KV ---------

export const CACHE_TTL_MS = 120_000;
interface CacheEntry {
  at: number;
  report: ScoreReport;
  /** The result this run replaced (any age), so the page can say what moved since. */
  previous?: ScoreReport;
  /** The ?fresh= value of the request that ran this analysis. */
  freshTag?: string;
}
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ScoreReport>>();
const reportKey = (key: string) => `report:v1:${key}`;

function cacheKey(input: string, opts: AnalyzeOptions = {}): string | null {
  const chain = detectChain(input, opts.chain);
  if (!chain) return null;
  const sim = opts.simulate && simulationAllowed(opts) ? `:sim=${opts.simulate}` : "";
  return `${chain}:${normalizeAddress(chain, input)}${sim}`;
}

/** True when a recent in-memory result exists (a request that will not run a live analysis). */
export function peekCached(input: string, opts: AnalyzeOptions = {}): boolean {
  const key = cacheKey(input, opts);
  const hit = key ? cache.get(key) : undefined;
  return !!hit && Date.now() - hit.at < CACHE_TTL_MS;
}

/**
 * A result under 2 minutes old from this instance or the shared KV — never runs an analysis. With
 * `freshTag`, only the result of that exact fresh run counts.
 */
export async function peekReport(input: string, opts: AnalyzeOptions = {}): Promise<CacheEntry | null> {
  const key = cacheKey(input, opts);
  if (!key) return null;
  const fits = (e: CacheEntry | null | undefined): e is CacheEntry => !!e?.report && Date.now() - e.at < CACHE_TTL_MS && (!opts.freshTag || e.freshTag === opts.freshTag);
  const mem = cache.get(key);
  if (fits(mem)) return mem;
  const shared = await kvGet<CacheEntry>(reportKey(key));
  if (!fits(shared)) return null;
  remember(key, shared);
  return shared;
}

function remember(key: string, entry: CacheEntry) {
  cache.set(key, entry);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
}

export async function analyzeCached(input: string, opts: AnalyzeOptions = {}): Promise<{ report: ScoreReport; cached: boolean; previous?: ScoreReport }> {
  const key = cacheKey(input, opts);
  if (!key) throw new InvalidAddressError(input);
  const hit = opts.fresh ? (cache.get(key) ?? (await kvGet<CacheEntry>(reportKey(key)))) : await peekReport(input, opts);
  if (!opts.fresh && hit) return { report: hit.report, cached: true };

  let p = inflight.get(key);
  if (!p) {
    p = analyzeAddress(input, opts).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const report = await p;
  const previous = hit && hit.report !== report ? hit.report : undefined;
  const entry: CacheEntry = { at: Date.now(), report, ...(previous ? { previous: { ...previous, raw: undefined } } : {}), ...(opts.fresh && opts.freshTag ? { freshTag: opts.freshTag } : {}) };
  remember(key, entry);
  // Shared with every instance, so the page that asked the API for this run can render it server-side.
  await kvSet(reportKey(key), entry, CACHE_TTL_MS / 1000);
  return { report, cached: false, previous };
}
