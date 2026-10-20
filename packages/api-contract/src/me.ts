import { z } from 'zod';
import { Email, TimeZone } from './auth.js';

export const Rank = z.enum(['guest', 'user', 'sudoer', 'root']);
export type Rank = z.infer<typeof Rank>;

/** Wall-clock time `HH:MM`, 00:00–23:59. */
export const ReminderTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const Count = z.number().int().nonnegative();

export const PatchMeBody = z.object({
  tz: TimeZone.optional(),
  reminderEnabled: z.boolean().optional(),
  reminderTime: ReminderTime.optional(),
  email: Email.optional(),
});
export type PatchMeBody = z.infer<typeof PatchMeBody>;

export const UserDto = z.object({
  id: z.uuid(),
  email: z.string(),
  nick: z.string(),
  emailVerified: z.boolean(),
  isAdmin: z.boolean(),
  tz: z.string(),
  rank: Rank,
  totalXp: Count,
  reminderEnabled: z.boolean(),
  reminderTime: ReminderTime,
});
export type UserDto = z.infer<typeof UserDto>;

export const MeDto = z.object({
  user: UserDto,
  hearts: z.object({ count: Count, msToNext: z.number().nonnegative().nullable() }),
  streak: z.object({ current: Count, best: Count }),
  xpToday: Count,
  dailyGoal: z.literal(30),
  rank: Rank,
  nextRank: z.object({ next: Rank.nullable(), xpNeeded: Count, tracksNeeded: Count }),
});
export type MeDto = z.infer<typeof MeDto>;
