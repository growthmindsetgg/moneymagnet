import type { SocialPanel as Panel } from "@/lib/social";
import { STAGE_NAME, type Stage } from "@/lib/social/stage";

const STAGES: Stage[] = [0, 1, 2, 3, 4, 5];
const nf = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const n = (v: number | null) => (v == null ? "—" : nf.format(v));

function ago(iso: string | null, now: number): string {
  if (!iso) return "—";
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 90 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function arrow(slope: number | null): string {
  if (slope == null) return "";
  if (!Number.isFinite(slope)) return " ↑";
  return slope >= 0.25 ? " ↑" : slope <= -0.25 ? " ↓" : " →";
}

/** Dial 0–5: the current stage is neon, the others outlined. */
function Dial({ stage }: { stage: Stage | null }) {
  return (
    <ol className="flex gap-1" aria-label={stage == null ? "Social stage: no data" : `Social stage ${stage} of 5, ${STAGE_NAME[stage]}`} data-testid="stage-dial">
      {STAGES.map((s) => (
        <li
          key={s}
          data-on={s === stage}
          title={`${s} — ${STAGE_NAME[s]}`}
          className={`grid h-8 w-8 place-items-center border-2 border-[var(--ink)] font-mono text-sm font-bold ${s === stage ? "bg-neon text-neon-ink" : "text-muted"}`}
        >
          {s}
        </li>
      ))}
    </ol>
  );
}

/** 30-day sparkline of M (posts or posters per 24h). */
function Sparkline({ points }: { points: { ts: string; m: number }[] }) {
  if (points.length < 2) return <p className="text-xs text-muted" data-testid="social-spark-empty">{points.length ? "1 sample so far — the line starts at the second" : "no samples yet"}</p>;
  const t = points.map((p) => Date.parse(p.ts));
  const t0 = Math.min(...t);
  const t1 = Math.max(...t);
  const max = Math.max(1, ...points.map((p) => p.m));
  const d = points.map((p, i) => `${i ? "L" : "M"}${(((t[i] - t0) / Math.max(1, t1 - t0)) * 200).toFixed(1)},${(40 - (p.m / max) * 36 - 2).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 200 40" className="h-10 w-full max-w-[16rem]" role="img" aria-label={`Posts per 24h over ${points.length} samples, peak ${Math.round(max)}`} data-testid="social-spark">
      <path d={d} fill="none" stroke="var(--ink)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function SocialPanel({ social, generatedAt }: { social: Panel; generatedAt: string }) {
  const now = Number.isNaN(Date.parse(generatedAt)) ? Date.now() : Date.parse(generatedAt);
  const st = social.stage;
  const r = social.nullReasons;
  const used = social.sources.filter((s) => s.state === "ok" || s.state === "partial").map((s) => s.label);
  return (
    <section className="mm-box space-y-4 p-4 sm:p-6" aria-labelledby="social-heading" data-testid="social-panel" data-stage={st?.stage ?? "none"} data-early={st?.earlyRead ? "1" : undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="social-heading" className="mm-display-sm text-xl sm:text-2xl">
          Social
        </h2>
        <span className="text-xs text-muted">information only — not in the score</span>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Dial stage={st?.stage ?? null} />
        <div className="min-w-0 space-y-1">
          <p className="font-bold" data-testid="social-verdict">
            {social.verdict ?? `No stage — ${r.stage ?? "no post counts"}`}
          </p>
          {social.badge && (
            <p className="flex flex-wrap items-center gap-2 font-mono text-xs" data-testid="social-badge">
              {social.badge}
              {st?.earlyRead && (
                <span className="rounded-full border border-dashed border-[var(--ink)] px-2 py-px text-[10px] font-bold uppercase tracking-wider" data-testid="early-read">
                  early read
                </span>
              )}
            </p>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="uppercase tracking-wider text-muted">Size</dt>
          <dd className="font-mono text-sm font-bold">{social.size ?? "—"}</dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-muted">Quality</dt>
          <dd className="font-mono text-sm font-bold" data-testid="social-quality">
            {social.quality.score ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-muted">{social.uniquePosters24h != null ? "Unique posters 24h" : "Posts 24h"}</dt>
          <dd className="font-mono text-sm font-bold" title={social.uniquePosters24h == null ? r.uniquePosters24h : undefined} data-testid="social-m">
            {social.uniquePosters24h != null ? n(social.uniquePosters24h) : n(social.posts24h)}
            {st && !st.earlyRead ? arrow(st.slope6) : ""}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-muted">Last sample</dt>
          <dd className="font-mono text-sm font-bold">{ago(social.lastSampleAt, now)}</dd>
        </div>
      </dl>
      <Sparkline points={social.series} />
      {social.warnings.length > 0 && (
        <ul className="space-y-1" data-testid="social-warnings">
          {social.warnings.map((w) => (
            <li key={w.id} className="flex gap-2 text-sm" data-testid="social-warning" data-warning={w.id}>
              <span className="sev-warn inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold" aria-label="warning">
                ▲
              </span>
              <span className="min-w-0 break-words">
                {w.text} <span className="text-xs text-muted">({w.note})</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 text-xs sm:grid-cols-2">
        <div className="space-y-1">
          <p>
            <span className="font-bold">First call:</span>{" "}
            {social.firstCallAt ? (
              <>
                @{social.firstCallHandle} · {social.firstCallAt.slice(0, 16).replace("T", " ")}Z
                {social.firstCallVsLaunchMin != null && <> · {social.firstCallVsLaunchMin >= 0 ? `${social.firstCallVsLaunchMin} min after launch` : `${-social.firstCallVsLaunchMin} min before launch`}</>}
              </>
            ) : (
              <span className="text-muted">no data — {r.firstCall}</span>
            )}
          </p>
          <p>
            <span className="font-bold">Sentiment:</span> {social.sentiment ? `${social.sentiment.posPct}% + · ${social.sentiment.negPct}% − · ${social.sentiment.neuPct}% neutral` : <span className="text-muted">no data — {r.sentiment}</span>}
          </p>
          <p>
            <span className="font-bold">Bot share:</span> {social.botShare != null ? `${Math.round(social.botShare * 100)}%` : <span className="text-muted">no data — {r.botShare}</span>}
          </p>
        </div>
        <div className="space-y-1">
          <p className="font-bold">Top accounts by followers{social.postersBasis ? <span className="font-normal text-muted"> ({social.postersBasis})</span> : null}</p>
          {social.topAccounts.length ? (
            <ul className="font-mono" data-testid="top-accounts">
              {social.topAccounts.map((a) => (
                <li key={a.handle} className="flex justify-between gap-3">
                  <span className="truncate">@{a.handle}</span>
                  <span className="tabular-nums">{n(a.followers)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">no data — {r.topAccounts}</p>
          )}
        </div>
      </div>
      <p className="text-xs" data-testid="social-tm">
        <span className="font-bold">Time Machine:</span> {social.timeMachine.line ?? <span className="text-muted">no data — {social.timeMachine.reason}</span>}
        {social.timeMachine.nearest && (
          <span className="text-muted">
            {" "}
            · nearest: {social.timeMachine.nearest.name} ({social.timeMachine.nearest.kind}, distance {social.timeMachine.nearest.distance})
          </span>
        )}
      </p>
      <p className="text-xs text-muted" data-testid="social-sources">
        sources used: {used.length ? used.join(", ") : "none answered"} · {social.samples} sample{social.samples === 1 ? "" : "s"} in our series
        {social.links.x ? (
          <>
            {" "}
            ·{" "}
            <a href={social.links.x} target="_blank" rel="noreferrer" className="mm-link">
              official X
            </a>
          </>
        ) : null}
        {social.links.telegram ? (
          <>
            {" "}
            ·{" "}
            <a href={social.links.telegram} target="_blank" rel="noreferrer" className="mm-link">
              Telegram
            </a>
          </>
        ) : null}
      </p>
      <details className="mm-research text-xs" data-testid="social-research">
        <summary className="cursor-pointer">
          <span className="mm-plus" aria-hidden="true" /> Posters, quality parts and source calls
        </summary>
        <div className="mt-2 space-y-3">
          {social.posters.length ? (
            <table className="w-full text-left font-mono tabular-nums" data-testid="posters-table">
              <thead>
                <tr className="mm-rule-b">
                  <th className="py-1 pr-3">Handle</th>
                  <th className="py-1 pr-3 text-right">Followers</th>
                  <th className="py-1">First post</th>
                </tr>
              </thead>
              <tbody>
                {social.posters.map((p) => (
                  <tr key={p.handle}>
                    <td className="py-0.5 pr-3">@{p.handle}</td>
                    <td className="py-0.5 pr-3 text-right">{n(p.followers)}</td>
                    <td className="py-0.5">{p.firstPostAt ? `${p.firstPostAt.slice(0, 16).replace("T", " ")}Z` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-muted">No poster list — {r.topAccounts}</p>
          )}
          <ul className="space-y-0.5">
            {social.quality.parts.map((p) => (
              <li key={p.id}>
                <span className="font-bold">{p.label}</span> ({p.weight}) — {p.value == null ? <span className="text-muted">no data: {p.reason}</span> : `${Math.round(p.value * 100)}%`} <span className="text-muted">· {p.note}</span>
              </li>
            ))}
          </ul>
          {st && (
            <p className="text-muted">
              stage rule: {st.rule} · M now {st.mNow.toFixed(1)}, 6h {st.m6h?.toFixed(1) ?? "—"}, 24h {st.m24h?.toFixed(1) ?? "—"}, peak {st.peak.toFixed(1)} ({st.metric})
            </p>
          )}
          <ul className="space-y-0.5">
            {social.sources.map((s) => (
              <li key={s.id}>
                <span className="font-bold">{s.label}</span> · {s.state} — <span className="text-muted">{s.message}</span>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </section>
  );
}
