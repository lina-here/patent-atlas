// Contracting State names as a sentence reads them, written apart from site/src/map.ts (the tests' own copy).

const STATE_IN_PROSE: Record<string, string> = { Netherlands: "the Netherlands", "United Kingdom": "the United Kingdom", China: "China" };

/** The name with its article where English needs one; a State not listed here fails (a new `via` needs its entry). */
export function stateInProse(name: string): string {
  if (!(name in STATE_IN_PROSE)) throw new Error(`no prose name for ${name}`);
  return STATE_IN_PROSE[name];
}
