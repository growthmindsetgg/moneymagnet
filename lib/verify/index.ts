import type { AdapterResult, MetricVerification, Provenance, TokenSnapshot, VerificationSummary } from "../types";
import { deriveMetrics, emptySnapshot, mergeSnapshots } from "../snapshot";
import { DERIVED_INPUTS, ONCHAIN_SOURCES, RELATIVE_TOLERANCE, VERIFIED_METRICS, type VerifiedMetricDef } from "./metrics";

export { VERIFIED_METRICS, ONCHAIN_SOURCES } from "./metrics";

type Scalar = number | boolean | string;
const isScalar = (v: unknown): v is Scalar => typeof v === "number" || typeof v === "boolean" || typeof v === "string";
const present = (v: unknown) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length);

/** Free-text fields that describe a window or label rather than measure something. */
const NOT_METRICS = new Set([
  "name",
  "symbol",
  "anchor",
  "assetKind",
  "tokenExists",
  "launchpad",
  "socialLinks",
  "holderSource",
  "feedWindow",
  "trendWindow",
  "launchWindow",
  "identicalWindow",
  "staircaseWindow",
  "liqChange24hWindow",
  "liqChange7dWindow",
  "chain",
  "address",
]);

export interface SourceSlice {
  id: string;
  label: string;
  data: Partial<TokenSnapshot>;
}

/**
 * Every source's reading of every metric. Each slice is derived on its own (with the shared supply
 * and pool list as context), so e.g. top-10 share is computed separately from each source's holders.
 */
export function collectProvenance(base: TokenSnapshot, slices: SourceSlice[], now = Date.now()): Record<string, Provenance[]> {
  const out: Record<string, Provenance[]> = {};
  const ctx: Partial<TokenSnapshot> = { totalSupply: base.totalSupply, poolAddresses: base.poolAddresses };
  for (const slice of slices) {
    if (!Object.values(slice.data).some(present)) continue;
    const own = deriveMetrics(mergeSnapshots(emptySnapshot(base.chain, base.address), [slice.data, ctx]));
    const rec = own as unknown as Record<string, unknown>;
    const supplied = (k: string) => present((slice.data as Record<string, unknown>)[k]);
    const stale = slice.data.staleFields ?? {};
    for (const [k, v] of Object.entries(rec)) {
      if (NOT_METRICS.has(k) || !isScalar(v)) continue;
      const inputs = DERIVED_INPUTS[k] ?? [k];
      if (!inputs.some(supplied)) continue;
      const age = stale[k] ?? inputs.map((i) => stale[i]).find((x) => x != null);
      (out[k] ??= []).push({
        source: slice.id,
        label: slice.label,
        value: v,
        fetchedAt: new Date(now - (age ?? 0) * 60_000).toISOString(),
        onchain: ONCHAIN_SOURCES.has(slice.id),
        ...(age != null ? { stale: true } : {}),
      });
    }
  }
  return out;
}

function differs(def: VerifiedMetricDef, a: Scalar | null, b: Scalar | null): boolean {
  if (a === null || b === null) return a !== b;
  if (def.kind === "number") {
    const x = Number(a);
    const y = Number(b);
    const diff = Math.abs(x - y);
    const scale = Math.max(Math.abs(x), Math.abs(y));
    return scale > 0 && diff / scale > RELATIVE_TOLERANCE && diff > (def.tolerance ?? 0);
  }
  if (def.kind === "address") return String(a).toLowerCase() !== String(b).toLowerCase();
  return a !== b;
}

/** The most conservative of a set of readings (see each metric's `direction`). */
function conservative(def: VerifiedMetricDef, values: Provenance[]): Provenance | null {
  const known = values.filter((v) => v.value !== null);
  switch (def.direction) {
    case "min":
      return known.reduce<Provenance | null>((m, v) => (m === null || Number(v.value) < Number(m.value) ? v : m), null);
    case "max":
      return known.reduce<Provenance | null>((m, v) => (m === null || Number(v.value) > Number(m.value) ? v : m), null);
    case "unsafe-true":
      return known.find((v) => v.value === true) ?? known[0] ?? null;
    case "unsafe-false":
      return known.find((v) => v.value === false) ?? known[0] ?? null;
    case "unknown":
      return null;
  }
}

/** Resolves one metric: agreement check, then on-chain truth, then the most conservative reading. */
export function verifyMetric(def: VerifiedMetricDef, readings: Provenance[]): MetricVerification {
  // One reading per source (the first a source gave).
  const values = readings.filter((v, i) => readings.findIndex((w) => w.source === v.source) === i);
  const base = { metric: def.metric, label: def.label, kind: def.kind, values };
  if (values.length === 1) {
    return { ...base, status: "single", chosen: values[0].value, chosenSource: values[0].source, resolution: `single source (${values[0].label})`, wrongSources: [] };
  }
  const disputed = values.some((a, i) => values.slice(i + 1).some((b) => differs(def, a.value as Scalar, b.value as Scalar)));
  const chain = values.filter((v) => v.onchain);
  // On-chain is truth: an API that disagrees with the chain is flagged stale/wrong.
  if (chain.length) {
    const truth = chain.length === 1 ? chain[0] : (conservative(def, chain) ?? chain[0]);
    const wrong = values.filter((v) => !v.onchain && differs(def, v.value as Scalar, truth.value as Scalar)).map((v) => v.source);
    const chainSplit = chain.some((c) => differs(def, c.value as Scalar, truth.value as Scalar));
    return {
      ...base,
      status: disputed ? "disputed" : "verified",
      chosen: truth.value,
      chosenSource: truth.source,
      resolution: disputed
        ? chainSplit
          ? `on-chain sources disagree — most conservative on-chain reading (${def.conservative}) from ${truth.label}`
          : `on-chain wins (${truth.label})`
        : `${values.length} sources agree within 15%`,
      wrongSources: wrong,
    };
  }
  if (!disputed) {
    const pick = conservative(def, values) ?? values[0];
    return { ...base, status: "verified", chosen: pick.value, chosenSource: pick.source, resolution: `${values.length} sources agree within 15%`, wrongSources: [] };
  }
  const pick = conservative(def, values);
  return {
    ...base,
    status: "disputed",
    chosen: pick?.value ?? null,
    chosenSource: pick?.source ?? null,
    resolution: `sources disagree — scored with the most conservative: ${def.conservative}${pick ? ` (${pick.label})` : ""}`,
    wrongSources: [],
  };
}

const DEFS = new Map(VERIFIED_METRICS.map((d) => [d.metric, d]));
export const verifiedMetricDef = (metric: string) => DEFS.get(metric);

export function summarizeVerification(provenance: Record<string, Provenance[]> = {}): VerificationSummary {
  const metrics = VERIFIED_METRICS.filter((d) => provenance[d.metric]?.length).map((d) => verifyMetric(d, provenance[d.metric]));
  return {
    verified: metrics.filter((m) => m.status === "verified").length,
    single: metrics.filter((m) => m.status === "single").length,
    disputed: metrics.filter((m) => m.status === "disputed").length,
    metrics,
  };
}

export const formatProvenanceValue = (v: Provenance["value"]) =>
  v === null ? "null" : typeof v === "number" ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 1000) / 1000)) : String(v);

/**
 * Applies verification to the merged (pre-derivation) snapshot: each multi-source metric takes its
 * chosen value, so derived metrics are computed from verified inputs. Returns per-source flags.
 */
export function applyVerification(merged: TokenSnapshot, slices: SourceSlice[], now = Date.now()): { snapshot: TokenSnapshot; flags: Record<string, string[]> } {
  const provenance = collectProvenance(merged, slices, now);
  const out: TokenSnapshot = { ...merged, provenance, nullReasons: { ...merged.nullReasons } };
  const rec = out as unknown as Record<string, unknown>;
  const flags: Record<string, string[]> = {};
  for (const m of summarizeVerification(provenance).metrics) {
    if (m.status === "single") continue;
    rec[m.metric] = m.chosen;
    if (m.chosen === null) {
      out.nullReasons[m.metric] = `disputed: ${m.values.map((v) => `${v.label} says ${formatProvenanceValue(v.value)}`).join(", ")} — no on-chain reading to settle it`;
    }
    if (m.metric === "ageHours" && m.chosenSource) {
      // Keep createdAt consistent with the age source that won.
      const src = slices.find((s) => s.id === m.chosenSource);
      if (src?.data.createdAt) out.createdAt = src.data.createdAt;
    }
    const truth = m.values.find((v) => v.source === m.chosenSource);
    for (const id of m.wrongSources) {
      const bad = m.values.find((v) => v.source === id)!;
      (flags[id] ??= []).push(`API stale/wrong: ${m.label} ${formatProvenanceValue(bad.value)} vs on-chain ${formatProvenanceValue(truth?.value ?? null)} (${truth?.label})`);
    }
  }
  return { snapshot: out, flags };
}

/** Adapter results as labelled slices (failed adapters with no data contribute nothing). */
export const slicesOf = (results: AdapterResult[]): SourceSlice[] =>
  results.filter((r) => Object.keys(r.data).length).map((r) => ({ id: r.status.id, label: r.status.label, data: r.data }));
