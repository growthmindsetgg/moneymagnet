import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { archiveWalletHistory, classifyContract, CONTRACT_SIGNATURES, kSearch, matchSignature } from "@/lib/onchain/holderClass";
import { applyHolderClasses } from "@/lib/topHolders";
import { largestHolderLine } from "@/lib/holderLine";
import { classRow } from "@/lib/onchain/holderClass";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { emptySnapshot, deriveMetrics } from "@/lib/snapshot";
import { prosCons } from "@/components/prosCons";
import type { Rpc } from "@/lib/onchain/rpc";
import type { HolderRow, SourceStatus, TokenSnapshot } from "@/lib/types";

const sel = (sig: string) => bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
/** Fake runtime code whose dispatcher pushes these selectors (PUSH4 = 0x63). */
const codeWith = (sigs: string[]) => "0x6080604052" + sigs.map((s) => `63${sel(s)}`).join("5b") + "00".repeat(200);
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const addr = (c: string) => "0x" + c.repeat(40);

describe("top-holder classification: contract signatures", () => {
  it("matches every listed family from its own selectors, and nothing on unrelated code", () => {
    for (const s of CONTRACT_SIGNATURES) expect(matchSignature(codeWith(s.fns))?.label, s.id).toBe(s.label);
    expect(matchSignature(codeWith(["transfer(address,uint256)", "balanceOf(address)"]))).toBeNull();
    // A partial match is not a match (Hedgey needs both functions).
    expect(matchSignature(codeWith(["redeemPlans(uint256[])"]))).toBeNull();
  });

  it("a Safe answering getThreshold / getOwners is a counted treasury, labelled with its threshold", async () => {
    const rpc = (async (method: string, params: unknown[]) => {
      if (method !== "eth_call") return "0x" + word(0);
      const data = (params[0] as { data: string }).data;
      if (data.startsWith("0x" + sel("getThreshold()"))) return "0x" + word(2);
      if (data.startsWith("0x" + sel("getOwners()"))) return "0x" + word(32) + word(3) + word(1) + word(2) + word(3);
      return "0x";
    }) as Rpc;
    const v = await classifyContract(rpc, addr("5"), addr("7"), "0x" + "60".repeat(171));
    expect(v.class).toBe("treasury");
    expect(v.label).toBe("treasury (multisig, Safe 2/3)");
  });

  it("an OpenZeppelin VestingWallet is excluded vesting with its release schedule read from start() / duration()", async () => {
    const start = Date.parse("2026-03-01T00:00:00Z") / 1000;
    const duration = 365 * 86_400;
    const code = codeWith(CONTRACT_SIGNATURES.find((s) => s.id === "oz-vesting-wallet")!.fns);
    const rpc = (async (method: string, params: unknown[]) => {
      if (method === "eth_getStorageAt") return "0x" + word(0);
      if (method !== "eth_call") return "0x";
      const data = (params[0] as { data: string }).data;
      if (data.startsWith("0x" + sel("start()"))) return "0x" + word(start);
      if (data.startsWith("0x" + sel("duration()"))) return "0x" + word(duration);
      return "0x"; // getThreshold / getOwners: not a Safe
    }) as Rpc;
    const v = await classifyContract(rpc, addr("6"), addr("7"), code);
    expect(v.class).toBe("vesting");
    expect(v.label).toBe("vesting contract (OpenZeppelin VestingWallet)");
    expect(v.unlocksAt).toBe("2027-03-01T00:00:00.000Z");
    expect(v.detail).toBe("vests 2026-03 → 2027-03");
  });
});

describe("top-holder classification: the page line", () => {
  it("reads as specified", () => {
    expect(largestHolderLine(classRow({ address: addr("1"), pct: 61.0973, class: "founder", label: "founder wallet (deployer)", detail: "0 sells in 116d", unlocksAt: null, evidence: "" }))).toBe(
      "Largest holder: founder wallet (deployer), 61.1%, 0 sells in 116d",
    );
    expect(largestHolderLine(classRow({ address: addr("2"), pct: 61.1, class: "vesting", label: "vesting contract (Hedgey)", detail: "unlocks 2027-03", unlocksAt: "2027-03-01T00:00:00.000Z", evidence: "" }))).toBe(
      "Largest holder: vesting contract (Hedgey), 61.1%, unlocks 2027-03",
    );
    expect(largestHolderLine(null)).toBeNull();
  });
});

describe("top-holder classification: holder math", () => {
  const row = (a: string, pct: number, kind: HolderRow["kind"]): HolderRow => ({ address: a, qty: pct * 1e7, pct, buys: null, sells: null, isContract: kind === "liquidity", kind });

  it("vesting / lockers leave the count (shown apart, labelled), a Safe treasury joins it, and top-1 / top-10 are re-derived", () => {
    const s: TokenSnapshot = {
      ...emptySnapshot("base", addr("9")),
      holders: [row(addr("a"), 40, "wallet"), row(addr("b"), 3, "wallet")],
      liquidityHolders: [row(addr("c"), 50, "liquidity"), row(addr("d"), 5, "liquidity")],
      top1SharePct: 40,
      top10SharePct: 43,
    };
    applyHolderClasses(s, [
      classRow({ address: addr("a"), pct: 40, class: "vesting", label: "vesting contract (Sablier)", detail: null, unlocksAt: null, evidence: "" }),
      classRow({ address: addr("d"), pct: 5, class: "treasury", label: "treasury (multisig, Safe 3/5)", detail: null, unlocksAt: null, evidence: "" }),
      classRow({ address: addr("c"), pct: 50, class: "contract", label: "unclassified contract", detail: null, unlocksAt: null, evidence: "" }),
    ]);
    expect(s.holders.map((h) => [h.address, h.label ?? null])).toEqual([
      [addr("d"), "treasury (multisig, Safe 3/5)"],
      [addr("b"), null],
    ]);
    expect(s.top1SharePct).toBe(5);
    expect(s.top10SharePct).toBe(8);
    expect(s.liquidityHolders.map((h) => h.label)).toEqual(["unclassified contract", "vesting contract (Sablier)"]);
    expect(s.provenance.top1SharePct?.at(-1)?.source).toBe("holder-class");
  });
});

describe("founder softening (top-holder caps)", () => {
  function token(over: Partial<TokenSnapshot>): TokenSnapshot {
    return deriveMetrics({
      ...emptySnapshot("monad", addr("e")),
      tokenExists: true,
      ageHours: 2781,
      priceUsd: 0.0016,
      fdvUsd: 1_600_000,
      liquidityUsd: 82_000,
      mainPoolLiquidityUsd: 82_000,
      volume24hUsd: 300_000,
      poolCount: 1,
      totalSupply: 1e9,
      holderCount: 2400,
      top10SharePct: 64,
      deployerHoldingPct: 61,
      deployerSoldPct: 0,
      buyers24h: 90,
      sellers24h: 40,
      netFlowRatio24h: 0.1,
      tradesPerWallet: 2,
      sellable: true,
      honeypot: false,
      roundTripLossPct: 0.6,
      mintAuthority: false,
      verified: true,
      ownerRenounced: true,
      upgradeable: false,
      isLaunchpad: true,
      launchpad: "nad.fun V2",
      trendScore: 50,
      ...over,
    });
  }
  const fired = (s: TokenSnapshot) => scoreSnapshot(s, []).rules.filter((r) => r.state === "fired").map((r) => r.id);
  const capOf = (s: TokenSnapshot) => scoreSnapshot(s, []).binding;

  it("≥ 35% held by a founder that never sold in ≥ 30 days: capped at B (not D), with the key-person reason", () => {
    const s = token({ top1SharePct: 61.1, founderNeverSold: true, founderSold: false, founderHoldDays: 116 });
    const r = scoreSnapshot(s, []);
    expect(fired(s)).toContain("top_holder_35_founder");
    expect(fired(s)).not.toContain("top_holder_35");
    expect(fired(s)).not.toContain("top_holder_20");
    const rule = r.rules.find((x) => x.id === "top_holder_35_founder")!;
    expect(rule.capTier).toBe("B");
    expect(rule.evidence).toBe("Founder holds 61.1%, never sold in 116d — key-person risk: capped at B.");
    expect(["B", "C", "D", "F"]).toContain(r.tier);
    expect(["S", "A"]).not.toContain(r.tier);
  });

  it("20–35% held by such a founder: capped at A (not C)", () => {
    const s = token({ top1SharePct: 25, founderNeverSold: true, founderSold: false, founderHoldDays: 40 });
    expect(fired(s)).toContain("top_holder_20_founder");
    expect(fired(s)).not.toContain("top_holder_20");
    expect(scoreSnapshot(s, []).rules.find((x) => x.id === "top_holder_20_founder")!.capTier).toBe("A");
  });

  it("any founder sell reverts to the normal caps and adds the red 'founder started selling' con", () => {
    const s = token({ top1SharePct: 61.1, founderNeverSold: false, founderSold: true, founderHoldDays: 116 });
    const r = scoreSnapshot(s, []);
    expect(fired(s)).toEqual(expect.arrayContaining(["top_holder_35", "top_holder_20", "founder_selling"]));
    expect(capOf(s)?.text).toMatch(/Top holder ≥ 35% ⇒ D|⇒ [DF]/);
    expect(["D", "F"]).toContain(r.tier);
    const con = prosCons(r).cons.find((c) => /Founder started selling/.test(c.text));
    expect(con?.sev).toBe("bad");
  });

  it("not proven (null) or not the deployer (false): the normal caps apply", () => {
    for (const founderNeverSold of [null, false]) {
      const s = token({ top1SharePct: 61.1, founderNeverSold });
      expect(fired(s)).toEqual(expect.arrayContaining(["top_holder_35", "top_holder_20"]));
      expect(fired(s)).not.toContain("top_holder_35_founder");
    }
  });

  it("monotone: the founder caps never raise a tier above what the score alone gives", () => {
    const base = token({ top1SharePct: 61.1, founderNeverSold: true, founderHoldDays: 116 });
    const r = scoreSnapshot(base, []);
    const uncapped = scoreSnapshot({ ...base, top1SharePct: 1 }, []);
    const order = ["S", "A", "B", "C", "D", "F", "U"];
    expect(order.indexOf(r.tier)).toBeGreaterThanOrEqual(order.indexOf(uncapped.tier));
  });
});

describe("archive wallet history", () => {
  const T = addr("7");
  const W = addr("8");
  /** A chain where the wallet's balance changes at given blocks; nonce per block; outflows go to `dest`. */
  function chain(opts: { receiptAt: number; outAt?: number[]; nonceAt?: (b: number) => number; destCode?: string }) {
    const head = 1_000_000;
    const bal = (b: number) => {
      if (b < opts.receiptAt) return 0n;
      return 1000n - BigInt((opts.outAt ?? []).filter((x) => x <= b).length * 10);
    };
    const rpc = (async (method: string, params: unknown[]) => {
      const blk = (p: unknown) => (p === "latest" ? head : Number(p));
      if (method === "eth_getTransactionCount") return "0x" + (opts.nonceAt?.(blk(params[1])) ?? 5).toString(16);
      if (method === "eth_call") return "0x" + word(bal(blk(params[1])));
      if (method === "eth_getLogs") {
        const f = params[0] as { fromBlock: string; topics: (string | null)[] };
        const b = Number(f.fromBlock);
        const outgoing = f.topics.length === 2;
        if (outgoing && (opts.outAt ?? []).includes(b)) return [{ topics: ["0x", "0x" + "0".repeat(24) + W.slice(2), "0x" + "0".repeat(24) + addr("4").slice(2)], data: "0x" + word(10), blockNumber: f.fromBlock, transactionHash: "0x1", address: T, logIndex: "0x0" }];
        if (!outgoing && b === opts.receiptAt) return [{ topics: ["0x", "0x" + "0".repeat(24) + addr("3").slice(2), "0x" + "0".repeat(24) + W.slice(2)], data: "0x" + word(1000), blockNumber: f.fromBlock, transactionHash: "0x2", address: T, logIndex: "0x0" }];
        return [];
      }
      if (method === "eth_getCode") return opts.destCode ?? "0x";
      if (method === "eth_getTransactionReceipt") return { logs: [] };
      throw new Error(method);
    }) as Rpc;
    return { rpc, head };
  }

  it("unchanged nonce since the first receipt proves nothing left the wallet", async () => {
    const { rpc, head } = chain({ receiptAt: 123_456, nonceAt: () => 7 });
    const h = await archiveWalletHistory(rpc, T, W, { fromBlock: 100, head });
    expect(h.complete).toBe(true);
    expect(h.toPools).toBe(0);
    expect(h.firstReceipt).toEqual({ block: 123_456, from: addr("3") });
    expect(h.method).toMatch(/nonce unchanged/);
  });

  it("finds every outflow and splits pools / contracts from wallet transfers", async () => {
    const toContract = chain({ receiptAt: 5_000, outAt: [600_000], nonceAt: (b) => (b < 600_000 ? 1 : 2), destCode: "0x" + "60".repeat(500) });
    const a = await archiveWalletHistory(toContract.rpc, T, W, { fromBlock: 100, head: toContract.head, maxCalls: 400 });
    expect(a.complete).toBe(true);
    expect(a.toPools).toBe(1);
    const toWallet = chain({ receiptAt: 5_000, outAt: [300_000, 700_001], nonceAt: (b) => (b < 300_000 ? 1 : 3) });
    const b = await archiveWalletHistory(toWallet.rpc, T, W, { fromBlock: 100, head: toWallet.head, maxCalls: 400 });
    expect(b.toPools).toBe(0);
    expect(b.transfersOut).toBe(2);
  });

  it("an exhausted call budget is incomplete (never read as 'never sold')", async () => {
    const { rpc, head } = chain({ receiptAt: 5_000, outAt: [300_000, 400_000, 500_000], nonceAt: (b) => (b < 300_000 ? 1 : 4) });
    const h = await archiveWalletHistory(rpc, T, W, { fromBlock: 100, head, maxCalls: 60 });
    expect(h.complete).toBe(false);
    expect(h.reason).toBeTruthy();
  });

  it("kSearch finds the first true block", async () => {
    for (const target of [1, 2, 777, 123_456, 999_999]) expect(await kSearch(0, 1_000_000, async (b) => b >= target, 8, 20)).toBe(target);
  });
});

describe("JAMES (Monad) recorded holder fixture", () => {
  // tests/fixtures/holders/monad-james.json — scripts/top-holder-fixture.ts
  const fx = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "holders", "monad-james.json"), "utf8")) as { snapshot: TokenSnapshot; sources: SourceStatus[] };

  it("the 61.1% holder is an EOA funded by the creation-tx sender, not the deployer: normal caps, D", () => {
    const s = fx.snapshot;
    expect(s.largestHolder?.address).toBe("0xf8baf2541defab76f2c344ff10cd6d4ef74d3432");
    expect(s.largestHolder?.class).toBe("wallet");
    expect(s.largestHolder?.label).toBe("wallet funded by the deployer");
    expect(s.largestHolder?.evidence).toMatch(/no code \(EOA\); not the deployer/);
    expect(largestHolderLine(s.largestHolder)).toBe("Largest holder: wallet funded by the deployer, 61.1%");
    const r = scoreSnapshot(s, fx.sources);
    expect(r.tier).toBe("D");
    expect(r.rules.find((x) => x.id === "top_holder_35")!.state).toBe("fired");
    expect(r.rules.find((x) => x.id === "top_holder_35_founder")!.state).not.toBe("fired");
  });

  it("the two Safe 6/8 multisigs in its top 5 are counted (labelled); unclassified contracts stay excluded", () => {
    const s = fx.snapshot;
    const safes = s.holderClasses.filter((h) => h.class === "treasury");
    expect(safes.map((h) => h.label)).toEqual(["treasury (multisig, Safe 6/8)", "treasury (multisig, Safe 6/8)"]);
    for (const h of safes) expect(s.holders.some((w) => w.address === h.address)).toBe(true);
    for (const h of s.holderClasses.filter((x) => x.class === "contract")) expect(s.holders.some((w) => w.address === h.address)).toBe(false);
  });

  it("were that wallet the deployer with 0 sells over 116 days, the cap would be B with the key-person reason", () => {
    const s: TokenSnapshot = { ...fx.snapshot, founderNeverSold: true, founderSold: false, founderHoldDays: 116 };
    const r = scoreSnapshot(s, fx.sources);
    expect(r.rules.find((x) => x.id === "top_holder_35_founder")!.state).toBe("fired");
    expect(r.rules.find((x) => x.id === "top_holder_35")!.state).not.toBe("fired");
    expect(r.rules.find((x) => x.id === "top_holder_35_founder")!.evidence).toBe("Founder holds 61.1%, never sold in 116d — key-person risk: capped at B.");
    expect(["B", "C", "D"]).toContain(r.tier);
  });
});
