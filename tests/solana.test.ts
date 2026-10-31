import { afterEach, describe, expect, it, vi } from "vitest";
import { fundingClusters, helius, HELIUS_NOT_SET, parseCurveTrades, type ParsedTx } from "@/lib/sources/helius";
import { bondingCurveAddress, curveProgressPct, decodeCurve } from "@/lib/sources/solanaCurve";
import { pumpfeed } from "@/lib/sources/pumpfeed";

const MINT = "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump";
const CURVE = "DiFVDcnxubBDpdJNVLQN59qZPjwdp4hEygxmybDKE6qu";

describe("pump.fun bonding curve", () => {
  it("derives the curve PDA exactly as the chain does", () => {
    expect(bondingCurveAddress(MINT)).toBe(CURVE);
  });

  it("decodes reserves and progress from account bytes", () => {
    const buf = new Uint8Array(49);
    const view = new DataView(buf.buffer);
    view.setBigUint64(8, 1_047_144_578_409_978n, true);
    view.setBigUint64(16, 30_740_740_744n, true);
    view.setBigUint64(24, 767_244_578_409_978n, true);
    view.setBigUint64(32, 740_740_744n, true);
    view.setBigUint64(40, 1_000_000_000_000_000n, true);
    const c = decodeCurve(buf);
    expect(c.realSolReserves).toBe(740_740_744n);
    expect(c.complete).toBe(false);
    expect(curveProgressPct(c)).toBeCloseTo(3.26, 2);
    buf[48] = 1;
    expect(curveProgressPct(decodeCurve(buf))).toBe(100);
  });
});

// ---------------------------------------------------------------------------------------------
const bal = (owner: string, amount: bigint) => ({ accountIndex: 0, mint: MINT, owner, uiTokenAmount: { amount: amount.toString(), decimals: 6 } });
let slot = 100;
function trade(owner: string, before: bigint, after: bigint, curveBefore: bigint, curveAfter: bigint, solSpent = 0): ParsedTx {
  slot += 1;
  return {
    slot,
    blockTime: 1_700_000_000 + slot,
    meta: {
      err: null,
      preBalances: [10e9, 0],
      postBalances: [10e9 - solSpent * 1e9, 0],
      preTokenBalances: [bal(owner, before), bal(CURVE, curveBefore)],
      postTokenBalances: [bal(owner, after), bal(CURVE, curveAfter)],
    },
    transaction: { message: { accountKeys: [{ pubkey: owner }, { pubkey: CURVE }] } },
  };
}

describe("curve trade parsing (buyer exit, dev buy, snipes)", () => {
  it("detects that every buyer has exited", () => {
    slot = 100;
    const C = 800n;
    const txs = [
      trade("dev", 0n, 50n, C, C - 50n, 1),
      trade("a", 0n, 10n, C - 50n, C - 60n),
      trade("b", 0n, 10n, C - 60n, C - 70n),
      trade("c", 0n, 10n, C - 70n, C - 80n),
      trade("d", 0n, 10n, C - 80n, C - 90n),
      trade("dev", 50n, 0n, C - 90n, C - 40n),
      trade("a", 10n, 0n, C - 40n, C - 30n),
      trade("b", 10n, 0n, C - 30n, C - 20n),
      trade("c", 10n, 0n, C - 20n, C - 10n),
      trade("d", 10n, 0n, C - 10n, C),
    ];
    const t = parseCurveTrades(txs, MINT, CURVE, "dev");
    expect(t.uniqueBuyers).toBe(5);
    expect(t.sellers).toBe(5);
    expect([...t.buyers].every((b) => t.lastBalance.get(b) === 0n)).toBe(true);
    expect(t.creatorBought).toBe(50n);
    expect(t.creatorSold).toBe(50n);
    expect(Number((t.creatorBought * 100n) / t.totalBought)).toBe(55); // dev bought 50 of 90
    expect(t.creatorSolSpent).toBeCloseTo(1);
    expect(t.snipedInFirstSlots).toBe(60n); // dev + a in the first 2 slots
  });

  it("counts the dev buy inside the creation transaction (curve account created in the same tx)", () => {
    slot = 500;
    const create: ParsedTx = {
      slot: 500,
      blockTime: 1_700_000_500,
      meta: {
        err: null,
        preBalances: [10e9, 0],
        postBalances: [7e9, 0],
        preTokenBalances: [],
        postTokenBalances: [bal("dev", 100n), bal(CURVE, 900n)],
      },
      transaction: { message: { accountKeys: [{ pubkey: "dev" }, { pubkey: CURVE }] } },
    };
    const t = parseCurveTrades([create, trade("a", 0n, 50n, 900n, 850n)], MINT, CURVE, "dev");
    expect(t.creatorBought).toBe(100n);
    expect(t.creatorSolSpent).toBeCloseTo(3);
    expect(t.uniqueBuyers).toBe(2);
    expect(t.sellers).toBe(0);
    expect(Number((t.creatorBought * 100n) / t.totalBought)).toBe(66);
  });

  it("ignores failed transactions", () => {
    const failed = { ...trade("x", 0n, 5n, 100n, 95n), meta: { ...trade("x", 0n, 5n, 100n, 95n).meta!, err: { InstructionError: [0, "Custom"] } } };
    expect(parseCurveTrades([failed], MINT, CURVE, null).uniqueBuyers).toBe(0);
  });
});

describe("funding clusters (HoodTier cluster, funding-graph)", () => {
  it("groups wallets funded by one source within 2h", () => {
    const base = 1_700_000_000;
    const c = fundingClusters([
      { wallet: "w1", funder: "F", time: base, pct: 2 },
      { wallet: "w2", funder: "F", time: base + 600, pct: 3 },
      { wallet: "w3", funder: "F", time: base + 3600, pct: 4 },
      { wallet: "w4", funder: "F", time: base + 30_000, pct: 9 }, // too late
      { wallet: "w5", funder: "G", time: base, pct: 1 },
      { wallet: "w6", funder: null, time: null, pct: 1 },
    ]);
    expect(c.size).toBe(3);
    expect(c.supplyPct).toBe(9);
    expect(c.wallets).toEqual(["w1", "w2", "w3"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("key-gated sources state exactly why they are null", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('Helius without a key ⇒ skipped, "Helius key not set" on every Helius metric', async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    const r = await helius(MINT);
    expect(r.status.state).toBe("skipped");
    expect(r.status.message).toBe(HELIUS_NOT_SET);
    expect(r.data.nullReasons?.freshWalletsTop20).toBe("Helius key not set");
    expect(r.data.nullReasons?.fundingClusterMax).toBe("Helius key not set");
  });

  const mcpReply = (sc: unknown) => async (_u: string, init?: RequestInit) => {
    const { id } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { structuredContent: sc } }), { status: 200 });
  };

  it("pump.fun intel feed with no observation for the mint ⇒ partial, every feed metric null with the reason", async () => {
    vi.stubGlobal("fetch", mcpReply({ found: false }));
    const r = await pumpfeed(MINT);
    expect(r.status.state).toBe("partial");
    expect(r.data.snipeRatioPct).toBeUndefined();
    expect(r.data.nullReasons?.snipeRatioPct).toMatch(/no launch observation/);
  });

  it("feed fields that are absent stay null — never fabricated; 0–1 scores become 0–100", async () => {
    vi.stubGlobal(
      "fetch",
      mcpReply({ found: true, observation_seconds: 90, first_seen_at: "2026-10-23T15:53:39Z", bundle_score: 0.72, snipe_ratio: 0.94, dev_buy_sol: 3, buy_volume_sol: 8, top_wallets: [{ wallet: "c", is_creator: true, buy_sol: 2, sell_sol: 0 }] }),
    );
    const r = await pumpfeed(MINT);
    expect(r.status.state).toBe("ok");
    expect(r.data.bundleScore).toBeCloseTo(72);
    expect(r.data.snipeRatioPct).toBeCloseTo(94);
    expect(r.data.devBuySol).toBe(3);
    expect(r.data.devBuySharePct).toBeCloseTo(25);
    expect(r.data.organicScore).toBeNull();
    expect(r.data.feesSol).toBeUndefined();
    expect(r.data.nullReasons?.organicScore).toBe("three.ws intel did not return this field");
    expect(r.data.nullReasons?.feesSol).toBe("three.ws intel has no fees field");
    expect(r.data.feedWindow).toMatch(/first 90s/);
  });
});
