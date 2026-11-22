import type { Chain, HolderClassRow } from "./types";

const pctText = (p: number | null) => (p == null ? "—" : `${p.toFixed(1)}%`);
const shortTx = (tx: string) => `${tx.slice(0, 8)}…${tx.slice(-4)}`;

/** The page line: "Largest holder: founder wallet (deployer), 61.1%, 0 sells in 116d" (team wallets add the funding tx). */
export function largestHolderLine(h: HolderClassRow | null | undefined): string | null {
  if (!h) return null;
  return `Largest holder: ${h.label}, ${pctText(h.pct)}${h.detail ? `, ${h.detail}` : ""}${h.fundingTx ? `, funded in tx ${shortTx(h.fundingTx)}` : ""}`;
}

/** Explorer page of a transaction on the token's chain. */
export function txUrl(chain: Chain, tx: string): string {
  if (chain === "solana") return `https://solscan.io/tx/${tx}`;
  if (chain === "base") return `https://basescan.org/tx/${tx}`;
  if (chain === "monad") return `https://monadvision.com/tx/${tx}`;
  if (chain === "ethereum") return `https://etherscan.io/tx/${tx}`;
  return `https://robinhoodchain.blockscout.com/tx/${tx}`;
}
