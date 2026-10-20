import {
  type ForgotBody,
  type LoginBody,
  MeDto,
  type RegisterBody,
  type ResetBody,
  UserDto,
} from '@rootcamp/api-contract';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiClientError, apiFetch } from './client';

export const ME_KEY = ['me'] as const;

const UserResponse = z.object({ user: UserDto });

/**
 * The signed-in user (`GET /api/me`). A 401 redirects to the login form (client); 5xx
 * goes to the error boundary; other errors are not retried.
 */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => apiFetch('/api/me', undefined, MeDto),
    retry: (count, err) => !(err instanceof ApiClientError) && count < 2,
    throwOnError: (err) => err instanceof ApiClientError && err.status >= 500,
  });
}

export const authApi = {
  register: (body: RegisterBody) =>
    apiFetch('/api/auth/register', { method: 'POST', json: body }, UserResponse),
  login: (body: LoginBody) =>
    apiFetch('/api/auth/login', { method: 'POST', json: body }, UserResponse),
  logout: () => apiFetch<void>('/api/auth/logout', { method: 'POST' }),
  verify: (token: string) =>
    apiFetch('/api/auth/verify', { method: 'POST', json: { token } }, UserResponse),
  resendVerification: () => apiFetch<void>('/api/auth/resend-verification', { method: 'POST' }),
  forgot: (body: ForgotBody) => apiFetch<void>('/api/auth/forgot', { method: 'POST', json: body }),
  reset: (body: ResetBody) => apiFetch<void>('/api/auth/reset', { method: 'POST', json: body }),
  /** `GET /api/me` without the login redirect (e.g. on the public verify screen). */
  meOrNull: () =>
    apiFetch('/api/me', { redirectOn401: false }, MeDto).catch((err: unknown) => {
      if (err instanceof ApiClientError && err.status === 401) return null;
      throw err;
    }),
  changeEmail: (email: string) =>
    apiFetch('/api/me', { method: 'PATCH', json: { email } }, UserResponse),
};
