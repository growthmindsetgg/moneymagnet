import { kvIncr } from "./kv";

/**
 * Per-client fixed-window limit for live analyses (cache hits are free). Counts live in the
 * shared KV so every serverless instance sees the same window. Fails open if the KV is down:
 * a broken limiter must never take the tool offline.
 */
export const LIVE_ANALYSES_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 12);

export interface RateDecision {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

export function clientId(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "local";
}

export async function takeLiveSlot(client: string, limit = LIVE_ANALYSES_PER_MIN, now = Date.now()): Promise<RateDecision> {
  const window = Math.floor(now / 60_000);
  const retryAfter = 60 - Math.floor((now % 60_000) / 1000);
  const key = `rl:v1:${client}:${window}`;
  const n = await kvIncr(key, 120);
  if (n == null) return { ok: true, remaining: limit, retryAfter }; // KV down: fail open
  if (n > limit) return { ok: false, remaining: 0, retryAfter };
  return { ok: true, remaining: limit - n, retryAfter };
}
