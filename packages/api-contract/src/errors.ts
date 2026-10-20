import { z } from 'zod';

/** Every API error code (spec §5.1, §5.2, §9). Responses never use any other `code`. */
export const ErrorCode = z.enum([
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
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Error response body: `{ error: { code, message } }`; `runId` accompanies `run_exists`. */
export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    runId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
