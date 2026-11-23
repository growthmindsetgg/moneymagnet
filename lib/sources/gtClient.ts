import { SourceError } from "./http";
import { kvGet, kvIncr, kvSet } from "../kv";

/**
 * The one way the app calls GeckoTerminal (or the same onchain API through a CoinGecko key).
 *
 * Why: GeckoTerminal's free tier is a small per-minute quota shared by every serverless instance on Vercel, and a
 * single analysis makes several calls (pools + up to 5 candle series, plus the peer cohort). Retrying a 429 inside the
 * request multiplied the burst. Here:
 *   - a 429 is never retried in-request; it starts a shared cool-down (Retry-After, else 60s) during which every caller
 *     skips the call at once, so the adapters fall back to their last good readings (labelled stale) instead of waiting;
 *   - a shared per-minute call budget (KV counter) keeps the app under the quota: "core" calls (the token being scored)
 *     may use all of it, "background" calls (peer cohort, social links, time machine) at most half, so they never starve
 *     scoring;
 *   - an optional short response cache returns the cached body with its age, so callers label it stale (≥ 1 min) on
 *     exactly the fields it fed;
 *   - timeouts and 5xx get one retry; nothing else does.
 * Skips and cool-downs are reported as HTTP 429 errors, so every existing outage path (isOutage → last good, stale)
 * applies unchanged.
 *
 * Keys (optional): GECKO_API_KEY with GECKO_API_PLAN = "demo" (CoinGecko Demo: api.coingecko.com, x-cg-demo-api-key,
 * 100 calls/min, 10k calls/month, attribution required) or "pro" (pro-api.coingecko.com, x-cg-pro-api-key). Without a
 * key: the public GeckoTerminal API. GECKO_RPM overrides the per-minute budget.
 */

export type GtPlan = "public" | "demo" | "pro";
export type GtPriority = "core" | "background";

export interface GtConfig {
  plan: GtPlan;
  base: string;
  headers: Record<string, string>;
  /** Calls per minute the app allows itself across all instances (headroom under the provider's limit). */
  rpm: number;
}

/**
 * Budgets per plan. Public: GeckoTerminal has documented 30 calls/min; production served a ~24-call burst without a
 * 429 (2026-11-23), and a budget below the real limit only fails calls the provider would have answered. Demo 100/min,
 * Pro ≥ 300/min: kept under. A real 429 still triggers the cool-down whatever the budget says.
 */
const DEFAULT_RPM: Record<GtPlan, number> = { public: 30, demo: 90, pro: 280 };
const BACKGROUND_SHARE = 0.5;
/** A core call that finds the budget used or a cool-down running waits for it to clear when that is this close. */
export const CORE_WAIT_MS = 8_000;
const COOLDOWN_MIN_S = 5;
const COOLDOWN_MAX_S = 300;
const CREDITS_COOLDOWN_S = 3_600;

export function gtConfig(env: Record<string, string | undefined> = process.env): GtConfig {
  const key = env.GECKO_API_KEY?.trim();
  const plan: GtPlan = !key ? "public" : env.GECKO_API_PLAN?.trim().toLowerCase() === "pro" ? "pro" : "demo";
  const rpmEnv = Number(env.GECKO_RPM);
  const rpm = Number.isFinite(rpmEnv) && rpmEnv > 0 ? Math.floor(rpmEnv) : DEFAULT_RPM[plan];
  if (plan === "pro") return { plan, base: "https://pro-api.coingecko.com/api/v3/onchain", headers: { "x-cg-pro-api-key": key! }, rpm };
  if (plan === "demo") return { plan, base: "https://api.coingecko.com/api/v3/onchain", headers: { "x-cg-demo-api-key": key! }, rpm };
  return { plan, base: "https://api.geckoterminal.com/api/v2", headers: {}, rpm };
}

export interface GtGetOptions {
  priority?: GtPriority;
  /** Reuse a cached body up to this age (seconds). Omit for no cache. */
  cacheTtlS?: number;
  timeoutMs?: number;
  /** Test hooks. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export interface GtResponse<T> {
  body: T;
  /** Seconds since the cached body was fetched; null when fetched in this call. */
  cachedAgeS: number | null;
}

const cacheKey = (plan: GtPlan, path: string) => `gt:cache:v1:${plan}:${path}`;
const cooldownKey = (plan: GtPlan) => `gt:cooldown:v1:${plan}`;
const budgetKey = (plan: GtPlan, minute: number) => `gt:budget:v1:${plan}:${minute}`;

const rateLimited = (why: string) => new SourceError(`HTTP 429: rate limited — ${why}`, 429);

/** Retry-After as seconds (delta-seconds or an HTTP date), clamped; null when absent / unparsable. */
export function retryAfterSeconds(h: string | null, now: number): number | null {
  if (!h) return null;
  const n = Number(h);
  const s = Number.isFinite(n) ? n : (Date.parse(h) - now) / 1000;
  return Number.isFinite(s) && s > 0 ? Math.min(COOLDOWN_MAX_S, Math.ceil(s)) : null;
}

/** GET `path` (e.g. "/networks/solana/pools/X/ohlcv/day?aggregate=1&limit=30") on the configured GeckoTerminal API. */
export async function gtGet<T>(path: string, opts: GtGetOptions = {}): Promise<GtResponse<T>> {
  const cfg = gtConfig(opts.env);
  const now = opts.now ?? Date.now;
  const priority = opts.priority ?? "core";
  const [cached, cooldown] = await Promise.all([
    opts.cacheTtlS ? kvGet<{ at: number; body: T }>(cacheKey(cfg.plan, path)) : Promise.resolve(null),
    kvGet<{ until: number }>(cooldownKey(cfg.plan)),
  ]);
  if (cached && opts.cacheTtlS && now() - cached.at <= opts.cacheTtlS * 1000) return { body: cached.body, cachedAgeS: Math.max(0, Math.floor((now() - cached.at) / 1000)) };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A core call waits out a cool-down that ends within CORE_WAIT_MS; anything else skips at once.
  if (cooldown && cooldown.until > now()) {
    const left = cooldown.until - now();
    if (priority !== "core" || left > CORE_WAIT_MS) throw rateLimited(`GeckoTerminal answered 429 recently; cooling down ${Math.ceil(left / 1000)}s before calling again`);
    await sleep(left + 100);
  }

  const cap = priority === "core" ? cfg.rpm : Math.max(1, Math.floor(cfg.rpm * BACKGROUND_SHARE));
  let used = await kvIncr(budgetKey(cfg.plan, Math.floor(now() / 60_000)), 120);
  // Budget used: a core call waits for the next minute's window when it opens within CORE_WAIT_MS (a burst is smoothed,
  // not failed); a background call never waits.
  if (used != null && used > cap && priority === "core") {
    const toNext = (Math.floor(now() / 60_000) + 1) * 60_000 - now();
    if (toNext <= CORE_WAIT_MS) {
      await sleep(toNext + 100);
      used = await kvIncr(budgetKey(cfg.plan, Math.floor(now() / 60_000)), 120);
    }
  }
  // KV unavailable (null): fail open — the provider's own 429 still triggers the cool-down.
  if (used != null && used > cap) throw rateLimited(`this minute's GeckoTerminal call budget is used (${cap} ${priority} calls/min, ${cfg.plan} plan) — skipped to stay under the provider limit`);

  const fetchImpl = opts.fetchImpl ?? fetch;
  const call = async (): Promise<T> => {
    const res = await fetchImpl(`${cfg.base}${path}`, {
      headers: { accept: "application/json", "user-agent": "HoodTier/0.1 (+token research)", ...cfg.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      cache: "no-store",
    });
    if (res.status === 429) {
      // Without Retry-After: the quota is per minute, so pause until the next minute's window opens (≥ 5s).
      const s = retryAfterSeconds(res.headers.get("retry-after"), now()) ?? Math.max(COOLDOWN_MIN_S, Math.ceil(((Math.floor(now() / 60_000) + 1) * 60_000 - now()) / 1000) + 1);
      await kvSet(cooldownKey(cfg.plan), { until: now() + s * 1000 }, s + 5);
      throw rateLimited(`GeckoTerminal answered 429; all callers pause ${s}s`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // A keyed plan out of monthly credits answers 4xx, not 429: treat it as a rate limit (last good stands in) and pause an hour.
      if (cfg.plan !== "public" && (res.status === 402 || res.status === 403) && /credit|quota|limit|exceed/i.test(text)) {
        await kvSet(cooldownKey(cfg.plan), { until: now() + CREDITS_COOLDOWN_S * 1000 }, CREDITS_COOLDOWN_S + 5);
        throw rateLimited(`the CoinGecko ${cfg.plan} plan reports its call credits are used (HTTP ${res.status}); pausing ${CREDITS_COOLDOWN_S / 60} min`);
      }
      throw new SourceError(`HTTP ${res.status}: ${text.slice(0, 120)}`, res.status);
    }
    return (await res.json()) as T;
  };
  let body: T;
  try {
    body = await call();
  } catch (e) {
    const retryable = (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) || (e instanceof SourceError && e.status != null && e.status >= 500);
    if (!retryable) throw e;
    // The retry is a second call: it counts against the budget too.
    const again = await kvIncr(budgetKey(cfg.plan, Math.floor(now() / 60_000)), 120);
    if (again != null && again > cap) throw e;
    body = await call();
  }
  if (opts.cacheTtlS) await kvSet(cacheKey(cfg.plan, path), { at: now(), body }, opts.cacheTtlS + 60);
  return { body, cachedAgeS: null };
}

/** Whole minutes a cached body is old, or null when it counts as this run's reading (< 1 min — GeckoTerminal's own refresh step). */
export function staleMinutes(cachedAgeS: number | null): number | null {
  return cachedAgeS == null || cachedAgeS < 60 ? null : Math.floor(cachedAgeS / 60);
}
