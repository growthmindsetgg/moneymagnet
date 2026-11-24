import rawConfig from "./factors.json";
import type { Chain, FlagLevel, Tier, TokenSnapshot } from "../types";

export type Op = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
export const OPS: Op[] = ["eq", "ne", "gt", "gte", "lt", "lte"];

/** Comparison against a single value, e.g. { "gte": 5, "lte": 10 }. All present ops must hold.
 *  { "missing": true } matches when the value is absent (null). */
export type ValueCondition = Partial<Record<Op, number | boolean>> & {
  missing?: boolean;
  /** A missing value passes this condition (e.g. "not liquidity-pulled" when nobody measured it). */
  orMissing?: boolean;
};
/** Conditions over several snapshot metrics, e.g. { "ageHours": { "lt": 24 } }. */
export type MetricCondition = Record<string, ValueCondition>;

export type Format = "pct" | "signedPct" | "signedPp" | "signedRatioPct" | "ratio" | "num" | "int" | "usd" | "usdAbs" | "bool" | "age";

export type Mode = "launch" | "established";
export type RatedTier = Exclude<Tier, "U">;

export interface Threshold extends ValueCondition {
  points: number;
  flag?: FlagLevel;
  note?: string;
}

export interface MissingRule {
  if?: MetricCondition;
  /** exclude = "no data" (counts against coverage); score = fixed points; na = not applicable (neither). */
  mode: "exclude" | "score" | "na";
  points?: number;
  flag?: FlagLevel;
  evidence: string;
}

export interface FactorDef {
  id: string;
  label: string;
  weight: number;
  metric: keyof TokenSnapshot;
  direction: "higher_better" | "lower_better" | "boolean" | "band";
  format: Format;
  thresholds: Threshold[];
  evidenceTemplate: string;
  /** "guide" (memecoin guide, page in `note`) or "hoodtier". */
  source: "guide" | "hoodtier";
  note?: string;
  /** Adapter ids that can supply the metric (used for "no data — <reason>"). */
  data: string[];
  /** Display text for boolean values, e.g. { "true": "sellable: yes" }. */
  labels?: Record<string, string>;
  chains?: Chain[];
  gate?: boolean;
  gatePass?: ValueCondition;
  whenMissing?: MissingRule[];
  /** v2.4 basics: evaluated and shown with their evidence, but worth 0 points (a fail is a gate rule). */
  gateOnly?: boolean;
  /** Scored only when `metric` ≥ `gte`; below that the factor is live, 0 points, "insufficient sample". */
  minSample?: { metric: keyof TokenSnapshot; gte: number; label: string };
  /** Shown when weight is 0 (factor kept in the file but not scored). */
  disabledReason?: string;
  /**
   * Scores the metric against a FIXED reference picked by another metric's band (e.g. liquidity / market cap
   * against the reference ratio of the token's market-cap band). The thresholds then apply to metric ÷ reference,
   * so 1.0 means "exactly the reference". The reference never depends on other tokens.
   */
  reference?: ReferenceDef;
  /**
   * When the boolean snapshot field `when` is true, the factor reads `metric` instead (and fills its own evidence
   * template). The substitute is a derived reading, so the original metric's cross-source verification is not shown.
   */
  override?: { when: keyof TokenSnapshot; metric: keyof TokenSnapshot; evidenceTemplate: string };
}

export interface ReferenceBand extends ValueCondition {
  /** The reference value, in the factor metric's own unit. */
  value: number;
  /** Shown in the evidence, e.g. "$1M–10M". */
  label: string;
}

export interface ReferenceDef {
  /** The snapshot metric whose value picks the band (e.g. fdvUsd). */
  metric: keyof TokenSnapshot;
  /** What that metric is, for the evidence and the null reason (e.g. "market cap (FDV)"). */
  label: string;
  /** Checked top-down, first match wins (like thresholds). */
  bands: ReferenceBand[];
  note?: string;
}

export interface GroupDef {
  id: string;
  label: string;
  weight: number;
  factors: FactorDef[];
}

export interface FactorSet {
  label: string;
  groups: GroupDef[];
}

/** Gates and penalties in one shape: a condition plus its effects. */
export interface RuleDef {
  id: string;
  label: string;
  source: "guide" | "hoodtier";
  note?: string;
  /** Shown in the gates strip (pass / fail / unknown) even when it doesn't fire. */
  gate?: boolean;
  /** Gate chip text when the gate passes (the label describes the failure). */
  passLabel?: string;
  when?: MetricCondition;
  anyOf?: MetricCondition[];
  /** Restrict to one factor set. */
  sets?: Mode[];
  /** Restrict to chains (shown as n/a elsewhere). */
  chains?: Chain[];
  points?: number;
  capTier?: RatedTier;
  forceF?: boolean;
  /** Unrated: too early / too little activity to rate (applied after coverage and forcing F gates). */
  forceU?: boolean;
  /** With forceU: applies even when a forcing gate fired (e.g. a token minutes old). */
  overridesGates?: boolean;
  flag?: string;
  evidenceTemplate: string;
}

export interface RequirementDef {
  id: string;
  label: string;
  tiers: ("S" | "A")[];
  when?: MetricCondition;
  anyOf?: MetricCondition[];
  allowMissing?: boolean;
}

export interface ManualCheckDef {
  id: string;
  text: string;
  note: string;
}

export interface ScoringConfig {
  version: number;
  modes: { launchMaxAgeHours: number; unknownAgeMode: Mode };
  /** `launch` and `established`, plus chain-specific sets named in `chainSets`. */
  sets: Record<Mode, FactorSet> & Record<string, FactorSet>;
  /** Chain → mode → set name, e.g. Robinhood launch tokens use `launch_robinhood`. */
  chainSets?: { note?: string } & Partial<Record<Chain, Partial<Record<Mode, string>>>>;
  rules: RuleDef[];
  /** Wallet-cluster meter constants (lib/cluster reads them; the engine only scores the resulting metrics). */
  walletClusters?: import("../cluster/graph").WalletClustersCfg;
  tiers: { tier: RatedTier; min: number }[];
  coverage: { unratedBelowPct: number; capBBelowPct: number; topTierMinPct: number };
  /**
   * Tier hysteresis (Schmitt trigger) on the score → band step: a token whose previous analysis was placed by
   * the score bands keeps that tier while the new score is within `margin` of the line between the two
   * adjacent tiers. Gates, caps, coverage and S/A requirements still apply afterwards.
   */
  hysteresis?: { note?: string; margin: number; maxAgeHours: number };
  requirements: RequirementDef[];
  manualChecks: ManualCheckDef[];
  /** Documentation of the Time Machine's (bounded) score effect; the effect itself is two rules. */
  timeMachine?: { note: string; buckets: number[]; bonus: Record<string, unknown>; malus: Record<string, unknown> };
  /** Conviction-vs-churn read-out (presentation only, no score effect). */
  /** Metrics set to 0 (minimum points) when activity is genuinely zero — see applyZeroActivity. */
  zeroActivity?: { note?: string; metrics: string[] };
  /** Display formats for metrics that evidence templates quote but no factor scores directly. */
  metricFormats?: { note?: string } & Record<string, Format | string>;
  summary: { note?: string; minSignals: number; leanBy: number; signals: { id: string; side: "conviction" | "churn"; when: MetricCondition; text: string }[] };
}

/** The factor set for a token: the chain-specific one when `chainSets` names it, else the mode's. */
export function setFor(cfg: ScoringConfig, mode: Mode, chain: Chain): FactorSet {
  const name = cfg.chainSets?.[chain]?.[mode];
  return (name && cfg.sets[name]) || cfg.sets[mode];
}

/** Throws with a readable message if the config is malformed. */
export function validateConfig(cfg: ScoringConfig): ScoringConfig {
  const errors: string[] = [];
  for (const [mode, set] of Object.entries(cfg.sets)) {
    const ids = new Set<string>();
    let total = 0;
    for (const g of set.groups) {
      const sum = g.factors.reduce((s, f) => s + f.weight, 0);
      if (Math.abs(sum - g.weight) > 1e-9) errors.push(`${mode}/${g.id}: weight ${g.weight} != sum of factor weights ${sum}`);
      total += g.weight;
      for (const f of g.factors) {
        if (ids.has(f.id)) errors.push(`${mode}: duplicate factor id "${f.id}"`);
        ids.add(f.id);
        if (!f.metric) errors.push(`${mode}/${f.id}: no metric`);
        if (!f.thresholds?.length) errors.push(`${mode}/${f.id}: no thresholds`);
        if (f.source !== "guide" && f.source !== "hoodtier") errors.push(`${mode}/${f.id}: source must be "guide" or "hoodtier"`);
        if (f.source === "guide" && !f.note) errors.push(`${mode}/${f.id}: guide factors need a page note`);
        if (!Array.isArray(f.data)) errors.push(`${mode}/${f.id}: data must list adapter ids`);
        for (const t of f.thresholds ?? []) if (t.points < 0 || t.points > 1) errors.push(`${mode}/${f.id}: threshold points must be 0..1`);
        if (f.gate && !f.gatePass) errors.push(`${mode}/${f.id}: gate needs gatePass`);
        if (f.reference) {
          if (!f.reference.metric) errors.push(`${mode}/${f.id}: reference needs a metric`);
          if (!f.reference.bands?.length) errors.push(`${mode}/${f.id}: reference needs bands`);
          for (const b of f.reference.bands ?? []) if (!(typeof b.value === "number" && b.value > 0)) errors.push(`${mode}/${f.id}: reference band "${b.label}" needs a positive value`);
        }
      }
    }
    if (Math.abs(total - 100) > 1e-9) errors.push(`${mode}: group weights sum to ${total}, expected 100`);
  }
  for (const r of cfg.rules) {
    if (!r.when && !r.anyOf) errors.push(`rule ${r.id}: needs when or anyOf`);
    if (r.source === "guide" && !r.note) errors.push(`rule ${r.id}: guide rules need a page note`);
  }
  if (errors.length) throw new Error(`Invalid factors.json:\n- ${errors.join("\n- ")}`);
  return cfg;
}

export function loadConfig(cfg: unknown = rawConfig): ScoringConfig {
  return validateConfig(cfg as ScoringConfig);
}

export const defaultConfig = loadConfig();

export function modeFor(ageHours: number | null, cfg: ScoringConfig = defaultConfig): Mode {
  if (ageHours == null) return cfg.modes.unknownAgeMode;
  return ageHours < cfg.modes.launchMaxAgeHours ? "launch" : "established";
}
