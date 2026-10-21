import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../src/api/client';
import { errorText, retryWait } from '../src/api/messages';

describe('retryWait', () => {
  it.each([
    [1, '1 с'],
    [45, '45 с'],
    [60, '60 с'],
    [61, '2 минуты'],
    [90, '2 минуты'],
    [120, '2 минуты'],
    [121, '3 минуты'],
    [300, '5 минут'],
    [1200, '20 минут'],
    [1201, '21 минуту'],
    [3531, '59 минут'],
    [3600, '60 минут'],
    [3601, '61 минуту'],
  ])('%i s → «%s»', (s, text) => expect(retryWait(s as number)).toBe(text));
});

describe('errorText for 429', () => {
  const limited = (retryAfter?: number) =>
    new ApiClientError(429, 'rate_limited', 'x', retryAfter ? { retryAfter } : {});

  it('names the wait in seconds up to a minute', () => {
    expect(errorText(limited(45))).toBe('Слишком много попыток. Попробуй через 45 с');
    expect(errorText(limited(60))).toBe('Слишком много попыток. Попробуй через 60 с');
  });

  it('names longer waits in whole minutes, rounded up', () => {
    expect(errorText(limited(61))).toBe('Слишком много попыток. Попробуй через 2 минуты');
    expect(errorText(limited(3531))).toBe('Слишком много попыток. Попробуй через 59 минут');
  });

  it('without Retry-After says «позже»', () => {
    expect(errorText(limited())).toBe('Слишком много попыток. Попробуй позже');
  });
});
