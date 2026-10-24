import type { PracticePublic } from '@rootcamp/content-schema';
import { Mascot, type MascotState } from '../../components/Mascot';
import { startLabel } from './messages';
import styles from './Practice.module.css';

/**
 * Before the start: «Начать (≈ 20 с)». After a run ended it carries the reason (`note`) and its
 * own button text («Новый сервер», «Запустить заново»…).
 */
export function StartCard({
  cls,
  onStart,
  pending,
  error,
  note,
  label,
  mascot,
}: {
  cls: PracticePublic['class'];
  onStart: () => void;
  pending: boolean;
  error: string | null;
  /** Why a new start is needed. */
  note?: string;
  /** Button text instead of «Начать (≈ N с)». */
  label?: string;
  mascot?: MascotState;
}) {
  return (
    <div className={styles.stageCard}>
      {mascot && <Mascot state={mascot} />}
      {note ? (
        <p className="t-heading">{note}</p>
      ) : (
        <p className="t-body">
          Мы поднимем для тебя отдельный сервер с поломкой. Чини её в терминале и жми «Проверить».
        </p>
      )}
      <button
        type="button"
        className="btn"
        onClick={onStart}
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {label ?? startLabel(cls)}
      </button>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </div>
  );
}
