import { describe, expect, it } from "vitest";
import { computeHolderStrength, isDipBuy, STRENGTH_AREAS, STRENGTH_WEIGHTS, strengthLabel, worstDrawdown7d, type DayCandle, type HolderLedger, type LedgerEvent, type StrengthInput } from "@/lib/holderStrength";
import { HOLDER_SERIES_REASON, portfolioReason, strengthHolders } from "@/lib/holderStrengthData";
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

/** A complete wallet ledger with explicit events (seasoned wallet, 6 tokens). */
function withEvents(i: number, events: LedgerEvent[], pct = 5): HolderLedger {
  return { address: addr(i), pct, cls: "wallet", events, complete: true, walletFirstSeenT: CREATED - 200 * DAY, tokensHeld: 6 };
}
const ev = (t: number, kind: LedgerEvent["kind"], qty: number): LedgerEvent => ({ t, kind, qty, priceUsd: null });
const comp = (r: ReturnType<typeof computeHolderStrength>, id: string) => r.components.find((c) => c.id === id)!;

describe("Holder Strength: Conviction / Demand areas", () => {
  it("weights: Conviction 67 + Demand 33 = 100; every component is tagged with its area, Conviction listed first", () => {
    const conv = STRENGTH_AREAS.conviction.components.reduce((a, id) => a + STRENGTH_WEIGHTS[id], 0);
    const dem = STRENGTH_AREAS.demand.components.reduce((a, id) => a + STRENGTH_WEIGHTS[id], 0);
    expect([conv, dem]).toEqual([67, 33]);
    const r = computeHolderStrength(input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 })));
    expect(r.components).toHaveLength(10);
    expect(r.components.every((c) => c.area === (STRENGTH_AREAS.conviction.components.includes(c.id) ? "conviction" : "demand"))).toBe(true);
    const firstDemand = r.components.findIndex((c) => c.area === "demand");
    expect(r.components.slice(firstDemand).every((c) => c.area === "demand")).toBe(true);
    expect(r.areas!.map((a) => [a.id, a.label, a.weight])).toEqual([
      ["conviction", "Conviction", 67],
      ["demand", "Demand", 33],
    ]);
  });

  it("an area's score is the weighted mean of its scored components (0–100); the overall score is the mean over all scored components", () => {
    const r = computeHolderStrength(input(many(20, { boughtDay: 5, dipBuy: true, ageDays: 400, tokens: 12 }), { accumulatorSupplyPct: 8 }));
    for (const a of r.areas!) {
      const got = r.components.filter((c) => c.area === a.id && c.score != null);
      const w = got.reduce((x, c) => x + c.weight, 0);
      expect(a.scoredWeight).toBe(w);
      expect(a.score).toBeCloseTo((got.reduce((x, c) => x + c.weight * c.score!, 0) / w) * 100, 1);
    }
    const all = r.components.filter((c) => c.score != null);
    expect(r.score).toBeCloseTo((all.reduce((x, c) => x + c.weight * c.score!, 0) / all.reduce((x, c) => x + c.weight, 0)) * 100, 1);
    // Diamond-hand holders who stopped trading: conviction full, demand held down by "no activity" in the last 7d.
    expect(r.areas![0].score).toBe(100);
    expect(r.areas![1].score!).toBeLessThan(100);
  });

  it("an area with nothing measurable is null with the reasons of its components", () => {
    const r = computeHolderStrength(input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 }), { createdT: NOW - 5 * DAY, candles: null, candleReason: "GeckoTerminal failed: HTTP 429" }));
    const demand = r.areas!.find((a) => a.id === "demand")!;
    expect(demand.score).toBeNull();
    expect(demand.nullReason).toMatch(/^no demand component measurable — dip accumulation: too new to measure/);
  });
});

describe("Holder Strength: whale net accumulation (7d)", () => {
  const recent = (d: number) => NOW - d * DAY;

  it("buy share of the top-20 swap volume over the last 7d, by token quantity; older trades and transfers do not count", () => {
    const ls = [
      withEvents(1, [ev(CREATED + DAY * 5, "buy", 1000), ev(recent(2), "buy", 300), ev(recent(20), "sell", 900)]),
      withEvents(2, [ev(CREATED + DAY * 5, "buy", 1000), ev(recent(3), "sell", 100), ev(recent(1), "out", 500)]),
    ];
    const r = computeHolderStrength({ ...input([]), ledgers: ls });
    const c = comp(r, "whaleNet");
    expect(c.score).toBeCloseTo(0.75, 5);
    expect(c.evidence).toMatch(/bought 300 and sold 100 tokens \(net \+200; 1 buyers, 1 sellers\) — buy share 75%/);
    expect(c.sentence).toBe("top-20 wallets were net buyers over the last 7 days (75% of their swap volume)");
  });

  it("net sellers score low", () => {
    const ls = [withEvents(1, [ev(CREATED + DAY * 5, "buy", 1000), ev(recent(2), "sell", 900), ev(recent(1), "buy", 100)])];
    const c = comp(computeHolderStrength({ ...input([]), ledgers: ls }), "whaleNet");
    expect(c.score).toBeCloseTo(0.1, 5);
    expect(c.sentence).toMatch(/net sellers over the last 7 days \(only 10%/);
  });

  it("no swaps in the last 7d is a value — 0, 'no activity' — not missing", () => {
    const c = comp(computeHolderStrength(input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 }))), "whaleNet");
    expect(c.score).toBe(0);
    expect(c.nullReason).toBeUndefined();
    expect(c.evidence).toMatch(/^no activity: none of the 20 read top-20 wallets swapped in the last 7d/);
  });

  it("too new: a token younger than 10d is 'too new to measure' (null, left out of the weight)", () => {
    const ls = [withEvents(1, [ev(recent(4), "buy", 1000), ev(recent(1), "buy", 10)])];
    const c = comp(computeHolderStrength({ ...input([]), ledgers: ls, createdT: NOW - 6 * DAY }), "whaleNet");
    expect(c.score).toBeNull();
    expect(c.tooNew).toBe(true);
    expect(c.nullReason).toBe("too new to measure — token is 6d old; needs ≥ 10d");
  });

  it("no wallet history read: null with the reason", () => {
    const r = computeHolderStrength({ ...input([]), ledgers: [{ ...withEvents(1, []), complete: false }] });
    expect(comp(r, "whaleNet").nullReason).toBe("no top-20 wallet history read");
  });
});

describe("Holder Strength: dip absorption (red days)", () => {
  /** Days 110 and 115 close red (open 1 → close 0.9). */
  const redCandles = () => candles().map((x, i) => (i === 110 || i === 115 ? { ...x, o: 1, c: 0.9, l: 0.88 } : x));
  const onDay = (d: number) => CREATED + d * DAY + 7200;

  it("buy share of the top-20 swap volume on days that closed red in the last 30d", () => {
    const ls = [
      withEvents(1, [ev(CREATED + DAY * 5, "buy", 1000), ev(onDay(110), "buy", 400), ev(onDay(111), "sell", 999)]),
      withEvents(2, [ev(CREATED + DAY * 5, "buy", 1000), ev(onDay(115), "sell", 100), ev(onDay(115), "buy", 100)]),
    ];
    const c = comp(computeHolderStrength({ ...input([]), ledgers: ls, candles: redCandles() }), "dipAbsorption");
    expect(c.score).toBeCloseTo(500 / 600, 5);
    expect(c.evidence).toMatch(/^2 red days in the last 30d: top-20 wallets bought 500 and sold 100 tokens on them — buy share 83%/);
    expect(c.sentence).toMatch(/net buyers on red days/);
  });

  it("no red day in the last 30d: n/a (nothing to absorb), not missing", () => {
    const r = computeHolderStrength(input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 })));
    const c = comp(r, "dipAbsorption");
    expect(c.na).toBe(true);
    expect(c.score).toBeNull();
    expect(r.score).not.toBeNull();
  });

  it("red days without any top-20 swap: 0, 'no activity'", () => {
    const c = comp(computeHolderStrength(input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 }), { candles: redCandles() })), "dipAbsorption");
    expect(c.score).toBe(0);
    expect(c.evidence).toMatch(/^no activity: 2 red days in the last 30d, no top-20 swap on any of them/);
  });

  it("a red day older than 30d or inside the 72h launch phase does not count", () => {
    const c0 = candles().map((x, i) => (i === 1 || i === 80 ? { ...x, o: 1, c: 0.9 } : x));
    const c = comp(computeHolderStrength(input(many(20, { boughtDay: 0, ageDays: 100, tokens: 5 }), { candles: c0 })), "dipAbsorption");
    expect(c.na).toBe(true);
  });

  it("no candles: null with the source's reason; too new below 10d", () => {
    expect(comp(computeHolderStrength(input(many(20, { boughtDay: 5 }), { candles: null, candleReason: "GeckoTerminal failed: HTTP 429" })), "dipAbsorption").nullReason).toBe("GeckoTerminal failed: HTTP 429");
    const young = comp(computeHolderStrength(input(many(20, { boughtDay: 5 }), { createdT: NOW - 9 * DAY })), "dipAbsorption");
    expect(young.tooNew).toBe(true);
    expect(young.evidence).toBe("too new to measure — token is 9d old; needs ≥ 10d — not scored");
  });
});

describe("Holder Strength: holder growth and fullported (inputs our sources do not provide)", () => {
  it("holder growth without a holder-count series: null with the reason, marked unavailable, not counted as missing", () => {
    const base = input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 }));
    const r = computeHolderStrength({ ...base, holderSeries: null, holderSeriesReason: HOLDER_SERIES_REASON });
    const c = comp(r, "holderGrowth");
    expect(c.score).toBeNull();
    expect(c.unavailable).toBe(true);
    expect(c.nullReason).toBe(HOLDER_SERIES_REASON);
    // Same score as with the component absent from the weight entirely.
    expect(r.score).toBe(computeHolderStrength(base).score);
  });

  it("holder growth from a real series: −10% → 0, +20% → 1, against the newest point 7–10.5d before the latest", () => {
    const series = (from: number, to: number) => [
      { t: NOW - 30 * DAY, count: 1 },
      { t: NOW - 8 * DAY, count: from },
      { t: NOW, count: to },
    ];
    const g = (from: number, to: number) => comp(computeHolderStrength(input(many(20, { boughtDay: 5 }), { holderSeries: series(from, to) })), "holderGrowth");
    expect(g(1000, 1200).score).toBe(1);
    expect(g(1000, 900).score).toBe(0);
    expect(g(1000, 1050).score).toBeCloseTo(0.5, 5);
    expect(g(1000, 1050).evidence).toBe("holders 1000 → 1050 over 8d (+5%; 0 at ≤ −10%, full at ≥ +20%)");
  });

  it("holder growth: a series without a point 7–10.5d back is missing (null with the reason); too new below 10d", () => {
    const short = comp(computeHolderStrength(input(many(20, { boughtDay: 5 }), { holderSeries: [{ t: NOW - 2 * DAY, count: 10 }, { t: NOW, count: 12 }] })), "holderGrowth");
    expect(short.score).toBeNull();
    expect(short.unavailable).toBeUndefined();
    expect(short.nullReason).toBe("holder-count series has no point 7–10.5d before its latest (2 points)");
    const young = comp(computeHolderStrength(input(many(20, { boughtDay: 5 }), { createdT: NOW - 7 * DAY, holderSeries: [{ t: NOW, count: 12 }] })), "holderGrowth");
    expect(young.tooNew).toBe(true);
  });

  it("fullported without portfolio values: null with the exact reason, unavailable — a token count is not a portfolio value", () => {
    const ls = input(many(20, { boughtDay: 5, ageDays: 100, tokens: 1 })).ledgers;
    for (const chain of ["robinhood", "solana", "base", "monad", "ethereum"] as const) {
      const c = comp(computeHolderStrength({ ...input([]), ledgers: ls, portfolioShares: null, portfolioReason: portfolioReason(chain) }), "fullported");
      expect(c.score).toBeNull();
      expect(c.unavailable).toBe(true);
      expect(c.nullReason).toMatch(/^no per-wallet portfolio value — /);
    }
    expect(portfolioReason("robinhood")).toMatch(/count of open positions .* not their USD values/);
    expect(portfolioReason("solana")).toMatch(/balances without prices/);
  });

  it("fullported from real portfolio values: share of the supply held by wallets with ≥ 50% of their portfolio in this token; full at ≥ 50%", () => {
    const ls = input(many(20, { boughtDay: 5, ageDays: 100, tokens: 5 })).ledgers;
    const shares = Object.fromEntries(ls.map((h, i) => [h.address, i < 4 ? 0.8 : 0.1]));
    const c = comp(computeHolderStrength({ ...input([]), ledgers: ls, portfolioShares: shares }), "fullported");
    expect(c.score).toBeCloseTo(0.2 / 0.5, 5);
    expect(c.evidence).toMatch(/^4 of 20 wallets hold ≥ 50% of their portfolio value in this token \(20% of their supply/);
    const thin = comp(computeHolderStrength({ ...input([]), ledgers: ls, portfolioShares: { [ls[0].address]: 0.9 } }), "fullported");
    expect(thin.score).toBeNull();
    expect(thin.nullReason).toBe("portfolio value read for 1 of 20 wallets (< 30% of their supply)");
  });

  it("the collector states holder growth and fullported as unavailable — never estimated", () => {
    expect(HOLDER_SERIES_REASON).toMatch(/^no holder-count series in our sources — .*only today's holder count/);
  });
});

describe("Holder Strength: too new to measure (young tokens)", () => {
  /** A 5-day-old token: wallets bought on day 0, never sold. */
  const youngInput = (over: Partial<StrengthInput> = {}): StrengthInput => {
    const created = NOW - 5 * DAY;
    const ledgers = Array.from({ length: 20 }, (_, i): HolderLedger => ({ address: addr(i + 1), pct: 5, cls: "wallet", events: [ev(created + 3600, "buy", 1000)], complete: true, walletFirstSeenT: created - 200 * DAY, tokensHeld: 8 }));
    return { ledgers, createdT: created, nowT: NOW, candles: candles().slice(0, 5).map((c, i) => ({ ...c, t: created + i * DAY })), accumulatorSupplyPct: 6, method: "test", ...over };
  };

  it("time-based components are null 'too new to measure', never guessed: hold < 14d; drawdown, dip accumulation, whale net, dip absorption, holder growth < 10d", () => {
    const r = computeHolderStrength(youngInput({ holderSeries: [{ t: NOW, count: 50 }] }));
    const newIds = r.components.filter((c) => c.tooNew).map((c) => c.id).sort();
    expect(newIds).toEqual(["accumulation", "dipAbsorption", "drawdown", "hold", "holderGrowth", "whaleNet"]);
    for (const id of newIds) {
      expect(comp(r, id).score).toBeNull();
      expect(comp(r, id).evidence).toMatch(/^too new to measure — token is 5d old; needs ≥ 1[04]d — not scored$/);
    }
    // Hold uses 14d: a 12-day-old token still has no hold score, while windowed components (10d) do measure.
    const twelve = computeHolderStrength({ ...input(many(20, { boughtDay: 0, ageDays: 100, tokens: 5 })), createdT: NOW - 12 * DAY });
    expect(comp(twelve, "hold").tooNew).toBe(true);
    expect(comp(twelve, "whaleNet").tooNew).toBeUndefined();
  });

  it("too-new components are left out of the weight: age neither penalises nor inflates the score", () => {
    const r = computeHolderStrength(youngInput());
    // Discipline (0 sells < 30d = 0.8), maturity (1) and accumulators (1) remain.
    expect(r.score).toBeCloseTo(((14 * 0.8 + 10 * 1 + 8 * 1) / 32) * 100, 1);
    expect(r.label).toBe("Diamond");
  });

  it("age never pushes a token to 'no score': with components too new, two measured components are enough (three otherwise)", () => {
    // Young: discipline + maturity (accumulators unread) still score.
    const young = computeHolderStrength(youngInput({ accumulatorSupplyPct: null, accumulatorReason: "no swap-index holder list" }));
    expect(young.score).toBeCloseTo(((14 * 0.8 + 10 * 1) / 24) * 100, 1);
    // Nothing too new (age unknown) and only two measured components (discipline, whale net): null, three are needed.
    const two = computeHolderStrength(input(many(20, { boughtDay: 5 }), { createdT: null, candles: null, candleReason: "GeckoTerminal failed: HTTP 429" }));
    expect(two.components.filter((c) => c.score != null).map((c) => c.id).sort()).toEqual(["discipline", "whaleNet"]);
    expect(two.score).toBeNull();
    expect(two.nullReason).toMatch(/^only 2 of 10 components measurable — hold duration: token age unknown; drawdown survival: GeckoTerminal failed: HTTP 429/);
  });

  it("too few measurable components on a young token: null, and the reason counts the too-new ones", () => {
    const ls = youngInput().ledgers.map((h) => ({ ...h, walletFirstSeenT: null, walletAgeReason: "archive search did not finish in time" }));
    const r = computeHolderStrength(youngInput({ ledgers: ls, accumulatorSupplyPct: null, accumulatorReason: "no swap-index holder list" }));
    expect(r.score).toBeNull();
    expect(r.nullReason).toBe("only 1 of 10 components measurable (5 too new to measure) — wallet maturity: archive search did not finish in time; 0-sell accumulators: no swap-index holder list");
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
