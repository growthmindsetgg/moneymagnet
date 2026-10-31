"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import ErrorState from "./ErrorState";
import LoadingSkeleton from "./LoadingSkeleton";
import StateBlock, { brand, rejectWord } from "./StateBlock";
import { classifyStatus, failureCause, type FailureKind } from "./failure";

/** The client waits at most this long for the API (its own budget is 45s, maxDuration 60). */
const CLIENT_TIMEOUT_MS = 70_000;

type State =
  | { phase: "loading" }
  | { phase: "done" }
  | { phase: "rejected"; title: string; reason: string | null }
  | { phase: "failed"; kind: FailureKind; status: number | null; cause: string; errorId?: string; logged: boolean };

/**
 * Cold result pages: the data call runs here, so every failure (504, network / blocked request, cut-off
 * or partial JSON, any exception) lands on the styled ERR state instead of a platform error page. On
 * success the server page re-renders from the shared 2-minute result cache. `renderId` changes on every
 * server render: if the page comes back to this component after a success (cache miss), it asks the
 * server to analyze inline (`?ssr=1`) instead of looping.
 */
export default function LiveReport({ chain, address, fresh, simulate, renderId }: { chain: string; address: string; fresh: string | null; simulate: string | null; renderId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const doneAt = useRef<string | null>(null);

  const run = useCallback(async () => {
    setState({ phase: "loading" });
    let res: Response;
    try {
      res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, chain, ...(fresh != null ? { fresh: true, freshTag: fresh } : {}), ...(simulate ? { simulate } : {}) }),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const kind: FailureKind = timeout ? "timeout" : "network";
      setState({ phase: "failed", kind, status: null, cause: failureCause(kind), logged: false });
      return;
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      setState({ phase: "failed", kind: "parse", status: res.status, cause: failureCause("parse"), logged: false });
      return;
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    if (res.status === 422 || (res.status === 400 && body?.rejected)) {
      const title = brand(String(body?.rejected ?? body?.error ?? "Not rated"));
      setState({ phase: "rejected", title, reason: typeof body?.reason === "string" ? `${body.reason}.` : null });
      return;
    }
    if (!res.ok) {
      const kind = classifyStatus(res.status);
      const errorId = typeof body?.errorId === "string" ? body.errorId : undefined;
      const detail = kind === "rate-limit" && typeof body?.retryAfter === "number" ? String(body.retryAfter) : null;
      setState({ phase: "failed", kind, status: res.status, cause: failureCause(kind, res.status, detail), errorId, logged: !!errorId });
      return;
    }
    if (!body) {
      setState({ phase: "failed", kind: "parse", status: res.status, cause: failureCause("parse"), logged: false });
      return;
    }
    if (typeof body.tier !== "string") {
      setState({ phase: "failed", kind: "partial", status: res.status, cause: failureCause("partial", null, "no tier"), logged: false });
      return;
    }
    doneAt.current = renderId;
    setState({ phase: "done" });
    // The server page now finds this run in the shared cache (a ?fresh=X page finds the run tagged X).
    router.refresh();
  }, [address, chain, fresh, simulate, renderId, router]);

  useEffect(() => {
    void run();
    // `run` changes with renderId; the fetch runs once per attempt, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Rendered again by the server after a success: the shared cache missed — analyze server-side instead.
  useEffect(() => {
    if (doneAt.current && doneAt.current !== renderId) {
      const url = new URL(location.href);
      url.searchParams.set("ssr", "1");
      router.replace(url.pathname + url.search, { scroll: false });
    }
  }, [renderId, router]);

  if (state.phase === "rejected") return <StateBlock testId="not-a-meme" word={rejectWord(state.title)} title={state.title} reason={state.reason} address={address} />;
  if (state.phase === "failed")
    return <ErrorState key={`${attempt}`} cause={state.cause} errorId={state.errorId} status={state.status} logged={state.logged} onRetry={() => setAttempt((n) => n + 1)} />;
  return <LoadingSkeleton chain={chain} />;
}
