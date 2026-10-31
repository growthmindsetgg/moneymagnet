import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { MemoryKV, setKV } from "@/lib/kv";
import {
  sizeBand,
  socialQuality,
  socialStage,
  socialTimeMachine,
  socialVerdict,
  stageBadge,
  stageEditDistance,
  stagesByAge,
  type SocialArchetype,
  type SocialSample,
} from "@/lib/social/stage";
import { parseMentions, parseReportSocial, robinx, type RobinxSocial } from "@/lib/social/robinx";
import { addressOf, authorizationDigest, fetchX402, paymentHeader } from "@/lib/social/x402";
import { collectSocial } from "@/lib/social";
import { KvSeries } from "@/lib/social/series";
import { resampleSocial } from "@/lib/social/cron";
import type { OfficialLinks } from "@/lib/social/links";

const H = 3_600_000;
const NOW = Date.parse("2026-10-29T12:00:00Z");

/** A series of posts/24h values, one sample every `stepH` hours, ending at NOW. */
function series(values: number[], stepH = 1, field: "posts24h" | "uniquePosters24h" = "uniquePosters24h"): SocialSample[] {
  return values.map((v, i) => ({
    ts: new Date(NOW - (values.length - 1 - i) * stepH * H).toISOString(),
    posts24h: field === "posts24h" ? v : v * 2,
    uniquePosters24h: field === "uniquePosters24h" ? v : null,
    reach24h: null,
    sentiment: null,
    botShare: null,
    source: "test",
  }));
}
const flat = (v: number, n: number) => Array(n).fill(v);

describe("social stage rules on synthetic series", () => {
  it("Stage 0 — silent: M < 5 and never ≥ 5", () => {
    const st = socialStage(series([1, 2, 3, 2, 1, 3, 4, 2]), 100, NOW)!;
    expect(st.stage).toBe(0);
  });

  it("Stage 1 — starting: 5 ≤ M < 50 and rising over 6h", () => {
    const st = socialStage(series([5, 6, 8, 10, 12, 15, 18, 22, 26, 30]), 30, NOW)!;
    expect(st.stage).toBe(1);
    expect(st.slope6!).toBeGreaterThan(0);
  });

  it("Stage 1 — starting: a series shorter than 6h counts even without a 6h slope", () => {
    const st = socialStage(series([8, 9, 10, 9]), 3, NOW)!;
    expect(st.stage).toBe(1);
    expect(st.rule).toMatch(/shorter than 6h/);
  });

  it("Stage 2 — accelerating: M ≥ 50 and slope6 ≥ +25%", () => {
    const st = socialStage(series([20, 25, 30, 40, 50, 60, 75, 90, 110, 130]), 30, NOW)!;
    expect(st.stage).toBe(2);
    expect(st.slope6!).toBeGreaterThanOrEqual(0.25);
  });

  it("Stage 3 — plateau held ≥ 12h; shorter is '3 (early)'", () => {
    const long = socialStage(series([...flat(300, 20)]), 100, NOW)!;
    expect(long.stage).toBe(3);
    expect(long.early3).toBe(false);
    expect(long.heldHours!).toBeGreaterThanOrEqual(12);
    const short = socialStage(series([40, 60, 100, 150, 200, 240, 280, 300, 300, 300, 300, 300, 300, 300, 300, 300]), 100, NOW)!;
    expect(short.stage).toBe(3);
    expect(short.early3).toBe(true);
    expect(stageBadge(short, "S3", 72)).toMatch(/^Stage 3 \(early\) · S3 · quality 72/);
  });

  it("Stage 4 — fading: M ≤ 0.6 × peak and slope24 ≤ −30%", () => {
    const st = socialStage(series([...flat(400, 10), 380, 340, 300, 260, 230, 200, 180, 160, 150, 140, 130, 120, 110, 100, 100, 100, 100, 100, 100, 100], 1.5), 200, NOW)!;
    expect(st.stage).toBe(4);
    expect(st.slope24!).toBeLessThanOrEqual(-0.3);
  });

  it("Stage 5 — gone: M < 5 after once ≥ 50", () => {
    const st = socialStage(series([60, 80, 100, 60, 30, 10, 3, 2, 1]), 200, NOW)!;
    expect(st.stage).toBe(5);
    expect(st.rule).toBe("M < 5 after once ≥ 50");
  });

  it("Stage 5 — gone: M < 0.15 × peak for ≥ 48h", () => {
    const st = socialStage(series([...flat(200, 5), ...flat(20, 60)], 1), 300, NOW)!;
    expect(st.stage).toBe(5);
    expect(st.rule).toBe("M < 0.15 × peak for ≥ 48h");
  });

  it("age-aware: a token < 2h old with M ≥ 50 on a plateau is Stage 2, not 3", () => {
    const shape = series(flat(120, 8), 0.2);
    expect(socialStage(shape, 1.5, NOW)!.stage).toBe(2);
    expect(socialStage(shape, 30, NOW)!.stage).toBe(3);
  });

  it("early read: fewer than 3 samples is tagged", () => {
    const st = socialStage(series([10, 12]), 1, NOW)!;
    expect(st.earlyRead).toBe(true);
    expect(st.samples).toBe(2);
    expect(socialStage(series([10, 12, 14]), 1, NOW)!.earlyRead).toBe(false);
  });

  it("M falls back to posts/24h when posters are unknown; smoothing uses the last 3 samples", () => {
    const st = socialStage(series([10, 20, 30], 1, "posts24h"), 10, NOW)!;
    expect(st.metric).toBe("posts24h");
    expect(st.mNow).toBe(20);
  });

  it("no counts at all ⇒ no stage (null, never a guess)", () => {
    expect(socialStage([{ ts: new Date(NOW).toISOString(), posts24h: null, uniquePosters24h: null, reach24h: null, sentiment: null, botShare: null, source: "x" }], 1, NOW)).toBeNull();
  });
});

describe("size bands, quality, verdicts", () => {
  it("S1 < 50 · S2 50–300 · S3 300–2,000 · S4 > 2,000", () => {
    expect([0, 49, 50, 300, 301, 2000, 2001].map(sizeBand)).toEqual(["S1", "S1", "S2", "S2", "S3", "S3", "S4"]);
  });

  it("quality parts: each part, renormalized over parts with data", () => {
    const all = socialQuality({ credibleShare: 0.5, botShare: 0.1, sentiment: { posPct: 70, negPct: 10 }, xCommunity: true, postsBeforeLaunch: false, callChannelPattern: false, boosted: false });
    expect(all.score).toBe(98);
    const shill = socialQuality({ credibleShare: 0.5, botShare: 0, sentiment: { posPct: 100, negPct: 0 }, xCommunity: true, postsBeforeLaunch: false, callChannelPattern: false, boosted: false });
    expect(shill.score).toBe(90);
    const bad = socialQuality({ credibleShare: 0, botShare: 1, sentiment: null, xCommunity: false, postsBeforeLaunch: true, callChannelPattern: true, boosted: true });
    expect(bad.score).toBe(0);
    const two = socialQuality({ credibleShare: 1, botShare: null, sentiment: null, xCommunity: null, postsBeforeLaunch: true, callChannelPattern: null, boosted: null }, { botShare: "no bot data" });
    expect(two.score).toBe(63);
    expect(two.parts.find((p) => p.id === "botShare")!.reason).toBe("no bot data");
    const one = socialQuality({ credibleShare: 1, botShare: null, sentiment: null, xCommunity: null, postsBeforeLaunch: null, callChannelPattern: null, boosted: null });
    expect(one.score).toBeNull();
    // Links and boosts alone are not a quality score.
    const linksOnly = socialQuality({ credibleShare: null, botShare: null, sentiment: null, xCommunity: false, postsBeforeLaunch: null, callChannelPattern: null, boosted: false });
    expect(linksOnly.score).toBeNull();
  });

  it("verdicts are ≤ 14 words; Stage 3 at S1 says nobody new is arriving", () => {
    const plateau = socialStage(series(flat(30, 20)), 100, NOW)!;
    expect(plateau.stage).toBe(3);
    expect(socialVerdict(plateau, "S1", 80)).toBe("Plateau, but tiny — nobody new is arriving");
    expect(stageBadge(plateau, "S1", 80)).toMatch(/plateau, but tiny — nobody new is arriving$/);
    const acc = socialStage(series([20, 25, 30, 40, 50, 60, 75, 90, 110, 130]), 30, NOW)!;
    expect(socialVerdict(acc, "S2", 75)).toBe("Accelerating, small, mostly real accounts");
    for (const v of [socialVerdict(plateau, "S1", 80), socialVerdict(acc, "S4", 10)]) expect(v.split(/\s+/).length).toBeLessThanOrEqual(14);
  });
});

describe("Time Machine stage sequences", () => {
  it("edit distance over stages", () => {
    expect(stageEditDistance([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(stageEditDistance([1, 2, 3], [1, 5])).toBe(2);
    expect(stageEditDistance([1, null, 3], [1, 3])).toBe(0);
  });

  it("no archetype with social history ⇒ null with the reason (never estimated)", () => {
    const r = socialTimeMachine({ 1: { stage: 1, size: "S1" } }, [{ name: "X", kind: "winner", stages: {} }], 1);
    expect(r.line).toBeNull();
    expect(r.reason).toMatch(/no archetype in the library has social history/);
  });

  it("winners vs rugs at the token's age, and the nearest archetype", () => {
    const lib: SocialArchetype[] = [
      { name: "WIN1", kind: "winner", stages: { 1: { stage: 1, size: "S1" }, 6: { stage: 2, size: "S2" }, 24: { stage: 2, size: "S2" } } },
      { name: "WIN2", kind: "winner", stages: { 1: { stage: 1, size: "S1" }, 6: { stage: 2, size: "S2" }, 24: { stage: 3, size: "S3" } } },
      { name: "RUG1", kind: "rug", stages: { 1: { stage: 1, size: "S1" }, 6: { stage: 5, size: "S1" }, 24: { stage: 5, size: "S1" } } },
    ];
    const r = socialTimeMachine({ 1: { stage: 1, size: "S1" }, 6: { stage: 2, size: "S2" }, 24: { stage: 2, size: "S2" } }, lib, 30);
    expect(r.line).toBe("At 24h, winners were typically Stage 2–3 at S2+; rugs were Stage 1 then 5.");
    expect(r.nearest).toEqual({ name: "WIN1", kind: "winner", distance: 0 });
  });

  it("stagesByAge reads the series at each age edge, null where there is no sample", () => {
    const launched = new Date(NOW - 30 * H).toISOString();
    const s = series([10, 12, 14, 30, 60, 90, 130, 170], 4);
    const st = stagesByAge(s, launched);
    expect(st[1]).toBeNull();
    expect(st[24]).not.toBeNull();
    expect(st[72]).toBeNull();
  });
});

const report = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "robinx-report-microduck.json"), "utf8")) as { body: unknown };

describe("RobinX adapter", () => {
  beforeEach(() => setKV(new MemoryKV()));

  it("parses the recorded free report: 24h mentions, first mention, earliest callers with followers", () => {
    const r = parseReportSocial(report.body);
    expect(r.mentions24h).toBe(35);
    expect(r.firstMention?.account).toBe("biggalordTE");
    expect(r.posters.length).toBe(10);
    expect(r.posters.find((p) => p.account === "OrdzWorld")?.coordinated).toBe(true);
  });

  it("without a wallet or key: free report only, $0 spent, the paid fields null with the reason", async () => {
    delete process.env.ROBINX_WALLET_KEY;
    delete process.env.ROBINX_API_KEY;
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(report.body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const rx = await robinx("0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725", { fetchImpl: f, now: NOW });
    expect(calls).toEqual(["https://api.robinx.io/report/0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725?tier=free"]);
    expect(rx.spentUsd).toBe(0);
    expect(rx.mentions24h).toBe(35);
    expect(rx.uniquePosters24h).toBeNull();
    expect(rx.nullReasons.uniquePosters24h).toMatch(/ROBINX_WALLET_KEY not set/);
    expect(rx.nullReasons.tg).toMatch(/ROBINX_WALLET_KEY not set/);
  });

  it("with a wallet: never pays above the $0.05 cap per analysis", async () => {
    process.env.ROBINX_WALLET_KEY = "0x" + "11".repeat(32);
    let paidCalls = 0;
    const f = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("tier=free")) return new Response("{}", { status: 429 });
      const hdr = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"];
      const price = u.includes("/report/") ? "50000" : u.includes("/mentions/") ? "20000" : "30000";
      if (!hdr) return new Response(JSON.stringify({ accepts: [{ scheme: "exact", network: "eip155:8453", amount: price, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xA13d363AeCCCF878Ec64f6eB687Eb4A771FB0599", extra: { name: "USD Coin", version: "2" } }] }), { status: 402 });
      paidCalls++;
      return new Response(JSON.stringify(u.includes("/report/") ? report.body : { data: { mentions: [] } }), { status: 200 });
    }) as typeof fetch;
    const rx = await robinx("0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725", { fetchImpl: f, now: NOW });
    expect(rx.spentUsd).toBeLessThanOrEqual(0.05);
    expect(rx.spentUsd).toBe(0.05);
    expect(paidCalls).toBe(1);
    expect(rx.nullReasons.uniquePosters24h).toMatch(/exceeds the remaining cap/);
    delete process.env.ROBINX_WALLET_KEY;
  });

  it("cron mode: the free report only, or just the $0.02 mention tape when it fails — never the report or Telegram call", async () => {
    process.env.ROBINX_WALLET_KEY = "0x" + "11".repeat(32);
    const urls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("tier=free")) return new Response("{}", { status: 429 });
      if (!(init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"])
        return new Response(JSON.stringify({ accepts: [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xA13d363AeCCCF878Ec64f6eB687Eb4A771FB0599" }] }), { status: 402 });
      return new Response(JSON.stringify({ data: { count_24h: 12, mentions: [] } }), { status: 200 });
    }) as typeof fetch;
    const rx = await robinx("0xabc", { fetchImpl: f, now: NOW, paid: "mentions", maxUsd: 0.02 });
    expect(rx.spentUsd).toBe(0.02);
    expect(rx.mentions24h).toBe(12);
    expect(urls.some((u) => u.includes("/tg/"))).toBe(false);
    expect(urls.filter((u) => u.endsWith("/report/0xabc")).length).toBe(0);
    delete process.env.ROBINX_WALLET_KEY;
  });

  it("parses a mention tape into unique 24h posters and reach", () => {
    const m = parseMentions(
      {
        data: {
          mentions: [
            { account: "a", followers: 100, tweeted_at: new Date(NOW - H).toISOString() },
            { account: "A", followers: 100, tweeted_at: new Date(NOW - 2 * H).toISOString() },
            { account: "b", followers: 5000, tweeted_at: new Date(NOW - 3 * H).toISOString() },
            { account: "c", followers: 10, tweeted_at: new Date(NOW - 30 * H).toISOString() },
          ],
        },
      },
      NOW,
    );
    expect(m.posters24h.map((p) => p.account)).toEqual(["a", "b"]);
  });
});

describe("x402 signing", () => {
  it("signs an EIP-3009 authorization that recovers to the wallet address", () => {
    const pk = "0x" + "22".repeat(32);
    const req = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xA13d363AeCCCF878Ec64f6eB687Eb4A771FB0599", extra: { name: "USD Coin", version: "2" } };
    const header = JSON.parse(Buffer.from(paymentHeader(req, pk, "https://api.robinx.io/mentions/x", NOW, "0x" + "33".repeat(32)), "base64").toString());
    const a = header.payload.authorization;
    expect(a.from).toBe(addressOf(pk));
    expect(a.value).toBe("20000");
    const digest = authorizationDigest(a, { name: "USD Coin", version: "2", chainId: 8453, address: req.asset });
    const sig = header.payload.signature.slice(2);
    const recovered = secp256k1.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(parseInt(sig.slice(128), 16) - 27).recoverPublicKey(digest).toRawBytes(false);
    expect("0x" + bytesToHex(keccak_256(recovered.slice(1))).slice(-40)).toBe(addressOf(pk));
    expect(hexToBytes(sig).length).toBe(65);
  });

  it("refuses to sign above the cap", async () => {
    const f = (async () => new Response(JSON.stringify({ accepts: [{ scheme: "exact", network: "eip155:8453", amount: "60000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1" }] }), { status: 402 })) as typeof fetch;
    await expect(fetchX402("https://x", { privateKey: "0x" + "22".repeat(32), maxAtomic: 50_000n, fetchImpl: f })).rejects.toThrow(/exceeds the remaining cap/);
  });
});

const noLinks = async (): Promise<OfficialLinks> => ({ x: "https://x.com/duck", telegram: null, websites: [], xCommunity: null, boosted: false, boostsActive: 0, sources: ["DexScreener"], nullReasons: {} });
const rxFixture = (over: Partial<RobinxSocial> = {}): RobinxSocial => ({
  ...parseReportSocial(report.body),
  uniquePosters24h: null,
  reach24h: null,
  coordinatedShare: 0.25,
  tg: null,
  calls: [{ endpoint: "/report?tier=free", tier: "free", usd: 0, status: 200 }],
  spentUsd: 0,
  nullReasons: {},
  fetchedAt: new Date(NOW).toISOString(),
  ...over,
});

describe("collectSocial (information only)", () => {
  beforeEach(() => setKV(new MemoryKV()));

  it("Robinhood: RobinX feeds posts/24h, top accounts, first call vs launch; one sample is stored (early read)", async () => {
    const store = new KvSeries();
    const p = await collectSocial("robinhood", "0xd5f1", { createdAt: "2026-08-27T12:13:50Z", ageHours: 1500, symbol: "MD" }, undefined, { robinx: async () => rxFixture(), links: noLinks, store, library: [], now: NOW });
    expect(p.posts24h).toBe(35);
    expect(p.topAccounts.length).toBe(5);
    expect(p.topAccounts[0]).toEqual({ handle: "biggalordTE", followers: 229757 });
    expect(p.firstCallVsLaunchMin).toBeGreaterThan(0);
    expect(p.stage?.earlyRead).toBe(true);
    expect(p.samples).toBe(1);
    expect(p.sentiment).toBeNull();
    expect(p.nullReasons.sentiment).toMatch(/no post text/);
    expect(p.warnings).toEqual([]);
    expect((await store.list("robinhood", "0xd5f1")).length).toBe(1);
  });

  it("posts older than the launch ⇒ warning (guide p.43); Telegram-first ⇒ call-channel warning", async () => {
    const p = await collectSocial("robinhood", "0xabc", { createdAt: "2026-08-30T00:00:00Z", ageHours: 100, symbol: null }, undefined, {
      robinx: async () => rxFixture({ tg: { telegramFirst: "2026-08-29T00:00:00Z", xFirst: "2026-08-29T03:25:33Z", leadMinutes: 205, rooms: 4, reportable: true } }),
      links: noLinks,
      store: new KvSeries(),
      library: [],
      now: NOW,
    });
    expect(p.warnings.map((w) => w.id)).toEqual(["posts_before_launch", "call_channels"]);
  });

  it("Solana / Base: no post source ⇒ every social count null with the reason; links still shown", async () => {
    const p = await collectSocial("base", "0xbase", { createdAt: null, ageHours: 5, symbol: null }, undefined, { links: noLinks, store: new KvSeries(), library: [], now: NOW });
    expect(p.stage).toBeNull();
    expect(p.posts24h).toBeNull();
    expect(p.nullReasons.posts24h).toMatch(/no source measures X posts for base tokens/);
    expect(p.sources.find((s) => s.id === "robinx")!.state).toBe("skipped");
    expect(p.links.x).toBe("https://x.com/duck");
  });
});

describe("social cron", () => {
  beforeEach(() => setKV(new MemoryKV()));

  it("dry run: re-samples tracked tokens oldest-sampled first and stores the samples", async () => {
    const store = new KvSeries();
    for (const [i, a] of ["0x1", "0x2", "0x3"].entries()) await store.track({ chain: "robinhood", address: a, symbol: null, launchedAt: null, lastAnalyzedAt: new Date(NOW - i * H).toISOString() });
    await store.track({ chain: "solana", address: "So1", symbol: null, launchedAt: null, lastAnalyzedAt: new Date(NOW).toISOString() });
    const seen: string[] = [];
    const res = await resampleSocial({ store, source: async (a) => (seen.push(a), rxFixture()), now: () => NOW });
    expect(res.stored).toBe(3);
    expect(res.spentUsd).toBe(0);
    expect(seen.sort()).toEqual(["0x1", "0x2", "0x3"]);
    expect(res.skipped).toEqual([{ address: "So1", reason: "no post-count source for solana" }]);
    expect((await store.list("robinhood", "0x2")).length).toBe(1);
  });

  it("budget: at most 300 tokens per run; tokens analysed > 7 days ago are not re-sampled", async () => {
    const store = new KvSeries();
    for (let i = 0; i < 320; i++) await store.track({ chain: "robinhood", address: `0x${i}`, symbol: null, launchedAt: null, lastAnalyzedAt: new Date(Date.now() - (i < 310 ? 1 : 8 * 24) * H).toISOString() });
    let n = 0;
    const res = await resampleSocial({ store, source: async () => (n++, rxFixture()), limit: 1000 });
    expect(res.due).toBe(300);
    expect(n).toBe(300);
  });

  it("stops early when the source keeps not answering (e.g. free quota spent)", async () => {
    const store = new KvSeries();
    for (let i = 0; i < 20; i++) await store.track({ chain: "robinhood", address: `0x${i}`, symbol: null, launchedAt: null, lastAnalyzedAt: new Date().toISOString() });
    const res = await resampleSocial({ store, source: async () => rxFixture({ mentions24h: null, nullReasons: { report: "free tier 429" } }) });
    expect(res.sampled).toBe(5);
    expect(res.stoppedEarly).toMatch(/5 tokens in a row/);
  });
});
