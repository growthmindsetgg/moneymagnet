"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { addressKind, CHAIN_LABEL, EVM_CHAINS, isEvmChain, normalizeAddress } from "@/lib/chain";
import { loadRecent, type RecentItem } from "./recent";
import { TierChip } from "./TierChip";

export default function AnalyzeForm({ initial = "", compact = false }: { initial?: string; compact?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  /** "auto" resolves an 0x address across Robinhood Chain, Base, Monad and Ethereum (§1a). */
  const [pick, setPick] = useState<string>("auto");

  useEffect(() => setRecent(loadRecent()), []);

  const kind = addressKind(value);
  const detected = kind === "solana" ? CHAIN_LABEL.solana : kind === "evm" ? (isEvmChain(pick) ? CHAIN_LABEL[pick] : "EVM (Robinhood Chain / Base / Monad / Ethereum — checked on each)") : null;

  /** `chain`: a recent search's known chain; otherwise the selector decides (auto for 0x). */
  function go(address: string, chain?: string) {
    const k = addressKind(address);
    if (!k) {
      setError("Enter an EVM (0x…, Robinhood Chain / Base / Monad / Ethereum) or Solana (base58) token address.");
      return;
    }
    setError(null);
    setBusy(true);
    if (k === "solana") return router.push(`/t/solana/${normalizeAddress("solana", address)}`);
    const c = isEvmChain(chain) ? chain : isEvmChain(pick) ? pick : "auto";
    router.push(`/t/${c}/${address.trim().toLowerCase()}`);
  }

  return (
    <div className="space-y-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(value);
        }}
        className="mm-box flex flex-col sm:flex-row"
      >
        <label htmlFor="address" className="sr-only">
          Token contract address
        </label>
        <input
          id="address"
          name="address"
          value={value}
          onChange={(e) => setValue(e.target.value.trim())}
          placeholder="0x… or Solana mint"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint="go"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby="address-hint"
          className={`min-w-0 flex-1 bg-transparent px-4 font-mono outline-none placeholder:text-muted ${compact ? "py-2.5 text-base sm:text-sm" : "py-4 text-base"}`}
        />
        <label htmlFor="chain" className="sr-only">
          Chain
        </label>
        <select
          id="chain"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          data-testid="chain-select"
          className={`mm-rule-t bg-transparent px-3 font-mono text-xs uppercase tracking-wider sm:border-l sm:border-t-0 sm:border-l-[var(--ink)] ${compact ? "py-2.5" : "py-4"}`}
        >
          <option value="auto">Auto</option>
          {EVM_CHAINS.map((c) => (
            <option key={c} value={c}>
              {CHAIN_LABEL[c]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy}
          className={`mm-btn-neon mm-display-sm border-0 px-8 sm:border-l sm:border-l-[var(--ink)] ${compact ? "py-2.5 text-lg" : "py-4 text-2xl"}`}
        >
          {busy ? "Analyzing…" : "Analyze"}
        </button>
      </form>
      <div id="address-hint" className="min-h-5 text-xs" aria-live="polite">
        {error ? <span className="text-tier-f">{error}</span> : detected ? <span className="text-muted">Detected: {detected}</span> : null}
      </div>
      {recent.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Recent searches">
          {recent.map((r) => (
            <li key={`${r.chain}:${r.address}`} className="max-w-full">
              <button type="button" onClick={() => go(r.address, r.chain)} className="mm-pill flex max-w-full items-center gap-2 py-1 pl-1 pr-3 text-xs" title={r.address}>
                <TierChip tier={r.tier} />
                <span className="truncate">
                  {r.symbol ?? `${r.address.slice(0, 6)}…${r.address.slice(-4)}`}
                  {r.score != null ? <span className="text-muted"> {Math.round(r.score)}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
