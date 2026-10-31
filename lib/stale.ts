import { kvGet, kvSet } from "./kv";
import type { TokenSnapshot } from "./types";

/** Last-good values older than this are never used. */
export const STALE_MAX_MS = 6 * 60 * 60 * 1000;

/** Per-field last-good values, so a partially failing source can be patched field by field. */
export interface StoredFields {
  fields: Record<string, { v: unknown; at: number }>;
}

const NOT_STALEABLE = new Set(["links", "fakeSignals", "staleFields", "chain", "address"]);

const present = (v: unknown) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);

export const lastGoodKey = (source: string, chain: string, address: string) => `lastgood:${source}:${chain}:${address.toLowerCase()}`;

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
    data[k] = v;
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
