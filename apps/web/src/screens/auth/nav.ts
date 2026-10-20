/** Control characters (browsers strip tab/CR/LF from URLs: `/\t/evil` → `//evil`) and `\`. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\x00-\x1f\x7f\\]/;

/**
 * `?next=` target after sign-in: same-origin paths only (a single leading `/`, no control
 * characters or backslashes, resolving to this origin), never back to an auth screen.
 */
export function safeNext(next: string | null): string {
  if (!next || UNSAFE_CHARS.test(next)) return '/';
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  try {
    if (new URL(next, window.location.origin).origin !== window.location.origin) return '/';
  } catch {
    return '/';
  }
  if (/^\/(login|register|forgot|reset|verify)(\/|\?|$)/.test(next)) return '/';
  return next;
}
