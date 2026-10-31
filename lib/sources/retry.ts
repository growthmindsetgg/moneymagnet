import { SourceError } from "./http";

export const BACKOFF_MS = [1000, 2000, 4000, 8000];

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 503s, "trade index is busy", "try again" answers and timeouts are transient; everything else is not. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  if (err instanceof SourceError && (err.status === 503 || err.status === 502 || err.status === 504 || err.status === 429)) return true;
  return /\b50[234]\b|busy|try again|timed? ?out|temporarily|ECONNRESET|fetch failed/i.test(err.message);
}

export interface RetryOptions {
  delays?: number[];
  sleep?: Sleep;
  /** Absolute epoch-ms deadline; no retry is started if its backoff would end past it. */
  deadline?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, delay: number, err: unknown) => void;
}

/** Runs `fn`, retrying transient failures with exponential backoff (default 1s, 2s, 4s, 8s → up to 5 attempts). */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { delays = BACKOFF_MS, sleep = realSleep, deadline, isRetryable = isTransient, onRetry } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const delay = delays[attempt];
      if (delay === undefined || !isRetryable(err)) throw err;
      if (deadline && Date.now() + delay >= deadline) throw err;
      onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
}

/** Outages a last good value may stand in for: 429, any 5xx, timeouts and the transient answers above. */
export function isOutage(err: unknown): boolean {
  if (isTransient(err)) return true;
  if (err instanceof SourceError && err.status != null && (err.status === 429 || err.status >= 500)) return true;
  return err instanceof Error && /\b(429|5\d\d)\b|too many requests|rate limit/i.test(err.message);
}
