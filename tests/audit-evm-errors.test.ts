import { afterEach, describe, expect, it } from "vitest";
import { addressTopic, callOrRevert, isRevert, RpcError, TRANSFER_TOPIC, ZERO_TOPIC, type Rpc, type RpcLog } from "@/lib/onchain/rpc";
import { evmMintAuthority } from "@/lib/onchain/mintScan";
import { lpLock } from "@/lib/onchain/lplock";
import { evmTokenRpc } from "@/lib/sources/evmRpc";
import { robinhoodRpc } from "@/lib/sources/rpc";
import { evmSim } from "@/lib/sources/evmSim";
import { simulateRobinhood, verdictOf, type PoolSim } from "@/lib/sources/robinhoodSim";
import { MemoryKV, setKV } from "@/lib/kv";

// Audit C2 / C3 / C4 / M14: a transport failure (timeout, 429, 5xx) is not a revert. It must never
// become "owner renounced", "not a token", "sell reverts", "dry", "0% locked" or "0 infra supply".

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const revert = () => new RpcError("execution reverted", 3, "0x");
const word = (v: bigint | string) => (typeof v === "string" ? v.replace(/^0x/, "").padStart(64, "0") : v.toString(16).padStart(64, "0"));
const SUPPLY = "0x" + word(10n ** 27n);
const DEC = "0x" + word(18n);
const OWNER = "0x8da5cb5b";
const MINT_CODE = "0x6080" + "6340c10f19" + "00".repeat(200); // has mint(address,uint256)

afterEach(() => setKV(null));

/** A token whose reads all answer, except owner() which behaves as `owner`. */
function tokenRpc(owner: "timeout" | "revert" | "429", extra: Partial<Record<string, () => unknown>> = {}): Rpc {
  return (async (method: string, params: unknown[]) => {
    if (extra[method]) return extra[method]!();
    if (method === "eth_getCode") return MINT_CODE;
    if (method === "eth_getStorageAt") return "0x" + word(0n);
    if (method === "eth_blockNumber") return "0x100";
    if (method === "eth_getLogs") return [];
    if (method === "eth_call") {
      const { data } = (params as [{ data: string }])[0];
      if (data === OWNER) {
        if (owner === "timeout") throw timeout();
        if (owner === "429") throw new RpcError("RPC HTTP 429", 429);
        throw revert();
      }
      if (data === "0x18160ddd") return SUPPLY;
      if (data === "0x313ce567") return DEC;
      throw revert();
    }
    throw new Error(`unexpected ${method}`);
  }) as Rpc;
}

describe("C2: revert vs transport failure", () => {
  it("isRevert: only reverts (revert data / code 3 / 'execution reverted') count", () => {
    expect(isRevert(new RpcError("execution reverted", 3, "0x"))).toBe(true);
    expect(isRevert(new RpcError("execution reverted", -32000))).toBe(true);
    expect(isRevert(new RpcError("custom", -32000, "0x08c379a0"))).toBe(true);
    expect(isRevert(timeout())).toBe(false);
    expect(isRevert(new RpcError("RPC HTTP 429", 429))).toBe(false);
    expect(isRevert(new RpcError("RPC HTTP 503", 503))).toBe(false);
    expect(isRevert(new Error("fetch failed"))).toBe(false);
  });

  it("callOrRevert separates a revert ({ value: null }) from a failed read ({ error })", async () => {
    expect(await callOrRevert(tokenRpc("revert"), "0x1", OWNER)).toEqual({ value: null });
    const r = await callOrRevert(tokenRpc("timeout"), "0x1", OWNER);
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/timeout/);
  });

  it("Base/Monad/Ethereum: timeout on owner() ⇒ ownerRenounced null (not true), source partial", async () => {
    const res = await evmTokenRpc("base", "0x" + "ab".repeat(20), { rpc: tokenRpc("timeout") });
    expect(res.data.ownerRenounced).toBeNull();
    expect(res.data.nullReasons?.ownerRenounced).toMatch(/^owner\(\) read failed: .*timeout/);
    expect(res.status.state).toBe("partial");
    expect(res.data.tokenExists).toBe(true);
  });

  it("Base/Monad/Ethereum: revert on owner() ⇒ still renounced (no owner() function), source ok", async () => {
    const res = await evmTokenRpc("base", "0x" + "ab".repeat(20), { rpc: tokenRpc("revert") });
    expect(res.data.ownerRenounced).toBe(true);
    expect(res.status.state).toBe("ok");
    expect(res.status.message).toMatch(/no owner\(\) function/);
  });

  it("a failed totalSupply() read never yields tokenExists:false; a reverting one still does", async () => {
    const failed = await evmTokenRpc("monad", "0x" + "ab".repeat(20), { rpc: tokenRpcSupply("timeout") });
    expect(failed.data.tokenExists).toBeUndefined();
    expect(failed.data.nullReasons?.totalSupply).toMatch(/^totalSupply\(\) read failed/);
    expect(failed.status.state).toBe("partial");
    const reverted = await evmTokenRpc("monad", "0x" + "ab".repeat(20), { rpc: tokenRpcSupply("revert") });
    expect(reverted.data.tokenExists).toBe(false);
  });

  it("Robinhood: 429 on owner() ⇒ ownerRenounced null and mintAuthority null (not false), partial", async () => {
    setKV(new MemoryKV());
    const res = await robinhoodRpc("0x" + "c1".repeat(20), { rpc: tokenRpc("429") });
    expect(res.data.ownerRenounced).toBeNull();
    expect(res.data.mintAuthority).toBeNull();
    expect(res.data.nullReasons?.ownerRenounced).toMatch(/owner\(\) read failed: RPC HTTP 429/);
    expect(res.data.nullReasons?.mintAuthority).toMatch(/owner unknown \(owner\(\) read failed/);
    expect(res.status.state).toBe("partial");
  });

  it("Robinhood: revert on owner() ⇒ renounced, so a mint selector is not owner-mintable (as before)", async () => {
    setKV(new MemoryKV());
    const res = await robinhoodRpc("0x" + "c2".repeat(20), { rpc: tokenRpc("revert") });
    expect(res.data.ownerRenounced).toBe(true);
    expect(res.data.mintAuthority).toBe(false);
  });

  it("evmMintAuthority quotes why the owner is unknown", () => {
    expect(evmMintAuthority(MINT_CODE, null, false, "owner() read failed: x").reason).toMatch(/owner unknown \(owner\(\) read failed: x\)/);
  });
});

/** A contract whose totalSupply() times out or reverts (owner() reverts). */
function tokenRpcSupply(supply: "timeout" | "revert"): Rpc {
  return (async (method: string, params: unknown[]) => {
    if (method === "eth_call" && (params as [{ data: string }])[0].data === "0x18160ddd") {
      if (supply === "timeout") throw timeout();
      throw revert();
    }
    return tokenRpc("revert")(method, params);
  }) as Rpc;
}

describe("M14: unread infrastructure balances", () => {
  it("a failed infra balanceOf ⇒ deployerHoldingPct null with the reason (not understated)", async () => {
    setKV(new MemoryKV());
    const token = "0x" + "c3".repeat(20);
    const deployer = "0x" + "d".repeat(40);
    const mint: RpcLog = { address: token, topics: [TRANSFER_TOPIC, ZERO_TOPIC, addressTopic(deployer)], data: "0x" + (10n ** 26n).toString(16), blockNumber: "0x10", transactionHash: "0xmint", logIndex: "0x0" };
    const rpc = (async (method: string, params: unknown[]) => {
      if (method === "eth_getLogs") {
        const t = (params[0] as { topics: (string | null)[] }).topics;
        return [mint].filter((l) => t.every((x, i) => x == null || l.topics[i] === x));
      }
      if (method === "eth_getTransactionByHash") return { from: deployer, to: null };
      if (method === "eth_getBlockByNumber") return { timestamp: "0x6553f100" };
      if (method === "eth_getTransactionReceipt") return { logs: [] };
      if (method === "eth_call") {
        const { data } = (params as [{ data: string }])[0];
        if (data.startsWith("0x70a08231")) {
          if (data.endsWith(deployer.slice(2))) return "0x" + word(10n ** 25n);
          throw timeout(); // infrastructure balances
        }
      }
      return tokenRpc("revert")(method, params);
    }) as Rpc;
    const res = await robinhoodRpc(token, { rpc });
    expect(res.data.deployerAddress).toBe(deployer);
    expect(res.data.deployerHoldingPct).toBeNull();
    expect(res.data.nullReasons?.deployerHoldingPct).toMatch(/infra balance unread \(\d+ of \d+ balanceOf calls failed\)/);
  });
});

describe("C3: sell simulation transport errors", () => {
  const pool = (over: Partial<PoolSim>): PoolSim => ({ pool: "0x" + "e".repeat(64), kind: "v4", hooks: null, feePct: 0.3, liquidityUsd: 5_000, result: "pass", lossPct: 1, detail: "", ...over });

  it("verdictOf: only errored pools ⇒ sellable null, not honeypot, not liquidity removed", () => {
    const v = verdictOf([pool({ result: "error", lossPct: null, detail: "buy quote could not run (RPC: timeout) — not simulated" })]);
    expect(v.sellable).toBeNull();
    expect(v.honeypot).toBeNull();
    expect(v.liquidityPulled).toBeUndefined();
    expect(v.detail).toMatch(/could not be simulated/);
  });

  it("verdictOf: an errored pool does not hide a passing one; dry + errored is not 'liquidity removed'", () => {
    expect(verdictOf([pool({ result: "error", lossPct: null }), pool({ pool: "0x" + "f".repeat(64) })]).sellable).toBe(true);
    const v = verdictOf([pool({ result: "error", lossPct: null }), pool({ result: "dry", lossPct: null })]);
    expect(v.liquidityPulled).toBeUndefined();
    expect(v.sellable).toBeNull();
  });

  it("evmSim: timeout on the v4 quote ⇒ not honeypot, not dry / liquidity pulled", async () => {
    const token = "0x7bcefbb4ea938f71e4352057d9bf6cb2122d47b9";
    const id = "0x2ff864f45f2b7d6eee8a0822401e3615c6bb70a7d4a7021d88529da55634117c";
    const key = "0x" + word(0n) + word(token) + word(0n) + word(1n) + word(0n);
    const quoter = "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203";
    const rpc = (async (method: string, params: unknown[]) => {
      const [{ to, data }] = params as [{ to: string; data: string }];
      if (to === quoter) throw timeout();
      if (data.startsWith("0x70a08231")) return "0x" + word(0n);
      return key;
    }) as Rpc;
    const res = await evmSim({ chain: "ethereum", token, pools: [{ id, liquidityUsd: 16_000, kind: "v4" }], holders: [], supplyRaw: null, rpc });
    expect(res.data.honeypot).not.toBe(true);
    expect(res.data.sellable).toBeNull();
    expect(res.data.liquidityPulled).not.toBe(true);
    expect(res.data.nullReasons?.sellable).toMatch(/could not run \(RPC: .*timeout/);
    expect(res.status.state).toBe("partial");
  });

  it("evmSim: a holder transfer probe that times out is not 'transfers blocked'", async () => {
    const token = "0x7bcefbb4ea938f71e4352057d9bf6cb2122d47b9";
    const holder = "0x" + "6".repeat(40);
    const rpc = (async (method: string, params: unknown[]) => {
      const [{ data }] = params as [{ data: string }];
      if (data.startsWith("0x70a08231")) return "0x" + word(10n ** 21n);
      if (data.startsWith("0xa9059cbb")) throw new RpcError("RPC HTTP 429", 429);
      throw revert();
    }) as Rpc;
    const res = await evmSim({ chain: "ethereum", token, pools: [], holders: [holder], supplyRaw: null, rpc });
    expect(res.data.honeypot).not.toBe(true);
    expect(res.status.message).toMatch(/could not run/);
  });

  it("Robinhood: a 429 on the custody transfer probe does not override a passing v4 quote", async () => {
    const TOKEN = "0x" + "a".repeat(40);
    const REAL = "0x" + "6".repeat(40);
    const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
    const key = { id: "0x" + "1".repeat(64), manager: POOL_MANAGER, currency0: "0x0000000000000000000000000000000000000000", currency1: TOKEN, fee: 100, tickSpacing: 1, hooks: "0x0000000000000000000000000000000000000000" };
    const kv = new MemoryKV();
    await kv.set("sim:v4quoter:mainnet", "0x" + "00".repeat(30) + "000000000004444c5dc75cb358380d2e3de08a90");
    setKV(kv);
    const w = (v: bigint) => "0x" + word(v);
    const rpc = (async (method: string, params: unknown[]) => {
      if (method === "eth_getStorageAt") return w(1000n);
      if (method === "eth_blockNumber") return "0x10";
      if (method === "eth_getLogs") {
        const t = (params[0] as { topics: (string | null)[] }).topics;
        if (t[3] !== "0x" + "0".repeat(24) + TOKEN.slice(2)) return [];
        return [{ topics: [t[0], key.id, "0x" + "0".repeat(64), t[3]], data: "0x" + word(100n) + word(1n) + "0".repeat(64) + word(0n) + word(0n) }];
      }
      if (method === "eth_call") {
        const c = params[0] as { to: string; data: string };
        if (c.data.startsWith("0x70a08231")) return w(c.data.endsWith(REAL.slice(2)) ? 10n ** 21n : 0n);
        if (c.data.startsWith("0xa9059cbb")) {
          if (c.data.includes(POOL_MANAGER.slice(2))) throw new RpcError("RPC HTTP 429", 429); // custody probe
          return w(1n);
        }
        return w(10n ** 18n) + "0".repeat(64); // quotes
      }
      throw new Error(method);
    }) as Rpc;
    const r = await simulateRobinhood({ token: TOKEN, pools: [{ id: key.id, volume24hUsd: 1, reserveUsd: 1 }], holder: REAL, holders: [], holderBalanceRaw: null, totalSupplyRaw: 10n ** 27n, creationBlock: 1, rpc });
    expect(r.honeypot).toBe(false);
    expect(r.sellable).toBe(true);
    expect(r.detail).toMatch(/transfer probe could not run \(RPC: RPC HTTP 429\) — transfers not verified/);
  });

  it("Robinhood: a timeout on every quote ⇒ sellable null, not 'revert' / honeypot", async () => {
    const TOKEN = "0x" + "b".repeat(40);
    const id = "0x" + "2".repeat(64);
    const kv = new MemoryKV();
    await kv.set("sim:v4quoter:mainnet", "0x" + "00".repeat(30) + "000000000004444c5dc75cb358380d2e3de08a90");
    setKV(kv);
    const rpc = (async (method: string, params: unknown[]) => {
      if (method === "eth_getStorageAt") return "0x" + word(1000n);
      if (method === "eth_blockNumber") return "0x10";
      if (method === "eth_getLogs") {
        const t = (params[0] as { topics: (string | null)[] }).topics;
        if (t[3] !== "0x" + "0".repeat(24) + TOKEN.slice(2)) return [];
        return [{ topics: [t[0], id, "0x" + "0".repeat(64), t[3]], data: "0x" + word(100n) + word(1n) + "0".repeat(64) + word(0n) + word(0n) }];
      }
      if (method === "eth_call") {
        const c = params[0] as { to: string; data: string };
        if (c.data.startsWith("0x70a08231")) return "0x" + word(0n);
        throw timeout();
      }
      throw new Error(method);
    }) as Rpc;
    const r = await simulateRobinhood({ token: TOKEN, pools: [{ id, volume24hUsd: 1, reserveUsd: 1 }], holder: null, holders: [], holderBalanceRaw: null, totalSupplyRaw: 10n ** 27n, creationBlock: 1, rpc });
    expect(r.sellable).toBeNull();
    expect(r.honeypot).toBeNull();
    expect(r.pools[0].result).toBe("error");
  });
});

describe("C4: LP-lock read failures", () => {
  const POOL = "0x" + "9".repeat(40);
  const NPM = "0x" + "4".repeat(40);
  const V3_MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
  const INCREASE = "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
  const mintLog = (i: number): RpcLog => ({ address: POOL, topics: [V3_MINT], data: "0x", blockNumber: "0x10", transactionHash: `0xtx${i}`, logIndex: "0x0" });
  function v3Rpc(fail: { positions?: boolean; ownerOf?: boolean }, mints = 1): Rpc {
    return (async (method: string, params: unknown[]) => {
      if (method === "eth_getLogs") return Array.from({ length: mints }, (_, i) => mintLog(i));
      if (method === "eth_getTransactionReceipt") {
        const i = Number(String(params[0]).slice(4));
        return { logs: [{ address: NPM, topics: [INCREASE, "0x" + word(BigInt(i + 1))], data: "0x" }] };
      }
      if (method === "eth_call") {
        const { data } = (params as [{ data: string }])[0];
        if (data === "0x0902f1ac") throw revert(); // not a v2 pair
        if (data.startsWith("0x99fbab88")) {
          if (fail.positions) throw timeout();
          return "0x" + Array.from({ length: 12 }, (_, k) => word(k === 7 ? 1000n : 0n)).join("");
        }
        if (data.startsWith("0x6352211e")) {
          if (fail.ownerOf) throw new RpcError("RPC HTTP 429", 429);
          return "0x" + word("0x" + "7".repeat(40)); // a live wallet: not locked
        }
      }
      throw new Error(method);
    }) as Rpc;
  }

  it("failed positions() ⇒ lockedPct null with 'LP lock read failed (k of n calls)', never 0", async () => {
    const r = await lpLock(v3Rpc({ positions: true }), POOL, 1, 100);
    expect(r.lockedPct).toBeNull();
    expect(r.detail).toMatch(/^LP lock read failed \(1 of 2 calls\): positions\(\)/);
  });

  it("failed ownerOf ⇒ null, never mapped to the zero (burn) address", async () => {
    const r = await lpLock(v3Rpc({ ownerOf: true }), POOL, 1, 100);
    expect(r.lockedPct).toBeNull();
    expect(r.detail).toMatch(/LP lock read failed \(1 of 2 calls\): ownerOf/);
  });

  it("all reads ok ⇒ measured; more than 40 Mint events ⇒ the detail says only the first 40 were inspected", async () => {
    const r = await lpLock(v3Rpc({}, 41), POOL, 1, 100);
    expect(r.lockedPct).toBe(0);
    expect(r.detail).toMatch(/first 40 of 41 Mint events inspected/);
  });

  it("v2: a failed burn/locker balanceOf ⇒ null, not 0 locked", async () => {
    const rpc = (async (method: string, params: unknown[]) => {
      const { data } = (params as [{ data: string }])[0];
      if (data === "0x0902f1ac") return "0x" + word(1n) + word(1n) + word(0n);
      if (data === "0x18160ddd") return "0x" + word(1000n);
      if (data.startsWith("0x70a08231")) throw timeout();
      throw new Error(method);
    }) as Rpc;
    const r = await lpLock(rpc, POOL, 1, 100);
    expect(r.lockedPct).toBeNull();
    expect(r.kind).toBe("v2");
    expect(r.detail).toMatch(/^LP lock read failed \(\d+ of \d+ calls\): balanceOf/);
  });
});
