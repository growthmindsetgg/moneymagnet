// Probes public Robinhood Chain (4663) RPC endpoints: chain id, head, eth_getLogs span, state-override
// eth_call, latency, and the 429 rate under a 20-request burst. Writes data/rpc-endpoints.json.
//   node scripts/probe-rpcs.mjs
import { writeFileSync } from "node:fs";
const CANDIDATES = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood-rpc.publicnode.com",
  "https://robinhood.drpc.org",
  "https://robinhood.rpc.blxrbdn.com",
  "https://robinhood.api.pocket.network",
  "https://lb.routeme.sh/rpc/evm/4663",
  "https://rpc.nodeflare.app/robinhood/public",
  "https://rpc-robinhood.blockmachine.io",
  "https://rpc.ordofi.network",
  "https://rpc-robinhood.globalstake.io",
  "https://robinhood-mainnet.gateway.tatum.io",
  "https://robinhood.daybreak-rpc.network",
  "https://4663.rpc.thirdweb.com",
  "https://robinhood-mainnet-rpc.blockreq.com/v1/rpc/public",
  "https://api.blockvectra.com/v1/robinhood_mainnet/public",
];
const TOKEN = "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
async function rpc(url, method, params, timeout = 15000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, ms };
    const j = await r.json();
    return j.error ? { ok: false, error: j.error.message?.slice(0, 80), ms } : { ok: true, result: j.result, ms };
  } catch (e) {
    return { ok: false, error: String(e.name === "TimeoutError" ? "timeout" : e.message).slice(0, 60), ms: Date.now() - t0 };
  }
}
const out = [];
for (const url of CANDIDATES) {
  const id = await rpc(url, "eth_chainId", []);
  if (!id.ok || parseInt(id.result, 16) !== 4663) {
    console.log("✗", url, id.ok ? `chainId ${id.result}` : id.error ?? `HTTP ${id.status}`);
    continue;
  }
  const head = await rpc(url, "eth_blockNumber", []);
  const h = parseInt(head.result, 16);
  const logs = await rpc(url, "eth_getLogs", [{ address: TOKEN, topics: [TRANSFER], fromBlock: "0x" + (h - 20000).toString(16), toBlock: "0x" + h.toString(16) }], 20000);
  const override = await rpc(url, "eth_call", [{ to: "0x00000000000000000000000000000000000c0de4", data: "0x" }, "latest", { "0x00000000000000000000000000000000000c0de4": { code: "0x602a60005260206000f3" } }]);
  const storage = await rpc(url, "eth_getStorageAt", ["0x8366a39cc670b4001a1121b8f6a443a643e40951", "0x0", "latest"]);
  // Burst: 20 concurrent eth_blockNumber.
  const burst = await Promise.all(Array.from({ length: 20 }, () => rpc(url, "eth_blockNumber", [], 10000)));
  const r429 = burst.filter((b) => b.status === 429 || /rate|limit|429/i.test(b.error ?? "")).length;
  const row = {
    url,
    head: h,
    latencyMs: head.ms,
    getLogs: logs.ok ? `ok (${logs.result.length} logs / 20k blocks)` : (logs.error ?? `HTTP ${logs.status}`),
    stateOverride: override.ok && override.result?.endsWith("2a"),
    getStorageAt: storage.ok,
    burst429: `${r429}/20`,
    burstOk: burst.filter((b) => b.ok).length,
  };
  out.push(row);
  console.log("✓", JSON.stringify(row));
}
const usable = out.filter((r) => r.getLogs.startsWith("ok") && r.stateOverride);
writeFileSync(
  "data/rpc-endpoints.json",
  JSON.stringify(
    {
      note: "Public Robinhood Chain (4663) RPC endpoints, probed " + new Date().toISOString() + " (scripts/probe-rpcs.mjs). Rotated on 429/5xx with a per-endpoint cooldown; ROBINHOOD_RPC_URL goes first when set. 'logs' = supports eth_getLogs; 'override' = supports eth_call state overrides (needed by the sell simulation).",
      endpoints: out.map((r) => ({ url: r.url, logs: r.getLogs.startsWith("ok"), override: r.stateOverride, storage: r.getStorageAt, latencyMs: r.latencyMs, burst429: r.burst429 })),
    },
    null,
    1,
  ),
);
console.log(`\n${out.length} endpoints answer for 4663, ${usable.length} support logs + state override`);
