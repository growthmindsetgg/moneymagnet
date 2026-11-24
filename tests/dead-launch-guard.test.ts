import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deadLaunchOf, emptySnapshot } from "@/lib/snapshot";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { SourceStatus, TokenSnapshot } from "@/lib/types";

const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

describe("dead launch: a zero-buyers reading contradicted by live buyers is not a dead launch (2026-11-24)", () => {
  // WIF as production read it: a non-pump.fun mint whose derived curve address had 84 unrelated txs ⇒ uniqueBuyers 0.
  const wifLike = (o: Partial<TokenSnapshot> = {}): TokenSnapshot => ({ ...emptySnapshot("solana", WIF), ageHours: 26_390, uniqueBuyers: 0, buyers24h: 9230, buyersBasis: "unique wallets", liquidityUsd: 3_752_025, ...o });

  it("WIF-shaped (0 'curve' buyers, 9,230 unique buyers in 24h, $3.75M liquidity) ⇒ not dead", () => {
    // Curve leg unknown ⇒ "not proven dead" (null), never true; with the curve leg known it is a clean false.
    expect(deadLaunchOf(wifLike())).not.toBe(true);
    expect(deadLaunchOf(wifLike({ deadCurve: false }))).toBe(false);
  });
  it("a real dead launch (≤ 2 buyers, none live) stays dead", () => {
    expect(deadLaunchOf(wifLike({ uniqueBuyers: 1, buyers24h: 0, liquidityUsd: 3_752_025 }))).toBe(true);
    expect(deadLaunchOf(wifLike({ uniqueBuyers: 0, buyers24h: null }))).toBe(true);
  });
  it("tx counts are not wallets: 9,230 buy txs do not clear the buyers leg", () => {
    expect(deadLaunchOf(wifLike({ buyersBasis: "tx counts, not unique wallets (DexScreener)" }))).toBe(true);
  });
  it("a drained pool is still dead whatever the buyers say", () => {
    expect(deadLaunchOf(wifLike({ liquidityUsd: 40 }))).toBe(true);
  });
  it("PEEK (never traded) is still a dead launch, F", () => {
    const fx = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "peek.json"), "utf8")) as { snapshot: TokenSnapshot; sources: SourceStatus[] };
    expect(deadLaunchOf(fx.snapshot)).toBe(true);
    expect(scoreSnapshot(fx.snapshot, fx.sources).tier).toBe("F");
  });
});
