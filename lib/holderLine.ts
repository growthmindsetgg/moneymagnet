import type { HolderClassRow } from "./types";

const pctText = (p: number | null) => (p == null ? "—" : `${p.toFixed(1)}%`);

/** The page line: "Largest holder: founder wallet (deployer), 61.1%, 0 sells in 116d". */
export function largestHolderLine(h: HolderClassRow | null | undefined): string | null {
  if (!h) return null;
  return `Largest holder: ${h.label}, ${pctText(h.pct)}${h.detail ? `, ${h.detail}` : ""}`;
}
