import { describe, expect, it } from "vitest";
import { computeHolderStrength, isDipBuy, strengthLabel, worstDrawdown7d, type DayCandle, type HolderLedger, type LedgerEvent, type StrengthInput } from "@/lib/holderStrength";
import { strengthHolders } from "@/lib/holderStrengthData";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { emptySnapshot } from "@/lib/snapshot";
import { perfectSnapshot } from "./helpers";
import type { TokenSnapshot } from "@/lib/types";

const DAY = 86_400;
const NOW = 1_800_000_000;
const CREATED = NOW - 120 * DAY;
const addr = (i: number) => "0x" + i.toString(16).padStart(40, "0");

/** 120 daily candles: flat at 1.0, a −50% slump on days 60–64 (peak day 59), then back to 1.0. */
function candles(): DayCandle[] {
  return Array.from({ length: 120 }, (_, i) => {
    const t = CREATED + i * DAY;
    const slump = i >= 60 && i <= 64;
    return { t, o: slump ? 0.5 : 1, h: slump ? 0.55 : 1, l: slump ? 0.5 : 0.98, c: slump ? 0.5 : 1 };
  });
}
const DIP_T = CREATED + 62 * DAY + 3600;
const PEAK_T = CREATED + 59 * DAY;

interface Wallet {
  /** First buy, days after creation. */
  boughtDay: number;
  /** Sold this share of the position, during the slump unless `soldDay` says otherwise. */
  sold?: number;
  soldDay?: number;
  dipBuy?: boolean;
  /** Days old before its first buy; tokens held. */
  ageDays?: number;
  tokens?: number;
}

function ledger(i: number, w: Wallet, pct = 5): HolderLedger {
  const buyT = CREATED + w.boughtDay * DAY + 3600;
  const events: LedgerEvent[] = [{ t: buyT, kind: "buy", qty: 1000, priceUsd: null }];
  if (w.dipBuy) events.push({ t: DIP_T, kind: "buy", qty: 200, priceUsd: null });
  if (w.sold) events.push({ t: CREATED + (w.soldDay ?? 61) * DAY + 3600, kind: "sell", qty: 1000 * w.sold, priceUsd: null });
  return {
    address: addr(i),
    pct,
    cls: "wallet",
    events,
    complete: true,
    walletFirstSeenT: w.ageDays != null ? buyT - w.ageDays * DAY : null,
    tokensHeld: w.tokens ?? null,
  };
}

function input(wallets: Wallet[], over: Partial<StrengthInput> = {}): StrengthInput {
  return { ledgers: wallets.map((w, i) => ledger(i + 1, w)), createdT: CREATED, nowT: NOW, candles: candles(), accumulatorSupplyPct: null, method: "test", ...over };
}
const many = (n: number, w: Wallet) => Array.from({ length: n }, () => ({ ...w }));

describe("Holder Strength: one synthetic top-20 set per label", () => {
  it("Diamond: early, seasoned wallets that never sold through the −50% drawdown and bought the dip", () => {
    const r = computeHolderStrength(input(many(20, { boughtDay: 5, dipBuy: true, ageDays: 400, tokens: 12 }), { accumulatorSupplyPct: 8 }));
    expect(r.label).toBe("Diamond");
    expect(r.score!).toBeGreaterThanOrEqual(80);
    expect(r.sentences).toHaveLength(3);
    expect(r.sentences.join(" ")).toMatch(/20 of 20 top-20 wallets held through the −50% drawdown/);
  });

  it("Strong: mostly holders through the drawdown, some light profit-taking, no dip buying", () => {
    const ws = [...many(12, { boughtDay: 10, ageDays: 200, tokens: 6 }), ...many(5, { boughtDay: 10, sold: 0.2, soldDay: 90, ageDays: 200, tokens: 6 }), ...many(3, { boughtDay: 10, sold: 0.6, ageDays: 30, tokens: 2 })];
    const r = computeHolderStrength(input(ws));
    expect(r.label).toBe("Strong");
  });

  it("Mixed: half held through, half dumped; young-ish wallets", () => {
    const ws = [...many(10, { boughtDay: 40, ageDays: 60, tokens: 3 }), ...many(10, { boughtDay: 40, sold: 0.7, ageDays: 10, tokens: 1 })];
    const r = computeHolderStrength(input(ws));
    expect(r.label).toBe("Mixed");
  });

  it("Weak: most sold more than half in the slump; holdings are recent", () => {
    const ws = [...many(4, { boughtDay: 100, ageDays: 3, tokens: 1 }), ...many(16, { boughtDay: 50, sold: 0.8, ageDays: 20, tokens: 2 })];
    const r = computeHolderStrength(input(ws));
    expect(r.label).toBe("Weak");
  });

  it("Paper: fresh single-token wallets that bought late and dumped through the drawdown", () => {
    const ws = many(20, { boughtDay: 55, sold: 0.9, ageDays: 1, tokens: 1 });
    const r = computeHolderStrength(input(ws, { accumulatorSupplyPct: 0 }));
    expect(r.label).toBe("Paper");
    expect(r.score!).toBeLessThan(20);
  });

  it("label bands: Diamond ≥ 80 · Strong 60–79 · Mixed 40–59 · Weak 20–39 · Paper < 20", () => {
    expect([80, 79.9, 60, 59.9, 40, 39.9, 20, 19.9, 0].map(strengthLabel)).toEqual(["Diamond", "Strong", "Strong", "Mixed", "Mixed", "Weak", "Weak", "Paper", "Paper"]);
  });
});

describe("Holder Strength: components", () => {
  it("worst 7d drawdown finds the slump peak → trough", () => {
    const dd = worstDrawdown7d(candles())!;
    expect(dd.depth).toBeCloseTo(0.5, 2);
    expect(dd.peakT).toBe(PEAK_T);
  });

  it("a dip buy needs the price ≥ 20% under the prior 7d high: priced trades by price, unpriced only on a day whose high was already under", () => {
    const c = candles();
    expect(isDipBuy(c, { t: DIP_T, kind: "buy", qty: 1, priceUsd: null })).toBe(true);
    expect(isDipBuy(c, { t: CREATED + 30 * DAY, kind: "buy", qty: 1, priceUsd: null })).toBe(false);
    expect(isDipBuy(c, { t: CREATED + 30 * DAY, kind: "buy", qty: 1, priceUsd: 0.7 })).toBe(true);
    expect(isDipBuy(c, { t: CREATED + 30 * DAY, kind: "buy", qty: 1, priceUsd: 0.9 })).toBe(false);
  });

  it("the launch window (first 72h) is not a drawdown to survive", () => {
    const c = candles().map((x, i) => (i === 1 ? { ...x, l: 0.01 } : x));
    const r = computeHolderStrength(input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 }), { candles: c }));
    expect(r.components.find((x) => x.id === "drawdown")!.evidence).toMatch(/−50%/);
  });

  it("no drawdown ≥ 20% and no dip: those components are n/a (not missing), the rest still score", () => {
    const flat = candles().map((x) => ({ ...x, o: 1, h: 1, l: 0.95, c: 1 }));
    const r = computeHolderStrength(input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 }), { candles: flat }));
    const dd = r.components.find((x) => x.id === "drawdown")!;
    expect(dd.na).toBe(true);
    expect(r.components.find((x) => x.id === "accumulation")!.na).toBe(true);
    expect(r.score).not.toBeNull();
  });

  it("founder that never sold and vesting supply count as strong and are named apart; CEX wallets are excluded", () => {
    const ls = input(many(18, { boughtDay: 40, sold: 0.7, ageDays: 10, tokens: 1 })).ledgers;
    ls.push({ address: addr(99), pct: 40, cls: "founder", keyNeverSold: true, label: "founder wallet", events: [{ t: CREATED, kind: "in", qty: 1, priceUsd: null }], complete: true, walletFirstSeenT: null, tokensHeld: null });
    ls.push({ address: addr(98), pct: 10, cls: "vesting", label: "vesting contract (Hedgey)", events: [], complete: true, walletFirstSeenT: null, tokensHeld: null });
    ls.push({ address: addr(97), pct: 8, cls: "cex", label: "Binance 14", events: [], complete: false, walletFirstSeenT: null, tokensHeld: null });
    const r = computeHolderStrength({ ...input([]), ledgers: ls });
    expect(r.keyPerson).toEqual(["founder wallet 40.0%, never sold, 120d", "vesting contract (Hedgey) 10.0%, locked"]);
    expect(r.excluded).toEqual([{ address: addr(97), pct: 8, why: "labelled CEX wallet" }]);
    expect(r.sentences).toContain("Founder wallet 40.0%, never sold, 120d");
    // The same set without the founder / vesting identity scores lower.
    const plain = computeHolderStrength({ ...input([]), ledgers: ls.map((h) => (h.cls === "founder" || h.cls === "vesting" ? { ...h, cls: "wallet" as const } : h)) });
    expect(r.score!).toBeGreaterThan(plain.score ?? 0);
  });

  it("never estimates: incomplete histories under 60% of the supply ⇒ null with the reason", () => {
    const ls = input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 })).ledgers.map((h, i) => ({ ...h, complete: i < 5 }));
    const r = computeHolderStrength({ ...input([]), ledgers: ls });
    expect(r.score).toBeNull();
    expect(r.nullReason).toMatch(/25% of the top-20 supply outside key-person \/ locked holders \(15 still incomplete; needs ≥ 60%\)/);
  });

  it("a key-person holder cannot stand in for the rest: a 61% team wallet plus unread wallets ⇒ null, not Diamond", () => {
    const ls = input(many(19, { boughtDay: 5, ageDays: 100, tokens: 5 })).ledgers.map((h) => ({ ...h, pct: 0.3, complete: false }));
    ls.push({ address: addr(99), pct: 61, cls: "team", keyNeverSold: true, label: "team wallet (deployer-funded)", events: [{ t: CREATED, kind: "in", qty: 1, priceUsd: null }], complete: true, walletFirstSeenT: null, tokensHeld: null });
    const r = computeHolderStrength({ ...input([]), ledgers: ls });
    expect(r.score).toBeNull();
    expect(r.nullReason).toMatch(/^histories read for wallets holding 0% of the top-20 supply outside key-person/);
  });

  it("no candles: drawdown and dip are null with the source's reason; three measured components still score", () => {
    const r = computeHolderStrength(input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 }), { candles: null, candleReason: "GeckoTerminal failed: HTTP 429" }));
    expect(r.components.find((x) => x.id === "drawdown")!.nullReason).toBe("GeckoTerminal failed: HTTP 429");
    expect(r.score).not.toBeNull();
  });

  it("wallet maturity on age alone says so when the token count is unavailable", () => {
    const ls = input(many(20, { boughtDay: 5, ageDays: 100 })).ledgers.map((h) => ({ ...h, tokensReason: "no keyless token-list API" }));
    const r = computeHolderStrength({ ...input([]), ledgers: ls });
    expect(r.components.find((x) => x.id === "maturity")!.evidence).toMatch(/token count known for 0 of 20 \(no keyless token-list API\) — the others are scored on age alone/);
  });
});

describe("Holder Strength in scoring", () => {
  const est = (over: Partial<TokenSnapshot>) => scoreSnapshot(perfectSnapshot("robinhood", over), []);
  const factor = (r: ReturnType<typeof est>) => r.groups.flatMap((g) => g.factors).find((f) => f.id === "holder_strength")!;

  it("Established Robinhood / Solana: a 10-point factor in the holder group; the accumulator factors are inputs now", () => {
    const r = est({ holderStrength: 85, holderStrengthLabel: "Diamond" });
    const holders = r.groups.find((g) => g.id === "holders")!;
    expect(factor(r).max).toBe(10);
    expect(factor(r).points).toBe(10);
    expect(holders.factors.map((f) => f.id)).not.toContain("accumulator_count");
    expect(holders.factors.map((f) => f.id)).not.toContain("accumulator_supply");
    expect(factor(r).evidence).toBe("Holder Strength 85/100 — Diamond (top-20 non-LP holders).");
    expect(factor(est({ holderStrength: 30, holderStrengthLabel: "Weak" })).points).toBe(2.5);
  });

  it("still reading (pending): n/a, not missing — no coverage penalty", () => {
    const r = est({ holderStrength: null, holderStrengthPending: true });
    expect(factor(r).status).toBe("n/a");
    expect(r.coveragePct).toBe(100);
  });

  it("not measurable (not pending): null with the reason, counted as missing", () => {
    const r = est({ holderStrength: null, nullReasons: { holderStrength: "only 2 of 6 components measurable" } });
    expect(factor(r).status).toBe("null");
    expect(factor(r).nullReason).toBe("only 2 of 6 components measurable");
  });

  it("Launch mode: no Holder Strength factor (information only)", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { ageHours: 20, holderStrength: 90 }), []);
    expect(r.groups.flatMap((g) => g.factors).find((f) => f.id === "holder_strength")).toBeUndefined();
  });

  it("Base / Monad Established: information only, no factor", () => {
    for (const chain of ["base", "monad"] as const) {
      const r = scoreSnapshot(perfectSnapshot(chain, { holderStrength: 90 }), []);
      expect(r.groups.flatMap((g) => g.factors).find((f) => f.id === "holder_strength")).toBeUndefined();
    }
  });

  it("caps: a vesting-led holder base with Holder Strength ≥ 80 softens ≥ 35% / > 20% by one tier; an unlabelled wallet never", () => {
    const fired = (over: Partial<TokenSnapshot>) => est(over).rules.filter((r) => r.state === "fired").map((r) => r.id);
    expect(fired({ top1SharePct: 40, vestingDiamond: true, holderStrength: 85 })).toEqual(expect.arrayContaining(["top_holder_35_vesting", "top_holder_20_vesting"]));
    expect(fired({ top1SharePct: 40, vestingDiamond: true, holderStrength: 85 })).not.toContain("top_holder_35");
    expect(est({ top1SharePct: 40, vestingDiamond: true, holderStrength: 85 }).rules.find((r) => r.id === "top_holder_35_vesting")!.capTier).toBe("C");
    expect(est({ top1SharePct: 25, vestingDiamond: true, holderStrength: 85 }).rules.find((r) => r.id === "top_holder_20_vesting")!.capTier).toBe("B");
    // Holder Strength 95 with an unlabelled wallet on top: the normal caps.
    expect(fired({ top1SharePct: 40, vestingDiamond: false, holderStrength: 95 })).toEqual(expect.arrayContaining(["top_holder_35", "top_holder_20"]));
    expect(est({ top1SharePct: 40, vestingDiamond: false, holderStrength: 95 }).tier).toBe("D");
  });
});

describe("Holder Strength: which holders", () => {
  it("top-20 counted wallets plus vesting supply; CEX by the source's label; founder / team carry their never-sold flag", () => {
    const s: TokenSnapshot = {
      ...emptySnapshot("base", addr(1)),
      holders: [
        { address: addr(1), qty: null, pct: 30, buys: null, sells: null, isContract: false },
        { address: addr(2), qty: null, pct: 5, buys: null, sells: null, isContract: false, label: "Coinbase 10" },
        ...Array.from({ length: 25 }, (_, i) => ({ address: addr(10 + i), qty: null, pct: 1, buys: null, sells: null, isContract: false })),
      ],
      holderClasses: [
        { address: addr(1), pct: 30, class: "founder", label: "founder wallet (deployer)", counted: true, detail: null, unlocksAt: null, evidence: "" },
        { address: addr(3), pct: 12, class: "vesting", label: "vesting contract (Sablier)", counted: false, detail: null, unlocksAt: null, evidence: "" },
      ],
      founderNeverSold: true,
    };
    const hs = strengthHolders(s);
    expect(hs).toHaveLength(20);
    expect(hs[0]).toMatchObject({ address: addr(1), cls: "founder", keyNeverSold: true });
    expect(hs[1]).toMatchObject({ address: addr(3), cls: "vesting" });
    expect(hs[2]).toMatchObject({ address: addr(2), cls: "cex" });
  });
});
