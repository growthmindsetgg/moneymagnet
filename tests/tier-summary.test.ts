import { afterEach, describe, expect, it } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { convictionOf, summarize } from "@/lib/summary";
import { eligibility, knownNonMeme } from "@/lib/memeFilter";
import { takeLiveSlot } from "@/lib/rateLimit";
import { MemoryKV, setKV } from "@/lib/kv";
import { perfectSnapshot } from "./helpers";

describe("conviction vs churn", () => {
  it("a token held by accumulators with net buying reads as conviction", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood"));
    const c = convictionOf(r);
    expect(c.label).toBe("conviction");
    expect(c.conviction.length).toBeGreaterThanOrEqual(2);
  });

  it("in-and-out wallets, early exits and net selling read as churn", () => {
    const r = scoreSnapshot(
      perfectSnapshot("robinhood", {
        accumulatorCount: 0,
        earlyRetentionPct: 10,
        earlyExitRatePct: 90,
        singleTradeWalletSharePct: 75,
        netFlowRatio24h: -0.3,
        buyerSellerRatio: 0.6,
        smartBuyers: 0,
        top10SharePct: 40,
      }),
    );
    const c = convictionOf(r);
    expect(c.label).toBe("churn");
    expect(c.churn.join(" ")).toMatch(/first buyers already exited/);
  });

  it("without enough evaluable signals it says so instead of guessing", () => {
    const r = scoreSnapshot({ ...perfectSnapshot("solana"), accumulatorCount: null, earlyRetentionPct: null, earlyExitRatePct: null, netFlowRatio24h: null, buyerSellerRatio: null, top10SharePct: null, smartBuyers: null, singleTradeWalletSharePct: null, tradesPerWallet: null, volLiqRatio: null, washFlag: null });
    expect(convictionOf(r).label).toBe("unknown");
  });
});

describe("short reasons", () => {
  it("returns at most five reasons, each taken from the report's evidence", () => {
    const s = summarize(scoreSnapshot(perfectSnapshot("robinhood")));
    expect(s.reasons.length).toBeGreaterThan(0);
    expect(s.reasons.length).toBeLessThanOrEqual(5);
    expect(s.tier).toBe("S");
    expect(s.url).toBe(`/t/robinhood/${s.address}`);
  });

  it("a honeypot leads with the forcing rule", () => {
    const s = summarize(scoreSnapshot(perfectSnapshot("robinhood", { sellable: false, honeypot: true })));
    expect(s.tier).toBe("F");
    expect(s.reasons[0]).toMatchObject({ kind: "risk" });
    expect(s.reasons[0].text).toMatch(/^Honeypot/);
  });

  // Replaced (§7e): U now requires failed sources; the reason names them.
  it("an unrated token explains which sources failed", () => {
    const empty = { ...perfectSnapshot("solana"), ...Object.fromEntries(Object.keys(perfectSnapshot("solana")).filter((k) => !["chain", "address", "name", "symbol", "holders", "swapHolders", "liquidityHolders", "poolAddresses", "staleFields", "patterns", "nullReasons", "provenance", "fakeSignals", "links", "zeroActivity"].includes(k)).map((k) => [k, null])) };
    const failed = ["rugcheck", "helius", "pumpfeed", "solana-rpc", "geckoterminal", "dexscreener"].map((id) => ({ id, label: id, state: "failed" as const, message: "HTTP 500" }));
    const s = summarize(scoreSnapshot(empty, failed));
    expect(s.tier).toBe("U");
    expect(s.reasons[0].text).toMatch(/sources failed: /);
  });

  it("flags rate-limited sources", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood"), [{ id: "geckoterminal", label: "GeckoTerminal", state: "failed", message: "HTTP 429: rate limit" }]);
    expect(summarize(r).rateLimited).toEqual(["geckoterminal"]);
  });
});

describe("meme-only filter", () => {
  it("refuses known non-meme Solana mints before fetching anything", () => {
    expect(knownNonMeme("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toMatchObject({ meme: false, reason: expect.stringMatching(/USDC/), rejected: expect.stringMatching(/HoodTier scores memecoins only$/) });
    expect(knownNonMeme("solana", "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump")).toBeNull();
  });

  it("refuses tokenized stocks, wrapped/bridged assets and stablecoins; keeps memes", () => {
    expect(eligibility(perfectSnapshot("robinhood", { assetKind: "stock", name: "NVIDIA • Robinhood Token" })).reason).toMatch(/classifies this token as a stock/);
    expect(eligibility(perfectSnapshot("robinhood", { assetKind: "meme", name: "Wrapped META Bridge" })).meme).toBe(false);
    expect(eligibility(perfectSnapshot("robinhood", { assetKind: "meme", name: "Coinbase Wrapped BTC" })).meme).toBe(false);
    expect(eligibility(perfectSnapshot("solana", { symbol: "USDT", name: "Some Token" })).meme).toBe(false);
    expect(eligibility(perfectSnapshot("robinhood", { assetKind: "meme", name: "microduck" })).meme).toBe(true);
    // HoodScan's "unknown" is not a verdict — the token is still rated (PANGEA came back as "unknown").
    expect(eligibility(perfectSnapshot("robinhood", { assetKind: "unknown", name: "Pangea" })).meme).toBe(true);
    expect(eligibility(perfectSnapshot("solana", { address: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", name: "Fartcoin", symbol: "Fartcoin" })).meme).toBe(true);
    expect(eligibility(perfectSnapshot("solana")).reason).toMatch(/wrapped SOL/); // the test helper's default mint is wSOL
  });

  it("a non-meme report has no tier in the summary", () => {
    const r = { ...scoreSnapshot(perfectSnapshot("robinhood")), eligibility: { meme: false, reason: "HoodScan classifies this token as a stock" } };
    const s = summarize(r);
    expect(s.tier).toBeNull();
    expect(s.meme).toBe(false);
    expect(s.reasons[0].text).toMatch(/^Not rated/);
  });
});

describe("rate awareness", () => {
  afterEach(() => setKV(null));

  it("allows N live analyses per client per minute, then answers with Retry-After", async () => {
    setKV(new MemoryKV());
    const now = Date.parse("2026-10-24T12:00:10Z");
    for (let i = 0; i < 3; i++) expect((await takeLiveSlot("1.2.3.4", 3, now)).ok).toBe(true);
    const denied = await takeLiveSlot("1.2.3.4", 3, now);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfter).toBe(50);
    expect((await takeLiveSlot("5.6.7.8", 3, now)).ok).toBe(true); // per client
    expect((await takeLiveSlot("1.2.3.4", 3, now + 60_000)).ok).toBe(true); // next window
  });
});

describe("conviction signals need real holders", () => {
  it("'supply is spread out' is not claimed when a curve or pool holds everything (few holders)", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { top10SharePct: 0, holderCount: 4 }));
    expect(convictionOf(r).conviction.join(" ")).not.toMatch(/spread out/);
  });
});
