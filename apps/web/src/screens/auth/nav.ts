/** `?next=` target after sign-in: same-site paths only, never back to an auth screen. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (/^\/(login|register|forgot|reset|verify)(\/|\?|$)/.test(next)) return '/';
  return next;
}
