import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bandMovingDisputes } from "@/components/disputeImpact";
import { band, CHECK_SEVERITY, disputeLook, factorSeverity, groupSeverity, ruleSeverity, SOURCE_SEVERITY, TIER_LOOK, worst } from "@/components/severity";
import { hitMetrics, mergedChecks, whyLines } from "@/components/verdict";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { FactorResult, Provenance, RuleResult, ScoreReport, SourceStatus, TokenSnapshot } from "@/lib/types";

// Round 3 replaces the round-1 severity rules (where staleness and source disputes coloured a factor):
// a factor's colour now means only how good it is. See REPORT.md §D.

const pv = (source: string, value: Provenance["value"]): Provenance => ({ source, label: source, value, fetchedAt: "2026-10-25T00:00:00Z", onchain: false });

const factor = (o: Partial<FactorResult>): FactorResult => ({
  id: "x",
  label: "X",
  metric: "x",
  points: 0,
  max: 10,
  value: 1,
  display: "1",
  evidence: "",
  flag: "none",
  missing: false,
  applicable: true,
  gate: false,
  source: "hoodtier",
  dataSources: [],
  status: "live",
  ...o,
});

const rule = (o: Partial<RuleResult>): RuleResult => ({ id: "r", label: "R", source: "guide", gate: false, state: "fired", points: 0, evidence: "", ...o });

const load = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures", `${name}.json`), "utf8")) as { snapshot: TokenSnapshot; sources: SourceStatus[] };
const report = (name: string) => {
  const { snapshot, sources } = load(name);
  return scoreSnapshot(snapshot, sources);
};

describe("rule 1 — a factor's colour means only how good it is", () => {
  it("bands points/max: ≥ 80% good, 40–80% ok, < 40% warn, 0 points bad", () => {
    expect(band(8, 10)).toBe("good");
    expect(band(7.99, 10)).toBe("ok");
    expect(band(4, 10)).toBe("ok");
    expect(band(3.99, 10)).toBe("warn");
    expect(band(0.01, 10)).toBe("warn");
    expect(band(0, 10)).toBe("bad");
    expect(band(5, 0)).toBeNull();
    expect(worst("good", "warn", null)).toBe("warn");
  });

  it("ignores staleness, flags and source disputes", () => {
    const base = factorSeverity(factor({ points: 9 }));
    expect(base).toBe("good");
    expect(factorSeverity(factor({ points: 9, status: "stale", stale: "12m" }))).toBe(base);
    expect(factorSeverity(factor({ points: 9, flag: "warn" }))).toBe(base);
    expect(factorSeverity(factor({ points: 9, verification: { status: "disputed", sources: 2, resolution: "", values: [pv("a", 100), pv("b", 1)] } }))).toBe(base);
  });

  it("is red when a fired gate / cap / penalty reads the factor's metric; grey with no data, n/a or a gate-only basic", () => {
    expect(factorSeverity(factor({ metric: "volMcRatio", points: 9 }), new Set(["volMcRatio"]))).toBe("bad");
    expect(factorSeverity(factor({ missing: true, status: "null" }))).toBeNull();
    expect(factorSeverity(factor({ applicable: false, status: "n/a" }))).toBeNull();
    expect(factorSeverity(factor({ basic: "pass", max: 0 }))).toBeNull();
  });

  it("colours a group bar by the group's own percentage", () => {
    expect(groupSeverity({ points: 9, max: 10, hasData: true })).toBe("good");
    expect(groupSeverity({ points: 5, max: 10, hasData: true })).toBe("ok");
    expect(groupSeverity({ points: 1, max: 10, hasData: true })).toBe("warn");
    expect(groupSeverity({ points: 0, max: 10, hasData: true })).toBe("bad");
    expect(groupSeverity({ points: 0, max: 10, hasData: false })).toBeNull();
  });

  it("shows a dispute as a grey ≠, orange only when it moves the band, never red", () => {
    expect(disputeLook(false)).toBe("muted");
    expect(disputeLook(true)).toBe("warn");
  });

  it("links fired gates / caps / penalties to the metrics they read (PEEK: dead launch, VOL/MC bundle)", () => {
    const hit = hitMetrics(report("peek"));
    expect(hit.size).toBeGreaterThan(0);
    expect([...hit].some((m) => /volMc/i.test(m))).toBe(true);
    // Only rules that fired and take something away count: with none, no factor is red for that reason.
    const md = report("microduck");
    const hurting = md.rules.filter((r) => r.state === "fired" && (r.gate || r.capTier || r.forceF || r.forceU || r.points > 0));
    if (!hurting.length) expect(hitMetrics(md).size).toBe(0);
    else expect(hitMetrics(md).size).toBeGreaterThan(0);
  });
});

describe("dispute that moves a factor's band (display-only re-score)", () => {
  const withDispute = (r: ScoreReport, alt: number): ScoreReport => {
    const values = [pv("onchain", r.token.top10SharePct), pv("hoodscan", alt)];
    const groups = r.groups.map((g) => ({ ...g, factors: g.factors.map((f) => (f.metric === "top10SharePct" ? { ...f, verification: { status: "disputed" as const, sources: 2, resolution: "", values } } : f)) }));
    return {
      ...r,
      groups,
      verification: { verified: 0, single: 0, disputed: 1, metrics: [{ metric: "top10SharePct", label: "Top-10", kind: "number", status: "disputed", values, chosen: r.token.top10SharePct, chosenSource: "onchain", resolution: "", wrongSources: [] }] },
    };
  };
  const top10 = (r: ScoreReport) => r.groups.flatMap((g) => g.factors).find((f) => f.metric === "top10SharePct")!.id;

  it("orange when another source's reading puts the row in another band", () => {
    const r = withDispute(report("microduck"), 70);
    expect(bandMovingDisputes(r).has(top10(r))).toBe(true);
  });

  it("grey when the other reading leaves the band where it is", () => {
    const base = report("microduck");
    const r = withDispute(base, base.token.top10SharePct! * 1.05);
    expect(bandMovingDisputes(r).has(top10(r))).toBe(false);
  });
});

describe("rule 2 — gates: one pill per check, basics merged in", () => {
  for (const name of ["microduck", "peek", "fartcoin", "offline", "pangea-honeypot"]) {
    it(`${name}: exactly one Sellable pill, no repeated label, fail wins`, () => {
      const r = report(name);
      const checks = mergedChecks(r);
      const labels = checks.map((c) => c.label.toLowerCase());
      expect(new Set(labels).size).toBe(labels.length);
      expect(checks.filter((c) => /sellable|honeypot/i.test(c.label))).toHaveLength(1);
      // Every gate-only basic is represented, inside its gate or on its own.
      const basics = r.groups.flatMap((g) => g.factors).filter((f) => f.basic);
      const evidence = checks.flatMap((c) => c.evidence);
      for (const b of basics) expect(evidence).toContain(b.evidence);
      // A failed basic or gate makes its check fail.
      for (const g of r.gates.filter((g) => g.state === "fail")) expect(checks.find((c) => c.id === g.id)?.state).toBe("fail");
    });
  }

  it("check colours: passed neon, unknown orange, failed red", () => {
    expect(CHECK_SEVERITY.pass).toBe("good");
    expect(CHECK_SEVERITY.unknown).toBe("warn");
    expect(CHECK_SEVERITY.fail).toBe("bad");
  });
});

describe("rule 2 — 'Why this tier': ≤ 3 positives then ≤ 2 holding it back, plain words", () => {
  const SOURCE_NAMES = /HoodScan|Helius|RugCheck|GeckoTerminal|DexScreener|Jupiter|ScanHood|Blockscout|source:|guide p\./i;
  for (const name of ["microduck", "peek", "fartcoin", "offline", "pangea-honeypot"]) {
    it(name, () => {
      const r = report(name);
      const lines = whyLines(r);
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(lines.filter((l) => l.kind === "positive").length).toBeLessThanOrEqual(3);
      expect(lines.filter((l) => l.kind === "holdback").length).toBeLessThanOrEqual(2);
      // Positives come first.
      const firstBack = lines.findIndex((l) => l.kind === "holdback");
      if (firstBack >= 0) expect(lines.slice(firstBack).every((l) => l.kind === "holdback")).toBe(true);
      for (const l of lines) {
        expect(l.text, l.text).not.toMatch(SOURCE_NAMES);
        expect(l.text).toMatch(/\.$|…$/);
      }
      // Red only when a gate / cap actually fired.
      const binding = r.rules.some((x) => x.state === "fired" && (x.gate || x.capTier || x.forceF || x.forceU));
      if (!binding) expect(lines.some((l) => l.sev === "bad")).toBe(false);
    });
  }

  it("an A-tier token has no red line and leads with three positives", () => {
    const r = report("microduck");
    expect(["A", "S"]).toContain(r.tier);
    const lines = whyLines(r);
    expect(lines.filter((l) => l.kind === "positive")).toHaveLength(3);
  });
});

describe("other surfaces keep the four-state scale", () => {
  it("rules, sources and tiers", () => {
    expect(ruleSeverity(rule({ gate: true }))).toBe("bad");
    expect(ruleSeverity(rule({ capTier: "D" }))).toBe("bad");
    expect(ruleSeverity(rule({ points: 5 }))).toBe("bad");
    expect(ruleSeverity(rule({ points: -2 }))).toBe("good");
    expect(ruleSeverity(rule({ flag: "warn" }))).toBe("warn");
    expect(SOURCE_SEVERITY.failed).toBe("bad");
    expect(SOURCE_SEVERITY.stale).toBe("warn");
    expect(TIER_LOOK.S).toBe("sev-good");
    expect(TIER_LOOK.F).toBe("sev-bad");
    expect(TIER_LOOK.U).toBe("sev-unrated");
  });
});
