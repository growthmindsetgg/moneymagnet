/**
 * Records live snapshots of the v3 Base / Monad fixtures (tests/fixtures/v3/*.json) so their scoring is
 * tested offline. Usage: node --env-file-if-exists=.env.local --import tsx scripts/record-v3-fixtures.ts [name…]
 * Pauses between tokens (GeckoTerminal 429s after ~30 calls/min; nad.fun keyless is 10/min).
 */
import { writeFileSync } from "node:fs";
import { collect } from "../lib/analyze";
import { V3_FIXTURES } from "../tests/fixtures/v3/addresses";

const only = process.argv.slice(2);
for (const fx of V3_FIXTURES) {
  if (only.length && !only.includes(fx.name)) continue;
  const { snapshot, sources } = await collect(fx.chain, fx.address, { chain: fx.chain });
  writeFileSync(`tests/fixtures/v3/${fx.name}.json`, JSON.stringify({ recordedAt: new Date().toISOString(), note: fx.note, snapshot, sources }, null, 2));
  console.log(fx.name, snapshot.symbol, sources.map((s) => `${s.id}:${s.state}`).join(" "));
  await new Promise((r) => setTimeout(r, 20_000));
}
