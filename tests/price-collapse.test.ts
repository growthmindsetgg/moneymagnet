import { describe, expect, it, vi } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { deriveMetrics } from "@/lib/snapshot";
import { verifiedMetricDef, verifyMetric } from "@/lib/verify";
import { perfectLaunch, perfectSnapshot } from "./helpers";

/** Price-collapse cap (2026-11-20): a −60% day with sellers in control is capped at C (REPORT.md open item 1). */

const rule = (r: ReturnType<typeof scoreSnapshot>) => r.rules.find((x) => x.id === "price_collapse")!;

describe("price_collapse cap", () => {
  it("−74% in 24h with net selling caps a perfect token at C, with the move and the window on the evidence line", () => {
    const r = scoreSnapshot(deriveMetrics(perfectSnapshot("robinhood", { priceChange24hPct: -74, netFlowRatio24h: -0.3 })));
    expect(r.tier).toBe("C");
    expect(rule(r).state).toBe("fired");
    expect(rule(r).evidence).toMatch(/74%.*over 24h.*-30%|74%.*over 24h.*−30%/);
  });

  it("−59% is not a collapse; −60% is", () => {
    expect(rule(scoreSnapshot(perfectSnapshot("base", { priceChange24hPct: -59, netFlowRatio24h: -0.2 }))).state).not.toBe("fired");
    expect(scoreSnapshot(perfectSnapshot("base", { priceChange24hPct: -60, netFlowRatio24h: -0.2 })).tier).toBe("C");
  });

  it("a fall bought by net buyers is not capped (a dip, not a dump)", () => {
    const r = scoreSnapshot(perfectSnapshot("solana", { priceChange24hPct: -70, netFlowRatio24h: 0.15 }));
    expect(rule(r).state).not.toBe("fired");
    expect(r.tier).not.toBe("C");
  });

  it("net flow unknown does not pass a 60% fall", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { priceChange24hPct: -80, netFlowRatio24h: null }));
    expect(rule(r).state).toBe("fired");
    expect(["C", "D", "F", "U"]).toContain(r.tier);
  });

  it("price change unknown is not evaluable, not a pass and not a cap", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { priceChange24hPct: null, netFlowRatio24h: -0.3 }));
    expect(rule(r).state).toBe("unknown");
  });

  it("age never gates: a 3-hour launch token is capped by the same rule, and the window says since launch", () => {
    const s = deriveMetrics(perfectLaunch("solana", { ageHours: 3, priceChange24hPct: -65, netFlowRatio24h: -0.4 }));
    expect(s.priceChangeWindow).toMatch(/^since launch/);
    const r = scoreSnapshot(s);
    expect(rule(r).state).toBe("fired");
    expect(["C", "D", "F", "U"]).toContain(r.tier);
  });

  it("disagreeing sources resolve to the steepest fall", () => {
    const v = verifyMetric(verifiedMetricDef("priceChange24hPct")!, [
      { source: "dexscreener", label: "DexScreener", value: -40, fetchedAt: "", onchain: false },
      { source: "geckoterminal", label: "GeckoTerminal", value: -66, fetchedAt: "", onchain: false },
    ]);
    expect(v.chosen).toBe(-66);
  });
});

describe("price change from the market adapters", () => {
  it("DexScreener reads the main pair's priceChange.h24 when the token is its base", async () => {
    const addr = "0x" + "a".repeat(40);
    vi.resetModules();
    vi.doMock("@/lib/sources/http", async (orig) => ({
      ...(await orig<typeof import("@/lib/sources/http")>()),
      fetchJson: async () => ({
        pairs: [{ chainId: "base", pairAddress: "0x" + "b".repeat(40), url: "u", baseToken: { address: addr, name: "T", symbol: "T" }, quoteToken: { address: "0x" + "c".repeat(40), symbol: "WETH" }, priceUsd: "1", priceChange: { h24: -71.5 }, liquidity: { usd: 50_000 }, volume: { h24: 1000 } }],
      }),
    }));
    const { dexscreener } = await import("@/lib/sources/dexscreener");
    const r = await dexscreener("base", addr);
    expect(r.data.priceChange24hPct).toBe(-71.5);
    vi.doUnmock("@/lib/sources/http");
  });
});
