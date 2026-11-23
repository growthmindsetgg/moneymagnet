import type { Chain, SourceStatus } from "./types";
import { sortCandles, type Candle } from "./patterns";
import { num } from "./sources/http";
import { gtGet } from "./sources/gtClient";
import { kvGet, kvIncr, kvSet } from "./kv";
import { STALE_MAX_MS, formatStaleAge } from "./stale";
import { CHAIN_LABEL } from "./chain";
import { knownNonMeme } from "./memeFilter";
import { BudgetError, within } from "./budget";

/**
 * Relative strength's peer cohort: the median 7d price change of tokens trading on the same DEX / launchpad venue as
 * the token's main pool (GeckoTerminal lists Robinhood launchpads such as pons-dot-family, hoodit or clanker-robinhood
 * as DEXes, and pump.fun graduates trade on pumpswap), on the same chain. Falls back to the chain's top pools when
 * the venue has too few qualifying peers, and says so in the label.
 *
 * Every peer's 7d change is read from its own GeckoTerminal daily candles with the same rule as the token's
 * (priceChange7d). The cohort is cached in KV: refreshed at most every COHORT_REFRESH_MS, never used past 6h, and
 * labelled stale with its age whenever it was not fetched in this run. Nothing is estimated: an unreadable cohort is
 * null with the exact reason.
 */

export const COHORT_MIN_PEERS = 5;
export const COHORT_MAX_PEERS = 8;
/** Dust pools are not peers: their closes move on a single swap. */
export const COHORT_MIN_RESERVE_USD = 10_000;
/** A peer needs a daily close from 7 days back: its pool must be at least this old. */
export const COHORT_MIN_POOL_AGE_DAYS = 7;
/** Listing pages read per scope (venue, then chain fallback). */
export const COHORT_LIST_PAGES = 3;
export const COHORT_REFRESH_MS = () => Number(process.env.COHORT_REFRESH_MIN || 60) * 60_000;
export const COHORT_MAX_AGE_MS = STALE_MAX_MS;
export const COHORT_BUDGET_MS = () => Number(process.env.COHORT_BUDGET_MS || 10_000);
/** After a failed read with nothing cached, the next attempt waits this long (protects the shared GeckoTerminal quota). */
export const COHORT_FAIL_BACKOFF_S = 300;
/** Below this much request time the cohort is not fetched (a cached one may still be used). */
export const COHORT_MIN_FETCH_MS = 1_500;

const API = "https://api.geckoterminal.com/api/v2";
const NETWORK: Record<Chain, string> = { robinhood: "robinhood", solana: "solana", base: "base", monad: "monad", ethereum: "eth" };
const DAY = 86_400;
/** Quote / major assets that top every venue's volume list but are not meme peers. */
const MAJOR_SYMBOL = /^(w?(eth|btc|sol|mon|bnb|hood)|cb(btc|eth)|w?steth|reth|weeth|jitosol|msol|bsol|usd.*|.*usd[a-z]?|dai|eurc|xaut|paxg)$/i;

export interface CohortPeer {
  address: string;
  symbol: string | null;
  pool: string;
  change7dPct: number;
}

export interface Cohort {
  key: string;
  chain: Chain;
  /** The venue (GeckoTerminal DEX id) the cohort was asked for; null = the chain's top pools. */
  dex: string | null;
  /** "dex" when the peers are from that venue, "chain" when the venue had too few and the chain's top pools stood in. */
  scope: "dex" | "chain";
  label: string;
  median: number;
  peers: CohortPeer[];
  /** Peers listed whose candles could not be read (or had no 7d close). */
  unread: number;
  at: number;
}

export interface CohortRead {
  median: number | null;
  size: number | null;
  label: string | null;
  /** Minutes since the cohort was fetched; null when it was fetched in this run (live). */
  ageMinutes: number | null;
  /** Why median is null. */
  reason: string | null;
  status: SourceStatus;
}

export const cohortKey = (chain: Chain, dex: string | null) => `cohort7d:v1:${chain}:${dex ?? "chain"}`;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const isoDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * 7d price change from daily candles: the latest close (the current price — no candle means no trade, so the last
 * close still stands) against the close of the last daily candle at or before the start of the day 7 days before
 * today (UTC). Used for the token and for every peer, so the comparison is like for like.
 */
export function priceChange7d(candles: Candle[], now = Date.now()): { pct: number | null; window: string | null; reason: string | null } {
  const cs = candles.filter((c) => Number.isFinite(c.c) && c.c > 0).sort((a, b) => a.t - b.t);
  if (!cs.length) return { pct: null, window: null, reason: "no daily candles" };
  const last = cs[cs.length - 1];
  const anchor = Math.floor(now / 1000 / DAY) * DAY - 7 * DAY;
  let base: Candle | undefined;
  for (const c of cs) if (c.t <= anchor) base = c;
  if (!base) {
    return { pct: null, window: null, reason: `daily candles start ${isoDay(cs[0].t)} — a 7d change needs a close from ${isoDay(anchor)} or earlier` };
  }
  const quiet = last.t <= anchor ? ` (no trade since ${isoDay(last.t)})` : "";
  return { pct: (last.c / base.c - 1) * 100, window: `daily close ${isoDay(base.t)} → latest ${isoDay(last.t)}${quiet}`, reason: null };
}

interface GtListPool {
  attributes: { name?: string; address: string; reserve_in_usd?: string | null; pool_created_at?: string | null };
  relationships?: { base_token?: { data?: { id?: string } } };
}

/** Qualifying peers from a GeckoTerminal pool listing, in listing order, one pool per base token. */
export function pickPeers(pools: GtListPool[], chain: Chain, now = Date.now()): { address: string; symbol: string | null; pool: string }[] {
  const seen = new Set<string>();
  const out: { address: string; symbol: string | null; pool: string }[] = [];
  for (const p of pools) {
    const id = p.relationships?.base_token?.data?.id;
    if (!id) continue;
    const raw = id.split("_").slice(1).join("_");
    const address = chain === "solana" ? raw : raw.toLowerCase();
    if (!address || seen.has(address.toLowerCase())) continue;
    const symbol = p.attributes.name?.split(" / ")[0]?.trim() || null;
    const reserve = num(p.attributes.reserve_in_usd);
    const created = p.attributes.pool_created_at ? Date.parse(p.attributes.pool_created_at) : NaN;
    if (reserve == null || reserve < COHORT_MIN_RESERVE_USD) continue;
    if (!Number.isFinite(created) || now - created < COHORT_MIN_POOL_AGE_DAYS * DAY * 1000) continue;
    if (symbol && MAJOR_SYMBOL.test(symbol)) continue;
    if (knownNonMeme(chain, address)) continue;
    seen.add(address.toLowerCase());
    out.push({ address, symbol, pool: p.attributes.address });
  }
  return out;
}

export class CohortError extends Error {
  name = "CohortError";
}

type Get = <T>(url: string) => Promise<T>;
/** Through the shared GeckoTerminal client at background priority: the cohort never takes calls the scored token needs. */
const defaultGet: Get = (url) => gtGet(url.startsWith(API) ? url.slice(API.length) : url, { priority: "background", timeoutMs: 6_000 }).then((r) => r.body as never);

const why = (e: unknown) => {
  const m = e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : String(e);
  return /\b429\b/.test(m) ? "rate limited (HTTP 429)" : m.slice(0, 100);
};

/**
 * Reads a fresh cohort from GeckoTerminal (≤ COHORT_LIST_PAGES listing calls per scope + ≤ COHORT_MAX_PEERS candle
 * calls). Throws CohortError with the reason.
 */
export async function fetchCohort(chain: Chain, dex: string | null, deps: { get?: Get; now?: number; concurrency?: number } = {}): Promise<Cohort> {
  const get = deps.get ?? defaultGet;
  const now = deps.now ?? Date.now();
  const net = NETWORK[chain];
  const list = async (path: string) => {
    try {
      return (await get<{ data?: GtListPool[] }>(`${API}${path}`)).data ?? [];
    } catch (e) {
      throw new CohortError(`GeckoTerminal pool listing failed: ${why(e)}`);
    }
  };
  const chainLabel = CHAIN_LABEL[chain];
  // Volume-ranked listings lead with fresh launches, which cannot have a 7d change: page on (≤ COHORT_LIST_PAGES)
  // until COHORT_MAX_PEERS peers qualify or a short page shows the listing has ended.
  const collect = async (base: string) => {
    let pools: GtListPool[] = [];
    let peers: ReturnType<typeof pickPeers> = [];
    for (let page = 1; page <= COHORT_LIST_PAGES; page++) {
      const batch = await list(`${base}?page=${page}&sort=h24_volume_usd_desc`);
      pools = [...pools, ...batch];
      peers = pickPeers(pools, chain, now);
      if (peers.length >= COHORT_MAX_PEERS || batch.length < 20) break;
    }
    return peers;
  };
  let scope: "dex" | "chain" = "chain";
  let label = `top-volume ${chainLabel} pools`;
  let peers: ReturnType<typeof pickPeers> = [];
  if (dex) {
    peers = await collect(`/networks/${net}/dexes/${encodeURIComponent(dex)}/pools`);
    if (peers.length >= COHORT_MIN_PEERS) {
      scope = "dex";
      label = `${dex} peers on ${chainLabel}`;
    } else {
      label = `top-volume ${chainLabel} pools (only ${peers.length} qualifying ${dex} pools)`;
    }
  }
  if (scope === "chain") peers = await collect(`/networks/${net}/pools`);
  peers = peers.slice(0, COHORT_MAX_PEERS);
  if (peers.length < COHORT_MIN_PEERS) {
    throw new CohortError(`only ${peers.length} qualifying peer pools (≥ $${COHORT_MIN_RESERVE_USD / 1000}k reserve, ≥ ${COHORT_MIN_POOL_AGE_DAYS}d old, not a major) in ${label} — needs ≥ ${COHORT_MIN_PEERS}`);
  }
  const read: CohortPeer[] = [];
  const errors: string[] = [];
  const queue = [...peers];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const r = await get<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(`${API}/networks/${net}/pools/${p.pool}/ohlcv/day?aggregate=1&limit=10&currency=usd`);
        const ch = priceChange7d(sortCandles(r.data?.attributes?.ohlcv_list ?? []), now);
        if (ch.pct == null) errors.push(`${p.symbol ?? p.address}: ${ch.reason}`);
        else read.push({ ...p, change7dPct: ch.pct });
      } catch (e) {
        errors.push(`${p.symbol ?? p.address}: ${why(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 2) }, worker));
  if (read.length < COHORT_MIN_PEERS) {
    throw new CohortError(`only ${read.length} of ${peers.length} peers' 7d changes could be read (${errors.slice(0, 2).join("; ")}) — needs ≥ ${COHORT_MIN_PEERS}`);
  }
  // Listing order, not completion order: the stored cohort is the same whichever request finished first.
  const order = new Map(peers.map((p, i) => [p.address, i]));
  read.sort((a, b) => order.get(a.address)! - order.get(b.address)!);
  return { key: cohortKey(chain, dex), chain, dex, scope, label, median: median(read.map((p) => p.change7dPct)), peers: read, unread: peers.length - read.length, at: now };
}

const validCohort = (c: unknown): c is Cohort =>
  !!c && typeof c === "object" && Array.isArray((c as Cohort).peers) && typeof (c as Cohort).at === "number" && typeof (c as Cohort).label === "string";

const LABEL = "Peer cohort (GeckoTerminal)";
const fmt = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

/**
 * The token's cohort median: fresh from KV when refreshed within COHORT_REFRESH_MS, else re-read (within `budgetMs`)
 * and stored; a failed refresh falls back to the cached cohort (≤ 6h, stale with its age); with nothing usable the
 * median is null with the exact reason. The token itself never counts in its own median.
 */
export async function readCohort(
  chain: Chain,
  dex: string | null,
  subject: string,
  opts: { budgetMs: number; now?: number; fetch?: typeof fetchCohort },
): Promise<CohortRead> {
  const now = opts.now ?? Date.now();
  const key = cohortKey(chain, dex);
  const url = dex ? `https://www.geckoterminal.com/${NETWORK[chain]}/${dex}/pools` : `https://www.geckoterminal.com/${NETWORK[chain]}/pools`;
  const stored = await kvGet<Cohort>(key);
  const cached = validCohort(stored) && now - stored.at >= 0 && now - stored.at <= COHORT_MAX_AGE_MS ? stored : null;
  const ageMin = (c: Cohort) => Math.round((now - c.at) / 60_000);

  const fromCache = (c: Cohort, why: string): CohortRead => read(c, ageMin(c), why);
  const nothing = (state: "failed" | "skipped", reason: string): CohortRead => ({
    median: null,
    size: null,
    label: null,
    ageMinutes: null,
    reason,
    status: { id: "cohort", label: LABEL, state, message: reason, url },
  });
  const read = (c: Cohort, age: number | null, note: string | null): CohortRead => {
    const peers = c.peers.filter((p) => p.address.toLowerCase() !== subject.toLowerCase());
    const stale = age != null ? `stale ${formatStaleAge(age)}` : null;
    if (peers.length < COHORT_MIN_PEERS) {
      const reason = `${c.label}: only ${peers.length} peers besides this token (needs ≥ ${COHORT_MIN_PEERS})`;
      return { median: null, size: null, label: c.label, ageMinutes: age, reason, status: { id: "cohort", label: LABEL, state: "partial", message: [reason, stale].filter(Boolean).join(" · "), url } };
    }
    const m = median(peers.map((p) => p.change7dPct));
    const parts = [`${c.label}: median 7d ${fmt(m)} across ${peers.length} peers`, c.unread ? `${c.unread} listed peers unreadable` : null, stale ? `${stale} (${note ?? "cached"})` : null];
    return {
      median: m,
      size: peers.length,
      label: c.label,
      ageMinutes: age,
      reason: null,
      status: { id: "cohort", label: LABEL, state: age != null ? "stale" : c.unread ? "partial" : "ok", message: parts.filter(Boolean).join(" · "), url },
    };
  };

  if (cached && now - cached.at < COHORT_REFRESH_MS()) return fromCache(cached, `refreshed every ${Math.round(COHORT_REFRESH_MS() / 60_000)}m`);
  if (opts.budgetMs < COHORT_MIN_FETCH_MS) {
    const reason = "no analysis time left to read the peer cohort";
    return cached ? fromCache(cached, `${reason}; last cohort used`) : nothing("failed", reason);
  }
  // One refresh at a time per cohort: a concurrent analysis uses the cached cohort.
  if (cached && ((await kvIncr(`${key}:lock`, 60)) ?? 1) > 1) return fromCache(cached, "another analysis is refreshing it");
  const failed = cached ? null : await kvGet<{ reason: string; at: number }>(`${key}:fail`);
  if (failed && now - failed.at >= 0) {
    return nothing("failed", `peer cohort read failed ${formatStaleAge(Math.round((now - failed.at) / 60_000))} ago (${failed.reason}); retried after ${COHORT_FAIL_BACKOFF_S / 60}m`);
  }
  // A read cut off by the budget keeps running and still stores its cohort (or its failure) for the next analysis.
  const job = (opts.fetch ?? fetchCohort)(chain, dex, { now }).then(
    async (c) => {
      await kvSet(key, c, Math.ceil(COHORT_MAX_AGE_MS / 1000));
      return c;
    },
    async (e: unknown) => {
      if (!cached) await kvSet(`${key}:fail`, { reason: e instanceof Error ? e.message : String(e), at: now }, COHORT_FAIL_BACKOFF_S);
      throw e;
    },
  );
  try {
    return read(await within(job, opts.budgetMs, `peer cohort timed out after ${Math.round(opts.budgetMs / 1000)}s`), null, null);
  } catch (e) {
    const reason = e instanceof BudgetError ? e.label : e instanceof Error ? e.message : String(e);
    if (cached) return fromCache(cached, `refresh failed: ${reason}`);
    return nothing("failed", `peer cohort unreadable: ${reason}`);
  }
}
