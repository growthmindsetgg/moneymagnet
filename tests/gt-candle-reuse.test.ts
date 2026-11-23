import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV, setKV } from "@/lib/kv";
import { geckoterminal, CANDLE_CACHE_S } from "@/lib/sources/geckoterminal";

const TOKEN = "So11111111111111111111111111111111111111112x"; // any Solana-shaped id; never matched as "base" pool
const POOL = "Pool1111111111111111111111111111111111111111";
const T0 = Date.parse("2026-11-23T10:00:00Z");

/** n candles ending now, `step` seconds apart, gently rising (newest first, as GeckoTerminal sends them). */
function candles(n: number, step: number, endS: number) {
  return Array.from({ length: n }, (_, i) => {
    const t = endS - i * step;
    const p = 1 + (n - i) * 0.001;
    return [t, p, p * 1.01, p * 0.99, p, 1000];
  });
}

function gtStub() {
  const seen: string[] = [];
  const impl = vi.fn(async (url: string) => {
    seen.push(url);
    const nowS = Math.floor(Date.now() / 1000);
    if (url.includes("/tokens/")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: `solana_${POOL}`,
              attributes: { name: "X / SOL", address: POOL, reserve_in_usd: "50000", pool_created_at: "2026-09-01T00:00:00Z", fdv_usd: "900000", base_token_price_usd: "1", volume_usd: { h24: "20000" }, price_change_percentage: { h24: "1" }, transactions: { h24: { buys: 10, sells: 8, buyers: 9, sellers: 7 } } },
              relationships: { base_token: { data: { id: `solana_${TOKEN}` } }, dex: { data: { id: "raydium" } } },
            },
          ],
        }),
        { status: 200 },
      );
    }
    const tf = url.match(/ohlcv\/(minute|hour|day)\?aggregate=(\d+)/)!;
    const list = tf[1] === "day" ? candles(80, 86_400, nowS - (nowS % 86_400)) : tf[1] === "hour" ? candles(168, 3_600, nowS - (nowS % 3_600)) : candles(300, 300, nowS - (nowS % 300));
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } } }), { status: 200 });
  });
  return { impl, seen };
}

describe("GeckoTerminal candle reuse is labelled stale on exactly the fields it fed", () => {
  beforeEach(() => {
    setKV(new MemoryKV());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("first read is live; 5 minutes later the hourly / daily series are reused (stale 5m), the 5m series and pools refetched", async () => {
    const gt = gtStub();
    vi.stubGlobal("fetch", gt.impl);
    const first = await geckoterminal("solana", TOKEN);
    expect(first.data.staleFields ?? {}).toEqual({});
    expect(first.data.trendWindow).toBeTruthy();
    const firstCalls = gt.seen.length;

    vi.setSystemTime(T0 + 5 * 60_000);
    const second = await geckoterminal("solana", TOKEN);
    const urls = gt.seen.slice(firstCalls);
    expect(urls.some((u) => u.includes("/tokens/"))).toBe(true); // pools: 45s reuse window passed
    expect(urls.some((u) => u.includes("ohlcv/minute?aggregate=5"))).toBe(true); // m5: 120s window passed
    expect(urls.some((u) => u.includes("ohlcv/hour"))).toBe(false); // h1 reused (600s)
    expect(urls.some((u) => u.includes("ohlcv/day"))).toBe(false); // d1 reused (1800s)
    const sf = second.data.staleFields ?? {};
    expect(sf.trendWindow).toBe(5);
    // A null reading keeps its reason and is never labelled stale; a value from the reused series is.
    if (second.data.trendScore != null) expect(sf.trendScore).toBe(5);
    else expect(sf.trendScore).toBeUndefined();
    expect(sf.staircase).toBeUndefined(); // from the refetched 5m series: this run's reading
    expect(sf.upOnlyChart).toBeUndefined();
    if (second.data.priceChange7dPct != null) expect(sf.priceChange7dPct).toBe(5);
    expect(sf.patterns).toBe(5);
  });

  it("past each series' window everything is refetched and nothing is stale", async () => {
    const gt = gtStub();
    vi.stubGlobal("fetch", gt.impl);
    await geckoterminal("solana", TOKEN);
    vi.setSystemTime(T0 + (CANDLE_CACHE_S.d1 + 1) * 1000);
    const later = await geckoterminal("solana", TOKEN);
    expect(later.data.staleFields ?? {}).toEqual({});
  });
});
