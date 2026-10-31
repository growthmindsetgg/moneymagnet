"use client";

import { useEffect, useState } from "react";
import { newErrorId } from "@/lib/errorId";

/** Failures within this window count towards the "still failing" hint. */
export const FAIL_WINDOW_MS = 120_000;
const FAIL_KEY = "mm:failures";
export const BLOCKER_HINT = "Still failing? Try a different browser or disable extensions — ad/tracker blockers can block the data calls.";

/** Records one failure and returns how many happened in the last 2 minutes (this one included). */
function recordFailure(now = Date.now()): number {
  try {
    const prev = (JSON.parse(sessionStorage.getItem(FAIL_KEY) ?? "[]") as number[]).filter((t) => typeof t === "number" && now - t < FAIL_WINDOW_MS);
    const next = [...prev, now];
    sessionStorage.setItem(FAIL_KEY, JSON.stringify(next));
    return next.length;
  } catch {
    // storage blocked: count only this page's failures
    return 1;
  }
}

/** Sends the id and cause to /api/client-error (best effort: a blocker may drop it too). */
function report(id: string, cause: string, status: number | null) {
  try {
    const body = JSON.stringify({ id, cause, status, path: location.pathname + location.search });
    if (!navigator.sendBeacon?.("/api/client-error", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/client-error", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
    }
  } catch {
    // logging must never break the error page
  }
}

/**
 * Every failure state (§2a): a big ERR, one plain-language cause, Retry, the error id, and — after the
 * second failure within 2 minutes — the browser / extension hint. `logged` = the server already wrote
 * this id to its log; otherwise the page reports it.
 */
export default function ErrorState({
  cause,
  errorId,
  status = null,
  logged = false,
  onRetry,
}: {
  cause: string;
  errorId?: string;
  status?: number | null;
  logged?: boolean;
  onRetry?: () => void;
}) {
  const [id] = useState(() => errorId ?? newErrorId());
  const [failures, setFailures] = useState(1);
  useEffect(() => {
    setFailures(recordFailure());
    console.error(`[${id}] ${cause}${status ? ` (HTTP ${status})` : ""}`);
    if (!logged) report(id, cause, status);
  }, [id, cause, status, logged]);
  return (
    <section className="mm-box p-4 sm:p-8" data-testid="error-state" data-error-id={id} role="alert">
      <p className="mm-display text-[22vw] sm:text-[12rem]" aria-hidden="true">
        ERR
      </p>
      <h1 className="mt-6 break-words font-mono text-base font-bold sm:text-lg" data-testid="error-cause">
        {cause}
      </h1>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button type="button" onClick={() => (onRetry ? onRetry() : location.reload())} className="mm-btn-neon mm-display-sm px-6 py-3 text-xl" data-testid="error-retry">
          Retry
        </button>
        <span className="font-mono text-xs text-muted">
          error id <span data-testid="error-id">{id}</span>
        </span>
      </div>
      {failures >= 2 && (
        <p className="mt-4 text-sm font-bold" data-testid="error-hint">
          {BLOCKER_HINT}
        </p>
      )}
    </section>
  );
}
