import { promises as fs } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

/** Minimal JSON key-value store used for stale snapshots, replay state and liquidity history. */
export interface KV {
  readonly kind: "upstash" | "postgres" | "file" | "memory";
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /** Atomically adds 1 to a numeric key (created at 1 with the TTL) and returns the new value. */
  incr(key: string, ttlSeconds: number, by?: number): Promise<number>;
  /** Several keys in one round trip; a missing / expired key is null, in input order. */
  mget<T>(keys: string[]): Promise<(T | null)[]>;
}

export class MemoryKV implements KV {
  readonly kind = "memory" as const;
  private map = new Map<string, { v: string; exp: number | null }>();
  async get<T>(key: string): Promise<T | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp && Date.now() > e.exp) {
      this.map.delete(key);
      return null;
    }
    return JSON.parse(e.v) as T;
  }
  async set(key: string, value: unknown, ttlSeconds?: number) {
    this.map.set(key, { v: JSON.stringify(value), exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }
  async incr(key: string, ttlSeconds: number, by = 1) {
    // Synchronous read-modify-write: no await in between, so concurrent calls cannot interleave.
    const e = this.map.get(key);
    const live = e && !(e.exp && Date.now() > e.exp);
    const n = (live ? (JSON.parse(e.v) as number) : 0) + by;
    this.map.set(key, { v: JSON.stringify(n), exp: live ? e.exp : Date.now() + ttlSeconds * 1000 });
    return n;
  }
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    return Promise.all(keys.map((k) => this.get<T>(k)));
  }
}

/** One JSON file per key under a directory — local development persistence across restarts. */
export class FileKV implements KV {
  readonly kind = "file" as const;
  constructor(private dir: string) {}
  private file(key: string) {
    return path.join(this.dir, `${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
  }
  async get<T>(key: string): Promise<T | null> {
    try {
      const { v, exp } = JSON.parse(await fs.readFile(this.file(key), "utf8"));
      if (exp && Date.now() > exp) return null;
      return v as T;
    } catch {
      return null;
    }
  }
  async set(key: string, value: unknown, ttlSeconds?: number) {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(key)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null }));
    await fs.rename(tmp, this.file(key));
  }
  private lock: Promise<unknown> = Promise.resolve();
  /** Local development (one process): increments are serialized through a per-store lock. */
  incr(key: string, ttlSeconds: number, by = 1): Promise<number> {
    const run = this.lock.then(async () => {
      const n = ((await this.get<number>(key)) ?? 0) + by;
      await this.set(key, n, ttlSeconds);
      return n;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    return Promise.all(keys.map((k) => this.get<T>(k)));
  }
}

/** Upstash Redis over its REST API. Works with both Vercel KV and Upstash env var names. */
export class UpstashKV implements KV {
  readonly kind = "upstash" as const;
  constructor(
    private url: string,
    private token: string,
  ) {}
  private async cmd<T>(args: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const body = (await res.json()) as { result?: T; error?: string };
    if (!res.ok || body.error) throw new Error(`Upstash ${res.status}: ${body.error ?? "error"}`);
    return body.result as T;
  }
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.cmd<string | null>(["GET", key]);
    return raw == null ? null : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown, ttlSeconds?: number) {
    const args: unknown[] = ["SET", key, JSON.stringify(value)];
    if (ttlSeconds) args.push("EX", ttlSeconds);
    await this.cmd(args);
  }
  async incr(key: string, ttlSeconds: number, by = 1) {
    const n = await this.cmd<number>(["INCRBY", key, by]);
    if (n === by) await this.cmd(["EXPIRE", key, ttlSeconds]);
    return n;
  }
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    if (!keys.length) return [];
    const raw = await this.cmd<(string | null)[]>(["MGET", ...keys]);
    return raw.map((r) => (r == null ? null : (JSON.parse(r) as T)));
  }
}

/** Postgres (Neon) fallback: a single `kv` table (key, value jsonb, expires_at). */
export class PostgresKV implements KV {
  readonly kind = "postgres" as const;
  private sql: ReturnType<typeof neon>;
  private ready: Promise<void> | null = null;
  constructor(url: string) {
    this.sql = neon(url);
  }
  private init() {
    this.ready ??= this.sql`CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb NOT NULL, expires_at timestamptz)`.then(() => undefined);
    return this.ready;
  }
  async get<T>(key: string): Promise<T | null> {
    await this.init();
    const rows = (await this.sql`SELECT value FROM kv WHERE key = ${key} AND (expires_at IS NULL OR expires_at > now())`) as { value: T }[];
    return rows.length ? rows[0].value : null;
  }
  async set(key: string, value: unknown, ttlSeconds?: number) {
    await this.init();
    const exp = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
    const json = JSON.stringify(value);
    await this.sql`INSERT INTO kv (key, value, expires_at) VALUES (${key}, ${json}::jsonb, ${exp})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`;
  }
  async incr(key: string, ttlSeconds: number, by = 1) {
    await this.init();
    const exp = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const start = JSON.stringify(by);
    // One statement: an expired row restarts at `by`, a live one increments in place.
    const rows = (await this.sql`INSERT INTO kv (key, value, expires_at) VALUES (${key}, ${start}::jsonb, ${exp})
      ON CONFLICT (key) DO UPDATE SET
        value = CASE WHEN kv.expires_at IS NOT NULL AND kv.expires_at <= now() THEN ${start}::jsonb ELSE to_jsonb((kv.value #>> '{}')::bigint + ${by}) END,
        expires_at = CASE WHEN kv.expires_at IS NOT NULL AND kv.expires_at <= now() THEN EXCLUDED.expires_at ELSE kv.expires_at END
      RETURNING value`) as { value: number }[];
    return Number(rows[0].value);
  }
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    if (!keys.length) return [];
    await this.init();
    const rows = (await this.sql`SELECT key, value FROM kv WHERE key = ANY(${keys}) AND (expires_at IS NULL OR expires_at > now())`) as { key: string; value: T }[];
    const by = new Map(rows.map((r) => [r.key, r.value]));
    return keys.map((k) => by.get(k) ?? null);
  }
}

/** Build the configured durable store, if any: Upstash first, then Postgres. */
export function durableKV(env: Record<string, string | undefined> = process.env): KV | null {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new UpstashKV(url, token);
  const pg = env.DATABASE_URL || env.POSTGRES_URL;
  if (pg) return new PostgresKV(pg);
  return null;
}

let instance: KV | null = null;

export function getKV(): KV {
  if (instance) return instance;
  const durable = durableKV();
  if (durable) instance = durable;
  else if (!process.env.VERCEL && !process.env.VITEST) instance = new FileKV(process.env.KV_FILE_DIR || path.join(process.cwd(), ".data", "kv"));
  else instance = new MemoryKV();
  return instance;
}

/** Test hook: swap the store (e.g. a fresh MemoryKV per test). */
export function setKV(kv: KV | null) {
  instance = kv;
}

/** KV errors must never break an analysis — reads become misses, writes are dropped. */
export async function kvGet<T>(key: string): Promise<T | null> {
  try {
    return await getKV().get<T>(key);
  } catch (err) {
    console.warn(`[kv] get ${key} failed: ${(err as Error).message}`);
    return null;
  }
}

/** Atomic counter; null when the KV is unavailable (callers fail open). */
export async function kvIncr(key: string, ttlSeconds: number, by = 1): Promise<number | null> {
  try {
    return await getKV().incr(key, ttlSeconds, by);
  } catch (err) {
    console.warn(`[kv] incr ${key} failed: ${(err as Error).message}`);
    return null;
  }
}

/** Several keys at once; on a KV error every key reads as a miss (callers fall back to fetching). */
export async function kvMget<T>(keys: string[]): Promise<(T | null)[]> {
  try {
    return await getKV().mget<T>(keys);
  } catch (err) {
    console.warn(`[kv] mget (${keys.length} keys) failed: ${(err as Error).message}`);
    return keys.map(() => null);
  }
}

export async function kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  try {
    await getKV().set(key, value, ttlSeconds);
  } catch (err) {
    console.warn(`[kv] set ${key} failed: ${(err as Error).message}`);
  }
}
