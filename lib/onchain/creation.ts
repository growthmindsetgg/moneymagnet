import { addressTopic, codeKind, hex, MAX_SPAN, TRANSFER_TOPIC, topicAddress, windowsBackward, ZERO_TOPIC, type Rpc, type RpcLog } from "./rpc";
import { infraEntry, isInfrastructure, isLiquidityManager, isLpSeedingSelector, isRegisteredInfra } from "./infra";

/** Uniswap v2, v3 and v4 Swap event topics. */
const SWAP_TOPICS = new Set([
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
]);
/** Outgoing deployer transactions classified by receipt per run. */
const MAX_CLASSIFIED_TXS = 40;

export interface Creation {
  creationBlock: number;
  mintTx: string;
  mintedTo: string;
  /** The externally-owned account that sent the first mint transaction. */
  deployer: string;
  /** Unix seconds of the creation block (on-chain truth for token age). */
  timestamp?: number;
  /** `to` of the creation tx: a launchpad factory when the token was launched through one (null = direct deploy). */
  factory?: string | null;
}

/**
 * Finds the token's first mint (Transfer from 0x0). The RPC has no archive state, so the
 * creation block can't be bisected with eth_getCode; mint logs are rare, so scanning every
 * 10M-block window for them is cheap (~10 queries for the whole chain).
 */
export async function findCreation(rpc: Rpc, token: string, head: number): Promise<Creation | null> {
  let earliest: RpcLog | null = null;
  for (const [from, to] of windowsBackward(0, head)) {
    const logs = await rpc<RpcLog[]>("eth_getLogs", [
      { address: token, topics: [TRANSFER_TOPIC, ZERO_TOPIC], fromBlock: hex(from), toBlock: hex(to) },
    ]);
    for (const l of logs) {
      if (!earliest || Number(l.blockNumber) < Number(earliest.blockNumber)) earliest = l;
    }
  }
  if (!earliest) return null;
  const [tx, block] = await Promise.all([
    rpc<{ from: string; to?: string | null }>("eth_getTransactionByHash", [earliest.transactionHash]),
    rpc<{ timestamp: string } | null>("eth_getBlockByNumber", [earliest.blockNumber, false]).catch(() => null),
  ]);
  return {
    timestamp: block ? Number(block.timestamp) : undefined,
    creationBlock: Number(earliest.blockNumber),
    mintTx: earliest.transactionHash,
    mintedTo: topicAddress(earliest.topics[2]),
    deployer: tx.from.toLowerCase(),
    factory: tx.to ? tx.to.toLowerCase() : tx.to,
  };
}

export interface DeployerStats {
  balance: bigint;
  received: bigint;
  /** Tokens sold: moved in a swap (a v2/v3/v4 Swap event in the tx) or into a bonding curve. */
  sentToContracts: bigint;
  sentToWallets: bigint;
  /** Tokens handed out by transfer (wallets, non-pool contracts) — shown, not penalised. */
  distributed: bigint;
  /** Tokens the deployer put into liquidity (creation tx, pool-initialize / liquidity-manager txs). */
  lpSeeded: bigint;
  /** Deployer balance / (supply − infrastructure-held supply). */
  holdingPct: number | null;
  /** Share of what the deployer could sell (received − LP seeded) that was sold in swaps. */
  soldPct: number;
  /** Share handed out by transfer (not penalised). */
  distributedPct: number;
}

export interface DeployerOptions {
  /** The token's creation tx: transfers inside it are launch mechanics, not sales. */
  creationTx?: string | null;
  /** Supply held by pools, curves, routers, lockers and burn addresses. */
  infraHeldRaw?: bigint;
}

/**
 * Deployer flows from filtered Transfer logs — a handful of queries, no full replay needed.
 * Liquidity seeding is not a sale: transfers to infrastructure inside the creation tx or inside a
 * transaction sent to a liquidity manager (v4 PositionManager, v3 position manager, v2 router
 * addLiquidity…) are counted as `lpSeeded`, not sold.
 */
export async function deployerStats(
  rpc: Rpc,
  token: string,
  deployer: string,
  fromBlock: number,
  head: number,
  totalSupplyRaw: bigint | null,
  opts: DeployerOptions = {},
): Promise<DeployerStats> {
  const dTopic = addressTopic(deployer);
  const windows = windowsBackward(fromBlock, head, MAX_SPAN);
  const query = (topics: (string | null)[]) =>
    Promise.all(
      windows.map(([f, t]) => rpc<RpcLog[]>("eth_getLogs", [{ address: token, topics, fromBlock: hex(f), toBlock: hex(t) }])),
    ).then((r) => r.flat());
  const [incoming, outgoing, balHex] = await Promise.all([
    query([TRANSFER_TOPIC, null, dTopic]),
    query([TRANSFER_TOPIC, dTopic]),
    rpc<string>("eth_call", [{ to: token, data: "0x70a08231" + dTopic.slice(2) }, "latest"]),
  ]);
  const amount = (l: RpcLog) => (l.data && l.data !== "0x" ? BigInt(l.data) : 0n);
  const received = incoming.reduce((a, l) => a + amount(l), 0n);

  const dests = [...new Set(outgoing.map((l) => topicAddress(l.topics[2])))].slice(0, 50);
  const codes = await Promise.all(dests.map((d) => rpc<string>("eth_getCode", [d, "latest"]).catch(() => "0x")));
  const infraDest = new Set(dests.filter((d, i) => d === "0x0000000000000000000000000000000000000000" || isInfrastructure(d, codeKind(codes[i]))));

  // Classify each outgoing transaction from its receipt: liquidity provision (creation tx,
  // liquidity-manager calls) is not a sale; a transaction that emits a Uniswap v2/v3/v4 Swap — or
  // sends into a registered bonding curve — is a sale; everything else (transfers to wallets,
  // multisigs, vesting or airdrop contracts) is distribution, shown but not penalised.
  const txs = [...new Set(outgoing.map((l) => l.transactionHash))];
  const kind = new Map<string, "seed" | "swap" | "transfer">();
  await Promise.all(
    txs.slice(0, MAX_CLASSIFIED_TXS).map(async (h) => {
      if (opts.creationTx && h === opts.creationTx) return kind.set(h, "seed");
      const [tx, receipt] = await Promise.all([
        rpc<{ to: string | null; input?: string } | null>("eth_getTransactionByHash", [h]).catch(() => null),
        rpc<{ logs: { topics: string[] }[] } | null>("eth_getTransactionReceipt", [h]).catch(() => null),
      ]);
      if (tx && (isLiquidityManager(tx.to) || (isRegisteredInfra(tx.to ?? "") && isLpSeedingSelector(tx.input)))) return kind.set(h, "seed");
      if (receipt?.logs.some((l) => SWAP_TOPICS.has(l.topics[0]))) return kind.set(h, "swap");
      if (receipt) kind.set(h, "transfer"); // unreadable receipts fall back to the destination rule below
    }),
  );

  let sentToContracts = 0n;
  let sentToWallets = 0n;
  let distributed = 0n;
  let lpSeeded = 0n;
  for (const l of outgoing) {
    const to = topicAddress(l.topics[2]);
    const v = amount(l);
    const k = kind.get(l.transactionHash);
    const curve = infraEntry(to)?.role === "bonding-curve";
    if (k === "seed") lpSeeded += v;
    else if (k === "swap" || curve) sentToContracts += v;
    else if (k === "transfer") {
      distributed += v;
      if (!infraDest.has(to)) sentToWallets += v;
    } else if (infraDest.has(to)) sentToContracts += v; // beyond the classified transactions: destination decides
    else {
      distributed += v;
      sentToWallets += v;
    }
  }

  const balance = BigInt(balHex);
  const circulating = totalSupplyRaw != null ? totalSupplyRaw - (opts.infraHeldRaw ?? 0n) : null;
  const sellable = received - lpSeeded;
  return {
    balance,
    received,
    sentToContracts,
    sentToWallets,
    distributed,
    lpSeeded,
    holdingPct: circulating && circulating > 0n ? Number((balance * 1_000_000n) / circulating) / 10_000 : null,
    soldPct: sellable > 0n ? Math.min(100, Number((sentToContracts * 10_000n) / sellable) / 100) : 0,
    distributedPct: sellable > 0n ? Math.min(100, Number((distributed * 10_000n) / sellable) / 100) : 0,
  };
}
