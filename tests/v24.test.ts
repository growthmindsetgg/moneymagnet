import { describe, expect, it } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { deriveMetrics } from "@/lib/snapshot";
import type { TokenSnapshot } from "@/lib/types";
import { perfectLaunch, perfectSnapshot } from "./helpers";

const fired = (s: TokenSnapshot) => scoreSnapshot(s).rules.filter((r) => r.state === "fired").map((r) => r.id);

/** Basics all pass; every other signal is the weakest reading the scale has (no conviction, no flow, thin liquidity). */
const basicsOnly = (s: TokenSnapshot): TokenSnapshot => ({
  ...s,
  top10SharePct: 60,
  top1SharePct: 25,
  accumulatorCount: 0,
  accumulatorSupplyPct: 0,
  earlyRetentionPct: 10,
  bundlersFlushed: false,
  deployerHoldingPct: 10,
  netFlowRatio24h: -0.3,
  netFlowRatio7d: -0.3,
  flowConsistent: false,
  buyerSellerRatio: 0.5,
  singleTradeWalletSharePct: 90,
  tradesPerWallet: 1,
  smartMoneyNetUsd: -5_000,
  liqFdvPct: 1,
  mainPoolSharePct: 30,
  liqChange24hPct: -30,
  liqChange7dPct: -60,
  poolCount: 1,
  trendScore: -1,
  roundTripLossPct: 30,
  // launch-mode signals
  devBuySharePct: 30,
  snipeRatioPct: 40,
  bundleScore: 70,
  organicScore: 10,
  timingEntropy: 0.1,
  launchRetraced30: false,
  identicalCandleSharePct: 80,
  staircase: true,
  hugeCandlesOnly: true,
  curveProgressPct: 5,
  first5mSharePct: 60,
  freshWalletsTop20: 15,
  fundingClusterMax: 10,
  insiderSupplyPct: 40,
  creatorRugRatePct: 80,
  creatorHasSocials: false,
  sells24h: 2,
  uniqueBuyers: 60,
  volMcVsBar: 0.2,
});

describe("v2.4 basics are gates, not points", () => {
  for (const chain of ["robinhood", "solana"] as const) {
    for (const [mode, make] of [["established", perfectSnapshot], ["launch", perfectLaunch]] as const) {
      it(`${chain} ${mode}: passing every basic adds nothing — a weak token stays F/D`, () => {
        const r = scoreSnapshot(basicsOnly(make(chain)));
        expect(r.groups.find((g) => g.id === "safety")!.factors.every((f) => f.points === 0 && f.max === 0)).toBe(true);
        expect(r.rawScore).toBeLessThanOrEqual(35);
        expect(["F", "D"]).toContain(r.tier);
      });
    }
  }

  it("owner not renounced caps at A, upgradeable proxy caps at B (Robinhood)", () => {
    expect(scoreSnapshot(perfectSnapshot("robinhood", { ownerRenounced: false })).tier).toBe("A");
    expect(scoreSnapshot(perfectSnapshot("robinhood", { upgradeable: true })).tier).toBe("B");
    expect(scoreSnapshot(perfectSnapshot("robinhood")).tier).toBe("S");
  });

  it("a failed basic is still a forcing gate (mint authority ⇒ F)", () => {
    expect(scoreSnapshot(perfectSnapshot("solana", { mintAuthority: true })).tier).toBe("F");
  });
});

describe("v2.4 size floor", () => {
  it("FDV < $10k on a token ≥ 1h ⇒ cap D, with the reason", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { fdvUsd: 8_000, liquidityUsd: 3_000, ageHours: 5 }));
    expect(r.tier).toBe("D");
    expect(r.rules.find((x) => x.id === "micro_cap")!.evidence).toMatch(/^micro-cap \/ illiquid — \$8K FDV, \$3K liquidity/);
  });
  it("liquidity < $2k on a token ≥ 1h ⇒ cap D", () => {
    expect(fired(perfectSnapshot("solana", { liquidityUsd: 1_500, ageHours: 2 }))).toContain("micro_cap");
  });
  it("does not apply under 1h", () => {
    expect(fired(perfectLaunch("solana", { fdvUsd: 8_000, ageHours: 0.5 }))).not.toContain("micro_cap");
  });
  it("FDV < $2k ⇒ cap F (dust), at any age", () => {
    const r = scoreSnapshot(perfectLaunch("solana", { fdvUsd: 1_500, ageHours: 0.5 }));
    expect(r.tier).toBe("F");
    expect(r.rules.find((x) => x.id === "dust")!.evidence).toMatch(/^dust — \$1\.5K FDV/);
  });
});

describe("v2.4 wash ⇒ cap D", () => {
  it("the wash flag caps at D, not just −20", () => {
    expect(scoreSnapshot(perfectSnapshot("robinhood", { washFlag: true })).tier).toBe("D");
  });
  it("VOL/MC > 20× on a token ≥ 1h is wash by definition", () => {
    const s = deriveMetrics(perfectSnapshot("solana", { volMcRatio: null, volume24hUsd: 25_000_000, fdvUsd: 1_000_000, washFlag: null, ageHours: 3 }));
    expect(s.washFlag).toBe(true);
    expect(s.fakeSignals.some((x) => /× market cap .*> 20× ⇒ wash/.test(x.text))).toBe(true);
    const young = deriveMetrics(perfectSnapshot("solana", { volMcRatio: null, volume24hUsd: 25_000_000, fdvUsd: 1_000_000, washFlag: null, ageHours: 0.5, volLiqRatio: 1 }));
    expect(young.fakeSignals.some((x) => /> 20× ⇒ wash/.test(x.text))).toBe(false);
  });
});

describe("v2.4 feed scores need ≥ 50 unique buyers", () => {
  it("below 50: organic / bundle score are live, 0 points, 'insufficient sample'", () => {
    const r = scoreSnapshot(perfectLaunch("solana", { uniqueBuyers: 30 }));
    for (const id of ["organic_score", "bundle_score"]) {
      const f = r.groups.flatMap((g) => g.factors).find((x) => x.id === id)!;
      expect(f.status).toBe("live");
      expect(f.points).toBe(0);
      expect(f.evidence).toMatch(/^insufficient sample — 30 unique buyers \(needs ≥ 50\)/);
    }
  });
  it("at 50+: scored normally", () => {
    const r = scoreSnapshot(perfectLaunch("solana", { uniqueBuyers: 50 }));
    expect(r.groups.flatMap((g) => g.factors).find((x) => x.id === "organic_score")!.points).toBeGreaterThan(0);
  });
});
