const DEFAULT_TIMEOUT = Number(process.env.SOURCE_TIMEOUT_MS) || 12_000;

export class SourceError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { accept: "application/json", "user-agent": "HoodTier/0.1 (+token research)", ...(rest.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = text.includes("Just a moment") ? "blocked by Cloudflare challenge" : text.slice(0, 160);
    throw new SourceError(`HTTP ${res.status}: ${hint}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceError(`Non-JSON response: ${text.slice(0, 120)}`);
  }
}

let rpcId = 0;

/**
 * Calls a tool on a stateless Streamable-HTTP MCP server (HoodScan, ScanHood) and
 * returns its structured result. Handles both JSON and SSE response framing.
 */
export async function mcpCall<T = unknown>(
  endpoint: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT,
  bearer?: string,
): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new SourceError(`HTTP ${res.status}: ${text.slice(0, 160)}`, res.status);
  const body = text.trimStart().startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5))
        .join("");
  const msg = JSON.parse(body) as {
    result?: { structuredContent?: T; content?: { type: string; text: string }[]; isError?: boolean };
    error?: { message: string };
  };
  if (msg.error) throw new SourceError(`MCP error: ${msg.error.message}`);
  const result = msg.result;
  const textOut = result?.content?.map((c) => c.text).join("\n") ?? "";
  if (result?.isError) throw new SourceError(textOut.slice(0, 200) || "MCP tool error");
  if (result?.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(textOut) as T;
  } catch {
    throw new SourceError(`MCP tool returned non-JSON: ${textOut.slice(0, 120)}`);
  }
}

export async function evmCall(rpc: string, to: string, data: string, timeoutMs = 8000): Promise<string | null> {
  const r = await fetchJson<{ result?: string; error?: unknown }>(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    timeoutMs,
  });
  return r.error ? null : (r.result ?? null);
}

export async function evmRpc<T = string>(rpc: string, method: string, params: unknown[], timeoutMs = 8000): Promise<T | null> {
  const r = await fetchJson<{ result?: T; error?: unknown }>(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    timeoutMs,
  });
  return r.error ? null : (r.result ?? null);
}

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
