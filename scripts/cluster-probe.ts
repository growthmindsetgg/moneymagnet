/**
 * Wallet-cluster probe: runs collect() on one token and prints the cluster step (state, coverage, clusters, why).
 * Usage: node --import tsx scripts/cluster-probe.ts <chain> <address>   (add --env-file-if-exists=.env.local for keys)
 * Origins resolved here are cached like in production, so repeated runs show the cache filling up.
 */
import { collect } from "../lib/analyze";
const [chain, address] = [process.argv[2] as "base", process.argv[3]];
const t0 = Date.now();
const { snapshot: s } = await collect(chain, address, { chain });
const g = s.walletClusterGraph;
console.log(`${chain} ${Math.round((Date.now() - t0) / 1000)}s total | state=${s.walletClusterState} meter=${s.walletClusterMeter} pending=${s.walletClusterPending} attempts=${s.walletClusterAttempts}`);
console.log(`resolved ${s.clusterResolvedWallets}/${s.clusterSampleWallets} · holder supply resolved ${s.clusterHolderSupplyResolvedPct}% · clusters ${s.clusterCount} · proven ${s.clusterSupplyMinPct} · sameTimeFunded ${s.sameTimeFundedMax}`);
console.log(`reason: ${s.nullReasons.walletClusterMeter ?? "-"}`);
console.log(`largest: ${s.clusterLargestText} | ${s.clusterSameTimeText}`);
const by = new Map<string, number>();
for (const n of g?.nodes ?? []) { const k = n.status + (n.origin?.reason ? `: ${n.origin.reason.slice(0, 70)}` : ""); by.set(k, (by.get(k) ?? 0) + 1); }
for (const [k, v] of by) console.log(`  ${v} × ${k}`);
for (const c of g?.clusters ?? []) console.log(`  cluster ${c.id}: ${c.members.length} wallets ${c.supplyPct}% · ${c.evidence}`);
for (const e of g?.exclusions ?? []) console.log(`  excluded funder ${e.label} (${e.kind}) × ${e.wallets}`);
process.exit(0);
