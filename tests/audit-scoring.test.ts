import { describe, expect, it } from "vitest";
import fx from "./fixtures/microduck.json";
import { applyHold, completeRunOf, usableValues, type CompleteRun } from "@/lib/hold";
import { describe as describeFactor, lowerFirst, scoreSnapshot } from "@/lib/scoring/engine";
import { defaultConfig, type ScoringConfig } from "@/lib/scoring/config";
import { OHLCV_FIELDS } from "@/lib/sources/geckoterminal";
import { ageCachedReport, normalizeReport, parseStaleAge } from "@/lib/normalizeReport";
import { summarize } from "@/lib/summary";
import { eligibility } from "@/lib/memeFilter";
import type { FactorResult, ScoreReport, SourceStatus, TokenSnapshot } from "@/lib/types";
import { perfectLaunch, perfectSnapshot } from "./helpers";

const MIN = 60_000;
const H = 60 * MIN;
const factorsOf = (r: ScoreReport) => r.groups.flatMap((g) => g.factors);
const byId = (r: ScoreReport, id: string) => factorsOf(r).find((f) => f.id === id)!;
const byMetric = (r: ScoreReport, m: string) => factorsOf(r).find((f) => f.metric === m)!;

describe("H2: minSample — an insufficient sample is not scored and not counted as covered", () => {
  it("a known sample below the bar is n/a (out of the applicable and the available weight)", () => {
    const r = scoreSnapshot(perfectLaunch("solana", { uniqueBuyers: 30 }));
    for (const id of ["organic_score", "bundle_score"]) {
      const f = byId(r, id);
      expect(f.status).toBe("n/a");
      expect(f.applicable).toBe(false);
      expect(f.missing).toBe(false);
      expect(f.points).toBe(0);
      expect(f.evidence).toMatch(/^insufficient sample — 30 unique buyers \(needs ≥ 50\); .* not scored\.$/);
      const g = r.groups.find((x) => x.factors.some((y) => y.id === id))!;
      expect(g.factors.filter((y) => y.applicable && !y.missing).some((y) => y.id === id)).toBe(false);
    }
  });
  it("an unknown sample size is missing with the reason, never 0 points counted as data", () => {
    const s = perfectLaunch("solana", { uniqueBuyers: null, nullReasons: { uniqueBuyers: "Helius key not set" } });
    const f = byId(scoreSnapshot(s), "bundle_score");
    expect(f.status).toBe("null");
    expect(f.missing).toBe(true);
    expect(f.nullReason).toMatch(/^unique buyers unknown \(Helius key not set\) — needs ≥ 50/);
  });
  it("at 50+ the factor scores normally", () => {
    expect(byId(scoreSnapshot(perfectLaunch("solana", { uniqueBuyers: 50 })), "organic_score").status).toBe("live");
  });
});

describe("M3: the stale label is applied on every non-null path", () => {
  it("threshold path (unchanged)", () => {
    const f = byMetric(scoreSnapshot(perfectSnapshot("robinhood", { staleFields: { top10SharePct: 42 } })), "top10SharePct");
    expect(f.status).toBe("stale");
    expect(f.stale).toBe("42m");
  });
  it("zero-activity path: a stale 0 is labelled stale", () => {
    const metric = "volume24hUsd";
    expect(defaultConfig.zeroActivity!.metrics).toContain(metric);
    const cfg = structuredClone(defaultConfig) as ScoringConfig;
    const f0 = cfg.sets.established.groups[0].factors[0];
    f0.metric = metric as typeof f0.metric;
    const s = perfectSnapshot("robinhood", { zeroActivity: ["0 trades in 24h (HoodScan)"], volume24hUsd: 0, staleFields: { volume24hUsd: 75 } });
    const f = byId(scoreSnapshot(s, [], cfg), f0.id);
    expect(f.display).toBe("0 — no activity");
    expect(f.status).toBe("stale");
    expect(f.evidence).toMatch(/\(stale, 1h 15m old\)$/);
  });
  it("whenMissing 'score' path: stale when a metric the rule reads is stale", () => {
    const cfg = structuredClone(defaultConfig) as ScoringConfig;
    const lp = cfg.sets.established.groups.flatMap((g) => g.factors).find((f) => f.id === "lp_lock")!;
    lp.whenMissing = [{ if: { isLaunchpad: { eq: true } }, mode: "score", points: 1, evidence: "launchpad pool — nothing to lock" }];
    const s = perfectSnapshot("robinhood", { lpLockedPct: null, isLaunchpad: true, staleFields: { isLaunchpad: 30 } });
    const f = byId(scoreSnapshot(s, [], cfg), "lp_lock");
    expect(f.status).toBe("stale");
    expect(f.stale).toBe("30m");
    expect(f.evidence).toMatch(/^launchpad pool — nothing to lock \(stale, 30m old\)/);
  });
});

describe("U accounting (audit M4 rejected): a factor counts when a source that feeds it failed or was not configured", () => {
  const nulls: Partial<TokenSnapshot> = { devBuySharePct: null, snipeRatioPct: null, bundleScore: null, organicScore: null, timingEntropy: null, freshWalletsTop20: null, fundingClusterMax: null, creatorRugRatePct: null, deployerSoldPct: null, top1SharePct: null };
  const src = (rug: SourceStatus["state"], helius: SourceStatus["state"], feed: SourceStatus["state"]): SourceStatus[] => [
    { id: "helius", label: "Helius", state: helius, message: helius === "skipped" ? "HELIUS_API_KEY not set" : "HTTP 429" },
    { id: "pumpfeed", label: "pump.fun intel feed", state: feed, message: "Timed out" },
    { id: "rugcheck", label: "RugCheck", state: rug, message: "Timed out" },
    { id: "solana-rpc", label: "Solana RPC", state: "ok" },
    { id: "geckoterminal", label: "GeckoTerminal", state: "ok" },
    { id: "dexscreener", label: "DexScreener", state: "ok" },
  ];
  const s = perfectLaunch("solana", { uniqueBuyers: 60, ...nulls });
  it("Helius and the feed failed ⇒ U, whether or not RugCheck answered (section7 §7e)", () => {
    const a = scoreSnapshot(s, src("failed", "failed", "failed"));
    expect(a.tier).toBe("U");
    expect(a.binding!.text).toMatch(/RugCheck/);
    const b = scoreSnapshot(s, src("ok", "failed", "failed"));
    expect(b.tier).toBe("U");
    expect(b.binding!.text).not.toMatch(/RugCheck/);
  });
  it("sources that were skipped (key not set) count, and are named as not configured", () => {
    const r = scoreSnapshot(s, src("ok", "skipped", "skipped"));
    expect(r.tier).toBe("U");
    expect(r.binding!.text).toMatch(/^sources not configured: /);
  });
  it("skipped sources beside failed ones are named apart", () => {
    const empty = Object.fromEntries(Object.keys(perfectLaunch("robinhood")).filter((k) => !["chain", "address", "name", "symbol", "holders", "swapHolders", "liquidityHolders", "poolAddresses", "staleFields", "patterns", "nullReasons", "provenance", "fakeSignals", "links", "ageHours", "zeroActivity"].includes(k)).map((k) => [k, null]));
    const sources = ["hoodscan", "rpc", "geckoterminal", "dexscreener", "rh-launch"].map((id): SourceStatus => (id === "rpc" ? { id, label: id, state: "skipped", message: "RPC key not set" } : { id, label: id, state: "failed", message: "timeout" }));
    const r = scoreSnapshot({ ...perfectLaunch("robinhood"), ...empty } as TokenSnapshot, sources);
    expect(r.tier).toBe("U");
    expect(r.binding!.text).toMatch(/^sources failed: [a-z-, ]+; not configured: rpc \(RPC key not set\) \(\d+% of weight\) ⇒ U$/);
    expect(r.binding!.text.split(";")[0]).not.toContain("rpc");
  });
});

describe("main risk: never a bonus, binding cap first, then the largest penalty", () => {
  it("an established token with only the track-record bonus does not call the bonus a risk", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { ageHours: 24 * 90 }));
    expect(r.bonuses.map((b) => b.id)).toContain("track_record_30d");
    expect(r.verdict).not.toMatch(/main risk: track record/i);
  });
  it("NIKO: −20 VOL/MC bundle and −10 top holder ⇒ main risk is the larger penalty, not config order", () => {
    const s = perfectLaunch("solana", { ageHours: 41.7, volMcRatio: 0, top1SharePct: 4 });
    const r = scoreSnapshot(s);
    const ids = r.penalties.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["vol_mc_bundle", "top_holder_bundle"]));
    const label = r.rules.find((x) => x.id === "vol_mc_bundle")!.label;
    expect(r.verdict).toContain(`main risk: ${lowerFirst(label)}`);
  });
  it("a binding cap is the main risk ahead of a bigger penalty", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { upgradeable: true, liqChange7dPct: -60, liqChange24hPct: -60 }));
    expect(r.binding).toEqual({ kind: "cap", text: "cap: Upgradeable proxy ⇒ B" });
    expect(r.penalties.map((p) => p.id)).toContain("liq_drain");
    expect(r.verdict).toMatch(/main risk: upgradeable proxy\.$/);
  });
  it("a boolean strength is one clean clause: no parenthetical, no lower-cased timestamps", () => {
    const f = { value: false, label: "Launch retrace", display: "no", evidence: "Price retraced ≥ 30% from the first 15-minute high — normal price discovery. (253 × 1m candles, 2026-11-18T14:53Z → 2026-11-18T19:50Z)" } as FactorResult;
    expect(describeFactor(f)).toBe("price retraced ≥ 30% from the first 15-minute high — normal price discovery");
    expect(describeFactor({ ...f, evidence: "VOL/MC clears the bar (stale, 5m old)" } as FactorResult)).toBe("VOL/MC clears the bar");
  });
});

describe("tierReason arithmetic matches the per-rule points", () => {
  it("penalties and bonuses are listed apart (PONS: liq_drain 15, track record +3 ⇒ not '− 12')", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { ageHours: 24 * 130, liqChange7dPct: -64.86, liqChange24hPct: -64.86 }));
    expect(r.penalties.map((p) => [p.id, p.points])).toEqual([["liq_drain", 15]]);
    expect(r.bonuses.map((p) => [p.id, p.points])).toEqual([["track_record_30d", 3]]);
    expect(r.tierReason).toContain(`(raw ${r.rawScore} − 15 penalties + 3 bonus)`);
    // Penalties are not scaled by coverage: the score is raw − penalties + bonuses.
    expect(r.score).toBe(Math.round((r.rawScore - 15 + 3) * 10) / 10);
  });
});

describe("L7: a value no threshold covers is a config gap (null with reason), not 0 points", () => {
  it("is null with the reason", () => {
    const cfg = structuredClone(defaultConfig) as ScoringConfig;
    const f = cfg.sets.established.groups.flatMap((g) => g.factors).find((x) => x.id === "top10_share")!;
    f.thresholds = [{ lte: 15, points: 1 }];
    const r = scoreSnapshot(perfectSnapshot("robinhood", { top10SharePct: 50 }), [], cfg);
    const out = byId(r, "top10_share");
    expect(out.status).toBe("null");
    expect(out.missing).toBe(true);
    expect(out.nullReason).toMatch(/^config gap: no threshold in factors\.json covers 50/);
  });
});

describe("L2: factor data sources", () => {
  const find = (set: string, id: string) => defaultConfig.sets[set].groups.flatMap((g) => g.factors).find((f) => f.id === id)!;
  it("creator_socials names RugCheck (its real source), top10_share (established) names Helius", () => {
    expect(find("launch", "creator_socials").data).toEqual(["rugcheck"]);
    expect(find("established", "top10_share").data).toContain("helius");
  });
});

describe("L1: normalizeReport keeps missing numbers missing", () => {
  it("rawScore / coveragePct absent ⇒ null, not 0", () => {
    const r = normalizeReport({ tier: "B", token: { chain: "robinhood", address: "0x" } });
    expect(r.rawScore).toBeNull();
    expect(r.coveragePct).toBeNull();
  });
});

describe("cached answers carry a marker and stale ages that count from the fetch", () => {
  it("parses formatStaleAge labels", () => {
    expect(parseStaleAge("3h 20m")).toBe(200);
    expect(parseStaleAge("45m")).toBe(45);
    expect(parseStaleAge("2h")).toBe(120);
    expect(parseStaleAge("soon")).toBeNull();
  });
  it("ages every stale label by the time since generation", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { staleFields: { top10SharePct: 50 } }), [{ id: "geckoterminal", label: "GeckoTerminal", state: "stale", message: "stale (50m old) for 3 fields — HTTP 429" }]);
    const now = Date.parse(r.generatedAt) + 25 * MIN + 10_000;
    const { report, cache } = ageCachedReport(r, now);
    expect(cache).toEqual({ cached: true, generatedAt: r.generatedAt, ageSeconds: 25 * 60 + 10 });
    const f = byMetric(report, "top10SharePct");
    expect(f.stale).toBe("1h 15m");
    expect(f.evidence).toMatch(/\(stale, 1h 15m old\)$/);
    expect(report.token.staleFields.top10SharePct).toBe(75);
    expect(report.sourceStatus[0].message).toBe("stale (1h 15m old) for 3 fields — HTTP 429");
    // The input is not mutated.
    expect(byMetric(r, "top10SharePct").stale).toBe("50m");
  });
});

describe("stock token: refused, never scored", () => {
  it("a Robinhood '• Robinhood Token' name is not a meme even when HoodScan's roster misses it (ANT)", () => {
    const s = perfectLaunch("robinhood", { name: "Anthropic, PBC Class A Common Stock • Robinhood Token", symbol: "ANT", assetKind: "unknown" } as Partial<TokenSnapshot>);
    const e = eligibility(s);
    expect(e.meme).toBe(false);
    expect(e.rejected).toBe("stock token — HoodTier scores memecoins only");
    const sum = summarize({ ...scoreSnapshot(s), eligibility: e });
    expect(sum.tier).toBeNull();
    expect(sum.score).toBeNull();
  });
});

describe("C6 + M1: the tier hold never re-uses a value older than 6h, and holds only the same tier", () => {
  const base = fx.snapshot as unknown as TokenSnapshot;
  const sources = fx.sources as unknown as SourceStatus[];
  // Clean cluster check stubbed (Robinhood S blocked until funding is readable, 2026-11-24): the hold is under test.
  const flapping: TokenSnapshot = { ...base, buyers24h: base.sellers24h, buyerSellerRatio: 1, smartMoneyNetUsd: 0, walletClusterState: "live", walletClusterPending: false, walletClusterMeter: 5, clusterSupplyMinPct: 0, clusterSupplyText: "0.0%", founderClusterOnly: null, clusterResolvedWallets: 30, clusterSampleWallets: 30, clusterLargestText: "no linked group among 30 resolved wallets", clusterSameTimeText: "no two wallets funded by one source within 30s" };
  const R429 = "GeckoTerminal OHLCV failed: rate limited (HTTP 429)";
  const downSnap = (s: TokenSnapshot = flapping) => {
    const out = { ...s, bundlersFlushed: null, patterns: [], nullReasons: { ...s.nullReasons } } as unknown as Record<string, unknown>;
    for (const k of OHLCV_FIELDS) if (k !== "patterns") out[k] = null;
    (out.nullReasons as Record<string, string>).trendScore = R429;
    (out.nullReasons as Record<string, string>).launchPriceUsd = R429;
    return out as unknown as TokenSnapshot;
  };
  const score = (s: TokenSnapshot) => scoreSnapshot(s, sources);

  it("completeRunOf stores a stale value with its original fetch time", () => {
    const now = Date.now();
    const r = score({ ...flapping, staleFields: { trendScore: 300 } });
    expect(byMetric(r, "trendScore").status).toBe("stale");
    const run = completeRunOf(r, now);
    expect(run.fetchedAt!.trendScore).toBe(now - 300 * MIN);
    // 2h later the 5h-old value is 7h old: no longer usable, while values fetched live at `now` are.
    const usable = usableValues(run, now + 2 * H);
    expect(usable.trendScore).toBeUndefined();
    expect(Object.keys(usable).length).toBeGreaterThan(0);
  });

  it("no hold from a complete run whose down factor was stale-filled > 6h ago", () => {
    const now = Date.now();
    const prev = completeRunOf(score({ ...flapping, staleFields: { trendScore: 300, launchPriceUsd: 300 } }), now - 2 * H);
    const live = score(downSnap());
    expect(applyHold(live, downSnap(), sources, prev, now)).toBe(live);
  });

  it("re-score lands on a third tier ⇒ the re-score is shown, labelled, with its refilled values stale", () => {
    const now = Date.now();
    const clean = completeRunOf(score(flapping), now - 5 * MIN);
    // The previous complete run was B (other factors moved since); this run alone reads S, the re-score A.
    const prev: CompleteRun = { ...clean, tier: "B", score: 60 };
    const live = score(downSnap());
    expect(live.tier).toBe("S");
    const out = applyHold(live, downSnap(), sources, prev, now);
    expect(out.tier).toBe("A");
    expect(out.tier).not.toBe(prev.tier);
    expect(out.hold).toMatchObject({ liveTier: "S", rescored: true });
    expect(out.binding!.text).toMatch(/^re-scored \(source down\): .* ⇒ A; live S, 5m ago B$/);
    const trend = byMetric(out, "trendScore");
    expect(trend.status).toBe("stale");
    expect(trend.stale).toBe("5m");
    expect(summarize(out).held!.text).toBe("re-scored with last values (source down)");
  });

  it("re-score equal to the previous tier ⇒ the previous tier is held (unchanged)", () => {
    const now = Date.now();
    const prev = completeRunOf(score(flapping), now - 5 * MIN);
    const out = applyHold(score(downSnap()), downSnap(), sources, prev, now);
    expect(out.tier).toBe(prev.tier);
    expect(out.hold?.rescored).toBeUndefined();
  });
});
