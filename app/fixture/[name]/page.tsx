import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Report from "@/components/Report";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { SourceStatus, Tier, TokenSnapshot } from "@/lib/types";
import { demoSocial, type SocialDemo } from "@/lib/social/fixtures";

// Test-only: a recorded fixture (tests/fixtures/*.json) rendered through the real result page, so the
// e2e suite can screenshot-diff the hero against fixed data. Exists only where HOODTIER_ALLOW_SIMULATE=1
// (the local e2e server); 404 everywhere else, including production.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Fixture", robots: { index: false } };

const NAMES = new Set(["microduck", "peek", "fartcoin", "offline", "pangea-honeypot", "monad-james"]);
/** Fixtures outside tests/fixtures/ (name → path under tests/fixtures). */
const PATHS: Record<string, string> = { "monad-james": "holders/monad-james.json" };
const TIERS = new Set<Tier>(["S", "A", "B", "C", "D", "F", "U"]);

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function FixturePage({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Search }) {
  if (process.env.HOODTIER_ALLOW_SIMULATE !== "1") notFound();
  const { name } = await params;
  if (!NAMES.has(name)) notFound();
  const sp = await searchParams;
  const fx = JSON.parse(await readFile(path.join(process.cwd(), "tests", "fixtures", PATHS[name] ?? `${name}.json`), "utf8")) as { recordedAt: string; snapshot: TokenSnapshot; sources: SourceStatus[] };
  const scored = scoreSnapshot(fx.snapshot, fx.sources);
  // Layout stress overrides (?tier=&score=&title=): presentation only, the scored report is otherwise untouched.
  const tier = typeof sp.tier === "string" && TIERS.has(sp.tier as Tier) ? (sp.tier as Tier) : scored.tier;
  const score = typeof sp.score === "string" && Number.isFinite(Number(sp.score)) ? Number(sp.score) : scored.score;
  const title = typeof sp.title === "string" ? sp.title.slice(0, 60) : scored.token.name;
  // ?social=null|early|full: the SOCIAL panel in each state (built by the real collectSocial from fixed inputs).
  const socialKind = typeof sp.social === "string" && ["null", "early", "full"].includes(sp.social) ? (sp.social as SocialDemo) : null;
  const social = socialKind ? await demoSocial(socialKind, Date.parse(fx.recordedAt)) : undefined;
  const report = { ...scored, tier, score: tier === "U" ? null : score, generatedAt: fx.recordedAt, token: { ...scored.token, name: title }, ...(social ? { social } : {}) };
  return (
    <div className="space-y-10">
      <Report report={report} cached rawInline />
    </div>
  );
}
