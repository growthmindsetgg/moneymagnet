import type { Tier } from "@/lib/types";
import { TIER_LOOK } from "./severity";

/** Tier text colour (S is never neon text: it is an ink letter on a neon fill). */
export const TIER_TEXT: Record<Tier, string> = {
  S: "text-neon-ink",
  A: "text-tier-a",
  B: "text-tier-b",
  C: "text-tier-c",
  D: "text-tier-d",
  F: "text-tier-f",
  U: "text-tier-u",
};

/** A small round tier letter on the severity scale: S/A neon, B ink, C outline, D orange, F red, U grey dashed. */
export function TierChip({ tier, className = "" }: { tier: Tier; className?: string }) {
  const look = TIER_LOOK[tier];
  return (
    <span className={`mm-display-sm inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm ${look} ${className}`}>
      {tier}
    </span>
  );
}
