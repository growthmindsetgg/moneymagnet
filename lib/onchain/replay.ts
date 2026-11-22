import { hex, TRANSFER_TOPIC, topicAddress, type Rpc, type RpcLog, MAX_SPAN } from "./rpc";

const ZERO = "0x0000000000000000000000000000000000000000";

export interface ReplayState {
  v: 1;
  token: string;
  creationBlock: number;
  /** Last block whose Transfer logs are fully applied. */
  scannedTo: number;
  /** address → raw balance (decimal string). Zero balances are dropped. */
  balances: Record<string, string>;
  logCount: number;
  /** Current eth_getLogs span; adapts to the RPC's limits. */
  chunk: number;
  /** True once the initial replay reached the chain head. */
  complete: boolean;
  /** Wall-clock ms spent replaying until the first completion (across invocations). */
  replayMs: number;
  firstCompletedAt: string | null;
  /** address → "wallet" | "contract" from eth_getCode, cached for top holders. */
  codeKinds: Record<string, "wallet" | "contract">;
  /** Last error that stopped an advance early (the replay resumes from scannedTo next time). */
  lastError?: string | null;
}

export function newReplayState(token: string, creationBlock: number): ReplayState {
  return {
    v: 1,
    token,
    creationBlock,
    scannedTo: creationBlock - 1,
    balances: {},
    logCount: 0,
    chunk: 500_000,
    complete: false,
    replayMs: 0,
    firstCompletedAt: null,
    codeKinds: {},
  };
}

/** Applies ERC-20 Transfer logs to a balance map. Pure — the unit-testable core of the replay. */
export function applyTransferLogs(balances: Map<string, bigint>, logs: RpcLog[]): number {
  let applied = 0;
  for (const l of logs) {
    if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue; // skip ERC-721 style (4 topics)
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    const value = l.data && l.data !== "0x" ? BigInt(l.data) : 0n;
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
    applied++;
  }
  return applied;
}

export const toMap = (b: Record<string, string>) => new Map(Object.entries(b).map(([k, v]) => [k, BigInt(v)]));
export function toRecord(m: Map<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of m) if (v > 0n) out[k] = v.toString();
  return out;
}

const isRateLimit = (e: unknown) => e instanceof Error && /\b429\b|rate|too many requests/i.test(e.message);
const isRangeError = (e: unknown) =>
  e instanceof Error && !isRateLimit(e) && /exceeds limit|narrow|too large|range|timeout|timed out|aborted|50[234]|limit/i.test(`${e.name} ${e.message}`);

/** Rejects (TimeoutError) when `p` takes longer than `ms`; the timer is always cleared. */
function withinMs<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("replay budget reached (timed out)"), { name: "TimeoutError" })), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export interface AdvanceOptions {
  budgetMs: number;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  now?: () => number;
  minChunk?: number;
  onProgress?: (s: ReplayState) => void;
}

/**
 * Advances the replay towards `head` within a time budget. Queries run in batches of
 * consecutive ranges; a range that the RPC rejects (too many logs / too wide / timeout)
 * halves the chunk size and is retried, sparse ranges double it. Only a contiguous prefix of
 * successful ranges is applied, so `scannedTo` is always exact.
 */
export async function advanceReplay(rpc: Rpc, state: ReplayState, head: number, opts: AdvanceOptions): Promise<ReplayState> {
  const now = opts.now ?? Date.now;
  let concurrency = opts.concurrency ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let rateLimited = 0;
  const minChunk = opts.minChunk ?? 500;
  const t0 = now();
  const balances = toMap(state.balances);
  const s: ReplayState = { ...state };
  let errors = 0;
  s.lastError = null;

  while (s.scannedTo < head && now() - t0 < opts.budgetMs) {
    const ranges: [number, number][] = [];
    let cursor = s.scannedTo + 1;
    for (let i = 0; i < concurrency && cursor <= head; i++) {
      const end = Math.min(head, cursor + s.chunk - 1);
      ranges.push([cursor, end]);
      cursor = end + 1;
    }
    // Never let one batch run past the budget (a slow endpoint, or the pool's own retries, used to hold a request
    // for 30s): each call races the time left; a call that loses is a range failure and nothing of it is applied.
    const left = Math.max(1_000, Math.min(30_000, opts.budgetMs - (now() - t0)));
    const results = await Promise.allSettled(
      ranges.map(([f, t]) =>
        withinMs(rpc<RpcLog[]>("eth_getLogs", [{ address: s.token, topics: [TRANSFER_TOPIC], fromBlock: hex(f), toBlock: hex(t) }], left), left + 250),
      ),
    );
    let maxLogs = 0;
    let failed = false;
    let throttled = false;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        if (isRateLimit(r.reason)) {
          throttled = true;
        } else {
          failed = true;
          if (!isRangeError(r.reason) || s.chunk <= minChunk) errors++;
        }
        s.lastError = String((r.reason as Error)?.message ?? r.reason).slice(0, 160);
        break;
      }
      // Apply in block order (the RPC returns logs ordered within a range).
      s.logCount += applyTransferLogs(balances, r.value);
      s.scannedTo = ranges[i][1];
      maxLogs = Math.max(maxLogs, r.value.length);
    }
    if (errors >= 3) break; // persistent non-range failure: stop, keep progress, resume next time
    if (throttled) {
      // Respect the public RPC: drop to one request at a time and back off exponentially.
      concurrency = 1;
      rateLimited = Math.min(rateLimited + 1, 5);
      if (now() - t0 + 1000 * 2 ** (rateLimited - 1) >= opts.budgetMs) break;
      await sleep(1000 * 2 ** (rateLimited - 1));
      continue;
    }
    rateLimited = 0;
    if (failed) s.chunk = Math.max(minChunk, Math.floor(s.chunk / 2));
    else if (maxLogs < 2500) s.chunk = Math.min(MAX_SPAN, s.chunk * 2);
    else if (maxLogs > 7000) s.chunk = Math.max(minChunk, Math.floor(s.chunk * 0.6));
    opts.onProgress?.({ ...s, balances: {} });
  }

  s.balances = toRecord(balances);
  if (!s.complete) {
    s.replayMs += now() - t0;
    if (s.scannedTo >= head) {
      s.complete = true;
      s.firstCompletedAt = new Date(now()).toISOString();
    }
  }
  return s;
}

export function replayProgressPct(s: ReplayState, head: number): number {
  const total = head - s.creationBlock + 1;
  return total > 0 ? Math.min(100, ((s.scannedTo - s.creationBlock + 1) / total) * 100) : 100;
}

export interface RankedHolder {
  address: string;
  raw: bigint;
}

export function rankHolders(balances: Record<string, string>, limit = 100): { top: RankedHolder[]; count: number } {
  const all = Object.entries(balances)
    .map(([address, v]) => ({ address, raw: BigInt(v) }))
    .filter((h) => h.raw > 0n);
  all.sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));
  return { top: all.slice(0, limit), count: all.length };
}
