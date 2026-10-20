import type { MeDto } from '@rootcamp/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { ROUTER_FUTURE } from '../src/config';

export const user = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'neo@example.com',
  nick: 'neo',
  emailVerified: false,
  isAdmin: false,
  tz: 'Europe/Moscow',
  rank: 'guest',
  totalXp: 0,
  reminderEnabled: true,
  reminderTime: '19:00',
} as const satisfies MeDto['user'];

export function meDto(overrides: Partial<MeDto['user']> = {}): MeDto {
  return {
    user: { ...user, ...overrides },
    hearts: { count: 5, msToNext: null },
    streak: { current: 0, best: 0 },
    xpToday: 0,
    dailyGoal: 30,
    rank: 'guest',
    nextRank: { next: 'user', xpNeeded: 100, tracksNeeded: 0 },
  };
}

export function jsonResponse(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
  });
}

/** Replaces `fetch` with a mock answering from `respond` (called once per request). */
export function mockFetch(respond: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) =>
    respond(String(input), init),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Shows the current path + search, so tests can assert navigation. */
function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

export function renderAt(
  ui: ReactElement,
  { path = '/', route = path, me }: { path?: string; route?: string; me?: MeDto } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  if (me) client.setQueryData(['me'], me);
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]} future={ROUTER_FUTURE}>
        <Routes>
          <Route path={path} element={ui} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}
