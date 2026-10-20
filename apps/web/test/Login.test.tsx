import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Login } from '../src/screens/auth/Login';
import { jsonResponse, mockFetch, renderAt, user } from './utils';

async function submit(email = 'neo@example.com', password = 'correct-horse') {
  const ev = userEvent.setup();
  await ev.type(screen.getByLabelText('Email'), email);
  await ev.type(screen.getByLabelText('Пароль'), password);
  await ev.click(screen.getByRole('button', { name: 'Войти' }));
}

describe('Login', () => {
  it('shows «Слишком много попыток» on 429', async () => {
    mockFetch(() =>
      jsonResponse(429, { error: { code: 'rate_limited', message: 'x' } }, { 'retry-after': '60' }),
    );
    renderAt(<Login />, { path: '/login' });
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Слишком много попыток');
  });

  it('shows a wrong-credentials error on 401', async () => {
    mockFetch(() => jsonResponse(401, { error: { code: 'invalid_credentials', message: 'x' } }));
    renderAt(<Login />, { path: '/login' });
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный email или пароль');
  });

  it('sends an unverified user to «Проверь почту»', async () => {
    mockFetch(() => jsonResponse(200, { user }));
    renderAt(<Login />, { path: '/login' });
    await submit();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/check-email'));
  });

  it('returns a verified user to `next`', async () => {
    mockFetch(() => jsonResponse(200, { user: { ...user, emailVerified: true } }));
    renderAt(<Login />, { path: '/login', route: '/login?next=%2Fprofile' });
    await submit();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/profile$/));
  });

  it('ignores an off-site `next`', async () => {
    mockFetch(() => jsonResponse(200, { user: { ...user, emailVerified: true } }));
    renderAt(<Login />, { path: '/login', route: '/login?next=%2F%2Fevil.example' });
    await submit();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/));
  });
});
