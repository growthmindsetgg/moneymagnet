import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryKV, setKV } from "@/lib/kv";
import { poolMetrics, pumpMarket } from "@/lib/sources/pools";
import { historyMetrics, liquidityChangeWhy, type LiqPoint } from "@/lib/history";
import { applyVerification, verifyMetric } from "@/lib/verify";
import { VERIFIED_METRICS } from "@/lib/verify/metrics";
import { emptySnapshot, mergeSnapshots } from "@/lib/snapshot";
import type { Provenance } from "@/lib/types";

const H = 3_600_000;
const DAY = 24 * H;
const TOKEN = "0x" + "c".repeat(40);
const def = (metric: string) => VERIFIED_METRICS.find((d) => d.metric === metric)!;
const reading = (source: string, value: Provenance["value"], stale = false): Provenance => ({
  source,
  label: source,
  value,
  fetchedAt: "2026-11-20T00:00:00.000Z",
  onchain: false,
  ...(stale ? { stale: true } : {}),
});

/** Mocks fetchJson (keeping num & co.) and imports an adapter fresh. */
async function withFetch<T>(mod: string, respond: (url: string) => unknown): Promise<T> {
  vi.resetModules();
  vi.doMock("@/lib/sources/http", async (orig) => ({
    ...(await orig<typeof import("@/lib/sources/http")>()),
    fetchJson: async (url: string) => respond(url),
  }));
  return (await import(mod)) as T;
}
afterEach(() => {
  vi.doUnmock("@/lib/sources/http");
  setKV(null);
});

// ---------------------------------------------------------------------------------------------
describe("C1: a pool listed without liquidity / volume / txns is unknown, never $0", () => {
  const known = { id: "0x" + "1".repeat(40), name: "A/WETH", liquidityUsd: 40_000, volume24hUsd: 9_000, createdAt: "2026-11-01T00:00:00Z" };
  const noLiq = { id: "0x" + "2".repeat(40), name: "A/USDC", liquidityUsd: null, volume24hUsd: 5_000, createdAt: "2026-11-02T00:00:00Z" };

  it("poolMetrics: totals that depend on an unknown pool are null, the reason names the partial sum", () => {
    const m = poolMetrics([known, noLiq]);
    expect(m.liquidityTotalUsd).toBeNull();
    expect(m.liquidityUsd).toBeNull(); // the unknown pool might be active / the deepest
    expect(m.poolCount).toBeNull();
    expect(m.volume24hUsd).toBe(14_000); // every volume is known
    expect(m.nullReasons?.liquidityTotalUsd).toMatch(/1 of 2 pools listed without a liquidity figure.*known pools sum to \$40,000, a partial sum/);
    expect(m.nullReasons?.liquidityUsd).toMatch(/cannot be told apart/);
  });

  it("poolMetrics: a pool a known figure rules out (dust volume) does not block the active-pool figures", () => {
    const m = poolMetrics([known, { ...noLiq, volume24hUsd: 3 }]);
    expect(m.liquidityUsd).toBe(40_000);
    expect(m.mainPoolLiquidityUsd).toBe(40_000);
    expect(m.poolCount).toBe(1);
    expect(m.liquidityTotalUsd).toBeNull(); // still not a total
  });

  it("poolMetrics: all figures known ⇒ unchanged sums, no reasons", () => {
    const m = poolMetrics([known, { ...noLiq, liquidityUsd: 2_000 }]);
    expect(m.liquidityTotalUsd).toBe(42_000);
    expect(m.nullReasons).toBeUndefined();
  });

  it("pumpMarket: an AMM pool without liquidity leaves the main market unknown, not graduated-at-$0", () => {
    const curve = { id: "curve", name: "X/SOL", liquidityUsd: null, volume24hUsd: 50_000, createdAt: "2026-11-20T00:00:00Z", dexId: "pumpfun" };
    const m = pumpMarket([curve, { id: "amm", name: "X/SOL", liquidityUsd: null, volume24hUsd: 100, createdAt: null, dexId: "pumpswap" }])!;
    expect(m.metrics.liquidityUsd).toBeUndefined();
    expect(m.metrics.volume24hUsd).toBeUndefined();
    expect(m.nullReasons.liquidityUsd).toMatch(/without a liquidity figure — the main market .* is unknown/);
    // A curve pair with no liquidity object (DexScreener's pump.fun pairs) is fine: curve liquidity is never used.
    expect(pumpMarket([curve])!.metrics.volume24hUsd).toBe(50_000);
  });

  it("DexScreener: a pair without liquidity / txns gives null (with the reason), and no 'last trade ≥ 24h' bound", async () => {
    const base = { address: TOKEN, name: "T", symbol: "T" };
    const q = { address: "0x" + "4".repeat(40), symbol: "WETH" };
    const { dexscreener } = await withFetch<typeof import("@/lib/sources/dexscreener")>("@/lib/sources/dexscreener", () => ({
      pairs: [
        { chainId: "base", dexId: "uniswap", pairAddress: "0x" + "1".repeat(40), url: "u1", baseToken: base, quoteToken: q, liquidity: { usd: 40_000 }, volume: { h24: 9_000 }, txns: { h24: { buys: 0, sells: 0 } } },
        { chainId: "base", dexId: "uniswap", pairAddress: "0x" + "2".repeat(40), url: "u2", baseToken: base, quoteToken: q, volume: { h24: 5_000 } },
      ],
    }));
    const r = await dexscreener("base", TOKEN);
    expect(r.data.liquidityTotalUsd).toBeNull();
    expect(r.data.liquidityUsd).toBeNull();
    expect(r.data.nullReasons?.liquidityTotalUsd).toMatch(/partial sum/);
    expect(r.data.sells24h).toBeNull();
    expect(r.data.buyTxs24h).toBeNull();
    expect(r.data.lastTradeHoursAgo).toBeNull(); // the pair without counts may have traded
    expect(r.data.nullReasons?.lastTradeHoursAgo).toMatch(/1 of 2 pairs are listed without 24h trade counts/);
  });

  it("DexScreener: every pair reporting 0 trades still gives the ≥ 24h lower bound", async () => {
    const base = { address: TOKEN, name: "T", symbol: "T" };
    const { dexscreener } = await withFetch<typeof import("@/lib/sources/dexscreener")>("@/lib/sources/dexscreener", () => ({
      pairs: [{ chainId: "base", pairAddress: "0x" + "1".repeat(40), url: "u1", baseToken: base, quoteToken: { address: "0x" + "4".repeat(40), symbol: "WETH" }, liquidity: { usd: 500 }, volume: { h24: 0 }, txns: { h24: { buys: 0, sells: 0 } } }],
    }));
    const r = await dexscreener("base", TOKEN);
    expect(r.data.lastTradeHoursAgo).toBe(24);
    expect(r.data.liquidityTotalUsd).toBe(500);
  });

  it("C1 scenario end-to-end: DexScreener without liquidity no longer beats GeckoTerminal's $40k under 'min'", () => {
    const dex = poolMetrics([{ ...noLiq, volume24hUsd: 9_000 }]);
    const gecko = { liquidityUsd: 40_000, liquidityTotalUsd: 40_000, mainPoolLiquidityUsd: 40_000 };
    const slices = [
      { id: "dexscreener", label: "DexScreener", data: dex },
      { id: "geckoterminal", label: "GeckoTerminal", data: gecko },
    ];
    const { snapshot } = applyVerification(mergeSnapshots(emptySnapshot("base", TOKEN), slices.map((s) => s.data)), slices);
    expect(snapshot.liquidityUsd).toBe(40_000);
    expect(snapshot.liquidityTotalUsd).toBe(40_000);
  });
});

// ---------------------------------------------------------------------------------------------
describe("M5: GeckoTerminal main-pool trade counts stand for the token only when it carries ≥ 90% of volume", () => {
  const pool = (addr: string, reserve: string | null, vol: string | null, tx: { buys: number; sells: number; buyers: number; sellers: number }) => ({
    id: `base_${addr}`,
    attributes: { name: "T / WETH", address: addr, reserve_in_usd: reserve, pool_created_at: null, fdv_usd: "100000", base_token_price_usd: "0.0001", volume_usd: { h24: vol }, transactions: { h24: tx } },
    relationships: { base_token: { data: { id: `base_${TOKEN}` } } },
  });
  const run = async (pools: unknown[]) => {
    const { geckoterminal } = await withFetch<typeof import("@/lib/sources/geckoterminal")>("@/lib/sources/geckoterminal", (url) => (url.includes("/ohlcv/") ? { data: { attributes: { ohlcv_list: [] } } } : { data: pools }));
    return geckoterminal("base", TOKEN);
  };

  it("main pool with 50% of volume: sells24h and tradesPerWallet are null with the scope reason", async () => {
    const r = await run([pool("0x" + "1".repeat(40), "50000", "5000", { buys: 40, sells: 30, buyers: 20, sellers: 10 }), pool("0x" + "2".repeat(40), "20000", "5000", { buys: 5, sells: 5, buyers: 3, sellers: 3 })]);
    expect(r.data.buyers24h).toBeNull();
    expect(r.data.sells24h).toBeNull();
    expect(r.data.tradesPerWallet).toBeNull();
    expect(r.data.nullReasons?.sells24h).toMatch(/main pool has only 50% of 24h volume/);
    expect(r.data.nullReasons?.tradesPerWallet).toMatch(/main pool has only 50%/);
  });

  it("a pool without a volume figure makes the share unknown: the counts are not the token's", async () => {
    const r = await run([pool("0x" + "1".repeat(40), "50000", "5000", { buys: 40, sells: 30, buyers: 20, sellers: 10 }), pool("0x" + "2".repeat(40), "20000", null, { buys: 5, sells: 5, buyers: 3, sellers: 3 })]);
    expect(r.data.sells24h).toBeNull();
    expect(r.data.volume24hUsd).toBeNull();
    expect(r.data.nullReasons?.volume24hUsd).toMatch(/partial sum/);
    expect(r.data.nullReasons?.sells24h).toMatch(/share of the token's trading is unknown/);
  });

  it("main pool with all the volume: counts kept", async () => {
    const r = await run([pool("0x" + "1".repeat(40), "50000", "5000", { buys: 40, sells: 30, buyers: 20, sellers: 10 })]);
    expect(r.data.sells24h).toBe(30);
    expect(r.data.tradesPerWallet).toBeCloseTo(70 / 30);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Monad volume is USD: nad.fun metrics volume is not multiplied by the MON price", () => {
  // CHOG (0x3500…7777), live 2026-11-20: metrics 1D volume total 3,650.86 (DexScreener $3,649 on the same pool),
  // market.native_price 0.01334 (MON/USD). The old code multiplied: 48.6.
  const CHOG = "0x350035555e10d9afaf1566aaebfced5ba6c27777";
  const respond = (creatorSwaps: unknown) => (url: string) => {
    if (url.includes("/token/")) return { token_info: { name: "Chog", symbol: "CHOG", is_graduated: true, twitter: null, telegram: null, website: null, created_at: 1_760_000_000, creator: { account_id: "0xE58982D5B56C07CDB18A04FC4429E658E6002D85" }, version: "V1" } };
    if (url.includes("/market/")) return { market_info: { market_type: "DEX", price_usd: "0.0007180046", native_price: "0.013342181493801912", total_supply: "999999989000000000000000000", holder_count: 34075 } };
    if (url.includes("/metrics/")) return { metrics: [{ timeframe: "1D", transactions: { buy: 62, sell: 77 }, volume: { buy: "2008.703984292851630014566236866218379183", sell: "1642.158810968821778704727934731225860093" }, makers: { buy: 47, sell: 50, total: 97 } }] };
    if (url.includes("/swap-history/")) return creatorSwaps;
    throw new Error("unexpected " + url);
  };

  it("CHOG: volume24hUsd ≈ $3,651 and net flow in USD", async () => {
    const { nadfun } = await withFetch<typeof import("@/lib/sources/nadfun")>("@/lib/sources/nadfun", respond({ swaps: [], total_count: 0 }));
    const r = await nadfun(CHOG);
    expect(r.data.volume24hUsd).toBeCloseTo(3650.86, 1);
    expect(r.data.netFlowUsd24h).toBeCloseTo(366.55, 1);
  });

  // M7: the creator never bought on nad.fun but sold — "0% of what they bought" was full points.
  it("M7: creator sold without buying ⇒ deployerSoldPct null with the reason, deployerHasSold true", async () => {
    const sell = { swap_info: { event_type: "SELL", token_amount: "1000000000000000000000", created_at: 1 } };
    const { nadfun } = await withFetch<typeof import("@/lib/sources/nadfun")>("@/lib/sources/nadfun", respond({ swaps: [sell], total_count: 1 }));
    const r = await nadfun(CHOG);
    expect(r.data.deployerSoldPct).toBeUndefined();
    expect(r.data.deployerHasSold).toBe(true);
    expect(r.data.nullReasons?.deployerSoldPct).toMatch(/sold on nad\.fun but never bought there/);
  });

  it("M7: creator who bought and sold half ⇒ 50%", async () => {
    const sw = (t: string, amt: string) => ({ swap_info: { event_type: t, token_amount: amt, created_at: 1 } });
    const { nadfun } = await withFetch<typeof import("@/lib/sources/nadfun")>("@/lib/sources/nadfun", respond({ swaps: [sw("BUY", "100"), sw("SELL", "50")], total_count: 2 }));
    expect((await nadfun(CHOG)).data.deployerSoldPct).toBe(50);
  });
});

// ---------------------------------------------------------------------------------------------
describe("verify: unknown readings never compete; live beats stale (M2)", () => {
  it("'min' ignores a null reading and a non-finite one", () => {
    const v = verifyMetric(def("volume24hUsd"), [reading("dexscreener", null), reading("nan", Number.NaN), reading("geckoterminal", 40_000)]);
    expect(v.chosen).toBe(40_000);
  });

  it("a 5h-old stale reading cannot beat a live one, even when it is the more conservative", () => {
    const v = verifyMetric(def("liquidityUsd"), [reading("geckoterminal", 2_000, true), reading("dexscreener", 40_000)]);
    expect(v.status).toBe("disputed");
    expect(v.chosen).toBe(40_000);
    expect(v.chosenSource).toBe("dexscreener");
    expect(v.resolution).toMatch(/live readings preferred over stale ones/);
  });

  it("stale readings are used when no live one exists", () => {
    const v = verifyMetric(def("liquidityUsd"), [reading("geckoterminal", 2_000, true), reading("dexscreener", 40_000, true)]);
    expect(v.chosen).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------------------------
describe("liquidity history windows", () => {
  const t0 = Date.UTC(2026, 10, 1);

  // TOSHI-shaped history: one observation 8 days ago, then today's. Both changes used to be read against the
  // 8-day-old point and printed the same value (24h == 7d on 18 of 25 live tokens).
  it("a gap: the 24h change is not read against an 8-day-old point, and differs from the 7d change", () => {
    const pts: LiqPoint[] = [
      { t: t0, liq: 50_000_000 },
      { t: t0 + 8 * DAY - 20 * H, liq: 1_100_000 },
      { t: t0 + 8 * DAY, liq: 1_000_000 },
    ];
    const h = historyMetrics(pts);
    expect(h.liqChange24hPct).toBeCloseTo(-9.09, 1);
    expect(h.liqChange24hWindow).toBe("20h of history");
    expect(h.liqChange7dPct).toBeCloseTo(-98);
    expect(h.liqChange7dWindow).toBe("7d");
    expect(h.liqChange24hPct).not.toBeCloseTo(h.liqChange7dPct!);
  });

  it("a gap with nothing usable inside the window ⇒ null naming the gap", () => {
    const pts: LiqPoint[] = [
      { t: t0, liq: 100 },
      { t: t0 + 3 * DAY, liq: 90 },
    ];
    const d = liquidityChangeWhy(pts, DAY, "24h");
    expect(d.change).toBeNull();
    expect(d.reason).toMatch(/no liquidity observation between 24h and 36h ago — the nearest older one is 72h old/);
  });

  it("7d needs a real 7-day-old observation: 21h of history ⇒ null 'history covers only 21h' (NIKO)", () => {
    const pts: LiqPoint[] = [
      { t: t0, liq: 30_000 },
      { t: t0 + 21 * H, liq: 24_000 },
    ];
    const h = historyMetrics(pts, 41);
    expect(h.liqChange24hPct).toBeCloseTo(-20);
    expect(h.liqChange24hWindow).toBe("21h of history");
    expect(h.liqChange7dPct).toBeNull();
    expect(h.liqChange7dWindow).toBeNull();
    expect(h.nullReasons.liqChange7dPct).toMatch(/history covers only 21h — a 7d change needs a full 7d of liquidity history/);
  });

  it("four days of history is not a 7d change either (the old '96h of history' 7d reading)", () => {
    const h = historyMetrics([
      { t: t0, liq: 100 },
      { t: t0 + 96 * H, liq: 50 },
    ]);
    expect(h.liqChange7dPct).toBeNull();
    expect(h.nullReasons.liqChange7dPct).toMatch(/history covers only 96h/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("H11: only a live, complete liquidity total is recorded into the history", () => {
  it("a stale fill is not recorded and leaves both changes null with the reason", async () => {
    setKV(new MemoryKV());
    const { liquidityHistoryStep } = await import("@/lib/analyze");
    const { historyKey } = await import("@/lib/history");
    const { kvGet } = await import("@/lib/kv");
    const s = { ...emptySnapshot("base", TOKEN), liquidityTotalUsd: 1_000_000, staleFields: { liquidityTotalUsd: 183 } };
    await liquidityHistoryStep("base", TOKEN, s, Date.UTC(2026, 10, 20));
    expect(await kvGet(historyKey("base", TOKEN))).toBeNull();
    expect(s.liqChange24hPct).toBeNull();
    expect(s.nullReasons.liqChange7dPct).toMatch(/stale \(last good snapshot, 183m old\) — not recorded/);
  });

  it("an unknown total (a pool without a figure) is not recorded; the reason carries the partial sum", async () => {
    setKV(new MemoryKV());
    const { liquidityHistoryStep } = await import("@/lib/analyze");
    const m = poolMetrics([
      { id: "a", name: "a", liquidityUsd: 40_000, volume24hUsd: 9_000, createdAt: null },
      { id: "b", name: "b", liquidityUsd: null, volume24hUsd: 9_000, createdAt: null },
    ]);
    const s = { ...emptySnapshot("base", TOKEN), ...m, nullReasons: m.nullReasons ?? {} };
    await liquidityHistoryStep("base", TOKEN, s);
    expect(s.nullReasons.liqChange24hPct).toMatch(/total pool liquidity unknown .*partial sum/);
  });

  it("a live total is recorded", async () => {
    setKV(new MemoryKV());
    const { liquidityHistoryStep } = await import("@/lib/analyze");
    const s = { ...emptySnapshot("base", TOKEN), liquidityTotalUsd: 1_000 };
    await liquidityHistoryStep("base", TOKEN, s);
    expect(s.liqHistoryPoints).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("M13: vesting diamond with unknown Holder Strength", () => {
  it("is null with the reason, not a measured false", async () => {
    const { vestingDiamondOf } = await import("@/lib/analyze");
    expect(vestingDiamondOf("vesting", null, "too few holder histories")).toEqual({ value: null, reason: expect.stringMatching(/Holder Strength is unknown \(too few holder histories\)/) });
    expect(vestingDiamondOf("vesting", 85).value).toBe(true);
    expect(vestingDiamondOf("vesting", 60).value).toBe(false);
    expect(vestingDiamondOf("wallet", null).value).toBe(false); // not a vesting wallet: measured
    expect(vestingDiamondOf(null, 90).value).toBeNull();
  });
});
