import { ERROR_ID_RE } from "@/lib/errorId";

export const runtime = "nodejs";

/**
 * Failures the browser saw (timeouts, blocked or cut-off calls) and the server never did: one log line
 * per error id, so the id the user reads matches a line in the logs. Nothing is stored.
 */
export async function POST(req: Request) {
  let body: { id?: unknown; cause?: unknown; status?: unknown; path?: unknown } = {};
  try {
    body = JSON.parse((await req.text()).slice(0, 4_000));
  } catch {
    return new Response(null, { status: 400 });
  }
  const id = typeof body.id === "string" && ERROR_ID_RE.test(body.id) ? body.id : null;
  if (!id) return new Response(null, { status: 400 });
  const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").slice(0, n) : "");
  console.error(`[${id}] client: ${clip(body.cause, 200)}${typeof body.status === "number" ? ` (HTTP ${body.status})` : ""} at ${clip(body.path, 200)}`);
  return new Response(null, { status: 204 });
}
