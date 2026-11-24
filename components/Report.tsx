import type { FactorResult, GroupResult, MetricVerification, Provenance, RuleResult, ScoreReport, Tier, VerificationSummary } from "@/lib/types";
import { CHAIN_LABEL } from "@/lib/chain";
import { formatAge, formatCompactUsd, formatPrice } from "@/lib/scoring/format";
import { Suspense, type CSSProperties, type ReactNode } from "react";
import { CopyAddress, CopyLink, RememberSearch, RetrySources } from "./ClientBits";
import ManualChecks from "./ManualChecks";
import TimeMachine from "./TimeMachine";
import StateBlock, { brand, rejectWord } from "./StateBlock";
import ResearchToggle from "./ResearchToggle";
import TierKey from "./TierKey";
import { TIER_TEXT } from "./TierChip";
import { summarize } from "@/lib/summary";
import { formatStaleAge } from "@/lib/stale";
import { formatProvenanceValue } from "@/lib/verify";
import { CHECK_SEVERITY, disputeLook, factorSeverity, fakeSignalSeverity, groupSeverity, ruleSeverity, SEV, SEV_FILL, SOURCE_SEVERITY, TIER_LOOK, worst, type Severity } from "./severity";
import { bandMovingDisputes } from "./disputeImpact";
import { driftSince, shortVerdict } from "./present";
import { hitMetrics, mergedChecks, verificationLine, whyLines } from "./verdict";
import { prosCons } from "./prosCons";
import DeepResearchButton from "./DeepResearch";
import SocialPanel from "./SocialPanel";
import RawData from "./RawData";
import { largestHolderLine, txUrl } from "@/lib/holderLine";
import { clusterSummary, deployerLine, holdersTable, poolList, poolLiquidity, short } from "./research";
import ClusterMeter from "./ClusterMeter";

export { TIER_TEXT };

const TIER_ORDER: Tier[] = ["F", "D", "C", "B", "A", "S"];
const BAND_WORD: Record<Severity, string> = { good: "good", ok: "fair", warn: "weak", bad: "failing" };

/** What a factor row needs beyond itself: metrics hit by a fired gate/cap/penalty, rows whose dispute moved their band, each metric's resolution. */
interface Ctx {
  hit: ReadonlySet<string>;
  bandMoved: ReadonlySet<string>;
  metrics: ReadonlyMap<string, MetricVerification>;
}

function H2({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mm-display-sm text-xl sm:text-2xl">
      {children}
    </h2>
  );
}

function Tag({ children, testId, on = false }: { children: ReactNode; testId?: string; on?: boolean }) {
  return (
    <span className="mm-tag text-xs uppercase tracking-wider" data-on={on}>
      <span data-testid={testId}>{children}</span>
    </span>
  );
}

/** A pill in one of the four severities, or the neutral grey look. */
function Chip({ sev, children, testId, title }: { sev: Severity | "muted"; children: ReactNode; testId?: string; title?: string }) {
  return (
    <span data-testid={testId} data-severity={sev} title={title} className={`inline-block shrink-0 rounded-full px-2 py-px text-xs font-bold tracking-wider ${sev === "muted" ? "sev-muted" : SEV[sev]}`}>
      {children}
    </span>
  );
}

function StaleBadge({ age, testId }: { age: string; testId?: string }) {
  return (
    <Chip sev="muted" testId={testId ?? "stale-badge"}>
      stale {age}
    </Chip>
  );
}

/** "12:34:56 UTC", or "time unknown" for a report without a valid timestamp. */
const utcTime = (iso: string) => (Number.isNaN(Date.parse(iso)) ? "time unknown" : `${new Date(iso).toISOString().slice(11, 19)} UTC`);

const pct1 = (v: number) => `${Math.round(v * 10) / 10}%`;

/** A source reading in the metric's own unit (17.9%, $310K, yes / no). */
function fmtValue(metric: string, v: Provenance["value"]) {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") {
    if (/Pct$/.test(metric)) return pct1(v);
    if (/Usd$/.test(metric)) return formatCompactUsd(v);
  }
  return formatProvenanceValue(v);
}

/** Readings that are known to be partial for a metric, said in a few words. */
const NOTE: Record<string, Partial<Record<string, string>>> = {
  hoodscan: { top10SharePct: "swap-index only", top1SharePct: "swap-index only", holderCount: "swap-index only" },
};

/** "scored: on-chain 17.9% · HoodScan 53.2% (swap-index only)", with each reading's time. */
function Readings({ metric, values, chosenSource }: { metric: string; values: Provenance[]; chosenSource?: string | null }) {
  const ordered = [...values].sort((a, b) => Number(b.source === chosenSource) - Number(a.source === chosenSource));
  return (
    <p className="break-words" data-testid="readings">
      <span className="font-bold">scored:</span>{" "}
      {ordered.map((v, i) => {
        const scored = v.source === chosenSource || (!chosenSource && i === 0);
        const note = NOTE[v.source]?.[metric];
        return (
          <span key={v.source} className={scored ? "" : "text-muted"} data-source={v.source} data-scored={scored || undefined}>
            {i > 0 && " · "}
            <span className={scored ? "font-bold" : ""}>{v.onchain && scored ? "on-chain" : v.label}</span> <span className="font-mono tabular-nums">{fmtValue(metric, v.value)}</span>
            {note && ` (${note})`}
            {v.stale && " (stale)"} <span className="text-muted" data-testid="reading-time">{v.fetchedAt.slice(11, 19)} UTC</span>
          </span>
        );
      })}
    </p>
  );
}

const points = (f: FactorResult) => (f.applicable && !f.missing ? `${+f.points.toFixed(2)}/${f.max}` : "—");

/** One line per factor: dot · name · value · points/max · optional ≠ / stale. Click to expand the evidence. */
function FactorRow({ f, ctx }: { f: FactorResult; ctx: Ctx }) {
  const sev = factorSeverity(f, ctx.hit);
  const disputed = f.applicable && f.verification?.status === "disputed";
  const resolution = ctx.metrics.get(f.metric);
  const guide = f.source === "guide" && f.note ? `guide ${f.note.split(":")[0]}` : null;
  return (
    <li className="mm-rule-t first:border-t-0" data-testid="factor-row" data-factor={f.id} data-status={f.status} data-severity={sev ?? "none"}>
      <details data-row>
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--neon)_16%,transparent)]">
          <span className={`mm-dot ${sev ? SEV[sev] : "mm-dot-none"}`} role="img" aria-label={sev ? BAND_WORD[sev] : "not rated"} />
          <span className={`min-w-0 flex-1 truncate font-bold ${f.applicable ? "" : "text-muted"}`}>{f.label}</span>
          <span className="max-w-[7.5rem] shrink-0 truncate font-mono tabular-nums" title={f.display} data-testid="factor-value">
            {f.applicable ? (f.missing ? "no data" : f.display) : "n/a"}
          </span>
          <span className="w-12 shrink-0 text-right font-mono tabular-nums" data-testid="factor-points">
            {points(f)}
          </span>
          {disputed && (
            <Chip sev={disputeLook(ctx.bandMoved.has(f.id))} testId="disputed-badge" title={`${f.verification!.values.length} sources differ`}>
              ≠<span className="sr-only"> {f.verification!.values.length} sources differ</span>
            </Chip>
          )}
          {f.status === "stale" && f.stale && <StaleBadge age={f.stale} />}
        </summary>
        <div className="space-y-1.5 px-3 pb-3 pl-8 text-xs" data-testid="row-detail">
          <p className="break-words">{f.evidence}</p>
          {f.status === "null" && (
            <p className="break-words text-muted" data-testid="null-reason">
              no data — {f.nullReason}
            </p>
          )}
          {f.verification && f.verification.values.length > 0 && <Readings metric={f.metric} values={f.verification.values} chosenSource={resolution?.chosenSource} />}
          {disputed && (
            <div data-testid="disputed-values" className="text-muted">
              {ctx.bandMoved.has(f.id) ? "Sources differ, and another reading would change this factor's colour." : "Sources differ; the conservative reading is scored."}
            </div>
          )}
          {f.applicable && (
            <p className="break-words text-muted" data-testid="factor-source">
              sources: {f.dataSources.join(" / ") || "—"}
              {guide && ` · ${guide}`}
            </p>
          )}
        </div>
      </details>
    </li>
  );
}

function ScoreBar({ pct, sev }: { pct: number; sev: Severity | null }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className="relative mt-2 h-2 border border-[var(--ink)]" aria-hidden="true" data-testid="score-bar" data-severity={sev ?? "none"}>
      {sev && <div className={`h-full ${SEV_FILL[sev]}`} style={{ width: `${w}%` }} />}
    </div>
  );
}

function GroupCard({ g, ctx }: { g: GroupResult; ctx: Ctx }) {
  const pct = g.max > 0 ? (g.points / g.max) * 100 : 0;
  // Gate-only basics live in the Gates row, not in the factor lists.
  const rows = g.factors.filter((f) => !f.basic);
  return (
    <section className="mm-box flex min-w-0 flex-col" data-testid="group-card" data-group={g.id} aria-label={g.label}>
      <header className="mm-rule-b p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="mm-display-sm min-w-0 text-lg leading-tight">{g.label}</h3>
          <span className="shrink-0 font-mono text-xs tabular-nums">{g.hasData ? `${Math.round(pct)}%` : "no data"}</span>
        </div>
        <ScoreBar pct={g.hasData ? pct : 0} sev={groupSeverity(g)} />
      </header>
      <ul>
        {rows.map((f) => (
          <FactorRow key={f.id} f={f} ctx={ctx} />
        ))}
      </ul>
    </section>
  );
}

/** Research view: the Verification column — counts, every disagreement, every cross-checked metric. */
function VerificationCard({ v }: { v: VerificationSummary | undefined }) {
  const disputed = v?.metrics.filter((m) => m.status === "disputed") ?? [];
  const total = v ? v.verified + v.single + v.disputed : 0;
  return (
    <section className="mm-box mm-research flex min-w-0 flex-col" data-testid="group-card" data-group="verification" aria-labelledby="verify-heading">
      <div className="flex min-w-0 flex-col" data-testid="verification-strip">
        <header className="mm-rule-b p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h3 id="verify-heading" className="mm-display-sm min-w-0 text-lg leading-tight">
              Verification
            </h3>
            <span className="shrink-0 font-mono text-xs tabular-nums">{total ? `${v!.verified}/${total} agree` : "no cross-checks"}</span>
          </div>
          <ScoreBar pct={total ? (v!.verified / total) * 100 : 0} sev={total ? "ok" : null} />
        </header>
        {v ? (
          <div className="space-y-3 p-3 text-xs">
            <p className="flex flex-wrap gap-x-4 gap-y-1">
              <span data-testid="verified-count">
                <span className="font-mono font-bold">{v.verified}</span> verified by ≥2 sources
              </span>
              <span data-testid="single-count">
                <span className="font-mono font-bold">{v.single}</span> single-source
              </span>
              <span data-testid="disputed-count">
                <span className="font-mono font-bold">{v.disputed}</span> disputed
              </span>
            </p>
            {disputed.length > 0 && (
              <ul className="space-y-3">
                {disputed.map((m) => (
                  <li key={m.metric} data-testid="disputed-metric" data-metric={m.metric}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-bold">{m.label}</span>
                      <Chip sev="muted">≠ differ</Chip>
                    </span>
                    <Readings metric={m.metric} values={m.values} chosenSource={m.chosenSource} />
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary className="cursor-pointer">
                <span className="mm-plus" aria-hidden="true" /> Every cross-checked metric ({v.metrics.length})
              </summary>
              <ul className="mt-2 space-y-2">
                {v.metrics.map((m) => (
                  <li key={m.metric} data-status={m.status}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-bold">{m.label}</span>
                      <Chip sev={m.status === "disputed" ? "muted" : "ok"}>{m.status === "verified" ? "agree" : m.status === "single" ? "1 source" : "≠ differ"}</Chip>
                    </span>
                    <Readings metric={m.metric} values={m.values} chosenSource={m.chosenSource} />
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ) : (
          <p className="p-3 text-xs text-muted">No metric was reported by two or more sources in this run.</p>
        )}
      </div>
    </section>
  );
}

/** Diamond / Strong read green, Mixed neutral, Weak orange, Paper red — the severity scale every other bar uses. */
function strengthSeverity(label: string | null): Severity | null {
  if (!label) return null;
  return label === "Diamond" || label === "Strong" ? "good" : label === "Mixed" ? "ok" : label === "Weak" ? "warn" : "bad";
}

/** The HOLDER STRENGTH tile beside the hero stats: label, 0–100 bar, or why there is no number. */
function StrengthTile({ report }: { report: ScoreReport }) {
  const t = report.token;
  const score = t.holderStrength;
  const sev = strengthSeverity(t.holderStrengthLabel);
  const why = t.nullReasons?.holderStrength;
  const short = report.mode === "launch" ? "too young to measure" : t.holderStrengthPending ? "reading holder histories…" : "no data";
  return (
    <div className="mm-box col-span-2 min-w-0 px-3 py-2 sm:col-span-1" data-testid="holder-strength" data-label={t.holderStrengthLabel ?? "none"} title={score == null ? why : undefined}>
      <div className="text-xs uppercase tracking-wider text-muted">Holder strength</div>
      {score == null ? (
        <div className="truncate text-sm font-bold" data-testid="holder-strength-value">
          — <span className="font-normal text-muted">{short}</span>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2" data-testid="holder-strength-value">
            <span className="truncate font-mono text-base font-bold tabular-nums sm:text-lg">{Math.round(score)}</span>
            {sev && (
              <Chip sev={sev} testId="holder-strength-label">
                {t.holderStrengthLabel}
              </Chip>
            )}
          </div>
          <div
            className="relative mt-1 h-2 border border-[var(--ink)]"
            role="meter"
            aria-label="Holder strength"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(score)}
            aria-valuetext={`${Math.round(score)} of 100, ${t.holderStrengthLabel}`}
            data-testid="holder-strength-bar"
            data-severity={sev ?? "none"}
          >
            {sev && <div className={`h-full ${SEV_FILL[sev]}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />}
          </div>
        </>
      )}
    </div>
  );
}

/** Research view: the three biggest contributors as sentences, key-person holders, and every component's evidence. */
function HolderStrengthDetail({ report }: { report: ScoreReport }) {
  const t = report.token;
  const d = t.holderStrengthDetail;
  if (report.mode === "launch") return null;
  return (
    <section className="mm-box mm-research space-y-3 p-4" aria-labelledby="strength-heading" data-testid="holder-strength-detail">
      <H2 id="strength-heading">
        Holder strength{t.holderStrength != null ? ` · ${Math.round(t.holderStrength)} ${t.holderStrengthLabel}` : ""}
      </H2>
      {t.holderStrength == null && <p className="break-words text-xs">No score — {t.nullReasons?.holderStrength ?? d?.nullReason ?? "not measured"}.</p>}
      {d && d.sentences.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="holder-strength-sentences">
          {d.sentences.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {d && d.keyPerson.length > 0 && (
        <p className="break-words text-xs" data-testid="holder-strength-key-person">
          <span className="font-bold">Key-person risk:</span> {d.keyPerson.join(" · ")}
        </p>
      )}
      {d && (
        <ul className="space-y-1 text-xs" aria-label="Holder strength components">
          {d.components.map((c) => (
            <li key={c.id} className="break-words">
              <span className="font-bold">
                {c.label} ({c.weight})
              </span>
              : {c.score == null ? "—" : `${Math.round(c.score * 100)}%`} — {c.evidence}
            </li>
          ))}
        </ul>
      )}
      {d && <p className="break-words text-xs text-muted">Method: {d.method}{d.excluded.length ? ` · excluded: ${d.excluded.map((e) => `${e.address.slice(0, 8)}… ${e.pct.toFixed(1)}% (${e.why})`).join(", ")}` : ""}</p>}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="mm-box min-w-0 px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className="truncate font-mono text-base font-bold tabular-nums sm:text-lg">{value}</div>
    </div>
  );
}

/**
 * The tier letter in a fixed-ratio block on the severity scale. The skew sits on the inner glyph (its
 * padding absorbs the slant), so nothing clips sideways. An aria-hidden reel climbs F → … → tier,
 * then the real letter (the test target) shows.
 */
function TierLetter({ tier }: { tier: Tier }) {
  const reel = tier === "U" ? [] : TIER_ORDER.slice(0, TIER_ORDER.indexOf(tier) + 1);
  return (
    <div className={`mm-tier ${TIER_LOOK[tier]}`} data-testid="tier-box" data-tier={tier}>
      <span className="mm-tier-glyph mm-reel-final" data-testid="tier-letter">
        {tier}
      </span>
      {reel.length > 1 && (
        <span className="mm-tier-reel-wrap mm-reel-wrap" aria-hidden="true">
          <span className="mm-tier-reel mm-reel block" style={{ "--reel-to": `-${(reel.length - 1) * 1.08}em` } as CSSProperties}>
            {reel.map((l) => (
              <span key={l}>
                <span className="mm-tier-glyph">{l}</span>
              </span>
            ))}
          </span>
        </span>
      )}
    </div>
  );
}

/** "NN.N/100" on one mono line; an aria-hidden integer counter climbs to it on load, then the real value shows. */
function Score({ score }: { score: number | null }) {
  return (
    <div className="mm-score font-mono font-bold tabular-nums" data-testid="score">
      {score == null ? (
        "—"
      ) : (
        <span className="relative inline-block">
          <span className="mm-reel-final">{score.toFixed(1)}</span>
          <span className="mm-count absolute left-0 top-0" style={{ "--mm-to": Math.floor(score) } as CSSProperties} aria-hidden="true" />
        </span>
      )}
      <span className="text-[0.45em] text-muted">/100</span>
    </div>
  );
}

function Hero({ report, cached, cacheAgeSeconds = null, previous }: { report: ScoreReport; cached: boolean; cacheAgeSeconds?: number | null; previous?: ScoreReport }) {
  const t = report.token;
  const staleAges = Object.values(t.staleFields ?? {});
  const staleMax = staleAges.length ? Math.max(...staleAges) : null;
  const staleSources = report.sourceStatus.filter((s) => s.state === "stale").map((s) => s.label);
  const dead = report.tier === "F" && /dead|liquidity removed|buyers exited/i.test(report.binding?.text ?? "");
  const drift = driftSince(previous, report);
  return (
    <section className="space-y-6" aria-labelledby="token-name" data-testid="hero">
      <p className="sr-only">
        {report.tier === "U" ? "Unrated" : `Tier ${report.tier}`}, score {report.score ?? "none"} out of 100.
      </p>
      <div className="flex flex-col gap-6 md:flex-row md:items-end">
        <div className="flex min-w-0 items-end gap-4 sm:gap-5" data-testid="hero-score">
          <TierLetter tier={report.tier} />
          <div className="min-w-0 space-y-2 pb-1">
            <Score score={report.score} />
            <p className="font-mono text-xs" data-testid="raw-score">
              raw {report.rawScore ?? "—"} · coverage {report.coveragePct != null ? `${report.coveragePct}%` : "—"}
            </p>
            {report.hold && (
              <p className="font-mono text-xs" data-testid="tier-held" title={`${report.hold.factors.join(", ")} missing — this run alone reads ${report.hold.liveTier} ${report.hold.liveScore ?? "—"}`}>
                <Chip sev="muted" testId="held-chip">
                  {report.hold.rescored ? "re-scored with last values (source down)" : "unchanged (source down)"}
                </Chip> · {report.hold.rescored ? "previous run" : "from"} {report.hold.minutesAgo}m ago · live {report.hold.liveTier}{" "}
                {report.hold.liveScore ?? "—"}
              </p>
            )}
            {report.hysteresis && (
              <p
                className="font-mono text-xs"
                data-testid="tier-hysteresis"
                title={`This score alone maps to ${report.hysteresis.liveTier}. It sits within ±${report.hysteresis.margin} of the ${report.hysteresis.line} line, so the previous analysis's tier is kept until it moves further.`}
              >
                <Chip sev="muted" testId="hysteresis-chip">
                  held near the {report.hysteresis.line} line
                </Chip>{" "}
                · from {report.hysteresis.minutesAgo}m ago · alone {report.hysteresis.liveTier}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              <Tag testId="mode-badge" on={report.mode === "launch"}>
                {report.modeLabel}
              </Tag>
              <Tag>{CHAIN_LABEL[report.chain]}</Tag>
              {dead && <Tag on>dead</Tag>}
            </div>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3 md:pb-2">
          <h1 id="token-name" className="mm-display break-words text-5xl sm:text-6xl lg:text-7xl">
            {t.name ?? "Unknown token"}
            {t.symbol && <span className="ml-3 align-baseline font-mono text-lg normal-case text-muted [transform:none]">${t.symbol}</span>}
          </h1>
          <CopyAddress address={report.address} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Age" value={t.ageHours != null ? formatAge(t.ageHours) : "—"} />
        <Stat label="Price" value={formatPrice(t.priceUsd)} />
        <Stat label="FDV" value={formatCompactUsd(t.fdvUsd)} />
        <Stat label="Liquidity" value={formatCompactUsd(t.liquidityUsd)} />
        <StrengthTile report={report} />
      </div>
      <div className="space-y-2">
        <p className="text-base font-bold" data-testid="verdict" title={report.verdict}>
          {shortVerdict(report.verdict)}
        </p>
        {drift.length > 0 && (
          <p className="break-words text-xs" data-testid="drift">
            <span className="font-bold">changed since last run:</span>{" "}
            {drift.map((d, i) => (
              <span key={d.id} data-testid="drift-item">
                {i > 0 && " · "}
                {d.label} {d.from} → {d.to}
              </span>
            ))}
          </p>
        )}
        {staleMax != null && (
          <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="stale-notice">
            <StaleBadge age={formatStaleAge(staleMax)} testId="stale-headline" />
            {staleAges.length} values come from the last good {staleSources.join(", ") || "source"} snapshot (live calls failed). They are still scored.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <CopyLink />
          <Suspense fallback={null}>
            <RetrySources />
          </Suspense>
          <span className="text-xs text-muted" data-testid="generated-at">
            {cached ? "cached · " : ""}generated {utcTime(report.generatedAt)}
            {cached && cacheAgeSeconds != null ? ` (${cacheAgeSeconds < 60 ? `${cacheAgeSeconds}s` : formatStaleAge(Math.floor(cacheAgeSeconds / 60))} ago)` : ""}
          </span>
        </div>
      </div>
    </section>
  );
}

const LEAN_LABEL = { conviction: "conviction holders", churn: "churn", mixed: "mixed: conviction and churn", unknown: "conviction vs churn: not enough data" } as const;

/** The four-colour key, behind a "?" next to "Why this tier". */
function Legend() {
  return (
    // Below 640px the key spans the "Why this tier" box (its positioned ancestor) instead of hanging off the "?",
    // which pushed it past the right edge of a 360px screen, where it was cut off.
    <details className="inline-block align-middle sm:relative" data-testid="legend-toggle">
      <summary className="mm-pill inline-grid h-6 w-6 cursor-pointer place-items-center text-xs font-bold" aria-label="Colour key">
        ?
      </summary>
      <div className="mm-box absolute inset-x-4 z-30 mt-2 space-y-1.5 bg-paper p-3 text-xs sm:inset-x-auto sm:left-0 sm:top-8 sm:mt-0 sm:w-[min(20rem,80vw)]" data-testid="severity-legend">
        <p className="flex items-center gap-2">
          <Chip sev="good">good</Chip> ≥ 80% of the factor&apos;s points
        </p>
        <p className="flex items-center gap-2">
          <Chip sev="ok">fair</Chip> 40–80%
        </p>
        <p className="flex items-center gap-2">
          <Chip sev="warn">weak</Chip> under 40%
        </p>
        <p className="flex items-center gap-2">
          <Chip sev="bad">failing</Chip> 0 points, or a gate / cap / penalty fired on it
        </p>
        <p className="flex items-center gap-2 text-muted">
          <Chip sev="muted">≠</Chip> sources differ — orange only when it moves the colour
        </p>
      </div>
    </details>
  );
}

function WhyThisTier({ report }: { report: ScoreReport }) {
  const s = summarize(report);
  const lines = whyLines(report);
  const ver = verificationLine(report);
  return (
    <section className="space-y-2" id="why" aria-labelledby="why-heading">
      <div className="mm-box relative space-y-3 p-4 sm:p-6" data-testid="short-reasons">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <h2 id="why-heading" className="min-w-0" data-testid="why-tier" data-kind={report.binding?.kind}>
              <span className="mm-display-sm block text-xl sm:text-2xl">Why this tier{report.binding ? ":" : ""}</span>
              {report.binding && <strong className="mt-1 block break-words font-mono text-base">{report.binding.text}</strong>}
            </h2>
            <Legend />
          </div>
          <span data-testid="conviction-label" data-lean={s.conviction.label} className={`mm-pill px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${s.conviction.label === "unknown" ? "border-dashed" : ""}`}>
            {LEAN_LABEL[s.conviction.label]}
          </span>
        </div>
        <ul className="space-y-1.5">
          {lines.map((r) => (
            <li key={r.text} className="flex gap-2 text-sm" data-testid="reason" data-kind={r.kind} data-severity={r.sev}>
              <span className={`inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold ${SEV[r.sev]}`} role="img" aria-label={r.kind === "positive" ? "strength" : r.sev === "bad" ? "binding limit" : "holding it back"}>
                {r.kind === "positive" ? "✓" : "▲"}
              </span>
              <span className="min-w-0 break-words">{r.text}</span>
            </li>
          ))}
        </ul>
        {s.rateLimited.length > 0 && (
          <p className="text-xs font-bold" data-testid="rate-limited">
            Rate-limited this run: {s.rateLimited.join(", ")} — retry in a minute.
          </p>
        )}
      </div>
      {ver && (
        <p className="text-xs text-muted" data-testid="verification-line">
          {ver.crossChecked}/{ver.total} metrics cross-checked · {ver.differ} differ (see research view)
        </p>
      )}
      <TierKey evidence testId="read-key" />
    </section>
  );
}

/** PROS / CONS: 2–4 bullets each, ≤ 12 words, deterministic (components/prosCons.ts). */
function ProsCons({ report }: { report: ScoreReport }) {
  const { pros, cons } = prosCons(report);
  if (!pros.length && !cons.length) return null;
  const col = (title: string, items: typeof pros, testId: string) => (
    <div className="min-w-0 p-4 sm:p-5" data-testid={testId}>
      <h3 className="mm-display-sm text-lg">{title}</h3>
      {items.length ? (
        <ul className="mt-2 space-y-1.5">
          {items.map((p) => (
            <li key={p.text} className="flex gap-2 text-sm" data-testid="procon" data-severity={p.sev} data-from={p.from}>
              <span className={`inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold ${SEV[p.sev]}`} role="img" aria-label={p.sev === "good" ? "pro" : p.sev === "bad" ? "gate or cap" : "con"}>
                {p.sev === "good" ? "✓" : "▲"}
              </span>
              <span className="min-w-0 break-words">{p.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted">Nothing to list from this run&apos;s data.</p>
      )}
    </div>
  );
  return (
    <section className="mm-box grid sm:grid-cols-2 sm:divide-x sm:divide-[var(--ink)]" aria-label="Pros and cons" data-testid="pros-cons">
      {col("Pros", pros, "pros")}
      <div className="mm-rule-t sm:border-t-0">{col("Cons", cons, "cons")}</div>
    </section>
  );
}

const CTA_TIERS: Tier[] = ["S", "A", "B"];

/** B and above: a neon panel into the Research view. Below B: one line with the binding constraint. */
function ResearchCta({ report }: { report: ScoreReport }) {
  if (!CTA_TIERS.includes(report.tier)) {
    return (
      <p className="text-sm" data-testid="no-research">
        <span className="font-bold">Not worth deeper research at this score</span>
        {report.binding ? <span className="text-muted"> — {report.binding.text}</span> : null}
      </p>
    );
  }
  return (
    <section className="mm-box flex flex-col gap-3 bg-neon p-4 text-neon-ink sm:flex-row sm:items-center sm:justify-between sm:p-5" data-testid="research-cta" aria-label="Deep research">
      <div className="min-w-0">
        <p className="mm-display-sm text-xl">This one is worth a closer look</p>
        <p className="text-sm">Every source value, disputes, holder lists, clusters, the time machine and manual checks.</p>
      </div>
      <DeepResearchButton />
    </section>
  );
}

/** Research view: top-20 holders, the deployer's history, every pool and the cluster read-out. All from this run's data. */
function ResearchExtras({ report }: { report: ScoreReport }) {
  const holders = holdersTable(report);
  const pools = poolList(report);
  const clusters = clusterSummary(report);
  const num = (v: number | null) => (v == null ? "—" : String(v));
  return (
    <section className="mm-box mm-research space-y-5 p-4" aria-labelledby="holders-heading" data-testid="research-extras">
      <div className="space-y-2">
        <H2 id="holders-heading">Top holders</H2>
        <p className="break-words text-xs" data-testid="deployer-line">
          {deployerLine(report)}
        </p>
        {holders.rows.length ? (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Top 20 holders">
            <table className="w-full min-w-[32rem] text-left font-mono text-xs tabular-nums" data-testid="holders-table">
              <thead>
                <tr className="mm-rule-b">
                  <th className="py-1 pr-3">#</th>
                  <th className="py-1 pr-3">Address</th>
                  <th className="py-1 pr-3 text-right">%</th>
                  <th className="py-1 pr-3 text-right">Buys / sells</th>
                  <th className="py-1 pr-3">First seen</th>
                  <th className="py-1">Cluster</th>
                </tr>
              </thead>
              <tbody>
                {holders.rows.map((h, i) => (
                  <tr key={h.address} data-testid="holder-row">
                    <td className="py-0.5 pr-3 text-muted">{i + 1}</td>
                    <td className="py-0.5 pr-3" title={h.address}>
                      {short(h.address)}
                    </td>
                    <td className="py-0.5 pr-3 text-right">{h.pct != null ? `${h.pct.toFixed(2)}%` : "—"}</td>
                    <td className="py-0.5 pr-3 text-right">
                      {num(h.buys)} / {num(h.sells)}
                    </td>
                    <td className="py-0.5 pr-3">{h.firstSeen ? `${h.firstSeen.slice(0, 16).replace("T", " ")}Z` : "—"}</td>
                    <td className="py-0.5">{h.cluster ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted">No holder list from any source this run.</p>
        )}
        {(holders.firstSeenNote || holders.clusterNote) && (
          <p className="text-xs text-muted">
            {holders.firstSeenNote && <>First seen: {holders.firstSeenNote}. </>}
            {holders.clusterNote && <>Cluster tags: {holders.clusterNote}.</>}
          </p>
        )}
      </div>
      <div className="space-y-1" data-testid="cluster-summary">
        <h3 className="mm-display-sm text-lg">Clusters</h3>
        <ul className="space-y-0.5 text-xs">
          {clusters.map((c) => (
            <li key={c} className="break-words">
              {c}
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-1">
        <h3 className="mm-display-sm text-lg">Pools ({pools.length})</h3>
        {pools.length ? (
          <ul className="space-y-0.5 font-mono text-xs" data-testid="pool-list">
            {pools.slice(0, 25).map((p) => (
              <li key={p.address} className="flex justify-between gap-3" data-testid="pool-row">
                <span className="min-w-0 truncate" title={p.address}>
                  {p.name ?? short(p.address)} <span className="text-muted">{p.dex ? `· ${p.dex}` : ""} · {p.source}</span>
                </span>
                <span className="shrink-0 tabular-nums">{poolLiquidity(p)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No pools listed by GeckoTerminal or DexScreener this run.</p>
        )}
      </div>
    </section>
  );
}

/** One row of pills, one per check: gates with their matching basics merged in. n/a checks show only in the research view. */
function Gates({ report }: { report: ScoreReport }) {
  const unmet = report.requirements.filter((r) => r.state !== "pass");
  const checks = mergedChecks(report);
  const MARK = { pass: "✓", fail: "✗", unknown: "?", "n/a": "–" } as const;
  return (
    <section className="space-y-3" aria-labelledby="gates-heading">
      <H2 id="gates-heading">Gates</H2>
      <ul className="flex flex-wrap gap-2" aria-label="Gates">
        {checks.map((c) => (
          <li
            key={c.id}
            title={c.evidence.join(" · ")}
            data-testid="gate-pill"
            data-check={c.id}
            data-state={c.state}
            data-severity={CHECK_SEVERITY[c.state]}
            className={`rounded-full px-3 py-1 text-xs font-bold ${SEV[CHECK_SEVERITY[c.state]]} ${c.state === "n/a" ? "mm-research" : ""}`}
          >
            {MARK[c.state]} {c.label}
          </li>
        ))}
      </ul>
      <details className="mm-research text-xs">
        <summary className="cursor-pointer">
          <span className="mm-plus" aria-hidden="true" /> Evidence for every check ({checks.length})
        </summary>
        <ul className="mt-2 space-y-1">
          {checks.map((c) => (
            <li key={c.id} className="break-words">
              <span className="font-bold">{c.label}</span> · {c.state} — <span className="text-muted">{c.evidence.join(" · ")}</span>
            </li>
          ))}
        </ul>
      </details>
      {unmet.length > 0 && report.tier !== "F" && (
        <details className="text-xs">
          <summary className="cursor-pointer">
            <span className="mm-plus" aria-hidden="true" /> What&apos;s missing for a higher tier ({unmet.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {unmet.map((r) => (
              <li key={r.id}>
                <span className="font-bold">{r.tier}</span> needs {r.label} — <span className="text-muted">{r.evidence}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function RuleLine({ r }: { r: RuleResult }) {
  const sev = ruleSeverity(r);
  const pts = r.points ? (r.points > 0 ? `−${r.points}` : `+${-r.points}`) : null;
  return (
    <li className={`mm-rule-t grid gap-1 py-2 pl-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4 sev-rule-${sev}`} data-testid="fired-rule" data-rule={r.id} data-severity={sev}>
      <span className="min-w-0">
        <span className="font-bold">{r.label}</span>
        <span className="block break-words text-xs text-muted">{r.evidence}</span>
      </span>
      <span className="flex flex-wrap gap-x-3 font-mono text-xs sm:justify-end sm:text-right">
        {r.forceF && <span className="font-bold">→ F</span>}
        {r.capTier && <span>cap {r.capTier}</span>}
        {pts && <span>{pts} pts</span>}
        {r.source === "guide" && r.note && <span className="text-muted">guide {r.note}</span>}
      </span>
    </li>
  );
}

/** "Largest holder: founder wallet (deployer), 61.1%, 0 sells in 116d" — the top-holder classification. */
function LargestHolder({ report }: { report: ScoreReport }) {
  const t = report.token;
  const line = largestHolderLine(t.largestHolder);
  const others = (t.holderClasses ?? []).filter((h) => h.address !== t.largestHolder?.address);
  if (!line) return null;
  return (
    <details className="mm-box p-4" data-testid="largest-holder" data-class={t.largestHolder!.class}>
      <summary className="cursor-pointer text-sm">
        <span className="mm-plus" aria-hidden="true" /> <span className="font-bold">{line}</span>
      </summary>
      <p className="mt-2 break-words text-xs text-muted">{t.largestHolder!.evidence}</p>
      {t.largestHolder!.fundingTx && (
        <p className="mt-1 break-all text-xs">
          Funding tx:{" "}
          <a className="underline" href={txUrl(report.chain, t.largestHolder!.fundingTx)} target="_blank" rel="noopener noreferrer" data-testid="funding-tx">
            {t.largestHolder!.fundingTx}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}
      {others.length > 0 && (
        <ul className="mt-2 space-y-1 font-mono text-xs" aria-label="Other top holders, classified">
          {others.map((h) => (
            <li key={h.address} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                {h.address} · {h.label}
                {h.detail ? ` · ${h.detail}` : ""}
                {h.counted ? "" : " · excluded"}
              </span>
              <span className="shrink-0 tabular-nums">{h.pct != null ? `${h.pct.toFixed(2)}%` : "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function LiquidityHeld({ report }: { report: ScoreReport }) {
  const t = report.token;
  if (!t.liquidityHolders?.length) return null;
  return (
    <details className="mm-box mm-research p-4" data-testid="liquidity-held">
      <summary className="cursor-pointer text-sm">
        <span className="mm-plus" aria-hidden="true" /> <span className="font-bold">Pool / locker-held supply · {t.liquidityHeldPct != null ? `${t.liquidityHeldPct.toFixed(1)}%` : "—"}</span>
        <span className="text-muted"> in {t.liquidityHolders.length} pools / curves / routers / lockers (excluded from holder math)</span>
      </summary>
      <ul className="mt-2 space-y-1 font-mono text-xs">
        {t.liquidityHolders.slice(0, 12).map((h) => (
          <li key={h.address} className="flex justify-between gap-3">
            <span className="min-w-0 truncate">
              {h.address}
              {h.label ? ` · ${h.label}` : ""}
            </span>
            <span className="shrink-0 tabular-nums">{h.pct != null ? `${h.pct.toFixed(2)}%` : "—"}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function FakeSignals({ report }: { report: ScoreReport }) {
  const t = report.token;
  return (
    <section className="mm-box mm-research p-4" aria-labelledby="fake-heading">
      <H2 id="fake-heading">Fake / manipulation signals</H2>
      {report.fakeSignals.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No wash, bundle, bot or insider patterns detected in the available data.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {report.fakeSignals.map((s, i) => {
            const sev = fakeSignalSeverity(s);
            return (
              <li key={i} className="flex items-start gap-2 text-sm" data-testid="fake-signal" data-severity={sev}>
                <Chip sev={sev}>{s.level === "none" ? "ok" : s.level}</Chip>
                <span className="min-w-0 break-words">
                  {s.text} <span className="text-xs text-muted">· {s.source}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {t.patterns.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer">
            <span className="mm-plus" aria-hidden="true" /> Chart-pattern audit ({t.patterns.length} detections)
          </summary>
          <ul className="mt-2 space-y-1.5">
            {t.patterns.map((p) => (
              <li key={p.id} className="break-words">
                <span className="font-bold">{p.id}</span> = {p.result === null ? "n/a" : String(p.result)} — {p.detail}{" "}
                <span className="text-muted">
                  [{p.candles} × {p.timeframe}
                  {p.from ? `, ${p.from.slice(0, 16)}Z → ${p.to?.slice(0, 16)}Z` : ""}]
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Sources and their status are printed on every result page (CLAUDE.md), in both views. */
function Sources({ report }: { report: ScoreReport }) {
  return (
    <section className="mm-box p-4" data-testid="sources" aria-labelledby="sources-heading">
      <H2 id="sources-heading">Sources</H2>
      <ul className="mt-3">
        {report.sourceStatus.map((s) => (
          <li key={s.id} className="mm-rule-t grid gap-x-3 py-2 text-sm first:border-t-0 sm:grid-cols-[10rem_5.5rem_minmax(0,1fr)_4.5rem]" data-testid="source-row" data-source={s.id} data-state={s.state}>
            <span className="font-bold">
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer" className="mm-link">
                  {brand(s.label)}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                brand(s.label)
              )}
            </span>
            <span>
              <Chip sev={SOURCE_SEVERITY[s.state]}>{s.state}</Chip>
            </span>
            <span className="min-w-0 break-words text-xs text-muted">
              <span className="mm-clamp-verdict" title={s.message}>{s.message ?? ""}</span>
              {s.flags?.map((f) => (
                <span key={f} className="block font-bold text-ink" data-testid="source-flag">
                  ⚠ {f}
                </span>
              ))}
            </span>
            <span className="font-mono text-xs tabular-nums sm:text-right">{s.ms != null ? `${s.ms}ms` : ""}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {dedupeLinks(report.token.links, report).map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="mm-link inline-block py-1.5">
            {l.label} <span aria-hidden="true">↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ))}
      </div>
    </section>
  );
}

/** Mobile only: tier · score · the binding constraint, pinned to the bottom edge. */
function StickyBar({ report }: { report: ScoreReport }) {
  return (
    <a href="#why" className="mm-rule-t fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 bg-paper px-4 py-2 sm:hidden" data-testid="sticky-bar">
      <span className="sr-only">Why this tier: </span>
      <span className={`mm-display-sm flex h-9 w-9 shrink-0 items-center justify-center text-2xl ${TIER_LOOK[report.tier]}`}>{report.tier}</span>
      <span className="shrink-0 font-mono text-lg font-bold tabular-nums">{report.score ?? "—"}</span>
      <span className="min-w-0 truncate text-xs">{report.binding?.text ?? report.verdict}</span>
    </a>
  );
}

function safeBandMoves(report: ScoreReport): Set<string> {
  try {
    return bandMovingDisputes(report);
  } catch {
    // Display-only re-scoring: if it cannot run, every dispute chip stays grey.
    return new Set();
  }
}

export default function Report({ report, cached = false, cacheAgeSeconds = null, previous, rawInline = false }: { report: ScoreReport; cached?: boolean; cacheAgeSeconds?: number | null; previous?: ScoreReport; rawInline?: boolean }) {
  const fired = report.rules.filter((r) => r.state === "fired");
  if (report.eligibility && !report.eligibility.meme) {
    const rejected = brand(report.eligibility.rejected ?? "Not rated — HoodTier scores memecoins only");
    return <StateBlock testId="not-a-meme" word={rejectWord(rejected)} title={rejected} reason={`${report.token.name ?? "This token"}: ${report.eligibility.reason}.`} address={report.address} />;
  }
  const ctx: Ctx = { hit: hitMetrics(report), bandMoved: safeBandMoves(report), metrics: new Map((report.verification?.metrics ?? []).map((m) => [m.metric, m])) };
  // Point-carrying groups only: gate-only basics are pills in the Gates row.
  const groups = report.groups.filter((g) => g.weight > 0);
  return (
    <article className="space-y-10">
      <RememberSearch chain={report.chain} address={report.address} symbol={report.token.symbol} tier={report.tier} score={report.score} />
      <div className="flex justify-end">
        <ResearchToggle />
      </div>
      <Hero report={report} cached={cached} cacheAgeSeconds={cacheAgeSeconds} previous={previous} />
      <WhyThisTier report={report} />
      <ProsCons report={report} />
      {report.social && <SocialPanel social={report.social} generatedAt={report.generatedAt} />}
      <ResearchCta report={report} />
      <Gates report={report} />

      {fired.length > 0 && (
        <section className={`mm-box mm-research p-4 sev-rule-${worst(...fired.map(ruleSeverity))}`} aria-labelledby="rules-heading">
          <H2 id="rules-heading">Rules triggered</H2>
          <ul className="mt-2">
            {fired.map((r) => (
              <RuleLine key={r.id} r={r} />
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-4" aria-label="Factor groups">
        <div className="mm-grid">
          {groups.map((g) => (
            <GroupCard key={g.id} g={g} ctx={ctx} />
          ))}
          <VerificationCard v={report.verification} />
        </div>
        <LargestHolder report={report} />
        <ClusterMeter report={report} />
        <HolderStrengthDetail report={report} />
        <LiquidityHeld report={report} />
      </section>
      <ResearchExtras report={report} />

      <FakeSignals report={report} />
      <div className="mm-research">
        <ManualChecks chain={report.chain} address={report.address} checks={report.manualChecks} />
      </div>
      {report.timeMachine && (
        <div className="mm-research">
          <TimeMachine tm={report.timeMachine} />
        </div>
      )}
      <Sources report={report} />

      {/* Loaded on demand from the result cache; recorded fixtures (no cache entry) pass theirs inline. */}
      <RawData chain={report.chain} address={report.address} inline={rawInline ? { snapshot: report.token, raw: report.raw } : undefined} />

      <p className="text-center text-xs text-muted">Generated {Number.isNaN(Date.parse(report.generatedAt)) ? "at an unknown time" : new Date(report.generatedAt).toUTCString()} · cached 2 min · not investment advice</p>
      <StickyBar report={report} />
    </article>
  );
}

function dedupeLinks(links: { label: string; url: string }[], report: ScoreReport) {
  const out = [...links];
  if (report.chain === "solana") out.push({ label: "Solscan", url: `https://solscan.io/token/${report.address}` });
  else if (report.chain === "base") out.push({ label: "Basescan", url: `https://basescan.org/token/${report.address}` });
  else if (report.chain === "ethereum") out.push({ label: "Etherscan", url: `https://etherscan.io/token/${report.address}` });
  else if (report.chain === "monad") {
    out.push({ label: "MonadVision", url: `https://monadvision.com/token/${report.address}` });
    out.push({ label: "Monadscan", url: `https://monadscan.com/token/${report.address}` });
  } else {
    out.push({ label: "Blockscout (explorer)", url: `https://robinhoodchain.blockscout.com/token/${report.address}` });
    out.push({ label: "ScanHood", url: "https://scanhood.xyz/scanner" });
  }
  const seen = new Set<string>();
  return out.filter((l) => (seen.has(l.label) ? false : (seen.add(l.label), true)));
}
