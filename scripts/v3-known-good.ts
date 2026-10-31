// v3 §1d known-good check: well-known Base / Monad memes (≥ $25k liquidity, ≥ 72h), addresses picked live
// on 2026-10-29 from DexScreener search (deepest pair on the chain). Bar: ≥ 30% of rated tokens land A/S.
//   node --env-file-if-exists=.env.local --import tsx scripts/v3-known-good.ts
import { collect } from "@/lib/analyze";
import { eligibility } from "@/lib/memeFilter";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { Chain } from "@/lib/types";

const LIST: [Chain, string, string][] = [
  ["base", "BRETT", "0x532f27101965dd16442e59d40670faf5ebb142e4"],
  ["base", "TOSHI", "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4"],
  ["base", "DEGEN", "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"],
  ["base", "MIGGLES", "0xb1a03eda10342529bbf8eb700a06c60441fef25d"],
  ["base", "KEYCAT", "0x9a26f5433671751c3276a065f57e5a02d2817973"],
  ["base", "SKI", "0x768be13e1680b5ebe0024c42c896e3db59ec0149"],
  ["base", "doginme", "0x6921b130d297cc43754afba22e5eac0fbf8db75b"],
  ["base", "BENJI", "0xbc45647ea894030a4e9801ec03479739fa2485f0"],
  ["base", "TYBG", "0x0d97f261b1e88845184f678e2d1e7a98d9fd38de"],
  ["base", "NORMIE", "0x47b464edb8dc9bc67b5cd4c9310bb87b773845bd"],
  ["monad", "CHOG", "0x350035555e10d9afaf1566aaebfced5ba6c27777"],
  ["monad", "MOLANDAK", "0x7b2728c04ad436153285702e969e6efac3a97777"],
  ["monad", "emo", "0x81a224f8a62f52bde942dbf23a56df77a10b7777"],
  ["monad", "JAMES", "0x43cf5407bda1400498b8064d50a7e17528d87777"],
  ["monad", "shramp", "0x42a4aa89864a794de135b23c6a8d2e05513d7777"],
];
const out: { chain: Chain; name: string; tier: string }[] = [];
for (const [chain, name, address] of LIST) {
  const { snapshot, sources } = await collect(chain, address, { chain });
  const meme = eligibility(snapshot);
  const r = scoreSnapshot(snapshot, sources);
  const tier = meme.meme ? r.tier : "rejected";
  out.push({ chain, name, tier });
  console.log(`${chain.padEnd(5)} ${name.padEnd(9)} ${tier} ${r.score ?? ""} cov ${r.coveragePct}% · ${meme.meme ? r.binding?.text : meme.rejected}`);
  await new Promise((res) => setTimeout(res, 7_000));
}
for (const c of ["base", "monad", "both"]) {
  const rated = out.filter((x) => (c === "both" || x.chain === c) && /^[SABCDF]$/.test(x.tier));
  const as = rated.filter((x) => x.tier === "A" || x.tier === "S").length;
  console.log(`${c}: ${as}/${rated.length} A/S = ${rated.length ? Math.round((as / rated.length) * 100) : 0}% (bar ≥ 30%)`);
}
