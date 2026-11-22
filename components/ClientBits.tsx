"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { pushRecent, type RecentItem } from "./recent";

export function RememberSearch({ chain, address, symbol, tier, score }: RecentItem) {
  useEffect(() => pushRecent({ chain, address, symbol, tier, score }), [chain, address, symbol, tier, score]);
  return null;
}

function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [done, setDone] = useState(false);
  return [
    done,
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      } catch {
        setDone(false);
      }
    },
  ];
}

export function CopyLink() {
  const [done, copy] = useCopied();
  return (
    <button type="button" onClick={() => copy(window.location.href)} className="mm-btn px-3 py-1.5 text-xs uppercase tracking-wider">
      {/* aria-live: the label change ("Copied ✓") is announced to screen readers too. */}
      <span aria-live="polite">{done ? "Copied ✓" : "Copy link"}</span>
    </button>
  );
}

/** The contract address in mono with a copy icon. */
export function CopyAddress({ address }: { address: string }) {
  const [done, copy] = useCopied();
  return (
    <div className="flex min-w-0 items-start gap-2">
      <code className="min-w-0 break-all font-mono text-xs leading-6 sm:text-sm" data-testid="contract-address">
        {address}
      </code>
      <button type="button" onClick={() => copy(address)} className="mm-btn -my-1 inline-flex h-8 w-8 shrink-0 items-center justify-center" aria-label={done ? "Address copied" : "Copy contract address"} title="Copy address">
        {done ? (
          <span aria-hidden="true">✓</span>
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5" y="5" width="9" height="9" />
            <path d="M11 5V2H2v9h3" />
          </svg>
        )}
      </button>
    </div>
  );
}

/** Re-runs every source, bypassing the 2-minute result cache (a full navigation to ?fresh=<now>). */
export function RetrySources() {
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        const next = new URLSearchParams(params.toString());
        next.set("fresh", String(Date.now()));
        setPending(true);
        window.location.assign(`${pathname}?${next.toString()}`);
      }}
      disabled={pending}
      data-testid="retry-sources"
      className="mm-btn px-3 py-1.5 text-xs uppercase tracking-wider"
    >
      {pending ? "Re-running sources…" : "Retry sources"}
    </button>
  );
}
