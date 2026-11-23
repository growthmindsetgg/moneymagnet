import { describe, expect, it } from "vitest";
import { evmFounderLink, founderVerdict, type LinkSignal } from "@/lib/onchain/founderLink";
import { TRANSFER_TOPIC, addressTopic, type Rpc } from "@/lib/onchain/rpc";

const TOKEN = "0x43cf5407bda1400498b8064d50a7e17528d87777";
const WALLET = "0xf8baf2541defab76f2c344ff10cd6d4ef74d3432";
const DEPLOYER = "0x8258cf2e72bf252778922cac02f518ee6457a10e";
const TX = "0x5c96c6a1de542fce420aab5f3955abde5d042ec254f39129d6442b7dc456ebeb";
const E18 = 10n ** 18n;
const hexOf = (n: bigint) => "0x" + n.toString(16);

/** Fake RPC: balances, one transfer receipt, code per address. Shaped on JAMES (Monad), read live 2026-11-23. */
function fakeRpc(o: { balances: Record<string, bigint>; received: bigint; swapInTx?: boolean; codes?: Record<string, string> }): Rpc {
  return (async (method: string, params: unknown[]) => {
    if (method === "eth_call") {
      const data = (params[0] as { data: string }).data;
      const who = "0x" + data.slice(-40);
      return hexOf(o.balances[who] ?? 0n);
    }
    if (method === "eth_getTransactionReceipt")
      return { logs: [{ address: TOKEN, topics: [TRANSFER_TOPIC, addressTopic(DEPLOYER), addressTopic(WALLET)], data: hexOf(o.received) }] };
    if (method === "eth_getCode") return o.codes?.[(params[0] as string).toLowerCase()] ?? "0x";
    throw new Error(`unexpected ${method}`);
  }) as Rpc;
}

const sig = (id: LinkSignal["id"], ok: boolean | null): LinkSignal => ({ id, ok, evidence: "test" });

describe("founderVerdict (pure)", () => {
  it("no direct deployer link ⇒ not linked, however many other clues hold", () => {
    const v = founderVerdict([sig("tokens_from_deployer", false), sig("gas_from_deployer", false), sig("stake_from_deployer", true), sig("deployer_emptied", true), sig("shared_funder", true)]);
    expect(v.role).toBeNull();
  });
  it("one direct clue alone ⇒ team wallet", () => {
    expect(founderVerdict([sig("tokens_from_deployer", true), sig("gas_from_deployer", false), sig("stake_from_deployer", false), sig("deployer_emptied", false), sig("shared_funder", null)]).role).toBe("team");
    expect(founderVerdict([sig("tokens_from_deployer", false), sig("gas_from_deployer", true), sig("stake_from_deployer", false), sig("deployer_emptied", false), sig("shared_funder", false)]).role).toBe("team");
  });
  it("a direct clue plus any second clue ⇒ founder wallet (linked)", () => {
    const v = founderVerdict([sig("tokens_from_deployer", true), sig("gas_from_deployer", null), sig("stake_from_deployer", true), sig("deployer_emptied", false), sig("shared_funder", null)]);
    expect(v.role).toBe("founder");
    expect(v.count).toBe(2);
    expect(v.summary).toMatch(/^founder link 2\/5 ⇒ founder wallet \(linked\)/);
  });
  it("unknown clues never count as yes and are named as unknown", () => {
    const v = founderVerdict([sig("tokens_from_deployer", true), sig("gas_from_deployer", null), sig("stake_from_deployer", null), sig("deployer_emptied", null), sig("shared_funder", null)]);
    expect(v.role).toBe("team");
    expect(v.summary).toMatch(/gas from deployer: unknown/);
  });
});

describe("evmFounderLink (JAMES-shaped)", () => {
  const base = { token: TOKEN, wallet: WALLET, deployer: DEPLOYER, first: { from: DEPLOYER, tx: TX, block: 85821687 }, firstPlain: true };

  it("JAMES: tokens by plain transfer, that transfer > its whole balance, deployer kept 0, different gas funders ⇒ founder (3/5)", async () => {
    const rpc = fakeRpc({ balances: { [WALLET]: 610_973_000n * E18, [DEPLOYER]: 0n }, received: 670_000_000n * E18 });
    const v = await evmFounderLink(rpc, {
      ...base,
      walletGas: { from: "0x49bcb13a5fdc8b9670212c5df50b802d03676c54", tx: null, block: 38383872 },
      deployerGas: { from: "0xf89d7b9c864f589bbf53a82105107622b35eaa40", tx: null, block: 1 },
    });
    expect(v.role).toBe("founder");
    expect(v.count).toBe(3);
    const by = Object.fromEntries(v.signals.map((s) => [s.id, s.ok]));
    expect(by).toEqual({ tokens_from_deployer: true, gas_from_deployer: false, stake_from_deployer: true, deployer_emptied: true, shared_funder: false });
  });

  it("a small gift from the deployer that the wallet then topped up by buying ⇒ team only (stake not handed over)", async () => {
    const rpc = fakeRpc({ balances: { [WALLET]: 500_000_000n * E18, [DEPLOYER]: 300_000_000n * E18 }, received: 10_000_000n * E18 });
    const v = await evmFounderLink(rpc, { ...base, walletGas: null, deployerGas: null, gasReason: "test: not read" });
    expect(v.signals.find((s) => s.id === "stake_from_deployer")!.ok).toBe(false);
    expect(v.signals.find((s) => s.id === "deployer_emptied")!.ok).toBe(false);
    expect(v.role).toBe("team");
  });

  it("tokens bought from the deployer in a swap tx are not a plain-transfer link", async () => {
    const rpc = fakeRpc({ balances: { [WALLET]: 1n * E18, [DEPLOYER]: 0n }, received: 1n * E18 });
    const v = await evmFounderLink(rpc, { ...base, firstPlain: false, walletGas: null, deployerGas: null, gasReason: "test" });
    expect(v.signals.find((s) => s.id === "tokens_from_deployer")!.ok).toBe(false);
    expect(v.role).toBeNull();
  });

  it("shared funder counts only for an EOA funder that isn't a labelled exchange", async () => {
    const funder = "0x1111111111111111111111111111111111111111";
    const gas = { from: funder, tx: null, block: 5 };
    const rpcEoa = fakeRpc({ balances: {}, received: 0n });
    const v1 = await evmFounderLink(rpcEoa, { ...base, first: null, firstPlain: false, walletGas: gas, deployerGas: gas });
    expect(v1.signals.find((s) => s.id === "shared_funder")!.ok).toBe(true);
    expect(v1.role).toBeNull(); // no direct link: shared funder alone never links
    const v2 = await evmFounderLink(rpcEoa, { ...base, first: null, firstPlain: false, walletGas: gas, deployerGas: gas, isExchange: (a) => a === funder });
    expect(v2.signals.find((s) => s.id === "shared_funder")!.ok).toBe(false);
    const rpcContract = fakeRpc({ balances: {}, received: 0n, codes: { [funder]: "0x6080604052" + "00".repeat(100) } });
    const v3 = await evmFounderLink(rpcContract, { ...base, first: null, firstPlain: false, walletGas: gas, deployerGas: gas });
    expect(v3.signals.find((s) => s.id === "shared_funder")!.ok).toBe(false);
  });

  it("gas from the deployer plus a shared-funder miss: one direct clue ⇒ team; with the stake handed over too ⇒ founder", async () => {
    const rpc = fakeRpc({ balances: { [WALLET]: 100n * E18, [DEPLOYER]: 50n * E18 }, received: 100n * E18 });
    const gas = { from: DEPLOYER, tx: null, block: 9 };
    const v = await evmFounderLink(rpc, { ...base, firstPlain: true, walletGas: gas, deployerGas: { from: "0x2222222222222222222222222222222222222222", tx: null, block: 1 } });
    // tokens + gas + stake (100/100) = 3; deployer kept 50% ⇒ not emptied
    expect(v.role).toBe("founder");
    expect(v.signals.find((s) => s.id === "deployer_emptied")!.ok).toBe(false);
  });
});
