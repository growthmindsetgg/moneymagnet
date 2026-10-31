import type { FactorResult, ScoreReport } from "@/lib/types";

/** Text for comparing reasons: no case, punctuation, "(caps at D)" / "(−20)" asides or spacing. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\((caps at [a-z]|[−-]\d+(\.\d+)?)\)/g, "")
    .replace(/[^a-z0-9%$.]+/g, " ")
    .replace(/\.(?=\s|$)/g, "")
    .trim();

/** Within one reason: drop " — " segments repeated or contained in a fuller segment ("Dead — no trades — dead — no trades for 15.9h+"). */
export function dedupeSegments(text: string): string {
  const parts = text.split(" — ");
  const n = parts.map(norm);
  const keep = parts.filter((_, i) => n[i] && !n.some((o, j) => j !== i && o.includes(n[i]) && (o.length > n[i].length || j < i)));
  return keep.join(" — ");
}

/** Distinct reasons, at most `max`: repeats and reasons contained in a fuller one are dropped. */
export function dedupeReasons<T extends { text: string }>(reasons: T[], max = 5): T[] {
  const cleaned = reasons.map((r) => ({ ...r, text: dedupeSegments(r.text) }));
  const n = cleaned.map((r) => norm(r.text));
  return cleaned.filter((_, i) => n[i] && !n.some((o, j) => j !== i && o.includes(n[i]) && (o.length > n[i].length || j < i))).slice(0, max);
}

export interface Drift {
  id: string;
  label: string;
  from: string;
  to: string;
}

/** Factors whose points moved since the previous run of this token (both runs measured), nothing else. */
export function driftSince(prev: ScoreReport | null | undefined, cur: ScoreReport): Drift[] {
  if (!prev) return [];
  const before = new Map(prev.groups.flatMap((g) => g.factors).map((f) => [f.id, f] as const));
  const measured = (f: FactorResult | undefined): f is FactorResult => !!f && f.applicable && !f.missing && !f.basic;
  return cur.groups
    .flatMap((g) => g.factors)
    .filter((f) => {
      const p = before.get(f.id);
      return measured(f) && measured(p) && Math.abs(f.points - p.points) >= 0.01;
    })
    .map((f) => ({ id: f.id, label: f.label, from: before.get(f.id)!.display, to: f.display }));
}

/** Words that name where a number came from — dropped from the plain-words "Why this tier" lines. */
const SOURCEY = /source|guide|lens|on-?chain|hoodscan|helius|rugcheck|geckoterminal|dexscreener|jupiter|pump\.?fun|scanhood|\brpc\b|blockscout|three\.ws|feed|simulat|see /i;

/** A segment that is one source's reading ("Helius: 0 buyers; pump.fun curve: 0%"). */
const SOURCE_PREFIX = /^(helius|hoodscan|rugcheck|geckoterminal|dexscreener|jupiter|pump\.?fun[\w ]*|scanhood|robinhood rpc|solana rpc|blockscout|three\.ws)\s*:/i;

/** One plain sentence from an evidence string: first fact, no source names, no "(guide …)" asides. */
export function plainSentence(text: string, label?: string): string {
  const segs = dedupeSegments(text)
    .split(" — ")
    .map((s) =>
      s
        .replace(/\(([^()]*)\)/g, (all, inner: string) => (SOURCEY.test(inner) ? "" : all))
        .replace(/\bguide p\.\s*[\d, –-]+/gi, "")
        .replace(/;\s*source:.*$/i, "")
        .replace(/\s+/g, " ")
        .replace(/\s+([.,;:])/g, "$1")
        .trim(),
    )
    .filter((s) => s && !SOURCE_PREFIX.test(s) && !/^(capped at|tier forced|−?\d+ and capped)/i.test(s) && (!label || !norm(label).includes(norm(s))));
  // First sentence only ("… is empty. Tier forced to F." → "… is empty").
  let first = (segs[0] ?? "").split(/\.\s+(?=[A-Z])/)[0].replace(/[.;:,\s]+$/, "");
  // A bare state ("no activity", "0") says nothing without its factor's name.
  if (label && (first.length < 14 || /^(no activity|no data)\b/i.test(first))) first = `${label}: ${first || "no data"}`;
  return first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}.` : "";
}

/** The verdict under the hero, at most `max` words: the headline clause, plus the main risk when it fits. */
export function shortVerdict(v: string, max = 14): string {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const [head = "", ...rest] = v.split(" — ");
  // Up to the next ";" (a "." may be a decimal point); trailing punctuation is cleaned below.
  const risk = rest.join(" — ").match(/main risk:\s*([^;]+)/i)?.[1]?.trim();
  const clean = (s: string) => s.replace(/[.;:,\s]+$/, "");
  const full = risk ? `${clean(head)} — main risk: ${clean(risk)}.` : `${clean(head)}.`;
  if (words(full) <= max) return full;
  if (words(head) <= max) return `${clean(head)}.`;
  return `${head.split(/\s+/).slice(0, max).join(" ")}…`;
}
