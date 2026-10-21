import type { ErrorCode } from '@rootcamp/api-contract';
import { pluralRu } from '@rootcamp/logic';
import { ApiClientError } from './client';

const TEXT: Partial<Record<ErrorCode, string>> = {
  validation: 'Проверь, правильно ли заполнены поля',
  invalid_credentials: 'Неверный email или пароль',
  email_taken: 'Этот email уже занят',
  nick_taken: 'Этот ник уже занят',
  registration_closed: 'Регистрация сейчас закрыта',
  user_limit: 'Мест пока нет: достигнут лимит пользователей',
  banned: 'Аккаунт заблокирован',
  token_invalid: 'Ссылка недействительна',
  token_expired: 'Ссылка устарела',
  token_used: 'Ссылка уже использована',
  email_already_verified: 'Почта уже подтверждена',
  wrong_password: 'Текущий пароль неверный',
  csrf: 'Запрос отклонён. Обнови страницу и попробуй снова',
};

/** «Что-то сломалось (код reqId)» (§9). */
export function brokenText(reqId?: string): string {
  return reqId ? `Что-то сломалось (код ${reqId})` : 'Что-то сломалось';
}

/**
 * A retry wait as read after «через»: up to a minute in seconds («45 с»), longer in whole
 * minutes rounded up («2 минуты», «21 минуту», «59 минут»).
 */
export function retryWait(seconds: number): string {
  if (seconds <= 60) return `${seconds} с`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${pluralRu(minutes, 'минуту', 'минуты', 'минут')}`;
}

/** Russian text for a failed request, shown in forms (`role="alert"`). */
export function errorText(err: unknown): string {
  if (!(err instanceof ApiClientError)) return 'Нет связи с сервером. Попробуй ещё раз';
  if (err.code === 'rate_limited') {
    return err.retryAfter
      ? `Слишком много попыток. Попробуй через ${retryWait(err.retryAfter)}`
      : 'Слишком много попыток. Попробуй позже';
  }
  if (err.status >= 500) return brokenText(err.reqId);
  return TEXT[err.code] ?? err.message;
}
