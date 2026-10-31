import type { ScoreHistory as History } from "@/lib/scoreHistory";
import { TIER_LOOK } from "./severity";

const CHIP = TIER_LOOK;

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`;
};
const pts = (v: number | null) => (v == null ? "no data" : `${+v.toFixed(2)}`);

function Sparkline({ values }: { values: (number | null)[] }) {
  const known = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (known.length < 2) return null;
  const W = 240;
  const H = 40;
  const xs = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * (W - 4) + 2 : W / 2);
  const ys = (v: number) => H - 2 - (v / 100) * (H - 4);
  const d = known.map(([i, v], k) => `${k ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
  const last = known[known.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-10 w-full max-w-[240px]" role="img" aria-label="Score over time" data-testid="score-sparkline">
      <line x1="0" x2={W} y1={ys(50)} y2={ys(50)} stroke="var(--muted)" strokeDasharray="2 3" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink" />
      <circle cx={xs(last[0])} cy={ys(last[1])} r="2.5" className="fill-neon stroke-[var(--ink)]" />
    </svg>
  );
}

export default function ScoreHistory({ history }: { history: History }) {
  const recent = history.entries.slice(-12);
  const d = history.diff;
  return (
    <section className="mm-box p-4" data-testid="score-history">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="mm-display-sm text-xl sm:text-2xl">Score history</h2>
        <span className="text-xs text-muted">{history.entries.length} scorings</span>
      </div>
      <ol className="mt-2 flex flex-wrap gap-1.5" data-testid="tier-timeline">
        {recent.map((e) => (
          <li key={e.at} className={`rounded-full px-2 py-0.5 text-xs font-bold ${CHIP[e.tier]}`} data-testid="timeline-chip" title={`${e.score ?? "—"} · coverage ${e.coveragePct}% · ${e.mode}`}>
            {e.tier} <span className="font-normal text-muted">{when(e.at)}</span>
          </li>
        ))}
      </ol>
      <div className="mt-2">
        <Sparkline values={recent.map((e) => e.score)} />
      </div>
      {d ? (
        <div className="mt-2 text-xs" data-testid="history-diff">
          <p className="text-muted">
            Since {when(d.from)}: {d.tier ? `tier ${d.tier.from} → ${d.tier.to}` : "tier unchanged"}
            {d.score ? `, score ${d.score.from ?? "—"} → ${d.score.to ?? "—"}` : ", score unchanged"}
            {!d.factors.length && !d.rulesFired.length && !d.rulesCleared.length ? " — no factor moved." : "."}
          </p>
          {d.factors.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {d.factors.map((m) => (
                <li key={m.id} className="break-words" data-testid="moved-factor">
                  <span className="font-medium">{m.label}</span> {pts(m.from)} → {pts(m.to)}
                  {m.from != null && m.to != null && <span className={m.to > m.from ? " font-bold" : " font-bold"}> ({m.to > m.from ? "+" : ""}{+(m.to - m.from).toFixed(2)})</span>}
                </li>
              ))}
            </ul>
          )}
          {(d.rulesFired.length > 0 || d.rulesCleared.length > 0) && (
            <p className="mt-1 break-words">
              {d.rulesFired.length > 0 && <span className="font-bold">rules fired: {d.rulesFired.join(", ")} </span>}
              {d.rulesCleared.length > 0 && <span>rules cleared: {d.rulesCleared.join(", ")}</span>}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted">First scoring of this token — the diff appears from the second one.</p>
      )}
    </section>
  );
}
