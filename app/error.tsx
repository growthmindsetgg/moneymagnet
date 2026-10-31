"use client";

import ErrorState from "@/components/ErrorState";
import { failureCause } from "@/components/failure";
import { digestId } from "@/lib/errorId";

/** Any render error that escapes a page: the same ERR state, with Next's digest as the id (it is in the server log). */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="pt-4">
      <ErrorState cause={failureCause("exception")} errorId={error.digest ? digestId(error.digest) : undefined} logged={!!error.digest} onRetry={reset} />
    </div>
  );
}
