import { expect, test } from 'vitest';
import {
  ApiError,
  ChangePasswordBody,
  ErrorCode,
  ForgotBody,
  LoginBody,
  MeDto,
  PatchMeBody,
  Rank,
  RegisterBody,
  ResetBody,
  UserDto,
  VerifyBody,
} from '@rootcamp/api-contract';

const register = {
  email: 'ann@example.com',
  nick: 'ann_01',
  password: '1234567890',
  tz: 'Europe/Moscow',
};

const user = {
  id: '6f1c2a4e-8b3d-4c1a-9e2f-0a1b2c3d4e5f',
  email: 'ann@example.com',
  nick: 'ann_01',
  emailVerified: false,
  isAdmin: false,
  tz: 'Europe/Moscow',
  rank: 'guest',
  totalXp: 0,
  reminderEnabled: true,
  reminderTime: '20:00',
};

test('ErrorCode lists every code from §5.1, §5.2 and §9', () => {
  expect(ErrorCode.options).toContain('content_changed');
  expect(ErrorCode.options).toContain('queue_full');
  expect(ErrorCode.options).toEqual([
    'validation',
    'csrf',
    'unauthorized',
    'forbidden',
    'not_found',
    'rate_limited',
    'registration_closed',
    'user_limit',
    'email_taken',
    'nick_taken',
    'invalid_credentials',
    'banned',
    'email_unverified',
    'token_invalid',
    'token_expired',
    'token_used',
    'email_already_verified',
    'wrong_password',
    'locked',
    'no_hearts',
    'out_of_order',
    'content_changed',
    'session_closed',
    'practice_locked',
    'run_exists',
    'quota_exceeded',
    'queue_full',
    'extend_not_allowed',
    'reset_limit',
    'self',
    'already_friends',
    'already_requested',
    'internal',
  ]);
});

test('ApiError accepts known codes, optional runId, rejects unknown codes', () => {
  expect(ApiError.safeParse({ error: { code: 'csrf', message: 'x' } }).success).toBe(true);
  expect(
    ApiError.safeParse({ error: { code: 'run_exists', message: 'x', runId: 'r1' } }).success,
  ).toBe(true);
  expect(ApiError.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false);
});

test('RegisterBody: password length 10..128', () => {
  expect(RegisterBody.safeParse(register).success).toBe(true);
  expect(RegisterBody.safeParse({ ...register, password: '123456789' }).success).toBe(false);
  expect(RegisterBody.safeParse({ ...register, password: 'a'.repeat(128) }).success).toBe(true);
  expect(RegisterBody.safeParse({ ...register, password: 'a'.repeat(129) }).success).toBe(false);
});

test('RegisterBody: nick ^[a-z0-9_.]{3,20}$', () => {
  expect(RegisterBody.safeParse({ ...register, nick: 'Ann' }).success).toBe(false);
  expect(RegisterBody.safeParse({ ...register, nick: 'an' }).success).toBe(false);
  expect(RegisterBody.safeParse({ ...register, nick: 'a'.repeat(21) }).success).toBe(false);
  expect(RegisterBody.safeParse({ ...register, nick: 'a.b_9' }).success).toBe(true);
  expect(RegisterBody.safeParse({ ...register, nick: 'a-b' }).success).toBe(false);
});

test('RegisterBody: email format, non-empty tz, optional honeypot', () => {
  expect(RegisterBody.safeParse({ ...register, email: 'not-an-email' }).success).toBe(false);
  expect(RegisterBody.safeParse({ ...register, tz: '' }).success).toBe(false);
  expect(RegisterBody.safeParse({ ...register, website: 'http://spam' }).success).toBe(true);
});

test('auth bodies', () => {
  expect(LoginBody.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
  expect(LoginBody.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  expect(ForgotBody.safeParse({ email: 'a@b.co' }).success).toBe(true);
  expect(ForgotBody.safeParse({}).success).toBe(false);
  expect(VerifyBody.safeParse({ token: 'abc' }).success).toBe(true);
  expect(VerifyBody.safeParse({ token: '' }).success).toBe(false);
  expect(ResetBody.safeParse({ token: 'abc', password: '1234567890' }).success).toBe(true);
  expect(ResetBody.safeParse({ token: 'abc', password: 'short' }).success).toBe(false);
  expect(ChangePasswordBody.safeParse({ current: 'old', next: '1234567890' }).success).toBe(true);
  expect(ChangePasswordBody.safeParse({ current: 'old', next: 'short' }).success).toBe(false);
});

test('PatchMeBody: reminderTime is HH:MM', () => {
  expect(PatchMeBody.parse({ reminderTime: '20:00' })).toEqual({ reminderTime: '20:00' });
  expect(PatchMeBody.safeParse({ reminderTime: '25:00' }).success).toBe(false);
  expect(PatchMeBody.safeParse({ reminderTime: '20:60' }).success).toBe(false);
  expect(PatchMeBody.safeParse({ reminderTime: '8:00' }).success).toBe(false);
  expect(PatchMeBody.safeParse({ reminderTime: '23:59' }).success).toBe(true);
  expect(PatchMeBody.parse({})).toEqual({});
  expect(
    PatchMeBody.safeParse({ tz: 'UTC', reminderEnabled: false, email: 'b@c.de' }).success,
  ).toBe(true);
  expect(PatchMeBody.safeParse({ email: 'nope' }).success).toBe(false);
});

test('Rank enum', () => {
  expect(Rank.options).toEqual(['guest', 'user', 'sudoer', 'root']);
});

test('UserDto and MeDto', () => {
  expect(UserDto.parse(user)).toEqual(user);
  expect(UserDto.safeParse({ ...user, rank: 'admin' }).success).toBe(false);
  const me = {
    user,
    hearts: { count: 5, msToNext: null },
    streak: { current: 0, best: 0 },
    xpToday: 0,
    dailyGoal: 30,
    rank: 'guest',
    nextRank: { next: 'user', xpNeeded: 200, tracksNeeded: 0 },
  };
  expect(MeDto.parse(me)).toEqual(me);
  expect(MeDto.safeParse({ ...me, dailyGoal: 50 }).success).toBe(false);
  expect(MeDto.safeParse({ ...me, hearts: { count: 3, msToNext: 60_000 } }).success).toBe(true);
  expect(
    MeDto.safeParse({ ...me, nextRank: { next: null, xpNeeded: 0, tracksNeeded: 0 } }).success,
  ).toBe(true);
});
