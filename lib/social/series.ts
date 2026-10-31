import { neon } from "@neondatabase/serverless";
import type { Chain } from "../types";
import type { SocialSample } from "./stage";
import { kvGet, kvSet } from "../kv";

/**
 * Our own social series: one sample per analysis and per cron re-sample, kept 30 days.
 * Postgres `social_series` (+ `social_tokens`, the tokens to re-sample) when DATABASE_URL is set;
 * otherwise the KV (local dev / tests).
 */
export const KEEP_DAYS = 30;

export interface TrackedToken {
  chain: Chain;
  address: string;
  symbol: string | null;
  launchedAt: string | null;
  lastAnalyzedAt: string;
  lastSampledAt: string | null;
}

export interface SeriesStore {
  kind: "postgres" | "kv";
  add(chain: Chain, address: string, s: SocialSample): Promise<void>;
  list(chain: Chain, address: string, sinceDays?: number): Promise<SocialSample[]>;
  track(t: Omit<TrackedToken, "lastSampledAt">): Promise<void>;
  /** Tokens analysed in the last `days`, least recently sampled first. */
  due(days: number, limit: number): Promise<TrackedToken[]>;
  markSampled(chain: Chain, address: string, at: string): Promise<void>;
  prune(days?: number): Promise<number>;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

class PgSeries implements SeriesStore {
  readonly kind = "postgres" as const;
  private sql: ReturnType<typeof neon>;
  private ready: Promise<void> | null = null;
  constructor(url: string) {
    this.sql = neon(url);
  }
  private init() {
    this.ready ??= (async () => {
      await this.sql`CREATE TABLE IF NOT EXISTS social_series (
        chain text NOT NULL, address text NOT NULL, ts timestamptz NOT NULL,
        posts24h double precision, unique_posters24h double precision, reach24h double precision,
        sentiment double precision, bot_share double precision, quality double precision, source text NOT NULL,
        PRIMARY KEY (chain, address, ts))`;
      await this.sql`ALTER TABLE social_series ADD COLUMN IF NOT EXISTS quality double precision`;
      await this.sql`CREATE TABLE IF NOT EXISTS social_tokens (
        chain text NOT NULL, address text NOT NULL, symbol text, launched_at timestamptz,
        last_analyzed_at timestamptz NOT NULL, last_sampled_at timestamptz, PRIMARY KEY (chain, address))`;
    })();
    return this.ready;
  }
  async add(chain: Chain, address: string, s: SocialSample) {
    await this.init();
    await this.sql`INSERT INTO social_series (chain, address, ts, posts24h, unique_posters24h, reach24h, sentiment, bot_share, quality, source)
      VALUES (${chain}, ${address}, ${s.ts}, ${s.posts24h}, ${s.uniquePosters24h}, ${s.reach24h}, ${s.sentiment}, ${s.botShare}, ${s.quality ?? null}, ${s.source})
      ON CONFLICT (chain, address, ts) DO NOTHING`;
  }
  async list(chain: Chain, address: string, sinceDays = KEEP_DAYS) {
    await this.init();
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const rows = (await this.sql`SELECT ts, posts24h, unique_posters24h, reach24h, sentiment, bot_share, quality, source FROM social_series
      WHERE chain = ${chain} AND address = ${address} AND ts >= ${since} ORDER BY ts`) as Record<string, unknown>[];
    return rows.map((r) => ({
      ts: iso(r.ts)!,
      posts24h: r.posts24h as number | null,
      uniquePosters24h: r.unique_posters24h as number | null,
      reach24h: r.reach24h as number | null,
      sentiment: r.sentiment as number | null,
      botShare: r.bot_share as number | null,
      quality: r.quality as number | null,
      source: r.source as string,
    }));
  }
  async track(t: Omit<TrackedToken, "lastSampledAt">) {
    await this.init();
    await this.sql`INSERT INTO social_tokens (chain, address, symbol, launched_at, last_analyzed_at) VALUES (${t.chain}, ${t.address}, ${t.symbol}, ${t.launchedAt}, ${t.lastAnalyzedAt})
      ON CONFLICT (chain, address) DO UPDATE SET symbol = EXCLUDED.symbol, launched_at = COALESCE(EXCLUDED.launched_at, social_tokens.launched_at), last_analyzed_at = EXCLUDED.last_analyzed_at`;
  }
  async due(days: number, limit: number) {
    await this.init();
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = (await this.sql`SELECT chain, address, symbol, launched_at, last_analyzed_at, last_sampled_at FROM social_tokens
      WHERE last_analyzed_at >= ${since} ORDER BY last_sampled_at ASC NULLS FIRST, last_analyzed_at ASC LIMIT ${limit}`) as Record<string, unknown>[];
    return rows.map((r) => ({
      chain: r.chain as Chain,
      address: r.address as string,
      symbol: (r.symbol as string) ?? null,
      launchedAt: iso(r.launched_at),
      lastAnalyzedAt: iso(r.last_analyzed_at)!,
      lastSampledAt: iso(r.last_sampled_at),
    }));
  }
  async markSampled(chain: Chain, address: string, at: string) {
    await this.init();
    await this.sql`UPDATE social_tokens SET last_sampled_at = ${at} WHERE chain = ${chain} AND address = ${address}`;
  }
  async prune(days = KEEP_DAYS) {
    await this.init();
    const before = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = (await this.sql`DELETE FROM social_series WHERE ts < ${before} RETURNING 1`) as unknown[];
    return rows.length;
  }
}

/** KV fallback: one list per token plus one token index (local dev and tests). */
export class KvSeries implements SeriesStore {
  readonly kind = "kv" as const;
  private key = (c: Chain, a: string) => `social:series:v1:${c}:${a}`;
  async add(chain: Chain, address: string, s: SocialSample) {
    const list = (await kvGet<SocialSample[]>(this.key(chain, address))) ?? [];
    if (!list.some((x) => x.ts === s.ts)) list.push(s);
    const cut = Date.now() - KEEP_DAYS * 86_400_000;
    await kvSet(
      this.key(chain, address),
      list.filter((x) => Date.parse(x.ts) >= cut).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
    );
  }
  async list(chain: Chain, address: string, sinceDays = KEEP_DAYS) {
    const cut = Date.now() - sinceDays * 86_400_000;
    return ((await kvGet<SocialSample[]>(this.key(chain, address))) ?? []).filter((x) => Date.parse(x.ts) >= cut);
  }
  private async index() {
    return (await kvGet<TrackedToken[]>("social:tokens:v1")) ?? [];
  }
  async track(t: Omit<TrackedToken, "lastSampledAt">) {
    const all = await this.index();
    const prev = all.find((x) => x.chain === t.chain && x.address === t.address);
    await kvSet("social:tokens:v1", [...all.filter((x) => x !== prev), { ...t, launchedAt: t.launchedAt ?? prev?.launchedAt ?? null, lastSampledAt: prev?.lastSampledAt ?? null }]);
  }
  async due(days: number, limit: number) {
    const cut = Date.now() - days * 86_400_000;
    const sampled = (t: TrackedToken) => (t.lastSampledAt ? Date.parse(t.lastSampledAt) : 0);
    return (await this.index())
      .filter((t) => Date.parse(t.lastAnalyzedAt) >= cut)
      .sort((a, b) => sampled(a) - sampled(b) || Date.parse(a.lastAnalyzedAt) - Date.parse(b.lastAnalyzedAt))
      .slice(0, limit);
  }
  async markSampled(chain: Chain, address: string, at: string) {
    const all = await this.index();
    await kvSet(
      "social:tokens:v1",
      all.map((t) => (t.chain === chain && t.address === address ? { ...t, lastSampledAt: at } : t)),
    );
  }
  async prune() {
    return 0; // KV lists are trimmed to 30 days on every add
  }
}

let store: SeriesStore | null = null;
export function seriesStore(): SeriesStore {
  if (store) return store;
  const pg = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  store = pg && !process.env.VITEST ? new PgSeries(pg) : new KvSeries();
  return store;
}
/** Test hook. */
export const setSeriesStore = (s: SeriesStore | null) => void (store = s);
