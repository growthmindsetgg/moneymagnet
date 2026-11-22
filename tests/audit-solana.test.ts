import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rugcheck } from "@/lib/sources/rugcheck";
import { jupiter } from "@/lib/sources/jupiter";
import { scanhood } from "@/lib/sources/scanhood";
import { pumpfeed } from "@/lib/sources/pumpfeed";
import { solanaCurve, bondingCurveAddress } from "@/lib/sources/solanaCurve";
import { helius } from "@/lib/sources/helius";
import { heliusRpc, resetHeliusQueue } from "@/lib/sources/heliusQueue";
import { applyZeroActivity, deadLaunchOf, deriveMetrics, emptySnapshot, mergeSnapshots } from "@/lib/snapshot";
import { fillFromStale } from "@/lib/stale";
import { setKV } from "@/lib/kv";
import type { SourceStatus, TokenSnapshot } from "@/lib/types";
import { perfectSnapshot } from "./helpers";

const MINT = "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump";
const RH = "0x" + "ab".repeat(20);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------------------------------------------
describe("C5 RugCheck: missing fields are unknown, and a transfer fee is never a simulated round trip", () => {
  const stub = (report: Record<string, unknown>) =>
    vi.stubGlobal("fetch", async (url: string) => (String(url).includes("rugcheck") ? json({ mint: MINT, ...report }) : Promise.reject(new Error("offline"))));

  it("a skeletal report gives null authorities / sellable with reasons, no round trip, no createdAt", async () => {
    stub({ token: { supply: 1e15, decimals: 6 }, detectedAt: "2026-11-01T00:00:00Z" });
    const r = await rugcheck(MINT);
    expect(r.data.mintAuthority).toBeNull();
    expect(r.data.freezeAuthority).toBeNull();
    expect(r.data.sellable).toBeNull();
    expect(r.data.roundTripLossPct).toBeUndefined();
    expect(r.data.nullReasons?.mintAuthority).toMatch(/no mintAuthority field/);
    expect(r.data.nullReasons?.sellable).toMatch(/freezeAuthority and transferFee/);
    // detectedAt is RugCheck's first sighting, not the creation time.
    expect(r.data.createdAt).toBeUndefined();
    expect(r.status.message).toMatch(/first detected .*not the creation time/);
  });

  it("present-but-null authorities mean revoked; a 0% fee makes it sellable but supplies no round-trip loss", async () => {
    stub({ token: { supply: 1e15, decimals: 6, mintAuthority: null, freezeAuthority: null }, transferFee: { pct: 0 } });
    const r = await rugcheck(MINT);
    expect(r.data.mintAuthority).toBe(false);
    expect(r.data.freezeAuthority).toBe(false);
    expect(r.data.sellable).toBe(true);
    expect(r.data.roundTripLossPct).toBeUndefined();
  });

  it("a real transfer fee is a labelled derived signal; ≥ 50% or a set freeze authority makes it unsellable", async () => {
    stub({ token: { mintAuthority: null, freezeAuthority: null }, transferFee: { pct: 12 } });
    const fee = await rugcheck(MINT);
    expect(fee.data.roundTripLossPct).toBeUndefined();
    expect(fee.data.fakeSignals!.some((s) => /transfer fee 12%.*24%.*derived.*not a simulation/.test(s.text))).toBe(true);
    stub({ token: { mintAuthority: null, freezeAuthority: null }, transferFee: { pct: 60 } });
    expect((await rugcheck(MINT)).data.sellable).toBe(false);
    // Freeze authority set decides "not sellable" even without a transferFee block.
    stub({ token: { mintAuthority: null, freezeAuthority: "Frz111" } });
    expect((await rugcheck(MINT)).data.sellable).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("H10 no fabricated percentages from booleans or absence", () => {
  it("Jupiter: buyable with no sell route ⇒ sellable false, round-trip loss null with the reason (not 100%)", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes(`inputMint=So11111111111111111111111111111111111111112`) ? json({ outAmount: "5000", routePlan: [{ swapInfo: { label: "Pump.fun" } }] }) : json({ error: "no route" }, 400),
    );
    const r = await jupiter(MINT);
    expect(r.data.sellable).toBe(false);
    expect(r.data.roundTripLossPct).toBeUndefined();
    expect(r.data.nullReasons?.roundTripLossPct).toMatch(/no sell route back.*no round trip measured/);
  });

  const scan = (sc: unknown) =>
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      const { id } = JSON.parse(String(init?.body));
      return json({ jsonrpc: "2.0", id, result: { structuredContent: sc } });
    });

  it("ScanHood: lp.safe=false without a share keeps lpLockedPct null with a note (never 0%)", async () => {
    scan({ verdict: "CAUTION", sellable: true, roundTripLossPct: 3, lp: { status: "unlocked", safe: false } });
    const r = await scanhood(RH);
    expect(r.data.lpLockedPct).toBeNull();
    expect(r.data.nullReasons?.lpLockedPct).toMatch(/LP not safe .*not a percentage/);
    expect(r.data.fakeSignals!.some((s) => /LP not safe/.test(s.text))).toBe(true);
  });

  it("ScanHood: lp.safe=true without a share is not 100%; a reported share is used as is", async () => {
    scan({ verdict: "PASS", sellable: true, roundTripLossPct: 1, lp: { status: "locked", safe: true } });
    expect((await scanhood(RH)).data.lpLockedPct).toBeNull();
    scan({ verdict: "PASS", sellable: true, roundTripLossPct: 1, lp: { status: "locked", safe: true, lockedPct: 80 } });
    expect((await scanhood(RH)).data.lpLockedPct).toBe(80);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("H13 DexScreener tx counts never become unique buyers", () => {
  const young = (o: Partial<TokenSnapshot>) => deriveMetrics({ ...emptySnapshot("solana", MINT), ageHours: 3, ...o });

  it("tx counts stay labelled buyers24h and leave uniqueBuyers null", () => {
    const d = young({ buyTxs24h: 597, sellTxs24h: 510 });
    expect(d.buyers24h).toBe(597);
    expect(d.buyersBasis).toMatch(/tx counts/);
    expect(d.uniqueBuyers).toBeNull();
  });

  it("unique-wallet 24h buyers still cover a < 24h token's whole life", () => {
    expect(young({ buyers24h: 40, sellers24h: 10 }).uniqueBuyers).toBe(40);
  });

  it("the all-buyers-exited path does not copy tx counts into uniqueBuyers either", () => {
    const d = young({ buyTxs24h: 30, sellTxs24h: 30, curveCirculatingPct: 0.001 });
    expect(d.uniqueBuyers).toBeNull();
  });

  it("tx counts > 2 do not clear the dead-launch buyer leg (one wallet can trade three times)", () => {
    const base = { ...emptySnapshot("solana", MINT), ageHours: 5, liquidityUsd: 5_000, deadCurve: false };
    expect(deadLaunchOf({ ...base, buyers24h: 3, buyersBasis: "tx counts, not unique wallets (DexScreener)" })).toBeNull();
    expect(deadLaunchOf({ ...base, buyers24h: 3, buyersBasis: "unique wallets" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("H6 / M8 derived values need their inputs", () => {
  it("the feed's dev_sold=false is not a lifetime 0% sold", () => {
    const d = deriveMetrics({ ...emptySnapshot("solana", MINT), deployerHasSold: false, feedWindow: "three.ws launch observation, first 90s" });
    expect(d.deployerSoldPct).toBeNull();
    expect(d.nullReasons.deployerSoldPct).toMatch(/launch observation .*not a lifetime share/);
  });

  it("an existing reason (e.g. Helius key not set) is kept", () => {
    const d = deriveMetrics({ ...emptySnapshot("solana", MINT), deployerHasSold: false, nullReasons: { deployerSoldPct: "Helius key not set" } });
    expect(d.nullReasons.deployerSoldPct).toBe("Helius key not set");
  });

  it("Robinhood wash 'no' needs turnover plus a swap-pattern input; missing inputs are not read as 0", () => {
    const partial = deriveMetrics(perfectSnapshot("robinhood", { washFlag: null, volLiqRatio: 1.3, repeatedSizeSharePct: null, bundleSharePct: null }));
    expect(partial.washFlag).toBeNull();
    expect(partial.nullReasons.washFlag).toMatch(/repeated-size/);
    const none = deriveMetrics(perfectSnapshot("robinhood", { washFlag: null, volLiqRatio: null, volMcRatio: 0.5, repeatedSizeSharePct: 5, bundleSharePct: null, liquidityUsd: null }));
    expect(none.washFlag).toBeNull();
    expect(deriveMetrics(perfectSnapshot("robinhood", { washFlag: null, volLiqRatio: 1.3, repeatedSizeSharePct: 5, bundleSharePct: null })).washFlag).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("H7/H12 zero activity needs a source that reads trades", () => {
  const quiet = (chain: "robinhood" | "solana"): TokenSnapshot => ({
    ...emptySnapshot(chain, chain === "solana" ? MINT : RH),
    ageHours: 0.3,
    volume24hUsd: 0,
  });
  const indexers: SourceStatus[] = [
    { id: "geckoterminal", label: "GeckoTerminal", state: "partial", message: "No pools" },
    { id: "dexscreener", label: "DexScreener", state: "partial", message: "no pairs" },
  ];

  it("Robinhood: indexers silent while HoodScan's trades and stats failed ⇒ nothing is zeroed", () => {
    const hs: SourceStatus = { id: "hoodscan", label: "HoodScan", state: "failed", message: "HTTP 503" };
    const d = applyZeroActivity(quiet("robinhood"), [...indexers, hs]);
    expect(d.zeroActivity).toEqual([]);
    expect(d.buyers24h).toBeNull();
    const partial: SourceStatus = { id: "hoodscan", label: "HoodScan", state: "partial", message: "2/4 calls failed (trades: HTTP 503; stats: HTTP 503)" };
    expect(applyZeroActivity(quiet("robinhood"), [...indexers, partial]).zeroActivity).toEqual([]);
  });

  it("Robinhood: HoodScan answered ⇒ zero activity applies", () => {
    const hs: SourceStatus = { id: "hoodscan", label: "HoodScan", state: "ok", message: "token + evidence + 0 swaps" };
    const d = applyZeroActivity(quiet("robinhood"), [...indexers, hs]);
    expect(d.zeroActivity.length).toBeGreaterThan(0);
    expect(d.buyers24h).toBe(0);
  });

  it("Solana: indexers silent and Helius failed ⇒ nothing is zeroed; Helius 0 buyers ⇒ zeroed", () => {
    const failed: SourceStatus = { id: "helius", label: "Helius", state: "failed", message: "HTTP 429" };
    expect(applyZeroActivity(quiet("solana"), [...indexers, failed]).zeroActivity).toEqual([]);
    const ok: SourceStatus = { id: "helius", label: "Helius", state: "ok", message: "1 curve trades: 0 buyers" };
    expect(applyZeroActivity({ ...quiet("solana"), uniqueBuyers: 0 }, [...indexers, ok]).zeroActivity).toContain("Helius: 0 buyers");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("M2 / M10 staleness", () => {
  it("a slice's stale age is copied only when its value won the merge", () => {
    const live = { buyers24h: 50 };
    const stale = { buyers24h: 40, sellers24h: 9, staleFields: { buyers24h: 120, sellers24h: 120 } };
    const m = mergeSnapshots(emptySnapshot("robinhood", RH), [live, stale]);
    expect(m.buyers24h).toBe(50);
    expect(m.staleFields).toEqual({ sellers24h: 120 });
  });

  it("time-relative fields are aged by their staleness on refill", () => {
    const t0 = 1_700_000_000_000;
    const stored = { fields: { ageHours: { v: 2, at: t0 }, lastTradeHoursAgo: { v: 1, at: t0 }, buyers24h: { v: 7, at: t0 } } };
    const fill = fillFromStale({}, stored, t0 + 5 * 3_600_000);
    expect(fill.data.ageHours).toBeCloseTo(7);
    expect(fill.data.lastTradeHoursAgo).toBeCloseTo(6);
    expect(fill.data.buyers24h).toBe(7);
    expect(fill.staleFields.ageHours).toBe(300);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("H3 / H4 / H5 Helius", () => {
  beforeEach(() => {
    setKV(null);
    resetHeliusQueue();
  });

  it("batchSettled reports failed items and never caches them", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      calls++;
      const body = JSON.parse(init.body) as { id: number; params: string[] }[];
      return json(body.map((b) => (b.params[0] === "bad" ? { jsonrpc: "2.0", id: b.id, error: { code: -32000, message: "boom" } } : { jsonrpc: "2.0", id: b.id, result: { sig: b.params[0] } })));
    });
    const h = heliusRpc("k");
    const first = await h.batchSettled<{ sig: string }>("getTransaction", [["good"], ["bad"]]);
    expect(first.values[0]).toEqual({ sig: "good" });
    expect(first.values[1]).toBeUndefined();
    expect(first.errors.get(1)).toMatch(/boom/);
    const again = await h.batchSettled<{ sig: string }>("getTransaction", [["good"], ["bad"]]);
    expect(calls).toBe(2); // "bad" asked again (not cached); "good" served from cache
    expect(again.errors.has(1)).toBe(true);
  });

  /** A Helius mock: pump.fun mint whose creator comes from the creation tx, 2 curve trades, one unreadable. */
  const heliusMock = (opts: { itemError?: { code: number; message: string }; curveAcctError?: string }) => {
    const curve = bondingCurveAddress(MINT);
    const methods: string[] = [];
    const createTx = {
      slot: 1,
      blockTime: 1_763_000_000,
      meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [{ pubkey: "CreatorWallet111" }] } },
    };
    const result = (method: string, params: unknown[]): unknown => {
      switch (method) {
        case "getAsset":
          return { token_info: { supply: 1e15, decimals: 6 }, creators: [{ address: "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM" }] };
        case "getTokenLargestAccounts":
          return { value: [] };
        case "getMultipleAccounts":
          return { value: [] };
        case "getTransactionsForAddress":
          return params[0] === MINT ? { data: [createTx] } : { data: [] };
        case "getSignaturesForAddress":
          return params[0] === curve ? [{ signature: "s1", err: null }, { signature: "s2", err: null }] : [];
        case "getTokenAccountsByOwner":
          return { value: [] };
        default:
          return null;
      }
    };
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (Array.isArray(body)) {
        return json(body.map((b: { id: number; params: string[] }) => (b.params[0] === "s2" && opts.itemError ? { jsonrpc: "2.0", id: b.id, error: opts.itemError } : { jsonrpc: "2.0", id: b.id, result: { ...createTx, slot: 2 } })));
      }
      methods.push(body.method);
      if (body.method === "getAccountInfo" && opts.curveAcctError) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: opts.curveAcctError } });
      if (body.method === "getAccountInfo") return json({ jsonrpc: "2.0", id: body.id, result: { value: null } });
      return json({ jsonrpc: "2.0", id: body.id, result: result(body.method, body.params) });
    });
    return methods;
  };

  it("an unreadable curve transaction nulls every curve field (non-outage: not stale-eligible)", async () => {
    vi.stubEnv("HELIUS_API_KEY", "k");
    heliusMock({ itemError: { code: -32000, message: "Transaction version unsupported" } });
    const r = await helius(MINT);
    for (const m of ["uniqueBuyers", "makersCount", "allBuyersExited"] as const) {
      expect(r.data[m], m).toBeUndefined();
      expect(r.data.nullReasons?.[m], m).toMatch(/curve history incomplete \(1 of 2 transactions unreadable/);
    }
    expect(r.failedFields ?? []).not.toContain("uniqueBuyers");
    expect(r.status.state).toBe("partial");
  });

  it("a 429 inside the batch is an outage: the curve fields are stale-eligible", async () => {
    vi.stubEnv("HELIUS_API_KEY", "k");
    heliusMock({ itemError: { code: 429, message: "rate limited" } });
    const r = await helius(MINT);
    expect(r.failedFields).toContain("uniqueBuyers");
  });

  it("a non-outage curve-account error is recorded: uniqueBuyers null with the error, not silently 'not graduated'", async () => {
    vi.stubEnv("HELIUS_API_KEY", "k");
    heliusMock({ curveAcctError: "invalid param" });
    const r = await helius(MINT);
    expect(r.data.uniqueBuyers).toBeUndefined();
    expect(r.data.nullReasons?.uniqueBuyers).toMatch(/Helius call failed: .*invalid param/);
    // The rest of the replay is still reported (only graduation-dependent uniqueBuyers is withheld).
    expect(r.data.makersCount).toBe(0);
  });

  it("a creator taken from the creation tx gets no DAS history: prior mints / rug rate null with the reason", async () => {
    vi.stubEnv("HELIUS_API_KEY", "k");
    const methods = heliusMock({ itemError: { code: -32000, message: "x" } });
    const r = await helius(MINT);
    expect(r.data.deployerAddress).toBe("CreatorWallet111");
    expect(r.data.creatorRugRatePct).toBeUndefined();
    expect(r.data.creatorPriorMints).toBeUndefined();
    expect(r.data.nullReasons?.creatorRugRatePct).toMatch(/DAS does not index pump\.fun mints/);
    expect(methods).not.toContain("getAssetsByCreator");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("H6 / L5 pump.fun feed, L3 Solana RPC", () => {
  const mcp = (byTool: Record<string, unknown | Error>) =>
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      const { id, params } = JSON.parse(String(init?.body));
      const v = byTool[params.name];
      if (v instanceof Error) return new Response("busy", { status: 503 });
      return json({ jsonrpc: "2.0", id, result: { structuredContent: v ?? {} } });
    });

  it("creator absent from top_wallets ⇒ dev-buy share null with the reason (not 0%)", async () => {
    mcp({ get_coin_intel: { found: true, observation_seconds: 90, first_seen_at: "2026-11-01T00:00:00Z", buy_volume_sol: 8, top_wallets: [{ wallet: "x", is_creator: false, buy_sol: 2, sell_sol: 0 }] } });
    const r = await pumpfeed(MINT);
    expect(r.data.devBuySharePct).toBeNull();
    expect(r.data.nullReasons?.devBuySharePct).toMatch(/creator not among three\.ws top_wallets/);
  });

  it("failed on-chain reads of the feed are partial with reasons", async () => {
    mcp({ get_coin_intel: { found: true, observation_seconds: 90, first_seen_at: "2026-11-01T00:00:00Z" }, get_token_details: new Error("503"), get_token_holders: new Error("503") });
    const r = await pumpfeed(MINT);
    expect(r.status.state).toBe("partial");
    expect(r.data.nullReasons?.mintAuthority).toMatch(/get_token_details failed/);
    expect(r.data.nullReasons?.holders).toMatch(/get_token_holders failed/);
  });

  it("an unreadable mint account makes Solana RPC partial, with the reason on the mint fields", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (body.params[0] === MINT) return new Response("bad gateway", { status: 502 });
      return json({ jsonrpc: "2.0", id: 1, result: { value: null } });
    });
    const r = await solanaCurve(MINT);
    expect(r.status.state).toBe("partial");
    expect(r.data.mintAuthority).toBeUndefined();
    expect(r.data.nullReasons?.mintAuthority).toMatch(/mint account read failed: HTTP 502/);
  });

});
