import rpcEndpoints from "@/data/rpc-endpoints.json";
import baseRpcEndpoints from "@/data/base-rpc-endpoints.json";
import monadRpcEndpoints from "@/data/monad-rpc-endpoints.json";
import ethereumRpcEndpoints from "@/data/ethereum-rpc-endpoints.json";
import type { EvmChain } from "../chain";

/** The official endpoint (the pool in makeRpc() covers every public one). */
export const ROBINHOOD_RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_TOPIC = "0x" + "0".repeat(64);
/** This RPC rejects eth_getLogs spans wider than 10,000,000 blocks. */
export const MAX_SPAN = 10_000_000;

export class RpcError extends Error {
  constructor(
    message: string,
    public code?: number,
    /** Revert data of a failed eth_call, when the node returns it. */
    public data?: string,
  ) {
    super(message);
  }
}

/**
 * A real EVM revert (the call ran and the contract rejected it), as opposed to a transport failure
 * (timeout, 429, HTTP 5xx, network). Only a revert may be read as "function absent" / "sell blocked".
 * Reverts come back as a JSON-RPC error with revert data, code 3, or an "execution reverted" message.
 * Anything else (no RpcError, an HTTP status, a JSON-RPC error without revert data) is a failed read.
 */
export function isRevert(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // post() puts the HTTP status in `code` for non-2xx responses: never a revert.
  if (/^RPC HTTP \d+/.test(err.message)) return false;
  if (err instanceof RpcError && (err.data !== undefined || err.code === 3)) return true;
  // The node's own wording (wrappers may rethrow it as a plain Error). Out of gas / invalid opcode are
  // execution outcomes of the call too (a gas-burning hook), not transport.
  return /execution reverted|\brevert|out of gas|invalid opcode/i.test(err.message);
}

/** Short text of a failed call, for "owner() read failed: …" reasons. */
export const errText = (err: unknown) => (err instanceof Error ? err.message || err.name : String(err)).slice(0, 100);

/**
 * eth_call that tells a revert from a transport failure: `{ value }` on success, `{ value: null }` on a
 * revert (e.g. no owner() function), `{ value: null, error }` when the read itself failed.
 */
export async function callOrRevert(rpc: Rpc, to: string, data: string, timeoutMs = 10_000): Promise<{ value: string | null; error?: string }> {
  try {
    return { value: await rpc<string>("eth_call", [{ to, data }, "latest"], timeoutMs) };
  } catch (err) {
    return isRevert(err) ? { value: null } : { value: null, error: errText(err) };
  }
}

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export type Rpc = <T = unknown>(method: string, params: unknown[], timeoutMs?: number) => Promise<T>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Endpoint-level failures (rotate to another endpoint); JSON-RPC errors like reverts are the call's own. */
const endpointFault = (e: unknown) =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || /\b(403|408|429|5\d\d)\b|rate|limit exceeded|too many|busy|ECONNRESET|fetch failed|socket|network/i.test(e.message));
const isRateLimit = (e: unknown) => e instanceof Error && /\b429\b|rate|too many/i.test(e.message);

async function post<T>(url: string, method: string, params: unknown[], timeoutMs: number): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    // AbortSignal.timeout needs a whole number of ms (a computed share of a deadline can be fractional).
    signal: AbortSignal.timeout(Math.max(1, Math.round(timeoutMs))),
    cache: "no-store",
  });
  if (!res.ok) throw new RpcError(`RPC HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: string } };
  if (body.error) throw new RpcError(body.error.message, body.error.code, typeof body.error.data === "string" ? body.error.data : undefined);
  return body.result as T;
}

interface Endpoint {
  url: string;
  /** Serves eth_getLogs over wide ranges. */
  logs: boolean;
  /** Serves eth_getLogs, but slowly (probed): used only while every primary log endpoint is cooling down. */
  logsFallback: boolean;
  /** Smoothed latency of successful calls (ms); a slow endpoint goes behind fast ones. */
  ewmaMs: number | null;
  /** Supports eth_call state overrides (the sell simulation needs them). */
  override: boolean;
  coolUntil: number;
}

/** Per-endpoint counters (calls, 429s, other endpoint failures) — reported by the RPC check script. */
export const rpcStats: Record<string, { calls: number; r429: number; faults: number }> = {};

/** Each EVM chain's public endpoint list (probed; see the file's note) and the env var that puts a private endpoint first. */
const ENDPOINTS: Record<EvmChain, { list: { endpoints: unknown[] }; env: string }> = {
  robinhood: { list: rpcEndpoints, env: "ROBINHOOD_RPC_URL" },
  base: { list: baseRpcEndpoints, env: "BASE_RPC_URL" },
  monad: { list: monadRpcEndpoints, env: "MONAD_RPC_URL" },
  ethereum: { list: ethereumRpcEndpoints, env: "ETHEREUM_RPC_URL" },
};

/** The chain's endpoint list as probed (data/<chain>-rpc-endpoints.json). */
export function endpointList(chain: EvmChain): { url: string; logs: string | boolean; logsMaxSpan?: number; historical?: boolean | null }[] {
  return ENDPOINTS[chain].list.endpoints as { url: string; logs: string | boolean; logsMaxSpan?: number; historical?: boolean | null }[];
}

/** Widest eth_getLogs span the chain's log-capable public endpoints serve (Robinhood: MAX_SPAN). */
export function chainLogSpan(chain: EvmChain): number {
  if (chain === "robinhood") return MAX_SPAN;
  return Math.max(...endpointList(chain).filter((e) => e.logs === true || e.logs === "full").map((e) => e.logsMaxSpan ?? 0), 1_000);
}

function endpointPool(chain: EvmChain = "robinhood"): Endpoint[] {
  const { list: file, env } = ENDPOINTS[chain];
  const list: Endpoint[] = (file.endpoints as { url: string; logs: string | boolean; override: boolean }[]).map((e) => ({
    url: e.url,
    logs: e.logs === "full" || e.logs === true,
    logsFallback: e.logs === "fallback",
    override: e.override,
    coolUntil: 0,
    ewmaMs: null,
  }));
  const own = process.env[env];
  // ROBINHOOD_RPC_URL (e.g. a private endpoint) goes first and is assumed fully capable.
  return own ? [{ url: own, logs: true, logsFallback: false, override: true, coolUntil: 0, ewmaMs: null }, ...list.filter((e) => e.url !== own)] : list;
}
const pools: Partial<Record<EvmChain, Endpoint[]>> = {};
let turn = 0;

/**
 * Robinhood Chain JSON-RPC across every public endpoint in data/rpc-endpoints.json. Each call
 * goes to a healthy endpoint that supports the method (eth_getLogs → full-log endpoints, state-
 * override eth_call → override-capable ones), round-robin. 429 / 5xx / timeouts put the endpoint on
 * a cooldown (20s for 429, 10s otherwise) and the call moves on; JSON-RPC errors (reverts, range
 * limits) are returned as they are. Pass `url` to pin a single endpoint (tests, probes).
 */
export function makeRpc(url?: string, retryDelays = [500, 1000, 2000], chain: EvmChain = "robinhood"): Rpc {
  if (url) {
    return async <T,>(method: string, params: unknown[], timeoutMs = 25_000): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await post<T>(url, method, params, timeoutMs);
        } catch (err) {
          if (attempt >= retryDelays.length || !endpointFault(err)) throw err;
          await sleep(retryDelays[attempt]);
        }
      }
    };
  }
  const endpoints = (pools[chain] ??= endpointPool(chain));
  return async <T,>(method: string, params: unknown[], timeoutMs = 25_000): Promise<T> => {
    const fits = endpoints.filter((e) => (method === "eth_getLogs" ? e.logs || e.logsFallback : true) && (method === "eth_call" && params.length >= 3 ? e.override : true));
    let lastErr: unknown = null;
    for (let round = 0; round < 3; round++) {
      const now = Date.now();
      const start = turn++ % fits.length;
      // Round-robin spreads load; healthy before cooling, primary log endpoints before fallbacks, and an endpoint
      // measured slow (> 4s smoothed, > 3× the fastest) behind the fast ones.
      const best = Math.min(...fits.map((e) => e.ewmaMs ?? Infinity));
      const slow = (e: Endpoint) => e.ewmaMs != null && e.ewmaMs > 4_000 && e.ewmaMs > 3 * best;
      const rank = (e: Endpoint) => (e.coolUntil > now ? 4 : 0) + (method === "eth_getLogs" && !e.logs ? 2 : 0) + (slow(e) ? 1 : 0);
      const order = [...fits.slice(start), ...fits.slice(0, start)].sort((a, b) => rank(a) - rank(b));
      for (const e of order) {
        if (e.coolUntil > Date.now() && order.some((x) => x.coolUntil <= Date.now())) continue;
        const st = (rpcStats[e.url] ??= { calls: 0, r429: 0, faults: 0 });
        st.calls++;
        const t0 = Date.now();
        try {
          const out = await post<T>(e.url, method, params, timeoutMs);
          const ms = Date.now() - t0;
          e.ewmaMs = e.ewmaMs == null ? ms : Math.round(e.ewmaMs * 0.7 + ms * 0.3);
          return out;
        } catch (err) {
          if (!endpointFault(err)) throw err;
          lastErr = err;
          if (isRateLimit(err)) st.r429++;
          else st.faults++;
          e.coolUntil = Date.now() + (isRateLimit(err) ? 20_000 : 10_000);
        }
      }
      // Every fitting endpoint is cooling down: wait for the first to come back (bounded).
      const wait = Math.min(...fits.map((e) => e.coolUntil)) - Date.now();
      await sleep(Math.max(250, Math.min(wait, 5_000)));
    }
    throw lastErr ?? new RpcError(`no ${chain} RPC endpoint available`);
  };
}

/** The endpoint pool for one EVM chain (Robinhood Chain, Base, Monad, Ethereum). */
export const chainRpc = (chain: EvmChain): Rpc => makeRpc(undefined, undefined, chain);

/**
 * Endpoints that serve state at old blocks (`historical: true` in the chain's endpoint file), tried in
 * order. Robinhood Chain has none (its RPC keeps no historical state): null. BASE_RPC_URL / MONAD_RPC_URL / ETHEREUM_RPC_URL go first.
 */
export function archiveUrls(chain: EvmChain): string[] {
  const { list, env } = ENDPOINTS[chain];
  const urls = (list.endpoints as { url: string; historical?: boolean | null }[]).filter((e) => e.historical === true).map((e) => e.url);
  const own = process.env[env];
  return own ? [own, ...urls.filter((u) => u !== own)] : urls;
}

/**
 * JSON-RPC against the archive-capable endpoints only, in file order (fastest first — parallel
 * bisection rounds wait for their slowest call), failing over to the next on endpoint faults.
 */
export function archiveRpc(chain: EvmChain): Rpc | null {
  const urls = archiveUrls(chain);
  if (!urls.length) return null;
  const single = urls.map((u) => makeRpc(u, [400], chain));
  return async <T,>(method: string, params: unknown[], timeoutMs = 15_000): Promise<T> => {
    let last: unknown = null;
    for (let i = 0; i < single.length; i++) {
      try {
        return await single[i]<T>(method, params, timeoutMs);
      } catch (err) {
        if (!endpointFault(err)) throw err;
        last = err;
      }
    }
    throw last ?? new RpcError(`no ${chain} archive endpoint available`);
  };
}

/**
 * eth_getLogs against the chain's log-capable endpoints only, in file order (private endpoint first),
 * moving to the next on ANY error — public endpoints tighten their range caps without notice, and a
 * range error from one is not an answer about the logs.
 */
export function logsRpc(chain: EvmChain): Rpc {
  const { list, env } = ENDPOINTS[chain];
  const listed = (list.endpoints as { url: string; logs: string | boolean }[]).filter((e) => e.logs === true || e.logs === "full").map((e) => e.url);
  const own = process.env[env];
  const urls = own ? [own, ...listed.filter((u) => u !== own)] : listed;
  const single = urls.map((u) => makeRpc(u, [400], chain));
  return async <T,>(method: string, params: unknown[], timeoutMs = 15_000): Promise<T> => {
    // The first endpoint's error is the one reported: a fallback with a tighter range cap must not make a
    // transient failure of the primary look like "range too wide".
    let first: unknown = null;
    for (const call of single) {
      try {
        return await call<T>(method, params, timeoutMs);
      } catch (err) {
        first ??= err;
      }
    }
    throw first ?? new RpcError(`no ${chain} log endpoint available`);
  };
}

/** Test hook: forget cooldowns. */
export function resetRpcPool() {
  for (const k of Object.keys(pools)) delete pools[k as EvmChain];
  for (const k of Object.keys(rpcStats)) delete rpcStats[k];
}

export const hex = (n: number) => "0x" + n.toString(16);
export const topicAddress = (topic: string) => "0x" + topic.slice(-40).toLowerCase();
export const addressTopic = (addr: string) => "0x" + "0".repeat(24) + addr.toLowerCase().slice(2);

/** Contracts with more than this much bytecode (pools, routers, launchpads) count as liquidity, not wallets.
 *  Minimal-proxy smart wallets (45 bytes) and EIP-7702 delegations (23 bytes) stay wallets. */
export const LARGE_CONTRACT_BYTES = 100;

export function codeKind(code: string | null | undefined): "wallet" | "contract" {
  const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  return bytes > LARGE_CONTRACT_BYTES ? "contract" : "wallet";
}

/** Splits [from, to] into windows no wider than MAX_SPAN, newest first. */
export function windowsBackward(from: number, to: number, span = MAX_SPAN): [number, number][] {
  const out: [number, number][] = [];
  for (let end = to; end >= from; end -= span) out.push([Math.max(from, end - span + 1), end]);
  return out;
}
