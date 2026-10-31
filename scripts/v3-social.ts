// pnpm tsx scripts/v3-social.ts <chain> <address…> — the SOCIAL panel for each token, live (records one sample).
import { collectSocial } from "@/lib/social";
import { dexscreener } from "@/lib/sources/dexscreener";
import type { Chain } from "@/lib/types";

const [chain, ...addrs] = process.argv.slice(2) as [Chain, ...string[]];
for (const a of addrs) {
  const ds = await dexscreener(chain, a).catch(() => null);
  const createdAt = (ds?.data.createdAt as string | undefined) ?? null;
  const p = await collectSocial(chain, a, { createdAt, ageHours: createdAt ? (Date.now() - Date.parse(createdAt)) / 3.6e6 : null, symbol: (ds?.data.symbol as string) ?? null }, ds?.raw);
  console.log(`\n${chain}:${a}`);
  console.log("  sources:", p.sources.map((s) => `${s.label} [${s.state}] ${s.message?.slice(0, 120)}`).join("\n           "));
  console.log("  posts24h", p.posts24h, "· uniquePosters24h", p.uniquePosters24h, "· top", JSON.stringify(p.topAccounts), "· first call", p.firstCallAt, p.firstCallVsLaunchMin, "min vs launch");
  console.log("  stage", p.badge ?? "—", "| verdict", p.verdict, "| quality", p.quality.score, "| samples", p.samples, "| spent $", p.spentUsd);
  console.log("  warnings", p.warnings.map((w) => w.text));
  console.log("  null:", JSON.stringify(p.nullReasons).slice(0, 700));
}
