import { describe, expect, it, vi } from "vitest";
import { pumpMarket } from "@/lib/sources/pools";

/**
 * SHEEP (6ppvYhoj…pump, 2026-11-20, ~1.5h old, still on the curve): pump.fun curve $56.8k 24h volume, plus a
 * Meteora DAMM v2 pool someone opened with $0.65 liquidity / $0.24 volume. Treating the dust pool as
 * "graduated" read volume 0.23 and liquidity 0.64, fired the VOL/MC bundle penalty (raw 63.5 → F 23.5) and
 * took the price move (−81%) from the dust pool instead of the curve (−3%).
 */
const SHEEP = [
  { id: "9puqJLbi", name: "SHEEP/SOL", liquidityUsd: 1825.4, volume24hUsd: 56_923, createdAt: "2026-11-20T12:00:00Z", dexId: "pump-fun" },
  { id: "86M5yWbt", name: "SHEEP/SOL", liquidityUsd: 0.6474, volume24hUsd: 0.2397, createdAt: "2026-11-20T12:40:00Z", dexId: "meteora-damm-v2" },
];

describe("a dust AMM pool next to a live curve is not graduation", () => {
  it("SHEEP: the curve stays the main market, its volume is used, and the dust pool is named as ignored", () => {
    const m = pumpMarket(SHEEP)!;
    expect(m.metrics.volume24hUsd).toBe(56_923);
    expect(m.metrics.liquidityUsd).toBeUndefined();
    expect(m.nullReasons.liquidityUsd).toMatch(/pre-graduation/);
    expect(m.note).toMatch(/1 dust pool under \$1000 ignored/);
  });

  it("a drained AMM pool next to a dead curve still reads as graduated (a pulled pool is not hidden)", () => {
    const m = pumpMarket([{ ...SHEEP[0], volume24hUsd: 0 }, { ...SHEEP[1], dexId: "pumpswap", volume24hUsd: 3 }])!;
    expect(m.note).toMatch(/graduated/);
    expect(m.metrics.liquidityUsd).toBeCloseTo(0.6474);
  });

  it("a real graduated pool (≥ $1000) is the main market even while the 24h curve volume is larger", () => {
    const m = pumpMarket([SHEEP[0], { ...SHEEP[1], dexId: "pumpswap", liquidityUsd: 15_000, volume24hUsd: 9_000 }])!;
    expect(m.note).toMatch(/graduated/);
    expect(m.metrics.liquidityUsd).toBe(15_000);
  });
});

describe("price change comes from the most-traded pair", () => {
  it("DexScreener: SHEEP's curve (−3.47%) is used, not the dust pool's −81%", async () => {
    const mint = "6ppvYhojMwM1CXpqajafV2UarkEo5zgXGszuM8Ycpump";
    vi.resetModules();
    vi.doMock("@/lib/sources/http", async (orig) => ({
      ...(await orig<typeof import("@/lib/sources/http")>()),
      fetchJson: async () => ({
        pairs: [
          { chainId: "solana", dexId: "pumpfun", pairAddress: "9puqJLbiSoMkpTuUb43C3QmyRrH3ToD6NFy1fxma2z28", url: "u1", baseToken: { address: mint, name: "SHEEP", symbol: "SHEEP" }, quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" }, priceUsd: "0.0001", priceChange: { h24: -3.47 }, volume: { h24: 56_848 } },
          { chainId: "solana", dexId: "meteora", pairAddress: "86M5yWbtbMDx7vm5k3EgSNR7iygXPS9VueofZ1tPmY2y", url: "u2", baseToken: { address: mint, name: "SHEEP", symbol: "SHEEP" }, quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" }, priceUsd: "0.00002", priceChange: { h24: -81.03 }, liquidity: { usd: 0.6 }, volume: { h24: 0.43 } },
        ],
      }),
    }));
    const { dexscreener } = await import("@/lib/sources/dexscreener");
    const r = await dexscreener("solana", mint);
    expect(r.data.priceChange24hPct).toBe(-3.47);
    expect(r.data.volume24hUsd).toBe(56_848);
    vi.doUnmock("@/lib/sources/http");
  });
});

describe("snapshots from before the pool fix are not served as stale", () => {
  it("GeckoTerminal / DexScreener last-good keys carry the derivation version; other sources keep theirs", async () => {
    const { lastGoodKey } = await import("@/lib/stale");
    // Updated twice: audit fixes (v3 indexers, v2 RugCheck), then v4 indexers for the dust-only listing fix (2026-11-22): neither the pre-pool-fix
    // keys nor the v2 keys written before the zero-default fix are read; a source never bumped keeps its plain key.
    for (const [src, v] of [["geckoterminal", 4], ["dexscreener", 4], ["rugcheck", 2]] as const) {
      const key = lastGoodKey(src, "solana", "Abc");
      expect(key).toBe(`lastgood:${src}@v${v}:solana:abc`);
      expect(key).not.toBe(`lastgood:${src}:solana:abc`);
      expect(key).not.toBe(`lastgood:${src}@v2:solana:abc`.replace(`@v2`, v === 2 ? "@v1" : "@v2"));
    }
    expect(lastGoodKey("solana-rpc", "solana", "Abc")).toBe("lastgood:solana-rpc:solana:abc");
  });
});
