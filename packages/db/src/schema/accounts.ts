// Accounts tables (spec §4.4). Column names are spelled out in snake_case; TS keys are camelCase.
// Enumerations are TypeScript-level (`text` + `enum`) rather than pg enums or CHECKs, so adding a
// value later never needs a migration. Migrations are extend-only.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Case-insensitive text (`CREATE EXTENSION citext` is the first statement of migration 0000). */
const citext = customType<{ data: string }>({ dataType: () => 'citext' });

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const userRef = (name = 'user_id') =>
  uuid(name)
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });
const serialId = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();

export const USER_STATUSES = ['active', 'banned'] as const;
export const RANKS = ['guest', 'user', 'sudoer', 'root'] as const;
export const EMAIL_TOKEN_KINDS = ['verify', 'reset'] as const;
export const EMAIL_KINDS = ['verify', 'reset', 'reminder', 'alert'] as const;
export const EMAIL_STATUSES = ['queued', 'sent', 'failed'] as const;
export const XP_SOURCES = ['lesson', 'review', 'drill', 'practice'] as const;

/** Nick format (Global Constraints). Enforced on `nick::text` so citext does not relax the case. */
export const NICK_PATTERN = '^[a-z0-9_.]{3,20}$';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull().unique(),
    emailVerifiedAt: tstz('email_verified_at'),
    nick: citext('nick').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    banReason: text('ban_reason'),
    /** IANA zone; days for streaks and the daily goal are computed in it. */
    tz: text('tz').notNull().default('Europe/Moscow'),
    rank: text('rank', { enum: RANKS }).notNull().default('guest'),
    /** Invariant: equals sum(xp_events.amount); both are written in one transaction. */
    totalXp: integer('total_xp').notNull().default(0),
    reminderEnabled: boolean('reminder_enabled').notNull().default(true),
    reminderTime: time('reminder_time').notNull().default('20:00'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at'),
  },
  (t) => [check('users_nick_format', sql`${t.nick}::text ~ ${sql.raw(`'${NICK_PATTERN}'`)}`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the cookie token (hex); the token itself is never stored. */
    id: text('id').primaryKey(),
    userId: userRef(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userRef(),
    kind: text('kind', { enum: EMAIL_TOKEN_KINDS }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
  },
  (t) => [index('email_tokens_user_id_idx').on(t.userId)],
);

export const emailLog = pgTable(
  'email_log',
  {
    id: serialId(),
    /** Null for mail not tied to an account (e.g. admin alerts). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: EMAIL_KINDS }).notNull(),
    status: text('status', { enum: EMAIL_STATUSES }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    sentAt: tstz('sent_at'),
    /** Address the letter goes to; kept after delivery for diagnostics (§9). */
    recipient: text('recipient'),
    // The letter itself while it awaits delivery (the queue job carries only `id`). Cleared once
    // the row is `sent` or `failed`: bodies may hold one-time links.
    subject: text('subject'),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    /** Set while a worker holds the row (claim → outcome written); an in-flight guard. */
    claimedAt: tstz('claimed_at'),
    /** When the next delivery attempt is due (insert time, then each retry's time). */
    nextAttemptAt: tstz('next_attempt_at'),
  },
  (t) => [index('email_log_user_id_idx').on(t.userId)],
);

export const hearts = pgTable(
  'hearts',
  {
    userId: userRef().primaryKey(),
    count: integer('count').notNull().default(5),
    lastRegenAt: tstz('last_regen_at').notNull().defaultNow(),
  },
  (t) => [check('hearts_count_range', sql`${t.count} BETWEEN 0 AND 5`)],
);

export const streaks = pgTable('streaks', {
  userId: userRef().primaryKey(),
  current: integer('current').notNull().default(0),
  best: integer('best').notNull().default(0),
  /** Date key in the user's zone. */
  lastActivityDate: date('last_activity_date', { mode: 'string' }),
});

export const xpEvents = pgTable(
  'xp_events',
  {
    id: serialId(),
    userId: userRef(),
    amount: integer('amount').notNull(),
    source: text('source', { enum: XP_SOURCES }).notNull(),
    refId: text('ref_id'),
    /** Date key in the user's zone at the time of the event. */
    day: date('day', { mode: 'string' }).notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('xp_events_user_id_day_idx').on(t.userId, t.day),
    index('xp_events_created_at_idx').on(t.createdAt),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: serialId(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    /** Not a foreign key: the audit trail must outlive its target. */
    targetId: text('target_id'),
    data: jsonb('data').$type<unknown>(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_created_at_idx').on(t.createdAt)],
);
