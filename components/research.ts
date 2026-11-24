import type { HolderRow, ScoreReport, TokenSnapshot } from "@/lib/types";
import { formatCompactUsd } from "@/lib/scoring/format";

// Presentation only: research-view tables built from data the run already fetched (snapshot + raw).
// Nothing here calls a source; a column no source filled says why.

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const key = (report: ScoreReport, a: string) => (report.chain === "solana" ? a : a.toLowerCase());

interface Funding {
  wallet: string;
  funder: string | null;
  firstTx: number | null;
}

export interface HolderLine {
  address: string;
  pct: number | null;
  buys: number | null;
  sells: number | null;
  /** ISO time of the wallet's first transaction, when a source looked it up. */
  firstSeen: string | null;
  /** "cluster" for the largest same-funder group, or "same funder ×N" for smaller groups. */
  cluster: string | null;
}

export interface HoldersTable {
  rows: HolderLine[];
  /** Why the first-seen column is empty, when it is. */
  firstSeenNote: string | null;
  clusterNote: string | null;
}

function fundingOf(report: ScoreReport): { funding: Funding[]; largest: Set<string>; groupOf: Map<string, string> | null } {
  // The wallet-cluster graph, when the report has one: the same groups the Linked wallets meter shows.
  const g = report.token.walletClusterGraph;
  if (g) {
    const funding = g.nodes.filter((n) => n.origin).map((n) => ({ wallet: n.address, funder: n.status === "resolved" ? n.origin!.funder : null, firstTx: n.origin!.fundT }));
    const groupOf = new Map<string, string>();
    for (const c of g.clusters) for (const m of c.members) groupOf.set(key(report, m), `group ${c.id} ×${c.members.length}`);
    return { funding, largest: new Set(g.clusters[0]?.members ?? []), groupOf };
  }
  const h = report.raw?.helius as { funding?: Funding[]; clusters?: { wallets?: string[] } } | undefined;
  return { funding: h?.funding ?? [], largest: new Set(h?.clusters?.wallets ?? []), groupOf: null };
}

/** Top 20 non-liquidity holders: on-chain balances first, swap-index buys/sells merged in by address. */
export function holdersTable(report: ScoreReport): HoldersTable {
  const t = report.token;
  const swaps = new Map((t.swapHolders ?? []).map((h) => [key(report, h.address), h] as const));
  const wallet = (h: HolderRow) => h.kind !== "liquidity";
  const base = (t.holders?.length ? t.holders : (t.swapHolders ?? [])).filter(wallet).slice(0, 20);
  const { funding, largest, groupOf } = fundingOf(report);
  const byWallet = new Map(funding.map((f) => [key(report, f.wallet), f] as const));
  const funderCount = new Map<string, number>();
  for (const f of funding) if (f.funder) funderCount.set(f.funder, (funderCount.get(f.funder) ?? 0) + 1);
  const rows = base.map((h): HolderLine => {
    const k = key(report, h.address);
    const s = swaps.get(k);
    const f = byWallet.get(k);
    const shared = f?.funder ? (funderCount.get(f.funder) ?? 0) : 0;
    return {
      address: h.address,
      pct: h.pct,
      buys: h.buys ?? s?.buys ?? null,
      sells: h.sells ?? s?.sells ?? null,
      firstSeen: f?.firstTx ? new Date(f.firstTx * 1000).toISOString() : null,
      cluster: groupOf ? (groupOf.get(k) ?? null) : largest.has(h.address) && largest.size >= 2 ? `cluster ×${largest.size}` : shared >= 2 ? `same funder ×${shared}` : null,
    };
  });
  const anyFirst = rows.some((r) => r.firstSeen);
  const firstSeenNote = anyFirst
    ? null
    : report.chain === "solana"
      ? (t.nullReasons?.freshWalletsTop20 ?? "Helius did not return wallet histories this run")
      : "not available: this chain's RPC has no address index, so a wallet's first transaction cannot be looked up";
  const clusterNote = funding.length ? null : report.chain === "solana" ? (t.nullReasons?.fundingClusterMax ?? "no funding lookups this run") : "funding graph not read for this chain's holders";
  return { rows, firstSeenNote, clusterNote };
}

export interface PoolLine {
  address: string;
  name: string | null;
  dex: string | null;
  liquidityUsd: number | null;
  source: string;
}

/** Every pool GeckoTerminal or DexScreener listed this run, highest liquidity first. */
export function poolList(report: ScoreReport): PoolLine[] {
  const gt = (report.raw?.geckoterminal as { pools?: { id: string; name?: string; liquidityUsd?: number; dexId?: string | null }[] } | undefined)?.pools ?? [];
  const ds =
    (report.raw?.dexscreener as { pairs?: { pairAddress: string; dexId?: string; liquidity?: { usd?: number }; baseToken?: { symbol?: string }; quoteToken?: { symbol?: string } }[] } | undefined)?.pairs ??
    [];
  const out = new Map<string, PoolLine>();
  for (const p of gt) out.set(key(report, p.id), { address: p.id, name: p.name ?? null, dex: p.dexId ?? null, liquidityUsd: p.liquidityUsd ?? null, source: "GeckoTerminal" });
  for (const p of ds) {
    const k = key(report, p.pairAddress);
    const prev = out.get(k);
    const liq = p.liquidity?.usd ?? null;
    const name = p.baseToken?.symbol && p.quoteToken?.symbol ? `${p.baseToken.symbol} / ${p.quoteToken.symbol}` : null;
    if (!prev) out.set(k, { address: p.pairAddress, name, dex: p.dexId ?? null, liquidityUsd: liq, source: "DexScreener" });
    // Both list it: the lower reading is shown (the conservative one), with both sources named.
    else out.set(k, { ...prev, dex: prev.dex ?? p.dexId ?? null, liquidityUsd: liq != null && prev.liquidityUsd != null ? Math.min(liq, prev.liquidityUsd) : (prev.liquidityUsd ?? liq), source: "GeckoTerminal + DexScreener" });
  }
  return [...out.values()].sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) || (a.address < b.address ? -1 : 1));
}

const pct = (v: number | null) => (v == null ? null : `${Math.round(v * 10) / 10}%`);
const why = (t: TokenSnapshot, m: keyof TokenSnapshot) => t.nullReasons?.[m as string];

/** "Deployer 0xabc…1234 · holds 2.1% · sold 0% in swaps · 3 prior mints (33% rugged)" — each part or its null reason. */
export function deployerLine(report: ScoreReport): string {
  const t = report.token;
  if (!t.deployerAddress) return `Deployer unknown — ${why(t, "deployerAddress") ?? why(t, "deployerSoldPct") ?? "no source identified the creator"}`;
  const parts = [`Deployer ${short(t.deployerAddress)}`];
  parts.push(t.deployerHoldingPct != null ? `holds ${pct(t.deployerHoldingPct)}` : `holding: no data${why(t, "deployerHoldingPct") ? ` (${why(t, "deployerHoldingPct")})` : ""}`);
  parts.push(t.deployerSoldPct != null ? `sold ${pct(t.deployerSoldPct)} in swaps` : `sold: no data${why(t, "deployerSoldPct") ? ` (${why(t, "deployerSoldPct")})` : ""}`);
  if (t.deployerDistributedPct != null) parts.push(`handed out ${pct(t.deployerDistributedPct)} by transfer`);
  if (t.creatorPriorMints != null) parts.push(`${t.creatorPriorMints} prior mints${t.creatorRugRatePct != null ? ` (${pct(t.creatorRugRatePct)} rugged)` : ""}`);
  else parts.push(`prior mints: no data${why(t, "creatorPriorMints") ? ` (${why(t, "creatorPriorMints")})` : ""}`);
  return parts.join(" · ");
}

/** The cluster read-out in one list: largest same-funder group, fresh wallets, insider networks, bundlers. */
export function clusterSummary(report: ScoreReport): string[] {
  const t = report.token;
  const out: string[] = [];
  if (t.walletClusterState) {
    // The wallet-cluster meter (lib/cluster): the same read-out as the Linked wallets section.
    out.push(t.walletClusterMeter != null ? `Linked wallets meter: ${t.walletClusterMeter}/100 — ${t.clusterLargestText ?? ""}` : `Linked wallets: not measured — ${why(t, "walletClusterMeter") ?? t.walletClusterState}`);
    if (t.clusterSameTimeText) out.push(t.clusterSameTimeText.charAt(0).toUpperCase() + t.clusterSameTimeText.slice(1));
  } else if (t.fundingClusterMax != null) out.push(`Largest same-funder cluster: ${t.fundingClusterMax} wallets${t.clusterSupplyPct != null ? `, ${pct(t.clusterSupplyPct)} of supply` : ""}`);
  else out.push(`Funding clusters: no data — ${why(t, "fundingClusterMax") ?? "not measured on this chain"}`);
  if (t.freshWalletsTop20 != null) out.push(`Fresh wallets in the top 20: ${t.freshWalletsTop20}`);
  if (t.insiderNetworks != null) out.push(`Insider networks: ${t.insiderNetworks}${t.insiderSupplyPct != null ? ` holding ${pct(t.insiderSupplyPct)}` : ""}`);
  if (t.bundlerMajority != null) out.push(t.bundlerMajority ? "Bundlers hold a majority of the early supply" : "No bundler majority");
  return out;
}

export const poolLiquidity = (p: PoolLine) => (p.liquidityUsd == null ? "—" : formatCompactUsd(p.liquidityUsd));
