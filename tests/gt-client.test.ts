import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKV, setKV } from "@/lib/kv";
import { gtConfig, gtGet, retryAfterSeconds, staleMinutes } from "@/lib/sources/gtClient";
import { isOutage } from "@/lib/sources/retry";

/** A fetch stub that records calls and answers from a queue of responses (the last one repeats). */
function stubFetch(responses: (() => Response)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r();
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number, headers: Record<string, string> = {}, body = "") => () => new Response(body, { status: code, headers });

const ENV = {} as Record<string, string | undefined>;
let clock = Date.parse("2026-11-23T10:00:00Z");
const now = () => clock;

beforeEach(() => {
  setKV(new MemoryKV());
  clock = Date.parse("2026-11-23T10:00:00Z");
});

describe("gtConfig", () => {
  it("no key ⇒ public GeckoTerminal; demo / pro keys ⇒ CoinGecko onchain roots with the right header", () => {
    expect(gtConfig({})).toMatchObject({ plan: "public", base: "https://api.geckoterminal.com/api/v2", headers: {}, rpm: 30 });
    expect(gtConfig({ GECKO_API_KEY: "k" })).toMatchObject({ plan: "demo", base: "https://api.coingecko.com/api/v3/onchain", headers: { "x-cg-demo-api-key": "k" }, rpm: 90 });
    expect(gtConfig({ GECKO_API_KEY: "k", GECKO_API_PLAN: "PRO" })).toMatchObject({ plan: "pro", base: "https://pro-api.coingecko.com/api/v3/onchain", headers: { "x-cg-pro-api-key": "k" }, rpm: 280 });
    expect(gtConfig({ GECKO_RPM: "7" }).rpm).toBe(7);
    expect(gtConfig({ GECKO_RPM: "nope" }).rpm).toBe(30);
  });
});

describe("gtGet", () => {
  it("fetches through the configured root and returns the body as this run's reading", async () => {
    const f = stubFetch([ok({ a: 1 })]);
    const r = await gtGet<{ a: number }>("/networks/solana/pools/X/ohlcv/day?aggregate=1", { fetchImpl: f.impl, env: { GECKO_API_KEY: "k" }, now });
    expect(r).toEqual({ body: { a: 1 }, cachedAgeS: null });
    expect(f.calls[0].url).toBe("https://api.coingecko.com/api/v3/onchain/networks/solana/pools/X/ohlcv/day?aggregate=1");
    expect(f.calls[0].headers["x-cg-demo-api-key"]).toBe("k");
  });

  it("reuses a cached body within its TTL and says how old it is; refetches after", async () => {
    const f = stubFetch([ok({ v: 1 }), ok({ v: 2 })]);
    await gtGet("/p", { cacheTtlS: 600, fetchImpl: f.impl, env: ENV, now });
    clock += 125_000;
    const hit = await gtGet<{ v: number }>("/p", { cacheTtlS: 600, fetchImpl: f.impl, env: ENV, now });
    expect(hit).toEqual({ body: { v: 1 }, cachedAgeS: 125 });
    expect(f.calls).toHaveLength(1);
    clock += 600_000;
    const fresh = await gtGet<{ v: number }>("/p", { cacheTtlS: 600, fetchImpl: f.impl, env: ENV, now });
    expect(fresh).toEqual({ body: { v: 2 }, cachedAgeS: null });
  });

  it("never retries a 429: one call, then a shared cool-down skips every caller without calling", async () => {
    const f = stubFetch([status(429, { "retry-after": "30" }), ok({})]);
    const first = await gtGet("/a", { fetchImpl: f.impl, env: ENV, now }).catch((e: Error) => e);
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toMatch(/HTTP 429: rate limited — GeckoTerminal answered 429; all callers pause 30s/);
    expect(isOutage(first)).toBe(true); // ⇒ adapters fall back to the last good reading, labelled stale
    expect(f.calls).toHaveLength(1);
    clock += 10_000;
    const second = await gtGet("/b", { fetchImpl: f.impl, env: ENV, now, priority: "background" }).catch((e: Error) => e);
    expect((second as Error).message).toMatch(/cooling down 20s/);
    expect(f.calls).toHaveLength(1);
    clock += 21_000;
    await expect(gtGet("/c", { fetchImpl: f.impl, env: ENV, now })).resolves.toMatchObject({ cachedAgeS: null });
  });

  it("a 429 without Retry-After pauses until the next minute window opens (the quota is per minute), at least 5s", async () => {
    const f = stubFetch([status(429)]);
    clock = Date.parse("2026-11-23T10:00:40Z");
    const e = await gtGet("/a", { fetchImpl: f.impl, env: ENV, now }).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/pause 21s/);
    clock = Date.parse("2026-11-23T10:01:58Z");
    const g = stubFetch([status(429)]);
    const e2 = await gtGet("/b", { fetchImpl: g.impl, env: ENV, now }).catch((x: Error) => x);
    expect((e2 as Error).message).toMatch(/pause 5s/);
  });

  it("a core call waits out a cool-down that ends within 8s; a background call skips at once", async () => {
    const f = stubFetch([status(429, { "retry-after": "6" }), ok({ v: 1 })]);
    const sleep = async (ms: number) => { clock += ms; };
    await gtGet("/a", { fetchImpl: f.impl, env: ENV, now, sleep }).catch(() => undefined);
    await expect(gtGet("/bg", { priority: "background", fetchImpl: f.impl, env: ENV, now, sleep })).rejects.toThrow(/cooling down 6s/);
    await expect(gtGet("/core", { fetchImpl: f.impl, env: ENV, now, sleep })).resolves.toEqual({ body: { v: 1 }, cachedAgeS: null });
    expect(f.calls).toHaveLength(2);
  });

  it("budget used: a core call waits for the next minute when it opens within 8s; otherwise, and for background, it skips", async () => {
    const env = { GECKO_RPM: "2" };
    const f = stubFetch([ok({})]);
    const sleep = async (ms: number) => { clock += ms; };
    clock = Date.parse("2026-11-23T10:00:55Z");
    await gtGet("/1", { fetchImpl: f.impl, env, now, sleep });
    await gtGet("/2", { fetchImpl: f.impl, env, now, sleep });
    await expect(gtGet("/bg", { priority: "background", fetchImpl: f.impl, env, now, sleep })).rejects.toThrow(/budget is used/);
    await expect(gtGet("/3", { fetchImpl: f.impl, env, now, sleep })).resolves.toBeTruthy(); // waited ~5s into 10:01
    expect(clock).toBeGreaterThanOrEqual(Date.parse("2026-11-23T10:01:00Z"));
    clock = Date.parse("2026-11-23T10:01:10Z");
    await gtGet("/4", { fetchImpl: f.impl, env, now, sleep });
    await expect(gtGet("/5", { fetchImpl: f.impl, env, now, sleep })).rejects.toThrow(/budget is used/); // next window 50s away: no wait
  });

  it("per-minute budget: core calls may use all of it, background calls half; a new minute resets it", async () => {
    const env = { GECKO_RPM: "4" };
    const f = stubFetch([ok({})]);
    for (let i = 0; i < 2; i++) await gtGet(`/bg${i}`, { priority: "background", fetchImpl: f.impl, env, now });
    const bg = await gtGet("/bg2", { priority: "background", fetchImpl: f.impl, env, now }).catch((e: Error) => e);
    expect((bg as Error).message).toMatch(/call budget is used \(2 background calls\/min/);
    expect(isOutage(bg)).toBe(true);
    await gtGet("/core", { fetchImpl: f.impl, env, now }); // 4th unit used (the rejected background call counted as the 3rd)
    const over = await gtGet("/core2", { fetchImpl: f.impl, env, now }).catch((e: Error) => e);
    expect((over as Error).message).toMatch(/4 core calls\/min/);
    expect(f.calls).toHaveLength(3);
    clock += 60_000;
    await expect(gtGet("/core3", { fetchImpl: f.impl, env, now })).resolves.toBeTruthy();
  });

  it("retries a timeout / 5xx once (counted against the budget), nothing else", async () => {
    const f = stubFetch([status(503, {}, "busy"), ok({ ok: true })]);
    await expect(gtGet("/x", { fetchImpl: f.impl, env: ENV, now })).resolves.toEqual({ body: { ok: true }, cachedAgeS: null });
    expect(f.calls).toHaveLength(2);
    const g = stubFetch([status(404, {}, "not found")]);
    await expect(gtGet("/y", { fetchImpl: g.impl, env: ENV, now })).rejects.toThrow(/HTTP 404/);
    expect(g.calls).toHaveLength(1);
  });

  it("a keyed plan out of monthly credits is treated as a rate limit with a 1h pause", async () => {
    const f = stubFetch([status(403, {}, '{"error":"You have exceeded your monthly credit limit"}'), ok({})]);
    const env = { GECKO_API_KEY: "k" };
    const e = await gtGet("/a", { fetchImpl: f.impl, env, now }).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/HTTP 429: rate limited — the CoinGecko demo plan reports its call credits are used \(HTTP 403\); pausing 60 min/);
    clock += 30 * 60_000;
    await expect(gtGet("/b", { fetchImpl: f.impl, env, now })).rejects.toThrow(/cooling down/);
    expect(f.calls).toHaveLength(1);
    // The public API's 403 is not a credits message: a plain error.
    const g = stubFetch([status(403, {}, "forbidden")]);
    await expect(gtGet("/c", { fetchImpl: g.impl, env: ENV, now })).rejects.toThrow(/HTTP 403: forbidden/);
  });
});

describe("helpers", () => {
  it("Retry-After: seconds or an HTTP date, clamped to 5 min; junk ⇒ null", () => {
    const t = Date.parse("2026-11-23T10:00:00Z");
    expect(retryAfterSeconds("12", t)).toBe(12);
    expect(retryAfterSeconds("9999", t)).toBe(300);
    expect(retryAfterSeconds(new Date(t + 45_000).toUTCString(), t)).toBe(45);
    expect(retryAfterSeconds("soon", t)).toBeNull();
    expect(retryAfterSeconds(null, t)).toBeNull();
  });
  it("staleMinutes: under a minute is this run's reading, else whole minutes", () => {
    expect(staleMinutes(null)).toBeNull();
    expect(staleMinutes(59)).toBeNull();
    expect(staleMinutes(60)).toBe(1);
    expect(staleMinutes(1799)).toBe(29);
  });
});
