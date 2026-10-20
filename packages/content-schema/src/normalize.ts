/** §6.4: trim, collapse whitespace runs to one space, lowercase. */
export function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** §9.4 R13: drop the characters .,!?:;«»"', then normalize (re-collapses spaces left by removed punctuation). */
export function normalizeKey(s: string): string {
  return normalize(s.replace(/[.,!?:;«»"']/g, ''));
}
