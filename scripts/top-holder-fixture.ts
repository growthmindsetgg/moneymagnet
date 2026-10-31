/**
 * Top-holder classification fixture (JAMES on Monad). Prints what the largest holder is — code or no code,
 * signature / label match, deployer or not, where its tokens came from and its whole sell history — then
 * the resulting tier, and records tests/fixtures/holders/monad-james.json.
 * Usage: node --env-file-if-exists=.env.local --import tsx scripts/top-holder-fixture.ts [--no-history]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { analyzeAddress, collect } from "../lib/analyze";
import { archiveRpc, chainRpc } from "../lib/onchain/rpc";
import { archiveWalletHistory } from "../lib/onchain/holderClass";
import { largestHolderLine } from "../lib/holderLine";

const TOKEN = "0x43cf5407bda1400498b8064d50a7e17528d87777";
process.env.HOLDER_CLASS_BUDGET_MS ??= "30000";
const { snapshot: s, sources } = await collect("monad", TOKEN, { chain: "monad" });
const top = s.largestHolder;
if (!top) throw new Error(`no largest holder: ${s.nullReasons.largestHolder}`);
console.log(`JAMES largest holder ${top.address} — ${top.pct?.toFixed(2)}% of supply`);
const code = await chainRpc("monad")<string>("eth_getCode", [top.address, "latest"]);
const nonce = Number(await chainRpc("monad")<string>("eth_getTransactionCount", [top.address, "latest"]));
console.log(`  code: ${code === "0x" ? "none (EOA)" : `${(code.length - 2) / 2} bytes`} · nonce ${nonce}`);
console.log(`  class: ${top.class} — ${top.label}`);
console.log(`  evidence: ${top.evidence}`);
console.log(`  deployer per nad.fun: ${s.deployerAddress}`);
const nf = await fetch(`https://api.nad.fun/agent/swap-history/${TOKEN}?limit=100&account_id=${top.address}`).then((r) => r.json() as Promise<{ swaps: { account_info: { nickname: string }; swap_info: { event_type: string } }[]; total_count: number }>);
const sells = nf.swaps.filter((x) => x.swap_info.event_type === "SELL").length;
console.log(`  nad.fun: nickname "${nf.swaps[0]?.account_info.nickname ?? "?"}", ${nf.total_count} swaps: ${nf.total_count - sells} buys, ${sells} sells`);
if (!process.argv.includes("--no-history")) {
  const archive = archiveRpc("monad")!;
  const head = Number(await archive<string>("eth_blockNumber", []));
  const h = await archiveWalletHistory(archive, TOKEN, top.address, { fromBlock: 85_819_844, head, maxCalls: 20_000, isPool: (a) => s.poolAddresses.includes(a) });
  console.log(`  whole history (${h.calls} archive calls): ${h.toPools} outflows to pools / routers / contracts, ${h.transfersOut} transfers to wallets (${(Number(h.transfersOutRaw / 10n ** 18n) / 1e7).toFixed(2)}% of supply) — ${h.method}${h.reason ? ` — ${h.reason}` : ""}`);
}
for (const h of s.holderClasses.filter((x) => x.address !== top.address)) console.log(`  also top-5: ${h.address} ${h.pct?.toFixed(2)}% ${h.label}${h.counted ? "" : " (excluded)"}`);
console.log(largestHolderLine(top));
console.log(`  founderNeverSold ${s.founderNeverSold} · founderSold ${s.founderSold} · top1 ${s.top1SharePct} · top10 ${s.top10SharePct}`);
mkdirSync("tests/fixtures/holders", { recursive: true });
writeFileSync("tests/fixtures/holders/monad-james.json", JSON.stringify({ recordedAt: new Date().toISOString(), note: "JAMES: 61.1% held by an EOA funded by the creation-tx sender (not the deployer); two Safe 6/8 treasuries in the top 5", snapshot: s, sources }, null, 2));
const r = await analyzeAddress(TOKEN, { chain: "monad" });
console.log(`tier ${r.tier} ${r.score} — ${r.binding?.text}`);
