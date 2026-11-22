import { describe, expect, it, vi } from "vitest";
import { deriveMetrics } from "@/lib/snapshot";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { perfectSnapshot } from "./helpers";

/**
 * 2026-11-22: HoodScan's swap index stalled. Its newest microduck swap was 16.9h old while DexScreener counted
 * trades on 5 pools in the last hour (≈ $96k/24h), and dead_no_trades forced microduck, GIGATENEV, Kolshi and
 * UHI to F 0 on production.
 */
describe("a stalled trade index is not 'no trades'", () => {
  it("HoodScan's 16.9h is contradicted by DexScreener trades in the last 1h: null with both readings, no dead F", () => {
    const d = deriveMetrics(perfectSnapshot("robinhood", { lastTradeHoursAgo: 16.9, lastTradeWithinHours: 1 }));
    expect(d.lastTradeHoursAgo).toBeNull();
    expect(d.nullReasons.lastTradeHoursAgo).toMatch(/contradicted.*DexScreener counts trades in the last 1h/);
    const r = scoreSnapshot(d);
    expect(r.rules.find((x) => x.id === "dead_no_trades")!.state).not.toBe("fired");
    expect(r.tier).not.toBe("F");
  });

  it("a genuinely dead token still fires: no DexScreener trade in 24h leaves the index reading standing", () => {
    const d = deriveMetrics(perfectSnapshot("robinhood", { lastTradeHoursAgo: 30, lastTradeWithinHours: null }));
    expect(d.lastTradeHoursAgo).toBe(30);
    expect(scoreSnapshot(d).tier).toBe("F");
  });

  it("consistent readings are untouched (last trade 0.5h, traded within 1h)", () => {
    expect(deriveMetrics(perfectSnapshot("robinhood", { lastTradeHoursAgo: 0.5, lastTradeWithinHours: 1 })).lastTradeHoursAgo).toBe(0.5);
  });
});

describe("DexScreener states the shortest window with a trade", () => {
  it("h1 counts on every base pair ⇒ within 1h; a pair missing h1 counts falls back to the next window", async () => {
    const addr = "0x" + "d".repeat(40);
    const pair = (id: string, txns: object) => ({ chainId: "robinhood", dexId: "uniswap", pairAddress: id, url: "u", baseToken: { address: addr, name: "M", symbol: "M" }, quoteToken: { address: "0x" + "e".repeat(40), symbol: "WETH" }, priceUsd: "1", txns, liquidity: { usd: 10_000 }, volume: { h24: 5_000 } });
    vi.resetModules();
    let pairs = [pair("0x" + "1".repeat(40), { h1: { buys: 1, sells: 1 }, h6: { buys: 17, sells: 11 }, h24: { buys: 40, sells: 30 } }), pair("0x" + "2".repeat(40), { h1: { buys: 0, sells: 0 }, h6: { buys: 2, sells: 0 }, h24: { buys: 5, sells: 3 } })];
    vi.doMock("@/lib/sources/http", async (orig) => ({ ...(await orig<typeof import("@/lib/sources/http")>()), fetchJson: async () => ({ pairs }) }));
    const { dexscreener } = await import("@/lib/sources/dexscreener");
    expect((await dexscreener("robinhood", addr)).data.lastTradeWithinHours).toBe(1);
    pairs = [pairs[0], pair("0x" + "2".repeat(40), { h6: { buys: 2, sells: 0 }, h24: { buys: 5, sells: 3 } })];
    expect((await dexscreener("robinhood", addr)).data.lastTradeWithinHours).toBe(6);
    vi.doUnmock("@/lib/sources/http");
  });
});

describe("a stale 'traded within' bound ages", () => {
  it("'within 1h' refilled from a 5h-old snapshot reads 'within 6h' — it cannot suppress a genuine dead F for long", async () => {
    const { fillFromStale } = await import("@/lib/stale");
    const now = Date.now();
    const fill = fillFromStale({}, { fields: { lastTradeWithinHours: { v: 1, at: now - 5 * 3_600_000 } } }, now);
    expect(fill.data.lastTradeWithinHours).toBeCloseTo(6);
    expect(fill.staleFields.lastTradeWithinHours).toBe(300);
  });
});
