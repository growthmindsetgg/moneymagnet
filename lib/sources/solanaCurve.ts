import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import type { AdapterResult, TokenSnapshot } from "../types";
import { fetchJson } from "./http";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** Tokens the curve sells before graduating (793.1M with 6 decimals). */
const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
const LAMPORTS = 1_000_000_000;

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
export const solanaRpcUrl = () => process.env.SOLANA_RPC_URL || PUBLIC_RPC;

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Solana findProgramAddress: the first bump (255 → 0) whose hash is off the ed25519 curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const program = bs58.decode(programId);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const buf = new Uint8Array([...seeds.flatMap((s) => [...s]), bump, ...program, ...marker]);
    const hash = sha256(buf);
    if (!onCurve(hash)) return bs58.encode(hash);
  }
  throw new Error("no viable bump");
}

export const bondingCurveAddress = (mint: string) =>
  findProgramAddress([new TextEncoder().encode("bonding-curve"), bs58.decode(mint)], PUMP_PROGRAM);

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** Associated token account of `owner` for `mint` (classic or Token-2022 program). */
export const associatedTokenAddress = (owner: string, mint: string, program = TOKEN_PROGRAM) =>
  findProgramAddress([bs58.decode(owner), bs58.decode(program), bs58.decode(mint)], ATA_PROGRAM);

/** The curve PDA plus its token vault under both token programs — all of it is pool, not wallet. */
export const curveAccounts = (mint: string) => {
  const curve = bondingCurveAddress(mint);
  return [curve, associatedTokenAddress(curve, mint), associatedTokenAddress(curve, mint, TOKEN_2022_PROGRAM)];
};

export interface CurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

/** Layout: 8-byte discriminator, five u64 LE, then the `complete` bool. */
export function decodeCurve(data: Uint8Array): CurveState {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o: number) => view.getBigUint64(o, true);
  return {
    virtualTokenReserves: u64(8),
    virtualSolReserves: u64(16),
    realTokenReserves: u64(24),
    realSolReserves: u64(32),
    tokenTotalSupply: u64(40),
    complete: data[48] === 1,
  };
}

export function curveProgressPct(c: CurveState): number {
  if (c.complete) return 100;
  const sold = INITIAL_REAL_TOKEN_RESERVES - c.realTokenReserves;
  return Math.max(0, Math.min(100, Number((sold * 10_000n) / INITIAL_REAL_TOKEN_RESERVES) / 100));
}

const WSOL = "So11111111111111111111111111111111111111112";

/** SOL/USD from DexScreener's deepest wSOL pair — only used to price the curve in USD. */
async function solUsd(): Promise<number | null> {
  const pairs = await fetchJson<{ baseToken: { address: string }; priceUsd?: string; liquidity?: { usd?: number } }[]>(`https://api.dexscreener.com/tokens/v1/solana/${WSOL}`, { timeoutMs: 8000 }).catch(() => null);
  const best = (pairs ?? []).filter((p) => p.baseToken.address === WSOL && p.priceUsd).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  return best ? Number(best.priceUsd) : null;
}

type RpcAccount<D> = { result?: { value: { owner: string; data: D } | null }; error?: { message: string } };
interface ParsedMint {
  parsed?: { type?: string; info?: { mintAuthority: string | null; freezeAuthority: string | null; supply: string; decimals: number } };
}

const rpcCall = <T,>(method: string, params: unknown[]) =>
  fetchJson<T>(solanaRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    timeoutMs: 10_000,
  });

/**
 * Reads straight from chain (public Solana RPC; no key needed): the mint account (mint/freeze
 * authority, supply — on-chain truth) and the pump.fun bonding curve, priced via curve math.
 */
export async function solanaCurve(mint: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const curve = bondingCurveAddress(mint);
  const [mintRes, res] = await Promise.all([
    rpcCall<RpcAccount<ParsedMint>>("getAccountInfo", [mint, { encoding: "jsonParsed" }]).catch(() => null),
    rpcCall<RpcAccount<[string, string]>>("getAccountInfo", [curve, { encoding: "base64" }]),
  ]);
  if (res.error) throw new Error(res.error.message);
  const info = mintRes?.result?.value?.data?.parsed?.type === "mint" ? mintRes.result.value.data.parsed.info : undefined;
  // The RPC answered and there is no account at all: no token exists at this address.
  const tokenExists = mintRes?.result ? mintRes.result.value != null : null;
  const mintData: Partial<TokenSnapshot> = info
    ? {
        mintAuthority: info.mintAuthority !== null,
        freezeAuthority: info.freezeAuthority !== null,
        totalSupply: Number(info.supply) / 10 ** info.decimals,
      }
    : {};
  const mintNote = info ? `mint authority ${info.mintAuthority ? "set" : "revoked"}, freeze ${info.freezeAuthority ? "set" : "revoked"}` : "mint account unreadable";

  const acct = res.result?.value;
  if (!acct || acct.owner !== PUMP_PROGRAM) {
    const reason = "not a pump.fun token (no bonding curve account)";
    return {
      status: { id: "solana-rpc", label: "Solana RPC", state: "ok", message: `${mintNote} · ${reason}`, ms: Date.now() - t0 },
      data: { ...mintData, tokenExists, nullReasons: { curveProgressPct: reason, realSolReserves: reason } },
    };
  }
  const state = decodeCurve(Uint8Array.from(Buffer.from(acct.data[0], "base64")));
  const progress = curveProgressPct(state);
  // Curve math (pre-graduation only): price = virtual SOL / virtual tokens (9 vs 6 decimals).
  let price: Partial<TokenSnapshot> = {};
  if (!state.complete && state.virtualTokenReserves > 0n) {
    const sol = await solUsd();
    const priceSol = Number(state.virtualSolReserves) / LAMPORTS / (Number(state.virtualTokenReserves) / 1e6);
    const supply = Number(state.tokenTotalSupply) / 1e6;
    // Pre-graduation liquidity = the curve's real SOL reserve × SOL/USD (the pool's quote side).
    if (sol) price = { priceUsd: priceSol * sol, fdvUsd: priceSol * sol * supply, liquidityUsd: (Number(state.realSolReserves) / LAMPORTS) * sol, liquidityTotalUsd: (Number(state.realSolReserves) / LAMPORTS) * sol };
  }
  return {
    status: {
      id: "solana-rpc",
      label: "Solana RPC",
      state: "ok",
      message: `${mintNote} · ${state.complete ? "bonding curve complete (graduated)" : `bonding curve ${progress.toFixed(1)}% · ${(Number(state.realSolReserves) / LAMPORTS).toFixed(3)} SOL`}`,
      ms: Date.now() - t0,
    },
    data: {
      ...mintData,
      tokenExists: true,
      ...price,
      curveProgressPct: progress,
      realSolReserves: Number(state.realSolReserves) / LAMPORTS,
      curveCirculatingPct: state.complete
        ? null
        : Number(((INITIAL_REAL_TOKEN_RESERVES - state.realTokenReserves) * 1_000_000n) / (state.tokenTotalSupply || 1n)) / 10_000,
      launchpad: "pump.fun",
      isLaunchpad: true,
      poolAddresses: curveAccounts(mint),
      links: [{ label: "pump.fun", url: `https://pump.fun/coin/${mint}` }],
    },
    raw: { curve, ...Object.fromEntries(Object.entries(state).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) },
  };
}
