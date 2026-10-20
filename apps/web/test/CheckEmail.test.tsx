import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CheckEmail } from '../src/screens/auth/CheckEmail';
import { jsonResponse, meDto, mockFetch, renderAt } from './utils';

const RESEND = /Отправить ещё раз/;

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('CheckEmail', () => {
  it('shows the address and the spam hint', () => {
    mockFetch(() => jsonResponse(204));
    renderAt(<CheckEmail />, { path: '/check-email', me: meDto() });
    expect(screen.getByText('neo@example.com')).toBeInTheDocument();
    expect(screen.getByText(/Спам/)).toBeInTheDocument();
  });

  it('keeps «Отправить ещё раз» disabled for 60 s', async () => {
    vi.useFakeTimers();
    mockFetch(() => jsonResponse(204));
    renderAt(<CheckEmail />, { path: '/check-email', me: meDto() });
    expect(screen.getByRole('button', { name: RESEND })).toBeDisabled();
    await tick(59_000);
    expect(screen.getByRole('button', { name: RESEND })).toBeDisabled();
    await tick(1_000);
    expect(screen.getByRole('button', { name: RESEND })).toBeEnabled();
  });

  it('after 3 resends suggests writing to the administrator', async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(() => jsonResponse(204));
    renderAt(<CheckEmail />, { path: '/check-email', me: meDto() });
    expect(screen.queryByText(/Напиши администратору/)).not.toBeInTheDocument();
    for (let i = 0; i < 3; i++) {
      await tick(60_000);
      fireEvent.click(screen.getByRole('button', { name: RESEND }));
      await tick(0);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]![0]).toBe('/api/auth/resend-verification');
    expect(screen.getByText(/Напиши администратору/)).toBeInTheDocument();
  });

  it('shows «Слишком много попыток» on 429 and waits Retry-After', async () => {
    vi.useFakeTimers();
    mockFetch(() =>
      jsonResponse(429, { error: { code: 'rate_limited', message: 'x' } }, { 'retry-after': '90' }),
    );
    renderAt(<CheckEmail />, { path: '/check-email', me: meDto() });
    await tick(60_000);
    fireEvent.click(screen.getByRole('button', { name: RESEND }));
    await tick(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Слишком много попыток');
    await tick(89_000);
    expect(screen.getByRole('button', { name: RESEND })).toBeDisabled();
    await tick(1_000);
    expect(screen.getByRole('button', { name: RESEND })).toBeEnabled();
  });

  it('changes the email with PATCH /api/me', async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(() => jsonResponse(200, { user: meDto().user }));
    renderAt(<CheckEmail />, { path: '/check-email', me: meDto() });
    fireEvent.change(screen.getByLabelText('Новый email'), {
      target: { value: 'neo2@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сменить email' }));
    await tick(0);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/me');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'neo2@example.com' });
  });
});
