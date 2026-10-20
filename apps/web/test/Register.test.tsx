import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Register } from '../src/screens/auth/Register';
import { jsonResponse, mockFetch, renderAt, user } from './utils';

async function fill(password: string) {
  const ev = userEvent.setup();
  await ev.type(screen.getByLabelText('Email'), 'neo@example.com');
  await ev.type(screen.getByLabelText('Ник'), 'neo');
  await ev.type(screen.getByLabelText('Пароль'), password);
  return ev;
}

describe('Register', () => {
  it('keeps the button disabled while the password is shorter than 10 characters', async () => {
    mockFetch(() => jsonResponse(500));
    renderAt(<Register />, { path: '/register' });
    const ev = await fill('123456789');
    const button = screen.getByRole('button', { name: 'Создать аккаунт' });
    expect(button).toBeDisabled();
    await ev.type(screen.getByLabelText('Пароль'), '0');
    expect(button).toBeEnabled();
  });

  it('sends the browser time zone and goes to «Проверь почту»', async () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...real.call(this), timeZone: 'Asia/Novosibirsk' };
    });
    const fetch = mockFetch(() => jsonResponse(201, { user }));
    renderAt(<Register />, { path: '/register' });
    const ev = await fill('correct-horse');
    await ev.click(screen.getByRole('button', { name: 'Создать аккаунт' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/check-email'));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/auth/register');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'neo@example.com',
      nick: 'neo',
      password: 'correct-horse',
      tz: 'Asia/Novosibirsk',
      website: '',
    });
  });

  it('shows the server error for a taken nick', async () => {
    mockFetch(() => jsonResponse(409, { error: { code: 'nick_taken', message: 'taken' } }));
    renderAt(<Register />, { path: '/register' });
    const ev = await fill('correct-horse');
    await ev.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Этот ник уже занят');
  });
});
