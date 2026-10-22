import type { Locator } from "@playwright/test";

/** Opens the card's "Sources, notes and how to reproduce" details (closed by default) so its lines can be asserted visible. */
export async function openNotes(card: Locator): Promise<void> {
  const details = card.locator("details.card-details");
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) await details.locator("> summary").click();
}
