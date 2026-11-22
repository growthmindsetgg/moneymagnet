import { keccak_256 } from "@noble/hashes/sha3";
import type { AdapterResult, TokenSnapshot } from "../types";
import { chainRpc, type Rpc } from "../onchain/rpc";
import { chainInfraEntry, findInfra } from "../onchain/chainInfra";
import { fetchJson } from "./http";

/**
 * Base-only sources (docs/chains/base.md):
 * - Basescan = the Etherscan v2 API with chainid=8453 (BASESCAN_API_KEY; Base needs a paid Etherscan plan —
 *   the free plan answers "Free API access is not supported for this chain"): creator, creation time, verified.
 * - Launchpad detection from on-chain views, no creation-tx lookup (tx.to is a wrapper or a 4337 EntryPoint
 *   on Base): the hook of the token's v4 pools (Clanker / Zora / Doppler / Flaunch / b2-vanity hooks in
 *   data/base-infra.json), Flaunch `flaunch()`, Virtuals v1 Bonding as `owner()`, Doppler `Airlock.getAssetData`.
 */
const sel = (sig: string) => "0x" + Buffer.from(keccak_256(sig)).toString("hex").slice(0, 8);
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const wordAddr = (hex: string | null, i = 0) => (hex && hex.length >= 66 + i * 64 ? "0x" + hex.slice(26 + i * 64, 66 + i * 64) : null);

export function baseAdapters(address: string): [string, () => Promise<AdapterResult>][] {
  return [["basescan", () => basescan(address)]];
}

export async function basescan(address: string): Promise<AdapterResult> {
  // One Etherscan v2 key serves every chain: BASESCAN_API_KEY first, else ETHERSCAN_API_KEY (Base still needs a paid plan).
  const key = process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY;
  if (!key) return { status: { id: "basescan", label: "Basescan", state: "skipped", message: "BASESCAN_API_KEY not set (Etherscan v2; Base needs a paid plan)" }, data: {} };
  return etherscanV2({ id: "basescan", label: "Basescan", chainid: 8453, key, page: "https://basescan.org/token/" }, address);
}

/**
 * Contract creator + creation time + verified source from the Etherscan v2 API (one key, `chainid` picks the chain):
 * Basescan (8453) and Etherscan (1) share it.
 */
export async function etherscanV2(src: { id: string; label: string; chainid: number; key: string; page: string }, address: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const a = address.toLowerCase();
  const key = src.key;
  const api = (q: string) => fetchJson<{ status: string; message: string; result: unknown }>(`https://api.etherscan.io/v2/api?chainid=${src.chainid}&${q}&apikey=${key}`);
  const [creation, source] = await Promise.all([api(`module=contract&action=getcontractcreation&contractaddresses=${a}`), api(`module=contract&action=getsourcecode&address=${a}`)]);
  const data: Partial<TokenSnapshot> = {};
  const notes: string[] = [];
  const c = Array.isArray(creation.result) ? (creation.result[0] as { contractCreator?: string; timestamp?: string } | undefined) : undefined;
  if (creation.status === "1" && c?.contractCreator) {
    data.deployerAddress = c.contractCreator.toLowerCase();
    if (c.timestamp) data.createdAt = new Date(Number(c.timestamp) * 1000).toISOString();
    notes.push(`creator ${data.deployerAddress.slice(0, 8)}…`);
  } else notes.push(`creation: ${String(creation.result).slice(0, 80)}`);
  const s = Array.isArray(source.result) ? (source.result[0] as { SourceCode?: string; Proxy?: string } | undefined) : undefined;
  if (source.status === "1" && s) {
    data.verified = !!s.SourceCode;
    notes.push(data.verified ? "verified source" : "unverified");
  }
  const ok = creation.status === "1" || source.status === "1";
  return { status: { id: src.id, label: src.label, state: ok ? "ok" : "failed", message: notes.join(" · "), ms: Date.now() - t0, url: `${src.page}${a}` }, data };
}

async function call(rpc: Rpc, to: string, data: string): Promise<string | null> {
  return rpc<string>("eth_call", [{ to, data }, "latest"], 8_000).catch(() => null);
}

/** Launchpad name from the hook of one of the token's v4 pools (PositionManager.poolKeys). */
async function launchpadByHook(rpc: Rpc, poolIds: string[]): Promise<{ launchpad: string; how: string } | null> {
  const pm = findInfra("base", "liquidity-manager", /v4.*PositionManager/i);
  if (!pm) return null;
  for (const id of poolIds.slice(0, 4)) {
    const key = await call(rpc, pm.address, sel("poolKeys(bytes25)") + id.slice(2, 52).padEnd(64, "0"));
    const hooks = wordAddr(key, 4);
    const e = hooks ? chainInfraEntry("base", hooks) : undefined;
    if (e?.launchpad && (e.role === "hook" || e.role === "launchpad-factory")) return { launchpad: e.launchpad, how: `v4 pool ${id.slice(0, 10)}… uses ${e.label}` };
  }
  return null;
}

export async function baseLaunchExtras(address: string, results: AdapterResult[], young: boolean, opts: { rpc?: Rpc } = {}): Promise<AdapterResult> {
  const t0 = Date.now();
  const rpc = opts.rpc ?? chainRpc("base");
  const a = address.toLowerCase();
  const ds = results.find((r) => r.status.id === "dexscreener")?.raw as { pairs?: { pairAddress: string }[] } | undefined;
  const gp = results.find((r) => r.status.id === "goplus")?.raw as { dex?: { pair: string }[] } | undefined;
  const v4Ids = [...new Set([...(ds?.pairs ?? []).map((p) => p.pairAddress), ...(gp?.dex ?? []).map((p) => p.pair)].map((x) => x.toLowerCase()).filter((x) => /^0x[0-9a-f]{64}$/.test(x)))];
  const airlock = findInfra("base", "launchpad-factory", /Doppler Airlock/i);
  const [byHook, ownKeyHex, flaunchHex, ownerHex, assetHex] = await Promise.all([
    launchpadByHook(rpc, v4Ids),
    call(rpc, a, sel("getPoolKey()")),
    call(rpc, a, sel("flaunch()")),
    call(rpc, a, "0x8da5cb5b"),
    airlock ? call(rpc, airlock.address, sel("getAssetData(address)") + addrWord(a)) : Promise.resolve(null),
  ]);
  let found: { launchpad: string; how: string } | null = byHook;
  // Zora coins (and other hooked coins) expose their own pool key: its hook names the launchpad.
  const ownHook = wordAddr(ownKeyHex, 4);
  const ownHookEntry = ownHook ? chainInfraEntry("base", ownHook) : undefined;
  if (!found && ownHookEntry?.launchpad) found = { launchpad: ownHookEntry.launchpad, how: `token getPoolKey() hook = ${ownHookEntry.label}` };
  const flaunchNft = wordAddr(flaunchHex);
  if (!found && flaunchNft && chainInfraEntry("base", flaunchNft)?.launchpad === "Flaunch") found = { launchpad: "Flaunch", how: "token flaunch() = the Flaunch NFT" };
  const owner = wordAddr(ownerHex);
  const ownerEntry = owner ? chainInfraEntry("base", owner) : undefined;
  if (!found && ownerEntry?.launchpad === "Virtuals") found = { launchpad: "Virtuals", how: `token owner() = ${ownerEntry.label}` };
  // Doppler: getAssetData's first words are the numeraire etc.; a registered asset has a non-zero record.
  if (!found && assetHex && assetHex.length >= 66 && !/^0x0*$/.test(assetHex)) found = { launchpad: "Doppler", how: "Doppler Airlock.getAssetData(token) is set" };
  const data: Partial<TokenSnapshot> = {};
  if (found) {
    data.isLaunchpad = true;
    data.launchpad = found.launchpad;
  } else data.nullReasons = { isLaunchpad: "no registered launchpad hook / view matched (the creation tx is not read: no address index, and tx.to is often a wrapper on Base)" };
  void young;
  return {
    status: { id: "base-launch", label: "Base launch signals", state: found ? "ok" : "partial", message: found ? `${found.launchpad}: ${found.how}` : data.nullReasons!.isLaunchpad, ms: Date.now() - t0 },
    data,
  };
}
