import { expect, test } from "@playwright/test";

// Item 7: canonical domain. Locally (HOODTIER_CANONICAL_HOST unset) the canonical / OG URLs use the serving
// host and nothing redirects. Against production every hoodtier.vercel.app path 308s to
// moneymagnet.vercel.app with path and query kept, and the canonical host loads without a loop.
const MICRODUCK = "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725";
const LEGACY = "https://hoodtier.vercel.app";
const CANONICAL = "https://moneymagnet.vercel.app";

test("result page declares <link rel=canonical> and og:url for its own path", async ({ page }) => {
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
  expect(canonical).toMatch(new RegExp(`^https://(hoodtier|moneymagnet)\\.vercel\\.app/t/robinhood/${MICRODUCK}$`));
  expect(await page.locator('meta[property="og:url"]').getAttribute("content")).toBe(canonical);
});

test("production: hoodtier.vercel.app/t/… 308 → moneymagnet.vercel.app/t/… (path + query kept); no loop on the canonical host", async ({ request }) => {
  // Un-skipped: Deployment Protection is off, so the canonical host must answer 200 itself (no 302 to the Vercel login).
  const head = await request.fetch(`${CANONICAL}/`, { method: "HEAD", maxRedirects: 0, timeout: 20_000, failOnStatusCode: false });
  expect(head.status(), `HEAD ${CANONICAL}/ → ${head.headers()["location"] ?? ""}`).toBe(200);
  expect(head.headers()["location"]).toBeUndefined();

  const res = await request.fetch(`${LEGACY}/t/robinhood/${MICRODUCK}?ref=e2e`, { maxRedirects: 0, failOnStatusCode: false, timeout: 30_000 });
  expect(res.status()).toBe(308);
  expect(res.headers()["location"]).toBe(`${CANONICAL}/t/robinhood/${MICRODUCK}?ref=e2e`);

  const direct = await request.fetch(`${CANONICAL}/t/robinhood/${MICRODUCK}`, { maxRedirects: 0, failOnStatusCode: false, timeout: 90_000 });
  expect(direct.status()).toBe(200);
  expect(await direct.text()).toContain(`<link rel="canonical" href="${CANONICAL}/t/robinhood/${MICRODUCK}"`);
});
