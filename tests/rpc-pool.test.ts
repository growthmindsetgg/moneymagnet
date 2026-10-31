import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRpc, resetRpcPool, rpcStats } from "@/lib/onchain/rpc";
import endpoints from "@/data/rpc-endpoints.json";

const LOGS = endpoints.endpoints.filter((e) => e.logs === "full").map((e) => e.url);

describe("Robinhood RPC endpoint pool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRpcPool();
  });

  it("lists the probed public endpoints, at least two with full eth_getLogs", () => {
    expect(endpoints.endpoints.length).toBeGreaterThanOrEqual(5);
    expect(LOGS.length).toBeGreaterThanOrEqual(2);
    expect(LOGS).toContain("https://rpc.mainnet.chain.robinhood.com");
  });

  it("rotates away from an endpoint that answers 429 and cools it down", async () => {
    resetRpcPool();
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      hits.push(url);
      if (url === hits[0] && hits.length === 1) return new Response("Too Many Requests", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }), { status: 200 });
    });
    const rpc = makeRpc();
    expect(await rpc<string>("eth_blockNumber", [])).toBe("0x10");
    expect(hits.length).toBe(2);
    expect(hits[1]).not.toBe(hits[0]);
    expect(rpcStats[hits[0]].r429).toBe(1);
    // The cooled endpoint is skipped while others are healthy.
    for (let i = 0; i < 8; i++) await rpc("eth_blockNumber", []);
    expect(hits.slice(2)).not.toContain(hits[0]);
  });

  it("sends eth_getLogs only to full-log endpoints", async () => {
    resetRpcPool();
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      hits.push(url);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
    });
    const rpc = makeRpc();
    for (let i = 0; i < 6; i++) await rpc("eth_getLogs", [{}]);
    expect(hits.every((u) => LOGS.includes(u))).toBe(true);
    expect(new Set(hits).size).toBe(LOGS.length); // load is shared
  });

  it("returns JSON-RPC errors (reverts) without burning other endpoints", async () => {
    resetRpcPool();
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0x08c379a0" } }), { status: 200 });
    });
    await expect(makeRpc()("eth_call", [{}, "latest"])).rejects.toThrow("execution reverted");
    expect(n).toBe(1);
  });

  it("puts ROBINHOOD_RPC_URL first", async () => {
    vi.stubEnv("ROBINHOOD_RPC_URL", "https://private.example/rpc");
    resetRpcPool();
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      hits.push(url);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 });
    });
    await makeRpc()("eth_getLogs", [{}]);
    const rpc = makeRpc();
    for (let i = 0; i < 3; i++) await rpc("eth_getLogs", [{}]);
    expect(hits).toContain("https://private.example/rpc");
  });
});
