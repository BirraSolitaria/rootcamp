import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/screens/auth/nav';

describe('safeNext', () => {
  it.each([
    ['/\t/evil', 'a tab the browser strips into //evil'],
    ['/\n/evil', 'a newline'],
    ['/\r/evil', 'a carriage return'],
    ['/\x00/evil', 'a NUL'],
    ['/\x7f/evil', 'a DEL'],
    ['/\\evil', 'a backslash right after the slash'],
    ['/a\\b', 'a backslash anywhere'],
    ['//evil', 'a protocol-relative URL'],
    ['https://evil', 'an absolute URL'],
    ['javascript:alert(1)', 'a javascript: URL'],
    ['evil', 'a relative path'],
    ['', 'an empty value'],
    [null, 'no value'],
  ] as const)('rejects %j (%s)', (next, why) => {
    expect(safeNext(next), why).toBe('/');
  });

  it.each(['/path?x=1', '/profile', '/lessons/1#top'])('keeps the same-origin path %j', (next) => {
    expect(safeNext(next)).toBe(next);
  });

  it('never returns to an auth screen', () => {
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext('/reset')).toBe('/');
  });
});
