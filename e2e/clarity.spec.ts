import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// UI round 3 — clarity, on Kolshi (live), default "Verdict" view.
const KOLSHI = "/t/robinhood/0x774b0e022477e83108530a975e9edf26cc4301bf";

async function open(page: Page) {
  await page.goto(KOLSHI);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
}

test.beforeEach(async ({ page }) => {
  // Every test starts from the default view (the toggle is remembered per browser).
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem("mm:test-init")) {
        localStorage.removeItem("mm:view");
        sessionStorage.setItem("mm:test-init", "1");
      }
    } catch {}
  });
});

test("Kolshi default view: Top-10 holder share is neon or ink (not red); Holder conviction bar is not red", async ({ page }) => {
  await open(page);
  const top10 = page.locator('[data-testid="factor-row"]').filter({ hasText: /Top-10 holder share/ }).first();
  await expect(top10).toBeVisible();
  expect(["good", "ok"]).toContain(await top10.getAttribute("data-severity"));
  const bar = page.locator('[data-group="holders"] [data-testid="score-bar"]');
  expect(await bar.getAttribute("data-severity")).not.toBe("bad");
});

test("Kolshi: exactly one Sellable pill; each check once", async ({ page }) => {
  await open(page);
  const pills = page.getByTestId("gate-pill");
  await expect(pills.filter({ hasText: /Sellable|Honeypot/ })).toHaveCount(1);
  const labels = (await pills.allTextContents()).map((t) => t.replace(/^[✓✗?–]\s*/, "").trim().toLowerCase());
  expect(new Set(labels).size).toBe(labels.length);
  // Passed neon, unknown orange "?", failed red.
  for (const pill of await pills.all()) {
    const state = await pill.getAttribute("data-state");
    const text = (await pill.textContent()) ?? "";
    if (state === "pass") expect(text.startsWith("✓")).toBe(true);
    if (state === "unknown") expect(text.startsWith("?")).toBe(true);
    if (state === "fail") expect(text.startsWith("✗")).toBe(true);
  }
});

test("Kolshi: 'Why this tier' has ≤ 5 lines, positives first, and no ✗ when the tier is A/S", async ({ page }) => {
  await open(page);
  const lines = page.getByTestId("reason");
  const n = await lines.count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(5);
  const kinds = await lines.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
  expect(kinds.filter((k) => k === "positive").length).toBeLessThanOrEqual(3);
  expect(kinds.filter((k) => k === "holdback").length).toBeLessThanOrEqual(2);
  expect(kinds.join(",")).toMatch(/^(positive,?)*(holdback,?)*$/);
  const tier = await page.getByTestId("tier-letter").textContent();
  const text = (await page.getByTestId("short-reasons").textContent()) ?? "";
  if (tier === "A" || tier === "S") {
    expect(text).not.toContain("✗");
    // A weak factor under an A is an orange ▲, never red — unless a gate / cap fired.
    const binding = await page.getByTestId("why-tier").getAttribute("data-kind");
    if (binding !== "gate" && binding !== "cap") expect(await page.locator('[data-testid="reason"][data-severity="bad"]').count()).toBe(0);
  }
  // No source names in the plain-words lines.
  for (const t of await lines.allTextContents()) expect(t).not.toMatch(/HoodScan|Helius|RugCheck|GeckoTerminal|DexScreener|source:|guide p\./);
  // Verification is one line under the box.
  await expect(page.getByTestId("verification-line")).toHaveText(/^\d+\/\d+ metrics cross-checked · \d+ differ \(see research view\)$/);
});

test("Kolshi: factor lines are compact; the research toggle reveals sources and timestamps, and is remembered", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("factor-row").first();
  // One line: dot · name · value · points (+ optional ≠ / stale); no LIVE label, no evidence until expanded.
  await expect(row.locator("summary")).not.toContainText("LIVE");
  await expect(row.getByTestId("row-detail")).toBeHidden();
  const summaryHeight = await row.locator("summary").evaluate((e) => e.getBoundingClientRect().height);
  expect(summaryHeight).toBeLessThan(48);
  await expect(page.getByTestId("factor-source").first()).toBeHidden();
  await expect(page.getByTestId("reading-time").first()).toBeHidden();
  await expect(page.locator('[data-group="verification"]')).toBeHidden();

  await page.getByTestId("research-toggle").click();
  await expect(page.getByTestId("research-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("factor-source").first()).toBeVisible();
  await expect(page.getByTestId("factor-source").first()).not.toContainText("MoneyMagnet ·");
  await expect(page.getByTestId("reading-time").first()).toBeVisible();
  await expect(page.getByTestId("reading-time").first()).toHaveText(/^\d\d:\d\d:\d\d UTC$/);
  await expect(page.locator('[data-group="verification"]')).toBeVisible();
  await expect(page.getByTestId("manual-checks")).toBeVisible();

  // Remembered across a reload.
  await page.reload();
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("research-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-group="verification"]')).toBeVisible();
  await page.getByTestId("research-toggle").click();
  await expect(page.locator('[data-group="verification"]')).toBeHidden();
});

test("Kolshi: the verdict under the hero is at most 14 words", async ({ page }) => {
  await open(page);
  const words = ((await page.getByTestId("verdict").textContent()) ?? "").trim().split(/\s+/);
  expect(words.length).toBeGreaterThan(0);
  expect(words.length).toBeLessThanOrEqual(14);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [360, 1440]) {
    test(`Kolshi axe clean · ${theme} · ${width}px (verdict and research views)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const scan = async (label: string) => {
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const summary = axe.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
        expect(summary, `axe on Kolshi ${label} ${theme} ${width}px`).toEqual([]);
      };
      await scan("verdict");
      await page.getByTestId("research-toggle").click();
      await scan("research");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
}
