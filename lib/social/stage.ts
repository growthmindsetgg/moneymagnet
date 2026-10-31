/**
 * Social lifecycle stage 0–5, size band S1–S4 and quality 0–100 (information only — no score effect).
 * Pure functions over the token's own social series (lib/social/series.ts); every input that is missing
 * is reported as missing, never estimated.
 */

export interface SocialSample {
  ts: string;
  posts24h: number | null;
  uniquePosters24h: number | null;
  /** Sum of follower counts over the 24h posters the source listed (follower-weighted reach). */
  reach24h: number | null;
  /** −1..1 when a source scored sentiment. */
  sentiment: number | null;
  /** 0..1 when a source reports a bot share. */
  botShare: number | null;
  /** Social quality 0–100 at this sample (analysis samples only; cron samples have no link data). */
  quality?: number | null;
  source: string;
}

export type Stage = 0 | 1 | 2 | 3 | 4 | 5;
export type SizeBand = "S1" | "S2" | "S3" | "S4";

export const STAGE_NAME: Record<Stage, string> = { 0: "silent", 1: "starting", 2: "accelerating", 3: "peak / plateau", 4: "fading", 5: "gone" };

export interface StageResult {
  stage: Stage;
  /** Stage 3 held < 12h. */
  early3: boolean;
  /** Fewer than 3 samples: shown with an "early read" tag and no slope arrows. */
  earlyRead: boolean;
  /** Which rule matched (auditable). */
  rule: string;
  /** M = unique posters / 24h, else posts / 24h — smoothed over the last 3 samples. */
  metric: "uniquePosters24h" | "posts24h";
  mNow: number;
  m6h: number | null;
  m24h: number | null;
  m72h: number | null;
  slope6: number | null;
  slope24: number | null;
  peak: number;
  /** Hours the current stage-3 condition (M ≥ 0.7 × peak) has held, when it holds. */
  heldHours: number | null;
  samples: number;
  spanHours: number;
}

const H = 3_600_000;

/** M per sample: unique posters when every sample with data has them, else posts. Null when neither. */
function metricOf(series: SocialSample[]): "uniquePosters24h" | "posts24h" | null {
  const withPosters = series.filter((s) => s.uniquePosters24h != null);
  if (withPosters.length && withPosters.length === series.filter((s) => s.uniquePosters24h != null || s.posts24h != null).length) return "uniquePosters24h";
  return series.some((s) => s.posts24h != null) ? "posts24h" : null;
}

/** Smoothed M at each sample: the mean of that sample and up to two before it (those with a value). */
export function smoothed(series: SocialSample[], metric: "uniquePosters24h" | "posts24h"): { t: number; m: number }[] {
  const pts = series
    .filter((s) => s[metric] != null)
    .map((s) => ({ t: Date.parse(s.ts), v: s[metric] as number }))
    .sort((a, b) => a.t - b.t);
  return pts.map((p, i) => {
    const win = pts.slice(Math.max(0, i - 2), i + 1);
    return { t: p.t, m: win.reduce((a, x) => a + x.v, 0) / win.length };
  });
}

/** The smoothed value at or before `t` (the window edge), or null when the series does not reach back that far. */
const at = (pts: { t: number; m: number }[], t: number) => {
  let hit: number | null = null;
  for (const p of pts) if (p.t <= t) hit = p.m;
  return hit;
};
const slope = (now: number, then: number | null) => (then == null ? null : then === 0 ? (now > 0 ? Infinity : 0) : now / then - 1);

/**
 * Stage rules (checked in this order; the first that matches wins):
 * 0 silent: M < 5 and never ≥ 5 · 5 gone: M < 0.15 × peak for ≥ 48h, or M < 5 after once ≥ 50 ·
 * 4 fading: M ≤ 0.6 × peak and slope24 ≤ −30% · 2 accelerating: M ≥ 50 and (slope6 ≥ +25% or slope24 ≥ +100%) ·
 * 3 plateau: M ≥ 0.7 × peak and |slope6| < 25% (held ≥ 12h, else "3 (early)"); a token < 2h old is 2 instead ·
 * 1 starting: 5 ≤ M < 50 and (slope6 > 0 or the series is shorter than 6h). A state no rule covers takes the
 * nearest stage, and `rule` says "nearest".
 */
export function socialStage(series: SocialSample[], ageHours: number | null, now = Date.now()): StageResult | null {
  const metric = metricOf(series);
  if (!metric) return null;
  const pts = smoothed(series, metric).filter((p) => p.t <= now);
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  const mNow = last.m;
  const m6h = at(pts, last.t - 6 * H);
  const m24h = at(pts, last.t - 24 * H);
  const m72h = at(pts, last.t - 72 * H);
  const slope6 = slope(mNow, m6h);
  const slope24 = slope(mNow, m24h);
  const peak = Math.max(...pts.map((p) => p.m));
  const spanHours = (last.t - pts[0].t) / H;
  const base = { metric, mNow, m6h, m24h, m72h, slope6, slope24, peak, samples: pts.length, spanHours, earlyRead: pts.length < 3 };
  const out = (stage: Stage, rule: string, extra: Partial<StageResult> = {}): StageResult => ({ ...base, stage, rule, early3: false, heldHours: null, ...extra });

  if (mNow < 5 && peak < 5) return out(0, "M < 5 and never ≥ 5");
  // Gone: below 15% of the peak for the last 48h (every sample in the window), or < 5 after once ≥ 50.
  const lowSince = sinceWhen(pts, (p) => p.m < 0.15 * peak);
  if (lowSince != null && (last.t - lowSince) / H >= 48 && pts.some((p) => p.t <= last.t - 48 * H)) return out(5, "M < 0.15 × peak for ≥ 48h");
  if (mNow < 5 && peak >= 50) return out(5, "M < 5 after once ≥ 50");
  if (mNow <= 0.6 * peak && slope24 != null && slope24 <= -0.3) return out(4, "M ≤ 0.6 × peak and slope24 ≤ −30%");
  const accelerating = mNow >= 50 && ((slope6 != null && slope6 >= 0.25) || (slope24 != null && slope24 >= 1));
  if (accelerating) return out(2, "M ≥ 50 and slope6 ≥ +25% (or slope24 ≥ +100%)");
  if (mNow >= 0.7 * peak && slope6 != null && Math.abs(slope6) < 0.25 && mNow >= 5) {
    if (ageHours != null && ageHours < 2 && mNow >= 50) return out(2, "plateau shape, but the token is < 2h old with M ≥ 50 ⇒ 2");
    const held = sinceWhen(pts, (p) => p.m >= 0.7 * peak);
    const heldHours = held == null ? 0 : (last.t - held) / H;
    return out(3, `M ≥ 0.7 × peak and |slope6| < 25%, held ${heldHours.toFixed(1)}h`, { early3: heldHours < 12, heldHours });
  }
  if (ageHours != null && ageHours < 2 && mNow >= 50) return out(2, "token < 2h old with M ≥ 50");
  if (mNow >= 5 && mNow < 50 && ((slope6 != null && slope6 > 0) || spanHours < 6)) return out(1, spanHours < 6 && (slope6 == null || slope6 <= 0) ? "5 ≤ M < 50, series shorter than 6h" : "5 ≤ M < 50 and slope6 > 0");
  // Rule gaps: the nearest stage, labelled.
  if (mNow < 5) return out(peak >= 5 ? 4 : 0, "nearest: M < 5 after a small peak");
  if (mNow < 50) return out(peak >= 50 || (slope6 != null && slope6 < 0) ? 4 : 1, "nearest: 5 ≤ M < 50 without growth");
  if (slope6 != null && slope6 < 0) return out(4, "nearest: M ≥ 50 and falling");
  return out(3, "nearest: M ≥ 50, flat", { early3: true, heldHours: 0 });
}

/** Earliest t of the unbroken run of samples ending at the last one where `cond` holds; null if the last fails it. */
function sinceWhen(pts: { t: number; m: number }[], cond: (p: { t: number; m: number }) => boolean): number | null {
  let since: number | null = null;
  for (let i = pts.length - 1; i >= 0 && cond(pts[i]); i--) since = pts[i].t;
  return since;
}

/** S1 < 50 · S2 50–300 · S3 300–2,000 · S4 > 2,000 (posters, else posts, per 24h). */
export function sizeBand(m: number): SizeBand {
  if (m < 50) return "S1";
  if (m <= 300) return "S2";
  if (m <= 2000) return "S3";
  return "S4";
}

export interface QualityInputs {
  /** Share (0–1) of listed posters with > 1k followers. */
  credibleShare: number | null;
  botShare: number | null;
  /** Sentiment split (0–100 each), when a source scored post text. */
  sentiment: { posPct: number; negPct: number } | null;
  /** An X community link among the official socials (CA-in-bio cannot be read without the X API). */
  xCommunity: boolean | null;
  /** The earliest post predates the launch. */
  postsBeforeLaunch: boolean | null;
  /** Telegram call channels carried it before X (or most early callers are one coordinated cluster). */
  callChannelPattern: boolean | null;
  /** DexScreener paid boosts are active. */
  boosted: boolean | null;
}

export interface QualityPart {
  id: keyof QualityInputs;
  label: string;
  weight: number;
  /** 0–1, or null with `reason`. */
  value: number | null;
  reason?: string;
  note: string;
}

const PARTS: { id: keyof QualityInputs; label: string; weight: number; note: string }[] = [
  { id: "credibleShare", label: "posters with > 1k followers", weight: 25, note: "guide p.37: credible humans, not bot channels" },
  { id: "botShare", label: "bot share (lower is better)", weight: 20, note: "guide p.37" },
  { id: "sentiment", label: "sentiment not flat-positive", weight: 10, note: "guide p.43: all-positive chatter is a shill signal" },
  { id: "xCommunity", label: "X community linked", weight: 10, note: "guide p.48: X community with the CA in its bio" },
  { id: "postsBeforeLaunch", label: "no posts before launch", weight: 15, note: "guide p.43: posts older than the launch = pre-planned" },
  { id: "callChannelPattern", label: "no call-channel pattern", weight: 15, note: "guide p.37: bot call channels" },
  { id: "boosted", label: "no paid boosts", weight: 5, note: "HoodTier: DexScreener boosts are paid promotion" },
];

const POSTER_PARTS = new Set<keyof QualityInputs>(["credibleShare", "botShare", "sentiment", "postsBeforeLaunch", "callChannelPattern"]);

/** Quality 0–100 over the parts that have data (renormalized); null when fewer than 2 parts (or no poster-based part) have data. */
export function socialQuality(q: QualityInputs, reasons: Partial<Record<keyof QualityInputs, string>> = {}): { score: number | null; parts: QualityPart[] } {
  const parts: QualityPart[] = PARTS.map((p) => {
    const v = q[p.id];
    let value: number | null = null;
    if (p.id === "credibleShare" && typeof v === "number") value = Math.min(1, v / 0.5);
    if (p.id === "botShare" && typeof v === "number") value = Math.max(0, 1 - v);
    if (p.id === "sentiment" && v && typeof v === "object") value = v.posPct >= 95 && v.negPct <= 1 ? 0 : 1;
    if ((p.id === "postsBeforeLaunch" || p.id === "callChannelPattern" || p.id === "boosted") && typeof v === "boolean") value = v ? 0 : 1;
    if (p.id === "xCommunity" && typeof v === "boolean") value = v ? 1 : 0;
    return { ...p, value, ...(value == null ? { reason: reasons[p.id] ?? "no source reported it" } : {}) };
  });
  const known = parts.filter((p) => p.value != null);
  // Links and boosts alone say nothing about who posts: a score needs at least one poster-based part.
  if (known.length < 2 || !known.some((p) => POSTER_PARTS.has(p.id))) return { score: null, parts };
  const w = known.reduce((a, p) => a + p.weight, 0);
  return { score: Math.round((known.reduce((a, p) => a + p.weight * (p.value as number), 0) / w) * 100), parts };
}

const SIZE_WORD: Record<SizeBand, string> = { S1: "tiny", S2: "small", S3: "mid-size", S4: "large" };

/** Plain-language verdict, ≤ 14 words. */
export function socialVerdict(st: StageResult, size: SizeBand, quality: number | null): string {
  const q = quality == null ? null : quality >= 70 ? "mostly real accounts" : quality >= 40 ? "mixed accounts" : "low-quality chatter";
  const peakSize = SIZE_WORD[sizeBand(st.peak)];
  const parts = (head: string) => [head, q].filter(Boolean).join(", ");
  switch (st.stage) {
    case 0:
      return "Silent — almost nobody is posting about it";
    case 1:
      return parts(`Starting, ${SIZE_WORD[size]}`);
    case 2:
      return parts(`Accelerating, ${SIZE_WORD[size]}`);
    case 3:
      return size === "S1" ? "Plateau, but tiny — nobody new is arriving" : parts(`${st.early3 ? "Peaking" : "Holding a plateau"}, ${SIZE_WORD[size]}`);
    case 4:
      return `Fading from a ${peakSize} peak`;
    default:
      return `Gone — attention left after a ${peakSize} peak`;
  }
}

/** "Stage 3 · S3 · quality 72 — strong, holding for 3 days". */
export function stageBadge(st: StageResult, size: SizeBand, quality: number | null): string {
  const label = st.stage === 3 && st.early3 ? "3 (early)" : String(st.stage);
  const tail =
    st.stage === 3 && st.heldHours != null
      ? size === "S1"
        ? "plateau, but tiny — nobody new is arriving"
        : `${quality != null && quality >= 70 ? "strong, " : ""}holding for ${st.heldHours >= 48 ? `${Math.round(st.heldHours / 24)} days` : `${Math.round(st.heldHours)}h`}`
      : STAGE_NAME[st.stage];
  return `Stage ${label} · ${size}${quality != null ? ` · quality ${quality}` : ""} — ${tail}`;
}

// --- Time Machine: stage sequences by age -----------------------------------------------------

export const SOCIAL_AGES = [1, 6, 24, 72, 168] as const;
export type SocialAge = (typeof SOCIAL_AGES)[number];
/** Stage at each age bucket (null where the history has no sample). */
export type StageByAge = Partial<Record<SocialAge, { stage: Stage; size: SizeBand } | null>>;

/** Levenshtein distance between two stage sequences (only ages both sides have). */
export function stageEditDistance(a: (Stage | null)[], b: (Stage | null)[]): number {
  const x = a.filter((s): s is Stage => s != null);
  const y = b.filter((s): s is Stage => s != null);
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  return d[x.length][y.length];
}

/** Stage at each age bucket from a series (the sample nearest before each age edge). */
export function stagesByAge(series: SocialSample[], launchedAt: string | null): StageByAge {
  if (!launchedAt) return {};
  const t0 = Date.parse(launchedAt);
  const out: StageByAge = {};
  for (const age of SOCIAL_AGES) {
    const edge = t0 + age * H;
    const upto = series.filter((s) => Date.parse(s.ts) <= edge);
    if (!upto.length || Date.parse(upto[upto.length - 1].ts) < edge - Math.max(1, age / 2) * H) {
      out[age] = null;
      continue;
    }
    const st = socialStage(upto, age, edge);
    out[age] = st ? { stage: st.stage, size: sizeBand(st.mNow) } : null;
  }
  return out;
}

export interface SocialArchetype {
  name: string;
  kind: "winner" | "rug";
  stages: StageByAge;
}

/**
 * The Time Machine line ("At 24h, winners were typically Stage 2–3 at S2+; rugs were Stage 1 then 5")
 * and the nearest archetype by stage sequence. Null (with the reason) when no archetype has social history.
 */
export function socialTimeMachine(
  token: StageByAge,
  library: SocialArchetype[],
  ageHours: number | null,
): { line: string | null; nearest: { name: string; kind: string; distance: number } | null; reason: string | null } {
  const withHistory = library.filter((a) => SOCIAL_AGES.some((g) => a.stages[g]));
  if (!withHistory.length) return { line: null, nearest: null, reason: "no archetype in the library has social history yet — the sources expose no past post counts, so it fills in from our own series" };
  const age = SOCIAL_AGES.filter((g) => ageHours == null || g <= Math.max(1, ageHours)).pop() ?? 1;
  const at = (kind: "winner" | "rug") =>
    withHistory
      .filter((a) => a.kind === kind)
      .map((a) => a.stages[age])
      .filter((x): x is { stage: Stage; size: SizeBand } => !!x);
  const range = (xs: { stage: Stage; size: SizeBand }[]) => {
    if (!xs.length) return null;
    const st = xs.map((x) => x.stage).sort();
    const lo = st[Math.floor(st.length * 0.25)];
    const hi = st[Math.ceil(st.length * 0.75) - 1] ?? lo;
    const sizes = xs.map((x) => x.size).sort();
    return `Stage ${lo === hi ? lo : `${lo}–${hi}`} at ${sizes[Math.floor(sizes.length * 0.25)]}+`;
  };
  const rugSeq = withHistory
    .filter((a) => a.kind === "rug")
    .map((a) => SOCIAL_AGES.map((g) => a.stages[g]?.stage).filter((s) => s != null));
  const rugPath = rugSeq.length ? [...new Set(rugSeq.flat())].slice(0, 2).join(" then ") : null;
  const w = range(at("winner"));
  const line = w || rugPath ? `At ${age >= 168 ? "7d" : `${age}h`}, ${w ? `winners were typically ${w}` : "no winner had a sample"}${rugPath ? `; rugs were Stage ${rugPath}` : ""}.` : null;
  const mine = SOCIAL_AGES.map((g) => token[g]?.stage ?? null);
  if (!mine.some((s) => s != null)) return { line, nearest: null, reason: "this token has no social samples at those ages yet" };
  const ranked = withHistory
    .map((a) => ({ name: a.name, kind: a.kind, distance: stageEditDistance(mine, SOCIAL_AGES.map((g) => a.stages[g]?.stage ?? null)) }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return { line, nearest: ranked[0], reason: null };
}
