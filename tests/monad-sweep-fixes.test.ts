import { describe, expect, it } from "vitest";
import { verdictOf, routeRank, type PoolSim } from "@/lib/sources/robinhoodSim";
import { dropDustOnlyMarkets } from "@/lib/sources/pools";
import type { AdapterResult } from "@/lib/types";

/** nad.fun sweep 2026-11-22: two Monad bugs found by scoring 94 memes on the old and new deployments. */

const sim = (o: Partial<PoolSim>): PoolSim => ({ pool: "0x" + "a".repeat(64), kind: "v4", hooks: null, feePct: 0.3, liquidityUsd: 9_000, result: "pass", lossPct: 1, detail: "d", ...o });

describe("round-trip loss is the best route's, not a junk v4 pool's (143 / BC / CATLABS)", () => {
  it("143: a 28%-fee v4 pool with unknown liquidity (48.3%) does not beat the $6,986 main v3 pool (1.99%)", () => {
    const v = verdictOf([
      sim({ pool: "0x" + "b".repeat(64), feePct: 28, liquidityUsd: null, lossPct: 48.3, detail: "48.30% round-trip loss (V4Quoter)" }),
      sim({ pool: "0x" + "c".repeat(40), kind: "v3", feePct: 1, liquidityUsd: 6_986, lossPct: 1.99, detail: "1.99% loss (computed from pool state)" }),
    ]);
    expect(v.sellable).toBe(true);
    expect(v.roundTripLossPct).toBe(1.99);
    expect(v.detail).toMatch(/^sellable via pool 0xcccccccc… \(v3, fee 1%\)/);
  });

  it("BC: a 20%-fee v4 pool loses to the nad.fun router's executed sell", () => {
    const v = verdictOf([
      sim({ feePct: 20, liquidityUsd: 5_000, lossPct: 46.8 }),
      sim({ pool: "0x" + "d".repeat(40), kind: "v2", feePct: null, liquidityUsd: null, lossPct: 2.0, executed: true }),
    ]);
    expect(v.roundTripLossPct).toBe(2.0);
  });

  it("a high-fee pool still counts when it is the only pool that passes (its loss is then the real cost)", () => {
    expect(verdictOf([sim({ feePct: 20, lossPct: 41 }), sim({ pool: "0x" + "e".repeat(40), kind: "v3", result: "revert", lossPct: null })]).roundTripLossPct).toBe(41);
  });

  it("among liquid markets the quoter-verified pool still ranks before pool-state math (unchanged rule)", () => {
    const v = verdictOf([sim({ pool: "0x" + "c".repeat(40), kind: "v3", lossPct: 0.02 }), sim({ lossPct: 0.6 })]);
    expect(v.roundTripLossPct).toBe(0.6);
  });

  it("route ranks: executed < quoted liquid < math liquid < unlisted/thin < junk fee", () => {
    expect(routeRank(sim({ executed: true, liquidityUsd: null }))).toBe(0);
    expect(routeRank(sim({}))).toBe(1);
    expect(routeRank(sim({ kind: "v3" }))).toBe(2);
    expect(routeRank(sim({ liquidityUsd: null }))).toBe(3);
    expect(routeRank(sim({ liquidityUsd: 120 }))).toBe(3);
    expect(routeRank(sim({ feePct: 10 }))).toBe(4);
  });
});

const res = (id: string, raw: unknown, data: Record<string, unknown>): AdapterResult => ({
  status: { id, label: id === "geckoterminal" ? "GeckoTerminal" : id === "dexscreener" ? "DexScreener" : "nad.fun", state: "ok", message: "m", ms: 1 },
  data: data as AdapterResult["data"],
  raw,
});

describe("an indexer that sees only dust pools does not speak for the token (MOE / GOCHI / PANAL)", () => {
  const moeGt = res(
    "geckoterminal",
    {
      pools: [
        { id: "0x6371876a1d077da3f32f958cced145026460a2f432eff48e325c790131da1143", name: "MOE / USDC 5%", liquidityUsd: 4.2542, volume24hUsd: 0.0731, createdAt: null },
        { id: "0xfb1fbd647aa70bc3bdfa5c5beeb23fd34bc5c322", name: "MOE / WMON 1%", liquidityUsd: 0.1601, volume24hUsd: 0.0013, createdAt: null },
        { id: "0xba80a708c1c00f55588429a1433969834fb37f0c82bd01326188543e101219dc", name: "MON / MOE 6%", liquidityUsd: 0, volume24hUsd: 0, createdAt: null },
      ],
    },
    { liquidityUsd: 4.4143, mainPoolLiquidityUsd: 4.2542, volume24hUsd: 0.0744, buyers24h: 1, priceUsd: 0.0001 },
  );
  const moeDs = res("dexscreener", { pairs: [{ pairAddress: "0x924D1c60aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", liquidity: { usd: 12_961.56 }, volume: { h24: 1_428 } }] }, { liquidityUsd: 12_961.56 });

  it("MOE: GeckoTerminal's $4.41 / 1 buyer / $0.07 are dropped with the reason; DexScreener and nad.fun stand", () => {
    const [gt, ds] = dropDustOnlyMarkets([moeGt, moeDs]);
    for (const k of ["liquidityUsd", "mainPoolLiquidityUsd", "volume24hUsd", "buyers24h", "priceUsd"]) expect(gt.data).not.toHaveProperty(k);
    expect(gt.data.nullReasons?.buyers24h).toMatch(/GeckoTerminal lists only 3 dust pools \(largest \$4\.25 liquidity\) — the main market is pool 0x924d1c60… \(\$12,962 liquidity on DexScreener\)/);
    expect(gt.status.state).toBe("partial");
    expect(ds).toBe(moeDs);
  });

  it("PANAL (nad.fun curve, no DexScreener pair): the $0.77 GeckoTerminal pool is dropped when the curve trades more", () => {
    const gt = res("geckoterminal", { pools: [{ id: "0x1a7808f8", name: "x", liquidityUsd: 0.7651, volume24hUsd: 0, createdAt: null }] }, { liquidityUsd: 0.7651, volume24hUsd: 0, buyers24h: 0 });
    const [out] = dropDustOnlyMarkets([gt], { label: "nad.fun", volume24hUsd: 197.56 });
    expect(out.data).not.toHaveProperty("volume24hUsd");
    expect(out.data.nullReasons?.liquidityUsd).toMatch(/still trades on the nad\.fun curve \(\$197\.56 24h volume there\)/);
  });

  it("a drained market is not hidden: every source sees the same pool, now dust", () => {
    const gt = res("geckoterminal", { pools: [{ id: "0xabc", name: "x", liquidityUsd: 3, volume24hUsd: 0, createdAt: null }] }, { liquidityUsd: 3 });
    const ds = res("dexscreener", { pairs: [{ pairAddress: "0xABC", liquidity: { usd: 3 }, volume: { h24: 0 } }] }, { liquidityUsd: 3 });
    const out = dropDustOnlyMarkets([gt, ds], { label: "nad.fun", volume24hUsd: null });
    expect(out[0]).toBe(gt);
    expect(out[1]).toBe(ds);
  });

  it("an indexer with one real pool (≥ $1000) keeps its figures, and an unknown liquidity never decides 'dust'", () => {
    const real = res("geckoterminal", { pools: [{ id: "0x1", name: "x", liquidityUsd: 2_000, volume24hUsd: 10, createdAt: null }, { id: "0x2", name: "y", liquidityUsd: 1, volume24hUsd: 0, createdAt: null }] }, { liquidityUsd: 2_001 });
    const unknown = res("geckoterminal", { pools: [{ id: "0x3", name: "x", liquidityUsd: null, volume24hUsd: 0, createdAt: null }] }, {});
    expect(dropDustOnlyMarkets([real, moeDs])[0]).toBe(real);
    expect(dropDustOnlyMarkets([unknown, moeDs])[0]).toBe(unknown);
  });
});

describe("a junk-fee pool's loss is not a honeypot verdict (PANAL)", () => {
  it("only a 95%-fee v4 pool fails ⇒ sellable / honeypot / loss null with the reason", () => {
    const v = verdictOf([sim({ feePct: 95, liquidityUsd: 0.77, result: "fail", lossPct: 99.75 })]);
    expect(v.sellable).toBeNull();
    expect(v.honeypot).toBeNull();
    expect(v.roundTripLossPct).toBeNull();
    expect(v.detail).toMatch(/^no verdict — the only pools that could be simulated charge an LP fee of 10% or more/);
  });

  it("a normal-fee pool that loses ≥ 50% is still a verdict, and a revert still means honeypot", () => {
    expect(verdictOf([sim({ feePct: 1, result: "fail", lossPct: 80 })]).honeypot).toBe(true);
    expect(verdictOf([sim({ feePct: 95, result: "revert", lossPct: null })]).honeypot).toBe(true);
  });
});
