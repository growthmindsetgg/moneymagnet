/**
 * Adds live Holder Strength to recorded fixtures without re-recording the rest of the snapshot (the other values,
 * and the tests built on them, stay as recorded). The fixture's note says when the Holder Strength was taken.
 * Usage: node --env-file-if-exists=.env.local --import tsx scripts/record-holder-strength.ts microduck fartcoin
 */
import { readFileSync, writeFileSync } from "node:fs";
import { collect } from "../lib/analyze";
import { holderStrength } from "../lib/holderStrengthData";
import type { AdapterResult, TokenSnapshot } from "../lib/types";

const FIELDS = ["holderStrength", "holderStrengthLabel", "holderStrengthDetail", "holderStrengthPending", "vestingDiamond"] as const;

for (const name of process.argv.slice(2)) {
  const file = `tests/fixtures/${name}.json`;
  const fx = JSON.parse(readFileSync(file, "utf8")) as { recordedAt: string; note: string; snapshot: TokenSnapshot; sources: unknown[]; holderStrengthRecordedAt?: string };
  const s0 = fx.snapshot;
  const { snapshot: live, raw } = await collect(s0.chain, s0.address, { chain: s0.chain });
  // Outside the request budget: resume the saved ledgers until complete (up to 4 passes of 50s).
  const results = Object.entries(raw).map(([id, r]) => ({ status: { id }, raw: r, data: {} }) as unknown as AdapterResult);
  for (let pass = 0; pass < 4 && live.holderStrength == null && live.ageHours != null && live.ageHours >= 72 && live.holderStrengthPending !== false; pass++) {
    const hs = await holderStrength(live.chain, live.address, live, results, Date.now() + 50_000);
    Object.assign(live, { holderStrengthDetail: hs, holderStrength: hs.score, holderStrengthLabel: hs.label, holderStrengthPending: hs.score == null && hs.pending === true });
    if (hs.score == null) live.nullReasons = { ...live.nullReasons, holderStrength: hs.nullReason ?? "not enough holder history" };
  }
  for (const k of FIELDS) (s0 as unknown as Record<string, unknown>)[k] = (live as unknown as Record<string, unknown>)[k] ?? null;
  s0.nullReasons = { ...s0.nullReasons, ...(live.nullReasons.holderStrength ? { holderStrength: live.nullReasons.holderStrength } : {}) };
  if (live.holderStrength != null) delete s0.nullReasons.holderStrength;
  fx.holderStrengthRecordedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(fx, null, 2));
  console.log(`${name}: Holder Strength ${s0.holderStrength ?? "null"} ${s0.holderStrengthLabel ?? ""}${s0.holderStrength == null ? ` — ${s0.nullReasons.holderStrength}` : ""}`);
  for (const x of s0.holderStrengthDetail?.sentences ?? []) console.log(`  » ${x}`);
}
