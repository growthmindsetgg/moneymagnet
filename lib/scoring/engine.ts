import type {
  Chain,
  FactorResult,
  FlagLevel,
  GateResult,
  GroupResult,
  PenaltyResult,
  PreviousTier,
  RequirementResult,
  RuleResult,
  ScoreReport,
  SourceStatus,
  Tier,
  TierHysteresis,
  TokenSnapshot,
} from "../types";
import { defaultConfig, modeFor, setFor, type FactorDef, type Format, type RatedTier, type ScoringConfig } from "./config";
import { isMissing, matchMetrics, matchRule, matchValue } from "./conditions";
import { formatValue } from "./format";
import { formatStaleAge } from "../stale";
import { summarizeVerification } from "../verify";
import { CHAIN_LABEL } from "../chain";

export interface Binding {
  kind: "coverage" | "gate" | "too-early" | "cap" | "requirement" | "score" | "hysteresis";
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
  "ethereum-rpc": "Ethereum RPC",
  "ethereum-sim": "Ethereum sell simulation",
  etherscan: "Etherscan",
  cohort: "Peer cohort (GeckoTerminal)",
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
  geckoterminal: ["robinhood", "solana", "base", "monad", "ethereum"],
  dexscreener: ["robinhood", "solana", "base", "monad", "ethereum"],
  history: ["robinhood", "solana", "base", "monad", "ethereum"],
  goplus: ["base", "monad", "ethereum"],
  nadfun: ["monad"],
  "nadfun-chart": ["monad"],
  "base-rpc": ["base"],
  "monad-rpc": ["monad"],
  "base-sim": ["base"],
  "monad-sim": ["monad"],
  basescan: ["base"],
  "base-launch": ["base"],
  "ethereum-rpc": ["ethereum"],
  "ethereum-sim": ["ethereum"],
  etherscan: ["ethereum"],
  cohort: ["robinhood", "solana", "base", "monad", "ethereum"],
};

/** Absent, not null: factors restricted to another chain, or fed only by other chains' sources. */
function presentOn(f: FactorDef, chain: Chain): boolean {
  if (f.chains && !f.chains.includes(chain)) return false;
  if (!f.data.length) return true;
  return f.data.some((d) => (SOURCE_CHAINS[d] ?? ["robinhood", "solana"]).includes(chain));
}

type Snap = Record<string, unknown>;

export function metricFormats(cfg: ScoringConfig): Record<string, Format> {
  const map: Record<string, Format> = { volMcRatio: "ratio", volume24hUsd: "usdAbs", volMcBar: "ratio", lpLockedPct: "pct", top1SharePct: "pct", ageHours: "age", curveCirculatingPct: "pct", sellers24h: "int", uniqueBuyers: "int", ageMinutes: "num", launchBuyers: "int", liquidityUsd: "usdAbs", fdvUsd: "usdAbs", deployerDistributedPct: "pct", lastTradeHoursAgo: "age", top10SharePct: "pct", equalSplitPct: "pct", equalSplitCount: "int", roundTripLossPct: "pct", priceChange24hPct: "signedPct" };
  for (const [k, v] of Object.entries(cfg.metricFormats ?? {})) if (k !== "note") map[k] = v as Format;
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

/** The factor as scored for this snapshot: its `override` metric and evidence when the override's flag is true. */
function effectiveFactor(f: FactorDef, s: TokenSnapshot): FactorDef {
  const o = f.override;
  return o && (s as unknown as Snap)[o.when as string] === true ? { ...f, metric: o.metric, evidenceTemplate: o.evidenceTemplate } : f;
}

function scoreWeighted(f0: FactorDef, s: TokenSnapshot, formats: Record<string, Format>, sources: SourceStatus[], zeroMetrics: Set<string> = new Set()): FactorResult {
  const f = effectiveFactor(f0, s);
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
  const nul = (evidence: string, nullReason: string, flag: FlagLevel = "none"): FactorResult => ({ ...base, points: 0, evidence, flag, missing: true, applicable: true, status: "null", nullReason });
  // M3: every non-null result read from a stale snapshot carries the stale label, whichever path scored it.
  const withStale = (r: FactorResult, metrics: string[] = [f.metric as string]): FactorResult => {
    const ages = metrics.map((m) => s.staleFields?.[m]).filter((a): a is number => a != null);
    if (!ages.length) return r;
    const label = formatStaleAge(Math.max(...ages));
    return { ...r, status: "stale", stale: label, evidence: `${r.evidence} (stale, ${label} old)` };
  };

  if (f.weight === 0) return na(f.disabledReason ?? "Disabled (weight 0).");
  // Zero is data: genuinely no activity ⇒ value 0, minimum points, live (counts as covered).
  if (s.zeroActivity?.length && zeroMetrics.has(f.metric as string) && (value === null || value === 0)) {
    const min = Math.min(...f.thresholds.map((t) => t.points));
    return withStale({
      ...base,
      value: 0,
      display: "0 — no activity",
      points: min * f.weight,
      evidence: `no activity — ${s.zeroActivity.join("; ")}`,
      flag: "warn",
      missing: false,
      applicable: true,
      status: "live",
    });
  }
  if (f.chains && !f.chains.includes(s.chain)) return na(`Not applicable on ${CHAIN_LABEL[s.chain]}.`);

  if (value === null) {
    const reason = nullReasonFor(f, s, sources);
    for (const rule of f.whenMissing ?? []) {
      if (rule.if && matchMetrics(s, rule.if) !== "pass") continue;
      const evidence = fill(rule.evidence, s, formats);
      if (rule.mode === "na") return na(evidence);
      if (rule.mode === "score") {
        // Scored from the metrics the rule reads: stale if any of them is.
        return withStale({ ...base, points: (rule.points ?? 0) * f.weight, evidence, flag: rule.flag ?? "info", missing: false, applicable: true, status: "live" }, Object.keys(rule.if ?? {}));
      }
      return nul(evidence, reason, rule.flag ?? "none");
    }
    return nul("No data — excluded from the score (neutral).", reason);
  }

  if (f.minSample) {
    const n = (s as unknown as Snap)[f.minSample.metric as string];
    // H2: too small a sample is not a reading. A known sample below the bar makes the factor not applicable
    // yet; an unknown sample size leaves it missing with that reason. Neither counts in the available weight.
    if (typeof n !== "number") {
      const why = s.nullReasons?.[f.minSample.metric as string];
      const reason = `${f.minSample.label} unknown${why ? ` (${why})` : ""} — needs ≥ ${f.minSample.gte} to score ${display}`;
      return nul(`insufficient sample — ${reason}; not scored.`, reason);
    }
    if (n < f.minSample.gte) return na(`insufficient sample — ${n} ${f.minSample.label} (needs ≥ ${f.minSample.gte}); ${display} not scored.`);
  }
  // A fixed reference picked by another metric's band: the thresholds read metric ÷ reference.
  let scored: number | boolean = value;
  let shown = display;
  let refVars: Record<string, string> = {};
  const staleMetrics = [f.metric as string];
  if (f.reference && typeof value === "number") {
    const ref = f.reference;
    const by = (s as unknown as Snap)[ref.metric as string];
    if (isMissing(by)) {
      const why = s.nullReasons?.[ref.metric as string];
      const reason = `${ref.label} unknown${why ? ` (${why})` : ""} — needed to pick the reference band`;
      return nul(`${reason}; ${display} not scored.`, reason);
    }
    const band = ref.bands.find((b) => matchValue(by, b));
    if (!band) {
      const reason = `config gap: no reference band in factors.json covers ${ref.label} ${formatValue(by, formats[ref.metric as string] ?? "num")}`;
      return nul(`${reason} — not scored.`, reason, "info");
    }
    scored = value / band.value;
    refVars = {
      reference: formatValue(band.value, f.format),
      band: band.label,
      ratio: formatValue(scored, "ratio"),
    };
    shown = `${display} (${refVars.ratio} ref)`;
    staleMetrics.push(ref.metric as string);
  }
  const t = f.thresholds.find((th) => matchValue(scored, th));
  // L7: a value no threshold covers is a config gap, not a measured worst score.
  if (!t) {
    const reason = `config gap: no threshold in factors.json covers ${shown}`;
    return nul(`${reason} — not scored.`, reason, "info");
  }
  return withStale(
    {
      ...base,
      display: shown,
      points: Math.round(t.points * f.weight * 100) / 100,
      evidence: fill(f.evidenceTemplate, s, formats, { ...refVars, value: display, note: t.note ? fill(t.note, s, formats) : "" }),
      flag: t.flag ?? "none",
      missing: false,
      applicable: true,
      status: "live",
    },
    staleMetrics,
  );
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

/** Lower-cases Title-case words only, so acronyms, tickers and timestamps keep their case ("VOL/MC", "LP", "14:53Z"). */
export const lowerFirst = (t: string) => t.replace(/\b[A-Z][a-z]+\b/g, (w) => w.toLowerCase());

/** One short clause for the verdict: a boolean factor's first evidence sentence (no stale note, sample detail or trailing dot). */
export const describe = (f: FactorResult) => {
  if (typeof f.value !== "boolean") return `${lowerFirst(f.label)} ${f.display}`;
  const clause = f.evidence
    .replace(/ \(stale, [^)]*\)$/, "")
    .split(/\.(?:\s|$)| \(/)[0]
    .trim();
  return lowerFirst(clause);
};

function buildVerdict(tier: Tier, groups: GroupResult[], fired: RuleResult[], forcedF: RuleResult[], bindingCap: RuleResult | null = null): string {
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
  // Main risk: the cap that decided the tier, else the largest penalty, else the worst other cap.
  // Bonuses (negative points) and 0-point rules are never a risk; config order never decides.
  const penalties = fired.filter((r) => r.points > 0 && r !== bindingCap).sort((a, b) => b.points - a.points);
  const caps = fired.filter((r) => r.capTier && r !== bindingCap).sort((a, b) => rank(b.capTier as Tier) - rank(a.capTier as Tier) || b.points - a.points);
  const top = bindingCap ?? penalties[0] ?? caps[0];
  const risk = top ? lowerFirst(top.label) : weak[0];
  if (risk) out += `; main risk: ${risk}`;
  return out + ".";
}

/** Lowest score of a tier's band. */
export function tierFloor(tier: RatedTier, cfg: ScoringConfig = defaultConfig): number {
  return cfg.tiers.find((t) => t.tier === tier)?.min ?? 0;
}

const RATED_ORDER: RatedTier[] = ["S", "A", "B", "C", "D", "F"];

/**
 * Hysteresis on the score → band step. Holds the previous tier when it was placed by the bands (not a gate,
 * cap, requirement or outage hold), in the same mode, recently, in an adjacent tier, and the score is within
 * the margin of the line between the two. Returns null when it does not apply.
 */
export function hysteresisHold(
  score: number,
  liveTier: RatedTier,
  mode: string,
  prev: PreviousTier | null | undefined,
  now: number,
  cfg: ScoringConfig = defaultConfig,
): TierHysteresis | null {
  const h = cfg.hysteresis;
  if (!h || !prev || prev.tier === liveTier || prev.mode !== mode) return null;
  if (prev.bindingKind !== "score" && prev.bindingKind !== "hysteresis") return null;
  const p = RATED_ORDER.indexOf(prev.tier as RatedTier);
  const l = RATED_ORDER.indexOf(liveTier);
  if (p < 0 || Math.abs(p - l) !== 1) return null;
  const at = Date.parse(prev.at);
  if (!Number.isFinite(at) || now < at || now - at > h.maxAgeHours * 3_600_000) return null;
  const line = tierFloor(RATED_ORDER[Math.min(p, l)], cfg);
  if (Math.abs(score - line) >= h.margin) return null;
  return { liveTier, line, margin: h.margin, since: new Date(at).toISOString(), minutesAgo: Math.round((now - at) / 60_000) };
}

export interface ScoreOptions {
  /** The token's previous analysis (score_history), for hysteresis. */
  previous?: PreviousTier | null;
  now?: number;
}

export function scoreSnapshot(s: TokenSnapshot, sourceStatus: SourceStatus[] = [], cfg: ScoringConfig = defaultConfig, opts: ScoreOptions = {}): ScoreReport {
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
      const v = byMetric.get(effectiveFactor(f, s).metric);
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
  // (Audit M4 proposed counting a factor only when every listed source failed; rejected: a factor whose
  // providing source failed is missing because of that failure even when another listed source answered.)
  const down = new Map(sourceStatus.filter((x) => x.state === "failed" || x.state === "skipped").map((x) => [x.id, x]));
  let failedNullWeight = 0;
  const failedSources = new Set<string>();
  const skippedSources = new Set<string>();
  for (const g of groups) {
    for (const f of g.factors) {
      if (!f.applicable || !f.missing) continue;
      const def = set.groups.find((x) => x.id === g.id)!.factors.find((x) => x.id === f.id)!;
      const failed = def.data.filter((d) => down.has(d)).map((d) => down.get(d)!);
      if (!failed.length) continue;
      failedNullWeight += f.max;
      for (const x of failed) {
        if (x.state === "skipped") skippedSources.add(`${x.label} (${x.message ?? "skipped"})`);
        else failedSources.add(x.label);
      }
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
  let hysteresis: TierHysteresis | null = null;
  let bindingCap: RuleResult | null = null;
  if (failedNullPct >= cfg.coverage.unratedBelowPct) {
    tier = "U";
    score = null;
    const names = [failedSources.size ? `failed: ${[...failedSources].join(", ")}` : "", skippedSources.size ? `not configured: ${[...skippedSources].join(", ")}` : ""].filter(Boolean).join("; ");
    reasons.push(`${failedNullPct}% of factor weight is missing because sources ${names} — Unrated.`);
    binding = { kind: "coverage", text: `sources ${names} (${failedNullPct}% of weight) ⇒ U` };
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
    // Penalties / bonuses move the score without a cap: name them, so "raw N" beside the score is explained.
    const adjusted = penaltyTotal ? ` (raw ${rawScore} ${penaltyTotal > 0 ? "−" : "+"} ${Math.abs(penaltyTotal)} ${penaltyTotal > 0 ? "penalties" : "bonus"})` : "";
    binding = { kind: "score", text: `score ${afterPenalties}${adjusted} ⇒ ${t} (no cap binds)` };
    // The reason lists penalties and bonuses apart, so its numbers match the per-rule points shown
    // (the binding above keeps the net figure: penalties minus bonuses).
    const penaltySum = Math.round(penalties.reduce((a, p) => a + p.points, 0) * 100) / 100;
    const bonusSum = Math.round(bonuses.reduce((a, p) => a + p.points, 0) * 100) / 100;
    const parts = [penaltySum ? `− ${penaltySum} penalties` : "", bonusSum ? `+ ${bonusSum} bonus` : ""].filter(Boolean).join(" ");
    reasons.push(`Score ${afterPenalties}${parts ? ` (raw ${rawScore} ${parts})` : ""} maps to ${t}.`);
    hysteresis = hysteresisHold(afterPenalties, t, mode, opts.previous, opts.now ?? Date.now(), cfg);
    if (hysteresis) {
      const held = opts.previous!.tier as RatedTier;
      reasons.push(`Held at ${held}: ${afterPenalties} is within ${hysteresis.margin} of the ${hysteresis.line} line and the previous analysis (${hysteresis.minutesAgo}m ago) was ${held}.`);
      binding = { kind: "hysteresis", text: `held ${held}: score ${afterPenalties} within ±${hysteresis.margin} of the ${hysteresis.line} line; ${hysteresis.minutesAgo}m ago it was ${held}` };
      t = held;
    }
    for (const r of fired.filter((x) => x.capTier)) {
      if (worse(t, r.capTier as RatedTier) !== t) {
        t = r.capTier as RatedTier;
        bindingCap = r;
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
    // Held up by hysteresis: the number shows the bottom of the held band (raw beside it), never below it.
    const floor = tierFloor(t, cfg);
    if (hysteresis && t === opts.previous?.tier && score < floor) {
      score = floor;
      reasons.push(`Displayed score shown at ${floor} (bottom of ${t}, held); raw ${afterPenalties}.`);
    }
    // A cap, coverage limit or requirement that moved the tier after the hold decides; the hold no longer applies.
    if (hysteresis && t !== opts.previous?.tier) hysteresis = null;
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
    verdict: buildVerdict(tier, groups, fired, forced, bindingCap),
    tierReason: reasons.join(" "),
    binding,
    ...(hysteresis ? { hysteresis } : {}),
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
