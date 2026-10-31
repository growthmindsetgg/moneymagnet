import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// MoneyMagnet design pass: every page at 360 / 768 / 1440, light + dark — screenshots to docs/screens/,
// no horizontal scroll, an axe scan with zero violations, and the result page usable at 360px.
const PAGES = [
  { name: "home", path: "/", ready: (p: Page) => expect(p.getByTestId("headline")).toBeVisible() },
  { name: "microduck", path: "/t/robinhood/0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725", ready: (p: Page) => expect(p.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 }) },
  { name: "peek", path: "/t/solana/A7Hm1SaHZZz8ZKFqZpsnZoGhri9f1iHEzYBPQGiPpump", ready: (p: Page) => expect(p.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 }) },
  { name: "nvda-rejected", path: "/t/robinhood/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", ready: (p: Page) => expect(p.getByTestId("rejected")).toBeVisible({ timeout: 90_000 }) },
];
const WIDTHS = [360, 768, 1440];
const THEMES = ["light", "dark"] as const;

test.describe.configure({ mode: "serial" });
// A cold analysis can take a minute; the three widths then hit the 2-minute result cache.
test.setTimeout(300_000);

for (const pg of PAGES) {
  for (const theme of THEMES) {
    test(`${pg.name} · ${theme}: screens at 360/768/1440, no overflow, axe clean`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
        await page.goto(pg.path);
        await pg.ready(page);
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${pg.name} ${theme} ${width}px scrolls sideways`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `docs/screens/${pg.name}-${width}-${theme}.png`, fullPage: true });
      }
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const summary = axe.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      expect(summary, `axe violations on ${pg.name} (${theme})`).toEqual([]);
    });
  }
}

test("result page at 360px: sticky bar shows tier · score · why, and the 'why' link lands on the box", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/t/robinhood/0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725");
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const bar = page.getByTestId("sticky-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(await page.getByTestId("tier-letter").innerText());
  await bar.click();
  await expect(page.getByTestId("short-reasons")).toBeInViewport();
  // The bar never hides the last line of content.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const barTop = await bar.evaluate((el) => el.getBoundingClientRect().top);
  const lastBottom = await page.locator("footer").evaluate((el) => el.getBoundingClientRect().bottom);
  expect(lastBottom).toBeLessThanOrEqual(barTop + 1);
  // Factor rows expand to show the full evidence.
  const row = page.getByTestId("factor-row").first();
  await row.locator("summary").click();
  await expect(row.locator("details")).toHaveAttribute("open", "");
});

test("theme toggle flips every token and survives a reload; the tier letter's space is reserved (no layout shift)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bg()).toBe("rgb(244, 244, 242)");
  await page.getByTestId("theme-toggle").click();
  expect(await bg()).toBe("rgb(11, 11, 11)");
  await page.reload();
  expect(await bg()).toBe("rgb(11, 11, 11)");
  await page.getByTestId("theme-toggle").click();
  expect(await bg()).toBe("rgb(244, 244, 242)");

  await page.goto("/t/robinhood/0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725");
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const cls = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) total += e.value;
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => resolve(total), 1500);
      }),
  );
  expect(cls).toBeLessThan(0.1);
});
