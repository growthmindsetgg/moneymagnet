import type { AdapterResult, HolderRow, TokenSnapshot } from "../types";
import { evmMintAuthority } from "../onchain/mintScan";
import { after } from "next/server";
import { getKV, kvGet, kvSet } from "../kv";
import { deployerStats, findCreation, type Creation, type DeployerStats } from "../onchain/creation";
import { creationKey, replayKey } from "../onchain/keys";
import { advanceReplay, newReplayState, rankHolders, replayProgressPct, type ReplayState } from "../onchain/replay";
import { callOrRevert, codeKind, makeRpc, type Rpc } from "../onchain/rpc";
import { infraEntry, isInfrastructure, launchpadOfFactory } from "../onchain/infra";
import infraRegistry from "@/data/robinhood-infra.json";

/** CLAUDE.md: stale data expires after 6h. */
const STALE_MAX_MIN = 360;
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO_WORD = /^0x0*$/;
const TOP_HOLDERS = 60;

export interface RpcOptions {
  rpc?: Rpc;
  /** Time allowed for advancing the Transfer-log replay in this request. */
  replayBudgetMs?: number;
}

/**
 * Supply sitting in registered infrastructure (pool managers, curves, vaults, burn addresses).
 * `failed` counts balanceOf reads that did not answer: their supply is unknown, not 0.
 */
async function registeredInfraHeld(rpc: Rpc, token: string): Promise<{ held: bigint; failed: number; total: number }> {
  const holders = infraRegistry.addresses.filter((e) => ["v4-pool-manager", "bonding-curve", "burn"].includes(e.role)).map((e) => e.address.toLowerCase());
  const bals = await Promise.all(
    holders.map((h) => rpc<string>("eth_call", [{ to: token, data: "0x70a08231" + h.slice(2).padStart(64, "0") }, "latest"], 10_000).then((r) => (r && r !== "0x" ? BigInt(r) : 0n)).catch(() => null)),
  );
  return { held: bals.reduce<bigint>((a, b) => a + (b ?? 0n), 0n), failed: bals.filter((b) => b === null).length, total: holders.length };
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
  const [code, supplyCall, decCall, ownerCall, implSlot, headHex] = await Promise.all([
    rpc<string>("eth_getCode", [a, "latest"], 15_000),
    callOrRevert(rpc, a, "0x18160ddd"),
    callOrRevert(rpc, a, "0x313ce567"),
    callOrRevert(rpc, a, "0x8da5cb5b"),
    rpc<string>("eth_getStorageAt", [a, EIP1967_IMPL, "latest"], 10_000).catch(() => null),
    rpc<string>("eth_blockNumber", [], 10_000),
  ]);
  if (!code || code === "0x") {
    return { status: { id: "rpc", label: "Robinhood RPC", state: "partial", message: "No contract code at this address", ms: Date.now() - t0 }, data: { tokenExists: false } };
  }
  const head = Number(headHex);
  const [supplyHex, decHex, ownerHex] = [supplyCall.value, decCall.value, ownerCall.value];
  const decimals = decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18;
  const supplyRaw = supplyHex && supplyHex !== "0x" ? BigInt(supplyHex) : null;
  const scale = 10 ** decimals;
  // A failed decimals() read would scale the supply by a guessed 18: leave it null instead.
  const totalSupply = supplyRaw != null && !decCall.error ? Number(supplyRaw) / scale : null;
  const readNotes: string[] = [];
  const readReasons: Record<string, string> = {};
  if (supplyCall.error) readReasons.totalSupply = `totalSupply() read failed: ${supplyCall.error}`;
  else if (decCall.error && supplyRaw != null) readReasons.totalSupply = `decimals() read failed: ${decCall.error}`;
  if (readReasons.totalSupply) readNotes.push(readReasons.totalSupply);

  // owner() reverting = no Ownable owner. A failed read says nothing about the owner: null, never "renounced".
  let ownerRenounced: boolean | null = true;
  if (ownerCall.error) {
    ownerRenounced = null;
    readReasons.ownerRenounced = `owner() read failed: ${ownerCall.error}`;
    readNotes.push(readReasons.ownerRenounced);
  } else if (ownerHex && ownerHex !== "0x") {
    const owner = `0x${ownerHex.slice(-40)}`.toLowerCase();
    ownerRenounced = /^0x0{40}$/.test(owner) || owner === "0x000000000000000000000000000000000000dead";
  }

  const upgradeable = implSlot == null ? null : !ZERO_WORD.test(implSlot);
  const mint = evmMintAuthority(code, ownerRenounced, upgradeable, readReasons.ownerRenounced);
  const data: Partial<TokenSnapshot> = {
    totalSupply,
    ownerRenounced,
    upgradeable,
    mintAuthority: mint.mintAuthority,
  };
  const notes: string[] = [...readNotes];
  const raw: Record<string, unknown> = { owner: ownerHex, implSlot, head, supplyRaw: supplyRaw?.toString() ?? null, decimals };
  data.nullReasons = {
    creatorHasSocials: "Robinhood Chain ERC-20s carry no social-link metadata",
    ...readReasons,
    ...(mint.mintAuthority == null ? { mintAuthority: mint.reason } : {}),
  };
  raw.mint = mint.reason;

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
        const infra = await registeredInfraHeld(rpc, a);
        const infraHeldRaw = infra.held;
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
          // Unread infrastructure balances leave infra supply in the denominator: the share is unknown, not lower.
          holdingPct: infra.failed ? null : d.holdingPct,
          infraUnread: infra.failed ? `infra balance unread (${infra.failed} of ${infra.total} balanceOf calls failed)` : null,
          soldPct: d.soldPct,
        };
        // A partial read is not cached: the next run retries the failed balances.
        if (!infra.failed) await kvSet(dKey, stats, 600);
      } catch (err) {
        notes.push(`deployer flows failed: ${(err as Error).message.slice(0, 80)}`);
      }
    }
    if (stats) {
      data.deployerHoldingPct = stats.holdingPct as number | null;
      if (stats.infraUnread) {
        data.nullReasons = { ...data.nullReasons, deployerHoldingPct: `${stats.infraUnread} — infrastructure supply cannot be excluded from the denominator` };
        notes.push(stats.infraUnread as string);
      }
      data.deployerSoldPct = stats.soldPct as number;
      data.deployerDistributedPct = (stats.distributedPct as number | undefined) ?? null;
      data.deployerHasSold = BigInt(stats.sentToContracts as string) > 0n;
      raw.deployer = stats;
    }
  }

  // 3. Holder balances via a resumable Transfer-log replay. Failures here only cost holder data.
  let state: ReplayState | null = null;
  let lagMin: number | null = null;
  let tooOld = false;
  const stored = creation ? await kvGet<ReplayState>(replayKey(a)) : null;
  // A full replay can take many minutes (microduck: 1.57M logs); per-instance memory can never finish
  // it and only burns the RPC's rate limit, so it needs durable KV unless a state already exists.
  const durable = getKV().kind !== "memory";
  if (creation && !stored && !durable) {
    notes.push("holder replay skipped: needs persistent KV (neither UPSTASH_REDIS_REST_URL nor DATABASE_URL set) — using swap-index holders");
    raw.replay = { skipped: "no durable KV" };
  } else if (creation) try {
    state = stored ?? newReplayState(a, creation.creationBlock);
    // Inside the request only a short advance; the rest continues after the response (see save below).
    state = await advanceReplay(rpc, state, head, { budgetMs: opts.replayBudgetMs ?? Number(process.env.REPLAY_BUDGET_MS || 8_000) });

    // A completed replay that has fallen behind the head is old data: labelled stale up to 6h, not used past that.
    lagMin = null;
    // Robinhood Chain makes ~10 blocks a second (measured 2026-11-19): under 1,200 blocks behind is ~2 minutes, i.e. current.
    if (state.complete && head - state.scannedTo <= 1_200) lagMin = 0;
    else if (state.complete && state.scannedTo < head) {
      const [at, now] = await Promise.all([
        rpc<{ timestamp: string } | null>("eth_getBlockByNumber", [`0x${state.scannedTo.toString(16)}`, false], 8_000).catch(() => null),
        rpc<{ timestamp: string } | null>("eth_getBlockByNumber", ["latest", false], 8_000).catch(() => null),
      ]);
      lagMin = at && now ? Math.max(0, Math.round((Number(now.timestamp) - Number(at.timestamp)) / 60)) : null;
    }
    tooOld = state.complete && state.scannedTo < head && (lagMin == null || lagMin > STALE_MAX_MIN);
    if (tooOld) {
      notes.push(`holder replay is ${lagMin == null ? "behind the head (age unknown)" : `${Math.round(lagMin / 60)}h behind`} — on-chain holders not used until it catches up`);
      data.nullReasons = { ...data.nullReasons, holders: `on-chain holder replay ${lagMin == null ? "lags the head by an unknown time" : `is ${Math.round(lagMin / 60)}h behind`} (> 6h): not served as current` };
    }
    if (state.complete && supplyRaw && !tooOld) {
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
      if (lagMin != null && lagMin >= 5) data.staleFields = { ...(data.staleFields ?? {}), holders: lagMin, holderCount: lagMin };
    }
    // Concurrent requests (or the pre-warm script) may have advanced further — never move backwards.
    // The state is ~1 MB on big tokens (a 5s write): saved after the response where the host allows it.
    const done = state;
    const save = async (more: boolean) => {
      const next = more && done.scannedTo < head ? await advanceReplay(rpc, done, head, { budgetMs: Number(process.env.REPLAY_AFTER_MS || 20_000) }).catch(() => done) : done;
      const latest = await kvGet<Pick<ReplayState, "scannedTo">>(replayKey(a));
      if (!latest || latest.scannedTo <= next.scannedTo) await kvSet(replayKey(a), next);
    };
    try {
      after(() => save(true));
    } catch {
      await save(false);
    }
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
      state: state?.complete && !tooOld && !readNotes.length ? "ok" : "partial",
      message: [creation ? `deployer ${creation.deployer.slice(0, 8)}…` : "deployer unknown", ...notes].join(" · "),
      ms: Date.now() - t0,
    },
    data,
    raw,
  };
}
