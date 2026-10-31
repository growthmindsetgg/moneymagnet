import { describe, expect, it } from "vitest";
import { canonicalOrigin, canonicalRedirects, checkCanonical, LEGACY_HOST } from "@/lib/canonical";

const answer = (status: number, location?: string) => async () => ({ status, headers: new Headers(location ? { location } : {}) });

describe("canonical host: redirect only once the new domain really serves the app", () => {
  it("is a no-op without HOODTIER_CANONICAL_HOST", async () => {
    const c = await checkCanonical(undefined, answer(200));
    expect(c.live).toBe(false);
    expect(canonicalRedirects(c)).toEqual([]);
    expect(canonicalOrigin(c)).toBe(`https://${LEGACY_HOST}`);
  });

  it("stays off while the host answers with Vercel's SSO redirect (today's moneymagnet.vercel.app)", async () => {
    const c = await checkCanonical("moneymagnet.vercel.app", answer(302, "https://vercel.com/sso-api?url=https%3A%2F%2Fmoneymagnet.vercel.app%2F"));
    expect(c.live).toBe(false);
    expect(c.detail).toContain("302");
    expect(canonicalRedirects(c)).toEqual([]);
  });

  it("stays off when the HEAD request fails", async () => {
    const c = await checkCanonical("moneymagnet.vercel.app", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(c.live).toBe(false);
    expect(c.detail).toContain("ENOTFOUND");
  });

  it("when live: 308 for every path on the legacy host only, path kept (no loop on the canonical host)", async () => {
    const c = await checkCanonical(" https://MoneyMagnet.vercel.app/ ", answer(200));
    expect(c).toMatchObject({ host: "moneymagnet.vercel.app", live: true });
    expect(canonicalRedirects(c)).toEqual([
      { source: "/:path*", has: [{ type: "host", value: LEGACY_HOST }], destination: "https://moneymagnet.vercel.app/:path*", permanent: true },
    ]);
    expect(canonicalOrigin(c)).toBe("https://moneymagnet.vercel.app");
  });

  it("never redirects the legacy host to itself", async () => {
    const c = await checkCanonical(LEGACY_HOST, answer(200));
    expect(canonicalRedirects(c)).toEqual([]);
  });
});
