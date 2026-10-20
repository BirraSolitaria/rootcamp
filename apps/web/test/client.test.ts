import { MeDto } from '@rootcamp/api-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiFetch, setNavigator } from '../src/api/client';
import { jsonResponse, meDto, mockFetch } from './utils';

describe('apiFetch', () => {
  const navigate = vi.fn();
  beforeEach(() => {
    navigate.mockReset();
    setNavigator(navigate);
    window.history.replaceState(null, '', '/lesson/t7.s01.l01?step=2');
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('sends X-RC: 1 and same-origin credentials on mutating requests', async () => {
    const fetch = mockFetch(() => jsonResponse(204));
    await apiFetch('/api/auth/login', { method: 'POST' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/auth/login');
    expect(new Headers(init?.headers).get('X-RC')).toBe('1');
    expect(init?.credentials).toBe('same-origin');
  });

  it('serialises `json` as the body with a JSON content type', async () => {
    const fetch = mockFetch(() => jsonResponse(204));
    await apiFetch('/api/auth/forgot', { method: 'POST', json: { email: 'a@b.c' } });
    const init = fetch.mock.calls[0]![1]!;
    expect(init.body).toBe('{"email":"a@b.c"}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('does not add X-RC to GET', async () => {
    const fetch = mockFetch(() => jsonResponse(200, meDto()));
    await apiFetch('/api/me');
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).has('X-RC')).toBe(false);
    expect(fetch.mock.calls[0]![1]?.credentials).toBe('same-origin');
  });

  it('parses the body with the schema', async () => {
    mockFetch(() => jsonResponse(200, meDto({ nick: 'trinity' })));
    const me = await apiFetch('/api/me', undefined, MeDto);
    expect(me.user.nick).toBe('trinity');
  });

  it('on 401 navigates to /login?next=<current location> and throws', async () => {
    mockFetch(() =>
      jsonResponse(401, { error: { code: 'unauthorized', message: 'sign in required' } }),
    );
    const err = await apiFetch('/api/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(navigate).toHaveBeenCalledWith(
      '/login?next=' + encodeURIComponent('/lesson/t7.s01.l01?step=2'),
    );
  });

  it('does not redirect on 401 from /api/auth/* (wrong password is a form error)', async () => {
    mockFetch(() =>
      jsonResponse(401, { error: { code: 'invalid_credentials', message: 'wrong' } }),
    );
    const err = await apiFetch('/api/auth/login', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not redirect when the caller opts out', async () => {
    mockFetch(() => jsonResponse(401, { error: { code: 'unauthorized', message: 'x' } }));
    await apiFetch('/api/me', { redirectOn401: false }).catch(() => undefined);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('maps 429 to rate_limited with Retry-After seconds', async () => {
    mockFetch(() =>
      jsonResponse(
        429,
        { error: { code: 'rate_limited', message: 'slow down' } },
        { 'retry-after': '42' },
      ),
    );
    const err = await apiFetch('/api/auth/login', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 42 });
  });

  it('keeps the request id of a 500', async () => {
    mockFetch(() =>
      jsonResponse(
        500,
        { error: { code: 'internal', message: 'internal error (reqId req-7)' } },
        { 'x-request-id': 'req-7' },
      ),
    );
    const err = await apiFetch('/api/me').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, code: 'internal', reqId: 'req-7' });
  });

  it('treats a non-JSON error body as internal', async () => {
    mockFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const err = await apiFetch('/api/me').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'internal' });
  });
});
