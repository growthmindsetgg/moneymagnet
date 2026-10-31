import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { durableKV, FileKV, MemoryKV, type KV } from "@/lib/kv";

/**
 * One contract every store must pass. The durable store (Upstash or Postgres) runs when its env is
 * present — `pnpm verify:kv` loads .env.local and runs this file against the real backend.
 */
const durable = durableKV();
const stores: [string, () => KV][] = [
  ["memory", () => new MemoryKV()],
  ["file", () => new FileKV(mkdtempSync(path.join(os.tmpdir(), "kv-")))],
];
if (durable) stores.push([durable.kind, () => durable]);

describe.each(stores)("KV contract: %s", (_name, make) => {
  const ns = `contract:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  it("missing keys read as null", async () => {
    expect(await make().get(`${ns}:missing`)).toBeNull();
  });

  it("round-trips JSON values of every shape", async () => {
    const kv = make();
    const value = { n: 1.5, s: "x", b: false, nil: null, arr: [1, "two", { three: 3 }], nested: { deep: { ok: true } } };
    await kv.set(`${ns}:obj`, value);
    expect(await kv.get(`${ns}:obj`)).toEqual(value);
    await kv.set(`${ns}:num`, 42);
    expect(await kv.get(`${ns}:num`)).toBe(42);
    await kv.set(`${ns}:str`, "hello");
    expect(await kv.get(`${ns}:str`)).toBe("hello");
  });

  it("overwrites an existing key", async () => {
    const kv = make();
    await kv.set(`${ns}:ow`, { v: 1 });
    await kv.set(`${ns}:ow`, { v: 2 });
    expect(await kv.get(`${ns}:ow`)).toEqual({ v: 2 });
  });

  it("expires keys after their TTL", async () => {
    const kv = make();
    await kv.set(`${ns}:ttl`, "soon gone", 1);
    expect(await kv.get(`${ns}:ttl`)).toBe("soon gone");
    await new Promise((r) => setTimeout(r, 2100));
    expect(await kv.get(`${ns}:ttl`)).toBeNull();
  }, 10_000);

  it("a set without TTL clears a previous TTL", async () => {
    const kv = make();
    await kv.set(`${ns}:keep`, "a", 1);
    await kv.set(`${ns}:keep`, "b");
    await new Promise((r) => setTimeout(r, 1500));
    expect(await kv.get(`${ns}:keep`)).toBe("b");
  }, 10_000);
});

describe.each(stores)("KV contract (counters): %s", (_name, make) => {
  const ns = `contract-incr:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  it("incr is atomic under concurrency and starts at 1", async () => {
    const kv = make();
    const results = await Promise.all(Array.from({ length: 10 }, () => kv.incr(`${ns}:c`, 60)));
    expect(results.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await kv.get(`${ns}:c`)).toBe(10);
  });
  it("an expired counter restarts at 1", async () => {
    const kv = make();
    await kv.incr(`${ns}:e`, 1);
    await kv.incr(`${ns}:e`, 1);
    await new Promise((r) => setTimeout(r, 2100));
    expect(await kv.incr(`${ns}:e`, 1)).toBe(1);
  }, 10_000);
});

describe("durable store selection", () => {
  it("prefers Upstash, falls back to Postgres, else none", () => {
    expect(durableKV({ UPSTASH_REDIS_REST_URL: "https://x", UPSTASH_REDIS_REST_TOKEN: "t", DATABASE_URL: "postgres://u:p@h/db" })?.kind).toBe("upstash");
    expect(durableKV({ DATABASE_URL: "postgres://u:p@h/db" })?.kind).toBe("postgres");
    expect(durableKV({})).toBeNull();
  });
});
