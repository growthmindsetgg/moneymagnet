import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_CHAINS, CHAIN_ID, CHAIN_LABEL, detectChain, EVM_CHAINS, isEvmChain, type EvmChain } from "@/lib/chain";
import { resolveEvmChain } from "@/lib/resolveChain";
import type { Rpc } from "@/lib/onchain/rpc";
import { archiveUrls, chainLogSpan, endpointList } from "@/lib/onchain/rpc";
import { chainCexLabel, chainInfraEntry, chainLaunchpadOf } from "@/lib/onchain/chainInfra";
import { defaultConfig, setFor } from "@/lib/scoring/config";
import { scoreSnapshot, SOURCE_CHAINS } from "@/lib/scoring/engine";
import { emptySnapshot, deriveMetrics } from "@/lib/snapshot";
import { knownNonMeme, eligibility } from "@/lib/memeFilter";
import { etherscan } from "@/lib/sources/ethereum";
import { basescan } from "@/lib/sources/base";
import { goplus } from "@/lib/sources/goplus";
import { evmSim } from "@/lib/sources/evmSim";
import type { SourceStatus, TokenSnapshot } from "@/lib/types";
import rpcFile from "@/data/ethereum-rpc-endpoints.json";

// Ethereum mainnet (chain id 1), the fifth chain (docs/chains/ethereum.md).

const A = "0x" + "cd".repeat(20);
const SUPPLY = "0x" + "0".repeat(60) + "f4240";

function fakeRpc(states: Partial<Record<EvmChain, "token" | "contract" | "none" | "down" | "hang">>) {
  return (c: EvmChain): Rpc =>
    (async (method: string) => {
      const s = states[c] ?? "none";
      if (s === "down") throw new Error("RPC HTTP 503");
      if (s === "hang") return new Promise(() => undefined);
      if (method === "eth_getCode") return s === "none" ? "0x" : "0x6080604052";
      if (method === "eth_call") {
        if (s === "token") return SUPPLY;
        throw new Error("execution reverted");
      }
      throw new Error(`unexpected ${method}`);
    }) as Rpc;
}
const pair = (chainId: string, fdv: number, liq = 10_000) => ({ chainId, baseToken: { address: A }, fdv, liquidity: { usd: liq } });

/** An Ethereum token whose every metric the Ethereum sources fill is clean (no launchpad: Ethereum registers none). */
function clean(ageHours: number, over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return deriveMetrics({
    ...emptySnapshot("ethereum", "0x" + "e".repeat(40)),
    name: "Clean",
    // A clean bundle check (wallet-cluster meter, 2026-11-24).
    walletClusterState: "live", walletClusterPending: false, walletClusterMeter: 5, clusterSupplyMinPct: 0, clusterSupplyText: "0.0%", founderClusterOnly: null, clusterResolvedWallets: 30, clusterSampleWallets: 30, clusterLargestText: "no linked group among 30 resolved wallets", clusterSameTimeText: "no two wallets funded by one source within 30s",
    symbol: "CLN",
    tokenExists: true,
    ageHours,
    priceUsd: 0.001,
    fdvUsd: 20_000_000,
    liquidityUsd: 3_000_000,
    mainPoolLiquidityUsd: 2_500_000,
    volume24hUsd: 30_000_000,
    poolCount: 2,
    liqChange24hPct: 2,
    liqChange7dPct: 5,
    totalSupply: 1e9,
    holderCount: 40_000,
    top1SharePct: 2,
    top10SharePct: 12,
    deployerHoldingPct: 0.5,
    makersCount: 8000,
    buyers24h: 6000,
    sellers24h: 4000,
    sells24h: 9000,
    uniqueBuyers: 6000,
    tradesPerWallet: 2.5,
    sellable: true,
    honeypot: false,
    roundTripLossPct: 1,
    mintAuthority: false,
    verified: true,
    ownerRenounced: true,
    upgradeable: false,
    lpLockedPct: 100,
    launchRetraced30: true,
    identicalCandleSharePct: 5,
    staircase: false,
    trendScore: 80,
    brokeHigherLow: false,
    upOnlyChart: false,
    ...over,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Ethereum: chain detection", () => {
  it("is an EVM chain with id 1; an 'ethereum' hint picks it; no hint stays Robinhood Chain", () => {
    expect(EVM_CHAINS).toContain("ethereum");
    expect(ALL_CHAINS).toContain("ethereum");
    expect(isEvmChain("ethereum")).toBe(true);
    expect(CHAIN_ID.ethereum).toBe(1);
    expect(CHAIN_LABEL.ethereum).toBe("Ethereum");
    expect(detectChain(A, "ethereum")).toBe("ethereum");
    expect(detectChain(A)).toBe("robinhood");
  });

  it("a bridged / CREATE2 token on Ethereum and Base ⇒ both are candidates, the real market (higher FDV) first", async () => {
    const res = await resolveEvmChain(A, { rpc: fakeRpc({ base: "token", ethereum: "token" }), fetchPairs: async () => [pair("base", 300_000), pair("ethereum", 90_000_000), pair("ethereum", 5_000)] });
    expect(res.candidates.map((c) => c.chain)).toEqual(["ethereum", "base"]);
    expect(res.candidates[0]).toMatchObject({ chain: "ethereum", fdvUsd: 90_000_000, pairs: 2 });
    expect(res.checks.ethereum).toBe("ERC-20 contract · 2 DexScreener pairs");
  });

  it("an Ethereum-only token resolves to Ethereum alone (no picker)", async () => {
    const res = await resolveEvmChain(A, { rpc: fakeRpc({ ethereum: "token" }), fetchPairs: async () => [pair("ethereum", 1_000_000)] });
    expect(res.candidates.map((c) => c.chain)).toEqual(["ethereum"]);
  });

  it("a hanging Ethereum RPC does not hold up the other chains: it is reported unreachable within its own deadline", async () => {
    const t0 = Date.now();
    const res = await resolveEvmChain(A, { rpc: fakeRpc({ base: "token", ethereum: "hang" }), fetchPairs: async () => [pair("base", 1_000_000)], chainTimeoutMs: 150 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.candidates.map((c) => c.chain)).toEqual(["base"]);
    expect(res.checks.ethereum).toBe("RPC unreachable");
  });
});

describe("Ethereum: RPC endpoints and infrastructure registry", () => {
  it("only probed keyless endpoints; logs / archive routing comes from the probe", () => {
    const list = endpointList("ethereum");
    expect(list.length).toBeGreaterThanOrEqual(5);
    for (const e of list) expect(e.url, e.url).toMatch(/^https:\/\//);
    expect(list.some((e) => e.logs === true)).toBe(true);
    expect(chainLogSpan("ethereum")).toBe(Math.max(...(rpcFile.endpoints as { logs: boolean; logsMaxSpan: number | null }[]).filter((e) => e.logs).map((e) => e.logsMaxSpan ?? 0)));
    expect(archiveUrls("ethereum").length).toBeGreaterThan(0);
    // Base keeps its own (unchanged) span.
    expect(chainLogSpan("base")).toBe(50_000);
  });

  it("registers the Uniswap v2/v3/v4 contracts and quote tokens; no launchpad; CEX wallets are labels, not infrastructure", () => {
    expect(chainInfraEntry("ethereum", "0x000000000004444c5dc75cb358380d2e3de08a90")?.role).toBe("v4-pool-manager");
    expect(chainInfraEntry("ethereum", "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e")?.role).toBe("liquidity-manager");
    expect(chainInfraEntry("ethereum", "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203")?.role).toBe("quoter");
    expect(chainInfraEntry("ethereum", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")).toMatchObject({ role: "quote-token", label: "WETH" });
    expect(chainLaunchpadOf("ethereum", "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f")).toBeNull();
    expect(chainInfraEntry("ethereum", "0xf977814e90da44bfa03b6295a0616a897441acec")).toBeUndefined();
    expect(chainCexLabel("ethereum", "0xF977814e90dA44bFA03b6295A0616a897441aceC")).toMatch(/Binance/);
    expect(chainCexLabel("base", "0xf977814e90da44bfa03b6295a0616a897441acec")).toBeUndefined();
  });
});

describe("Ethereum: factor sets", () => {
  const SETS = ["launch_ethereum", "established_ethereum"] as const;

  it("age selects the set (< 72h launch, ≥ 72h established); each totals 100 with gate-only basics", () => {
    expect(setFor(defaultConfig, "launch", "ethereum")).toBe(defaultConfig.sets.launch_ethereum);
    expect(setFor(defaultConfig, "established", "ethereum")).toBe(defaultConfig.sets.established_ethereum);
    for (const name of SETS) {
      const set = defaultConfig.sets[name];
      expect(set.groups.reduce((a, g) => a + g.weight, 0), name).toBe(100);
      const safety = set.groups.find((g) => g.id === "safety")!;
      expect(safety.weight).toBe(0);
      expect(safety.factors.every((f) => f.weight === 0 && f.gateOnly)).toBe(true);
    }
    expect(scoreSnapshot(clean(10)).mode).toBe("launch");
    expect(scoreSnapshot(clean(71.9)).mode).toBe("launch");
    expect(scoreSnapshot(clean(72)).mode).toBe("established");
    expect(scoreSnapshot(clean(10)).modeLabel).toMatch(/Ethereum/);
  });

  it("built only from Ethereum sources, with no launchpad factor (no Ethereum launchpad is registered)", () => {
    for (const name of SETS) {
      for (const f of defaultConfig.sets[name].groups.flatMap((g) => g.factors)) {
        expect(f.data.length, `${name}/${f.id}`).toBeGreaterThan(0);
        expect(f.data.some((d) => (SOURCE_CHAINS[d] ?? []).includes("ethereum")), `${name}/${f.id} ${f.data}`).toBe(true);
        expect(f.data.some((d) => /base|monad|nadfun/.test(d)), `${name}/${f.id}`).toBe(false);
        expect(f.id).not.toBe("launchpad");
      }
    }
    const r = scoreSnapshot(clean(500));
    expect(r.groups.flatMap((g) => g.factors).every((f) => !/not used on this chain/.test(f.nullReason ?? ""))).toBe(true);
  });

  it("a clean token scores A in both modes; S stays out of reach without swap-index accumulators", () => {
    for (const age of [10, 500]) {
      const r = scoreSnapshot(clean(age));
      expect(r.coveragePct, `${age}h`).toBeGreaterThanOrEqual(80);
      expect(["A", "S"], `${age}h: ${r.tier} ${r.tierReason}`).toContain(r.tier);
    }
  });

  it("age never penalises: an older Established token scores at least as high; the track-record bonus is ≤ 3", () => {
    const young = scoreSnapshot(clean(100));
    const old = scoreSnapshot(clean(2_000));
    expect(old.score!).toBeGreaterThanOrEqual(young.score!);
    const bonus = defaultConfig.rules.filter((r) => r.id.startsWith("track_record"));
    for (const b of bonus) expect(Math.abs(b.points ?? 0)).toBeLessThanOrEqual(3);
    expect(old.rules.find((r) => r.id === "track_record_30d")!.state).toBe("fired");
  });

  it("the EVM rules apply on Ethereum: owner cap, owner-mint F, proxy cap, liquidity pulled F, too early U", () => {
    expect(scoreSnapshot(clean(500, { ownerRenounced: false })).rules.find((r) => r.id === "owner_not_renounced")!.state).toBe("fired");
    const mint = scoreSnapshot(clean(500, { mintAuthority: true, ownerRenounced: false }));
    expect(mint.tier).toBe("F");
    expect(scoreSnapshot(clean(500, { upgradeable: true })).rules.find((r) => r.id === "upgradeable_proxy")!.state).toBe("fired");
    const rug = scoreSnapshot(clean(30, { liquidityPulled: true }));
    expect(rug.tier).toBe("F");
    expect(scoreSnapshot(clean(3 / 60, { uniqueBuyers: 4, ageMinutes: 3 })).tier).toBe("U");
  });

  it("measured unlocked LP with no launchpad proof is capped at D (Ethereum never proves a launchpad)", () => {
    const r = scoreSnapshot(clean(10, { lpLockedPct: 0 }));
    expect(r.rules.find((x) => x.id === "lp_unlocked_unproven")!.state).toBe("fired");
    expect(["D", "F"]).toContain(r.tier);
  });

  it("without ETHERSCAN_API_KEY the explorer fields are null with that reason, never defaulted", async () => {
    vi.stubEnv("ETHERSCAN_API_KEY", "");
    vi.stubEnv("BASESCAN_API_KEY", "");
    const res = await etherscan(A);
    expect(res.status.state).toBe("skipped");
    expect(res.status.message).toMatch(/ETHERSCAN_API_KEY not set/);
    expect(res.data).toEqual({});
    // GoPlus did not answer either: `verified` (GoPlus / Etherscan) is null and says why, naming the key.
    const sources: SourceStatus[] = [
      { id: "goplus", label: "GoPlus", state: "failed", message: "GoPlus code 4029: too many requests" },
      res.status,
    ];
    const r = scoreSnapshot(clean(500, { verified: null }), sources);
    const verified = r.groups.flatMap((g) => g.factors).find((f) => f.id === "verified")!;
    expect(verified.status).toBe("null");
    expect(verified.nullReason).toMatch(/ETHERSCAN_API_KEY not set/);
  });
});

describe("Ethereum: Etherscan v2 (one key, chainid=1)", () => {
  const ok = (url: string) => {
    if (/getcontractcreation/.test(url)) return { status: "1", message: "OK", result: [{ contractCreator: "0xABCDEF0000000000000000000000000000000001", timestamp: "1681234567" }] };
    return { status: "1", message: "OK", result: [{ SourceCode: "contract X {}" }] };
  };

  it("reads creator, creation time and verified source from chainid=1", async () => {
    vi.stubEnv("ETHERSCAN_API_KEY", "k-eth");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(ok(url)), { status: 200 });
    });
    const res = await etherscan(A);
    expect(res.status).toMatchObject({ id: "etherscan", state: "ok" });
    expect(res.data).toMatchObject({ deployerAddress: "0xabcdef0000000000000000000000000000000001", createdAt: new Date(1681234567 * 1000).toISOString(), verified: true });
    expect(urls.every((u) => u.includes("chainid=1&") && u.includes("apikey=k-eth"))).toBe(true);
  });

  it("falls back to BASESCAN_API_KEY (an Etherscan v2 key serves every chain); Base keeps BASESCAN_API_KEY first", async () => {
    vi.stubEnv("ETHERSCAN_API_KEY", "");
    vi.stubEnv("BASESCAN_API_KEY", "k-base");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(ok(url)), { status: 200 });
    });
    expect((await etherscan(A)).status.state).toBe("ok");
    expect(urls.every((u) => u.includes("chainid=1&") && u.includes("apikey=k-base"))).toBe(true);
    urls.length = 0;
    vi.stubEnv("ETHERSCAN_API_KEY", "k-eth");
    expect((await basescan(A)).status.id).toBe("basescan");
    expect(urls.every((u) => u.includes("chainid=8453&") && u.includes("apikey=k-base"))).toBe(true);
  });
});

describe("Ethereum: GoPlus (chain id 1)", () => {
  const record = (holders: { address: string; percent: string; is_contract?: number }[]) => ({
    code: 1,
    message: "OK",
    result: {
      [A]: {
        token_symbol: "TKN",
        holder_count: "99",
        is_honeypot: "0",
        is_mintable: "0",
        is_open_source: "1",
        holders: holders.map((h) => ({ balance: "1", is_locked: 0, is_contract: 0, ...h })),
      },
    },
  });

  it("queries chain id 1 and labels registered exchange wallets (still counted as holders)", async () => {
    let asked = "";
    vi.stubGlobal("fetch", async (url: string) => {
      asked = url;
      return new Response(JSON.stringify(record([{ address: "0xf977814e90da44bfa03b6295a0616a897441acec", percent: "0.12" }, { address: "0x" + "1".repeat(40), percent: "0.05" }])), { status: 200 });
    });
    const res = await goplus("ethereum", A);
    expect(asked).toContain("/token_security/1?");
    expect(res.data.holders![0].label).toMatch(/Binance 8/);
    expect(res.data.top1SharePct).toBe(12);
  });

  it("an impossible holder list (shares sum > 100%) is not scored: concentration is null with the reason", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(record([{ address: "0x" + "2".repeat(40), percent: "1.0" }, { address: "0x" + "3".repeat(40), percent: "0.10" }, { address: "0x" + "4".repeat(40), percent: "0.10" }])), { status: 200 }));
    const res = await goplus("ethereum", A);
    expect(res.data.top1SharePct).toBeUndefined();
    expect(res.data.top10SharePct).toBeUndefined();
    expect(res.data.nullReasons?.top1SharePct).toMatch(/inconsistent.*120% of supply/);
  });
});

describe("Ethereum: sell simulation", () => {
  it("simulates a native-ETH v4 pool (currency0 = 0x0 is ETH, not an unknown pool)", async () => {
    const token = "0x7bcefbb4ea938f71e4352057d9bf6cb2122d47b9";
    const id = "0x2ff864f45f2b7d6eee8a0822401e3615c6bb70a7d4a7021d88529da55634117c";
    const word = (v: bigint | string) => (typeof v === "string" ? v.replace(/^0x/, "").padStart(64, "0") : v.toString(16).padStart(64, "0"));
    const key = "0x" + word(0n) + word(token) + word(0n) + word(1n) + word(0n);
    const quoter = "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203";
    let quotes = 0;
    const rpc = (async (method: string, params: unknown[]) => {
      const [{ to, data }] = params as [{ to: string; data: string }];
      if (method !== "eth_call") throw new Error(method);
      if (to === quoter) {
        quotes++;
        // Buy 0.01 ETH ⇒ 5e18 tokens; selling them back ⇒ 0.0099 ETH (1% round trip).
        return "0x" + word(quotes === 1 ? 5n * 10n ** 18n : 99n * 10n ** 14n) + word(0n);
      }
      if (data.startsWith("0x70a08231")) return "0x" + word(0n);
      return key;
    }) as Rpc;
    const res = await evmSim({ chain: "ethereum", token, pools: [{ id, liquidityUsd: 16_000, kind: "v4" }], holders: [], supplyRaw: null, rpc });
    expect(res.status.id).toBe("ethereum-sim");
    expect(res.data.sellable).toBe(true);
    expect(res.data.roundTripLossPct).toBe(1);
  });
});

describe("Ethereum: meme filter", () => {
  it("refuses registered quote tokens and blue chips before fetching", () => {
    expect(knownNonMeme("ethereum", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")?.rejected).toMatch(/wrapped/);
    expect(knownNonMeme("ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")?.rejected).toMatch(/^stablecoin/);
    expect(knownNonMeme("ethereum", "0x514910771af9ca656af840dff83e8264ecf986ca")?.rejected).toMatch(/^blue chip/);
    expect(knownNonMeme("ethereum", "0x6982508145454ce325ddbe47a25d4ec3d2311933")).toBeNull();
  });

  it("a > $1B Ethereum meme without a launchpad is still scored (Ethereum memes have no launchpad origin; blue chips are registered)", () => {
    const pepe = clean(20_000, { address: "0x6982508145454ce325ddbe47a25d4ec3d2311933", symbol: "PEPE", name: "Pepe", fdvUsd: 1_570_000_000 });
    expect(eligibility(pepe).meme).toBe(true);
  });
});
