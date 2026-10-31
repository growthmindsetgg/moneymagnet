/**
 * Request budgets (§2b): one analysis finishes inside ANALYSIS_BUDGET_MS (default 45s) so the route,
 * with maxDuration 60, never 504s. Every source also has its own cap; whichever ends first wins and the
 * source is reported failed with that reason (then served stale from its last good run when it has one).
 */
export const ANALYSIS_BUDGET_MS = Number(process.env.ANALYSIS_BUDGET_MS || 45_000);

/** Per-source caps (ms). Sources not listed get DEFAULT_SOURCE_MS. */
export const SOURCE_BUDGET_MS: Record<string, number> = {
  hoodscan: 35_000,
  rpc: 35_000,
  "rh-sim": 30_000,
  "evm-sim": 30_000,
  helius: 35_000,
};
export const DEFAULT_SOURCE_MS = Number(process.env.SOURCE_BUDGET_MS || 30_000);

export class BudgetError extends Error {
  constructor(public label: string, public ms: number) {
    super(`${label} (${Math.round(ms / 100) / 10}s)`);
    this.name = "BudgetError";
  }
}

export interface Deadline {
  /** Absolute epoch ms when the analysis must stop waiting. */
  at: number;
  budgetMs: number;
}

export const deadlineIn = (budgetMs = ANALYSIS_BUDGET_MS, now = Date.now()): Deadline => ({ at: now + budgetMs, budgetMs });
export const remaining = (d: Deadline | undefined, now = Date.now()) => (d ? d.at - now : Infinity);

/** Resolves with `p`, or rejects with a BudgetError after `ms`. The underlying work is not cancelled, only no longer awaited. */
export function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms)) return p;
  if (ms <= 0) return Promise.reject(new BudgetError(label, 0));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new BudgetError(label, ms)), ms)));
  // A late rejection of the abandoned promise must not become an unhandled rejection.
  p.catch(() => undefined);
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The cap for one source: its own limit or what is left of the analysis budget, whichever is smaller. */
export function sourceCap(id: string, d: Deadline | undefined, now = Date.now()): { ms: number; label: string } {
  const own = SOURCE_BUDGET_MS[id] ?? DEFAULT_SOURCE_MS;
  const left = remaining(d, now);
  return left < own ? { ms: left, label: `timed out: ${Math.round((d?.budgetMs ?? 0) / 1000)}s analysis budget reached` } : { ms: own, label: `timed out after ${Math.round(own / 1000)}s (per-source limit)` };
}
