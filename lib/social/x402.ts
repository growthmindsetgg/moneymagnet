import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

/**
 * Minimal x402 client (scheme "exact", USDC on Base): answers a 402 by signing an EIP-3009
 * transferWithAuthorization for the quoted amount and retrying with the payment header. The wallet
 * key is read from ROBINX_WALLET_KEY by the caller; nothing is paid above `maxAtomic` (the per-analysis cap).
 */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount?: string;
  maxAmountRequired?: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

const CHAIN_IDS: Record<string, number> = { "eip155:8453": 8453, base: 8453, "eip155:84532": 84532, "base-sepolia": 84532 };

const k = (b: Uint8Array) => keccak_256(b);
const pad32 = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const uint = (n: bigint | number | string) => pad32(BigInt(n).toString(16));
const typeHash = (s: string) => bytesToHex(k(utf8ToBytes(s)));

const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const TRANSFER_TYPE = "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

export function addressOf(privateKey: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKey.replace(/^0x/, "")), false);
  return "0x" + bytesToHex(k(pub.slice(1))).slice(-40);
}

export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** EIP-712 digest of a USDC transferWithAuthorization. */
export function authorizationDigest(a: Authorization, token: { name: string; version: string; chainId: number; address: string }): Uint8Array {
  const domain = k(hexToBytes(typeHash(DOMAIN_TYPE) + bytesToHex(k(utf8ToBytes(token.name))) + bytesToHex(k(utf8ToBytes(token.version))) + uint(token.chainId) + pad32(token.address)));
  const struct = k(hexToBytes(typeHash(TRANSFER_TYPE) + pad32(a.from) + pad32(a.to) + uint(a.value) + uint(a.validAfter) + uint(a.validBefore) + pad32(a.nonce)));
  return k(new Uint8Array([0x19, 0x01, ...domain, ...struct]));
}

export function signDigest(digest: Uint8Array, privateKey: string): string {
  const sig = secp256k1.sign(digest, hexToBytes(privateKey.replace(/^0x/, "")), { lowS: true });
  return "0x" + sig.r.toString(16).padStart(64, "0") + sig.s.toString(16).padStart(64, "0") + (27 + sig.recovery).toString(16);
}

export const quotedAtomic = (r: PaymentRequirement) => BigInt(r.amount ?? r.maxAmountRequired ?? "0");

/** Base64 payment header for one requirement (x402 v2 payload; v1 servers read the same fields). */
export function paymentHeader(req: PaymentRequirement, privateKey: string, resource: string, now = Date.now(), nonce?: string): string {
  const chainId = CHAIN_IDS[req.network];
  if (!chainId) throw new Error(`x402: unsupported network ${req.network}`);
  const from = addressOf(privateKey);
  const nowS = Math.floor(now / 1000);
  const auth: Authorization = {
    from,
    to: req.payTo,
    value: quotedAtomic(req).toString(),
    validAfter: String(nowS - 60),
    validBefore: String(nowS + (req.maxTimeoutSeconds ?? 60)),
    nonce: nonce ?? "0x" + bytesToHex(secp256k1.utils.randomPrivateKey()),
  };
  const signature = signDigest(authorizationDigest(auth, { name: req.extra?.name ?? "USD Coin", version: req.extra?.version ?? "2", chainId, address: req.asset }), privateKey);
  const payload = { x402Version: 2, scheme: req.scheme, network: req.network, resource: { url: resource }, accepted: req, payload: { signature, authorization: auth } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** The requirements a 402 carries (v2: base64 PAYMENT-REQUIRED header; v1: JSON body `accepts`). */
export function requirementsOf(res: Response, body: unknown): PaymentRequirement[] {
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      return (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: PaymentRequirement[] }).accepts ?? [];
    } catch {
      // fall through to the body
    }
  }
  return (body as { accepts?: PaymentRequirement[] } | null)?.accepts ?? [];
}

export class BudgetExceeded extends Error {}

/**
 * GET with x402: on 402, pays the cheapest exact-USDC-on-Base requirement when it fits within
 * `maxAtomic`, else throws BudgetExceeded (nothing is signed). Returns the response and what was paid.
 */
export async function fetchX402(url: string, opts: { privateKey: string; maxAtomic: bigint; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<{ res: Response; paidAtomic: bigint }> {
  const f = opts.fetchImpl ?? fetch;
  const first = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000), cache: "no-store" });
  if (first.status !== 402) return { res: first, paidAtomic: 0n };
  const body = await first.json().catch(() => null);
  const offers = requirementsOf(first, body).filter((r) => r.scheme === "exact" && CHAIN_IDS[r.network]);
  const req = offers.sort((a, b) => (quotedAtomic(a) < quotedAtomic(b) ? -1 : 1))[0];
  if (!req) throw new Error("x402: no payable requirement (exact USDC on Base)");
  const price = quotedAtomic(req);
  if (price > opts.maxAtomic) throw new BudgetExceeded(`x402: price ${Number(price) / 1e6} USDC exceeds the remaining cap ${Number(opts.maxAtomic) / 1e6}`);
  const header = paymentHeader(req, opts.privateKey, url);
  const res = await f(url, { headers: { "X-PAYMENT": header, "PAYMENT-SIGNATURE": header }, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000), cache: "no-store" });
  return { res, paidAtomic: res.ok ? price : 0n };
}
