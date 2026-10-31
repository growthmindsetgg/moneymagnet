// pnpm backtest:social — social §6. Does "Stage 2 at S2+ with quality ≥ 60" predict better 24h / 72h
// outcomes than the baseline? Reads our own social series (Postgres social_series, or the KV) and the
// liquidity/mcap history every analysis records; never estimates a missing outcome.
//   Outcome: mcap(t + H) / mcap(t) from the liquidity history (nearest point within ±2h of t and of t + H).
//   Success: the multiple is ≥ 1.5. "2× better" = the group's success rate ≥ 2 × the baseline rate.
// Refuses to conclude before 14 days of series or with fewer than 20 group observations.
import { kvGet } from "@/lib/kv";
import { historyKey, type LiqPoint } from "@/lib/history";
import { seriesStore } from "@/lib/social/series";
import { sizeBand, socialStage } from "@/lib/social/stage";

const H = 3_600_000;
const MIN_DAYS = 14;
const MIN_GROUP = 20;
const SUCCESS = 1.5;

const near = (pts: LiqPoint[], t: number) => {
  const p = pts.filter((x) => x.mcap != null && Math.abs(x.t - t) <= 2 * H).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  return p?.mcap ?? null;
};

async function main() {
  const store = seriesStore();
  const tokens = await store.due(30, 100_000);
  let first = Infinity;
  let qualityMissing = 0;
  const rows: { group: boolean; m24: number | null; m72: number | null }[] = [];
  for (const t of tokens) {
    const series = await store.list(t.chain, t.address, 30);
    if (!series.length) continue;
    first = Math.min(first, Date.parse(series[0].ts));
    const liq = (await kvGet<LiqPoint[]>(historyKey(t.chain, t.address))) ?? [];
    for (let i = 2; i < series.length; i++) {
      const upto = series.slice(0, i + 1);
      const ts = Date.parse(upto[upto.length - 1].ts);
      const age = t.launchedAt ? (ts - Date.parse(t.launchedAt)) / H : null;
      const st = socialStage(upto, age, ts);
      if (!st) continue;
      const m0 = near(liq, ts);
      const mult = (h: number) => {
        const m1 = near(liq, ts + h * H);
        return m0 && m1 ? m1 / m0 : null;
      };
      // Quality: the latest analysis sample's quality at or before t (cron samples carry none).
      const q = [...upto].reverse().find((s) => s.quality != null)?.quality ?? null;
      if (q == null) qualityMissing++;
      rows.push({ group: st.stage === 2 && sizeBand(st.mNow) !== "S1" && q != null && q >= 60, m24: mult(24), m72: mult(72) });
    }
  }
  const days = Number.isFinite(first) ? (Date.now() - first) / 86_400_000 : 0;
  console.log(`series: ${tokens.length} tracked tokens, ${rows.length} stage observations, ${days.toFixed(1)} days of history`);
  if (days < MIN_DAYS) {
    console.log(`not enough history: ${days.toFixed(1)} of ${MIN_DAYS} days — no conclusion, no points proposed.`);
    return;
  }
  for (const h of ["m24", "m72"] as const) {
    const have = rows.filter((r) => r[h] != null);
    const rate = (xs: typeof have) => (xs.length ? xs.filter((r) => (r[h] as number) >= SUCCESS).length / xs.length : null);
    const g = have.filter((r) => r.group);
    const base = rate(have);
    const grp = rate(g);
    const verdict = g.length < MIN_GROUP || base == null || grp == null ? `inconclusive (${g.length} group observations, needs ≥ ${MIN_GROUP})` : grp >= 2 * base ? "YES — ≥ 2× the baseline" : "no — below 2× the baseline";
    console.log(`${h === "m24" ? "24h" : "72h"}: baseline ${base == null ? "—" : `${(base * 100).toFixed(1)}%`} of ${have.length}; stage 2 at S2+ ${grp == null ? "—" : `${(grp * 100).toFixed(1)}%`} of ${g.length} → ${verdict}`);
  }
  console.log(`${qualityMissing} observations had no quality yet (counted in the baseline, never in the group). Points are proposed only in a separate prompt.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
