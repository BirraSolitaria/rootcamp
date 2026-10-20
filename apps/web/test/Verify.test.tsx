import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../src/api/client';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { Verify } from '../src/screens/auth/Verify';
import { jsonResponse, meDto, mockFetch, renderAt, user } from './utils';

const route = '/verify?token=tok-1';

describe('Verify', () => {
  it('confirms the email with the token from the link', async () => {
    const fetch = mockFetch(() => jsonResponse(200, { user: { ...user, emailVerified: true } }));
    renderAt(<Verify />, { path: '/verify', route });
    expect(await screen.findByText('Почта подтверждена')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/auth/verify');
    expect(JSON.parse(String(init?.body))).toEqual({ token: 'tok-1' });
  });

  it('shows success for a reused link when /api/me says the email is verified', async () => {
    mockFetch((url) =>
      url === '/api/me'
        ? jsonResponse(200, meDto({ emailVerified: true }))
        : jsonResponse(409, { error: { code: 'token_used', message: 'used' } }),
    );
    renderAt(<Verify />, { path: '/verify', route });
    expect(await screen.findByText('Почта подтверждена')).toBeInTheDocument();
  });

  it('reports a reused link when the email is still unverified or nobody is signed in', async () => {
    mockFetch((url) =>
      url === '/api/me'
        ? jsonResponse(401, { error: { code: 'unauthorized', message: 'x' } })
        : jsonResponse(409, { error: { code: 'token_used', message: 'used' } }),
    );
    renderAt(<Verify />, { path: '/verify', route });
    expect(await screen.findByRole('alert')).toHaveTextContent('Ссылка уже использована');
    // No redirect to /login from this public screen.
    expect(screen.getByTestId('location')).toHaveTextContent(route);
  });

  it('explains an expired link', async () => {
    mockFetch(() => jsonResponse(410, { error: { code: 'token_expired', message: 'old' } }));
    renderAt(<Verify />, { path: '/verify', route });
    expect(await screen.findByText('Ссылка устарела')).toBeInTheDocument();
  });

  it('rejects a link without a token without calling the api', () => {
    const fetch = mockFetch(() => jsonResponse(500));
    renderAt(<Verify />, { path: '/verify', route: '/verify' });
    expect(screen.getByRole('alert')).toHaveTextContent('Ссылка недействительна');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('ErrorBoundary', () => {
  it('shows «Что-то сломалось (код reqId)» with the sad mascot', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Boom(): never {
      throw new ApiClientError(500, 'internal', 'boom', { reqId: 'req-42' });
    }
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Что-то сломалось (код req-42)')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /грустит/ })).toHaveAttribute('data-state', 'sad');
  });
});
