/**
 * Builds the Time Machine archetype library from real history and stores it in data/archetypes/
 * and the KV (key tm:library:v1). Resumable: archetypes already in data/archetypes/ are reused
 * unless --fresh is passed.
 *   pnpm timemachine:build [--fresh] [--only=solana|robinhood] [--rugs-only]
 * Needs HELIUS_API_KEY for Solana; Robinhood uses the public RPC + GeckoTerminal.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { durableKV } from "../lib/kv";
import { mcpCall, fetchJson } from "../lib/sources/http";
import { scanhood } from "../lib/sources/scanhood";
import { heliusClient, reconstructSolana } from "../lib/timemachine/solana";
import { reconstructRobinhood } from "../lib/timemachine/robinhood";
import { LIBRARY_KEY } from "../lib/timemachine";
import type { Archetype, ArchetypeLibrary } from "../lib/timemachine/types";
import type { Chain } from "../lib/types";

const DIR = path.join(process.cwd(), "data", "archetypes");
const FEED = process.env.PUMPFUN_FEED_URL || "https://three.ws/api/pump-fun-mcp";
const THREE = "https://three.ws/api/oracle";
const HOODSCAN = "https://hoodscan.co/mcp";
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith("--only="))?.slice(7) as Chain | undefined;
const fresh = args.has("--fresh");
const SOL_MAX_TX = Number(process.env.TM_MAX_TX || 4000);
const RH_MAX_LOGS = Number(process.env.TM_MAX_LOGS || 400_000);
const RUG_TARGET = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

interface Candidate {
  chain: Chain;
  address: string;
  label: string;
  kind: "winner" | "rug";
  source: string;
  peakMcapUsd: number | null;
  expectSymbol?: string;
}

// Named Solana memes (mints verified against the on-chain symbol at build time).
const NAMED: [string, string][] = [
  ["BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
  ["WIF", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"],
  ["POPCAT", "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"],
  ["FARTCOIN", "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"],
  ["PNUT", "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump"],
  ["GOAT", "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump"],
  ["MOODENG", "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY"],
  ["CHILLGUY", "Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump"],
  ["PENGU", "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv"],
  ["TRUMP", "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN"],
];

interface Intel {
  found?: boolean;
  symbol?: string;
  outcome?: { outcome?: string; rugged?: boolean | null; graduated?: boolean | null; ath_market_cap_usd?: number } | null;
}
/** GeckoTerminal with patient 429 backoff (public API: ~30 calls/min). */
async function gecko<T>(url: string): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fetchJson<T>(url, { timeoutMs: 20_000 });
    } catch (e) {
      if (i >= 5 || !/\b429\b/.test((e as Error).message)) throw e;
      await sleep(15_000 * (i + 1));
    }
  }
}
const intel = (mint: string) => mcpCall<Intel>(FEED, "get_coin_intel", { mint, network: "mainnet" }, 20_000).catch(() => null);

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** three.ws: graduated winners of the last 30 days ranked by peak market cap (outcome.ath_market_cap_usd). */
async function pumpWinners(exclude: Set<string>): Promise<Candidate[]> {
  const wins = await fetchJson<{ items: { mint: string; symbol: string; graduated: boolean }[] }>(`${THREE}/wins?network=mainnet&period=30d&limit=100&min_ath=2`, { timeoutMs: 30_000 });
  const grads = wins.items.filter((w) => w.graduated && !exclude.has(w.mint));
  const withPeak = await pool(grads, 5, async (w) => ({ w, i: await intel(w.mint) }));
  return withPeak
    .filter((x) => x.i?.outcome?.ath_market_cap_usd)
    .sort((a, b) => b.i!.outcome!.ath_market_cap_usd! - a.i!.outcome!.ath_market_cap_usd!)
    .slice(0, 20)
    .map(({ w, i }) => ({ chain: "solana" as const, address: w.mint, label: w.symbol, kind: "winner" as const, source: "three.ws top graduation by peak mcap (30d)", peakMcapUsd: i!.outcome!.ath_market_cap_usd! }));
}

/** three.ws: coins labelled outcome = rugged, sampled from every listing the API exposes. */
async function pumpRugs(target: number): Promise<Candidate[]> {
  const mints = new Set<string>();
  const add = (items: { mint: string }[] | undefined) => items?.forEach((x) => mints.add(x.mint));
  for (const h of [24, 48, 168]) add((await fetchJson<{ items: { mint: string }[] }>(`${THREE}/movers?network=mainnet&direction=falling&hours=${h}&limit=40`).catch(() => null))?.items);
  add((await fetchJson<{ items: { mint: string }[] }>(`${THREE}/feed?network=mainnet&limit=200`).catch(() => null))?.items);
  for (const cat of ["meme", "ai", "animal", "celebrity", "political", "unknown"]) add((await fetchJson<{ items: { mint: string }[] }>(`${THREE}/feed?network=mainnet&category=${cat}&limit=200`).catch(() => null))?.items);
  log(`rug candidates from three.ws listings: ${mints.size}`);
  const out: Candidate[] = [];
  await pool([...mints], 8, async (m) => {
    if (out.length >= target) return;
    const i = await intel(m);
    if (i?.outcome?.rugged === true) out.push({ chain: "solana", address: m, label: i.symbol ?? m.slice(0, 6), kind: "rug", source: "three.ws outcome = rugged", peakMcapUsd: i.outcome.ath_market_cap_usd ?? null });
  });
  return out;
}

interface HsMeme {
  address: string;
  symbol: string;
  name?: string;
  launchpad: string;
  fdvUsd: number;
  liquidityUsd: number;
  ageHours: number;
}
const memes = (sort: string, extra: Record<string, unknown> = {}) =>
  mcpCall<{ items: HsMeme[] }>(HOODSCAN, "list_meme_stocks", { sort, limit: 100, ...extra }, 30_000).then((r) => r.items).catch(() => [] as HsMeme[]);

/** HoodScan memes (launchpad coins with real liquidity), ranked by peak mcap = FDV now × highest daily high / last close (GeckoTerminal). */
async function robinhoodWinners(): Promise<Candidate[]> {
  const seen = new Map<string, HsMeme>();
  for (const s of ["fdv", "volume", "liquidity", "score"]) for (const m of await memes(s)) if (m.launchpad !== "other" && m.liquidityUsd >= 10_000 && m.ageHours >= 72) seen.set(m.address, m);
  log(`Robinhood meme candidates: ${seen.size}`);
  const ranked: Candidate[] = [];
  for (const m of seen.values()) {
    await sleep(2500); // GeckoTerminal public limit ~30/min
    try {
      const pools = await gecko<{ data: { attributes: { address: string; reserve_in_usd: string } }[] }>(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${m.address}/pools?page=1`);
      const main = pools.data.sort((a, b) => Number(b.attributes.reserve_in_usd) - Number(a.attributes.reserve_in_usd))[0];
      if (!main) continue;
      await sleep(2200);
      const d = await gecko<{ data: { attributes: { ohlcv_list: number[][] } } }>(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${main.attributes.address}/ohlcv/day?aggregate=1&limit=180&currency=usd&token=base`);
      const rows = d.data.attributes.ohlcv_list;
      if (!rows.length) continue;
      const high = Math.max(...rows.map((r) => r[2]));
      const lastClose = rows.sort((a, b) => b[0] - a[0])[0][4];
      ranked.push({ chain: "robinhood", address: m.address, label: m.symbol, kind: "winner", source: "HoodScan meme, top 15 by peak mcap (FDV × peak daily high / last close)", peakMcapUsd: lastClose > 0 ? (m.fdvUsd * high) / lastClose : null });
    } catch (e) {
      log(`  peak for ${m.symbol} failed: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  return ranked.filter((c) => c.peakMcapUsd).sort((a, b) => b.peakMcapUsd! - a.peakMcapUsd!).slice(0, 15);
}

/** Robinhood honeypots confirmed by a ScanHood buy/sell simulation (≤ 80 scans of the free 500/day). */
async function robinhoodHoneypots(target: number): Promise<Candidate[]> {
  const pool_ = new Map<string, HsMeme>();
  // Memes only: launchpad coins, never wrapped/bridged assets (HoodScan lists those next to memes).
  for (const m of [...(await memes("newest")), ...(await memes("change_24h"))]) if (m.ageHours >= 2 && m.ageHours <= 24 * 30 && !/wrapped|bridge/i.test(m.name ?? "")) pool_.set(m.address, m);
  pool_.set("0x30de7ae4c9578d110a97367ede9f7765cdce06ea", { address: "0x30de7ae4c9578d110a97367ede9f7765cdce06ea", symbol: "PANGEA", launchpad: "other", fdvUsd: 0, liquidityUsd: 0, ageHours: 0 });
  const out: Candidate[] = [];
  let scans = 0;
  await pool([...pool_.values()].slice(0, 80), 4, async (m) => {
    if (out.length >= target) return;
    scans++;
    const r = await scanhood(m.address).catch(() => null);
    if (r?.data.honeypot === true) out.push({ chain: "robinhood", address: m.address, label: m.symbol, kind: "rug", source: "ScanHood honeypot (buy/sell simulation)", peakMcapUsd: null });
  });
  log(`ScanHood: ${scans} scans, ${out.length} honeypots`);
  return out;
}

const fileOf = (c: Candidate) => path.join(DIR, `${c.chain}-${c.kind}-${c.address}.json`);

async function build(c: Candidate, helius: ReturnType<typeof heliusClient> | null): Promise<Archetype | { skip: string }> {
  if (!fresh && existsSync(fileOf(c))) return JSON.parse(readFileSync(fileOf(c), "utf8")) as Archetype;
  try {
    const rec =
      c.chain === "solana"
        ? helius
          ? await reconstructSolana(c.address, helius, { maxTx: c.kind === "rug" ? Math.min(SOL_MAX_TX, 2000) : SOL_MAX_TX })
          : (() => {
              throw new Error("Helius key not set");
            })()
        : await reconstructRobinhood(c.address, { maxLogs: c.kind === "rug" ? Math.min(RH_MAX_LOGS, 150_000) : RH_MAX_LOGS });
    if (c.expectSymbol && rec.symbol && rec.symbol.trim().toUpperCase().replace(/^\$/, "") !== c.expectSymbol) return { skip: `on-chain symbol is ${rec.symbol}, expected ${c.expectSymbol}` };
    const usable = rec.buckets.filter((b) => Object.values(b.fields).filter((v) => v != null).length >= 4).length;
    if (!usable) return { skip: `no bucket reconstructable (${rec.notes.join("; ") || rec.buckets[0]?.nulls.holders || "no buckets"})` };
    const arch: Archetype = { ...rec, kind: c.kind, source: c.source, peakMcapUsd: c.peakMcapUsd, symbol: rec.symbol ?? c.label };
    writeFileSync(fileOf(c), JSON.stringify(arch, null, 1));
    return arch;
  } catch (e) {
    return { skip: (e as Error).message.slice(0, 160) };
  }
}

const t0 = Date.now();
mkdirSync(DIR, { recursive: true });
const helius = process.env.HELIUS_API_KEY ? heliusClient(process.env.HELIUS_API_KEY) : null;
// Candidate discovery is slow (rate-limited APIs); it is cached for a day so a rerun resumes building.
const CANDIDATES = path.join(process.cwd(), ".data", "tm-candidates.json");
const cachedCandidates: Candidate[] | null =
  !fresh && existsSync(CANDIDATES) && Date.now() - Date.parse(JSON.parse(readFileSync(CANDIDATES, "utf8")).at) < 86_400_000 ? JSON.parse(readFileSync(CANDIDATES, "utf8")).candidates : null;
const candidates: Candidate[] = cachedCandidates ?? [];
if (cachedCandidates) log(`using ${candidates.length} cached candidates`);
else {
if (only !== "robinhood") {
  candidates.push(...NAMED.map(([sym, mint]) => ({ chain: "solana" as const, address: mint, label: sym, kind: "winner" as const, source: "named meme", peakMcapUsd: null, expectSymbol: sym })));
  if (!args.has("--rugs-only")) candidates.push(...(await pumpWinners(new Set(NAMED.map((n) => n[1])))));
}
if (only !== "solana" && !args.has("--rugs-only")) candidates.push(...(await robinhoodWinners()));
log(`winners listed: ${candidates.length}`);
const rhRugs = only !== "solana" ? await robinhoodHoneypots(15) : [];
const solRugs = only !== "robinhood" ? await pumpRugs(RUG_TARGET - rhRugs.length) : [];
candidates.push(...rhRugs, ...solRugs);
mkdirSync(path.dirname(CANDIDATES), { recursive: true });
writeFileSync(CANDIDATES, JSON.stringify({ at: new Date().toISOString(), candidates }));
}
log(`candidates: ${candidates.filter((c) => c.kind === "winner").length} winners, ${candidates.filter((c) => c.kind === "rug").length} rugs`);

const archetypes: Archetype[] = [];
const skipped: ArchetypeLibrary["skipped"] = [];
const sol = candidates.filter((c) => c.chain === "solana");
const rh = candidates.filter((c) => c.chain === "robinhood");
await Promise.all([
  pool(sol, 1, async (c) => {
    const r = await build(c, helius);
    if ("skip" in r) skipped.push({ chain: c.chain, address: c.address, label: c.label, reason: r.skip });
    else archetypes.push(r);
    log(`${c.chain} ${c.kind} ${c.label}: ${"skip" in r ? `skipped — ${r.skip}` : `${r.buckets.map((b) => `+${b.bucket}h`).join(" ")} in ${r.buildMs}ms`}`);
  }),
  pool(rh, 1, async (c) => {
    const r = await build(c, null);
    if ("skip" in r) skipped.push({ chain: c.chain, address: c.address, label: c.label, reason: r.skip });
    else archetypes.push(r);
    log(`${c.chain} ${c.kind} ${c.label}: ${"skip" in r ? `skipped — ${r.skip}` : `${r.buckets.map((b) => `+${b.bucket}h`).join(" ")} in ${r.buildMs}ms`}`);
  }),
]);

// Keep archetypes built in earlier runs that this run's listings no longer return.
for (const f of readdirSync(DIR).filter((f) => /^(solana|robinhood)-(winner|rug)-/.test(f))) {
  const a = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Archetype;
  if (!archetypes.some((x) => x.address === a.address && x.kind === a.kind) && (!only || a.chain === only)) archetypes.push(a);
}
const lib: ArchetypeLibrary = { version: 1, builtAt: new Date().toISOString(), buildMs: Date.now() - t0, archetypes, skipped };
writeFileSync(path.join(DIR, "library.json"), JSON.stringify(lib));
const kv = durableKV();
if (kv) await kv.set(LIBRARY_KEY, lib);
log(`library: ${archetypes.filter((a) => a.kind === "winner").length} winners, ${archetypes.filter((a) => a.kind === "rug").length} rugs, ${skipped.length} skipped, ${((Date.now() - t0) / 60000).toFixed(1)} min${kv ? ` · stored in ${kv.kind}` : ""}`);
