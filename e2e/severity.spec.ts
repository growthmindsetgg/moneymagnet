import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// UI fix round 1, item 3: the four-state severity colours (components/severity.ts), checked as rendered.
const MICRODUCK = "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725";
const NEON = "rgb(57, 255, 20)";
const RED = "rgb(220, 38, 38)";
const ORANGE = "rgb(245, 158, 11)";
const GREY = "rgb(107, 107, 107)";

const bgOf = (page: Page, sel: string) => page.locator(sel).evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));

test("a fired gate ⇒ at least one red element, and the gate pill itself is red (PEEK fixture: dead launch)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/fixture/peek");
  await expect(page.getByTestId("tier-letter")).toHaveText("F");
  const failed = page.locator('[data-testid="gate-pill"][data-state="fail"]');
  expect(await failed.count()).toBeGreaterThan(0);
  for (const bg of await bgOf(page, '[data-testid="gate-pill"][data-state="fail"]')) expect(bg).toBe(RED);
  expect((await bgOf(page, '[data-severity="bad"]')).filter((bg) => bg === RED).length).toBeGreaterThanOrEqual(1);
  // F is a red block.
  expect(await page.getByTestId("tier-box").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(RED);
});

test("live PEEK: every fired gate is red", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/t/solana/A7Hm1SaHZZz8ZKFqZpsnZoGhri9f1iHEzYBPQGiPpump");
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const bgs = await bgOf(page, '[data-testid="gate-pill"][data-state="fail"]');
  test.skip(bgs.length === 0, "no gate fired on this run");
  for (const bg of bgs) expect(bg).toBe(RED);
});

test("microduck ⇒ at least three neon (GOOD) elements, and S/A tiers are a neon block", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const neon = (await bgOf(page, '[data-severity="good"]')).filter((bg) => bg === NEON);
  expect(neon.length).toBeGreaterThanOrEqual(3);
  const tier = await page.getByTestId("tier-letter").textContent();
  if (tier === "S" || tier === "A") expect(await page.getByTestId("tier-box").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(NEON);
});

// Replaced (round 3, rule 1): staleness no longer colours a factor. A stale row keeps its points colour and
// shows a small grey "stale Nm" chip; the HoodScan source itself still reads "stale" in orange.
test("stale run (HoodScan down) ⇒ stale rows keep their points colour and carry a grey stale chip", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/t/robinhood/${MICRODUCK}?fresh=warm`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  await page.goto(`/t/robinhood/${MICRODUCK}?simulate=hoodscan-down&fresh=1`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const stale = page.locator('[data-testid="factor-row"][data-status="stale"]');
  expect(await stale.count()).toBeGreaterThan(0);
  for (const row of await stale.all()) {
    const chip = row.getByTestId("stale-badge");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/^stale \d+[smhd]/);
    expect(await chip.evaluate((e) => getComputedStyle(e).borderTopColor)).toBe(GREY);
    // Colour = points/max band only (or grey when the row has no rating).
    const sev = await row.getAttribute("data-severity");
    const [pts, max] = ((await row.getByTestId("factor-points").textContent()) ?? "").split("/").map(Number);
    if (Number.isFinite(pts) && max > 0) {
      const expected = pts <= 0 ? "bad" : pts / max >= 0.8 ? "good" : pts / max >= 0.4 ? "ok" : "warn";
      expect(["bad", expected]).toContain(sev);
    }
  }
  expect(await page.locator('[data-testid="source-row"][data-source="hoodscan"] [data-severity="warn"]').evaluate((e) => getComputedStyle(e).borderTopColor)).toBe(ORANGE);
});

// Replaced (round 3, "fewer words"): the legend is behind a "?" next to "Why this tier", not inline text.
test("'Why this tier' has a '?' colour key and at most five distinct reasons", async ({ page }) => {
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const legend = page.getByTestId("severity-legend");
  await expect(legend).toBeHidden();
  await page.getByTestId("legend-toggle").locator("summary").click();
  await expect(legend).toBeVisible();
  for (const s of ["good", "ok", "warn", "bad", "muted"]) await expect(legend.locator(`[data-severity="${s}"]`)).toHaveCount(1);
  // The key sits next to the heading, inside the box.
  const box = page.getByTestId("short-reasons");
  expect(await box.locator('[data-testid="severity-legend"]').count()).toBe(1);
  const reasons = (await page.getByTestId("reason").allTextContents()).map((t) => t.toLowerCase().replace(/[^a-z0-9%$]+/g, " ").trim());
  expect(reasons.length).toBeGreaterThan(0);
  expect(reasons.length).toBeLessThanOrEqual(5);
  expect(new Set(reasons).size).toBe(reasons.length);
  for (const r of reasons) for (const o of reasons) if (r !== o) expect(o.includes(r), `"${r}" repeats inside "${o}"`).toBe(false);
});

test("score drift: a fresh re-run lists only moved factors as 'label from → to'", async ({ page }) => {
  await page.goto(`/t/robinhood/${MICRODUCK}?fresh=a`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  await page.goto(`/t/robinhood/${MICRODUCK}?fresh=b`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const drift = page.getByTestId("drift");
  // Whether anything moved between two live runs is up to the market; when it did, the format holds.
  if (await drift.count()) {
    await expect(drift).toContainText("changed since last run:");
    for (const item of await page.getByTestId("drift-item").allTextContents()) expect(item).toMatch(/\S .* → \S/);
  }
  // A cached view never claims drift.
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("generated-at")).toContainText("cached");
  await expect(page.getByTestId("drift")).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`axe AA on every severity state (PEEK + microduck fixtures, rows expanded) · ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const fx of ["peek", "microduck", "pangea-honeypot"]) {
      await page.goto(`/fixture/${fx}`);
      await expect(page.getByTestId("tier-letter")).toBeVisible();
      // Research view + every <details> open, so rows, evidence, the key and every cross-checked metric are scanned.
      await page.evaluate(() => (document.documentElement.dataset.view = "research"));
      await page.locator("details").evaluateAll((els) => els.forEach((d) => d.setAttribute("open", "")));
      const states = await page.evaluate(() => [...new Set([...document.querySelectorAll("[data-severity]")].map((e) => e.getAttribute("data-severity")))]);
      expect(states.length).toBeGreaterThanOrEqual(3);
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const summary = axe.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      expect(summary, `axe violations on ${fx} (${theme})`).toEqual([]);
    }
  });
}
