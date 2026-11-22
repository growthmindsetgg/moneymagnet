import { robinx, type RobinxSocial } from "./robinx";
import { sampleOf } from "./index";
import { seriesStore, type SeriesStore } from "./series";

/** Tokens re-sampled per run at most, the look-back for "analysed recently", and the wall-clock budget. */
export const CRON_MAX_TOKENS = 300;
export const CRON_DAYS = 7;
const CRON_BUDGET_MS = 240_000;
/** Consecutive "no answer" tokens after which the run stops (e.g. the free RobinX quota is spent). */
const STOP_AFTER_MISSES = 5;
/** Paid RobinX spend per cron run (USD, default 1.00): the free report first, the $0.02 mention tape only when it fails. */
export const CRON_MAX_USD = Number(process.env.SOCIAL_CRON_MAX_USD || 1);

export interface ResampleResult {
  due: number;
  sampled: number;
  stored: number;
  skipped: { address: string; reason: string }[];
  spentUsd: number;
  calls: number;
  stoppedEarly: string | null;
  pruned: number;
  ms: number;
}

/**
 * Social cron (every 30 min where the host allows it): re-samples every token analysed in the last 7 days,
 * least recently sampled first, at most 300 per run, inside the time budget, then drops samples older
 * than 30 days. Only chains with a post-count source are tracked (Robinhood Chain via RobinX).
 */
export async function resampleSocial(
  opts: { store?: SeriesStore; source?: (a: string) => Promise<RobinxSocial>; limit?: number; days?: number; now?: () => number; budgetMs?: number; maxUsd?: number } = {},
): Promise<ResampleResult> {
  const store = opts.store ?? seriesStore();
  let budget = opts.maxUsd ?? CRON_MAX_USD;
  const source = opts.source ?? ((a: string) => robinx(a, { paid: "mentions", maxUsd: Math.min(0.02, budget), cache: false }));
  const now = opts.now ?? Date.now;
  const t0 = now();
  const limit = Math.min(opts.limit ?? CRON_MAX_TOKENS, CRON_MAX_TOKENS);
  const due = await store.due(opts.days ?? CRON_DAYS, limit, t0);
  const out: ResampleResult = { due: due.length, sampled: 0, stored: 0, skipped: [], spentUsd: 0, calls: 0, stoppedEarly: null, pruned: 0, ms: 0 };
  let misses = 0;
  for (const t of due) {
    if (now() - t0 > (opts.budgetMs ?? CRON_BUDGET_MS)) {
      out.stoppedEarly = `time budget (${Math.round((opts.budgetMs ?? CRON_BUDGET_MS) / 1000)}s) reached`;
      break;
    }
    if (t.chain !== "robinhood") {
      out.skipped.push({ address: t.address, reason: `no post-count source for ${t.chain}` });
      continue;
    }
    const rx = await source(t.address).catch((e: Error) => ({ error: e.message }) as const);
    out.sampled++;
    if ("error" in rx) {
      out.skipped.push({ address: t.address, reason: rx.error.slice(0, 100) });
      misses++;
    } else {
      out.calls += rx.calls.length;
      out.spentUsd += rx.spentUsd;
      budget -= rx.spentUsd;
      const s = sampleOf(rx, now());
      if (s) {
        await store.add(t.chain, t.address, s);
        out.stored++;
        misses = 0;
      } else {
        out.skipped.push({ address: t.address, reason: Object.values(rx.nullReasons)[0] ?? "no post count" });
        misses++;
      }
      await store.markSampled(t.chain, t.address, new Date(now()).toISOString());
    }
    if (misses >= STOP_AFTER_MISSES) {
      out.stoppedEarly = `${STOP_AFTER_MISSES} tokens in a row without an answer (last: ${out.skipped[out.skipped.length - 1]?.reason})`;
      break;
    }
  }
  out.pruned = await store.prune().catch(() => 0);
  out.spentUsd = Math.round(out.spentUsd * 100) / 100;
  out.ms = now() - t0;
  return out;
}
