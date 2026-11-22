import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type ScoringConfig } from "@/lib/scoring/config";
import { hysteresisHold, scoreSnapshot, tierFloor } from "@/lib/scoring/engine";
import { appendScore, entryOf, previousTier } from "@/lib/scoreHistory";
import { MemoryKV, setKV } from "@/lib/kv";
import type { PreviousTier, TokenSnapshot } from "@/lib/types";
import { perfectSnapshot } from "./helpers";

const NOW = Date.UTC(2026, 10, 20, 12);
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const prev = (tier: PreviousTier["tier"], over: Partial<PreviousTier> = {}): PreviousTier => ({ tier, at: ago(20), mode: "established", bindingKind: "score", ...over });

/** A mid-quality established token with no cap, and a config whose A line sits `offset` above its score. */
function nearLine(offset: number): { snap: TokenSnapshot; cfg: ScoringConfig; score: number } {
  const snap = perfectSnapshot("robinhood", { netFlowRatio24h: -0.05, buyerSellerRatio: 0.9, liqChange7dPct: -5, smartMoneyNetUsd: 0 });
  // S out of reach, so no S requirement clamps the number: the displayed score is the score itself.
  const noS = defaultConfig.tiers.map((t) => (t.tier === "S" ? { ...t, min: 200 } : t));
  const score = scoreSnapshot(snap, [], { ...defaultConfig, tiers: noS }).score!;
  const line = Math.round((score + offset) * 10) / 10;
  const tiers = noS.map((t) => (t.tier === "A" ? { ...t, min: line } : t));
  return { snap, cfg: { ...defaultConfig, tiers }, score };
}

describe("hysteresisHold (band math)", () => {
  it("holds an adjacent tier inside ±margin of the shared line", () => {
    expect(hysteresisHold(69.0, "B", "established", prev("A"), NOW)?.line).toBe(70);
    expect(hysteresisHold(71.9, "A", "established", prev("B"), NOW)?.line).toBe(70);
  });
  it("does not hold at or beyond the margin", () => {
    expect(hysteresisHold(68.0, "B", "established", prev("A"), NOW)).toBeNull();
    expect(hysteresisHold(72.0, "A", "established", prev("B"), NOW)).toBeNull();
  });
  it("does not hold across two bands, across modes, after 6h, or when the previous tier was not placed by the bands", () => {
    expect(hysteresisHold(54.5, "C", "established", prev("A"), NOW)).toBeNull();
    expect(hysteresisHold(69.0, "B", "established", prev("A", { mode: "launch" }), NOW)).toBeNull();
    expect(hysteresisHold(69.0, "B", "established", prev("A", { at: ago(6 * 60 + 1) }), NOW)).toBeNull();
    for (const bindingKind of ["cap", "gate", "requirement", "held", "coverage", undefined]) {
      expect(hysteresisHold(69.0, "B", "established", prev("A", { bindingKind }), NOW)).toBeNull();
    }
    expect(hysteresisHold(69.0, "B", "established", prev("A", { bindingKind: "hysteresis" }), NOW)).not.toBeNull();
  });
  it("never holds from or to U", () => {
    expect(hysteresisHold(69.0, "B", "established", prev("U"), NOW)).toBeNull();
  });
});

describe("hysteresis in scoreSnapshot", () => {
  it("held up: tier kept, displayed score at the bottom of the held band, raw beside it", () => {
    const { snap, cfg, score } = nearLine(1); // the score is 1 below the A line ⇒ B alone
    expect(scoreSnapshot(snap, [], cfg).tier).toBe("B");
    const r = scoreSnapshot(snap, [], cfg, { previous: prev("A"), now: NOW });
    expect(r.tier).toBe("A");
    expect(r.score).toBe(tierFloor("A", cfg));
    expect(r.binding?.kind).toBe("hysteresis");
    expect(r.hysteresis).toMatchObject({ liveTier: "B", margin: 2, minutesAgo: 20 });
    expect(r.tierReason).toMatch(new RegExp(`raw ${score}`));
  });

  it("held down: tier kept, displayed score clamped to the top of the held band", () => {
    const { snap, cfg } = nearLine(-1); // 1 above the A line ⇒ A alone
    expect(scoreSnapshot(snap, [], cfg).tier).toBe("A");
    const r = scoreSnapshot(snap, [], cfg, { previous: prev("B"), now: NOW });
    expect(r.tier).toBe("B");
    expect(r.score).toBeLessThan(tierFloor("A", cfg));
    expect(r.hysteresis?.liveTier).toBe("A");
  });

  it("outside the margin the score decides", () => {
    const { snap, cfg } = nearLine(3);
    expect(scoreSnapshot(snap, [], cfg, { previous: prev("A"), now: NOW }).tier).toBe("B");
  });

  it("caps, gates and coverage still apply after a hold", () => {
    const { snap, cfg } = nearLine(1);
    const capped = scoreSnapshot({ ...snap, top1SharePct: 25 }, [], cfg, { previous: prev("A"), now: NOW });
    expect(capped.tier).toBe("C");
    expect(capped.hysteresis).toBeUndefined();
    const gated = scoreSnapshot({ ...snap, sellable: false, honeypot: true }, [], cfg, { previous: prev("A"), now: NOW });
    expect(gated.tier).toBe("F");
    expect(gated.hysteresis).toBeUndefined();
  });

  it("stays monotone: a held A never shows a lower number than an unheld B", () => {
    const { snap, cfg } = nearLine(1);
    const held = scoreSnapshot(snap, [], cfg, { previous: prev("A"), now: NOW });
    const unheld = scoreSnapshot(snap, [], cfg);
    expect(held.score!).toBeGreaterThan(unheld.score!);
  });

  it("damps a flap: scores alternating either side of the line keep one tier (Schmitt trigger)", () => {
    const below = nearLine(0.5);
    const above = nearLine(-0.5);
    let last: PreviousTier = prev("A");
    const tiers: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { snap, cfg } = i % 2 ? above : below;
      const r = scoreSnapshot(snap, [], cfg, { previous: last, now: NOW });
      tiers.push(r.tier);
      last = { tier: r.tier, at: ago(10), mode: r.mode, bindingKind: r.binding?.kind };
    }
    expect(new Set(tiers)).toEqual(new Set(["A"]));
  });
});

describe("score_history feeds hysteresis", () => {
  beforeEach(() => setKV(new MemoryKV()));
  it("stores what placed the tier and returns the latest entry", async () => {
    const r = { ...scoreSnapshot(perfectSnapshot("robinhood")), generatedAt: ago(5) };
    expect(entryOf(r).bindingKind).toBe(r.binding?.kind);
    await appendScore(r);
    expect(await previousTier("robinhood", r.address)).toEqual({ tier: r.tier, at: ago(5), mode: r.mode, bindingKind: r.binding?.kind });
  });
});
