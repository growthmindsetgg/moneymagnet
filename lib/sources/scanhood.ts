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
  const loss = num(r.roundTripLossPct);
  // ScanHood sometimes says sellable=false while its own round trip completed with a small loss and no honeypot
  // flag. That reading contradicts itself: it is not counted either way (null, with the reason).
  const contradicts = r.sellable === false && !honeypotFlag && loss != null && loss < 50;
  const honeypot = contradicts ? null : honeypotFlag || r.sellable === false ? true : r.sellable === true ? false : null;

  let lpLockedPct: number | null = null;
  let lpNote: string | null = null;
  const status = r.lp?.status?.toLowerCase();
  if (status && status !== "unknown") {
    lpLockedPct = num(r.lp?.lockedPct) ?? num(r.lp?.burnedPct);
    // A bare safe=true/false is a verdict, not a locked share: it is never turned into 100% / 0%.
    if (lpLockedPct == null && typeof r.lp?.safe === "boolean") {
      lpNote = `ScanHood says LP ${r.lp.safe ? "safe" : "not safe"} (status ${status}${r.lp.detail ? `: ${r.lp.detail.slice(0, 80)}` : ""}) without a locked share — not a percentage`;
    }
  }

  const signals: FakeSignal[] = flags
    .filter((f) => f.level === "danger" || f.level === "warn")
    .map((f) => ({ kind: "other" as const, level: f.level === "danger" ? ("danger" as const) : ("warn" as const), text: f.msg, source: "ScanHood" }));
  if (lpNote && r.lp?.safe === false) signals.push({ kind: "other", level: "warn", text: lpNote, source: "ScanHood" });
  const nullReasons: Record<string, string> = {};
  if (lpNote) nullReasons.lpLockedPct = lpNote;
  if (contradicts) {
    nullReasons.sellable = `ScanHood contradicts itself: sellable=false with a completed ${loss}% round trip and no honeypot flag — not counted`;
    nullReasons.honeypot = "ScanHood reading self-contradictory (see sellable)";
  }

  const deployer = typeof r.deployer === "string" ? r.deployer : (r.deployer?.address ?? null);
  return {
    status: {
      id: "scanhood",
      label: "ScanHood",
      state: honeypot === null ? "partial" : "ok",
      message: `verdict ${r.verdict ?? "?"}${r.roundTripLossPct != null ? `, round-trip ${r.roundTripLossPct}%` : ""}${contradicts ? " · says not sellable while its round trip completed — reading not counted" : ""}`,
      ms: Date.now() - t0,
      url: "https://scanhood.xyz/scanner",
    },
    data: {
      honeypot,
      // A danger-level honeypot flag (e.g. prohibitive sell tax) overrides a technically successful sell.
      sellable: contradicts ? null : honeypot === true ? false : (r.sellable ?? null),
      ...(Object.keys(nullReasons).length ? { nullReasons } : {}),
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
