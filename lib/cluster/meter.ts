import type { TokenSnapshot } from "../types";
import type { ClusterGraph, ClusterNode, WalletClustersCfg } from "./graph";
import { pctText } from "./graph";

/**
 * The 0–100 wallet-cluster meter and its snapshot fields (plan §3.2, §3.6). Pure.
 *
 * holdShare = Σ pct of resolved holders in strong clusters (size ≥ 2) ÷ Σ pct of resolved holders.
 * buyShare  = resolved first buyers in strong clusters still holding ≥ buyerClusterMinHoldPct ÷ resolved first buyers.
 * meter     = round(100 × (w.buy·buyShare + w.hold·holdShare)), weights by mode (age only picks the mode);
 *             one part n/a ⇒ the other alone (said so); floor: the largest cluster holds ≥ floorClusterPct of the resolved
 *             sampled holder supply ⇒ meter ≥ floorMeter.
 * Published only past the coverage bar; otherwise null with the reason, or pending while background work runs.
 * Supply percentages always use TOTAL supply.
 */

export type ClusterState = "live" | "partial" | "pending" | "null" | "n/a";

export const BAND_LABELS = ["Independent wallets", "Some linked wallets", "Coordinated group", "Heavily linked", "Linked wallets dominate buying and holding"] as const;

export function bandOf(meter: number, bands: number[]): number {
  const i = bands.findIndex((b) => meter <= b);
  return i === -1 ? bands.length : i;
}

export interface MeterInput {
  graph: ClusterGraph;
  cfg: WalletClustersCfg;
  mode: "launch" | "established";
  /** Background work in flight and within the end-state limits. */
  pending: boolean;
  attempts: number;
  /** Why the buyer part is n/a, when no first buyers were sampled. */
  buyersNa?: string | null;
  /** Robinhood without funding reads: shown as partial, never scored live. */
  partialReason?: string | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function meterFields(input: MeterInput): Partial<TokenSnapshot> & { nullReasons: Record<string, string> } {
  const { graph, cfg, mode } = input;
  const nodes = graph.nodes;
  const nullReasons: Record<string, string> = {};
  const out: Partial<TokenSnapshot> & { nullReasons: Record<string, string> } = { nullReasons, walletClusterAttempts: input.attempts };

  const holders = nodes.filter((n) => n.role !== "buyer");
  const buyers = nodes.filter((n) => n.buyRank != null);
  const resolved = (n: ClusterNode) => n.status === "resolved" || n.status === "excluded";
  const settled = nodes.filter(resolved);
  const rHolders = holders.filter(resolved);
  const rBuyers = buyers.filter(resolved);
  const sampleSupply = holders.reduce((a, n) => a + (n.pct ?? 0), 0);
  const resolvedSupply = rHolders.reduce((a, n) => a + (n.pct ?? 0), 0);
  const clustered = new Set(graph.clusters.flatMap((c) => c.members));
  const largest = graph.clusters[0] ?? null;

  out.clusterSampleWallets = nodes.length;
  out.clusterResolvedWallets = settled.length;
  out.clusterHolderSupplyResolvedPct = sampleSupply > 0 ? round1((resolvedSupply / sampleSupply) * 100) : null;
  out.clusterCount = graph.clusters.length;
  out.fundingClusterMax = largest ? largest.members.length : settled.length ? 1 : null;
  out.clusterIncludesFounder = largest ? largest.includesFounder : null;
  out.founderClusterOnly = largest ? largest.founderOnly : null;
  out.clusterEdgeSummary = largest ? largest.evidence : null;
  // Pre-rendered sentences for the evidence template (fill() has no conditionals).
  out.clusterLargestText = largest
    ? `largest linked group: ${largest.members.length} wallets holding ${settled.length === nodes.length ? "" : "at least "}${pctText(largest.supplyPct)} of supply (${largest.evidence})`
    : `no linked group among ${settled.length} resolved wallets`;

  // The owner's literal "same-time funded" count, and same-time buys among them.
  const funded = nodes.filter((n) => n.status === "resolved" && n.origin?.funder && n.origin.fundT != null);
  if (funded.length >= 2) {
    out.sameTimeFundedMax = maxWindowGroup(funded, (n) => n.origin!.funder!, (n) => n.origin!.fundT!, cfg.sameTimeSec, (n) => n.origin!.fundRef);
    const bought = funded.filter((n) => n.buyT != null);
    if (bought.length >= 2) out.sameTimeBuyMax = maxWindowGroup(bought, (n) => n.origin!.funder!, (n) => n.buyT!, cfg.sameTimeSec, (n) => n.buyRef);
    else {
      out.sameTimeBuyMax = null;
      nullReasons.sameTimeBuyMax = "first-buy times known for fewer than 2 funded wallets";
    }
  } else {
    const why = `funding read for ${funded.length} wallet${funded.length === 1 ? "" : "s"} — fewer than 2`;
    out.sameTimeFundedMax = null;
    out.sameTimeBuyMax = null;
    nullReasons.sameTimeFundedMax = why;
    nullReasons.sameTimeBuyMax = why;
  }
  out.clusterSameTimeText =
    out.sameTimeFundedMax == null
      ? `same-time funding not measurable (${nullReasons.sameTimeFundedMax})`
      : out.sameTimeFundedMax < 2
        ? `no two wallets funded by one source within ${cfg.sameTimeSec}s`
        : `${out.sameTimeFundedMax} wallets funded by one source within ${cfg.sameTimeSec}s${out.sameTimeBuyMax != null && out.sameTimeBuyMax >= 2 ? `, ${out.sameTimeBuyMax} of them also bought within ${cfg.sameTimeSec}s` : ""}`;

  // Parts of the meter.
  const holdShare = resolvedSupply > 0 ? rHolders.filter((n) => clustered.has(n.address)).reduce((a, n) => a + (n.pct ?? 0), 0) / resolvedSupply : null;
  const buyShare = rBuyers.length ? rBuyers.filter((n) => clustered.has(n.address) && (clusterOf(graph, n.address)?.supplyPct ?? 0) >= cfg.buyerClusterMinHoldPct).length / rBuyers.length : null;
  out.clusterHoldShare = holdShare == null ? null : Math.round(holdShare * 1000) / 1000;
  out.clusterBuyShare = buyShare == null ? null : Math.round(buyShare * 1000) / 1000;

  // Proven lower bound for the caps: the largest strong cluster's share of total supply.
  const complete = settled.length === nodes.length;
  const lower = largest ? largest.supplyPct : 0;
  out.clusterSupplyIsLowerBound = !complete;
  if (lower >= cfg.minProvenPct || (complete && nodes.length > 0)) out.clusterSupplyMinPct = round1(lower);
  else {
    out.clusterSupplyMinPct = null;
    nullReasons.clusterSupplyMinPct = `no linked group ≥ ${cfg.minProvenPct}% proven yet (${settled.length} of ${nodes.length} wallets read)`;
  }
  out.clusterSupplyText = largest ? `${complete ? "" : "at least "}${pctText(lower)}` : "0.0%";

  // Coverage bar.
  const buyerPartNa = !buyers.length;
  const gaps: string[] = [];
  // A source that lists fewer wallets than the bar (e.g. a top-10 holder list) passes only when every one is resolved.
  const wholeSmallSample = settled.length === nodes.length && nodes.length >= cfg.coverage.minSampleAll;
  if (settled.length < cfg.coverage.minResolved && !wholeSmallSample)
    gaps.push(`${settled.length} of ${nodes.length} wallets resolved (needs ${nodes.length < cfg.coverage.minResolved ? `all of a sample of at least ${cfg.coverage.minSampleAll}` : cfg.coverage.minResolved})`);
  if ((out.clusterHolderSupplyResolvedPct ?? 0) < cfg.coverage.minHolderSupplyPct) gaps.push(`${out.clusterHolderSupplyResolvedPct ?? 0}% of sampled holder supply resolved (needs ${cfg.coverage.minHolderSupplyPct}%)`);
  if (!buyerPartNa && rBuyers.length < cfg.coverage.minBuyers) gaps.push(`${rBuyers.length} first buyers resolved (needs ${cfg.coverage.minBuyers})`);

  const set = (state: ClusterState, why?: string) => {
    out.walletClusterState = state;
    out.walletClusterPending = state === "pending";
    if (why) nullReasons.walletClusterMeter = why;
  };

  if (!nodes.length) {
    out.walletClusterMeter = null;
    set("n/a", "no wallets to sample (no trading activity)");
    return out;
  }
  if (input.partialReason) {
    out.walletClusterMeter = null;
    out.clusterSupplyPct = largest && lower >= cfg.minProvenPct ? round1(lower) : null;
    set("partial", input.partialReason);
    return out;
  }
  if (gaps.length) {
    out.walletClusterMeter = null;
    out.clusterSupplyPct = null;
    const unread = nodes.filter((n) => !resolved(n)).map((n) => n.origin?.reason).filter(Boolean) as string[];
    const top = mostCommon(unread);
    const why = `bundle check incomplete: ${gaps.join("; ")}${top ? ` — ${top}` : ""}`;
    if (input.pending) set("pending", why);
    else set("null", why);
    return out;
  }

  const w = cfg.blend[mode];
  let meter: number;
  if (holdShare != null && buyShare != null) meter = 100 * (w.buy * buyShare + w.hold * holdShare);
  else meter = 100 * (holdShare ?? buyShare ?? 0);
  meter = Math.round(meter);
  if (largest && resolvedSupply > 0 && (largest.supplyPct / resolvedSupply) * 100 >= cfg.floorClusterPct) meter = Math.max(meter, cfg.floorMeter);
  out.walletClusterMeter = meter;
  out.clusterSupplyPct = round1(lower);
  if (buyerPartNa) nullReasons.clusterBuyShare = input.buyersNa ?? "first buyers not reconstructable for this token yet — the meter reads holders only";
  set("live");
  return out;
}

function clusterOf(graph: ClusterGraph, address: string) {
  return graph.clusters.find((c) => c.members.includes(address)) ?? null;
}

/** Largest group sharing a key whose times fall within `windowSec` of the group's first (or share a block / slot). */
export function maxWindowGroup<T>(items: T[], key: (x: T) => string, time: (x: T) => number, windowSec: number, ref: (x: T) => number | null): number {
  const by = new Map<string, T[]>();
  for (const x of items) by.set(key(x), [...(by.get(key(x)) ?? []), x]);
  let best = 1;
  for (const list of by.values()) {
    list.sort((a, b) => time(a) - time(b));
    for (let i = 0; i < list.length; i++) {
      const r = ref(list[i]);
      const n = list.filter((x) => (time(x) >= time(list[i]) && time(x) - time(list[i]) <= windowSec) || (r != null && ref(x) === r)).length;
      if (n > best) best = n;
    }
  }
  return best;
}

function mostCommon(xs: string[]): string | null {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? `${top[1]} wallet${top[1] === 1 ? "" : "s"}: ${top[0]}` : null;
}
