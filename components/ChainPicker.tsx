import type { ChainCandidate } from "@/lib/resolveChain";
import { CHAIN_LABEL } from "@/lib/chain";
import { formatCompactUsd } from "@/lib/scoring/format";

/** §1a: the same 0x address is a token on more than one chain — pick one (each with its FDV). */
export default function ChainPicker({ address, candidates, suffix = "" }: { address: string; candidates: ChainCandidate[]; suffix?: string }) {
  return (
    <section className="mm-box space-y-4 p-4 sm:p-8" data-testid="chain-picker" aria-labelledby="picker-heading">
      <h1 id="picker-heading" className="mm-display-sm text-2xl sm:text-3xl">
        This address is a token on {candidates.length} chains
      </h1>
      <p className="break-all font-mono text-xs text-muted">{address}</p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {candidates.map((c) => (
          <li key={c.chain}>
            <a href={`/t/${c.chain}/${address}${suffix}`} className="mm-box block p-4 transition-colors hover:bg-[color-mix(in_srgb,var(--neon)_16%,transparent)]" data-testid="chain-option" data-chain={c.chain}>
              <span className="mm-display-sm block text-xl">{CHAIN_LABEL[c.chain]}</span>
              <span className="mt-1 block font-mono text-sm tabular-nums">FDV {c.fdvUsd != null ? formatCompactUsd(c.fdvUsd) : "— (no pairs)"}</span>
              <span className="block text-xs text-muted">
                {c.pairs} pair{c.pairs === 1 ? "" : "s"}
                {c.liquidityUsd != null && c.pairs > 0 ? ` · liquidity ${formatCompactUsd(c.liquidityUsd)}` : ""}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
