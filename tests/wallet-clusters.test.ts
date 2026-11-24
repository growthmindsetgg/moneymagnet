import { describe, expect, it } from "vitest";
import { buildGraph, exchangeLikeMembers, type FunderFact, type SampleWallet, type WalletClustersCfg } from "@/lib/cluster/graph";
import { bandOf, maxWindowGroup, meterFields } from "@/lib/cluster/meter";
import { solanaReceipt, type Origin } from "@/lib/onchain/origin";
import { defaultConfig, setFor } from "@/lib/scoring/config";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { perfectSnapshot } from "./helpers";
import type { FullTx } from "@/lib/timemachine/solana";

const cfg = defaultConfig.walletClusters as WalletClustersCfg;
const T = 1_760_000_000;

const holder = (i: number, pct: number, extra: Partial<SampleWallet> = {}): SampleWallet => ({ address: `w${String(i).padStart(2, "0")}`, role: "holder", pct, buyRank: null, buyT: null, buyRef: null, holderClass: null, ...extra });
const origin = (wallet: string, funder: string | null, fundT: number | null, extra: Partial<Origin> = {}): Origin => ({ wallet, fundT, fundRef: fundT, funder, funderKind: funder ? "eoa" : "unknown", via: null, fundTx: funder ? `tx-${wallet}` : null, method: "helius-gtfa", final: true, ...(funder ? {} : { reason: "no SOL receipt" }), ...extra });

function graphOf(wallets: SampleWallet[], origins: Origin[], funders: Record<string, FunderFact> = {}, deployers: string[] = []) {
  return buildGraph({ chain: "solana", token: "TOKEN", wallets, origins: new Map(origins.map((o) => [o.wallet, o])), funders: new Map(Object.entries(funders)), deployers: new Set(deployers), cfg, computedAt: 0 });
}

/** 14 holders: 6 funded by one wallet within 36s (a ring), 8 independently. */
function ring(ringPct = 4, othersPct = 2) {
  const wallets = Array.from({ length: 14 }, (_, i) => holder(i, i < 6 ? ringPct : othersPct));
  const origins = wallets.map((w, i) => (i < 6 ? origin(w.address, "SPRAYER", T + i * 6) : origin(w.address, `solo${i}`, T + i * 5000)));
  return { wallets, origins };
}

describe("cluster graph (pure)", () => {
  it("one funder spraying 6 wallets within 36s ⇒ one strong cluster with same-time edges", () => {
    const { wallets, origins } = ring();
    const g = graphOf(wallets, origins);
    expect(g.clusters).toHaveLength(1);
    expect(g.clusters[0].members).toHaveLength(6);
    expect(g.clusters[0].supplyPct).toBe(24);
    expect(g.edges.filter((e) => e.kind === "same_time_funder").length).toBe(15);
    expect(g.clusters[0].evidence).toMatch(/^all 6 first funded by SPRAYER within 30s/);
    // A group whose funding spans longer than the window says how many fell inside it (counts describe the group).
    const wide = graphOf([holder(1, 5), holder(2, 5), holder(3, 5), holder(4, 5)], [origin("w01", "F", T), origin("w02", "F", T + 27), origin("w03", "F", T + 600), origin("w04", "F", T + 700)]);
    expect(wide.clusters[0].evidence).toMatch(/^all 4 first funded by F within 12 min \(2 of them within 30s\)/);
    expect(g.nodes.filter((n) => n.clusterId === "A")).toHaveLength(6);
  });

  it("window boundaries: ≤ 30s same-time, ≤ 30 min shared (strong), ≤ 2h weak (no merge), beyond: nothing", () => {
    const pair = (gap: number) => graphOf([holder(1, 5), holder(2, 5)], [origin("w01", "F", T), origin("w02", "F", T + gap, { fundRef: T + gap })]);
    expect(pair(30).edges[0].kind).toBe("same_time_funder");
    expect(pair(31).edges[0].kind).toBe("shared_funder");
    expect(pair(1800).edges[0].kind).toBe("shared_funder");
    expect(pair(1801).edges[0].kind).toBe("funder_2h");
    expect(pair(1801).clusters).toHaveLength(0);
    expect(pair(7201).edges).toHaveLength(0);
  });

  it("excluded funders (exchange, program, contract) create no edge and nothing chains through them", () => {
    const wallets = [holder(1, 5), holder(2, 5), holder(3, 5)];
    const origins = wallets.map((w, i) => origin(w.address, "BINANCE", T + i));
    const g = graphOf(wallets, origins, { BINANCE: { kind: "cex", label: "Binance hot wallet" } });
    expect(g.edges).toHaveLength(0);
    expect(g.clusters).toHaveLength(0);
    expect(g.nodes.every((n) => n.status === "excluded")).toBe(true);
    expect(g.exclusions).toEqual([{ address: "BINANCE", kind: "cex", label: "Binance hot wallet", wallets: 3 }]);
  });

  it("high-volume sender: back-to-back (consecutive nonces / same tx) is a strong spray; interleaved is weak only", () => {
    const wallets = [holder(1, 5), holder(2, 5), holder(3, 5)];
    const hub = { HUB: { kind: "eoa" as const, hub: true } };
    const spray = graphOf(wallets, wallets.map((w, i) => origin(w.address, "HUB", T + i * 400, { funderNonce: 100 + i, fundRef: T + i * 400 })), hub);
    expect(spray.edges.some((e) => e.kind === "hub_spray")).toBe(true);
    expect(spray.clusters[0]?.members).toHaveLength(3);
    const apart = graphOf(wallets, wallets.map((w, i) => origin(w.address, "HUB", T + i * 400, { funderNonce: 100 + i * 7, fundRef: T + i * 400 })), hub);
    expect(apart.edges.every((e) => e.kind === "hub_funder" && e.strength === "weak")).toBe(true);
    expect(apart.clusters).toHaveLength(0);
  });

  it("a big batch payout (> 20 recipients, sample < 25% of them) is a weak clue, not a cluster", () => {
    const wallets = [holder(1, 5), holder(2, 5), holder(3, 5)];
    const g = graphOf(wallets, wallets.map((w) => origin(w.address, "EXCH", T, { fundTx: "batch", viaRecipients: 100 })));
    expect(g.edges.every((e) => e.kind === "batch_withdrawal" && e.strength === "weak")).toBe(true);
    expect(g.clusters).toHaveLength(0);
  });

  it("two weak clues of DIFFERENT kinds merge (composite); one weak clue, or two of the same kind, never do", () => {
    const a = holder(1, 5, { role: "both", buyRank: 1, buyRef: 999 });
    const b = holder(2, 5, { role: "both", buyRank: 2, buyRef: 999 });
    const twoKinds = graphOf([a, b], [origin("w01", "F", T), origin("w02", "F", T + 3600, { fundRef: T + 3600 })]);
    expect(twoKinds.edges.map((e) => e.kind).sort()).toEqual(["composite", "funder_2h", "same_block_buy"]);
    expect(twoKinds.clusters).toHaveLength(1);
    const oneKind = graphOf([holder(1, 5), holder(2, 5)], [origin("w01", "F", T), origin("w02", "F", T + 3600, { fundRef: T + 3600 })]);
    expect(oneKind.clusters).toHaveLength(0);
  });

  it("direct funding links the funder wallet to the funded one", () => {
    const g = graphOf([holder(1, 10), holder(2, 5)], [origin("w01", "solo", T), origin("w02", "w01", T + 99999)]);
    expect(g.edges.map((e) => e.kind)).toContain("direct_fund");
    expect(g.clusters[0].members.sort()).toEqual(["w01", "w02"]);
  });

  it("a founder group: deployer-funded wallets with founder / team classes ⇒ includesFounder and founderOnly", () => {
    const g = graphOf([holder(1, 30, { holderClass: "founder" }), holder(2, 10, { holderClass: "team" })], [origin("w01", "DEV", T), origin("w02", "DEV", T + 5)], {}, ["DEV"]);
    expect(g.clusters[0].includesFounder).toBe(true);
    expect(g.clusters[0].founderOnly).toBe(true);
  });

  it("exchange-like custody: a high-activity member leaves the group; a founder / deployer-funded one stays (correction 16)", () => {
    // Two large holders where one funded the other: the WIF-style exchange pair.
    const g = graphOf([holder(1, 10), holder(2, 6.4)], [origin("w01", "x", T), origin("w02", "w01", T + 500)]);
    expect(g.clusters).toHaveLength(1);
    expect(exchangeLikeMembers(g, new Map([["w01", "≥ 1000 transactions"]]), new Set())).toEqual([{ address: "w01", label: "≥ 1000 transactions" }]);
    // Founder / team class, or funded by the deployer: never dropped, whatever its activity.
    const team = graphOf([holder(1, 30, { holderClass: "founder" }), holder(2, 10)], [origin("w01", "DEV", T), origin("w02", "DEV", T + 5)], {}, ["DEV"]);
    expect(exchangeLikeMembers(team, new Map([["w01", "nonce 9000"], ["w02", "nonce 9000"]]), new Set(["DEV"]))).toEqual([]);
    // Not a hub: stays.
    expect(exchangeLikeMembers(g, new Map(), new Set())).toEqual([]);
  });

  it("deterministic: the same input gives the same clusters, ids and edge order", () => {
    const { wallets, origins } = ring();
    expect(JSON.stringify(graphOf(wallets, origins))).toBe(JSON.stringify(graphOf([...wallets].reverse().reverse(), origins)));
  });
});

describe("meter (pure)", () => {
  const meter = (g: ReturnType<typeof graphOf>, over: Partial<Parameters<typeof meterFields>[0]> = {}) => meterFields({ graph: g, cfg, mode: "established", pending: false, attempts: 1, ...over });

  it("ring of 6 holding 24% of a 56% sample (no buyers ⇒ holders only): meter 43, proven 24%", () => {
    const f = meter(graphOf(ring(4, 4).wallets, ring(4, 4).origins));
    expect(f.walletClusterState).toBe("live");
    expect(f.clusterHoldShare).toBe(0.429);
    expect(f.walletClusterMeter).toBe(43);
    expect(f.clusterSupplyMinPct).toBe(24);
    expect(f.clusterSupplyText).toBe("24.0%");
    expect(f.sameTimeFundedMax).toBe(6);
    expect(f.clusterLargestText).toMatch(/^largest linked group: 6 wallets holding 24\.0% of supply/);
    expect(f.clusterSameTimeText).toBe("6 wallets funded by one source within 30s");
    expect(f.nullReasons.clusterBuyShare).toMatch(/first-buyer|first buyers/);
  });

  it("floor: the largest group holds ≥ 50% of resolved holder supply ⇒ meter ≥ 80", () => {
    const f = meter(graphOf(ring(10, 1).wallets, ring(10, 1).origins));
    expect(f.walletClusterMeter).toBeGreaterThanOrEqual(80);
  });

  it("launch blend weighs coordinated buyers 60%", () => {
    // 6 clustered buyers hold 1% each; 8 independent hold 3% each.
    const wallets = Array.from({ length: 14 }, (_, i) => holder(i, i < 6 ? 1 : 3, { role: "both", buyRank: i + 1, buyT: T + i, buyRef: T + i }));
    const origins = wallets.map((w, i) => (i < 6 ? origin(w.address, "F", T + i) : origin(w.address, `s${i}`, T + i * 9000)));
    const f = meterFields({ graph: graphOf(wallets, origins), cfg, mode: "launch", pending: false, attempts: 1 });
    // buyShare 6/14 (group holds 6% ≥ 1%), holdShare 6/30: 100·(0.6·0.4286 + 0.4·0.2) = 33.7 → 34; established would be 25.
    expect(f.walletClusterMeter).toBe(34);
    expect(meterFields({ graph: graphOf(wallets, origins), cfg, mode: "established", pending: false, attempts: 1 }).walletClusterMeter).toBe(25);
    expect(f.sameTimeBuyMax).toBe(6);
  });

  it("coverage bar: fewer than 12 resolved wallets ⇒ null with the reason, or pending while background work runs", () => {
    const wallets = Array.from({ length: 14 }, (_, i) => holder(i, 2));
    const origins = wallets.slice(0, 5).map((w) => origin(w.address, `s${w.address}`, T));
    const g = graphOf(wallets, origins);
    const off = meter(g);
    expect(off.walletClusterMeter).toBeNull();
    expect(off.walletClusterState).toBe("null");
    expect(off.nullReasons.walletClusterMeter).toMatch(/5 of 14 wallets resolved \(needs 12\)/);
    const on = meter(g, { pending: true });
    expect(on.walletClusterState).toBe("pending");
    expect(on.walletClusterPending).toBe(true);
  });

  it("a small sample (source lists < 12 wallets) passes only when every wallet is resolved and there are ≥ 8", () => {
    const nine = Array.from({ length: 9 }, (_, i) => holder(i, 5));
    const all = meter(graphOf(nine, nine.map((w) => origin(w.address, `s${w.address}`, T))));
    expect(all.walletClusterState).toBe("live");
    expect(all.walletClusterMeter).toBe(0);
    const most = meter(graphOf(nine, nine.slice(0, 8).map((w) => origin(w.address, `s${w.address}`, T))));
    expect(most.walletClusterMeter).toBeNull();
    expect(most.nullReasons.walletClusterMeter).toMatch(/8 of 9 wallets resolved \(needs all of a sample of at least 8\)/);
    const seven = Array.from({ length: 7 }, (_, i) => holder(i, 10));
    expect(meter(graphOf(seven, seven.map((w) => origin(w.address, `s${w.address}`, T)))).walletClusterMeter).toBeNull();
  });

  it("no unread gate passes: below 10% and incomplete ⇒ clusterSupplyMinPct null with the reason", () => {
    const wallets = Array.from({ length: 14 }, (_, i) => holder(i, 2));
    const origins = [origin("w00", "F", T), origin("w01", "F", T + 1), ...wallets.slice(2, 13).map((w) => origin(w.address, `s${w.address}`, T))];
    const f = meter(graphOf(wallets, origins));
    expect(f.clusterSupplyMinPct).toBeNull();
    expect(f.nullReasons.clusterSupplyMinPct).toMatch(/no linked group ≥ 10% proven yet \(13 of 14 wallets read\)/);
  });

  it("supply uses TOTAL supply: 12 resolved wallets holding 6% read 6%, never 100%", () => {
    const wallets = Array.from({ length: 12 }, (_, i) => holder(i, 0.5));
    const g = graphOf(wallets, wallets.map((w, i) => origin(w.address, "F", T + i)));
    const f = meter(g);
    expect(f.clusterSupplyMinPct).toBe(6);
  });

  it("no wallets ⇒ n/a (never a meter of 0, which would read 'independent')", () => {
    const f = meter(graphOf([], []));
    expect(f.walletClusterState).toBe("n/a");
    expect(f.walletClusterMeter).toBeNull();
  });

  it("Robinhood partial: never scored live, reason given", () => {
    const f = meter(graphOf(ring().wallets, []), { partialReason: "partial: native funding not readable" });
    expect(f.walletClusterState).toBe("partial");
    expect(f.walletClusterMeter).toBeNull();
  });

  it("bands and the same-time window group", () => {
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map((m) => bandOf(m, cfg.bands))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    const items = [{ k: "F", t: 0 }, { k: "F", t: 10 }, { k: "F", t: 31 }, { k: "G", t: 5 }];
    expect(maxWindowGroup(items, (x) => x.k, (x) => x.t, 30, () => null)).toBe(2);
  });
});

describe("Solana origin parser", () => {
  const tx = (keys: string[], pre: number[], post: number[], fee = 5000): FullTx => ({ slot: 1, blockTime: T, transaction: { signatures: ["sig"], message: { accountKeys: keys.map((pubkey) => ({ pubkey })), instructions: [] } }, meta: { err: null, fee, preBalances: pre, postBalances: post } });
  const W = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"; // on-curve example keys
  const F = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  it("funder = the account with the largest lamport drop (fee excluded); counts credited accounts", () => {
    const r = solanaReceipt(tx([F, W], [10_000_000, 0], [8_995_000, 1_000_000]), W);
    expect(r).toEqual({ funder: F, credited: 1 });
  });
  it("no SOL rise for the wallet ⇒ not a receipt (no fee-payer fallback)", () => {
    expect(solanaReceipt(tx([F, W], [10_000_000, 5], [9_995_000, 5]), W)).toBeNull();
  });
  it("a failed tx is never a receipt", () => {
    const t = tx([F, W], [10_000_000, 0], [8_995_000, 1_000_000]);
    t.meta!.err = { InstructionError: [0, "x"] };
    expect(solanaReceipt(t, W)).toBeNull();
  });
});

describe("scoring: wallet_clusters factor and caps", () => {
  const live = (o: Record<string, unknown>) => scoreSnapshot(perfectSnapshot("solana", { walletClusterState: "live", walletClusterMeter: 10, clusterSupplyMinPct: 0, founderClusterOnly: null, clusterResolvedWallets: 20, clusterSampleWallets: 20, clusterLargestText: "no linked group among 20 resolved wallets", clusterSameTimeText: "no two wallets funded by one source within 30s", ...o }));
  const fired = (r: ReturnType<typeof live>) => r.rules.filter((x) => x.state === "fired").map((x) => x.id);

  it("a clean live check: factor scored full, S requirement passes", () => {
    const r = live({});
    const f = r.groups.flatMap((g) => g.factors).find((x) => x.id === "wallet_clusters")!;
    expect(f.points).toBe(f.max);
    expect(f.evidence).toMatch(/^Meter 10\/100 — no linked group among 20 resolved wallets;/);
    expect(r.requirements.find((q) => q.id === "s_clusters:S")!.state).toBe("pass");
  });
  it("a proven linked group of 12% ⇒ capped at A, never S", () => {
    const r = live({ clusterSupplyMinPct: 12, clusterSupplyText: "12.0%", walletClusterMeter: 30 });
    expect(fired(r)).toContain("cluster_10");
    expect(["A", "B", "C", "D", "F"]).toContain(r.tier);
  });
  it("22% ⇒ C, 49.9% ⇒ D (cluster_35), 50% ⇒ D (full bundle)", () => {
    expect(fired(live({ clusterSupplyMinPct: 22, walletClusterMeter: 70 }))).toContain("cluster_20");
    expect(["C", "D", "F"]).toContain(live({ clusterSupplyMinPct: 22, walletClusterMeter: 70 }).tier);
    const r = live({ clusterSupplyMinPct: 49.9, walletClusterMeter: 90 });
    expect(fired(r)).toContain("cluster_35");
    expect(["D", "F"]).toContain(r.tier);
    expect(fired(live({ clusterSupplyMinPct: 50, walletClusterMeter: 90 }))).toContain("full_bundle");
  });
  it("founder-only group of 25% ⇒ the founder cap (A), not C", () => {
    const r = live({ clusterSupplyMinPct: 25, founderClusterOnly: true, walletClusterMeter: 40 });
    expect(fired(r)).toContain("cluster_20_founder");
    expect(fired(r)).not.toContain("cluster_20");
  });
  it("founderClusterOnly missing (unknown) ⇒ the normal cap still fires", () => {
    expect(fired(live({ clusterSupplyMinPct: 25, founderClusterOnly: undefined }))).toContain("cluster_20");
  });
  it("pending ⇒ factor n/a (not missing), S blocked, A still reachable", () => {
    const r = live({ walletClusterState: "pending", walletClusterPending: true, walletClusterMeter: null, clusterSupplyMinPct: null, clusterResolvedWallets: 6 });
    const f = r.groups.flatMap((g) => g.factors).find((x) => x.id === "wallet_clusters")!;
    expect(f.applicable).toBe(false);
    expect(f.missing).toBe(false);
    expect(f.evidence).toMatch(/funding origin read for 6 of 20 wallets/);
    expect(r.requirements.find((q) => q.id === "s_clusters:S")!.state).not.toBe("pass");
  });
  it("null (not pending) ⇒ missing with the step's reason; caps 'unknown', never passed", () => {
    const r = scoreSnapshot(perfectSnapshot("solana", { walletClusterState: "null", walletClusterMeter: null, clusterSupplyMinPct: null, nullReasons: { walletClusterMeter: "Helius key not set" } }));
    const f = r.groups.flatMap((g) => g.factors).find((x) => x.id === "wallet_clusters")!;
    expect(f.missing).toBe(true);
    expect(f.nullReason).toBe("Helius key not set");
    expect(r.rules.find((x) => x.id === "cluster_20")!.state).toBe("unknown");
  });
  it("monotone: a bigger proven group never raises the tier or the displayed score", () => {
    const order = ["S", "A", "B", "C", "D", "F", "U"];
    let prev = live({ clusterSupplyMinPct: 0 });
    for (const pct of [5, 10.5, 15, 20.5, 30, 35, 49, 50, 80]) {
      const r = live({ clusterSupplyMinPct: pct, walletClusterMeter: Math.min(100, pct * 2) });
      expect(order.indexOf(r.tier)).toBeGreaterThanOrEqual(order.indexOf(prev.tier));
      expect((r.score ?? 0) <= (prev.score ?? 0) + 1e-9).toBe(true);
      prev = r;
    }
  });
  it("Robinhood stays on the shared established set (unchanged, no cluster factor); Solana gets established_solana", () => {
    const rh = setFor(defaultConfig, "established", "robinhood");
    expect(rh).toBe(defaultConfig.sets.established);
    expect(rh.groups.flatMap((g) => g.factors).some((f) => f.id === "wallet_clusters")).toBe(false);
    expect(rh.groups.find((g) => g.id === "holders")!.factors.find((f) => f.id === "top10_share")!.weight).toBe(8);
    const sol = setFor(defaultConfig, "established", "solana");
    expect(sol).toBe(defaultConfig.sets.established_solana);
    expect(sol.groups.find((g) => g.id === "holders")!.factors.find((f) => f.id === "wallet_clusters")!.weight).toBe(5);
    expect(setFor(defaultConfig, "launch", "robinhood").groups.flatMap((g) => g.factors).some((f) => f.id === "wallet_clusters")).toBe(false);
  });
  it("a holder source listing fewer than 8 wallets: n/a with the reason (not missing, never a number)", () => {
    const r = scoreSnapshot(perfectSnapshot("monad", { walletClusterState: "null", walletClusterMeter: null, clusterSampleWallets: 4, clusterResolvedWallets: 3, clusterSupplyMinPct: null }));
    const f = r.groups.flatMap((g) => g.factors).find((x) => x.id === "wallet_clusters")!;
    expect(f.applicable).toBe(false);
    expect(f.missing).toBe(false);
    expect(f.evidence).toMatch(/^Only 4 holder wallets to sample/);
  });
  it("a dead launch has no wallets to cluster: n/a, not missing", () => {
    const r = scoreSnapshot(perfectSnapshot("solana", { ageHours: 10, deadLaunch: true, walletClusterState: undefined, walletClusterMeter: null }));
    const f = r.groups.flatMap((g) => g.factors).find((x) => x.id === "wallet_clusters")!;
    expect(f.applicable).toBe(false);
    expect(f.missing).toBe(false);
  });
});

describe("background episodes (B2)", () => {
  // Imported lazily: collect.ts pulls in next/server's after(), which these pure checks do not need.
  const step = async (...a: Parameters<typeof import("@/lib/cluster/collect").episodeStep>) => (await import("@/lib/cluster/collect")).episodeStep(...a);
  const NOW = 1_800_000_000_000;
  const MIN = 60_000;

  it("an expired episode with never-read wallets starts a new one and schedules reads (the brett regression)", async () => {
    const r = await step({ attempts: 0, startedAt: NOW - 120 * MIN }, NOW, cfg, { neverRead: 2, retryable: 2, unresolved: 2 });
    expect(r.schedule).toBe(true);
    expect(r.progress).toEqual({ attempts: 1, startedAt: NOW });
    expect(r.endState).toBe(false);
  });
  it("within an episode: up to 3 attempts, then the end state (no new episode until it expires)", async () => {
    const third = await step({ attempts: 2, startedAt: NOW - 10 * MIN }, NOW, cfg, { neverRead: 0, retryable: 3, unresolved: 3 });
    expect(third.schedule).toBe(true);
    expect(third.progress.attempts).toBe(3);
    const spent = await step({ attempts: 3, startedAt: NOW - 10 * MIN }, NOW, cfg, { neverRead: 1, retryable: 3, unresolved: 3 });
    expect(spent.schedule).toBe(false);
    expect(spent.endState).toBe(true);
  });
  it("expired with nothing never-read: no new episode, end state for what is still owed", async () => {
    const r = await step({ attempts: 1, startedAt: NOW - 60 * MIN }, NOW, cfg, { neverRead: 0, retryable: 2, unresolved: 2 });
    expect(r.schedule).toBe(false);
    expect(r.endState).toBe(true);
  });
  it("everything resolved: attempts reset, nothing scheduled, no end state", async () => {
    const r = await step({ attempts: 2, startedAt: NOW - 5 * MIN }, NOW, cfg, { neverRead: 0, retryable: 0, unresolved: 0 });
    expect(r).toEqual({ progress: { attempts: 0, startedAt: NOW }, schedule: false, endState: false });
  });
});

describe("proven token-only wallets (EVM) and the small-sample bar", () => {
  const evmOrigin = (wallet: string, extra: Partial<Origin>): Origin => ({ wallet, fundT: null, fundRef: null, funder: null, funderKind: "unknown", via: null, fundTx: null, method: "archive-2stage", final: false, ...extra });
  const evmGraph = (wallets: SampleWallet[], origins: Origin[]) => buildGraph({ chain: "ethereum", token: "0xtoken", wallets, origins: new Map(origins.map((o) => [o.wallet, o])), funders: new Map(), deployers: new Set(), cfg, computedAt: 0 });
  const nine = (lastPct: number) => Array.from({ length: 9 }, (_, i) => holder(i, i === 8 ? lastPct : 5));
  const resolved8 = (ws: SampleWallet[]) => ws.slice(0, 8).map((w) => evmOrigin(w.address, { funder: `0xf${w.address}`, funderKind: "eoa", fundT: T, fundRef: 1 }));

  it("a small proven token-only wallet no longer holds the bar hostage (the PEPE case: 8 of 9 + one token-only)", () => {
    const ws = nine(0.5);
    const g = evmGraph(ws, [...resolved8(ws), evmOrigin(ws[8].address, { reason: "never held native coin (token-only wallet)" })]);
    expect(g.nodes[8].status).toBe("excluded");
    expect(g.nodes[8].excludedReason).toMatch(/^token-only wallet \(never held native coin, holds 0\.5%\)/);
    expect(meterFields({ graph: g, cfg, mode: "established", pending: false, attempts: 1 }).walletClusterState).toBe("live");
  });
  it("a large token-only wallet (> 2%) still blocks; an unproven or Solana token-first one is never treated as read", () => {
    const ws = nine(6);
    const big = evmGraph(ws, [...resolved8(ws), evmOrigin(ws[8].address, { reason: "never held native coin (token-only wallet)" })]);
    expect(big.nodes[8].status).toBe("unresolved");
    const sponsored = evmGraph(nine(0.5), [...resolved8(nine(0.5)), evmOrigin(nine(0.5)[8].address, { reason: "no native coin before its first transaction (block 9): gas was sponsored or paid in the same block" })]);
    expect(sponsored.nodes[8].status).toBe("unresolved");
    const sol = graphOf([holder(1, 0.5)], [origin("w01", null as unknown as string, null, { funder: null, reason: "first 25 transactions carry no SOL receipt (token-first wallet: tokens arrived before any SOL)" })]);
    expect(sol.nodes[0].status).toBe("unresolved");
  });
});
