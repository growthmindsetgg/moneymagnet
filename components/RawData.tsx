"use client";

import { useState } from "react";

/** Raw snapshot + source payloads, fetched when the section is opened (not shipped in the page HTML). */
export default function RawData({ chain, address, inline }: { chain: string; address: string; inline?: unknown }) {
  const [text, setText] = useState<string | null>(inline !== undefined ? JSON.stringify(inline, null, 2) : null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (text || error) return;
    try {
      const sim = new URLSearchParams(location.search).get("simulate");
      const res = await fetch(`/api/raw?chain=${chain}&address=${address}${sim ? `&simulate=${sim}` : ""}`);
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `HTTP ${res.status}`);
      else setText(JSON.stringify({ snapshot: body.snapshot, raw: body.raw }, null, 2));
    } catch (e) {
      setError(`Could not load the raw data: ${(e as Error).message}`);
    }
  };
  return (
    <details className="mm-box mm-research p-4" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void load()} data-testid="raw-data">
      <summary className="cursor-pointer text-sm font-bold">
        <span className="mm-plus" aria-hidden="true" /> Raw data
      </summary>
      {error ? (
        <p className="mt-3 text-xs">{error}</p>
      ) : (
        <pre tabIndex={0} aria-label="Raw snapshot and source data (JSON)" className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-all border border-dashed border-[var(--muted)] p-3 text-xs leading-relaxed">
          {text ?? "Loading…"}
        </pre>
      )}
    </details>
  );
}
