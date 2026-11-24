import type { ScoreReport } from "@/lib/types";
import { defaultConfig } from "@/lib/scoring/config";
import { BAND_LABELS, bandOf } from "@/lib/cluster/meter";
import { txUrl } from "@/lib/holderLine";
import ClusterBubbles from "./ClusterBubbles";
import { SEV_FILL, type Severity } from "./severity";

/**
 * LINKED WALLETS: the wallet-cluster meter (0–100), the largest linked group, same-time funding, and the wallet map.
 * Never shows a number the coverage bar has not earned: pending / null / n/a / partial each say why.
 */

const BAND_SEV: Severity[] = ["good", "ok", "warn", "bad", "bad"];
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const pctText = (n: number | null | undefined) => (n == null ? "—" : `${(Math.round(n * 10) / 10).toFixed(1)}%`);

const STATE_TEXT: Record<string, string> = { live: "live", pending: "reading", partial: "partial", null: "not measured", "n/a": "not applicable" };

export default function ClusterMeter({ report }: { report: ScoreReport }) {
  const t = report.token;
  const state = t.walletClusterState;
  if (!state) return null;
  const cfg = defaultConfig.walletClusters;
  const graph = t.walletClusterGraph ?? null;
  const meter = t.walletClusterMeter ?? null;
  const band = meter != null && cfg ? bandOf(meter, cfg.bands) : null;
  const sev = band != null ? BAND_SEV[band] : null;
  const why = t.nullReasons?.walletClusterMeter;
  const holders = graph?.nodes.filter((n) => n.role !== "buyer").length ?? 0;
  const buyers = graph?.nodes.filter((n) => n.buyRank != null).length ?? 0;
  const factor = report.groups.flatMap((g) => g.factors).find((f) => f.id === "wallet_clusters");
  const caps = report.rules.filter((r) => r.state === "fired" && /^cluster_|^full_bundle$/.test(r.id));

  return (
    <section className="mm-box space-y-3 p-4" aria-labelledby="clusters-heading" data-testid="wallet-clusters" data-state={state}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="clusters-heading" className="mm-display text-2xl">
          Linked wallets
        </h2>
        <span className="text-xs uppercase tracking-wider text-muted" data-testid="wallet-clusters-state">
          bundle check · {STATE_TEXT[state] ?? state}
        </span>
      </div>

      {meter != null && band != null && sev ? (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-3xl font-bold tabular-nums" data-testid="wallet-clusters-meter">
              {meter}
              <span className="text-base text-muted">/100</span>
            </span>
            <span className="text-sm font-bold" data-testid="wallet-clusters-band">
              {BAND_LABELS[band]}
            </span>
          </div>
          <div
            className="relative h-3 border border-[var(--ink)]"
            role="meter"
            aria-label="Linked wallets"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={meter}
            aria-valuetext={`${meter} of 100, ${BAND_LABELS[band]}`}
          >
            <div className={`h-full ${SEV_FILL[sev]}`} style={{ width: `${Math.max(2, Math.min(100, meter))}%` }} />
            {/* Band edges, so the reader sees where each label starts. */}
            {(cfg?.bands ?? []).map((b) => (
              <span key={b} aria-hidden="true" className="absolute top-0 h-full w-px bg-[var(--ink)] opacity-40" style={{ left: `${b + 0.5}%` }} />
            ))}
          </div>
          <p className="text-xs text-muted">0 = independent wallets · 100 = one linked group dominates buying and holding</p>
        </div>
      ) : (
        <p className="break-words text-sm" data-testid="wallet-clusters-reason">
          <span className="font-bold">{state === "pending" ? `Reading funding origins (${t.clusterResolvedWallets ?? 0} of ${t.clusterSampleWallets ?? 0} wallets)…` : "No meter"}</span>
          {why ? ` — ${why}` : ""}
          {state === "pending" ? " Shown from the next analysis once the background reads finish." : ""}
        </p>
      )}

      <ul className="space-y-1 text-sm" data-testid="wallet-clusters-lines">
        {t.clusterLargestText && <li className="break-words">{capitalise(t.clusterLargestText)}.</li>}
        {t.clusterSameTimeText && <li className="break-words">{capitalise(t.clusterSameTimeText)}.</li>}
        {caps.map((r) => (
          <li key={r.id} className="break-words font-bold text-[var(--bad-text)]">
            {r.evidence}
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted" data-testid="wallet-clusters-coverage">
        {t.clusterResolvedWallets ?? 0} of {t.clusterSampleWallets ?? 0} wallets resolved · {holders} top holders{buyers ? `, ${buyers} first buyers` : ""}
        {t.clusterHolderSupplyResolvedPct != null ? ` · ${pctText(t.clusterHolderSupplyResolvedPct)} of their supply resolved` : ""}
        {factor ? ` · factor ${factor.status === "n/a" ? "not counted yet" : `${factor.points}/${factor.max}`}` : " · not scored on this chain yet"}
      </p>

      {graph && graph.nodes.length > 0 && <ClusterBubbles graph={graph} />}

      {graph && graph.nodes.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-bold">Wallet list ({graph.nodes.length})</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--ink)]">
                  <th className="py-1 pr-2">Wallet</th>
                  <th className="py-1 pr-2">Held</th>
                  <th className="py-1 pr-2">Buyer</th>
                  <th className="py-1 pr-2">Group</th>
                  <th className="py-1 pr-2">First coin from</th>
                  <th className="py-1 pr-2">Funding tx / note</th>
                </tr>
              </thead>
              <tbody>
                {[...graph.nodes]
                  .sort((a, b) => (a.clusterId ?? "~").localeCompare(b.clusterId ?? "~") || (b.pct ?? 0) - (a.pct ?? 0))
                  .map((n) => (
                    <tr key={n.address} className="border-b border-[var(--muted)] align-top">
                      <td className="py-1 pr-2 font-mono">{short(n.address)}</td>
                      <td className="py-1 pr-2 tabular-nums">{pctText(n.pct)}</td>
                      <td className="py-1 pr-2">{n.buyRank != null ? `#${n.buyRank}` : "—"}</td>
                      <td className="py-1 pr-2 font-bold">{n.clusterId ?? "—"}</td>
                      <td className="py-1 pr-2 font-mono">{n.origin?.funder ? short(n.origin.funder) : "—"}</td>
                      <td className="break-words py-1 pr-2">
                        {n.origin?.fundTx ? (
                          <a className="underline" href={txUrl(report.chain, n.origin.fundTx)} target="_blank" rel="noopener noreferrer">
                            {short(n.origin.fundTx)}
                            <span className="sr-only"> (opens in a new tab)</span>
                          </a>
                        ) : (
                          (n.excludedReason ?? n.origin?.reason ?? "not read yet")
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {graph?.unreadable && graph.unreadable.length > 0 && (
        <p className="break-words text-xs text-muted" data-testid="wallet-clusters-unreadable">
          Left out after {cfg?.pending.maxAttempts ?? 3} background attempts (funding not readable): {graph.unreadable.map((u) => `${short(u.address)} — ${u.reason}`).join(" · ")}
        </p>
      )}
      {graph?.custody && graph.custody.length > 0 && (
        <p className="break-words text-xs text-muted" data-testid="wallet-clusters-custody">
          Left out of linking (exchange-like custody, still counted in concentration): {graph.custody.map((c) => `${short(c.address)} ${pctText(c.pct)} — ${c.label}`).join(" · ")}
        </p>
      )}
      {graph && graph.exclusions.length > 0 && (
        <p className="break-words text-xs text-muted" data-testid="wallet-clusters-exclusions">
          Not linked (funded by infrastructure): {graph.exclusions.map((e) => `${e.wallets} via ${e.label} ${short(e.address)}`).join(" · ")}
        </p>
      )}
      <p className="text-xs text-muted">
        Method: each sampled wallet&apos;s first native-coin funding is read on chain; wallets are linked only by proven ties (one funder within {cfg?.sameTimeSec ?? 30}s or 30 min, direct funding, back-to-back sprays). Exchanges, bridges, routers and contracts never link wallets.
      </p>
    </section>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
