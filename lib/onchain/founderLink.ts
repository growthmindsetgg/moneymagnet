import { addressTopic, codeKind, TRANSFER_TOPIC, type Rpc } from "./rpc";

/**
 * Founder-link due diligence: is a large non-deployer EOA the founder's own second wallet?
 *
 * A launch is often sent from one wallet and the founder's stake then moved to another (JAMES on Monad: the
 * creation-tx sender sent 61% by plain transfer to a fresh EOA that never sold). One clue alone — the deployer
 * sent it its first tokens, or its first gas — is a "team wallet". Two or more independent clues, at least one a
 * direct deployer link, make it a "founder wallet (linked to the deployer)", which the rules treat as the founder.
 *
 * Clues (each live-read, false, or null with the exact reason — never assumed):
 *   tokens_from_deployer  its first tokens came from the deployer by plain transfer (no Swap event in that tx)   direct
 *   gas_from_deployer     the first native coin it ever received came from the deployer                         direct
 *   stake_from_deployer   that deployer transfer is ≥ 80% of the wallet's current balance (its stake was handed over, not bought)
 *   deployer_emptied      the deployer kept ≤ 1% of what it sent (it moved its stake rather than splitting it)
 *   shared_funder         the wallet and the deployer got their first native coin from the same EOA (not a labelled exchange)
 */

export type LinkSignalId = "tokens_from_deployer" | "gas_from_deployer" | "stake_from_deployer" | "deployer_emptied" | "shared_funder";

export interface LinkSignal {
  id: LinkSignalId;
  /** true / false when read; null with `evidence` giving the reason it could not be read. */
  ok: boolean | null;
  evidence: string;
}

export interface FounderVerdict {
  role: "founder" | "team" | null;
  count: number;
  signals: LinkSignal[];
  /** One line for the holder's evidence: "founder link 3/5: …". */
  summary: string;
}

const DIRECT: LinkSignalId[] = ["tokens_from_deployer", "gas_from_deployer"];
/** Clues needed for the founder class (at least one direct). */
export const FOUNDER_LINK_MIN = 2;
export const STAKE_SHARE_MIN = 0.8;
export const DEPLOYER_KEPT_MAX = 0.01;

const SHORT: Record<LinkSignalId, string> = {
  tokens_from_deployer: "tokens from deployer",
  gas_from_deployer: "gas from deployer",
  stake_from_deployer: "stake handed over",
  deployer_emptied: "deployer emptied",
  shared_funder: "shared funder",
};

/** Pure: the class the clues support. No direct link ⇒ not linked, whatever else holds. */
export function founderVerdict(signals: LinkSignal[]): FounderVerdict {
  const yes = signals.filter((s) => s.ok === true);
  const direct = yes.some((s) => DIRECT.includes(s.id));
  const count = yes.length;
  const role = !direct ? null : count >= FOUNDER_LINK_MIN ? "founder" : "team";
  const list = signals.map((s) => `${SHORT[s.id]}: ${s.ok === true ? "yes" : s.ok === false ? "no" : "unknown"} (${s.evidence})`).join("; ");
  return { role, count, signals, summary: `founder link ${count}/${signals.length}${role ? ` ⇒ ${role === "founder" ? "founder wallet (linked)" : "team wallet"}` : ""} — ${list}` };
}

export interface FounderLinkInput {
  token: string;
  wallet: string;
  deployer: string;
  /** The wallet's first token receipt. */
  first: { from: string | null; tx: string | null; block: number } | null;
  /** That receipt was a plain transfer (no Swap event). */
  firstPlain: boolean;
  /** The wallet's first native-coin receipt, or null with `gasReason`. */
  walletGas: { from: string | null; tx: string | null; block: number } | null;
  /** The deployer's first native-coin receipt, or null with `gasReason`. */
  deployerGas: { from: string | null; tx: string | null; block: number } | null;
  /** Set when native-coin funding can't be read on this chain / in this run. */
  gasReason?: string;
  /** A funder that is a labelled exchange wallet funds everyone: never a shared-funder clue. */
  isExchange?: (address: string) => boolean;
}

const balanceOf = (rpc: Rpc, token: string, who: string) =>
  rpc<string>("eth_call", [{ to: token, data: `0x70a08231${addressTopic(who).slice(2)}` }, "latest"], 8_000).then((v) => BigInt(v === "0x" ? 0 : v));

/** Token units the wallet received in one tx (sum of Transfer logs of `token` to `wallet`). */
async function receivedIn(rpc: Rpc, token: string, wallet: string, tx: string): Promise<bigint | null> {
  const receipt = await rpc<{ logs: { address: string; topics: string[]; data: string }[] } | null>("eth_getTransactionReceipt", [tx]).catch(() => null);
  if (!receipt) return null;
  const to = addressTopic(wallet).toLowerCase();
  let sum = 0n;
  for (const l of receipt.logs) if (l.address.toLowerCase() === token && l.topics[0] === TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === to) sum += BigInt(l.data === "0x" ? 0 : l.data);
  return sum;
}

const pctText = (n: number) => `${(Math.round(n * 1000) / 10).toFixed(1)}%`;

/** Reads the five clues for an EVM wallet. `rpc` serves latest state; funding receipts come in via `input`. */
export async function evmFounderLink(rpc: Rpc, input: FounderLinkInput): Promise<FounderVerdict> {
  const token = input.token.toLowerCase();
  const wallet = input.wallet.toLowerCase();
  const deployer = input.deployer.toLowerCase();
  const first = input.first;
  const fromDeployer = first?.from?.toLowerCase() === deployer;
  const signals: LinkSignal[] = [];

  signals.push(
    !first
      ? { id: "tokens_from_deployer", ok: null, evidence: "first token receipt not found" }
      : { id: "tokens_from_deployer", ok: fromDeployer && input.firstPlain, evidence: fromDeployer ? (input.firstPlain ? `plain transfer in tx ${first.tx ?? "?"} (block ${first.block})` : `from the deployer but in a swap tx ${first.tx ?? "?"}`) : `first tokens from ${first.from ?? "an internal call"}` },
  );

  const gasFrom = input.walletGas?.from?.toLowerCase() ?? null;
  signals.push(
    !input.walletGas
      ? { id: "gas_from_deployer", ok: null, evidence: input.gasReason ?? "first native-coin receipt not found" }
      : { id: "gas_from_deployer", ok: gasFrom === deployer, evidence: gasFrom ? `first native coin from ${gasFrom} (block ${input.walletGas.block})` : "first native coin through an internal call (sender not attributable)" },
  );

  // Stake handed over / deployer emptied: only meaningful when the first tokens came from the deployer.
  if (fromDeployer && input.firstPlain && first?.tx) {
    const [got, bal, kept] = await Promise.all([
      receivedIn(rpc, token, wallet, first.tx),
      balanceOf(rpc, token, wallet).catch(() => null),
      balanceOf(rpc, token, deployer).catch(() => null),
    ]);
    if (got == null || bal == null) signals.push({ id: "stake_from_deployer", ok: null, evidence: got == null ? "transfer receipt unreadable" : "wallet balance unreadable" });
    else if (bal === 0n) signals.push({ id: "stake_from_deployer", ok: false, evidence: "wallet holds 0 now" });
    else {
      const share = Number((got * 10_000n) / bal) / 10_000;
      signals.push({ id: "stake_from_deployer", ok: share >= STAKE_SHARE_MIN, evidence: `that transfer is ${pctText(Math.min(share, 9.99))} of its current balance (needs ≥ ${pctText(STAKE_SHARE_MIN)})` });
    }
    if (got == null || got === 0n || kept == null) signals.push({ id: "deployer_emptied", ok: null, evidence: kept == null ? "deployer balance unreadable" : "amount received unreadable" });
    else {
      const share = Number((kept * 10_000n) / got) / 10_000;
      signals.push({ id: "deployer_emptied", ok: share <= DEPLOYER_KEPT_MAX, evidence: `deployer still holds ${pctText(Math.min(share, 9.99))} of what it sent (needs ≤ ${pctText(DEPLOYER_KEPT_MAX)})` });
    }
  } else {
    const why = "first tokens did not come from the deployer by plain transfer";
    signals.push({ id: "stake_from_deployer", ok: false, evidence: why }, { id: "deployer_emptied", ok: false, evidence: why });
  }

  const dGas = input.deployerGas?.from?.toLowerCase() ?? null;
  if (!input.walletGas || !input.deployerGas) signals.push({ id: "shared_funder", ok: null, evidence: input.gasReason ?? "a first native-coin receipt was not found" });
  else if (!gasFrom || !dGas) signals.push({ id: "shared_funder", ok: false, evidence: "a first native-coin sender is not attributable" });
  else if (gasFrom === deployer) signals.push({ id: "shared_funder", ok: false, evidence: "funded by the deployer itself (counted as gas from deployer)" });
  else if (gasFrom !== dGas) signals.push({ id: "shared_funder", ok: false, evidence: `wallet funded by ${gasFrom}, deployer by ${dGas}` });
  else if (input.isExchange?.(gasFrom)) signals.push({ id: "shared_funder", ok: false, evidence: `both funded by ${gasFrom}, a labelled exchange wallet (funds everyone)` });
  else {
    const code = await rpc<string>("eth_getCode", [gasFrom, "latest"]).catch(() => null);
    if (code == null) signals.push({ id: "shared_funder", ok: null, evidence: `funder ${gasFrom} code unreadable` });
    else if (codeKind(code) !== "wallet") signals.push({ id: "shared_funder", ok: false, evidence: `both funded by contract ${gasFrom} (a bridge / router funds everyone)` });
    else signals.push({ id: "shared_funder", ok: true, evidence: `both got their first native coin from EOA ${gasFrom}` });
  }

  return founderVerdict(signals);
}
