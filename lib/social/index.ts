import type { Chain, SourceStatus, TokenSnapshot } from "../types";
import { kvGet, kvSet } from "../kv";
import { loadLibrary } from "../timemachine";
import { officialLinks, type OfficialLinks } from "./links";
import { robinx, type RobinxSocial } from "./robinx";
import { seriesStore, type SeriesStore } from "./series";
import {
  sizeBand,
  socialQuality,
  socialStage,
  socialTimeMachine,
  socialVerdict,
  stageBadge,
  stagesByAge,
  type QualityInputs,
  type QualityPart,
  type SizeBand,
  type SocialArchetype,
  type SocialSample,
  type StageResult,
} from "./stage";

/**
 * The SOCIAL panel: information only — nothing here feeds the score (see REPORT.md, social §6).
 * Sources, in order: three.ws (keyless; scores post text it is handed — no source here supplies text, and
 * it accepts Solana mints only), RobinX (Robinhood Chain CAs), DexScreener / GeckoTerminal (official links,
 * boosts), and our own series (Postgres social_series). A field no source answered is null with the reason.
 */
export interface SocialWarning {
  id: "posts_before_launch" | "call_channels" | "coordinated_callers" | "boosted";
  text: string;
  note: string;
}

export interface SocialPanel {
  chain: Chain;
  sources: SourceStatus[];
  links: OfficialLinks;
  posts24h: number | null;
  uniquePosters24h: number | null;
  reach24h: number | null;
  sentiment: { score: number; posPct: number; negPct: number; neuPct: number } | null;
  botShare: number | null;
  /** Top 5 by followers among the accounts the source listed (handle + follower count). */
  topAccounts: { handle: string; followers: number }[];
  /** What the listed accounts are ("earliest 10 callers" or "24h posters"). */
  postersBasis: string | null;
  posters: { handle: string; followers: number | null; firstPostAt: string | null }[];
  firstCallAt: string | null;
  firstCallHandle: string | null;
  /** Minutes from launch to the first call (negative = before launch). */
  firstCallVsLaunchMin: number | null;
  warnings: SocialWarning[];
  nullReasons: Record<string, string>;
  /** 30-day series of M (unique posters, else posts, per 24h) for the sparkline. */
  series: { ts: string; m: number }[];
  lastSampleAt: string | null;
  samples: number;
  stage: StageResult | null;
  size: SizeBand | null;
  quality: { score: number | null; parts: QualityPart[] };
  verdict: string | null;
  badge: string | null;
  timeMachine: { line: string | null; nearest: { name: string; kind: string; distance: number } | null; reason: string | null };
  spentUsd: number;
}

export const SOCIAL_LIBRARY_KEY = "tm:social:v1";

const THREEWS_REASON = "three.ws social_cashtag_sentiment only scores post text it is given and social_x_post_impact needs one X post URL and a Solana curve mint (an EVM CA is rejected: \"invalid mint\"); no source here supplies post text";

interface Deps {
  robinx?: typeof robinx;
  links?: typeof officialLinks;
  store?: SeriesStore;
  library?: SocialArchetype[];
  now?: number;
  record?: boolean;
}

/** One sample from what the sources answered now (null when neither posts nor posters are known). */
export function sampleOf(rx: RobinxSocial | null, now: number, quality: number | null = null): SocialSample | null {
  if (!rx || (rx.mentions24h == null && rx.uniquePosters24h == null)) return null;
  return { ts: new Date(now).toISOString(), posts24h: rx.mentions24h, uniquePosters24h: rx.uniquePosters24h, reach24h: rx.reach24h, sentiment: null, botShare: null, quality, source: "robinx" };
}

export async function collectSocial(chain: Chain, address: string, token: Pick<TokenSnapshot, "createdAt" | "ageHours" | "symbol">, dexRaw: unknown, deps: Deps = {}): Promise<SocialPanel> {
  const now = deps.now ?? Date.now();
  const store = deps.store ?? seriesStore();
  const sources: SourceStatus[] = [];
  const nullReasons: Record<string, string> = {};
  const t0 = Date.now();

  sources.push({ id: "threews-social", label: "three.ws social", state: "skipped", message: THREEWS_REASON });
  nullReasons.sentiment = `no post text to score: RobinX does not redistribute tweet text, and ${THREEWS_REASON.split(";")[0]}`;

  let rx: RobinxSocial | null = null;
  if (chain === "robinhood") {
    try {
      rx = await (deps.robinx ?? robinx)(address);
      const answered = rx.calls.filter((c) => c.status === 200).map((c) => c.endpoint);
      sources.push({
        id: "robinx",
        label: "RobinX",
        state: answered.length ? (Object.keys(rx.nullReasons).length ? "partial" : "ok") : "failed",
        message: `${answered.length ? `answered: ${answered.join(", ")}` : "no call answered"}${rx.spentUsd ? ` · spent $${rx.spentUsd.toFixed(2)}` : " · $0"}${Object.keys(rx.nullReasons).length ? ` · ${Object.values(rx.nullReasons)[0]}` : ""}`.slice(0, 300),
        ms: Date.now() - t0,
      });
    } catch (err) {
      sources.push({ id: "robinx", label: "RobinX", state: "failed", message: (err as Error).message.slice(0, 200), ms: Date.now() - t0 });
    }
  } else {
    sources.push({ id: "robinx", label: "RobinX", state: "skipped", message: "RobinX covers Robinhood Chain tokens only (its Solana and Base records were retired 2026-10-09)" });
  }
  const rxReason = sources.find((s) => s.id === "robinx")!.message ?? "RobinX did not answer";
  const noSource = `no source measures X posts for ${chain} tokens (RobinX: Robinhood Chain only; three.ws: no post search)`;
  const launchedAt = token.createdAt;

  const links = await (deps.links ?? officialLinks)(chain, address, dexRaw as { pairs?: [] } | undefined).catch(
    (err: Error): OfficialLinks => ({ x: null, telegram: null, websites: [], xCommunity: null, boosted: null, boostsActive: null, sources: [], nullReasons: { links: err.message } }),
  );
  sources.push({ id: "social-links", label: "DexScreener / GeckoTerminal socials", state: links.sources.length ? "ok" : "failed", message: links.sources.length ? `links from ${links.sources.join(" + ")}${links.boostsActive ? ` · ${links.boostsActive} active boosts` : ""}` : (links.nullReasons.links ?? "no answer") });

  const posts24h = rx?.mentions24h ?? null;
  const uniquePosters24h = rx?.uniquePosters24h ?? null;
  if (posts24h == null) nullReasons.posts24h = chain === "robinhood" ? (rx?.nullReasons.mentions24h ?? rxReason) : noSource;
  if (uniquePosters24h == null) nullReasons.uniquePosters24h = rx?.nullReasons.uniquePosters24h ?? nullReasons.posts24h ?? "no source";
  if (rx?.reach24h == null) nullReasons.reach24h = rx?.nullReasons.reach24h ?? nullReasons.uniquePosters24h;
  nullReasons.botShare = chain === "robinhood" ? "RobinX reports coordinated clusters, not a bot share" : "no source reports a bot share for this chain";

  const posters = (rx?.posters ?? []).map((p) => ({ handle: p.account, followers: p.followers, firstPostAt: p.when }));
  const topAccounts = posters
    .filter((p): p is { handle: string; followers: number; firstPostAt: string | null } => p.followers != null)
    .sort((a, b) => b.followers - a.followers || a.handle.localeCompare(b.handle))
    .slice(0, 5)
    .map(({ handle, followers }) => ({ handle, followers }));
  const postersBasis = !rx || !posters.length ? null : rx.uniquePosters24h != null ? "24h posters (RobinX mention tape)" : "earliest 10 callers (RobinX report)";
  if (!posters.length) nullReasons.topAccounts = chain === "robinhood" ? rxReason : noSource;

  const first = rx?.firstMention ?? null;
  const launchMs = launchedAt ? Date.parse(launchedAt) : NaN;
  const firstCallVsLaunchMin = first && Number.isFinite(launchMs) ? Math.round((Date.parse(first.when) - launchMs) / 60_000) : null;
  if (!first) nullReasons.firstCall = chain === "robinhood" ? `RobinX has no first mention: ${rxReason}` : noSource;
  else if (firstCallVsLaunchMin == null) nullReasons.firstCall = "launch time unknown";

  // Guide rules (warnings only).
  const warnings: SocialWarning[] = [];
  if (firstCallVsLaunchMin != null && firstCallVsLaunchMin < 0)
    warnings.push({ id: "posts_before_launch", text: `The earliest X post (@${first!.account}) is ${fmtMinutes(-firstCallVsLaunchMin)} older than the launch — pre-planned.`, note: "guide p.43" });
  const tgFirst = rx?.tg?.reportable && rx.tg.leadMinutes != null && rx.tg.leadMinutes > 0;
  if (tgFirst) warnings.push({ id: "call_channels", text: `Telegram call channels carried it ${fmtMinutes(rx!.tg!.leadMinutes!)} before X (≥ 3 rooms) — a call-channel pattern.`, note: "guide p.37" });
  const coordinated = rx?.coordinatedShare != null && rx.coordinatedShare >= 0.5 && (rx.posters.filter((p) => p.coordinated != null).length ?? 0) >= 3;
  if (coordinated) warnings.push({ id: "coordinated_callers", text: `${Math.round(rx!.coordinatedShare! * 100)}% of the measured early callers belong to coordinated clusters.`, note: "guide p.37" });
  if (links.boosted) warnings.push({ id: "boosted", text: `DexScreener shows ${links.boostsActive} active paid boosts.`, note: "HoodTier" });

  const qIn: QualityInputs = {
    credibleShare: posters.length && posters.every((p) => p.followers != null) ? posters.filter((p) => (p.followers ?? 0) > 1000).length / posters.length : null,
    botShare: null,
    sentiment: null,
    xCommunity: links.sources.length ? !!links.xCommunity : null,
    postsBeforeLaunch: firstCallVsLaunchMin == null ? null : firstCallVsLaunchMin < 0,
    callChannelPattern: rx?.tg?.reportable ? !!tgFirst || coordinated : rx?.coordinatedShare != null ? coordinated : null,
    boosted: links.boosted,
  };
  const quality = socialQuality(qIn, {
    credibleShare: nullReasons.topAccounts ?? "follower counts missing for some listed posters",
    botShare: nullReasons.botShare,
    sentiment: nullReasons.sentiment,
    xCommunity: links.nullReasons.links ?? "no link source answered",
    postsBeforeLaunch: nullReasons.firstCall,
    callChannelPattern: rx?.nullReasons.tg ?? (chain === "robinhood" ? rxReason : "no Telegram / caller source for this chain"),
    boosted: links.nullReasons.boosted,
  });

  // Our own series: this analysis adds one sample (when a source measured posts/posters).
  const sample = sampleOf(rx, now, quality.score);
  if (deps.record !== false) {
    try {
      if (sample) await store.add(chain, address, sample);
      if (chain === "robinhood") await store.track({ chain, address, symbol: token.symbol, launchedAt, lastAnalyzedAt: new Date(now).toISOString() });
    } catch (err) {
      nullReasons.series = `series store failed: ${(err as Error).message.slice(0, 80)}`;
    }
  }
  let series: SocialSample[] = [];
  try {
    series = await store.list(chain, address);
  } catch (err) {
    nullReasons.series = `series store failed: ${(err as Error).message.slice(0, 80)}`;
  }
  if (sample && !series.some((s) => s.ts === sample.ts)) series = [...series, sample];
  const stage = socialStage(series, token.ageHours, now);
  const size = stage ? sizeBand(stage.mNow) : null;
  if (!stage) nullReasons.stage = chain === "robinhood" ? `no post counts yet — ${rxReason}` : noSource;

  const library = deps.library ?? ((await kvGet<SocialArchetype[]>(SOCIAL_LIBRARY_KEY)) || []);
  const tm = socialTimeMachine(stagesByAge(series, launchedAt), library, token.ageHours);

  const m = stage?.metric ?? "posts24h";
  const spark = series
    .map((s) => ({ ts: s.ts, m: (m === "uniquePosters24h" ? s.uniquePosters24h : s.posts24h) as number | null }))
    .filter((p): p is { ts: string; m: number } => p.m != null);
  return {
    chain,
    sources,
    links,
    posts24h,
    uniquePosters24h,
    reach24h: rx?.reach24h ?? null,
    sentiment: null,
    botShare: null,
    topAccounts,
    postersBasis,
    posters,
    firstCallAt: first?.when ?? null,
    firstCallHandle: first?.account ?? null,
    firstCallVsLaunchMin,
    warnings,
    nullReasons,
    series: spark,
    lastSampleAt: series.length ? series[series.length - 1].ts : null,
    samples: series.length,
    stage,
    size,
    quality,
    verdict: stage && size ? socialVerdict(stage, size, quality.score) : null,
    badge: stage && size ? stageBadge(stage, size, quality.score) : null,
    timeMachine: tm,
    spentUsd: rx?.spentUsd ?? 0,
  };
}

function fmtMinutes(min: number): string {
  if (min < 90) return `${Math.round(min)} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)} days`;
}

/** Rebuilds the social archetype library from our own series of the Time Machine's archetypes. */
export async function buildSocialLibrary(store: SeriesStore = seriesStore()): Promise<{ archetypes: number; withHistory: number }> {
  const lib = await loadLibrary();
  const out: SocialArchetype[] = [];
  for (const a of lib.archetypes) {
    const series = await store.list(a.chain, a.address).catch(() => []);
    out.push({ name: a.symbol ?? a.name ?? a.address.slice(0, 8), kind: a.kind, stages: stagesByAge(series, a.createdAt) });
  }
  await kvSet(SOCIAL_LIBRARY_KEY, out);
  return { archetypes: out.length, withHistory: out.filter((x) => Object.values(x.stages).some(Boolean)).length };
}
