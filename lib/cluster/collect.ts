import { after } from "next/server";
import type { AdapterResult, Chain, TokenSnapshot } from "../types";
import { defaultConfig, modeFor } from "../scoring/config";
import { isEvmChain, type EvmChain } from "../chain";
import { kvGet, kvSet } from "../kv";
import { archiveRpc, chainRpc, makeRpc, type Rpc } from "../onchain/rpc";
import { chainCexLabel, chainInfraEntry } from "../onchain/chainInfra";
import { infraEntry } from "../onchain/infra";
import { heliusClient, isProgramAddress, type Helius } from "../timemachine/solana";
import { cachedOrigins, originKey, originOf, type FunderKind, type Origin, type OriginCtx } from "../onchain/origin";
import { buildGraph, exchangeLikeMembers, nodeStatus, type FunderFact, type SampleWallet, type WalletClustersCfg } from "./graph";
import { meterFields } from "./meter";

/**
 * The wallet-cluster step (plan §3.3, §3.7). Started as soon as the holder list is merged — in parallel with the
 * top-holder classification and Holder Strength — and finished once they are done (labels, this run's balances).
 *
 * Inline: cached origins in one KV read, then the priority wallets' funding (top holders + first buyers) within
 * CLUSTER_BUDGET_MS. The rest is read in the background (≤ maxAttempts per 6h, ≤ maxAgeSec), the factor is n/a while
 * that runs, and the next analysis picks the cached results up. Never a guessed funder.
 */

export const CLUSTER_BUDGET_MS = () => Number(process.env.CLUSTER_BUDGET_MS || 8_000);
const BACKGROUND_MS = 35_000;
const PROGRESS_TTL_S = 6 * 3_600;
const FUNDER_TTL_S = 7 * 86_400;

interface Progress {
  attempts: number;
  startedAt: number;
}

export interface WalletClusterRun {
  finish(snapshot: TokenSnapshot): Promise<void>;
}

const NOOP: WalletClusterRun = { finish: async () => undefined };

const norm = (chain: Chain, a: string) => (chain === "solana" ? a : a.toLowerCase());

/** Sampled holders (top counted wallets, dust / programs / infra / exchanges out) and first buyers. */
export function buildSample(chain: Chain, snapshot: TokenSnapshot, results: AdapterResult[], cfg: WalletClustersCfg): { wallets: SampleWallet[]; buyersNa: string | null } {
  const pools = new Set((snapshot.poolAddresses ?? []).map((a) => norm(chain, a)));
  const heliusRaw = results.find((r) => r.status.id === "helius")?.raw as { curve?: string | null; firstBuyers?: { wallet: string; t: number | null; slot: number | null }[] | null } | undefined;
  if (heliusRaw?.curve) pools.add(heliusRaw.curve);
  const infra = (a: string) => {
    if (chain === "solana") return isProgramAddress(a);
    if (chain === "robinhood") return !!infraEntry(a) || !!chainCexLabel("robinhood", a);
    return !!chainInfraEntry(chain as EvmChain, a) || !!chainCexLabel(chain as EvmChain, a);
  };
  const holders = (snapshot.holders ?? [])
    .filter((h) => h.kind !== "liquidity" && (h.pct ?? 0) >= cfg.dustPct && !pools.has(norm(chain, h.address)) && !infra(h.address))
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
    .slice(0, cfg.sample.holders);
  const out = new Map<string, SampleWallet>();
  for (const h of holders) out.set(norm(chain, h.address), { address: h.address, role: "holder", pct: h.pct ?? null, buyRank: null, buyT: null, buyRef: null, holderClass: null });

  let buyersNa: string | null = null;
  const firstBuyers = chain === "solana" ? (heliusRaw?.firstBuyers ?? null) : null;
  if (!firstBuyers) buyersNa = chain === "solana" ? "first buyers not reconstructable: no bonding-curve replay for this token (graduated before the replay window, or not a pump.fun launch)" : `first-buyer reconstruction on ${chain} is not built yet — the meter reads holders only`;
  else {
    let rank = 0;
    for (const b of firstBuyers) {
      if (rank >= cfg.sample.buyers) break;
      if (pools.has(b.wallet) || infra(b.wallet)) continue;
      rank++;
      const k = norm(chain, b.wallet);
      const held = out.get(k);
      if (held) Object.assign(held, { role: "both", buyRank: rank, buyT: b.t, buyRef: b.slot });
      else out.set(k, { address: b.wallet, role: "buyer", pct: 0, buyRank: rank, buyT: b.t, buyRef: b.slot, holderClass: null });
    }
    if (!rank) buyersNa = "no first buyers left after excluding pools and programs";
  }
  return { wallets: [...out.values()], buyersNa };
}

async function mapLimit<T>(items: T[], limit: number, deadline: number, fn: (x: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && Date.now() < deadline) await fn(items[next++]).catch(() => undefined);
    }),
  );
}

function deployersOf(chain: Chain, snapshot: TokenSnapshot, results: AdapterResult[]): Set<string> {
  const out = new Set<string>();
  if (snapshot.deployerAddress) out.add(norm(chain, snapshot.deployerAddress));
  const creator = (results.find((r) => r.status.id === "helius")?.raw as { creator?: string | null } | undefined)?.creator;
  if (creator) out.add(creator);
  for (const h of snapshot.holderClasses ?? []) if (h.class === "founder") out.add(norm(chain, h.address));
  return out;
}

/** Funder facts: deployer, exchange / infrastructure labels, contracts, and the hub test for shared funders (cached 7d). */
async function classifyFunders(chain: Chain, origins: Map<string, Origin>, deployers: Set<string>, ctx: { helius: Helius | null; rpc: Rpc | null; deadline: number }, cfg: WalletClustersCfg): Promise<Map<string, FunderFact>> {
  const count = new Map<string, number>();
  const kindFromOrigin = new Map<string, FunderKind>();
  for (const o of origins.values()) {
    if (!o.funder) continue;
    const f = norm(chain, o.funder);
    count.set(f, (count.get(f) ?? 0) + 1);
    if (o.funderKind === "contract" || o.funderKind === "relayer" || o.funderKind === "aa_bundler") kindFromOrigin.set(f, o.funderKind);
  }
  const out = new Map<string, FunderFact>();
  await Promise.all(
    [...count.entries()].map(async ([f, n]) => {
      if (deployers.has(f)) return out.set(f, { kind: "deployer", label: "deployer" });
      const ok = kindFromOrigin.get(f);
      if (ok) return out.set(f, { kind: ok, label: ok === "contract" ? "contract" : ok });
      if (chain === "solana" && isProgramAddress(f)) return out.set(f, { kind: "program", label: "program account" });
      if (isEvmChain(chain)) {
        const cex = chainCexLabel(chain as EvmChain, f);
        if (cex) return out.set(f, { kind: "cex", label: cex });
        const e = chain === "robinhood" ? infraEntry(f) : chainInfraEntry(chain as EvmChain, f);
        if (e) return out.set(f, { kind: /bridge/i.test(e.label) ? "bridge" : /launchpad|curve/i.test(e.role) ? "launchpad" : "router", label: e.label });
      }
      // The hub test only matters for funders shared by ≥ 2 sampled wallets.
      if (n < 2 || Date.now() >= ctx.deadline) return out.set(f, { kind: "eoa" });
      const hub = await hubLabel(chain, f, ctx, cfg);
      out.set(f, hub ? { kind: "eoa", hub: true, label: `high-volume sender (${hub})` } : { kind: "eoa" });
    }),
  );
  return out;
}

/**
 * High-activity test (cached 7 days at hub:v1): ≥ hubSigs signatures in one page (Solana) or nonce > hubNonce (EVM).
 * Returns a short label ("≥ 1000 transactions" / "nonce 48211") or null. Unknown (read failed) ⇒ null, not cached.
 */
async function hubLabel(chain: Chain, address: string, ctx: { helius: Helius | null; rpc: Rpc | null }, cfg: WalletClustersCfg): Promise<string | null> {
  const key = `hub:v1:${chain}:${address}`;
  const hit = await kvGet<{ label: string | null }>(key);
  if (hit) return hit.label;
  try {
    let label: string | null = null;
    if (chain === "solana" && ctx.helius) {
      const sigs = await ctx.helius<{ signature: string }[]>("getSignaturesForAddress", [address, { limit: cfg.hubSigs }]);
      if (sigs.length >= cfg.hubSigs) label = `≥ ${cfg.hubSigs} transactions`;
    } else if (ctx.rpc) {
      const nonce = Number(await ctx.rpc<string>("eth_getTransactionCount", [address, "latest"]));
      if (nonce > cfg.hubNonce) label = `nonce ${nonce}`;
    } else return null;
    await kvSet(key, { label }, FUNDER_TTL_S);
    return label;
  } catch {
    return null;
  }
}

/** Starts the step: cached origins + priority funding reads begin now; finish() builds the graph and the meter. */
export function startWalletClusters(chain: Chain, token: string, snapshot: TokenSnapshot, results: AdapterResult[], requestDeadline: number): WalletClusterRun {
  const cfg = defaultConfig.walletClusters;
  if (!cfg) return NOOP;
  const { wallets, buyersNa } = buildSample(chain, snapshot, results, cfg);
  const evmArchive = isEvmChain(chain) && chain !== "robinhood" ? archiveRpc(chain as EvmChain) : null;
  const partialReason = chain === "robinhood" ? "partial: native funding not readable on Robinhood Chain (public RPC keeps no historical state) — linked-wallet groups are not scored here yet" : null;
  const helius = chain === "solana" && process.env.HELIUS_API_KEY ? heliusClient(process.env.HELIUS_API_KEY) : null;
  const memo = new Map<string, Promise<Origin>>();
  const inlineDeadline = Math.min(Date.now() + CLUSTER_BUDGET_MS(), requestDeadline - 1_500);
  const ctx: OriginCtx = { deadline: inlineDeadline, memo, helius, archive: evmArchive };
  const addrs = wallets.map((w) => w.address);

  const cached = partialReason ? Promise.resolve(new Map<string, Origin>()) : cachedOrigins(chain, addrs);
  const inline = (async () => {
    if (partialReason || !wallets.length) return;
    const known = await cached;
    const priority = [
      ...wallets.filter((w) => w.role !== "buyer").slice(0, cfg.inline.holders),
      ...wallets.filter((w) => w.buyRank != null).slice(0, cfg.inline.buyers),
    ].filter((w, i, a) => a.indexOf(w) === i && !known.has(w.address));
    await mapLimit(priority, chain === "solana" ? 4 : 3, inlineDeadline, (w) => originOf(chain, w.address, ctx));
  })();
  inline.catch(() => undefined);

  return {
    async finish(snap: TokenSnapshot) {
      const cfgNow = cfg;
      await Promise.race([inline, new Promise((r) => setTimeout(r, Math.max(0, inlineDeadline - Date.now())))]);
      const origins = new Map<string, Origin>(await cached);
      for (const w of wallets) {
        const p = memo.get(originKey(chain, w.address));
        if (!p) continue;
        const o = await Promise.race([p, Promise.resolve(null)]);
        if (o) origins.set(w.address, o);
      }

      // This run's balances and labels (after the top-holder classification moved vesting / lockers out).
      const counted = new Map((snap.holders ?? []).map((h) => [norm(chain, h.address), h.pct ?? null]));
      const classes = new Map((snap.holderClasses ?? []).map((h) => [norm(chain, h.address), h]));
      const sample: SampleWallet[] = [];
      for (const w of wallets) {
        const c = classes.get(norm(chain, w.address));
        if (c && !c.counted) continue; // vesting / locker / staking / proven pool: not a holder wallet
        if (c?.label && /exchange|\bcex\b/i.test(c.label)) continue; // exchange custody: counted in concentration, not a cluster member
        const pct = counted.get(norm(chain, w.address));
        sample.push({ ...w, pct: pct ?? (w.role === "buyer" ? 0 : w.pct), holderClass: c?.class ?? null });
      }

      const deployers = deployersOf(chain, snap, results);
      const rpc = evmArchive ?? (isEvmChain(chain) ? (chain === "robinhood" ? makeRpc() : chainRpc(chain as EvmChain)) : null);
      const funders = partialReason ? new Map<string, FunderFact>() : await classifyFunders(chain, origins, deployers, { helius, rpc, deadline: Math.max(inlineDeadline, Date.now() + 1_500) }, cfgNow);

      // Background reads for what is still unresolved, within the end-state limits.
      const unresolved = sample.filter((w) => nodeStatus(origins.get(w.address) ?? null, origins.get(w.address)?.funder ? funders.get(norm(chain, origins.get(w.address)!.funder!)) : undefined) === "unresolved");
      const progressKey = `clusters:v1:${chain}:${norm(chain, token)}`;
      const prog = (await kvGet<Progress>(progressKey)) ?? { attempts: 0, startedAt: Date.now() };
      const fresh = Date.now() - prog.startedAt <= cfgNow.pending.maxAgeSec * 1000;
      // Retryable: wallets with no origin yet, or a non-final one whose reason is a budget / outage (not a proven gap).
      const retryable = unresolved.filter((w) => {
        const o = origins.get(w.address);
        return !o || /time budget|failed|rate|timed out|unreachable|not reachable inline/i.test(o.reason ?? "");
      });
      let pending = false;
      if (!partialReason && retryable.length && prog.attempts < cfgNow.pending.maxAttempts && fresh) {
        pending = true;
        const next = { attempts: prog.attempts + 1, startedAt: prog.startedAt };
        await kvSet(progressKey, next, PROGRESS_TTL_S).catch(() => undefined);
        prog.attempts = next.attempts;
        const bgCtx: OriginCtx = { deadline: Date.now() + BACKGROUND_MS, memo: new Map(), helius, archive: evmArchive };
        try {
          after(() => mapLimit(retryable, chain === "solana" ? 4 : 3, bgCtx.deadline, (w) => originOf(chain, w.address, bgCtx)).then(() => undefined, () => undefined));
        } catch {
          // Outside a request (scripts): the next analysis continues from the cached origins.
        }
      } else if (!unresolved.length && prog.attempts) {
        await kvSet(progressKey, { attempts: 0, startedAt: Date.now() }, PROGRESS_TTL_S).catch(() => undefined);
      }

      let graph = buildGraph({ chain, token, wallets: sample, origins, funders, deployers, cfg: cfgNow, computedAt: Date.now() });
      // Exchange-like custody wallets inside a group leave the sample (still counted in concentration), then re-link.
      if (!partialReason && graph.clusters.length) {
        const members = [...new Set(graph.clusters.flatMap((c) => c.members))];
        const hubs = new Map<string, string>();
        await mapLimit(members, 4, Math.max(Date.now() + 3_000, inlineDeadline), async (m) => {
          const label = await hubLabel(chain, norm(chain, m), { helius, rpc }, cfgNow);
          if (label) hubs.set(norm(chain, m), label);
        });
        const drop = exchangeLikeMembers(graph, hubs, deployers);
        if (drop.length) {
          const gone = new Set(drop.map((d) => d.address));
          const kept = sample.filter((w) => !gone.has(w.address));
          graph = buildGraph({ chain, token, wallets: kept, origins, funders, deployers, cfg: cfgNow, computedAt: Date.now() });
          graph.custody = drop.map((d) => ({ address: d.address, label: `exchange-like custody wallet (${d.label})`, pct: sample.find((w) => w.address === d.address)?.pct ?? null }));
        }
      }
      const fields = meterFields({ graph, cfg: cfgNow, mode: modeFor(snap.ageHours, defaultConfig), pending, attempts: prog.attempts, buyersNa, partialReason });
      const { nullReasons, ...values } = fields;
      Object.assign(snap, values);
      snap.walletClusterGraph = graph;
      // This step owns these fields: its reasons replace earlier ones; a value it set clears a stale reason.
      const nr = { ...snap.nullReasons };
      for (const k of Object.keys(values)) if ((values as Record<string, unknown>)[k] != null) delete nr[k];
      snap.nullReasons = { ...nr, ...nullReasons };
    },
  };
}
