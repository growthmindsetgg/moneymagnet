import { describe, expect, it } from "vitest";
import { addressKind, detectChain, isEvmChain } from "@/lib/chain";
import { resolveEvmChain } from "@/lib/resolveChain";
import type { EvmChain } from "@/lib/chain";
import type { Rpc } from "@/lib/onchain/rpc";

const A = "0x" + "ab".repeat(20);
const SUPPLY = "0x" + "0".repeat(60) + "f4240";

/** A fake RPC per chain: `token` answers code + totalSupply, `contract` code only, `none` no code. */
function fakeRpc(states: Partial<Record<EvmChain, "token" | "contract" | "none" | "down">>) {
  return (c: EvmChain): Rpc =>
    (async (method: string) => {
      const s = states[c] ?? "none";
      if (s === "down") throw new Error("RPC HTTP 503");
      if (method === "eth_getCode") return s === "none" ? "0x" : "0x6080604052";
      if (method === "eth_call") {
        if (s === "token") return SUPPLY;
        throw new Error("execution reverted");
      }
      throw new Error(`unexpected ${method}`);
    }) as Rpc;
}
const pair = (chainId: string, fdv: number, liq = 10_000) => ({ chainId, baseToken: { address: A }, fdv, liquidity: { usd: liq } });

describe("§1a chain detection", () => {
  it("0x is EVM; a valid hint picks the EVM chain; base58 is Solana regardless", () => {
    expect(addressKind(A)).toBe("evm");
    expect(detectChain(A)).toBe("robinhood");
    expect(detectChain(A, "base")).toBe("base");
    expect(detectChain(A, "monad")).toBe("monad");
    expect(detectChain(A, "solana")).toBe("robinhood");
    expect(detectChain("So11111111111111111111111111111111111111112", "base")).toBe("solana");
    expect(isEvmChain("auto")).toBe(false);
  });

  it("the same 0x token on two chains ⇒ two candidates (picker), each with its FDV, highest first", async () => {
    const res = await resolveEvmChain(A, { rpc: fakeRpc({ base: "token", monad: "token" }), fetchPairs: async () => [pair("monad", 2_000_000), pair("base", 9_000_000), pair("base", 1_000)] });
    expect(res.candidates.map((c) => c.chain)).toEqual(["base", "monad"]);
    expect(res.candidates[0]).toMatchObject({ chain: "base", fdvUsd: 9_000_000, pairs: 2 });
    expect(res.candidates[1]).toMatchObject({ chain: "monad", fdvUsd: 2_000_000, pairs: 1 });
    expect(res.checks.robinhood).toBe("no code");
  });

  it("one chain ⇒ one candidate (no picker)", async () => {
    const res = await resolveEvmChain(A, { rpc: fakeRpc({ robinhood: "token", base: "contract" }), fetchPairs: async () => [pair("robinhood", 5_000)] });
    expect(res.candidates.map((c) => c.chain)).toEqual(["robinhood"]);
    expect(res.checks.base).toBe("contract, not an ERC-20");
  });

  it("a token with no pairs on one chain still counts, FDV null, listed after priced chains", async () => {
    const res = await resolveEvmChain(A, { rpc: fakeRpc({ robinhood: "token", monad: "token" }), fetchPairs: async () => [pair("monad", 50_000)] });
    expect(res.candidates.map((c) => [c.chain, c.fdvUsd])).toEqual([
      ["monad", 50_000],
      ["robinhood", null],
    ]);
  });

  it("an unreachable RPC is reported, not guessed; DexScreener down still resolves from the chains", async () => {
    const res = await resolveEvmChain(A, { rpc: fakeRpc({ base: "token", monad: "down" }), fetchPairs: async () => Promise.reject(new Error("429")) });
    expect(res.candidates.map((c) => c.chain)).toEqual(["base"]);
    expect(res.candidates[0].fdvUsd).toBeNull();
    expect(res.checks.monad).toBe("RPC unreachable");
  });
});
