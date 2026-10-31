"use client";

import { useEffect, useState } from "react";
import type { Chain } from "@/lib/types";

interface Check {
  id: string;
  text: string;
  note: string;
}

/**
 * Guide checks no API can answer (narrative, posters, dev's X…). The viewer ticks them; ticks are
 * stored server-side per token (KV) so a returning viewer sees them. They never change the score.
 */
export default function ManualChecks({ chain, address, checks }: { chain: Chain; address: string; checks: Check[] }) {
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");

  useEffect(() => {
    let alive = true;
    fetch(`/api/checks?chain=${chain}&address=${encodeURIComponent(address)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { ticks?: Record<string, boolean> }) => {
        if (alive) {
          setTicks(j.ticks ?? {});
          setState("ready");
        }
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [chain, address]);

  async function toggle(id: string) {
    const next = { ...ticks, [id]: !ticks[id] };
    setTicks(next);
    setState("saving");
    try {
      const r = await fetch("/api/checks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain, address, ticks: next }),
      });
      setState(r.ok ? "ready" : "error");
    } catch {
      setState("error");
    }
  }

  const done = checks.filter((c) => ticks[c.id]).length;
  return (
    <section className="mm-box p-4" data-testid="manual-checks">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="mm-display-sm text-xl sm:text-2xl">Manual checks</h2>
        <span className="text-xs text-muted">
          {done}/{checks.length} · {state === "saving" ? "saving…" : state === "error" ? "not saved" : state === "loading" ? "loading…" : "saved per token"}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">No data source can answer these — the guide asks you to check them yourself. They do not affect the score.</p>
      <ul className="mt-3 space-y-2">
        {checks.map((c) => (
          <li key={c.id}>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" className="mm-check mt-0.5 shrink-0" checked={!!ticks[c.id]} onChange={() => toggle(c.id)} disabled={state === "loading"} />
              <span className="min-w-0">
                {c.text} <span className="text-xs text-muted">({c.note})</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
