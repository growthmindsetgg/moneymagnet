"use client";

import { useEffect, useState } from "react";

// The adapters this chain's analysis queries (lib/analyze.ts). Per-adapter completion is not observable
// from the page, so the line names each adapter in turn as "querying", never a ✓ it cannot know.
const ADAPTERS: Record<string, string[]> = {
  robinhood: ["HoodScan", "ScanHood", "Robinhood RPC", "sell simulation", "DexScreener", "GeckoTerminal"],
  solana: ["RugCheck", "Helius", "Solana RPC", "Jupiter quote", "pump.fun feed", "DexScreener", "GeckoTerminal"],
  base: ["GoPlus", "Base RPC", "sell simulation", "Basescan", "DexScreener", "GeckoTerminal"],
  monad: ["Monad RPC", "sell simulation", "explorer", "DexScreener", "GeckoTerminal"],
  ethereum: ["GoPlus", "Ethereum RPC", "sell simulation", "Etherscan", "DexScreener", "GeckoTerminal"],
};

export default function LoadingSkeleton({ chain }: { chain: string }) {
  const names = ADAPTERS[chain] ?? ADAPTERS.robinhood;
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => n + 1), 900);
    return () => clearInterval(id);
  }, []);
  const on = i % names.length;
  return (
    <div className="space-y-10 pt-2" aria-busy="true" data-testid="loading">
      <div className="mm-skel h-12" />
      <div className="flex flex-col gap-6 md:flex-row md:items-end">
        <div className="flex items-end gap-5">
          {/* Same footprint as the tier letter, so nothing shifts when the result lands. */}
          <div className="mm-skel h-[clamp(6.6rem,17vw,16rem)] w-[clamp(4.5rem,12vw,11rem)]" />
          <div className="space-y-2 pb-2">
            <div className="mm-skel h-12 w-40" />
            <div className="mm-skel h-4 w-32" />
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="mm-skel h-14 w-full max-w-md" />
          <div className="mm-skel h-5 w-full max-w-lg" />
        </div>
      </div>
      {/* One stable announcement for screen readers; the cycling adapter names (every 900ms) stay visual only,
          so a live region does not re-announce on every tick. */}
      <p className="sr-only" role="status">
        Analyzing this token: querying {names.length} sources. This can take up to a minute.
      </p>
      <p className="font-mono text-sm" aria-hidden="true" data-testid="loading-status">
        {names.map((n, k) => (
          <span key={n} className={k === on ? "bg-neon px-1 text-neon-ink" : "text-muted"}>
            {n} {k === on ? "…" : "·"}{" "}
          </span>
        ))}
      </p>
      <p className="text-xs text-muted">Pulling holders, flow, honeypot simulation and pool data — the sell simulation can take up to 30 seconds.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((k) => (
          <div key={k} className="mm-skel h-72" />
        ))}
      </div>
    </div>
  );
}
