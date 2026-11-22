import { fetchJson } from "./http";
import { kvIncr } from "../kv";

/**
 * Every Helius request in the process goes through one queue: at most 2 in flight, at least
 * 100ms between starts, retries with backoff on HTTP 429, and a 2-minute response cache keyed by
 * method + params (so parallel analyses of the same token reuse each other's answers).
 */
export const HELIUS_CONCURRENCY = 2;
export const HELIUS_SPACING_MS = 100;
export const HELIUS_CACHE_MS = 120_000;
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000, 12_000];
/** Cross-instance limit: every serverless instance shares this window through the KV's atomic counter. */
/** Helius free tier: 10 requests/s. We stay at 9 per one-second window across all instances. */
export const HELIUS_GLOBAL_PER_WINDOW = 9;
export const HELIUS_GLOBAL_WINDOW_MS = 1000;

/** Waits for a slot in the shared (KV) window; fails open when the KV is unavailable. */
async function globalSlot(weight = 1): Promise<void> {
  // A batch of N calls counts as N requests at Helius, so it takes N slots.
  for (let i = 0; i < 400; i++) {
    const w = Math.floor(Date.now() / HELIUS_GLOBAL_WINDOW_MS);
    const n = await kvIncr(`helius:win:${w}`, 5, weight);
    if (n == null || n <= HELIUS_GLOBAL_PER_WINDOW) return;
    await new Promise((r) => setTimeout(r, (w + 1) * HELIUS_GLOBAL_WINDOW_MS - Date.now() + 5));
  }
}

let active = 0;
let lastStart = 0;
const waiting: (() => void)[] = [];
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export const heliusStats = { requests: 0, retries429: 0, cacheHits: 0, maxActive: 0 };

function pump() {
  if (active >= HELIUS_CONCURRENCY || !waiting.length) return;
  const wait = Math.max(0, lastStart + HELIUS_SPACING_MS - Date.now());
  if (wait > 0) {
    setTimeout(pump, wait);
    return;
  }
  lastStart = Date.now();
  active++;
  heliusStats.maxActive = Math.max(heliusStats.maxActive, active);
  waiting.shift()!();
  pump();
}

/** Runs `task` when the queue allows it. */
export async function queued<T>(task: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    waiting.push(resolve);
    pump();
  });
  try {
    return await task();
  } finally {
    active--;
    pump();
  }
}

const is429 = (e: unknown) => e instanceof Error && /\b429\b|too many requests|rate limit/i.test(e.message);

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await queued(run);
    } catch (err) {
      if (!is429(err) || i >= RETRY_DELAYS.length) throw err;
      heliusStats.retries429++;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[i]));
    }
  }
}

function cached<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < HELIUS_CACHE_MS) {
    heliusStats.cacheHits++;
    return Promise.resolve(hit.value as T);
  }
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    p = run()
      .then((v) => {
        cache.set(key, { at: Date.now(), value: v });
        if (cache.size > 5000) cache.delete(cache.keys().next().value!);
        return v;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Calls per batched HTTP request (each counts against the rate limit). */
const BATCH = 5;

/** Helius JSON-RPC client through the global queue and cache. */
export function heliusRpc(key: string) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  const post = <R,>(body: unknown, timeoutMs: number, weight = 1) =>
    withRetry(async () => {
      await globalSlot(weight);
      heliusStats.requests++;
      return fetchJson<R>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs });
    });

  const call = <T,>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> =>
    cached(`${method}:${JSON.stringify(params)}`, async () => {
      const r = await post<{ result?: T; error?: { message: string; code?: number } }>({ jsonrpc: "2.0", id: 1, method, params }, timeoutMs);
      if (r.error) {
        const e = new Error(`Helius ${method}: ${r.error.message.slice(0, 120)}`);
        if (r.error.code === 429) e.message += " (429)";
        throw e;
      }
      return r.result as T;
    });

  /**
   * Batched calls (5 per HTTP request, charged 5 slots), each batch through the queue. Only real results are
   * cached per item: an item that came back with an error, with no result, or not at all is reported in
   * `errors` (by index) and never cached, so the next request asks again instead of replaying the hole.
   */
  const batchSettled = async <T,>(method: string, paramsList: unknown[]): Promise<{ values: (T | undefined)[]; errors: Map<number, string> }> => {
    const values: (T | undefined)[] = new Array(paramsList.length).fill(undefined);
    const errors = new Map<number, string>();
    const missing: number[] = [];
    paramsList.forEach((p, i) => {
      const hit = cache.get(`${method}:${JSON.stringify(p)}`);
      if (hit && Date.now() - hit.at < HELIUS_CACHE_MS && hit.value != null) {
        values[i] = hit.value as T;
        heliusStats.cacheHits++;
      } else missing.push(i);
    });
    for (let i = 0; i < missing.length; i += BATCH) {
      const idx = missing.slice(i, i + BATCH);
      const res = await post<{ id: number; result?: T | null; error?: { message?: string; code?: number } }[]>(
        idx.map((k) => ({ jsonrpc: "2.0", id: k, method, params: paramsList[k] })),
        30_000,
        idx.length,
      );
      const answered = new Set<number>();
      for (const r of Array.isArray(res) ? res : []) {
        if (typeof r?.id !== "number" || !idx.includes(r.id)) continue;
        answered.add(r.id);
        if (r.error) {
          errors.set(r.id, `Helius ${method}: ${(r.error.message ?? "error").slice(0, 100)}${r.error.code === 429 ? " (429)" : ""}`);
        } else if (r.result == null) {
          errors.set(r.id, `Helius ${method}: no result`);
        } else {
          values[r.id] = r.result;
          cache.set(`${method}:${JSON.stringify(paramsList[r.id])}`, { at: Date.now(), value: r.result });
        }
      }
      for (const k of idx) if (!answered.has(k)) errors.set(k, `Helius ${method}: item missing from the batch response`);
    }
    return { values, errors };
  };
  /** Values only (failed items are undefined); prefer `batchSettled` to see which failed. */
  const batch = async <T,>(method: string, paramsList: unknown[]): Promise<(T | undefined)[]> => (await batchSettled<T>(method, paramsList)).values;
  return { call, batch, batchSettled };
}

/** Test hook. */
export function resetHeliusQueue() {
  cache.clear();
  inflight.clear();
  Object.assign(heliusStats, { requests: 0, retries429: 0, cacheHits: 0, maxActive: 0 });
}
