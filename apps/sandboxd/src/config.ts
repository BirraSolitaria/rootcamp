import { z } from 'zod';

/** Unset and empty strings both mean "not provided" (compose passes `${VAR:-}` as ""). */
const blankToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v;

const required = z.preprocess(blankToUndefined, z.string());
const optional = z.preprocess(blankToUndefined, z.string().optional());
const secret = z.preprocess(blankToUndefined, z.string().min(16));

/** Non-negative integer; unset or empty means `fallback`. */
const int = (fallback: number, min = 0) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^\d+$/, 'must be a non-negative integer')
      .transform(Number)
      .refine((n) => n >= min, `must be ≥ ${min}`)
      .default(fallback),
  );

/** Positive decimal; unset or empty means `fallback`. */
const positiveNumber = (fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'must be a positive number')
      .transform(Number)
      .refine((n) => n > 0, 'must be a positive number')
      .default(fallback),
  );

const path = (fallback: string) => z.preprocess(blankToUndefined, z.string().default(fallback));

export const SandboxDriverName = z.enum(['sysbox', 'runc-dev']);
export type SandboxDriverName = z.infer<typeof SandboxDriverName>;

/** Default sandbox network per driver: infra's `rc-sbx`, or the dev bridge sandboxd creates. */
export const DEFAULT_NETWORK: Record<SandboxDriverName, string> = {
  sysbox: 'rc-sbx',
  'runc-dev': 'rc-sbx-dev',
};

const EnvSchema = z.object({
  DATABASE_URL: required,
  /** Bearer token on the internal API (api → sandboxd). */
  INTERNAL_TOKEN: secret,
  /** HMAC key for terminal tickets, shared with api. */
  TICKET_SECRET: secret,
  SANDBOX_DRIVER: z.preprocess(blankToUndefined, SandboxDriverName.default('sysbox')),
  SANDBOX_NETWORK: optional,
  /** Admission budget (spec §6.5). */
  BUDGET_MEM_MB: int(5120, 1),
  BUDGET_CPU: positiveNumber(3.5),
  HEAVY_SLOTS: int(1),
  QUEUE_MAX: int(10),
  /** Host `/proc` and `/` mounted read-only, for host metrics. */
  HOST_PROC: path('/host/proc'),
  HOST_ROOT: path('/host/root'),
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(['development', 'test', 'production']).default('production'),
  ),
  PORT: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^\d+$/, 'must be an integer 0-65535')
      .transform(Number)
      .refine((n) => n <= 65535, 'must be an integer 0-65535')
      .default(3001),
  ),
  HOST: path('0.0.0.0'),
});

export interface Config {
  databaseUrl: string;
  internalToken: string;
  ticketSecret: string;
  driver: SandboxDriverName;
  network: string;
  /** Matches the scheduler's `Budget`. */
  budget: { memMb: number; cpu: number; heavySlots: number };
  queueMax: number;
  hostProc: string;
  hostRoot: string;
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
}

/** Validates the process environment; throws one error naming every invalid variable. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  ${i.path.join('.')}: ${i.code === 'invalid_type' ? 'is required' : i.message}`,
    );
    throw new Error(`invalid configuration:\n${lines.join('\n')}`);
  }
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    internalToken: e.INTERNAL_TOKEN,
    ticketSecret: e.TICKET_SECRET,
    driver: e.SANDBOX_DRIVER,
    network: e.SANDBOX_NETWORK ?? DEFAULT_NETWORK[e.SANDBOX_DRIVER],
    budget: { memMb: e.BUDGET_MEM_MB, cpu: e.BUDGET_CPU, heavySlots: e.HEAVY_SLOTS },
    queueMax: e.QUEUE_MAX,
    hostProc: e.HOST_PROC,
    hostRoot: e.HOST_ROOT,
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
  };
}

/**
 * runc-dev gives no user-namespace isolation: it must never run in production. server.ts
 * calls this first and exits 1 on the error.
 */
export function assertDriverAllowed(cfg: Pick<Config, 'driver' | 'nodeEnv'>): void {
  if (cfg.driver === 'runc-dev' && cfg.nodeEnv === 'production') {
    throw new Error('SANDBOX_DRIVER=runc-dev is not allowed with NODE_ENV=production (use sysbox)');
  }
}
