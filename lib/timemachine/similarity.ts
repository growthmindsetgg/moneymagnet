import type { Archetype, BucketFields, FieldName } from "./types";
import { FIELD_LABELS } from "./types";

/**
 * How each field is compared. Log-scaled fields (sizes) use decades; the rest are linear.
 * `span` is the difference at which the field counts as 0% similar; `floor` keeps log10 finite.
 */
export const SIMILARITY_FIELDS: { field: FieldName; scale: "log" | "linear"; span: number; floor?: number; unit?: string }[] = [
  { field: "holders", scale: "log", span: 2, floor: 1 },
  { field: "mcapUsd", scale: "log", span: 2, floor: 100 },
  { field: "liquidityUsd", scale: "log", span: 2, floor: 10 },
  { field: "buyerSellerRatio", scale: "log", span: 1, floor: 0.01 },
  { field: "volMc", scale: "log", span: 1.5, floor: 0.001 },
  { field: "peakMultiple", scale: "log", span: 1.5, floor: 1 },
  { field: "top10SharePct", scale: "linear", span: 50, unit: "%" },
  { field: "earlyRetentionPct", scale: "linear", span: 50, unit: "%" },
  { field: "devBuySharePct", scale: "linear", span: 30, unit: "%" },
  { field: "devSoldPct", scale: "linear", span: 100, unit: "%" },
  { field: "freshWalletSharePct", scale: "linear", span: 60, unit: "%" },
  { field: "fundingClusterMax", scale: "linear", span: 5 },
  { field: "drawdownPct", scale: "linear", span: 60, unit: "%" },
];

/** Fewer shared fields than this and no similarity is claimed. */
export const MIN_SHARED_FIELDS = 4;

export interface FieldComparison {
  field: FieldName;
  label: string;
  a: number;
  b: number;
  similarity: number;
  /** e.g. "liquidity 4× thinner" or "top-10 share 35% vs 12%". */
  phrase: string;
}

export interface Similarity {
  /** 0–100, or null when fewer than MIN_SHARED_FIELDS fields are known on both sides. */
  pct: number | null;
  compared: FieldComparison[];
  /** Fields known on only one side — excluded from the distance. */
  excluded: FieldName[];
}

const log = (x: number, floor: number) => Math.log10(Math.max(x, floor));

function phrase(def: (typeof SIMILARITY_FIELDS)[number], a: number, b: number): string {
  const label = FIELD_LABELS[def.field].toLowerCase();
  if (def.scale === "log") {
    const r = Math.max(a, def.floor ?? 0) / Math.max(b, def.floor ?? 1e-9);
    if (r >= 0.8 && r <= 1.25) return `${label} about the same`;
    const x = r >= 1 ? r : 1 / r;
    const word = def.field === "liquidityUsd" ? (r < 1 ? "thinner" : "deeper") : r < 1 ? "lower" : "higher";
    return `${label} ${x >= 10 ? Math.round(x) : x.toFixed(1)}× ${word}`;
  }
  const u = def.unit ?? "";
  return `${label} ${+a.toFixed(1)}${u} vs ${+b.toFixed(1)}${u}`;
}

/** Symmetric similarity of two same-age snapshots over the fields both have. */
export function similarity(a: BucketFields, b: BucketFields): Similarity {
  const compared: FieldComparison[] = [];
  const excluded: FieldName[] = [];
  for (const def of SIMILARITY_FIELDS) {
    const x = a[def.field];
    const y = b[def.field];
    if (x == null || y == null) {
      if (x != null || y != null) excluded.push(def.field);
      continue;
    }
    const d = def.scale === "log" ? Math.abs(log(x, def.floor ?? 1e-9) - log(y, def.floor ?? 1e-9)) : Math.abs(x - y);
    const s = Math.max(0, 1 - d / def.span);
    compared.push({ field: def.field, label: FIELD_LABELS[def.field], a: x, b: y, similarity: Math.round(s * 1000) / 1000, phrase: phrase(def, x, y) });
  }
  const pct = compared.length >= MIN_SHARED_FIELDS ? Math.round((compared.reduce((t, c) => t + c.similarity, 0) / compared.length) * 1000) / 10 : null;
  return { pct, compared, excluded };
}

export interface Match {
  archetype: Pick<Archetype, "chain" | "address" | "symbol" | "name" | "kind" | "source" | "peakMcapUsd">;
  bucket: number;
  pct: number;
  matches: FieldComparison[];
  breaks: FieldComparison[];
  compared: FieldComparison[];
  archetypeFields: BucketFields;
}

export const MATCH_AT = 0.75;
export const BREAK_BELOW = 0.5;

/** Ranks archetypes of one kind by similarity at the same bucket. */
export function nearest(fields: BucketFields, bucket: number, library: Archetype[], kind: Archetype["kind"], limit = 5): Match[] {
  const out: Match[] = [];
  for (const arch of library) {
    if (arch.kind !== kind) continue;
    const snap = arch.buckets.find((x) => x.bucket === bucket);
    if (!snap) continue;
    const s = similarity(fields, snap.fields);
    if (s.pct == null) continue;
    out.push({
      archetype: { chain: arch.chain, address: arch.address, symbol: arch.symbol, name: arch.name, kind: arch.kind, source: arch.source, peakMcapUsd: arch.peakMcapUsd },
      bucket,
      pct: s.pct,
      matches: s.compared.filter((c) => c.similarity >= MATCH_AT),
      breaks: s.compared.filter((c) => c.similarity < BREAK_BELOW).sort((x, y) => x.similarity - y.similarity),
      compared: s.compared,
      archetypeFields: snap.fields,
    });
  }
  return out.sort((x, y) => y.pct - x.pct).slice(0, limit);
}
