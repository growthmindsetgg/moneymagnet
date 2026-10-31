import type { NextConfig } from "next";
import { canonicalOrigin, canonicalRedirects, checkCanonical } from "./lib/canonical";

export default async function config(): Promise<NextConfig> {
  // Checked once per build / server start and logged: the redirect stays off until the canonical host
  // really serves the app (see lib/canonical.ts).
  const canonical = await checkCanonical(process.env.HOODTIER_CANONICAL_HOST);
  console.log(`[canonical] ${canonical.detail}`);
  return {
    poweredByHeader: false,
    // Metadata (title, description) is rendered in <head> for every client, not streamed after the body.
    htmlLimitedBots: /.*/,
    // The whole stylesheet is ~7 KB: inline it in <head> instead of a render-blocking request (LCP on mobile).
    experimental: { inlineCss: true },
    env: { MM_CANONICAL_ORIGIN: canonicalOrigin(canonical) },
    async redirects() {
      return canonicalRedirects(canonical);
    },
  };
}
