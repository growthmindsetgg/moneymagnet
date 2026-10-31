// v3 §1d distribution check for Base and Monad (same bars as scripts/distribution.ts):
//   junk  = the newest GeckoTerminal pools' base tokens  → ≤ 10% of rated tokens may land A/S;
//   good  = the top GeckoTerminal pools by 24h volume, memes with ≥ $100k liquidity and ≥ 72h → ≥ 30% A/S.
//   node --env-file-if-exists=.env.local --import tsx scripts/v3-distribution.ts [perChainJunk=20] [perChainGood=10]
// Saves every scored row to docs/chains/v3-distribution.json.
import { writeFileSync } from "node:fs";
import { collect } from "@/lib/analyze";
import { eligibility, knownNonMeme } from "@/lib/memeFilter";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { Chain } from "@/lib/types";

const JUNK = Number(process.argv[2] ?? 20);
const GOOD = Number(process.argv[3] ?? 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface GtPool {
  attributes: { reserve_in_usd: string; pool_created_at: string; volume_usd: { h24: string } };
  relationships: { base_token: { data: { id: string } } };
}
async function gt(path: string): Promise<GtPool[]> {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`https://api.geckoterminal.com/api/v2${path}`, { headers: { accept: "application/json" } });
    if (res.status === 429) {
      await sleep(30_000);
      continue;
    }
    return ((await res.json()) as { data?: GtPool[] }).data ?? [];
  }
  return [];
}
const tokenOf = (p: GtPool) => p.relationships.base_token.data.id.split("_").slice(1).join("_").toLowerCase();

const rows: { chain: Chain; group: "junk" | "good"; address: string; tier?: string; score?: number | null; rejected?: string; binding?: string; fdv?: number | null }[] = [];
for (const chain of ["base", "monad"] as Chain[]) {
  const fresh = [...(await gt(`/networks/${chain}/new_pools?page=1`)), ...(await gt(`/networks/${chain}/new_pools?page=2`))];
  await sleep(4_000);
  const top = [...(await gt(`/networks/${chain}/pools?page=1&sort=h24_volume_usd_desc`)), ...(await gt(`/networks/${chain}/pools?page=2&sort=h24_volume_usd_desc`))];
  const seen = new Set<string>();
  const pick = (pools: GtPool[], n: number, ok: (p: GtPool) => boolean) =>
    pools.filter((p) => ok(p) && !seen.has(tokenOf(p)) && !knownNonMeme(chain, tokenOf(p)) && (seen.add(tokenOf(p)), true)).slice(0, n).map(tokenOf);
  const old = (p: GtPool) => Date.now() - Date.parse(p.attributes.pool_created_at) >= 72 * 3_600_000;
  for (const address of pick(top, GOOD, (p) => Number(p.attributes.reserve_in_usd) >= 100_000 && old(p))) rows.push({ chain, group: "good", address });
  for (const address of pick(fresh, JUNK, () => true)) rows.push({ chain, group: "junk", address });
}
console.log(`sample: ${rows.filter((r) => r.group === "junk").length} junk, ${rows.filter((r) => r.group === "good").length} good`);
for (const r of rows) {
  try {
    const { snapshot, sources } = await collect(r.chain, r.address, { chain: r.chain });
    const meme = eligibility(snapshot);
    if (!meme.meme) r.rejected = meme.rejected ?? meme.reason ?? "not a meme";
    else {
      const s = scoreSnapshot(snapshot, sources);
      Object.assign(r, { tier: s.tier, score: s.score, binding: s.binding?.text, fdv: snapshot.fdvUsd });
    }
  } catch (e) {
    r.rejected = `error: ${(e as Error).message.slice(0, 80)}`;
  }
  console.log(`${r.chain.padEnd(5)} ${r.group.padEnd(4)} ${r.address} ${r.tier ?? "—"} ${r.score ?? ""} ${r.rejected ?? r.binding ?? ""}`);
  await sleep(6_000);
}
writeFileSync("docs/chains/v3-distribution.json", JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2));
for (const chain of ["base", "monad", "both"]) {
  const of = (g: string) => rows.filter((r) => r.group === g && (chain === "both" || r.chain === chain) && r.tier && r.tier !== "U");
  const share = (xs: typeof rows) => (xs.length ? Math.round((xs.filter((r) => r.tier === "A" || r.tier === "S").length / xs.length) * 100) : null);
  const junk = of("junk");
  const good = of("good");
  console.log(`${chain}: junk A/S ${share(junk)}% of ${junk.length} rated (bar ≤ 10%) · good A/S ${share(good)}% of ${good.length} rated (bar ≥ 30%)`);
}
