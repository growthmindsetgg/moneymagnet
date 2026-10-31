import { keccak_256 } from "@noble/hashes/sha3";
import type { AdapterResult } from "../types";
import type { EvmChain } from "../chain";
import { CHAIN_LABEL } from "../chain";
import { chainRpc, RpcError, type Rpc } from "../onchain/rpc";
import { chainInfraEntry, findInfra } from "../onchain/chainInfra";
import { describeRevert, encodeQuote, simV2, simV3, transferProbe, verdictOf, type PoolKey, type PoolSim } from "./robinhoodSim";

/**
 * Our own sell simulation on Base and Monad (§1b) — on Monad nad.fun curve tokens it is the only
 * sellability source (no scanner gives a verdict there). Read-only eth_calls:
 * 1. transfer probe: a real holder's transfer(fresh, ½ balance) — a blacklist / transfer lock reverts it;
 * 2. per pool (highest liquidity first, ≤ 6): v4 = native V4Quoter round trip (pool key from
 *    PositionManager.poolKeys(bytes25)); v2 = reserves math; v3 = slot0 math (lib/sources/robinhoodSim);
 * 3. nad.fun (Monad): the router's real `sell` run inside eth_call with the fresh wallet's balance and
 *    allowance set by state override (slots found with eth_createAccessList), after a Lens / router buy quote.
 * Verdict rules are robinhoodSim's verdictOf: sellable = some pool completes with < 50% loss.
 */
export const simSourceId = (chain: EvmChain) => `${chain}-sim`;

const sel = (sig: string) => "0x" + Buffer.from(keccak_256(sig)).toString("hex").slice(0, 8);
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const w = (hex: string | null | undefined, i: number) => (hex && hex.length >= 66 + i * 64 ? BigInt("0x" + hex.slice(2 + i * 64, 66 + i * 64)) : null);
const FRESH = "0x000000000000000000000000000000000000f2e5";
const MAX_UINT = (1n << 256n) - 1n;
const ZERO = "0x0000000000000000000000000000000000000000";

/** Error(string) revert data → its message. */
export function revertString(data: string | undefined): string | null {
  if (!data?.startsWith("0x08c379a0") || data.length < 138) return null;
  const len = Number(BigInt("0x" + data.slice(74, 138)));
  return Buffer.from(data.slice(138, 138 + len * 2), "hex").toString("utf8");
}
/**
 * Reverts that mean "no liquidity to sell into", not "the token blocks sells": Uniswap v3 SPL (price at
 * its limit) / AS / IIA, v2 INSUFFICIENT_*, nad.fun InvalidAmountOut (0x4e969c58).
 */
export const DRY_REVERT = /^(SPL|AS|IIA)$|INSUFFICIENT_(LIQUIDITY|OUTPUT_AMOUNT|INPUT_AMOUNT)|insufficient liquidity/i;

export interface EvmPool {
  id: string;
  liquidityUsd: number | null;
  /** "v2" / "v3" / "v4" when a source said so (GoPlus liquidity_type, DexScreener labels). */
  kind?: "v2" | "v3" | "v4" | null;
}

export interface EvmSimInput {
  chain: EvmChain;
  token: string;
  pools: EvmPool[];
  /** Wallet holders (largest first) for the transfer probe. */
  holders: string[];
  supplyRaw: bigint | null;
  /** nad.fun: version + market type, when the token is a nad.fun token. */
  nadfun?: { version: string; marketType: string | null } | null;
  rpc?: Rpc;
}

/** Quote-side amount for a round trip: 0.01 ETH on Base, 10 MON on Monad, 10 USDC. Null for other quotes. */
function quoteAmount(chain: EvmChain, quote: string): bigint | null {
  const q = quote.toLowerCase();
  const e = chainInfraEntry(chain, q);
  const native = q === ZERO || (e?.role === "quote-token" && /^W(ETH|MON)\b/i.test(e.label));
  if (native) return chain === "monad" ? 10n ** 19n : 10n ** 16n;
  if (e?.role === "quote-token" && /USDC|USDG|USDT/i.test(e.label)) return 10n ** 7n;
  // Registered 18-decimal launchpad quote currencies (flETH, ZORA, VIRTUAL): one unit — the loss is a ratio.
  if (e?.role === "quote-currency") return 10n ** 18n;
  return null;
}

async function v4Sim(rpc: Rpc, chain: EvmChain, id: string, token: string, supply: bigint | null): Promise<PoolSim | null> {
  const pm = findInfra(chain, "liquidity-manager", /v4.*PositionManager/i);
  const quoter = findInfra(chain, "quoter", /v4/i);
  const manager = findInfra(chain, "v4-pool-manager");
  if (!pm || !quoter || !manager) return null;
  let keyHex = await rpc<string>("eth_call", [{ to: pm.address, data: sel("poolKeys(bytes25)") + id.slice(2, 52).padEnd(64, "0") }, "latest"], 10_000).catch(() => null);
  // Pools the PositionManager never saw (Zora coins mint through their own hook): the token's own
  // getPoolKey(), accepted only when it hashes to this pool id.
  if (!keyHex || keyHex.length < 2 + 5 * 64 || w(keyHex, 0) === 0n) {
    const own = await rpc<string>("eth_call", [{ to: token, data: sel("getPoolKey()") }, "latest"], 10_000).catch(() => null);
    keyHex = own && own.length >= 2 + 5 * 64 && "0x" + Buffer.from(keccak_256(Buffer.from(own.slice(2, 2 + 5 * 64), "hex"))).toString("hex") === id ? own : null;
  }
  if (!keyHex || keyHex.length < 2 + 5 * 64 || w(keyHex, 0) === null) return null;
  const key: PoolKey = {
    id,
    manager: manager.address,
    currency0: "0x" + keyHex.slice(26, 66),
    currency1: "0x" + keyHex.slice(90, 130),
    fee: Number(w(keyHex, 2)),
    tickSpacing: Number(BigInt.asIntN(24, w(keyHex, 3)!)),
    hooks: "0x" + keyHex.slice(282, 322),
  };
  const tokenIs0 = key.currency0.toLowerCase() === token;
  if (!tokenIs0 && key.currency1.toLowerCase() !== token) return null;
  const quote = tokenIs0 ? key.currency1 : key.currency0;
  const hooks = /^0x0{40}$/.test(key.hooks) ? null : key.hooks;
  const feePct = key.fee & 0x800000 ? null : key.fee / 10_000;
  const base = { pool: id, kind: "v4" as const, hooks, feePct, liquidityUsd: null };
  const qIn = quoteAmount(chain, quote);
  if (qIn == null) return { ...base, result: "dry", lossPct: null, detail: `quote currency ${quote.slice(0, 10)}… not a registered quote token — not simulated` };
  const q = async (zeroForOne: boolean, amount: bigint) => {
    try {
      const res = await rpc<string>("eth_call", [{ from: "0x1111111111111111111111111111111111111111", to: quoter.address, data: encodeQuote(key, zeroForOne, amount) }, "latest"], 12_000);
      return { out: w(res, 0) };
    } catch (err) {
      const r = describeRevert(err instanceof RpcError ? err.data : undefined);
      return { out: null, error: r.reason, dry: r.dry };
    }
  };
  const buy = await q(!tokenIs0, qIn);
  if (!buy.out) return { ...base, result: "dry", lossPct: null, detail: `buy quote failed (${buy.error ?? "0 out"}) — no usable liquidity` };
  const sell = await q(tokenIs0, buy.out);
  if (!sell.out) return { ...base, result: sell.dry ? "dry" : "revert", lossPct: null, detail: `sell of the bought amount reverts: ${sell.error ?? "0 out"}` };
  const loss = Math.max(0, Number(((qIn - sell.out) * 10_000n) / qIn) / 100);
  void supply;
  return { ...base, result: loss < 50 ? "pass" : "fail", lossPct: loss, detail: `${loss.toFixed(2)}% round-trip loss (V4Quoter, buy then sell)` };
}

async function poolSim(rpc: Rpc, chain: EvmChain, p: EvmPool, token: string, supply: bigint | null): Promise<PoolSim | null> {
  const id = p.id.toLowerCase();
  const ethQuoted = (a: string) => quoteAmount(chain, a) === (chain === "monad" ? 10n ** 19n : 10n ** 16n);
  let sim: PoolSim | null = null;
  if (/^0x[0-9a-f]{64}$/.test(id)) sim = await v4Sim(rpc, chain, id, token, supply);
  else if (/^0x[0-9a-f]{40}$/.test(id)) sim = p.kind === "v3" ? await simV3(rpc, id, token) : ((await simV2(rpc, id, token, ethQuoted, supply)) ?? (await simV3(rpc, id, token)));
  return sim ? { ...sim, liquidityUsd: p.liquidityUsd } : null;
}

/** nad.fun router sell (Monad), run for real inside eth_call. */
async function nadfunSim(rpc: Rpc, token: string, nf: NonNullable<EvmSimInput["nadfun"]>): Promise<PoolSim | null> {
  const v2 = /^V2/i.test(nf.version);
  const curve = /CURVE/.test(nf.marketType ?? "");
  const router = v2 ? findInfra("monad", "launchpad-factory", /V2 router/i) : curve ? findInfra("monad", "launchpad-factory", /BondingCurveRouter/i) : findInfra("monad", "router", /nad\.fun V1 DexRouter/i);
  const lens = v2 ? router : findInfra("monad", "lens", /nad\.fun V1 Lens/i);
  if (!router || !lens) return null;
  const base = { pool: router.address, kind: "v2" as const, hooks: null, feePct: null, liquidityUsd: null };
  const qIn = 10n ** 19n; // 10 MON
  const quoteData = sel("getAmountOut(address,uint256,bool)") + addrWord(token) + word(qIn) + word(1n);
  const buyHex = await rpc<string>("eth_call", [{ to: lens.address, data: quoteData }, "latest"], 10_000).catch((e: RpcError) => (e.data ?? "err") as string);
  const tokens = buyHex && !buyHex.startsWith("err") ? (v2 ? w(buyHex, 0) : w(buyHex, 1)) : null;
  if (!tokens) return { ...base, result: "dry", lossPct: null, detail: `nad.fun buy quote for 10 MON failed${buyHex && buyHex !== "err" ? ` (${buyHex.slice(0, 10)})` : ""}` };
  // Storage slots of balanceOf(F) and allowance(F, router), found by tracing the reads.
  const slots = async (data: string) => {
    const al = await rpc<{ accessList: { address: string; storageKeys: string[] }[] }>("eth_createAccessList", [{ from: FRESH, to: token, data }, "latest"], 10_000).catch(() => null);
    return al?.accessList.find((x) => x.address.toLowerCase() === token)?.storageKeys ?? [];
  };
  const [balKeys, allowKeys] = await Promise.all([slots("0x70a08231" + addrWord(FRESH)), slots("0xdd62ed3e" + addrWord(FRESH) + addrWord(router.address))]);
  if (!balKeys.length || !allowKeys.length) return { ...base, result: "dry", lossPct: null, detail: "could not locate the balance / allowance storage slots — sell not simulated" };
  const stateDiff: Record<string, string> = {};
  for (const k of balKeys) stateDiff[k] = "0x" + word(tokens);
  for (const k of allowKeys) stateDiff[k] = "0x" + word(MAX_UINT);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const sellData = sel("sell((uint256,uint256,address,address,uint256))") + word(tokens) + word(1n) + addrWord(token) + addrWord(FRESH) + word(deadline);
  try {
    const out = await rpc<string>("eth_call", [{ from: FRESH, to: router.address, data: sellData }, "latest", { [token]: { stateDiff } }], 15_000);
    const back = w(out, 0);
    if (back == null) return { ...base, result: "revert", lossPct: null, detail: "nad.fun sell returned no amount" };
    const loss = Math.max(0, Number(((qIn - back) * 10_000n) / qIn) / 100);
    return { ...base, result: loss < 50 ? "pass" : "fail", lossPct: loss, detail: `${loss.toFixed(2)}% round-trip loss (nad.fun ${v2 ? "V2" : "V1"} ${curve ? "curve" : "DEX"} router: quote 10 MON buy, then a real sell(…) in eth_call)` };
  } catch (err) {
    const data = err instanceof RpcError ? err.data : undefined;
    // Panic 0x11 on a curve = arithmetic underflow: the curve has no MON left to pay out (nothing to sell into).
    if (data?.startsWith("0x4e487b71") && data.endsWith("11")) return { ...base, result: "dry", lossPct: null, detail: "curve has no MON reserve to pay a sell (Panic 0x11)" };
    const msg = revertString(data);
    if ((msg && DRY_REVERT.test(msg)) || data?.startsWith("0x4e969c58")) return { ...base, result: "dry", lossPct: null, detail: `nad.fun sell finds no liquidity (${msg ?? "InvalidAmountOut"}) — nothing to sell into` };
    return { ...base, result: "revert", lossPct: null, detail: `nad.fun sell reverts: ${msg ? `"${msg}"` : describeRevert(data).reason}` };
  }
}

export async function evmSim(inp: EvmSimInput): Promise<AdapterResult> {
  const t0 = Date.now();
  const id = simSourceId(inp.chain);
  const label = `${CHAIN_LABEL[inp.chain]} sell simulation`;
  const rpc = inp.rpc ?? chainRpc(inp.chain);
  const token = inp.token.toLowerCase();

  // 1. Transfer probe from the first holders with a real balance.
  let blocked: string | null = null;
  let probeNote = "no holder with a balance to probe";
  let probed = 0;
  let reverted = 0;
  for (const h of inp.holders.slice(0, 5)) {
    if (probed >= 2) break;
    const balHex = await rpc<string>("eth_call", [{ to: token, data: "0x70a08231" + addrWord(h) }, "latest"], 10_000).catch(() => null);
    const bal = w(balHex, 0);
    if (!bal) continue;
    probed++;
    const r = await transferProbe(rpc, token, h, FRESH, bal / 2n);
    if (!r.ok) reverted++;
    probeNote = `transfer probe from ${h.slice(0, 8)}…: ${r.ok ? "ok" : `blocked (${r.error})`}`;
  }
  if (probed >= 1 && reverted === probed) blocked = `holder transfers revert (${reverted}/${probed} probed)`;

  // 2. Pools (≤ 6, highest listed liquidity first) and 3. the nad.fun router.
  const seen = new Set<string>();
  const pools = inp.pools
    .filter((p) => (seen.has(p.id.toLowerCase()) ? false : (seen.add(p.id.toLowerCase()), true)))
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, 6);
  const sims = (await Promise.all([...pools.map((p) => poolSim(rpc, inp.chain, p, token, inp.supplyRaw).catch(() => null)), inp.nadfun ? nadfunSim(rpc, token, inp.nadfun).catch(() => null) : Promise.resolve(null)])).filter(
    (x): x is PoolSim => !!x,
  );
  const v = verdictOf(sims, { blocked, probeNote });
  const nothing = !sims.length;
  const onlyScanner = inp.chain === "monad" && inp.nadfun && /CURVE/.test(inp.nadfun.marketType ?? "");
  return {
    status: {
      id,
      label,
      state: v.sellable == null ? "partial" : "ok",
      message: `${onlyScanner ? "only sellability source for this curve token (no scanner covers it) · " : ""}${nothing ? `no pool could be simulated (${pools.length} listed) · ${probeNote}` : v.detail}`.slice(0, 600),
      ms: Date.now() - t0,
    },
    data: {
      liquidityPulled: v.liquidityPulled ?? (sims.length ? false : null),
      sellable: v.sellable,
      honeypot: v.honeypot,
      roundTripLossPct: v.roundTripLossPct,
      nullReasons: v.sellable == null ? { sellable: v.detail, roundTripLossPct: v.detail } : {},
      fakeSignals: v.info.map((text) => ({ kind: "other" as const, level: "info" as const, text, source: label })),
    },
    raw: { ...v, probeNote },
  };
}
