import { z } from 'zod';

const DEFAULT_PORT = 3000;

/** Parses the PORT env value; unset or empty means 3000. Throws on anything but a 0-65535 integer. */
export function parsePort(value: string | undefined): number {
  const raw = value?.trim() ?? '';
  if (raw === '') return DEFAULT_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new Error(`PORT must be an integer 0-65535, got "${value}"`);
  }
  return port;
}

/** Unset and empty strings both mean "not provided" (compose passes `${VAR:-}` as ""). */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const required = z.preprocess(blankToUndefined, z.string());
const optional = z.preprocess(blankToUndefined, z.string().optional());
const secret = z.preprocess(blankToUndefined, z.string().min(16));

const port = (fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^\d+$/, 'must be an integer 0-65535')
      .transform(Number)
      .refine((n) => n <= 65535, 'must be an integer 0-65535')
      .default(fallback),
  );

const bool = (fallback: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .enum(['true', 'false'], 'must be "true" or "false"')
      .transform((v) => v === 'true')
      .default(fallback),
  );

/** Absolute http(s) URL with no path, query or fragment; normalised to `URL.origin`. */
const origin = z.preprocess(
  blankToUndefined,
  z.string().transform((v, ctx) => {
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be an absolute URL' });
      return z.NEVER;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      ctx.addIssue({ code: 'custom', message: 'must be a bare http(s) origin' });
      return z.NEVER;
    }
    return url.origin;
  }),
);

const ConfigSchema = z.object({
  DATABASE_URL: required,
  /** Site origin as the browser sees it; CSRF compares `Origin` with it verbatim. */
  PUBLIC_ORIGIN: origin,
  /** `false` only on plain-http stands (dev, e2e). */
  COOKIE_SECURE: bool(true),
  SMTP_HOST: required,
  SMTP_PORT: port(587),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  SMTP_FROM: required,
  /** Bearer token for internal calls (sandboxd → api). */
  INTERNAL_TOKEN: secret,
  /** HMAC key for terminal tickets, shared with sandboxd. */
  TICKET_SECRET: secret,
  /** sandboxd base URL; required once M4a wires practices. */
  SANDBOXD_URL: optional,
  /** Content tree root; required once M3 serves content. */
  CONTENT_DIR: optional,
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(['development', 'test', 'production']).default('production'),
  ),
  PORT: port(DEFAULT_PORT),
  /**
   * Reverse proxies in front of the api that append the client address to X-Forwarded-For.
   * 1 (default): Caddy, which overwrites X-Forwarded-For from untrusted clients; `req.ip` is
   * the address Caddy saw. 0: the api is reached directly and X-Forwarded-For is ignored
   * (otherwise any client could pick its own IP and dodge the per-IP rate limits).
   */
  TRUST_PROXY_HOPS: z.preprocess(
    blankToUndefined,
    z.string().regex(/^\d$/, 'must be an integer 0-9').transform(Number).default(1),
  ),
  HOST: z.preprocess(blankToUndefined, z.string().default('0.0.0.0')),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Validates the process environment; throws one error naming every invalid variable. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  ${i.path.join('.')}: ${i.code === 'invalid_type' ? 'is required' : i.message}`,
    );
    throw new Error(`invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
