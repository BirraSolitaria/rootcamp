import type { ErrorCode, RunState } from '@rootcamp/api-contract';
import type { PracticePublic } from '@rootcamp/content-schema';
import { ApiClientError } from '../../api/client';
import { errorText } from '../../api/messages';

/** §9 «Нет ресурсов»: `queue_full` (409 or 503) and `queue_timeout`. */
export const BUSY_TEXT = 'Сейчас все серверы заняты, попробуй через 10 минут';

const TEXT: Partial<Record<ErrorCode, string>> = {
  queue_full: BUSY_TEXT,
  quota_exceeded: 'На сегодня время практики закончилось (180 минут в сутки). Приходи завтра',
  practice_locked: 'Практика пока закрыта: пройди урок перед ней',
  email_unverified: 'Подтверди почту, чтобы запускать практику',
  reset_limit: 'Сбросы закончились: не больше 3 за запуск',
  extend_not_allowed: 'Продлить уже нельзя',
  // The api answers `validation` when the sandbox is not ready (or the run is over).
  validation: 'Сервер сейчас недоступен. Подожди немного и попробуй снова',
  not_found: 'Запуск не найден',
};

/** Russian text for a failed practice request; the practice codes come before the generic ones. */
export function practiceErrorText(err: unknown): string {
  if (err instanceof ApiClientError) {
    const text = TEXT[err.code];
    if (text) return text;
  }
  return errorText(err);
}

/** The sandbox state line of the screen. */
export const STATE_LABEL: Record<RunState, string> = {
  queued: 'В очереди',
  starting: 'Запускается',
  ready: 'Сервер готов',
  solved: 'Инцидент решён',
  expired: 'Время истекло',
  stopped: 'Остановлен',
  failed: 'Ошибка сервера',
  queue_timeout: 'Очередь не дошла',
};

/** «Начать (≈ 20 с)»: rough boot time by class (`docker` pulls images, `heavy` boots systemd). */
export function startLabel(cls: PracticePublic['class']): string {
  const seconds = cls === 'light' ? 20 : cls === 'docker' ? 40 : 60;
  return `Начать (≈ ${seconds} с)`;
}

/** What a failed run says (§9): setup failures differ from a crashed sandbox. */
export function failedText(stopReason: string | null): { text: string; action: string } {
  if (stopReason === 'setup_failed') {
    return { text: 'Не удалось подготовить инцидент. Мы уже знаем', action: 'Попробовать снова' };
  }
  if (stopReason === 'oom') {
    return { text: 'Сервер упал (не хватило памяти)', action: 'Запустить заново' };
  }
  return { text: 'Сервер упал', action: 'Запустить заново' };
}

/** A stopped run, by reason. */
export function stoppedText(stopReason: string | null): string {
  switch (stopReason) {
    case 'idle':
      return 'Сервер остановлен: 10 минут без действий';
    case 'disk_quota':
      return 'Сервер остановлен: занято слишком много места на диске';
    case 'stopped_by_admin':
      return 'Сервер остановил администратор';
    default:
      return 'Сервер остановлен';
  }
}
