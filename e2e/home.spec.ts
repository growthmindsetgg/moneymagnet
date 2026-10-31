import { expect, test, type Page } from "@playwright/test";

// UI fix round 1, item 2: from 1200px the headline spans ~75% of the container on two lines; the tags sit
// directly under the description box; the input and ANALYZE are above the fold at 1440×900 and 375×812.
async function layout(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("headline")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const h1 = document.querySelector('[data-testid="headline"]')!;
    const main = document.querySelector("main")!;
    const cs = getComputedStyle(main);
    const inner = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const range = document.createRange();
    // Each child span is one line from 1200px (two below): its range box spans the whole line.
    const widths = [...h1.children].map((s) => {
      range.selectNodeContents(s);
      return range.getBoundingClientRect().width;
    });
    // Visual lines: text fragments whose tops lie within half a font size of each other share a line.
    range.selectNodeContents(h1);
    const half = parseFloat(getComputedStyle(h1).fontSize) / 2;
    const tops = [...range.getClientRects()].filter((r) => r.width > 4).map((r) => r.top).sort((a, b) => a - b);
    const lineTops = tops.filter((t, i) => i === 0 || t - tops[i - 1] > half);
    const box = document.querySelector('[data-testid="explainer"]')!.getBoundingClientRect();
    const tags = document.querySelector('[data-testid="home-tags"]')!.getBoundingClientRect();
    const input = document.querySelector("#address")!.getBoundingClientRect();
    const button = [...document.querySelectorAll("button")].find((b) => /analyze/i.test(b.textContent ?? ""))!.getBoundingClientRect();
    return { ratio: Math.max(...widths) / inner, lines: lineTops.length, gapUnderBox: tags.top - box.bottom, tagsLeft: tags.left - box.left, foldBottom: Math.max(input.bottom, button.bottom), vh: innerHeight };
  });
}

test("1440×900: two-line headline at ~75% of the container; tags under the box; input + ANALYZE above the fold", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const m = await layout(page);
  expect(m.ratio).toBeGreaterThanOrEqual(0.7);
  expect(m.ratio).toBeLessThanOrEqual(0.8);
  expect(m.lines).toBe(2);
  expect(m.gapUnderBox).toBeGreaterThanOrEqual(0);
  expect(m.gapUnderBox).toBeLessThanOrEqual(24);
  expect(Math.abs(m.tagsLeft)).toBeLessThanOrEqual(1);
  expect(m.foldBottom).toBeLessThanOrEqual(m.vh);
});

test("1200px: the two-line headline still spans ~75%", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const m = await layout(page);
  expect(m.ratio).toBeGreaterThanOrEqual(0.7);
  expect(m.ratio).toBeLessThanOrEqual(0.8);
  expect(m.lines).toBe(2);
});

test("375×812: input + ANALYZE above the fold, tags directly under the box, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const m = await layout(page);
  expect(m.foldBottom).toBeLessThanOrEqual(m.vh);
  expect(m.gapUnderBox).toBeGreaterThanOrEqual(0);
  expect(m.gapUnderBox).toBeLessThanOrEqual(24);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("home has no layout shift on load", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
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
