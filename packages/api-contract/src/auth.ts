import { z } from 'zod';

export const Email = z.email();
/** New passwords: 8–128 characters. */
export const Password = z.string().min(8).max(128);
/** Existing password as typed by the user: only bounded, never policy-checked. */
const PasswordInput = z.string().min(1).max(128);
export const Nick = z.string().regex(/^[a-z0-9_.]{3,20}$/);
/** IANA zone name; validity is checked by the api, not by the contract. */
export const TimeZone = z.string().min(1);
const Token = z.string().min(1);

/** `website` is a honeypot: when non-empty the server answers 201 and creates nothing. */
export const RegisterBody = z.object({
  email: Email,
  nick: Nick,
  password: Password,
  tz: TimeZone,
  website: z.string().optional(),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const LoginBody = z.object({ email: Email, password: PasswordInput });
export type LoginBody = z.infer<typeof LoginBody>;

export const ForgotBody = z.object({ email: Email });
export type ForgotBody = z.infer<typeof ForgotBody>;

export const ResetBody = z.object({ token: Token, password: Password });
export type ResetBody = z.infer<typeof ResetBody>;

export const VerifyBody = z.object({ token: Token });
export type VerifyBody = z.infer<typeof VerifyBody>;

export const ChangePasswordBody = z.object({ current: PasswordInput, next: Password });
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;
