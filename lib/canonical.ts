/**
 * Canonical domain. When HOODTIER_CANONICAL_HOST (e.g. moneymagnet.vercel.app) is set AND that host
 * actually serves the app, every path on the legacy host 308-redirects to it (path and query kept),
 * and <link rel="canonical"> / Open Graph URLs point at it. Until then all of this is a no-op.
 */
export const LEGACY_HOST = "hoodtier.vercel.app";

export interface CanonicalCheck {
  host: string | null;
  live: boolean;
  detail: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "headers">>;

/**
 * Live = a HEAD on the host's root answers 2xx. A redirect (e.g. Vercel's SSO wall on a protected alias),
 * an error or a timeout means not live, so the legacy host keeps serving instead of redirecting into a wall.
 */
export async function checkCanonical(host: string | undefined, fetchImpl: Fetch = fetch): Promise<CanonicalCheck> {
  const h = host?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
  if (!h) return { host: null, live: false, detail: "HOODTIER_CANONICAL_HOST not set — canonical redirect off" };
  if (h === LEGACY_HOST) return { host: h, live: false, detail: `canonical host is the legacy host (${h}) — nothing to redirect` };
  try {
    const res = await fetchImpl(`https://${h}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(8_000) });
    const loc = res.headers.get("location");
    const live = res.status >= 200 && res.status < 300;
    return { host: h, live, detail: `HEAD https://${h}/ → ${res.status}${loc ? ` (location ${loc.slice(0, 80)})` : ""} — canonical redirect ${live ? "ON" : "off"}` };
  } catch (err) {
    return { host: h, live: false, detail: `HEAD https://${h}/ failed (${err instanceof Error ? err.message : String(err)}) — canonical redirect off` };
  }
}

/** next.config redirects: legacy host → canonical host, every path, 308, query preserved by Next. */
export function canonicalRedirects(check: CanonicalCheck) {
  if (!check.live || !check.host) return [];
  return [{ source: "/:path*", has: [{ type: "host" as const, value: LEGACY_HOST }], destination: `https://${check.host}/:path*`, permanent: true }];
}

/** The origin used for <link rel="canonical"> and Open Graph URLs. */
export const canonicalOrigin = (check: CanonicalCheck) => `https://${check.live && check.host ? check.host : LEGACY_HOST}`;
