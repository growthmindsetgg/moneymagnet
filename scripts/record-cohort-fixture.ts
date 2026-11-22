// Records the GeckoTerminal responses behind one peer cohort (relative strength 7d) into tests/fixtures/cohort/, so the
// unit tests replay them without network:
//   node --import tsx scripts/record-cohort-fixture.ts <chain> <dex|-> [name]
// Calls are paced (one at a time, 2.5s apart) to stay inside GeckoTerminal's public rate limit. Only the fields the
// cohort reads are kept.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchCohort } from "@/lib/cohort";
import { fetchJson } from "@/lib/sources/http";
import type { Chain } from "@/lib/types";

const [chain, dexArg, name] = process.argv.slice(2) as [Chain, string, string | undefined];
const dex = !dexArg || dexArg === "-" ? null : dexArg;
const responses: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-explicit-any */
const trim = (url: string, body: any) => {
  if (url.includes("/ohlcv/")) return { data: { attributes: { ohlcv_list: body?.data?.attributes?.ohlcv_list ?? [] } } };
  return {
    data: (body?.data ?? []).map((p: any) => ({
      attributes: { name: p.attributes.name, address: p.attributes.address, reserve_in_usd: p.attributes.reserve_in_usd, pool_created_at: p.attributes.pool_created_at },
      relationships: { base_token: { data: { id: p.relationships?.base_token?.data?.id } } },
    })),
  };
};

const now = Date.now();
const get = async <T,>(url: string): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    await sleep(attempt ? 20_000 : 2_500);
    try {
      const body = await fetchJson(url, { timeoutMs: 15_000 });
      responses[url] = trim(url, body);
      return responses[url] as T;
    } catch (e) {
      // The public quota is shared: wait out a 429 a few times before giving up.
      if (attempt >= 5 || !/\b429\b/.test((e as Error).message)) throw e;
    }
  }
};

const cohort = await fetchCohort(chain, dex, { get, now, concurrency: 1 });
const dir = path.join(process.cwd(), "tests", "fixtures", "cohort");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${name ?? `${chain}-${dex ?? "chain"}`}.json`);
writeFileSync(file, JSON.stringify({ recordedAt: new Date(now).toISOString(), now, chain, dex, expected: { scope: cohort.scope, label: cohort.label, median: cohort.median, size: cohort.peers.length }, responses }, null, 2) + "\n");
console.log(`${file}: ${cohort.label} — median ${cohort.median.toFixed(2)}% across ${cohort.peers.length} peers`);
