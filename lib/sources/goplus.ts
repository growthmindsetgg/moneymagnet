import type { AdapterResult, Chain, HolderRow, TokenSnapshot } from "../types";
import { fetchJson } from "./http";

/**
 * GoPlus token_security (keyless): https://api.gopluslabs.io/api/v1/token_security/<chainId>?contract_addresses=<ca>
 * Base 8453 and Monad 143. Its fields are GoPlus's own analysis (a claim, not our measurement); the
 * sell simulation is the measured sellability, and the verifier compares them. Rate limit: a 20-call
 * burst gets ~10 answers, then `code 4029 too many requests` (treated as an outage, served stale).
 * Monad: no creator / owner fields, and nad.fun curve tokens get holders only (no honeypot / tax verdict).
 */
const CHAIN_ID: Partial<Record<Chain, number>> = { base: 8453, monad: 143 };

interface GpHolder {
  address: string;
  tag?: string;
  is_contract: number;
  balance: string;
  percent: string;
  is_locked: number;
}
interface GpResult {
  token_name?: string;
  token_symbol?: string;
  total_supply?: string;
  holder_count?: string;
  holders?: GpHolder[];
  lp_holders?: GpHolder[];
  lp_total_supply?: string;
  is_honeypot?: string;
  cannot_sell_all?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_mintable?: string;
  is_open_source?: string;
  is_proxy?: string;
  owner_address?: string;
  creator_address?: string;
  creator_percent?: string;
  is_in_dex?: string;
  dex?: { name: string; liquidity_type?: string; liquidity?: string; pair: string; pool_manager?: string; pool_fee?: string }[];
  hidden_owner?: string;
  can_take_back_ownership?: string;
  transfer_pausable?: string;
  is_blacklisted?: string;
}

const flag = (v: string | undefined) => (v === "1" ? true : v === "0" ? false : null);
const num = (v: string | undefined) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export async function goplus(chain: Chain, address: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const id = CHAIN_ID[chain];
  if (!id) return { status: { id: "goplus", label: "GoPlus", state: "skipped", message: `GoPlus not used on ${chain}` }, data: {} };
  const a = address.toLowerCase();
  const url = `https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${a}`;
  const res = await fetchJson<{ code: number; message: string; result?: Record<string, GpResult> }>(url);
  if (res.code !== 1) {
    // 4029 = rate limited: an outage, not an answer.
    throw new Error(`GoPlus code ${res.code}: ${res.message}`.slice(0, 120));
  }
  const r = res.result?.[a] ?? Object.values(res.result ?? {})[0];
  if (!r || !Object.keys(r).length) {
    return { status: { id: "goplus", label: "GoPlus", state: "partial", message: "GoPlus has no record of this token", ms: Date.now() - t0, url: `https://gopluslabs.io/token-security/${id}/${a}` }, data: {}, raw: res };
  }
  const nullReasons: Record<string, string> = {};
  const data: Partial<TokenSnapshot> = {};
  const holders: HolderRow[] = (r.holders ?? []).map((h) => ({
    address: h.address.toLowerCase(),
    qty: num(h.balance),
    pct: num(h.percent) != null ? num(h.percent)! * 100 : null,
    buys: null,
    sells: null,
    isContract: h.is_contract === 1,
    // Contracts (pools, lockers, curves) and locked balances are not holder conviction.
    kind: h.is_contract === 1 || h.is_locked === 1 ? "liquidity" : "wallet",
    ...(h.tag ? { label: h.tag } : h.is_locked === 1 ? { label: "locked (GoPlus)" } : {}),
  }));
  if (holders.length) {
    const wallets = holders.filter((h) => h.kind === "wallet");
    data.holders = holders;
    data.holderSource = "goplus";
    data.top1SharePct = wallets[0]?.pct ?? 0;
    data.top10SharePct = Math.round(wallets.slice(0, 10).reduce((s, h) => s + (h.pct ?? 0), 0) * 100) / 100;
    data.liquidityHolders = holders.filter((h) => h.kind === "liquidity");
    data.liquidityHeldPct = Math.round(data.liquidityHolders.reduce((s, h) => s + (h.pct ?? 0), 0) * 100) / 100;
  }
  data.holderCount = num(r.holder_count);
  if (r.token_name) data.name = r.token_name;
  if (r.token_symbol) data.symbol = r.token_symbol;
  // A honeypot verdict is GoPlus's own simulation claim — only when it gives one (nad.fun curve tokens get none).
  const hp = flag(r.is_honeypot);
  if (hp != null) {
    data.honeypot = hp;
    if (hp) data.sellable = false;
  } else nullReasons.honeypot = "GoPlus gave no honeypot verdict (token not on a DEX it indexes)";
  data.mintAuthority = flag(r.is_mintable);
  data.verified = flag(r.is_open_source);
  data.upgradeable = flag(r.is_proxy);
  const owner = r.owner_address?.toLowerCase();
  if (owner !== undefined && owner !== "") data.ownerRenounced = /^0x0{40}$/.test(owner) || owner.endsWith("dead");
  if (r.creator_address) data.deployerAddress = r.creator_address.toLowerCase();
  else nullReasons.deployerAddress = `GoPlus returns no creator for chain ${id}`;
  const creatorPct = num(r.creator_percent);
  if (r.creator_address && creatorPct != null) data.deployerHoldingPct = creatorPct * 100;
  // LP lock: share of LP (v2 tokens / v4 NFTs) GoPlus marks locked or burned.
  const lp = r.lp_holders ?? [];
  if (lp.length) data.lpLockedPct = Math.round(lp.filter((h) => h.is_locked === 1 || /dead$|^0x0{40}$/.test(h.address)).reduce((s, h) => s + (num(h.percent) ?? 0), 0) * 10_000) / 100;
  else nullReasons.lpLockedPct = "GoPlus lists no LP holders";
  const notes = [
    `${data.holderCount ?? "?"} holders`,
    hp == null ? "no honeypot verdict" : hp ? "honeypot: YES (GoPlus)" : "honeypot: no (GoPlus)",
    r.sell_tax ? `sell tax ${Math.round(Number(r.sell_tax) * 1000) / 10}%` : null,
    data.mintAuthority ? "mintable" : null,
    data.upgradeable ? "proxy" : null,
  ].filter(Boolean);
  data.nullReasons = nullReasons;
  return {
    status: { id: "goplus", label: "GoPlus", state: "ok", message: notes.join(" · "), ms: Date.now() - t0, url: `https://gopluslabs.io/token-security/${id}/${a}` },
    data,
    raw: { sellTax: num(r.sell_tax), buyTax: num(r.buy_tax), dex: r.dex ?? [], cannotSellAll: flag(r.cannot_sell_all), transferPausable: flag(r.transfer_pausable), hiddenOwner: flag(r.hidden_owner), blacklist: flag(r.is_blacklisted) },
  };
}
