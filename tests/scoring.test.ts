import { describe, expect, it } from "vitest";
import rawConfig from "@/lib/scoring/factors.json";
import { defaultConfig, loadConfig, modeFor, type ScoringConfig } from "@/lib/scoring/config";
import { scoreSnapshot, tierCeiling } from "@/lib/scoring/engine";
import { deriveMetrics } from "@/lib/snapshot";
import type { ScoreReport, Tier, TokenSnapshot } from "@/lib/types";
import { perfectLaunch, perfectSnapshot, strip } from "./helpers";

const clone = (): ScoringConfig => JSON.parse(JSON.stringify(rawConfig));
const fired = (r: ScoreReport) => r.rules.filter((x) => x.state === "fired").map((x) => x.id);
const factor = (r: ScoreReport, id: string) => r.groups.flatMap((g) => g.factors).find((f) => f.id === id)!;
const RANK: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5, U: 6 };

// ---------------------------------------------------------------------------------------------
describe("config loading", () => {
  it("both factor sets have group weights summing to 100", () => {
    for (const set of Object.values(defaultConfig.sets)) expect(set.groups.reduce((a, g) => a + g.weight, 0)).toBe(100);
    expect(defaultConfig.sets.established.groups.map((g) => g.id)).toEqual(["holders", "flow", "safety", "liquidity"]);
    // v2.4 (replaces the 35/25/25/15 split): basics carry no weight; it went to the other groups.
    for (const set of Object.values(defaultConfig.sets)) {
      const safety = set.groups.find((g) => g.id === "safety")!;
      expect(safety.weight).toBe(0);
      expect(safety.factors.every((f) => f.weight === 0 && f.gateOnly)).toBe(true);
      expect(set.groups.filter((g) => g.id !== "safety").every((g) => g.weight > 0)).toBe(true);
    }
  });

  it("rejects a config whose factor weights do not match the group weight", () => {
    const bad = clone();
    bad.sets.established.groups[0].factors[0].weight += 5;
    expect(() => loadConfig(bad)).toThrow(/weight/);
  });

  it("rejects guide factors without a page note", () => {
    const bad = clone();
    const f = bad.sets.launch.groups[0].factors.find((x) => x.source === "guide")!;
    delete f.note;
    expect(() => loadConfig(bad)).toThrow(/page note/);
  });

  it("picks up a new factor added only in config", () => {
    const cfg = clone();
    const liq = cfg.sets.established.groups.find((g) => g.id === "liquidity")!;
    // (token_age became bonus-only rules in §7d; take the 2 points from liq_fdv instead.)
    liq.factors.find((f) => f.id === "liq_fdv")!.weight -= 2;
    liq.factors.push({
      id: "volume_floor",
      label: "24h volume floor",
      weight: 2,
      metric: "volume24hUsd",
      direction: "higher_better",
      format: "usd",
      source: "hoodtier",
      data: ["dexscreener"],
      thresholds: [{ gte: 50_000, points: 1 }, { points: 0, flag: "warn" }],
      evidenceTemplate: "24h volume {value}.",
    });
    const loaded = loadConfig(cfg);
    const good = scoreSnapshot(perfectSnapshot(), [], loaded);
    expect(factor(good, "volume_floor").points).toBe(2);
    const thin = scoreSnapshot(perfectSnapshot("robinhood", { volume24hUsd: 1000 }), [], loaded);
    expect(thin.rawScore).toBeLessThan(good.rawScore);
  });

  it("guide-sourced factors carry ≥ 60% of launch-mode weight", () => {
    const factors = defaultConfig.sets.launch.groups.flatMap((g) => g.factors);
    const guide = factors.filter((f) => f.source === "guide").reduce((a, f) => a + f.weight, 0);
    expect(guide).toBeGreaterThanOrEqual(60);
  });

  it("every factor and rule names its source", () => {
    for (const set of Object.values(defaultConfig.sets))
      for (const f of set.groups.flatMap((g) => g.factors)) {
        expect(["guide", "hoodtier"]).toContain(f.source);
        if (f.weight > 0) expect(f.data.length).toBeGreaterThan(0);
      }
    for (const r of defaultConfig.rules) expect(["guide", "hoodtier"]).toContain(r.source);
  });
});

// ---------------------------------------------------------------------------------------------
describe("mode selection (age picks the set, never penalises)", () => {
  it("uses the launch set under 72h and the established set from 72h", () => {
    expect(modeFor(71.9)).toBe("launch");
    expect(modeFor(72)).toBe("established");
    expect(scoreSnapshot(perfectLaunch()).mode).toBe("launch");
    expect(scoreSnapshot(perfectLaunch()).modeLabel).toBe("Launch mode (<72h)");
    expect(scoreSnapshot(perfectSnapshot()).modeLabel).toBe("Established mode");
  });

  it("states when the age is unknown", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { ageHours: null }));
    expect(r.mode).toBe("established");
    expect(r.modeLabel).toMatch(/age unknown/);
  });

  it("has no age penalty at all", () => {
    expect(defaultConfig.rules.some((r) => r.id === "too_new")).toBe(false);
    for (const age of [0.2, 5, 23, 71]) {
      const r = scoreSnapshot(perfectLaunch("solana", { ageHours: age, volMcVsBar: 1.5 }));
      expect(r.penalties).toEqual([]);
    }
  });

  // Replaced (§7d: age never gates anywhere, including S): a perfect launch-age token reaches S.
  it("age never gates S: a perfect token under 72h is S, and no requirement mentions age", () => {
    const r = scoreSnapshot(perfectLaunch());
    expect(r.rawScore).toBe(100);
    expect(r.tier).toBe("S");
    expect(r.requirements.map((x) => x.id).join(" ")).not.toMatch(/age/);
  });

  it("age only adds: track-record bonus in Established mode, never a penalty", () => {
    const young = scoreSnapshot(perfectSnapshot("robinhood", { ageHours: 80 }));
    const week = scoreSnapshot(perfectSnapshot("robinhood", { ageHours: 200 }));
    const month = scoreSnapshot(perfectSnapshot("robinhood", { ageHours: 800 }));
    expect(young.bonuses).toEqual([]);
    expect(week.bonuses.map((b) => [b.id, b.points])).toEqual([["track_record_7d", 1.5]]);
    expect(month.bonuses.map((b) => [b.id, b.points])).toEqual([["track_record_30d", 3]]);
    expect(young.penalties).toEqual([]);
    expect(defaultConfig.sets.established.groups.flatMap((g) => g.factors).map((f) => f.metric)).not.toContain("ageHours");
  });
});

// ---------------------------------------------------------------------------------------------
describe("tiers and S/A requirements", () => {
  it("scores a clean early-runner as S", () => {
    const r = scoreSnapshot(perfectSnapshot());
    expect(r.rawScore).toBe(100);
    expect(r.tier).toBe("S");
    expect(r.requirements.filter((x) => x.state !== "pass")).toEqual([]);
  });

  it("works for Solana too", () => {
    expect(scoreSnapshot(perfectSnapshot("solana")).tier).toBe("S");
  });

  it("downgrades S to A when the early-runner pattern is missing (buyers < sellers)", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { buyerSellerRatio: 0.9 }));
    expect(r.rawScore).toBeGreaterThanOrEqual(85);
    expect(r.tier).toBe("A");
    expect(r.tierReason).toMatch(/Buyers ≥ sellers/);
  });

  it("drops A to B when a basic flaw exists (top-10 ≥ 60%)", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { top10SharePct: 65 }));
    expect(r.rawScore).toBeGreaterThanOrEqual(70);
    expect(r.tier).toBe("B");
  });

  it("caps unknown sellability at C (spec A.5 — replaces the old 'unknown honeypot allows A')", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { honeypot: null, sellable: null }));
    expect(fired(r)).toContain("sellable_unknown");
    expect(r.tier).toBe("C");
    expect(r.score).toBeLessThanOrEqual(tierCeiling("C"));
  });

  it("maps score bands to tiers", () => {
    const weak = scoreSnapshot(
      perfectSnapshot("robinhood", {
        top10SharePct: 55,
        top1SharePct: 3,
        accumulatorCount: 0,
        accumulatorSupplyPct: 0,
        earlyRetentionPct: 35,
        earlyExitRatePct: 65,
        bundlersFlushed: false,
        netFlowRatio24h: -0.1,
        buyerSellerRatio: 0.6,
        smartMoneyNetUsd: -1000,
        flowConsistent: false,
        liqFdvPct: 1.5,
        mainPoolSharePct: 20,
        singleTradeWalletSharePct: 80,
        roundTripLossPct: 30,
        ownerRenounced: false,
        isLaunchpad: false,
        lpLockedPct: 60,
        poolCount: 25,
        volMcVsBar: 0.4,
        trendScore: 0,
        // 80h: Established without the §7d track-record bonus, so the bands are tested on factors alone.
        ageHours: 80,
      }),
    );
    expect(weak.score!).toBeLessThan(55);
    expect(["C", "D"]).toContain(weak.tier);
  });
});

// ---------------------------------------------------------------------------------------------
describe("tier / displayed-score monotonicity", () => {
  // Deterministic pseudo-random variations across every lever the engine has.
  function* variants(): Generator<TokenSnapshot> {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    for (let i = 0; i < 400; i++) {
      const base = rnd() < 0.5 ? perfectSnapshot(pick(["robinhood", "solana"] as const)) : perfectLaunch(pick(["robinhood", "solana"] as const));
      yield {
        ...base,
        top10SharePct: pick([5, 20, 45, 70, null]),
        top1SharePct: pick([1, 3, 5, 25, 40, null]),
        buyerSellerRatio: pick([0.4, 0.8, 1.1, 1.5]),
        netFlowRatio24h: pick([-0.3, 0, 0.2, null]),
        sellable: pick([true, true, true, null, false]),
        deployerSoldPct: pick([0, 30, 60, null]),
        volMcRatio: pick([0.3, 0.9, 1.5]),
        volMcVsBar: pick([0.3, 0.8, 1.2]),
        liqFdvPct: pick([0.5, 3, 12, null]),
        accumulatorCount: pick([0, 2, 6, null]),
        insiderSupplyPct: pick([0, 20, 45, null]),
        washFlag: pick([false, false, true]),
        staircase: pick([false, false, true, null]),
        mintAuthority: base.chain === "solana" ? pick([false, false, true]) : null,
        ageHours: pick([3, 30, 100, 1000]),
      } as TokenSnapshot;
    }
  }

  it("a higher displayed score never means a lower tier", () => {
    const reports = [...variants()].map((s) => scoreSnapshot(s)).filter((r) => r.tier !== "U");
    expect(new Set(reports.map((r) => r.tier)).size).toBeGreaterThan(3);
    for (const a of reports)
      for (const b of reports) {
        if (a.score! > b.score!) expect(RANK[a.tier]).toBeLessThanOrEqual(RANK[b.tier]);
      }
  });

  it("the displayed score always sits inside its tier band, with raw shown separately", () => {
    for (const s of variants()) {
      const r = scoreSnapshot(s);
      if (r.tier === "U") {
        expect(r.score).toBeNull();
        continue;
      }
      const band = defaultConfig.tiers.find((t) => t.tier === r.tier)!;
      expect(r.score!).toBeGreaterThanOrEqual(band.min);
      expect(r.score!).toBeLessThanOrEqual(tierCeiling(r.tier as Exclude<Tier, "U">));
      expect(typeof r.rawScore).toBe("number");
    }
  });

  it("clamps a capped token's score to the top of the capped band", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { top1SharePct: 25 }));
    expect(r.rawScore).toBeGreaterThan(70);
    expect(r.tier).toBe("C");
    expect(r.score).toBe(54.9);
    expect(r.tierReason).toMatch(/clamped to 54.9/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("coverage rules", () => {
  const thin = (keep: number) => {
    // Null out factors until roughly `keep`% of established weight remains.
    const all: (keyof TokenSnapshot)[] = [
      "top10SharePct", "top1SharePct", "accumulatorCount", "accumulatorSupplyPct", "earlyRetentionPct", "bundlersFlushed",
      "deployerHoldingPct", "deployerSoldPct", "netFlowRatio24h", "buyerSellerRatio", "singleTradeWalletSharePct",
      "tradesPerWallet", "smartMoneyNetUsd", "flowConsistent", "washFlag", "volMcVsBar", "roundTripLossPct",
      "ownerRenounced", "upgradeable", "liqFdvPct", "mainPoolSharePct", "liqChange24hPct", "liqChange7dPct", "poolCount", "trendScore",
    ];
    const s = perfectSnapshot();
    let r = scoreSnapshot(s);
    const removed: (keyof TokenSnapshot)[] = [];
    for (const m of all) {
      if (r.coveragePct <= keep) break;
      removed.push(m);
      r = scoreSnapshot(strip(s, removed));
    }
    return r;
  };

  // Replaced (§7e): low coverage alone no longer unrates — only weight missing because a SOURCE
  // FAILED does. Fields no source provides still lower coverage and cap the tier.
  it("< 40% coverage without failed sources is still rated (numeric score, capped at B)", () => {
    const r = thin(35);
    expect(r.coveragePct).toBeLessThan(40);
    expect(r.tier).not.toBe("U");
    expect(r.score).not.toBeNull();
    expect(["B", "C", "D", "F"]).toContain(r.tier);
  });

  it("≥ 40% of weight missing because sources failed ⇒ U naming them", () => {
    const strip35 = thin(35).token;
    const r = scoreSnapshot(strip35, [
      { id: "hoodscan", label: "HoodScan", state: "failed", message: "HTTP 503" },
      { id: "rpc", label: "Robinhood RPC", state: "failed", message: "timeout" },
      { id: "geckoterminal", label: "GeckoTerminal", state: "failed", message: "HTTP 429" },
      { id: "dexscreener", label: "DexScreener", state: "failed", message: "HTTP 500" },
      { id: "scanhood", label: "ScanHood", state: "failed", message: "HTTP 500" },
    ]);
    expect(r.tier).toBe("U");
    expect(r.score).toBeNull();
    expect(r.tierReason).toMatch(/sources failed: .*HoodScan/);
    expect(r.binding?.kind).toBe("coverage");
  });

  it("40–60% ⇒ capped at B", () => {
    const r = thin(55);
    expect(r.coveragePct).toBeGreaterThanOrEqual(40);
    expect(r.coveragePct).toBeLessThan(60);
    expect(["B", "C", "D", "F"]).toContain(r.tier);
    expect(r.tier).toBe("B");
  });

  it("S/A need ≥ 80% coverage", () => {
    const r = thin(75);
    expect(r.coveragePct).toBeGreaterThanOrEqual(60);
    expect(r.coveragePct).toBeLessThan(80);
    expect(r.rawScore).toBeGreaterThanOrEqual(85);
    expect(r.tier).toBe("B");
    expect(r.tierReason).toMatch(/≥ 80% data coverage/);
  });

  it("stale-but-present values count as covered", () => {
    const s = { ...perfectSnapshot(), staleFields: { top10SharePct: 30, buyerSellerRatio: 30, netFlowRatio24h: 30 } };
    const r = scoreSnapshot(s);
    expect(r.coveragePct).toBe(100);
    expect(factor(r, "top10_share").status).toBe("stale");
    expect(factor(r, "top10_share").evidence).toMatch(/stale, 30m old/);
    expect(r.tier).toBe("S");
  });
});

// ---------------------------------------------------------------------------------------------
describe("gates", () => {
  it("mint authority enabled ⇒ F (guide p.17-19)", () => {
    const r = scoreSnapshot(perfectSnapshot("solana", { mintAuthority: true }));
    expect(r.gates.find((g) => g.id === "mint_enabled")!.state).toBe("fail");
    expect(r.tier).toBe("F");
    expect(r.score).toBe(0);
  });

  it("marks Solana-only gates as n/a on Robinhood Chain", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood"));
    expect(r.gates.find((g) => g.id === "freeze_enabled")!.state).toBe("n/a");
  });

  it("forces honeypots to score 0 / tier F", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { sellable: false, honeypot: true }));
    expect(r.tier).toBe("F");
    expect(r.score).toBe(0);
    expect(fired(r)).toContain("honeypot");
  });

  it("all buyers exited ⇒ F", () => {
    const r = scoreSnapshot(perfectLaunch("solana", { allBuyersExited: true, uniqueBuyers: 7 }));
    expect(fired(r)).toContain("all_buyers_exited");
    expect(r.tier).toBe("F");
    expect(r.gates.find((g) => g.id === "all_buyers_exited")!.state).toBe("fail");
  });

  it("derives sellability from an explicit honeypot verdict", () => {
    expect(deriveMetrics(perfectSnapshot("robinhood", { sellable: null, honeypot: true })).sellable).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Sellable row", () => {
  it('shows "sellable: yes", not the raw honeypot boolean', () => {
    const f = factor(scoreSnapshot(perfectSnapshot()), "sellable");
    expect(f.display).toBe("sellable: yes");
    expect(f.metric).toBe("sellable");
    expect(factor(scoreSnapshot(perfectSnapshot("robinhood", { sellable: false })), "sellable").display).toBe("sellable: no");
  });
});

// ---------------------------------------------------------------------------------------------
describe("penalties (rules with points)", () => {
  const cases: [string, Partial<TokenSnapshot>, number][] = [
    ["dev_sold", { deployerSoldPct: 60 }, 10],
    ["wash", { washFlag: true }, 20],
    ["liq_drain", { liqChange7dPct: -45, liqChange7dWindow: "7d" }, 15],
  ];
  for (const [id, overrides, points] of cases) {
    it(`applies ${id} (−${points}) and lists it separately`, () => {
      const r = scoreSnapshot(perfectSnapshot("robinhood", overrides));
      expect(r.penalties.find((x) => x.id === id)?.points).toBe(points);
      // Bonuses (e.g. the §7d track record) offset penalties.
      const total = r.penalties.reduce((a, x) => a + x.points, 0) - r.bonuses.reduce((a, x) => a + x.points, 0);
      const afterPenalties = Math.max(0, r.rawScore - total);
      expect(r.score!).toBeLessThanOrEqual(afterPenalties + 1e-9);
    });
  }

  // Replaced (v2.2 audit: the 3.5% top-holder rule is Launch-only): it used to apply −10 to an
  // established token; now it must fire in Launch mode and be absent in Established mode.
  it("top_holder_bundle (−10) applies in Launch mode only", () => {
    const l = scoreSnapshot(perfectLaunch("robinhood", { top1SharePct: 5 }));
    expect(l.penalties.find((x) => x.id === "top_holder_bundle")?.points).toBe(10);
    const e = scoreSnapshot(perfectSnapshot("robinhood", { top1SharePct: 5 }));
    expect(e.mode).toBe("established");
    expect(e.rules.map((x) => x.id)).not.toContain("top_holder_bundle");
    expect(e.penalties.find((x) => x.id === "top_holder_bundle")).toBeUndefined();
    // Kolshi-like: 3.57% on an established token costs nothing from the rule.
    expect(scoreSnapshot(perfectSnapshot("robinhood", { top1SharePct: 3.57 })).penalties).toEqual([]);
  });

  it("does not fire penalties on missing data", () => {
    const r = scoreSnapshot(strip(perfectSnapshot(), ["deployerSoldPct", "top1SharePct", "liqChange7dPct"]));
    expect(r.penalties).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("missing-data neutrality", () => {
  const optional = ["deployerSoldPct", "deployerHoldingPct", "liqChange24hPct", "liqChange7dPct", "smartMoneyNetUsd", "roundTripLossPct"] as const;

  it("missing metrics do not drag a strong token down", () => {
    const r = scoreSnapshot(strip(perfectSnapshot(), [...optional]));
    expect(r.rawScore).toBe(100);
    for (const f of r.groups.flatMap((g) => g.factors).filter((x) => (optional as readonly string[]).includes(x.metric))) {
      expect(f.missing).toBe(true);
      expect(f.points).toBe(0);
      expect(f.status).toBe("null");
    }
    expect(r.coveragePct).toBeLessThan(100);
  });

  it("missing metrics do not lift a weak token up", () => {
    const weakBase = perfectSnapshot("robinhood", { liqFdvPct: 0.5, mainPoolSharePct: 10, poolCount: 30 });
    const full = scoreSnapshot(weakBase);
    const stripped = scoreSnapshot(strip(weakBase, ["liqChange24hPct", "liqChange7dPct"]));
    const g = (r: ScoreReport) => r.groups.find((x) => x.id === "liquidity")!;
    expect(g(stripped).points / g(stripped).max).toBeLessThan(g(full).points / g(full).max);
  });

  it("a group with no data is excluded and the rest is renormalized", () => {
    const s = strip(perfectSnapshot(), ["liqFdvPct", "mainPoolSharePct", "liqChange24hPct", "liqChange7dPct", "ageHours", "poolCount", "trendScore"]);
    const r = scoreSnapshot({ ...s, ageHours: null });
    expect(r.groups.find((g) => g.id === "liquidity")!.hasData).toBe(false);
    expect(r.rawScore).toBe(100);
  });

  it("null factors state the exact reason", () => {
    const r = scoreSnapshot(perfectLaunch("solana", { freshWalletsTop20: null }), [{ id: "helius", label: "Helius", state: "skipped", message: "Helius key not set" }]);
    const f = factor(r, "fresh_wallets");
    expect(f.status).toBe("null");
    expect(f.nullReason).toBe("Helius key not set");
    expect(f.evidence).toMatch(/^No data/); // the exact reason is shown once, in the row status tag (nullReason)
  });

  it("adapter-supplied null reasons win", () => {
    // (v2.3: chart_huge is absent from the Solana set — no Solana source has per-candle trade counts.)
    const r = scoreSnapshot({ ...perfectLaunch("solana", { identicalCandleSharePct: null }), nullReasons: { identicalCandleSharePct: "too few candles" } });
    expect(factor(r, "chart_identical").nullReason).toBe("too few candles");
  });

  // Replaced (audit: "ignore unknown LP lock noise on established tokens"): unknown LP lock on an
  // established token used to be "no data" (lowering coverage); it is now n/a and costs nothing.
  it("treats unknown LP lock on an established token as n/a — no coverage loss, no points lost", () => {
    const known = scoreSnapshot(perfectSnapshot("robinhood", { lpLockedPct: 100, isLaunchpad: false }));
    const r = scoreSnapshot(perfectSnapshot("robinhood", { lpLockedPct: null, isLaunchpad: false }));
    const lp = factor(r, "lp_lock");
    expect(lp.applicable).toBe(false);
    expect(lp.status).toBe("n/a");
    expect(lp.missing).toBe(false);
    expect(lp.evidence).toMatch(/not held against the token/);
    expect(r.coveragePct).toBe(known.coveragePct);
    expect(r.tier).toBe(known.tier);
  });

  it("launchpad tokens pass the LP rule by construction and say so", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { lpLockedPct: null, isLaunchpad: true, launchpad: "Pons" }));
    const lp = factor(r, "lp_lock");
    expect(lp.points).toBe(lp.max);
    expect(lp.evidence).toMatch(/Pons.*by construction/);
  });

  // Replaced: the 3–14 day "unverifiable LP lock" warning moved to Launch mode only (established = n/a).
  it("still flags unverifiable LP lock on launch-age non-launchpad tokens, and a measured unlocked LP still fires", () => {
    const r = scoreSnapshot(perfectLaunch("robinhood", { lpLockedPct: null, isLaunchpad: false }));
    const lp = factor(r, "lp_lock");
    expect(r.mode).toBe("launch");
    expect(lp.missing).toBe(false);
    expect(lp.flag).toBe("warn");
    expect(lp.points).toBeCloseTo(lp.max * 0.25);
    const est = scoreSnapshot(perfectSnapshot("robinhood", { lpLockedPct: 10, isLaunchpad: false, ageHours: 100 }));
    expect(factor(est, "lp_lock").flag).toBe("danger");
    expect(est.rules.find((x) => x.id === "lp_unlocked")!.state).toBe("fired");
  });
});

// ---------------------------------------------------------------------------------------------
describe("derived metrics", () => {
  it("computes holder concentration from a holder list and accumulators from swap-index holders", () => {
    const s = deriveMetrics({
      ...perfectSnapshot("robinhood", { top10SharePct: null, top1SharePct: null, accumulatorCount: null, accumulatorSupplyPct: null }),
      totalSupply: 1000,
      holders: [
        { address: "a", qty: 50, pct: null, buys: null, sells: null, isContract: null },
        { address: "b", qty: 30, pct: null, buys: null, sells: null, isContract: null },
        { address: "pool", qty: 400, pct: null, buys: null, sells: null, isContract: true },
        { address: "c", qty: 20, pct: null, buys: null, sells: null, isContract: null },
      ],
      swapHolders: [
        { address: "a", qty: 50, pct: null, buys: 10, sells: 0, isContract: null },
        { address: "b", qty: 30, pct: null, buys: 6, sells: 0, isContract: null },
        { address: "c", qty: 20, pct: null, buys: 2, sells: 1, isContract: null },
      ],
    });
    expect(s.top10SharePct).toBeCloseTo(10);
    expect(s.top1SharePct).toBeCloseTo(5);
    expect(s.liquidityHeldPct).toBeCloseTo(40);
    expect(s.accumulatorCount).toBe(2);
    expect(s.accumulatorSupplyPct).toBeCloseTo(8);
  });

  it("falls back to swap-index holders when no on-chain holder list exists", () => {
    const s = deriveMetrics({
      ...perfectSnapshot("robinhood", { top10SharePct: null, top1SharePct: null }),
      totalSupply: 1000,
      swapHolders: [{ address: "a", qty: 50, pct: null, buys: 1, sells: 0, isContract: null }],
    });
    expect(s.holderSource).toBe("swap-index");
    expect(s.top10SharePct).toBeCloseTo(5);
  });

  it("raises the wash flag on repeated sizes plus high turnover", () => {
    const s = deriveMetrics(perfectSnapshot("robinhood", { washFlag: null, volLiqRatio: 12, repeatedSizeSharePct: 30, bundleSharePct: 0 }));
    expect(s.washFlag).toBe(true);
    expect(s.fakeSignals.some((f) => f.kind === "wash")).toBe(true);
  });

  it("leaves wash flag false for normal activity", () => {
    const s = deriveMetrics(perfectSnapshot("robinhood", { washFlag: null, volLiqRatio: 1.3, repeatedSizeSharePct: 5, bundleSharePct: 3 }));
    expect(s.washFlag).toBe(false);
  });

  it("scales the VOL/MC bar by age (guide p.25)", () => {
    const at = (age: number) => deriveMetrics(perfectSnapshot("solana", { ageHours: age, volMcRatio: null, volMcBar: null, volMcVsBar: null, volume24hUsd: 1200, fdvUsd: 1000 }));
    expect(at(3).volMcBar).toBe(1.5);
    expect(at(12).volMcBar).toBe(1.2);
    expect(at(48).volMcBar).toBe(1.0);
    expect(at(200).volMcBar).toBe(0.8);
    expect(at(12).volMcVsBar).toBeCloseTo(1);
  });

  it("bundlers flushed needs a 3d+ token, ≥ 70% early exit and price above launch", () => {
    const base = { bundlersFlushed: null, earlyExitRatePct: 75, priceUsd: 0.004, launchPriceUsd: 0.002 };
    expect(deriveMetrics(perfectSnapshot("robinhood", { ...base, ageHours: 100 })).bundlersFlushed).toBe(true);
    expect(deriveMetrics(perfectSnapshot("robinhood", { ...base, ageHours: 100, priceUsd: 0.001 })).bundlersFlushed).toBe(false);
    expect(deriveMetrics(perfectSnapshot("robinhood", { ...base, ageHours: 40 })).bundlersFlushed).toBeNull();
  });

  it("honeypot triad = up-only chart + low volume + few holders", () => {
    const d = deriveMetrics(perfectSnapshot("solana", { honeypotPattern: null, upOnlyChart: true, volume24hUsd: 3000, holderCount: 12 }));
    expect(d.honeypotPattern).toBe(true);
    expect(deriveMetrics(perfectSnapshot("solana", { honeypotPattern: null, upOnlyChart: false })).honeypotPattern).toBe(false);
  });
});

describe("all buyers exited from on-chain curve state", () => {
  const drained = (o: Partial<TokenSnapshot> = {}) =>
    deriveMetrics(perfectLaunch("solana", { allBuyersExited: null, uniqueBuyers: null, curveProgressPct: 0, realSolReserves: 8e-9, curveCirculatingPct: 0.0001, ageHours: 5, buyers24h: 7, sellers24h: 8, ...o }));

  it("a drained pump.fun curve with ≥ 5 buyers and sellers ⇒ all buyers exited ⇒ F", () => {
    const d = drained();
    expect(d.allBuyersExited).toBe(true);
    expect(d.uniqueBuyers).toBe(7);
    const r = scoreSnapshot(d);
    expect(r.tier).toBe("F");
    expect(r.rules.find((x) => x.id === "all_buyers_exited")!.evidence).toMatch(/7 buyers/);
  });

  it("does not fire with fewer than 5 buyers, on a live curve, or past 24h", () => {
    expect(drained({ buyers24h: 3 }).allBuyersExited).toBe(false);
    expect(drained({ curveCirculatingPct: 2.6 }).allBuyersExited).toBeNull();
    expect(drained({ ageHours: 30 }).allBuyersExited).toBeNull();
  });
});
