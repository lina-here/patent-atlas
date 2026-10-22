import { expect, type Frame, type Page } from "@playwright/test";

// Wide fallback fonts: a visitor without the theme fonts (Linux, Windows) may get wider text than macOS, so text wraps to
// more lines. Fit tests rerun with every font forced to Verdana (macOS, Windows), else DejaVu Sans (Linux CI's fallback).
// Verdana measured as wide as DejaVu Sans on the site's longest lines (measured 2026-10-22).
// Theme font tokens are forced too: charts measure label widths with --font-data (charts.ts textWidth).

export const WIDE_FONT_STACK = 'Verdana, "DejaVu Sans", sans-serif';
const FONT_TOKENS = ["--font-display", "--font-body", "--font-ui", "--font-data"];
const WIDE_FONT_CSS = `:root{${FONT_TOKENS.map((token) => `${token}:${WIDE_FONT_STACK} !important`).join(";")}}` +
  `*{font-family:${WIDE_FONT_STACK} !important}`;

/** Appends the override to base.css for this page and its frames (an embed in an iframe); call before the first goto. */
export async function useWideFonts(page: Page): Promise<void> {
  await page.route("**/css/base.css", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n${WIDE_FONT_CSS}\n` });
  });
}

/** The override is in force (base.css renamed or not loaded would silently test the theme fonts). */
export async function expectWideFonts(target: Page | Frame): Promise<void> {
  expect(await target.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^Verdana/);
}

/** Fit tests run once with the theme fonts, once with wide fallback fonts. */
export const FONT_VARIANTS = [
  { wide: false, suffix: "" },
  { wide: true, suffix: " (wide fallback fonts)" },
];
