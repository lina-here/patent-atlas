import { readFileSync } from "node:fs";

// Site timing constants the tests wait on, read from the site source text (no copy kept here): the module that holds
// one imports the whole page (charts, map, DOM helpers), so the tests read it rather than import it.

/** `const <name> = <integer>;` declaration (line start, optional `export`) in site/src/<file>: a comment line that
 * quotes it is not read. */
function sourceConstant(file: string, name: string): number {
  const match = new RegExp(`^(?:export )?const ${name} = (\\d+);`, "m").exec(readFileSync(`site/src/${file}`, "utf8"));
  if (!match) throw new Error(`no integer const ${name} in site/src/${file}`);
  return Number(match[1]);
}

/** Wait after the last resize before the cards redraw (overview.ts `redrawOnResize`). */
export const RESIZE_SETTLE_MS = sourceConstant("overview.ts", "RESIZE_SETTLE_MS");

/** Chart ids of the women-inventors page (womenPage.ts `WOMEN_CARD_IDS`), resolved from the string constants it lists. */
export const WOMEN_CARD_IDS: string[] = (() => {
  const source = readFileSync("site/src/womenPage.ts", "utf8");
  const list = /^export const WOMEN_CARD_IDS: string\[\] = \[([^\]]+)\];/m.exec(source)?.[1];
  if (!list) throw new Error("no WOMEN_CARD_IDS in site/src/womenPage.ts");
  return list.split(",").map((name) => {
    const value = new RegExp(`^export const ${name.trim()} = "([^"]+)";`, "m").exec(source)?.[1];
    if (!value) throw new Error(`no string const ${name.trim()} in site/src/womenPage.ts`);
    return value;
  });
})();

/** The wallboard's key table (wallboard.ts `WALLBOARD_KEYS`): KeyboardEvent.key, action, label, read from its entries. */
export const WALLBOARD_KEYS: { key: string; action: string; label: string }[] = (() => {
  const source = readFileSync("site/src/wallboard.ts", "utf8");
  const table = /^export const WALLBOARD_KEYS[^=]*= \[([\s\S]*?)\n\];/m.exec(source)?.[1];
  if (!table) throw new Error("no WALLBOARD_KEYS in site/src/wallboard.ts");
  const entries = [...table.matchAll(/\{ key: "([^"]+)", action: "([^"]+)", label: "([^"]+)" \}/g)]
    .map(([, key, action, label]) => ({ key, action, label }));
  if (entries.length === 0) throw new Error("WALLBOARD_KEYS has no entries");
  return entries;
})();

/** Minimum contrast of the board's text colours (wallboard.ts `BOARD_MIN_CONTRAST`). */
export const BOARD_MIN_CONTRAST = sourceConstant("wallboard.ts", "BOARD_MIN_CONTRAST");

/** The colours that minimum covers (wallboard.ts `BOARD_CONTRAST_COLOURS`): theme token and name. */
export const BOARD_CONTRAST_COLOURS: { token: string; name: string }[] = (() => {
  const source = readFileSync("site/src/wallboard.ts", "utf8");
  const list = /^export const BOARD_CONTRAST_COLOURS = \[([\s\S]*?)\n\];/m.exec(source)?.[1];
  if (!list) throw new Error("no BOARD_CONTRAST_COLOURS in site/src/wallboard.ts");
  const entries = [...list.matchAll(/\{ token: "([^"]+)", name: "([^"]+)" \}/g)].map(([, token, name]) => ({ token, name }));
  if (entries.length === 0) throw new Error("BOARD_CONTRAST_COLOURS has no entries");
  return entries;
})();

/** The board's defaults (wallboard.ts `FALLBACK`): used when config.json lacks or breaks a value, and before it loads. */
export const BOARD_FALLBACK: Record<"seconds" | "hideControlsSeconds" | "fetchTimeoutSeconds" | "safeAreaPercent", number> = (() => {
  const source = readFileSync("site/src/wallboard.ts", "utf8");
  const body = /^const FALLBACK = \{([^}]*)\};/m.exec(source)?.[1];
  if (!body) throw new Error("no FALLBACK in site/src/wallboard.ts");
  const values = Object.fromEntries([...body.matchAll(/(\w+): (\d+)/g)].map(([, key, value]) => [key, Number(value)]));
  for (const key of ["seconds", "hideControlsSeconds", "fetchTimeoutSeconds", "safeAreaPercent"]) {
    if (!(key in values)) throw new Error(`FALLBACK has no ${key}`);
  }
  return values as Record<"seconds" | "hideControlsSeconds" | "fetchTimeoutSeconds" | "safeAreaPercent", number>;
})();
