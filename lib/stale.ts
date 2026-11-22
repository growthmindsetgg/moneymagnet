import { kvGet, kvSet } from "./kv";
import type { TokenSnapshot } from "./types";

/** Last-good values older than this are never used. */
export const STALE_MAX_MS = 6 * 60 * 60 * 1000;

/** Per-field last-good values, so a partially failing source can be patched field by field. */
export interface StoredFields {
  fields: Record<string, { v: unknown; at: number }>;
}

const NOT_STALEABLE = new Set(["links", "fakeSignals", "staleFields", "chain", "address"]);

/** Fields measured relative to "now" (field → its unit in ms): their stale age is added on refill. */
const TIME_RELATIVE: Record<string, number> = {
  ageHours: 3_600_000,
  ageMinutes: 60_000,
  lastTradeHoursAgo: 3_600_000,
  // An upper bound ages too: "traded within 1h" read 5h ago is "within 6h" now.
  lastTradeWithinHours: 3_600_000,
  founderHoldDays: 86_400_000,
  teamHoldDays: 86_400_000,
};

const present =(v: unknown) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);

/**
 * Bumped when a source's derivation changes, so a snapshot computed by the old logic is never served as
 * "stale" after the fix. v2 (2026-11-20): pump.fun dust pools / graduated curve pools (SHEEP served a pre-fix
 * $0.23 volume as stale for 31 min).
 */
// Bumped when an adapter's stored values change meaning, so pre-fix values are never served as stale.
// v3 gecko/dexscreener + v2 others: audit fixes (missing figures were stored as 0; nad.fun volume was in the wrong unit;
// failed RPC reads were stored as "owner renounced"; RugCheck/ScanHood absences were stored as passes/percentages; GoPlus
// lists summing > 100% were stored as concentration).
// v4 gecko/dexscreener (2026-11-22): a dust-only pool listing (a side pool of a market the indexer does not see) stored
// its liquidity / volume / buyers as the token's (MOE: $4.41, 1 buyer); those are no longer stored.
export const STALE_VERSION: Record<string, number> = {
  geckoterminal: 4,
  dexscreener: 4,
  nadfun: 2,
  rugcheck: 2,
  scanhood: 2,
  helius: 2,
  goplus: 2,
  rpc: 2,
  "base-rpc": 2,
  "monad-rpc": 2,
};

export const lastGoodKey = (source: string, chain: string, address: string) =>
  `lastgood:${source}${(STALE_VERSION[source] ?? 1) > 1 ? `@v${STALE_VERSION[source]}` : ""}:${chain}:${address.toLowerCase()}`;

export function mergeGood(prev: StoredFields | null, live: Partial<TokenSnapshot>, now: number): StoredFields {
  const fields = { ...(prev?.fields ?? {}) };
  for (const [k, v] of Object.entries(live)) {
    if (!NOT_STALEABLE.has(k) && present(v)) fields[k] = { v, at: now };
  }
  return { fields };
}

export interface StaleFill {
  data: Partial<TokenSnapshot>;
  /** Field → age in minutes, only for fields that were filled from storage. */
  staleFields: Record<string, number>;
  oldestMinutes: number | null;
}

/** Fills fields the live call did not deliver from the last good values (≤ 6h old). */
export function fillFromStale(
  live: Partial<TokenSnapshot>,
  stored: StoredFields | null,
  now: number,
  /** Only these fields may be filled (those whose producing calls all failed). Omit to allow all. */
  allow?: Set<string>,
  maxAgeMs = STALE_MAX_MS,
): StaleFill {
  const data: Record<string, unknown> = { ...live };
  const staleFields: Record<string, number> = {};
  let oldest: number | null = null;
  for (const [k, { v, at }] of Object.entries(stored?.fields ?? {})) {
    if (present(data[k]) || (allow && !allow.has(k))) continue;
    const age = now - at;
    if (age > maxAgeMs || age < 0) continue;
    // Time-relative values keep counting while they sit in storage: a 5h-old "2h since the last trade" is 7h now.
    const unitMs = TIME_RELATIVE[k];
    data[k] = unitMs != null && typeof v === "number" ? v + age / unitMs : v;
    const minutes = Math.round(age / 60_000);
    staleFields[k] = minutes;
    oldest = Math.max(oldest ?? 0, minutes);
  }
  return { data: data as Partial<TokenSnapshot>, staleFields, oldestMinutes: oldest };
}

export function formatStaleAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export async function loadGood(key: string): Promise<StoredFields | null> {
  return kvGet<StoredFields>(key);
}

export async function saveGood(key: string, prev: StoredFields | null, live: Partial<TokenSnapshot>, now: number) {
  await kvSet(key, mergeGood(prev, live, now), 24 * 60 * 60);
}
