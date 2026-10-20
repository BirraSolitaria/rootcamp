import { ApiError, type ErrorCode } from '@rootcamp/api-contract';
import type { z } from 'zod';

/** A failed API call: HTTP status plus the contract's error `code` (§9). */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** `Retry-After` of a 429, in seconds. */
  readonly retryAfter: number | undefined;
  /** `x-request-id`, quoted on «Что-то сломалось (код …)». */
  readonly reqId: string | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: { retryAfter?: number; reqId?: string } = {},
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.retryAfter = extra.retryAfter;
    this.reqId = extra.reqId;
  }
}

export type ApiInit = Omit<RequestInit, 'body'> & {
  body?: BodyInit | null;
  /** Sent as a JSON body. */
  json?: unknown;
  /** 401 → `/login?next=…`; on by default except for `/api/auth/*`. */
  redirectOn401?: boolean;
};

type Navigate = (to: string) => void;

let navigate: Navigate = (to) => window.location.assign(to);

/** The router registers its `navigate` so the 401 redirect stays inside the SPA. */
export function setNavigator(fn: Navigate): void {
  navigate = fn;
}

function currentLocation(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

async function toError(res: Response): Promise<ApiClientError> {
  const reqId = res.headers.get('x-request-id') ?? undefined;
  const retryHeader = Number(res.headers.get('retry-after'));
  const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined;
  const parsed = ApiError.safeParse(await res.json().catch(() => null));
  if (parsed.success) {
    const { code, message } = parsed.data.error;
    return new ApiClientError(res.status, code, message, { retryAfter, reqId });
  }
  return new ApiClientError(res.status, 'internal', `HTTP ${res.status}`, { retryAfter, reqId });
}

/**
 * Same-origin cookie-authenticated call to the api. Mutating requests carry `X-RC: 1`
 * (CSRF, §5.1). Errors become `ApiClientError`; a 401 outside `/api/auth/*` also sends
 * the user to the login form and back afterwards.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: ApiInit = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  const { json, redirectOn401 = !path.startsWith('/api/auth/'), ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const headers = new Headers(rest.headers);
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-RC', '1');
  let body = rest.body;
  if (json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(json);
  }

  const res = await fetch(path, { ...rest, method, headers, body, credentials: 'same-origin' });
  if (!res.ok) {
    const err = await toError(res);
    if (res.status === 401 && redirectOn401 && window.location.pathname !== '/login') {
      navigate('/login?next=' + encodeURIComponent(currentLocation()));
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json();
  return schema ? schema.parse(data) : (data as T);
}
