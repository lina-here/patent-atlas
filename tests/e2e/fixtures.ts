import { test as base, expect } from "@playwright/test";

// Every spec imports `test` from here (pipeline/tests/test_site_security.py checks): the pages' meta CSP (site/*.html,
// README "Security") must block nothing the site does. Any CSP violation in any page or frame of a test's context fails
// the test: the `securitypolicyviolation` event (forwarded by an init script) and Chromium's console CSP errors.

/** Chromium's console text for a blocked load or a Trusted Types refusal. */
const CSP_CONSOLE_ERROR = /Content Security Policy|Trusted ?Type/i;
const REPORT_BINDING = "__reportCspViolation";

/** `violations` seen so far; `allow(pattern)`: a test that provokes a violation on purpose exempts it from the final check. */
export type CspWatch = { violations: string[]; allow(pattern: RegExp): void };

export const test = base.extend<{ csp: CspWatch }>({
  csp: [async ({ context }, use) => {
    const violations: string[] = [];
    const allowed: RegExp[] = [];
    await context.exposeBinding(REPORT_BINDING, (_source, text: string) => { violations.push(text); });
    await context.addInitScript((binding) => {
      document.addEventListener("securitypolicyviolation", (event) => {
        const report = (window as unknown as Record<string, (text: string) => void>)[binding];
        report(`${event.effectiveDirective} blocked ${event.blockedURI || "inline"} (${event.sourceFile}:${event.lineNumber})`);
      });
    }, REPORT_BINDING);
    context.on("console", (message) => {
      if (message.type() === "error" && CSP_CONSOLE_ERROR.test(message.text())) violations.push(message.text());
    });
    await use({ violations, allow: (pattern) => { allowed.push(pattern); } });
    expect(violations.filter((text) => !allowed.some((pattern) => pattern.test(text))), "CSP violations").toEqual([]);
  }, { auto: true }],
});

export { expect };
export type { Frame, Locator, Page } from "@playwright/test";
