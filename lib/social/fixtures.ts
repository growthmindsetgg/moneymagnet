import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectSocial, type SocialPanel } from "./index";
import { parseReportSocial, type RobinxSocial } from "./robinx";
import type { SeriesStore } from "./series";
import type { SocialSample } from "./stage";
import type { OfficialLinks } from "./links";

/**
 * Test-only (the /fixture page, HOODTIER_ALLOW_SIMULATE=1): the SOCIAL panel built by the real
 * collectSocial from recorded / synthetic inputs, in three states — every source null, an early read
 * (one sample), and a full 30-day series. Never used for a live token.
 */
export type SocialDemo = "null" | "early" | "full";

const H = 3_600_000;

class FixedStore implements SeriesStore {
  readonly kind = "kv" as const;
  constructor(private samples: SocialSample[]) {}
  async add(_c: string, _a: string, s: SocialSample) {
    if (!this.samples.some((x) => x.ts === s.ts)) this.samples.push(s);
  }
  async list() {
    return this.samples;
  }
  async track() {}
  async due() {
    return [];
  }
  async markSampled() {}
  async prune() {
    return 0;
  }
}

export async function demoSocial(kind: SocialDemo, now: number): Promise<SocialPanel> {
  const recorded = JSON.parse(await readFile(path.join(process.cwd(), "tests", "fixtures", "robinx-report-microduck.json"), "utf8")) as { body: unknown };
  const rx: RobinxSocial = {
    ...parseReportSocial(recorded.body),
    uniquePosters24h: null,
    reach24h: null,
    coordinatedShare: 0.25,
    tg: null,
    calls: [{ endpoint: "/report?tier=free", tier: "free", usd: 0, status: 200 }],
    spentUsd: 0,
    nullReasons: { uniquePosters24h: "RobinX /mentions ($0.02) not called: ROBINX_WALLET_KEY not set (paid RobinX calls disabled)" },
    fetchedAt: new Date(now).toISOString(),
  };
  const links: OfficialLinks = { x: "https://x.com/MicroDuckNVDA", telegram: null, websites: ["https://microduck.net/"], xCommunity: null, boosted: false, boostsActive: 0, sources: ["DexScreener", "GeckoTerminal"], nullReasons: {} };
  const series: SocialSample[] =
    kind === "full"
      ? Array.from({ length: 60 }, (_, i) => {
          const m = Math.round(20 + 200 * Math.sin((Math.PI * i) / 90) ** 2);
          return { ts: new Date(now - (59 - i) * 12 * H).toISOString(), posts24h: m, uniquePosters24h: null, reach24h: null, sentiment: null, botShare: null, quality: 55, source: "robinx" };
        })
      : [];
  if (kind === "null")
    return collectSocial("solana", "So1Demo", { createdAt: null, ageHours: 100, symbol: "DEMO" }, undefined, {
      links: async () => ({ x: null, telegram: null, websites: [], xCommunity: null, boosted: null, boostsActive: null, sources: [], nullReasons: { links: "neither DexScreener nor GeckoTerminal answered" } }),
      store: new FixedStore([]),
      library: [],
      now,
      record: false,
    });
  return collectSocial("robinhood", "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725", { createdAt: "2026-08-27T12:13:50Z", ageHours: 1500, symbol: "microduck" }, undefined, {
    robinx: async () => rx,
    links: async () => links,
    store: new FixedStore(series),
    library: [],
    now,
  });
}
