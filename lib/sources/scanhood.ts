import type { AdapterResult, FakeSignal } from "../types";
import { mcpCall, num } from "./http";

const MCP = "https://scanhood.xyz/mcp";

interface ScanResult {
  verdict?: "PASS" | "CAUTION" | "DANGER";
  sellable?: boolean | null;
  roundTripLossPct?: number | null;
  verified?: boolean | null;
  deployer?: { address?: string } | string | null;
  lp?: { status?: string; safe?: boolean | null; lockedPct?: number | null; burnedPct?: number | null; detail?: string };
  flags?: { level: string; msg: string }[];
}

/**
 * Honeypot simulation only. LP-lock and verification fields are used solely when
 * ScanHood actually determined them — "unknown"/null means "not checkable", not a flag.
 */
export async function scanhood(address: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const a = address.toLowerCase();
  const r = await mcpCall<ScanResult>(MCP, "scan_token", { token: a }, 45_000);
  const flags = r.flags ?? [];
  const honeypotFlag = flags.some((f) => f.level === "danger" && /honeypot/i.test(f.msg));
  const honeypot = honeypotFlag || r.sellable === false ? true : r.sellable === true ? false : null;

  let lpLockedPct: number | null = null;
  const status = r.lp?.status?.toLowerCase();
  if (status && status !== "unknown") {
    lpLockedPct = num(r.lp?.lockedPct) ?? num(r.lp?.burnedPct) ?? (r.lp?.safe === true ? 100 : r.lp?.safe === false ? 0 : null);
  }

  const signals: FakeSignal[] = flags
    .filter((f) => f.level === "danger" || f.level === "warn")
    .map((f) => ({ kind: "other" as const, level: f.level === "danger" ? ("danger" as const) : ("warn" as const), text: f.msg, source: "ScanHood" }));

  const deployer = typeof r.deployer === "string" ? r.deployer : (r.deployer?.address ?? null);
  return {
    status: {
      id: "scanhood",
      label: "ScanHood",
      state: honeypot === null ? "partial" : "ok",
      message: `verdict ${r.verdict ?? "?"}${r.roundTripLossPct != null ? `, round-trip ${r.roundTripLossPct}%` : ""}`,
      ms: Date.now() - t0,
      url: "https://scanhood.xyz/scanner",
    },
    data: {
      honeypot,
      // A danger-level honeypot flag (e.g. prohibitive sell tax) overrides a technically successful sell.
      sellable: honeypot === true ? false : (r.sellable ?? null),
      roundTripLossPct: num(r.roundTripLossPct),
      verified: typeof r.verified === "boolean" ? r.verified : null,
      lpLockedPct,
      deployerAddress: deployer,
      fakeSignals: signals,
      links: [{ label: "ScanHood", url: "https://scanhood.xyz/scanner" }],
    },
    raw: r,
  };
}
