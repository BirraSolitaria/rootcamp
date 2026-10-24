// Shared dependency types for `AppDeps`. Implementations arrive later:
// Mailer → services/mailer.ts (Task 4, R-M2-1), pg-boss → jobs/boss.ts, limiting → Task 7 (R-M2-3).

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

/** pg-boss 10 instance: started by `jobs/boss.ts`, runs the `email` queue (Task 6). */
export type { default as PgBoss } from 'pg-boss';

/** Override for one rate limit (R-M2-3); omitted fields keep the production value. */
export interface LimitOverride {
  max?: number;
  windowMs?: number;
}

/** Rate-limit overrides keyed by limit name (names are defined by the limiter, Task 7). */
export type Limits = Partial<Record<string, LimitOverride>>;

/** sandboxd internal API client (services/sandboxdClient.ts, M4a). */
export type { SandboxdClient } from './services/sandboxdClient.js';
