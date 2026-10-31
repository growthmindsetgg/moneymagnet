import type {
  Chain,
  FactorResult,
  FlagLevel,
  GateResult,
  GroupResult,
  PenaltyResult,
  RequirementResult,
  RuleResult,
  ScoreReport,
  SourceStatus,
  Tier,
  TokenSnapshot,
} from "../types";
import { defaultConfig, modeFor, setFor, type FactorDef, type Format, type RatedTier, type ScoringConfig } from "./config";
import { isMissing, matchMetrics, matchRule, matchValue } from "./conditions";
import { formatValue } from "./format";
import { formatStaleAge } from "../stale";
import { summarizeVerification } from "../verify";
import { CHAIN_LABEL } from "../chain";

export interface Binding {
  kind: "coverage" | "gate" | "too-early" | "cap" | "requirement" | "score";
  text: string;
}

const TIER_ORDER: Tier[] = ["S", "A", "B", "C", "D", "F"];
const rank = (t: Tier) => TIER_ORDER.indexOf(t);
/** The lower (worse) of two rated tiers. */
const worse = (a: RatedTier, b: RatedTier): RatedTier => (rank(a) >= rank(b) ? a : b);

export const SOURCE_LABELS: Record<string, string> = {
  hoodscan: "HoodScan",
  scanhood: "ScanHood",
  "rh-sim": "HoodTier sell simulation",
  "hs-candles": "HoodScan swap candles",
  "rh-launch": "Robinhood launch signals",
  rpc: "Robinhood RPC",
  geckoterminal: "GeckoTerminal",
  dexscreener: "DexScreener",
  rugcheck: "RugCheck",
  helius: "Helius",
  pumpfeed: "pump.fun intel feed",
  "solana-rpc": "Solana RPC",
  jupiter: "Jupiter quote",
  history: "Liquidity history",
  metadata: "Token metadata",
  goplus: "GoPlus",
  nadfun: "nad.fun",
  "nadfun-chart": "nad.fun candles",
  "base-rpc": "Base RPC",
  "monad-rpc": "Monad RPC",
  "base-sim": "Base sell simulation",
  "monad-sim": "Monad sell simulation",
  basescan: "Basescan",
  "base-launch": "Base launch signals",
};

/** Which chain each source serves. A factor none of whose sources serves the chain is absent there. */
export const SOURCE_CHAINS: Record<string, Chain[]> = {
  hoodscan: ["robinhood"],
  scanhood: ["robinhood"],
  "rh-sim": ["robinhood"],
  "hs-candles": ["robinhood"],
  "rh-launch": ["robinhood"],
  rpc: ["robinhood"],
  rugcheck: ["solana"],
  helius: ["solana"],
  pumpfeed: ["solana"],
  "solana-rpc": ["solana"],
  jupiter: ["solana"],
  metadata: ["solana"],
  geckoterminal: ["robinhood", "solana", "base", "monad"],
  dexscreener: ["robinhood", "solana", "base", "monad"],
  history: ["robinhood", "solana", "base", "monad"],
  goplus: ["base", "monad"],
  nadfun: ["monad"],
  "nadfun-chart": ["monad"],
  "base-rpc": ["base"],
  "monad-rpc": ["monad"],
  "base-sim": ["base"],
  "monad-sim": ["monad"],
  basescan: ["base"],
  "base-launch": ["base"],
};

/** Absent, not null: factors restricted to another chain, or fed only by other chains' sources. */
function presentOn(f: FactorDef, chain: Chain): boolean {
  if (f.chains && !f.chains.includes(chain)) return false;
  if (!f.data.length) return true;
  return f.data.some((d) => (SOURCE_CHAINS[d] ?? ["robinhood", "solana"]).includes(chain));
}

type Snap = Record<string, unknown>;

export function metricFormats(cfg: ScoringConfig): Record<string, Format> {
  const map: Record<string, Format> = { volMcRatio: "ratio", volMcBar: "ratio", lpLockedPct: "pct", top1SharePct: "pct", ageHours: "age", curveCirculatingPct: "pct", sellers24h: "int", uniqueBuyers: "int", ageMinutes: "num", launchBuyers: "int", liquidityUsd: "usdAbs", fdvUsd: "usdAbs", deployerDistributedPct: "pct", lastTradeHoursAgo: "age" };
  for (const set of Object.values(cfg.sets)) for (const g of set.groups) for (const f of g.factors) map[f.metric] = f.format;
  return map;
}

/** Replaces {key} placeholders; {value}/{note} come from `vars`, anything else from the snapshot. */
export function fill(template: string, snapshot: TokenSnapshot, formats: Record<string, Format>, vars: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (key in vars) return vars[key];
    const v = (snapshot as unknown as Snap)[key];
    return formatValue(v, formats[key] ?? "num");
  });
}

/** Why a factor has no value, as precisely as the adapters let us say. */
function nullReasonFor(f: FactorDef, s: TokenSnapshot, sources: SourceStatus[]): string {
  const explicit = s.nullReasons?.[f.metric as string];
  if (explicit) return explicit;
  if (!f.data.length) return "no data source exists for this metric";
  const ran = f.data.map((id) => sources.find((x) => x.id === id)).filter((x): x is SourceStatus => !!x);
  const chainName = CHAIN_LABEL[s.chain];
  if (!ran.length) {
    if (f.data.includes("history")) return "liquidity history not recorded yet";
    return `no ${chainName} source provides this (${f.data.map((d) => SOURCE_LABELS[d] ?? d).join(", ")} not used on this chain)`;
  }
  const down = ran.filter((x) => x.state === "failed" || x.state === "skipped");
  if (down.length === ran.length) {
    return down.map((x) => (x.state === "skipped" ? (x.message ?? `${x.label} skipped`) : `${x.label} failed: ${x.message ?? "error"}`)).join("; ");
  }
  return `not provided by ${ran.map((x) => x.label).join(" / ")} for this token`;
}

function scoreFactor(f: FactorDef, s: TokenSnapshot, formats: Record<string, Format>, sources: SourceStatus[], zeroMetrics: Set<string> = new Set()): FactorResult {
  if (!f.gateOnly) return scoreWeighted(f, s, formats, sources, zeroMetrics);
  // Basics are gates, not points: same value and evidence, 0 points, no effect on coverage.
  const r = scoreWeighted({ ...f, weight: 1 }, s, formats, sources, zeroMetrics);
  if (r.status === "n/a") return { ...r, max: 0 };
  const basic = r.status === "null" ? "unknown" : r.points >= 1 ? "pass" : r.points > 0 ? "partial" : "fail";
  return { ...r, max: 0, points: 0, applicable: false, missing: false, basic, evidence: `${r.evidence} Gate only — no points.` };
}

function scoreWeighted(f: FactorDef, s: TokenSnapshot, formats: Record<string, Format>, sources: SourceStatus[], zeroMetrics: Set<string> = new Set()): FactorResult {
  const raw = (s as unknown as Snap)[f.metric];
  const value = isMissing(raw) ? null : (raw as number | boolean);
  const display = value === null ? "no data" : (f.labels?.[String(value)] ?? formatValue(value, f.format));
  const base = {
    id: f.id,
    label: f.label,
    metric: f.metric as string,
    max: f.weight,
    value,
    display,
    gate: !!f.gate,
    source: f.source,
    note: f.note,
    dataSources: f.data.map((d) => SOURCE_LABELS[d] ?? d),
  };
  const na = (evidence: string): FactorResult => ({ ...base, points: 0, evidence, flag: "none", missing: false, applicable: false, status: "n/a" });

  if (f.weight === 0) return na(f.disabledReason ?? "Disabled (weight 0).");
  // Zero is data: genuinely no activity ⇒ value 0, minimum points, live (counts as covered).
  if (s.zeroActivity?.length && zeroMetrics.has(f.metric as string) && (value === null || value === 0)) {
    const min = Math.min(...f.thresholds.map((t) => t.points));
    return {
      ...base,
      value: 0,
      display: "0 — no activity",
      points: min * f.weight,
      evidence: `no activity — ${s.zeroActivity.join("; ")}`,
      flag: "warn",
      missing: false,
      applicable: true,
      status: "live",
    };
  }
  if (f.chains && !f.chains.includes(s.chain)) return na(`Not applicable on ${CHAIN_LABEL[s.chain]}.`);

  if (value === null) {
    const reason = nullReasonFor(f, s, sources);
    for (const rule of f.whenMissing ?? []) {
      if (rule.if && matchMetrics(s, rule.if) !== "pass") continue;
      const evidence = fill(rule.evidence, s, formats);
      if (rule.mode === "na") return na(evidence);
      if (rule.mode === "score") {
        return { ...base, points: (rule.points ?? 0) * f.weight, evidence, flag: rule.flag ?? "info", missing: false, applicable: true, status: "live" };
      }
      return { ...base, points: 0, evidence, flag: rule.flag ?? "none", missing: true, applicable: true, status: "null", nullReason: reason };
    }
    return {
      ...base,
      points: 0,
      evidence: "No data — excluded from the score (neutral).",
      flag: "none",
      missing: true,
      applicable: true,
      status: "null",
      nullReason: reason,
    };
  }

  if (f.minSample) {
    const n = (s as unknown as Snap)[f.minSample.metric as string];
    if (typeof n !== "number" || n < f.minSample.gte) {
      const have = typeof n === "number" ? `${n} ${f.minSample.label}` : `${f.minSample.label} unknown`;
      return { ...base, points: 0, evidence: `insufficient sample — ${have} (needs ≥ ${f.minSample.gte}); ${display} not scored, 0 points.`, flag: "info", missing: false, applicable: true, status: "live" };
    }
  }
  const t = f.thresholds.find((th) => matchValue(value, th)) ?? { points: 0, flag: "warn" as FlagLevel };
  const result: FactorResult = {
    ...base,
    points: Math.round(t.points * f.weight * 100) / 100,
    evidence: fill(f.evidenceTemplate, s, formats, { value: display, note: t.note ? fill(t.note, s, formats) : "" }),
    flag: t.flag ?? "none",
    missing: false,
    applicable: true,
    status: "live",
  };
  const age = s.staleFields?.[f.metric as string];
  if (age != null) {
    const label = formatStaleAge(age);
    return { ...result, status: "stale", stale: label, evidence: `${result.evidence} (stale, ${label} old)` };
  }
  return result;
}

function tierFor(score: number, cfg: ScoringConfig): RatedTier {
  for (const t of cfg.tiers) if (score >= t.min) return t.tier;
  return "F";
}

/** Highest displayable score for a tier: just below the next band up. */
export function tierCeiling(tier: RatedTier, cfg: ScoringConfig = defaultConfig): number {
  const sorted = [...cfg.tiers].sort((a, b) => b.min - a.min);
  const i = sorted.findIndex((t) => t.tier === tier);
  return i <= 0 ? 100 : Math.round((sorted[i - 1].min - 0.1) * 10) / 10;
}

const describe = (f: FactorResult) =>
  typeof f.value === "boolean" ? f.evidence.replace(/ \(stale.*\)$/, "").replace(/\.$/, "").toLowerCase() : `${f.label.toLowerCase()} ${f.display}`;

function buildVerdict(tier: Tier, groups: GroupResult[], fired: RuleResult[], forcedF: RuleResult[]): string {
  const early = fired.find((r) => r.forceU && r.overridesGates) ?? fired.find((r) => r.forceU);
  if (tier === "U" && early && (!forcedF.length || early.overridesGates)) return `Unrated — ${early.evidence.replace(/.$/, "")}.`;
  if (tier === "U") return "Unrated — too little live data to place this token in S–F. See the sources below for what failed.";
  if (forcedF.length) return `${forcedF.map((r) => r.label).join(", ")} — avoid.`;
  const factors = groups.flatMap((g) => g.factors).filter((f) => f.applicable && !f.missing && f.max > 0);
  const strengths = factors
    .filter((f) => f.points / f.max >= 0.99 && f.flag === "none")
    .sort((a, b) => b.max - a.max)
    .slice(0, 2)
    .map(describe);
  const weak = factors
    .filter((f) => f.flag === "warn" || f.flag === "danger")
    .sort((a, b) => b.max - b.points - (a.max - a.points))
    .slice(0, 1)
    .map(describe);
  const lead: Record<Tier, string> = {
    S: "Early-runner pattern with every basic issue cleared",
    A: "Strong setup",
    B: "Solid but not clean",
    C: "Mixed signals",
    D: "Weak",
    F: "Fails basic checks",
    U: "Unrated",
  };
  let out = lead[tier];
  if (strengths.length) out += ` — ${strengths.join(", ")}`;
  const risk = fired.find((r) => r.capTier || r.points)?.label.toLowerCase() ?? weak[0];
  if (risk) out += `; main risk: ${risk}`;
  return out + ".";
}

export function scoreSnapshot(s: TokenSnapshot, sourceStatus: SourceStatus[] = [], cfg: ScoringConfig = defaultConfig): ScoreReport {
  const formats = metricFormats(cfg);
  const mode = modeFor(s.ageHours, cfg);
  const set = setFor(cfg, mode, s.chain);

  // Cross-source verification of each factor's metric (the snapshot already carries the chosen values).
  const verification = summarizeVerification(s.provenance);
  const byMetric = new Map(verification.metrics.map((m) => [m.metric, m]));

  const zeroMetrics = new Set(cfg.zeroActivity?.metrics ?? []);
  const groups: GroupResult[] = set.groups.map((g) => {
    const factors = g.factors.filter((f) => presentOn(f, s.chain)).map((f) => {
      const r = scoreFactor(f, s, formats, sourceStatus, zeroMetrics);
      const v = byMetric.get(f.metric);
      return v ? { ...r, verification: { status: v.status, sources: v.values.length, resolution: v.resolution, values: v.values } } : r;
    });
    const scored = factors.filter((f) => f.applicable && !f.missing);
    const available = scored.reduce((a, f) => a + f.max, 0);
    const points = scored.reduce((a, f) => a + f.points, 0);
    return { id: g.id, label: g.label, weight: g.weight, points: Math.round(points * 100) / 100, max: Math.round(available * 100) / 100, available, factors, hasData: scored.length > 0 };
  });

  // Weighted sum, renormalized over the weight with data: a missing factor neither adds nor subtracts.
  let weighted = 0;
  let weightWithData = 0;
  let applicableWeight = 0;
  let availableWeight = 0;
  for (const g of groups) {
    applicableWeight += g.factors.filter((f) => f.applicable).reduce((a, f) => a + f.max, 0);
    availableWeight += g.available;
    if (g.available > 0) {
      weighted += g.weight * (g.points / g.available);
      weightWithData += g.weight;
    }
  }
  const rawScore = weightWithData > 0 ? Math.round((weighted / weightWithData) * 1000) / 10 : 0;
  const coveragePct = applicableWeight > 0 ? Math.round((availableWeight / applicableWeight) * 100) : 0;
  // U only when ≥ 40% of the weight is null because a source FAILED (or was not configured).
  // Fields a source simply does not provide lower coverage (and cap the tier) but never unrate.
  const down = new Map(sourceStatus.filter((x) => x.state === "failed" || x.state === "skipped").map((x) => [x.id, x]));
  let failedNullWeight = 0;
  const failedSources = new Set<string>();
  for (const g of groups) {
    for (const f of g.factors) {
      if (!f.applicable || !f.missing) continue;
      const def = set.groups.find((x) => x.id === g.id)!.factors.find((x) => x.id === f.id)!;
      const failed = def.data.filter((d) => down.has(d));
      if (!failed.length) continue;
      failedNullWeight += f.max;
      for (const d of failed) failedSources.add(down.get(d)!.label + (down.get(d)!.state === "skipped" ? ` (${down.get(d)!.message ?? "skipped"})` : ""));
    }
  }
  const failedNullPct = applicableWeight > 0 ? Math.round((failedNullWeight / applicableWeight) * 100) : 0;

  // Rules: gates, caps and penalties.
  const rules: RuleResult[] = cfg.rules
    .filter((r) => !r.sets || r.sets.includes(mode))
    .map((r) => {
      const chainsOk = !r.chains || r.chains.includes(s.chain);
      const state = !chainsOk ? "clear" : ({ pass: "fired", fail: "clear", unknown: "unknown" } as const)[matchRule(s, r)];
      return {
        id: r.id,
        label: r.label,
        source: r.source,
        note: r.note,
        gate: !!r.gate,
        state,
        points: state === "fired" ? (r.points ?? 0) : 0,
        capTier: r.capTier,
        forceF: r.forceF,
        forceU: r.forceU,
        overridesGates: r.overridesGates,
        flag: r.flag,
        evidence: state === "fired" ? fill(r.evidenceTemplate, s, formats) : state === "unknown" ? "Not evaluable — an input is missing." : chainsOk ? "Clear." : "Not applicable on this chain.",
      };
    });
  const fired = rules.filter((r) => r.state === "fired");
  const forced = fired.filter((r) => r.forceF);
  const tooEarly = fired.filter((r) => r.forceU);
  // Positive points are penalties; negative points are bonuses (track record, Time Machine) — listed apart.
  const adjustments: PenaltyResult[] = fired.filter((r) => r.points !== 0).map((r) => ({ id: r.id, label: r.label, points: r.points, evidence: r.evidence }));
  const gates: GateResult[] = rules
    .filter((r) => r.gate)
    .map((r) => {
      const def = cfg.rules.find((x) => x.id === r.id);
      const na = def?.chains && !def.chains.includes(s.chain);
      const state = na ? ("n/a" as const) : r.state === "fired" ? ("fail" as const) : r.state === "clear" ? ("pass" as const) : ("unknown" as const);
      return {
        id: r.id,
        label: state === "pass" && def?.passLabel ? def.passLabel : r.label,
        state: na ? ("n/a" as const) : r.state === "fired" ? ("fail" as const) : r.state === "clear" ? ("pass" as const) : ("unknown" as const),
        evidence: r.evidence,
      };
    });

  const requirements: RequirementResult[] = cfg.requirements.flatMap((r) =>
    r.tiers.map((tier) => {
      const res = matchRule(s, r);
      const state = res === "unknown" && r.allowMissing ? "pass" : res;
      const metrics = [...Object.keys(r.when ?? {}), ...(r.anyOf ?? []).flatMap((c) => Object.keys(c))];
      return {
        id: `${r.id}:${tier}`,
        label: r.label,
        tier,
        state,
        evidence:
          res === "unknown"
            ? r.allowMissing
              ? "No data — not held against the token."
              : "No data — cannot be proven."
            : metrics.map((m) => `${m} = ${formatValue((s as unknown as Snap)[m], formats[m] ?? "num")}`).join(", "),
      };
    }),
  );

  const reasons: string[] = [];
  let tier: Tier;
  let score: number | null;
  const penalties = adjustments.filter((p) => p.points > 0);
  const bonuses = adjustments.filter((p) => p.points < 0).map((p) => ({ ...p, points: -p.points }));
  const penaltyTotal = adjustments.reduce((a, p) => a + p.points, 0);
  const afterPenalties = Math.max(0, Math.min(100, Math.round((rawScore - penaltyTotal) * 10) / 10));

  // The single constraint that decided the tier (shown as "Why this tier").
  let binding: Binding;
  if (failedNullPct >= cfg.coverage.unratedBelowPct) {
    tier = "U";
    score = null;
    const names = [...failedSources].join(", ");
    reasons.push(`${failedNullPct}% of factor weight is missing because sources failed: ${names} — Unrated.`);
    binding = { kind: "coverage", text: `sources failed: ${names} (${failedNullPct}% of weight) ⇒ U` };
  } else if (tooEarly.some((r) => r.overridesGates)) {
    const r = tooEarly.find((x) => x.overridesGates)!;
    tier = "U";
    score = null;
    reasons.push(`${r.evidence} — Unrated (applies before gates).`);
    binding = { kind: "too-early", text: `${r.evidence} ⇒ U` };
  } else if (forced.length) {
    tier = "F";
    score = 0;
    reasons.push(`${forced.map((r) => r.label).join(", ")} forces tier F.`);
    binding = { kind: "gate", text: `gate: ${forced[0].label} ⇒ F` };
  } else if (tooEarly.length) {
    tier = "U";
    score = null;
    reasons.push(`${tooEarly.map((r) => r.evidence).join(" ")} — Unrated.`);
    binding = { kind: "too-early", text: `${tooEarly[0].evidence} ⇒ U` };
  } else {
    let t: RatedTier = tierFor(afterPenalties, cfg);
    binding = { kind: "score", text: `score ${afterPenalties} ⇒ ${t} (no cap binds)` };
    reasons.push(`Score ${afterPenalties}${penaltyTotal ? ` (raw ${rawScore} ${penaltyTotal > 0 ? "−" : "+"} ${Math.abs(penaltyTotal)} ${penaltyTotal > 0 ? "penalties" : "bonus"})` : ""} maps to ${t}.`);
    for (const r of fired.filter((x) => x.capTier)) {
      if (worse(t, r.capTier as RatedTier) !== t) {
        t = r.capTier as RatedTier;
        reasons.push(`${r.label} caps the tier at ${r.capTier}.`);
        binding = { kind: "cap", text: `cap: ${r.label} ⇒ ${r.capTier}` };
      }
    }
    if (coveragePct < cfg.coverage.capBBelowPct && worse(t, "B") !== t) {
      t = "B";
      reasons.push(`Only ${coveragePct}% of factor weight has data (< ${cfg.coverage.capBBelowPct}%) — capped at B.`);
      binding = { kind: "coverage", text: `coverage ${coveragePct}% < ${cfg.coverage.capBBelowPct}% ⇒ cap B` };
    }
    if ((t === "S" || t === "A") && coveragePct < cfg.coverage.topTierMinPct) {
      reasons.push(`S/A need ≥ ${cfg.coverage.topTierMinPct}% data coverage (have ${coveragePct}%) — capped at B.`);
      t = "B";
      binding = { kind: "coverage", text: `coverage ${coveragePct}% < ${cfg.coverage.topTierMinPct}% needed for S/A ⇒ B` };
    }
    if (t === "S") {
      const miss = requirements.filter((r) => r.tier === "S" && r.state !== "pass");
      if (miss.length) {
        t = "A";
        reasons.push(`S needs: ${miss.map((r) => r.label).join("; ")} — downgraded to A.`);
        binding = { kind: "requirement", text: `S requirement not met: ${miss[0].label} ⇒ A` };
      }
    }
    if (t === "A") {
      const miss = requirements.filter((r) => r.tier === "A" && r.state !== "pass");
      if (miss.length) {
        t = "B";
        reasons.push(`A needs: ${miss.map((r) => r.label).join("; ")} — downgraded to B.`);
        binding = { kind: "requirement", text: `A requirement not met: ${miss[0].label} ⇒ B` };
      }
    }
    tier = t;
    // Keep tier and number monotone: a capped token shows at most the top of its band.
    const ceiling = tierCeiling(t, cfg);
    score = Math.min(afterPenalties, ceiling);
    if (score < afterPenalties) reasons.push(`Displayed score clamped to ${score} (top of ${t}).`);
  }

  return {
    chain: s.chain,
    address: s.address,
    tier,
    score,
    rawScore,
    coveragePct,
    mode,
    modeLabel: s.ageHours == null ? `${set.label} (age unknown)` : set.label,
    verdict: buildVerdict(tier, groups, fired, forced),
    tierReason: reasons.join(" "),
    binding,
    penalties,
    bonuses,
    gates,
    rules,
    requirements,
    groups,
    manualChecks: cfg.manualChecks,
    fakeSignals: s.fakeSignals,
    sourceStatus,
    verification,
    token: s,
    generatedAt: new Date().toISOString(),
  };
}
