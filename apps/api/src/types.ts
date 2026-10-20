// Shared dependency types for `AppDeps`. Implementations arrive later:
// Mailer → services/mailer.ts (Task 4, R-M2-1), pg-boss → Task 6, limiting → Task 7 (R-M2-3).

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Sends one message right now; throws when the transport fails. */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/**
 * Minimal surface of a pg-boss instance the api relies on. Task 6 adds the `pg-boss`
 * dependency and may replace this with `import type { PgBoss } from 'pg-boss'`.
 */
export interface PgBoss {
  send(name: string, data: object, options?: object): Promise<string | null>;
  stop(options?: object): Promise<void>;
}

/** Override for one rate limit (R-M2-3); omitted fields keep the production value. */
export interface LimitOverride {
  max?: number;
  windowMs?: number;
}

/** Rate-limit overrides keyed by limit name (names are defined by the limiter, Task 7). */
export type Limits = Partial<Record<string, LimitOverride>>;

/** Placeholders until M4a / M3 define them. */
export type SandboxdClient = unknown;
export type ContentStore = unknown;
