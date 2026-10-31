/**
 * Rebuilds tokens' own history with the library-build budgets and caches it in KV, so their
 * token pages show the Time Machine at full depth (requests use smaller budgets).
 *   pnpm timemachine:prewarm <address…>   (defaults to the four fixtures)
 */
import { detectChain, normalizeAddress } from "../lib/chain";
import { reconstructToken, saveTokenReconstruction } from "../lib/timemachine";
import { FIXTURES } from "../tests/fixtures/addresses";

const list = process.argv.slice(2).length ? process.argv.slice(2) : FIXTURES.map((f) => f.address);
for (const input of list) {
  const chain = detectChain(input);
  if (!chain) continue;
  const address = normalizeAddress(chain, input);
  try {
    const rec = await reconstructToken(chain, address, 72, { maxTx: Number(process.env.TM_MAX_TX || 4000), maxLogs: Number(process.env.TM_MAX_LOGS || 400_000) });
    await saveTokenReconstruction(rec);
    console.log(`${rec.symbol ?? address}: ${rec.buckets.map((b) => `+${b.bucket}h ${Object.values(b.fields).filter((v) => v != null).length} fields`).join(" · ")} (${rec.buildMs}ms) ${rec.notes.join("; ")}`);
  } catch (e) {
    console.log(`${address}: failed — ${(e as Error).message}`);
  }
}
