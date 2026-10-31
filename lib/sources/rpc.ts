import type { AdapterResult, HolderRow, TokenSnapshot } from "../types";
import { getKV, kvGet, kvSet } from "../kv";
import { deployerStats, findCreation, type Creation, type DeployerStats } from "../onchain/creation";
import { creationKey, replayKey } from "../onchain/keys";
import { advanceReplay, newReplayState, rankHolders, replayProgressPct, type ReplayState } from "../onchain/replay";
import { codeKind, makeRpc, type Rpc } from "../onchain/rpc";
import { infraEntry, isInfrastructure, launchpadOfFactory } from "../onchain/infra";
import infraRegistry from "@/data/robinhood-infra.json";

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO_WORD = /^0x0*$/;
const TOP_HOLDERS = 60;

export interface RpcOptions {
  rpc?: Rpc;
  /** Time allowed for advancing the Transfer-log replay in this request. */
  replayBudgetMs?: number;
}

async function safeCall(rpc: Rpc, to: string, data: string): Promise<string | null> {
  try {
    return await rpc<string>("eth_call", [{ to, data }, "latest"], 10_000);
  } catch {
    return null; // revert, e.g. no owner() function
  }
}

/** Supply sitting in registered infrastructure (pool managers, curves, vaults, burn addresses). */
async function registeredInfraHeld(rpc: Rpc, token: string): Promise<bigint> {
  const holders = infraRegistry.addresses.filter((e) => ["v4-pool-manager", "bonding-curve", "burn"].includes(e.role)).map((e) => e.address.toLowerCase());
  const bals = await Promise.all(
    holders.map((h) => rpc<string>("eth_call", [{ to: token, data: "0x70a08231" + h.slice(2).padStart(64, "0") }, "latest"], 10_000).then((r) => (r && r !== "0x" ? BigInt(r) : 0n)).catch(() => 0n)),
  );
  return bals.reduce((a, b) => a + b, 0n);
}

const pctOf = (raw: bigint, supply: bigint) => (supply > 0n ? Number((raw * 1_000_000n) / supply) / 10_000 : null);

/**
 * Robinhood Chain reads straight from the RPC: supply, ownership, proxy status, the deployer
 * (first mint tx sender), deployer flows, and holder balances from a resumable Transfer-log replay.
 */
export async function robinhoodRpc(address: string, opts: RpcOptions = {}): Promise<AdapterResult> {
  const t0 = Date.now();
  const rpc = opts.rpc ?? makeRpc();
  const a = address.toLowerCase();
  const [code, supplyHex, decHex, ownerHex, implSlot, headHex] = await Promise.all([
    rpc<string>("eth_getCode", [a, "latest"], 15_000),
    safeCall(rpc, a, "0x18160ddd"),
    safeCall(rpc, a, "0x313ce567"),
    safeCall(rpc, a, "0x8da5cb5b"),
    rpc<string>("eth_getStorageAt", [a, EIP1967_IMPL, "latest"], 10_000).catch(() => null),
    rpc<string>("eth_blockNumber", [], 10_000),
  ]);
  if (!code || code === "0x") {
    return { status: { id: "rpc", label: "Robinhood RPC", state: "partial", message: "No contract code at this address", ms: Date.now() - t0 }, data: { tokenExists: false } };
  }
  const head = Number(headHex);
  const decimals = decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18;
  const supplyRaw = supplyHex && supplyHex !== "0x" ? BigInt(supplyHex) : null;
  const scale = 10 ** decimals;
  const totalSupply = supplyRaw != null ? Number(supplyRaw) / scale : null;

  let ownerRenounced: boolean | null = true; // owner() reverting = no Ownable owner
  if (ownerHex && ownerHex !== "0x") {
    const owner = `0x${ownerHex.slice(-40)}`.toLowerCase();
    ownerRenounced = /^0x0{40}$/.test(owner) || owner === "0x000000000000000000000000000000000000dead";
  }

  const data: Partial<TokenSnapshot> = {
    totalSupply,
    ownerRenounced,
    upgradeable: implSlot == null ? null : !ZERO_WORD.test(implSlot),
  };
  const notes: string[] = [];
  const raw: Record<string, unknown> = { owner: ownerHex, implSlot, head, supplyRaw: supplyRaw?.toString() ?? null, decimals };
  data.nullReasons = { creatorHasSocials: "Robinhood Chain ERC-20s carry no social-link metadata" };

  // 1. Creation + deployer (cached forever: it never changes).
  let creation = await kvGet<Creation>(creationKey(a));
  if (!creation) {
    try {
      creation = await findCreation(rpc, a, head);
      if (creation) await kvSet(creationKey(a), creation);
    } catch (err) {
      notes.push(`creation lookup failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }
  // Older cache entries predate the factory field: backfill it once from the creation tx.
  if (creation && creation.factory === undefined) {
    const tx = await rpc<{ to: string | null } | null>("eth_getTransactionByHash", [creation.mintTx], 10_000).catch(() => null);
    if (tx) {
      creation = { ...creation, factory: tx.to ? tx.to.toLowerCase() : null };
      await kvSet(creationKey(a), creation);
    }
  }
  // Launchpad from the creation tx's factory (not from an indexer's label).
  if (creation && creation.factory !== undefined) {
    const lp = launchpadOfFactory(creation.factory);
    data.isLaunchpad = !!lp;
    if (lp) data.launchpad = lp;
    raw.factory = creation.factory ? { address: creation.factory, label: infraEntry(creation.factory)?.label ?? "unregistered contract" } : "direct deploy (contract-creation tx)";
  }
  // Older cache entries predate the timestamp field: backfill it once from the block header.
  if (creation && creation.timestamp == null) {
    const block = await rpc<{ timestamp: string } | null>("eth_getBlockByNumber", [`0x${creation.creationBlock.toString(16)}`, false], 10_000).catch(() => null);
    if (block) {
      creation = { ...creation, timestamp: Number(block.timestamp) };
      await kvSet(creationKey(a), creation);
    }
  }
  if (creation?.timestamp) data.createdAt = new Date(creation.timestamp * 1000).toISOString();
  raw.creation = creation;

  // 2. Deployer flows (filtered logs + balanceOf), cached 10 minutes. Supply held by registered
  // infrastructure (PoolManager, curves, burn) is excluded from the holding denominator.
  if (creation) {
    data.deployerAddress = creation.deployer;
    const dKey = `deployer:v3:robinhood:${a}`;
    let stats = await kvGet<Record<string, string | number | null>>(dKey);
    if (!stats) {
      try {
        const infraHeldRaw = await registeredInfraHeld(rpc, a);
        const d: DeployerStats = await deployerStats(rpc, a, creation.deployer, creation.creationBlock, head, supplyRaw, { creationTx: creation.mintTx, infraHeldRaw });
        stats = {
          balance: d.balance.toString(),
          received: d.received.toString(),
          sentToContracts: d.sentToContracts.toString(),
          sentToWallets: d.sentToWallets.toString(),
          lpSeeded: d.lpSeeded.toString(),
          distributed: d.distributed.toString(),
          distributedPct: d.distributedPct,
          infraHeld: infraHeldRaw.toString(),
          holdingPct: d.holdingPct,
          soldPct: d.soldPct,
        };
        await kvSet(dKey, stats, 600);
      } catch (err) {
        notes.push(`deployer flows failed: ${(err as Error).message.slice(0, 80)}`);
      }
    }
    if (stats) {
      data.deployerHoldingPct = stats.holdingPct as number | null;
      data.deployerSoldPct = stats.soldPct as number;
      data.deployerDistributedPct = (stats.distributedPct as number | undefined) ?? null;
      data.deployerHasSold = BigInt(stats.sentToContracts as string) > 0n;
      raw.deployer = stats;
    }
  }

  // 3. Holder balances via a resumable Transfer-log replay. Failures here only cost holder data.
  let state: ReplayState | null = null;
  const stored = creation ? await kvGet<ReplayState>(replayKey(a)) : null;
  // A full replay can take many minutes (microduck: 1.57M logs); per-instance memory can never finish
  // it and only burns the RPC's rate limit, so it needs durable KV unless a state already exists.
  const durable = getKV().kind !== "memory";
  if (creation && !stored && !durable) {
    notes.push("holder replay skipped: needs persistent KV (neither UPSTASH_REDIS_REST_URL nor DATABASE_URL set) — using swap-index holders");
    raw.replay = { skipped: "no durable KV" };
  } else if (creation) try {
    state = stored ?? newReplayState(a, creation.creationBlock);
    state = await advanceReplay(rpc, state, head, { budgetMs: opts.replayBudgetMs ?? Number(process.env.REPLAY_BUDGET_MS || 20_000) });

    if (state.complete && supplyRaw) {
      const { top, count } = rankHolders(state.balances, TOP_HOLDERS);
      const unknown = top.filter((h) => !state!.codeKinds[h.address]);
      const codes = await Promise.all(unknown.map((h) => rpc<string>("eth_getCode", [h.address, "latest"], 10_000).catch(() => null)));
      unknown.forEach((h, i) => {
        if (codes[i] != null) state!.codeKinds[h.address] = codeKind(codes[i]);
      });
      const holders: HolderRow[] = top.map((h) => {
        const kind = state!.codeKinds[h.address];
        return {
          address: h.address,
          qty: Number(h.raw) / scale,
          pct: pctOf(h.raw, supplyRaw),
          buys: null,
          sells: null,
          isContract: kind ? kind === "contract" : null,
          kind: isInfrastructure(h.address, kind) ? "liquidity" : "wallet",
          ...(infraEntry(h.address) ? { label: infraEntry(h.address)!.label } : {}),
        };
      });
      data.holders = holders;
      data.holderCount = count;
      data.holderSource = "onchain";
    }
    // Concurrent requests (or the pre-warm script) may have advanced further — never move backwards.
    const latest = await kvGet<Pick<ReplayState, "scannedTo">>(replayKey(a));
    if (!latest || latest.scannedTo <= state.scannedTo) await kvSet(replayKey(a), state);
    const pct = replayProgressPct(state, head);
    notes.push(
      state.complete
        ? `replay at block ${state.scannedTo} (${state.logCount.toLocaleString("en-US")} Transfer logs)`
        : `holder replay ${pct.toFixed(1)}% (${state.logCount.toLocaleString("en-US")} logs so far) — using swap-index holders meanwhile`,
    );
    if (state.lastError) notes.push(`rpc: ${state.lastError}`);
    raw.replay = { scannedTo: state.scannedTo, logCount: state.logCount, complete: state.complete, replayMs: state.replayMs, chunk: state.chunk, holders: Object.keys(state.balances).length };
  } catch (err) {
    notes.push(`holder replay failed: ${(err as Error).message.slice(0, 80)}`);
  }

  return {
    status: {
      id: "rpc",
      label: "Robinhood RPC",
      state: state?.complete ? "ok" : "partial",
      message: [creation ? `deployer ${creation.deployer.slice(0, 8)}…` : "deployer unknown", ...notes].join(" · "),
      ms: Date.now() - t0,
    },
    data,
    raw,
  };
}
