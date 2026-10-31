/** One plain-language line per failure kind (§2a). Pure, so it is unit-tested. */
export type FailureKind = "network" | "timeout" | "http" | "parse" | "partial" | "exception" | "rate-limit";

export function failureCause(kind: FailureKind, status: number | null = null, detail?: string | null): string {
  switch (kind) {
    case "network":
      return "Couldn't reach the data service — the request never got an answer.";
    case "timeout":
      return "The analysis took too long and the server gave up.";
    case "rate-limit":
      return `Too many analyses from this connection — wait${detail ? ` ${detail}s` : " a minute"} and retry.`;
    case "parse":
      return "The server's answer was cut off or unreadable.";
    case "partial":
      return `The server's answer was missing parts of the report${detail ? ` (${detail})` : ""}.`;
    case "http":
      if (status === 502 || status === 503) return "The server is temporarily unavailable.";
      if (status === 504 || status === 408) return "The analysis took too long and the server gave up.";
      return `The analysis failed on the server${status ? ` (HTTP ${status})` : ""}.`;
    default:
      return `Something unexpected broke${detail ? `: ${detail.slice(0, 120)}` : ""}.`;
  }
}

/** Classifies a fetch outcome. */
export function classifyStatus(status: number): FailureKind {
  if (status === 504 || status === 408) return "timeout";
  if (status === 429) return "rate-limit";
  return "http";
}
