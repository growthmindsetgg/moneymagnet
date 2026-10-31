import type { TimeMachineResult } from "@/lib/timemachine";
import { FIELD_LABELS, FIELD_NAMES, type FieldName } from "@/lib/timemachine/types";
import type { Match } from "@/lib/timemachine/similarity";
import { formatCompactUsd } from "@/lib/scoring/format";

const USD: FieldName[] = ["priceUsd", "mcapUsd", "liquidityUsd", "volume24hUsd"];
const PCT: FieldName[] = ["top10SharePct", "earlyRetentionPct", "devBuySharePct", "devSoldPct", "freshWalletSharePct", "drawdownPct"];

function fmt(field: FieldName, v: number | null): string {
  if (v == null) return "not reconstructable";
  if (field === "priceUsd") return v < 0.01 ? `$${v.toPrecision(3)}` : `$${v.toFixed(4)}`;
  if (USD.includes(field)) return formatCompactUsd(v);
  if (PCT.includes(field)) return `${v.toFixed(1)}%`;
  if (field === "volMc" || field === "buyerSellerRatio" || field === "peakMultiple") return `${v.toFixed(2)}×`;
  return Math.round(v).toLocaleString("en-US");
}

const nameOf = (m: Match) => m.archetype.symbol ?? m.archetype.address.slice(0, 6);

function matchSentence(m: Match): string {
  const ok = m.matches.slice(0, 3).map((c) => c.label.toLowerCase());
  const broken = m.breaks.slice(0, 2).map((c) => c.phrase);
  const parts = [ok.length ? `${ok.join(", ")} match` : null, broken.length ? broken.join("; ") : null].filter(Boolean);
  return `${m.pct}% like ${nameOf(m)} at ${m.bucket}h${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

export default function TimeMachine({ tm }: { tm: TimeMachineResult }) {
  if (tm.status !== "ok" || !tm.token || tm.bucket == null) {
    return (
      <section className="mm-box p-4" data-testid="time-machine" data-status="unavailable">
        <h2 className="mm-display-sm text-xl sm:text-2xl">Time Machine</h2>
        <p className="mt-1 text-xs text-muted" data-testid="tm-reason">
          Not available — {tm.reason}
        </p>
      </section>
    );
  }
  const best = tm.winners[0];
  const rug = tm.rugs[0];
  const tokenFields = tm.token.fields;
  return (
    <section className="space-y-3 mm-box p-4" data-testid="time-machine" data-status="ok">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="mm-display-sm text-xl sm:text-2xl">Time Machine</h2>
        {tm.verdict && (
          <span
            data-testid="tm-verdict"
            className={`rounded-full px-2 py-0.5 text-xs font-bold ${tm.verdict === "closer to rugs" ? "sev-bad" : tm.verdict === "closer to winners" ? "sev-good" : "sev-ok"}`}
          >
            {tm.verdict}
          </span>
        )}
      </div>
      <p className="break-words text-sm" data-testid="tm-sentence">
        At {tm.bucket}h old, this token looks {tm.winners.length ? tm.winners.slice(0, 2).map(matchSentence).join(", ") : "like no winner archetype (too few shared fields)"}
        {tm.winners.length > 2 ? "…" : ""} · nearest rug archetype {rug ? `${rug.pct}% (${nameOf(rug)})` : "n/a"}.
      </p>
      {tm.reason && <p className="text-xs font-bold">{tm.reason}</p>}
      {(tm.library.winners < 10 || tm.library.rugs < 10) && (
        <p className="text-xs font-bold" data-testid="tm-thin">
          The archetype library is still small ({tm.library.winners} winners, {tm.library.rugs} rugs): treat these matches as anecdotes. They do not affect the score until it has ≥ 10 of each.
        </p>
      )}
      <p className="text-xs text-muted">
        Information, not score: at most +5 in Launch mode when ≥ 70% like a winner and ≤ 40% like a rug, −5 when ≥ 70% like a rug. Library: {tm.library.winners} winners, {tm.library.rugs} rugs
        {tm.library.builtAt ? `, built ${tm.library.builtAt.slice(0, 10)}` : ""}.
      </p>

      {best && (
        <div className="overflow-hidden border border-[var(--ink)]">
          <table className="w-full table-fixed text-xs" data-testid="tm-table">
            <thead className="mm-rule-b text-left text-muted">
              <tr>
                <th className="w-[40%] px-2 py-1.5 font-medium">Metric at {tm.bucket}h</th>
                <th className="px-2 py-1.5 font-medium">This token</th>
                <th className="px-2 py-1.5 font-medium">{nameOf(best)}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ink)]">
              {FIELD_NAMES.map((f) => (
                <tr key={f} data-field={f}>
                  <td className="break-words px-2 py-1">{FIELD_LABELS[f]}</td>
                  <td className={`break-words px-2 py-1 font-mono tabular-nums ${tokenFields[f] == null ? "text-muted" : ""}`} title={tm.token!.nulls[f]}>
                    {fmt(f, tokenFields[f])}
                  </td>
                  <td className={`break-words px-2 py-1 font-mono tabular-nums ${best.archetypeFields[f] == null ? "text-muted" : ""}`}>{fmt(f, best.archetypeFields[f])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-muted">Nearest archetypes ({tm.winners.length} winners, {tm.rugs.length} rugs)</summary>
        <ul className="mt-2 space-y-1.5" data-testid="tm-matches">
          {[...tm.winners, ...tm.rugs].map((m) => (
            <li key={`${m.archetype.kind}:${m.archetype.address}`} className="break-words">
              <span className={`px-1 font-bold uppercase ${m.archetype.kind === "rug" ? "sev-bad" : "sev-good"}`}>{m.archetype.kind}</span> {matchSentence(m)}{" "}
              <span className="text-muted">
                · {m.archetype.source} · {m.compared.length} shared fields
              </span>
            </li>
          ))}
        </ul>
      </details>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">How each field was rebuilt</summary>
        <ul className="mt-2 space-y-1">
          {FIELD_NAMES.map((f) => (
            <li key={f} className="break-words">
              <span className="font-bold">{FIELD_LABELS[f]}</span>: {tm.token!.nulls[f] ? <span className="text-muted">null — {tm.token!.nulls[f]}</span> : tm.methods[f]}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
