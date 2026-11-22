import type { AdapterResult, FakeSignal, HolderRow } from "../types";
import { fetchJson, num } from "./http";
import { PLATFORM_AUTHORITIES } from "./helius";

interface RcReport {
  mint: string;
  creator?: string | null;
  creatorBalance?: number | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  token?: { supply?: number; decimals?: number; mintAuthority?: string | null; freezeAuthority?: string | null };
  tokenMeta?: { name?: string; symbol?: string; mutable?: boolean };
  tokenProgram?: string;
  topHolders?: { owner: string; address: string; pct: number; uiAmount: number; insider?: boolean }[];
  knownAccounts?: Record<string, { name: string; type: string }>;
  markets?: {
    pubkey?: string;
    marketType?: string;
    liquidityA?: string;
    liquidityB?: string;
    liquidityAAccount?: { owner?: string } | null;
    liquidityBAccount?: { owner?: string } | null;
    lp?: { lpLockedPct?: number; lpLockedUSD?: number };
  }[];
  risks?: { name: string; description?: string; level?: string; value?: string }[];
  totalHolders?: number;
  transferFee?: { pct?: number } | null;
  token_extensions?: unknown;
  rugged?: boolean;
  detectedAt?: string;
  graphInsidersDetected?: number;
  insiderNetworks?: { id: string; size: number; type: string; tokenAmount?: number }[] | null;
  launchpad?: { name?: string; platform?: string } | null;
  tokenMeta_uri?: string;
}

const SOCIAL_KEYS = ["twitter", "telegram", "website", "discord", "x"];

/** Reads the token's metadata JSON (usually IPFS) for social links. Null with a reason on failure. */
async function metadataSocials(uri: string | undefined): Promise<{ has: boolean | null; links: string | null; reason?: string }> {
  if (!uri) return { has: null, links: null, reason: "token has no metadata URI" };
  // Several public gateways: a rate-limited gateway is a source failure, not "no socials".
  const cid = uri.startsWith("ipfs://") ? uri.slice(7) : uri.match(/\/ipfs\/(.+)$/)?.[1] ?? null;
  const urls = cid ? [`https://ipfs.io/ipfs/${cid}`, `https://dweb.link/ipfs/${cid}`, `https://gateway.pinata.cloud/ipfs/${cid}`, `https://cloudflare-ipfs.com/ipfs/${cid}`] : [uri];
  if (cid && !uri.startsWith("ipfs://")) urls.unshift(uri);
  try {
    let meta: Record<string, unknown> | null = null;
    let lastErr: unknown = null;
    for (const url of urls) {
      try {
        meta = await fetchJson<Record<string, unknown>>(url, { timeoutMs: 6000 });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!meta) throw lastErr ?? new Error("no gateway answered");
    const ext = (meta.extensions && typeof meta.extensions === "object" ? meta.extensions : {}) as Record<string, unknown>;
    const found = SOCIAL_KEYS.flatMap((k) => {
      const v = meta[k] ?? ext[k];
      return typeof v === "string" && v.trim() ? [`${k}: ${v.trim()}`] : [];
    });
    return { has: found.length > 0, links: found.join(", ") || null };
  } catch (e) {
    return { has: null, links: null, reason: `metadata fetch failed: ${(e as Error).message.slice(0, 80)}` };
  }
}

export async function rugcheck(mint: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const r = await fetchJson<RcReport>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeoutMs: 30_000 });
  const socials = await metadataSocials((r.tokenMeta as { uri?: string } | undefined)?.uri);
  const decimals = r.token?.decimals ?? 0;
  const supply = r.token?.supply != null ? r.token.supply / 10 ** decimals : null;

  // Exclude AMM / pool vaults from holder concentration.
  const known = r.knownAccounts ?? {};
  const poolAccounts = new Set<string>();
  for (const [addr, k] of Object.entries(known)) if (/amm|pool|lp|locker/i.test(`${k.type} ${k.name}`)) poolAccounts.add(addr);
  for (const m of r.markets ?? []) {
    for (const x of [m.pubkey, m.liquidityA, m.liquidityB, m.liquidityAAccount?.owner, m.liquidityBAccount?.owner]) if (x) poolAccounts.add(x);
  }
  const holders: HolderRow[] = (r.topHolders ?? [])
    .filter((h) => !poolAccounts.has(h.owner) && !poolAccounts.has(h.address))
    .map((h) => ({ address: h.owner, qty: h.uiAmount, pct: h.pct, buys: null, sells: null, isContract: false, label: h.insider ? "insider" : undefined }));

  // The best-locked market is the one that matters: pump.fun graduates burn the main LP.
  const lp = (r.markets ?? []).filter((m) => m.lp?.lpLockedPct != null);
  const lpLockedPct = lp.length ? Math.max(...lp.map((m) => m.lp!.lpLockedPct!)) : null;

  const signals: FakeSignal[] = [];
  const insiderNetworks = Array.isArray(r.insiderNetworks) ? r.insiderNetworks.length : null;
  if (r.graphInsidersDetected) {
    signals.push({
      kind: "insider",
      level: r.graphInsidersDetected > 50 ? "warn" : "info",
      text: `${r.graphInsidersDetected} insider-linked wallets across ${insiderNetworks ?? "?"} networks (RugCheck graph)`,
      source: "RugCheck",
    });
  }
  const insiderTop = holders.filter((h) => h.label === "insider").length;
  if (insiderTop) signals.push({ kind: "insider", level: "warn", text: `${insiderTop} of the top holders are flagged insiders`, source: "RugCheck" });
  for (const risk of r.risks ?? []) {
    signals.push({
      kind: "other",
      level: risk.level === "danger" ? "danger" : risk.level === "warn" ? "warn" : "info",
      text: `${risk.name}${risk.value ? ` (${risk.value})` : ""}`,
      source: "RugCheck",
    });
  }
  if (r.rugged) signals.push({ kind: "other", level: "danger", text: "RugCheck marks this token as rugged", source: "RugCheck" });
  const extFlags = (r.token_extensions ?? {}) as { permanentDelegate?: unknown };
  if (extFlags.permanentDelegate) signals.push({ kind: "other", level: "danger", text: "Token-2022 permanent delegate is set — tokens can be moved out of any wallet", source: "RugCheck" });

  // A field RugCheck omitted is unknown, not "revoked": only a key that is present (null = revoked) counts.
  const has = (o: object | null | undefined, k: string) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const mintKnown = has(r.token, "mintAuthority") || has(r, "mintAuthority");
  const freezeKnown = has(r.token, "freezeAuthority") || has(r, "freezeAuthority");
  const mintAuth = r.token?.mintAuthority ?? r.mintAuthority ?? null;
  const freezeAuth = r.token?.freezeAuthority ?? r.freezeAuthority ?? null;
  // Transfer fee: only when RugCheck reported one (a skeletal report has no transferFee block).
  const feePct = r.transferFee != null ? num(r.transferFee.pct) : null;
  const ext = (r.token_extensions ?? {}) as { transferHook?: { programId?: string | null } | null; nonTransferable?: boolean; permanentDelegate?: unknown };
  // A hook only exists when the extension names a hook program.
  const hasHook = !!ext.transferHook?.programId;
  const creatorUi = r.creatorBalance != null ? r.creatorBalance / 10 ** decimals : null;
  // Guide p.18: share of supply moved inside RugCheck insider networks.
  const supplyRaw = r.token?.supply ?? null;
  const insiderAmount = Array.isArray(r.insiderNetworks) ? r.insiderNetworks.reduce((a, n) => a + (n.tokenAmount ?? 0), 0) : null;
  const insiderSupplyPct = insiderAmount != null && supplyRaw ? Math.min(100, (insiderAmount / supplyRaw) * 100) : r.insiderNetworks === null ? 0 : null;
  const launchpadName = r.launchpad?.name ?? r.launchpad?.platform ?? null;
  const nullReasons: Record<string, string> = {};
  if (socials.has === null && socials.reason) nullReasons.creatorHasSocials = socials.reason;
  // RugCheck names the pump.fun platform authority as "creator" on some mints — never a real creator.
  const creator = r.creator && !PLATFORM_AUTHORITIES.has(r.creator) ? r.creator : null;
  if (r.creator && !creator) nullReasons.deployerAddress = `RugCheck lists the shared platform authority ${r.creator.slice(0, 6)}… as creator`;
  if (!mintKnown) nullReasons.mintAuthority = "RugCheck report has no mintAuthority field";
  if (!freezeKnown) nullReasons.freezeAuthority = "RugCheck report has no freezeAuthority field";
  // Spec: Solana sellable = transfer fee < 50% AND no transfer hook AND freeze authority null. Any failing leg
  // decides "not sellable"; "sellable" needs every leg reported (a missing field is not a pass).
  const sellable = (freezeKnown && freezeAuth !== null) || hasHook || (feePct != null && feePct >= 50) ? false : freezeKnown && feePct != null ? true : null;
  if (sellable === null) {
    nullReasons.sellable = `RugCheck report lacks ${[!freezeKnown ? "freezeAuthority" : "", feePct == null ? "transferFee" : ""].filter(Boolean).join(" and ")} — sellability rule not evaluated`;
  }
  // RugCheck runs no swap: its transfer fee taken twice is a derived lower bound, never a simulated round trip.
  // It is not reported as roundTripLossPct (whose evidence reads "Simulated buy→sell"); a real fee is shown as a signal.
  const feeRoundTripPct = feePct != null ? feePct * 2 : null;
  if (feePct != null && feePct > 0) {
    signals.push({
      kind: "other",
      level: feePct >= 10 ? "warn" : "info",
      text: `Token-2022 transfer fee ${feePct}% per transfer — about ${feeRoundTripPct}% on a buy→sell round trip (derived from RugCheck's fee ×2, not a simulation)`,
      source: "RugCheck",
    });
  }

  return {
    status: {
      id: "rugcheck",
      label: "RugCheck",
      state: "ok",
      message: [
        `score ${(r as { score?: number }).score ?? "?"}, ${r.risks?.length ?? 0} risks`,
        feePct != null ? `transfer fee ${feePct}%` : "no transfer-fee field",
        r.detectedAt ? `first detected ${r.detectedAt.slice(0, 16)}Z (not the creation time)` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      ms: Date.now() - t0,
      url: `https://rugcheck.xyz/tokens/${mint}`,
    },
    data: {
      name: r.tokenMeta?.name ?? null,
      symbol: r.tokenMeta?.symbol ?? null,
      totalSupply: supply,
      holderCount: num(r.totalHolders),
      mintAuthority: mintKnown ? mintAuth !== null : null,
      freezeAuthority: freezeKnown ? freezeAuth !== null : null,
      sellable,
      insiderSupplyPct,
      isLaunchpad: launchpadName ? true : null,
      launchpad: launchpadName,
      creatorHasSocials: socials.has,
      socialLinks: socials.links,
      nullReasons,
      lpLockedPct,
      deployerAddress: creator,
      deployerHoldingPct: creator && creatorUi != null && supply ? (creatorUi / supply) * 100 : null,
      insiderNetworks,
      holders,
      holderSource: holders.length ? "rugcheck" : null,
      // Pool vaults, their owners and RugCheck-labelled AMM / locker accounts, so other sources'
      // holder lists (e.g. Helius largest accounts) exclude them too, not only RugCheck's own.
      poolAddresses: [...poolAccounts],
      // `detectedAt` is when RugCheck first saw the token, not its creation: never fed in as createdAt (age disputes
      // resolve to the youngest reading, so a late detection would put an old token into launch mode). Kept in raw.
      fakeSignals: signals,
      links: [{ label: "RugCheck", url: `https://rugcheck.xyz/tokens/${mint}` }],
    },
    raw: {
      mintAuthority: mintAuth,
      freezeAuthority: freezeAuth,
      creator: r.creator,
      creatorBalance: r.creatorBalance,
      risks: r.risks,
      topHolders: (r.topHolders ?? []).slice(0, 15),
      markets: (r.markets ?? []).map((m) => ({ type: m.marketType, lp: m.lp })),
      transferFee: r.transferFee,
      derivedFeeRoundTripPct: feeRoundTripPct,
      detectedAt: r.detectedAt ?? null,
    },
  };
}
