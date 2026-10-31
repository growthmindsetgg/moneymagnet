// Tiny stdio-MCP → HTTP bridge, for intel feeds that only ship as an MCP server.
// It spawns the MCP server, then serves GET /intel, /holders, /curve and /trades (?mint=<mint>),
// each mapped to one MCP tool. Point HoodTier at it with PUMPFUN_FEED_URL=http://host:PORT.
//
//   MCP_COMMAND="npx -y <your-pumpfun-mcp-package>" \
//   BRIDGE_TOOLS='{"intel":"<tool>","holders":"<tool>","curve":"<tool>","trades":"<tool>"}' \
//   BRIDGE_ARG=mint BRIDGE_KEY=<optional shared secret> PORT=8787 node scripts/mcp-bridge.mjs
//
// The MCP server's own env (API keys) is inherited from this process. Responses are passed
// through as-is: HoodTier only uses fields that are actually present.
import { spawn } from "node:child_process";
import http from "node:http";

const command = process.env.MCP_COMMAND;
if (!command) {
  console.error("Set MCP_COMMAND to the command that starts the MCP server (stdio).");
  process.exit(1);
}
const tools = JSON.parse(process.env.BRIDGE_TOOLS ?? "{}");
const argName = process.env.BRIDGE_ARG ?? "mint";
const port = Number(process.env.PORT ?? 8787);
const key = process.env.BRIDGE_KEY;

const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let nextId = 1;
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    } catch {
      // non-JSON log line from the server — ignore
    }
  }
});
child.on("exit", (code) => {
  console.error(`MCP server exited (${code})`);
  process.exit(1);
});

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error("MCP timeout"))), 30_000);
  });
}

await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hoodtier-bridge", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const listed = await rpc("tools/list", {});
console.error(`MCP tools: ${listed.tools.map((t) => t.name).join(", ")}`);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const route = url.pathname.replace(/^\//, "");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (key && req.headers.authorization !== `Bearer ${key}`) return send(401, { error: "unauthorized" });
    const tool = tools[route];
    if (!tool) return send(404, { error: `no tool mapped for /${route}`, mapped: tools });
    const mint = url.searchParams.get("mint");
    if (!mint) return send(400, { error: "mint required" });
    try {
      const result = await rpc("tools/call", { name: tool, arguments: { [argName]: mint } });
      if (result.structuredContent) return send(200, result.structuredContent);
      const text = (result.content ?? []).map((c) => c.text).join("\n");
      try {
        return send(200, JSON.parse(text));
      } catch {
        return send(200, { text });
      }
    } catch (e) {
      return send(502, { error: e.message });
    }
  })
  .listen(port, () => console.error(`bridge on http://localhost:${port}`));
