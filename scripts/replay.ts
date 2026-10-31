/**
 * Runs (or resumes) the full Transfer-log replay for a Robinhood Chain token and stores it in the
 * configured KV (Upstash when KV_REST_API_URL/TOKEN are set, else .data/kv). Use it to pre-warm
 * tokens so the first web request doesn't have to replay from scratch.
 *   pnpm replay 0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725
 */
import { getKV, kvGet, kvSet } from "../lib/kv";
import { findCreation, type Creation } from "../lib/onchain/creation";
import { creationKey, replayKey } from "../lib/onchain/keys";
import { advanceReplay, newReplayState, replayProgressPct, type ReplayState } from "../lib/onchain/replay";
import { makeRpc } from "../lib/onchain/rpc";

const token = (process.argv[2] ?? "").toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error("usage: pnpm replay <0x token address>");
const rpc = makeRpc();
console.log(`KV: ${getKV().kind}`);
const head = Number(await rpc<string>("eth_blockNumber", []));
let creation = await kvGet<Creation>(creationKey(token));
if (!creation) {
  creation = await findCreation(rpc, token, head);
  if (!creation) throw new Error("no mint found");
  await kvSet(creationKey(token), creation);
}
console.log(`creation block ${creation.creationBlock}, deployer ${creation.deployer}, head ${head}`);
let state = (await kvGet<ReplayState>(replayKey(token))) ?? newReplayState(token, creation.creationBlock);
const t0 = Date.now();
let stalls = 0;
while (state.scannedTo < head && stalls < 5) {
  const before = state.scannedTo;
  state = await advanceReplay(rpc, state, head, {
    budgetMs: 60_000,
    onProgress: (s) =>
      process.stdout.write(`\r  ${replayProgressPct(s, head).toFixed(1)}%  logs=${s.logCount}  chunk=${s.chunk}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `),
  });
  await kvSet(replayKey(token), state);
  stalls = state.scannedTo === before ? stalls + 1 : 0;
  if (state.lastError) process.stdout.write(`
  (rpc: ${state.lastError})
`);
}
console.log(`\nDONE logs=${state.logCount} holders=${Object.keys(state.balances).length} replayMs=${state.replayMs} wall=${Date.now() - t0}ms complete=${state.complete}`);
