/**
 * Holder Strength for one token, live: the score, label, the three sentences and every component's evidence.
 * Usage: node --env-file-if-exists=.env.local --import tsx scripts/holder-strength.ts <address> [chain]
 */
import { collect } from "../lib/analyze";
import { holderStrength } from "../lib/holderStrengthData";
import type { AdapterResult } from "../lib/types";
import { scoreSnapshot } from "../lib/scoring/engine";
import type { Chain } from "../lib/types";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [address, chain] = args as [string, Chain | undefined];
const passes = Number(process.argv.find((a) => a.startsWith("--passes="))?.slice(9) ?? 3);
if (!address) throw new Error("usage: holder-strength.ts <address> [chain]");
const { snapshot: s, sources, raw } = await collect(chain ?? (address.startsWith("0x") ? "robinhood" : "solana"), address, chain ? { chain } : {});
// Outside the request budget: up to 3 more passes of 50s each, resuming the saved ledgers, until complete.
let hs = s.holderStrengthDetail;
const results = Object.entries(raw).map(([id, r]) => ({ status: { id }, raw: r, data: {} }) as unknown as AdapterResult);
for (let pass = 0; pass < passes && (!hs || hs.score == null) && s.ageHours != null && s.ageHours >= 72; pass++) {
  hs = await holderStrength(s.chain, address, s, results, Date.now() + 50_000);
  console.log(`  pass ${pass + 1}: ${hs.score ?? "null"} ${hs.nullReason ?? ""}`);
}
if (hs) Object.assign(s, { holderStrengthDetail: hs, holderStrength: hs.score, holderStrengthLabel: hs.label });
console.log(`${s.symbol ?? address} (${s.chain}, ${s.ageHours != null ? Math.round(s.ageHours / 24) : "?"}d)`);
console.log(`  largest holder: ${s.largestHolder ? `${s.largestHolder.label} ${s.largestHolder.pct?.toFixed(1)}% (${s.largestHolder.detail ?? ""})` : `none — ${s.nullReasons.largestHolder}`}`);
if (!hs) console.log(`  Holder Strength: null — ${s.nullReasons.holderStrength}`);
else {
  console.log(`  Holder Strength: ${hs.score ?? "null"} ${hs.label ?? ""}${hs.nullReason ? ` — ${hs.nullReason}` : ""}`);
  console.log(`  method: ${hs.method}`);
  for (const c of hs.components) console.log(`  · ${c.label} (${c.weight}): ${c.score == null ? "—" : c.score.toFixed(2)} — ${c.evidence}`);
  for (const x of hs.sentences) console.log(`  » ${x}`);
  for (const k of hs.keyPerson) console.log(`  key person: ${k}`);
  for (const e of hs.excluded) console.log(`  excluded: ${e.address} ${e.pct.toFixed(2)}% (${e.why})`);
}
const r = scoreSnapshot(s, sources);
console.log(`  tier ${r.tier} ${r.score} (raw ${r.rawScore}, coverage ${r.coveragePct}%) — ${r.binding?.text}`);
