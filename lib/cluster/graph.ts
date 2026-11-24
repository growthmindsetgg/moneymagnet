import type { Chain } from "../types";
import type { FunderKind, Origin } from "../onchain/origin";

/**
 * Wallet-cluster graph (docs/research/2026-11-23-team-review-plan.md §3.5). Pure: origins and funder facts in, edges
 * and clusters out. Every threshold comes from factors.json → walletClusters.
 *
 * Strong edges merge wallets (union-find). Weak edges are drawn but never merge on their own; two weak edges of
 * DIFFERENT kinds on the same pair merge as a "composite" strong edge.
 */

export type EdgeKind = "same_time_funder" | "shared_funder" | "direct_fund" | "hub_spray" | "funder_2h" | "hub_funder" | "batch_withdrawal" | "same_block_buy";
const STRONG: ReadonlySet<string> = new Set(["same_time_funder", "shared_funder", "direct_fund", "hub_spray", "composite"]);

export interface WalletClustersCfg {
  sameTimeSec: number;
  strongWindowSec: number;
  weakWindowSec: number;
  batchWithdrawalMinRecipients: number;
  batchWithdrawalMaxSampleShare: number;
  buyerClusterMinHoldPct: number;
  floorClusterPct: number;
  floorMeter: number;
  minProvenPct: number;
  blend: { launch: { buy: number; hold: number }; established: { buy: number; hold: number } };
  /** minSampleAll: a sample smaller than minResolved passes only when every wallet is resolved and it has at least this many. */
  coverage: { minResolved: number; minHolderSupplyPct: number; minBuyers: number; minSampleAll: number };
  pending: { maxAttempts: number; maxAgeSec: number };
  inline: { holders: number; buyers: number };
  sample: { holders: number; buyers: number };
  bands: number[];
  dustPct: number;
  hubNonce: number;
  hubSigs: number;
}

export interface SampleWallet {
  address: string;
  role: "holder" | "buyer" | "both";
  /** Share of total supply held now (this run's balances); 0 for a buyer that no longer holds. */
  pct: number | null;
  /** 1-based order among first buyers. */
  buyRank: number | null;
  buyT: number | null;
  /** Block (EVM) or slot (Solana) of the first buy. */
  buyRef: number | null;
  /** Holder class from the top-holder classification, when known (founder / team / treasury …). */
  holderClass: string | null;
}

/** What is known about a funder address. Excluded kinds never create an edge and nothing chains through them. */
export interface FunderFact {
  kind: FunderKind;
  label?: string;
  /** High-activity sender (nonce / signature count over the hub bar): only a consecutive spray links its recipients. */
  hub?: boolean;
}

export const EXCLUDED_KINDS: ReadonlySet<FunderKind> = new Set(["cex", "bridge", "router", "launchpad", "program", "contract", "relayer", "aa_bundler", "bot_infra"]);

export interface ClusterEdge {
  a: string;
  b: string;
  kind: EdgeKind | "composite";
  strength: "strong" | "weak";
  parts?: EdgeKind[];
  tx?: string;
  gapSec?: number;
  detail: string;
}

export interface ClusterNode extends SampleWallet {
  clusterId: string | null;
  origin: Origin | null;
  status: "resolved" | "unresolved" | "excluded";
  excludedReason?: string;
}

export interface Cluster {
  id: string;
  members: string[];
  /** Share of total supply the members hold now. */
  supplyPct: number;
  buyers: number;
  funder: string | null;
  includesFounder: boolean;
  founderOnly: boolean;
  edgeKinds: string[];
  evidence: string;
}

export interface ClusterGraph {
  chain: Chain;
  token: string;
  computedAt: number;
  nodes: ClusterNode[];
  edges: ClusterEdge[];
  clusters: Cluster[];
  exclusions: { address: string; kind: FunderKind; label: string; wallets: number }[];
  /** Exchange-like custody wallets left out of the sample (still counted in concentration). */
  custody?: { address: string; label: string; pct: number | null }[];
  /** Wallets whose funding stayed unreadable (outage / budget) after the background attempts: left out of the sample. */
  unreadable?: { address: string; reason: string }[];
}

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const pctText = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)}%`;
const FOUNDERISH = new Set(["founder", "team"]);

/** A node is resolved when its funder is known with proof, or proven to be excluded infrastructure. */
export function nodeStatus(o: Origin | null, fact: FunderFact | undefined): ClusterNode["status"] {
  if (!o) return "unresolved";
  if (o.funder) return fact && EXCLUDED_KINDS.has(fact.kind) ? "excluded" : "resolved";
  // Coin from a program-owned account (Solana) is a proven non-wallet source: excluded, not unknown.
  if (o.funderKind === "program") return "excluded";
  return "unresolved";
}

class UnionFind {
  private p = new Map<string, string>();
  find(x: string): string {
    let r = this.p.get(x) ?? x;
    if (r !== x) {
      r = this.find(r);
      this.p.set(x, r);
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

export function buildGraph(input: {
  chain: Chain;
  token: string;
  wallets: SampleWallet[];
  origins: Map<string, Origin>;
  funders: Map<string, FunderFact>;
  deployers: Set<string>;
  cfg: WalletClustersCfg;
  computedAt: number;
}): ClusterGraph {
  const { wallets, origins, funders, cfg } = input;
  const norm = (a: string) => (input.chain === "solana" ? a : a.toLowerCase());
  const deployers = new Set([...input.deployers].map(norm));
  const nodes: ClusterNode[] = wallets.map((w) => {
    const origin = origins.get(w.address) ?? null;
    const fact = origin?.funder ? funders.get(norm(origin.funder)) : undefined;
    const status = nodeStatus(origin, fact);
    const excludedReason = status === "excluded" ? (origin?.funder ? `funded by ${fact?.label ?? fact?.kind ?? "infrastructure"} ${short(origin.funder)} — not a link` : (origin?.reason ?? "funded from a program account")) : undefined;
    return { ...w, origin, status, clusterId: null, ...(excludedReason ? { excludedReason } : {}) };
  });
  const byAddr = new Map(nodes.map((n) => [norm(n.address), n]));
  const edges: ClusterEdge[] = [];
  const add = (e: ClusterEdge) => edges.push(e);

  // Funding edges: pairs sharing a non-excluded funder, by the gap between their first receipts.
  const resolved = nodes.filter((n) => n.status === "resolved" && n.origin?.funder);
  const byFunder = new Map<string, ClusterNode[]>();
  for (const n of resolved) {
    const f = norm(n.origin!.funder!);
    // A funder that is itself in the sample (or the deployer): direct funding.
    const target = byAddr.get(f);
    if (target && target !== n) add({ a: target.address, b: n.address, kind: "direct_fund", strength: "strong", tx: n.origin!.fundTx ?? undefined, detail: `${short(target.address)} sent ${short(n.address)} its first coin` });
    byFunder.set(f, [...(byFunder.get(f) ?? []), n]);
  }
  for (const [f, list] of byFunder) {
    if (list.length < 2) continue;
    const fact = funders.get(f);
    const isDeployer = deployers.has(f);
    // Batch withdrawals: one tx crediting many recipients where the sample is a small share — a weak clue only.
    const sameTx = (x: ClusterNode, y: ClusterNode) => !!x.origin!.fundTx && x.origin!.fundTx === y.origin!.fundTx;
    const sampleInTx = (tx: string | null) => list.filter((n) => n.origin!.fundTx === tx).length;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i];
        const y = list[j];
        const ox = x.origin!;
        const oy = y.origin!;
        const gap = ox.fundT != null && oy.fundT != null ? Math.abs(ox.fundT - oy.fundT) : null;
        const sameRef = ox.fundRef != null && ox.fundRef === oy.fundRef;
        const who = isDeployer ? `the deployer ${short(f)}` : short(f);
        if (sameTx(x, y) && (ox.viaRecipients ?? 0) > cfg.batchWithdrawalMinRecipients && sampleInTx(ox.fundTx) / (ox.viaRecipients ?? 1) < cfg.batchWithdrawalMaxSampleShare) {
          add({ a: x.address, b: y.address, kind: "batch_withdrawal", strength: "weak", tx: ox.fundTx ?? undefined, gapSec: 0, detail: `both in one ${ox.viaRecipients}-recipient payout from ${who} (batch withdrawal)` });
          continue;
        }
        if (fact?.hub && !isDeployer) {
          // A high-activity sender links its recipients only when it sprayed them back to back.
          const consecutive = (ox.funderNonce != null && oy.funderNonce != null && Math.abs(ox.funderNonce - oy.funderNonce) === 1) || sameTx(x, y) || sameRef;
          add(
            consecutive
              ? { a: x.address, b: y.address, kind: "hub_spray", strength: "strong", gapSec: gap ?? undefined, detail: `${who} (high-volume sender) funded both back to back` }
              : { a: x.address, b: y.address, kind: "hub_funder", strength: "weak", gapSec: gap ?? undefined, detail: `both funded by high-volume sender ${who}` },
          );
          continue;
        }
        if (sameRef || (gap != null && gap <= cfg.sameTimeSec)) add({ a: x.address, b: y.address, kind: "same_time_funder", strength: "strong", gapSec: gap ?? 0, tx: ox.fundTx ?? undefined, detail: `funded by ${who} ${sameRef ? "in the same block" : `${gap}s apart`}` });
        else if (gap != null && gap <= cfg.strongWindowSec) add({ a: x.address, b: y.address, kind: "shared_funder", strength: "strong", gapSec: gap, detail: `funded by ${who} ${Math.round(gap / 60)} min apart` });
        else if (gap != null && gap <= cfg.weakWindowSec) add({ a: x.address, b: y.address, kind: "funder_2h", strength: "weak", gapSec: gap, detail: `funded by ${who} ${Math.round(gap / 60)} min apart` });
      }
    }
  }

  // Weak buy-timing edge: first buys in the same block / slot.
  const buyers = nodes.filter((n) => n.buyRef != null);
  for (let i = 0; i < buyers.length; i++) {
    for (let j = i + 1; j < buyers.length; j++) {
      if (buyers[i].buyRef === buyers[j].buyRef) add({ a: buyers[i].address, b: buyers[j].address, kind: "same_block_buy", strength: "weak", gapSec: 0, detail: `first buys in the same ${input.chain === "solana" ? "slot" : "block"}` });
    }
  }

  // Two weak edges of different kinds on one pair merge as a composite strong edge.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const weakByPair = new Map<string, ClusterEdge[]>();
  for (const e of edges) if (e.strength === "weak") weakByPair.set(pairKey(e.a, e.b), [...(weakByPair.get(pairKey(e.a, e.b)) ?? []), e]);
  const strongPairs = new Set(edges.filter((e) => e.strength === "strong").map((e) => pairKey(e.a, e.b)));
  for (const [k, list] of weakByPair) {
    const kinds = [...new Set(list.map((e) => e.kind as EdgeKind))];
    if (kinds.length >= 2 && !strongPairs.has(k)) add({ a: list[0].a, b: list[0].b, kind: "composite", strength: "strong", parts: kinds, detail: `two independent clues: ${list.map((e) => e.detail).join("; ")}` });
  }

  // Union-find over strong edges only.
  const uf = new UnionFind();
  for (const e of edges) if (STRONG.has(e.kind)) uf.union(norm(e.a), norm(e.b));
  const groups = new Map<string, ClusterNode[]>();
  for (const n of nodes) {
    if (n.status !== "resolved") continue;
    const r = uf.find(norm(n.address));
    groups.set(r, [...(groups.get(r) ?? []), n]);
  }
  const clusters: Cluster[] = [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      const members = g.map((n) => n.address);
      const set = new Set(members.map(norm));
      const inner = edges.filter((e) => STRONG.has(e.kind) && set.has(norm(e.a)) && set.has(norm(e.b)));
      const funderCount = new Map<string, number>();
      for (const n of g) if (n.origin?.funder) funderCount.set(n.origin.funder, (funderCount.get(n.origin.funder) ?? 0) + 1);
      const funder = [...funderCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
      const founderish = g.filter((n) => (n.holderClass && FOUNDERISH.has(n.holderClass)) || deployers.has(norm(n.address)));
      return {
        id: "",
        members,
        supplyPct: Math.round(g.reduce((a, n) => a + (n.pct ?? 0), 0) * 100) / 100,
        buyers: g.filter((n) => n.buyRank != null).length,
        funder,
        includesFounder: founderish.length > 0 || (funder != null && deployers.has(norm(funder))),
        founderOnly: founderish.length === g.length,
        edgeKinds: [...new Set(inner.map((e) => e.kind))],
        evidence: summarise(inner, g, funder, cfg.sameTimeSec),
      };
    })
    // Deterministic order: largest supply first, then address.
    .sort((a, b) => b.supplyPct - a.supplyPct || b.members.length - a.members.length || (a.members[0] < b.members[0] ? -1 : 1));
  clusters.forEach((c, i) => {
    c.id = String.fromCharCode(65 + Math.min(i, 25));
    for (const m of c.members) byAddr.get(norm(m))!.clusterId = c.id;
  });

  const excl = new Map<string, { address: string; kind: FunderKind; label: string; wallets: number }>();
  for (const n of nodes) {
    if (n.status !== "excluded" || !n.origin?.funder) continue;
    const f = norm(n.origin.funder);
    const fact = funders.get(f);
    const e = excl.get(f) ?? { address: n.origin.funder, kind: fact?.kind ?? "unknown", label: fact?.label ?? fact?.kind ?? "infrastructure", wallets: 0 };
    e.wallets++;
    excl.set(f, e);
  }
  return { chain: input.chain, token: input.token, computedAt: input.computedAt, nodes, edges, clusters, exclusions: [...excl.values()] };
}

/**
 * Cluster members that look like exchange custody (plan correction 16): a high-activity wallet (over the hub bar) that
 * is not the founder / team and was not funded by the deployer. An exchange wallet funding another is how exchanges
 * work, not one person farming a token — these leave the cluster sample (they stay counted in concentration).
 */
export function exchangeLikeMembers(graph: ClusterGraph, hubs: Map<string, string>, deployers: Set<string>): { address: string; label: string }[] {
  const norm = (a: string) => (graph.chain === "solana" ? a : a.toLowerCase());
  const dep = new Set([...deployers].map(norm));
  const out: { address: string; label: string }[] = [];
  for (const c of graph.clusters) {
    for (const m of c.members) {
      const n = graph.nodes.find((x) => x.address === m);
      const label = hubs.get(norm(m));
      if (!n || !label) continue;
      if (n.holderClass && FOUNDERISH.has(n.holderClass)) continue;
      if (n.origin?.funder && dep.has(norm(n.origin.funder))) continue;
      out.push({ address: m, label });
    }
  }
  return out;
}

/** Duration as "27s" / "12 min" / "1.5 h". */
const span = (sec: number) => (sec < 120 ? `${Math.round(sec)}s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(Math.round(sec / 360) / 10).toFixed(1)} h`);

/**
 * The group's evidence line. Counts describe the whole group, never one pair: how many came from the main funder and
 * over what span, and how many of those fell inside the same-time window.
 */
function summarise(inner: ClusterEdge[], members: ClusterNode[], funder: string | null, sameTimeSec: number): string {
  const kinds = new Map<string, number>();
  for (const e of inner) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  const parts: string[] = [];
  const fromMain = funder ? members.filter((n) => n.origin?.funder === funder && n.origin.fundT != null) : [];
  if (fromMain.length >= 2) {
    const ts = fromMain.map((n) => n.origin!.fundT!).sort((a, b) => a - b);
    let sameTime = 1;
    for (let i = 0, j = 0; j < ts.length; j++) {
      while (ts[j] - ts[i] > sameTimeSec) i++;
      sameTime = Math.max(sameTime, j - i + 1);
    }
    const all = fromMain.length === members.length ? `all ${members.length}` : `${fromMain.length} of ${members.length}`;
    parts.push(`${all} first funded by ${short(funder!)} within ${span(ts[ts.length - 1] - ts[0])}${sameTime >= 2 && sameTime < fromMain.length ? ` (${sameTime} of them within ${sameTimeSec}s)` : ""}`);
  }
  if (kinds.get("direct_fund")) parts.push(`${kinds.get("direct_fund")} direct funding${kinds.get("direct_fund")! > 1 ? "s" : ""}`);
  if (kinds.get("hub_spray")) parts.push(`sprayed back to back by a high-volume sender`);
  if (kinds.get("composite")) parts.push(`${kinds.get("composite")} pair${kinds.get("composite")! > 1 ? "s" : ""} with two independent clues`);
  return parts.length ? parts.join("; ") : `${members.length} wallets linked`;
}

export { pctText };
