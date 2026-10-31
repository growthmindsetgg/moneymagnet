/**
 * Records live, normalized TokenSnapshots for the fixture tokens so scoring tests run offline.
 * Usage: pnpm record:fixtures   (pauses between tokens to respect GeckoTerminal's rate limit)
 */
import { writeFileSync } from "node:fs";
import { collect, detectChain, normalizeAddress } from "../lib/analyze";
import { FIXTURES } from "../tests/fixtures/addresses";

const only = process.argv.slice(2);
for (const fx of FIXTURES) {
  if (only.length && !only.includes(fx.name)) continue;
  const chain = detectChain(fx.address)!;
  const { snapshot, sources } = await collect(chain, normalizeAddress(chain, fx.address));
  const out = { recordedAt: new Date().toISOString(), note: fx.note, snapshot, sources };
  writeFileSync(`tests/fixtures/${fx.name}.json`, JSON.stringify(out, null, 2));
  console.log(fx.name, snapshot.symbol, sources.map((s) => `${s.id}:${s.state}`).join(" "));
  await new Promise((r) => setTimeout(r, 25_000));
}
