import { describe, expect, it } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { identicalCandles, launchRetrace, staircase, trend, upOnly, type Candle } from "@/lib/patterns";
import type { ScoreReport, TokenSnapshot } from "@/lib/types";
import { perfectLaunch, perfectSnapshot } from "./helpers";

const rule = (r: ScoreReport, id: string) => r.rules.find((x) => x.id === id)!;
const RANK = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5, U: 6 } as const;
const atMost = (r: ScoreReport, tier: keyof typeof RANK) => expect(RANK[r.tier]).toBeGreaterThanOrEqual(RANK[tier]);

/** Launch-mode token (<72h) with one guide violation applied. */
const launch = (o: Partial<TokenSnapshot>) => scoreSnapshot(perfectLaunch("solana", o));

describe("memecoin-guide hard rules — one synthetic fixture each", () => {
  it("1. LP unlocked on a non-launchpad token ⇒ F (p.16-18)", () => {
    const r = launch({ isLaunchpad: false, launchpad: null, lpLockedPct: 10 });
    expect(rule(r, "lp_unlocked").state).toBe("fired");
    expect(r.tier).toBe("F");
  });

  it("1b. launchpad tokens pass the LP rule by construction", () => {
    const r = launch({ isLaunchpad: true, launchpad: "pump.fun", lpLockedPct: null });
    expect(rule(r, "lp_unlocked").state).not.toBe("fired");
    expect(r.groups.flatMap((g) => g.factors).find((f) => f.id === "lp_lock")!.evidence).toMatch(/by construction/);
  });

  it("2. mint authority enabled ⇒ F (p.17-19)", () => {
    const r = launch({ mintAuthority: true });
    expect(rule(r, "mint_enabled").state).toBe("fired");
    expect(r.tier).toBe("F");
  });

  it("3. freeze authority enabled ⇒ F (p.19, 99)", () => {
    const r = launch({ freezeAuthority: true });
    expect(rule(r, "freeze_enabled").state).toBe("fired");
    expect(r.tier).toBe("F");
  });

  it("4a. top holder > 3.5% ⇒ −10 bundle warning (p.22)", () => {
    const r = launch({ top1SharePct: 6 });
    expect(rule(r, "top_holder_bundle")).toMatchObject({ state: "fired", points: 10, flag: "bundle warning" });
  });

  it("4b. top holder > 20% ⇒ cap C", () => {
    const r = launch({ top1SharePct: 25 });
    expect(rule(r, "top_holder_20").state).toBe("fired");
    atMost(r, "C");
  });

  it("4c. top holder ≥ 35% ⇒ cap D", () => {
    const r = launch({ top1SharePct: 40 });
    expect(rule(r, "top_holder_35").state).toBe("fired");
    atMost(r, "D");
  });

  it("5. VOL/MC < 0.8 on a < 72h token ⇒ −20 and cap C (p.25)", () => {
    const r = launch({ volMcRatio: 0.6, volMcVsBar: 0.5 });
    expect(rule(r, "vol_mc_bundle")).toMatchObject({ state: "fired", points: 20, capTier: "C" });
    atMost(r, "C");
  });

  it("5b. the VOL/MC rule is absent from Established mode (v2.1: launch-only)", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { volMcRatio: 0.2, volMcVsBar: 0.25 }));
    expect(r.rules.find((x) => x.id === "vol_mc_bundle")).toBeUndefined();
    expect(r.penalties).toEqual([]);
  });

  it("6. fees < 0.5 SOL per 15k mcap ⇒ −10 bundle flag (p.25)", () => {
    const r = launch({ feesSol: 0.2, feesPerMcap15k: 0.2 });
    expect(rule(r, "fees_low")).toMatchObject({ state: "fired", points: 10 });
  });

  it("6b. fees unknown ⇒ rule not evaluable (no estimate)", () => {
    const r = launch({ feesSol: null, feesPerMcap15k: null });
    expect(rule(r, "fees_low").state).toBe("unknown");
  });

  it("7. > 3 same-source funded wallets ⇒ RED FLAG −15 and cap C (p.25)", () => {
    const r = launch({ fundingClusterMax: 5 });
    expect(rule(r, "funding_cluster")).toMatchObject({ state: "fired", points: 15, capTier: "C", flag: "RED FLAG" });
    atMost(r, "C");
  });

  it("8a. multiple fresh wallets among top holders ⇒ RED FLAG −10 (p.23)", () => {
    const r = launch({ freshWalletsTop20: 4 });
    expect(rule(r, "fresh_wallets")).toMatchObject({ state: "fired", points: 10 });
  });

  it("8b. majority of holders are bundlers ⇒ cap C (p.23)", () => {
    const r = launch({ bundlerMajority: true });
    expect(rule(r, "bundler_majority").state).toBe("fired");
    atMost(r, "C");
  });

  it("9. honeypot triad ⇒ cap D and 'honeypot pattern' (p.19)", () => {
    const r = launch({ honeypotPattern: true });
    expect(rule(r, "honeypot_pattern")).toMatchObject({ state: "fired", capTier: "D", flag: "honeypot pattern" });
    atMost(r, "D");
  });

  it("10a. dev buy ≥ 20% of buys ⇒ −15 (p.24)", () => {
    const r = launch({ devBuySharePct: 25 });
    expect(rule(r, "dev_buy_big")).toMatchObject({ state: "fired", points: 15 });
  });

  it("10b. dev sold ≥ 50% ⇒ −10 and cap C (p.24, spec A.6)", () => {
    const r = launch({ deployerSoldPct: 80 });
    expect(rule(r, "dev_sold")).toMatchObject({ state: "fired", points: 10, capTier: "C" });
    atMost(r, "C");
  });

  it("11a. insider networks ≥ 18% ⇒ −10 (p.18)", () => {
    const r = launch({ insiderSupplyPct: 20 });
    expect(rule(r, "insider_18")).toMatchObject({ state: "fired", points: 10 });
    expect(rule(r, "insider_40").state).toBe("clear");
  });

  it("11b. insider networks ≥ 40% ⇒ cap C", () => {
    const r = launch({ insiderSupplyPct: 45 });
    expect(rule(r, "insider_40").state).toBe("fired");
    atMost(r, "C");
  });

  it("12. one linked cluster holding 50-80% ⇒ full bundle, cap D (p.21-22, 28-29)", () => {
    const r = launch({ clusterSupplyPct: 62 });
    expect(rule(r, "full_bundle")).toMatchObject({ state: "fired", capTier: "D", flag: "full bundle" });
    expect(rule(r, "full_bundle").evidence).toMatch(/HoodTier cluster \(funding-graph\)/);
    atMost(r, "D");
  });

  it("13. makers > 3× holders on a < 24h token ⇒ −10 (p.27)", () => {
    const r = launch({ ageHours: 10, makersCount: 400, holderCount: 100, makersHoldersRatio: 4 });
    expect(rule(r, "bot_inflated")).toMatchObject({ state: "fired", points: 10 });
  });

  it("14. straight-up launch that never retraced 30% ⇒ −10 supply controlled (p.27)", () => {
    const r = launch({ ageHours: 10, launchRetraced30: false });
    expect(rule(r, "supply_controlled")).toMatchObject({ state: "fired", points: 10 });
  });

  it("chart: identical candles ≥ 60% ⇒ botted chart −15 (p.24)", () => {
    const r = launch({ identicalCandleSharePct: 70 });
    expect(rule(r, "botted_chart")).toMatchObject({ state: "fired", points: 15 });
  });

  it("chart: only huge candles ⇒ −10 (p.24)", () => {
    const r = launch({ hugeCandlesOnly: true });
    expect(rule(r, "huge_candles")).toMatchObject({ state: "fired", points: 10 });
  });

  it("chart: staircase ⇒ honeypot pattern, cap D (p.24)", () => {
    const r = launch({ staircase: true });
    expect(rule(r, "staircase")).toMatchObject({ state: "fired", capTier: "D" });
    atMost(r, "D");
  });

  it("chart: break below the last higher low ⇒ −5 (p.61-71)", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { brokeHigherLow: true }));
    expect(rule(r, "broke_hl")).toMatchObject({ state: "fired", points: 5 });
  });

  it("positive: bundlers flushed out adds points in Established mode (p.37)", () => {
    const yes = scoreSnapshot(perfectSnapshot("robinhood", { bundlersFlushed: true, earlyRetentionPct: 20 }));
    const no = scoreSnapshot(perfectSnapshot("robinhood", { bundlersFlushed: false, earlyRetentionPct: 20 }));
    expect(yes.rawScore).toBeGreaterThan(no.rawScore);
  });

  // v2.4 replaces "known launchpad adds points": basics are gates, not points.
  it("v2.4: a known launchpad is a passed gate worth 0 points (p.16, 19)", () => {
    const yes = launch({ isLaunchpad: true });
    const no = launch({ isLaunchpad: false, lpLockedPct: 100 });
    expect(yes.rawScore).toBe(no.rawScore);
    const f = yes.groups.flatMap((g) => g.factors).find((x) => x.id === "launchpad")!;
    expect([f.points, f.max]).toEqual([0, 0]);
    expect(f.evidence).toMatch(/Gate only/);
  });

  it("positive: socials only count when metadata actually has them (p.34, 47)", () => {
    const r = launch({ creatorHasSocials: null });
    expect(r.groups.flatMap((g) => g.factors).find((f) => f.id === "creator_socials")!.status).toBe("null");
  });
});

// ---------------------------------------------------------------------------------------------
const c = (t: number, o: number, h: number, l: number, cl: number): Candle => ({ t, o, h, l, c: cl, v: 100 });

describe("chart-pattern detectors (audited windows)", () => {
  it("identical candles: 25/30 same-size bodies ⇒ ≥ 60%", () => {
    const cs = Array.from({ length: 30 }, (_, i) => (i < 25 ? c(i * 60, 1, 1.03, 0.99, 1.02) : c(i * 60, 1, 1.2, 0.9, 1.15)));
    const r = identicalCandles(cs);
    expect(r.value).toBeGreaterThanOrEqual(60);
    expect(r.detection.candles).toBe(30);
    expect(r.detection.from).toBe("1970-01-01T00:00:00.000Z");
  });

  it("identical candles: too few non-doji candles ⇒ null with a reason", () => {
    const r = identicalCandles(Array.from({ length: 30 }, (_, i) => c(i * 60, 1, 1, 1, 1)));
    expect(r.value).toBeNull();
    expect(r.detection.detail).toMatch(/non-doji/);
  });

  it("staircase: step / plateau / step… with no red candles", () => {
    const cs: Candle[] = [];
    let p = 1;
    for (let i = 0; i < 12; i++) {
      if (i % 2 === 0) {
        cs.push(c(i * 300, p, p * 1.05, p, p * 1.05));
        p *= 1.05;
      } else cs.push(c(i * 300, p, p * 1.002, p * 0.999, p * 1.001));
    }
    expect(staircase(cs).value).toBe(true);
  });

  it("staircase: an ordinary rally without plateaus is not a staircase", () => {
    let p = 1;
    const cs = Array.from({ length: 12 }, (_, i) => {
      const k = c(i * 300, p, p * 1.04, p * 0.99, p * 1.03);
      p *= 1.03;
      return k;
    });
    expect(staircase(cs).value).toBe(false);
  });

  it("launch retrace: −35% after the first 15 minutes ⇒ retraced", () => {
    const cs = [c(0, 1, 2, 1, 2), c(600, 2, 2.1, 1.9, 2), c(1200, 2, 2, 1.3, 1.4)];
    const r = launchRetrace(cs, 0);
    expect(r.value).toBe(true);
    expect(r.detection.detail).toMatch(/−3\d\.\d%/);
  });

  it("launch retrace: never below 70% of the first high ⇒ not retraced", () => {
    const cs = [c(0, 1, 2, 1, 2), c(1200, 2, 2.5, 1.8, 2.4)];
    expect(launchRetrace(cs, 0).value).toBe(false);
  });

  it("trend: higher highs and higher lows ⇒ 1; break below the last HL is detected", () => {
    const prices = [1, 1.2, 1.5, 1.2, 1.1, 1.3, 1.7, 1.4, 1.25, 1.5, 1.9, 1.6, 1.45, 1.6, 1.7];
    const cs = prices.map((p, i) => c(i * 300, p, p * 1.01, p * 0.99, p));
    expect(trend(cs).value).toBe(1);
    const broke = [...cs, c(15 * 300, 1.3, 1.31, 1.2, 1.2), c(16 * 300, 1.2, 1.21, 1.1, 1.1)];
    expect(trend(broke).brokeHigherLow).toBe(true);
  });

  it("up-only: no 10% drawdown over ≥ 12 candles", () => {
    let p = 1;
    const cs = Array.from({ length: 15 }, (_, i) => {
      const k = c(i * 300, p, p * 1.02, p * 0.99, p * 1.02);
      p *= 1.02;
      return k;
    });
    expect(upOnly(cs).value).toBe(true);
  });
});
