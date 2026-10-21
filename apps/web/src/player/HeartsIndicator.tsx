import { formatMmSs } from '@rootcamp/logic';
import styles from './parts.module.css';

export const MAX_HEARTS = 5;

export function HeartIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.2 3.1 4.5 6.7 4.5c2.1 0 3.6 1.1 4.3 2.3h2c.7-1.2 2.2-2.3 4.3-2.3 3.6 0 5.8 3.7 4.3 7.2C19.5 16.4 12 21 12 21z" />
    </svg>
  );
}

/** «♥ N» and, when not full, the regen timer «+1 через ММ:СС» next to it. */
export function HeartsIndicator({ count, msToNext }: { count: number; msToNext: number | null }) {
  const timer = count < MAX_HEARTS && msToNext !== null ? `+1 через ${formatMmSs(msToNext)}` : null;
  return (
    <span className={styles.hearts}>
      <span
        role="img"
        aria-label={`Сердечки: ${count}`}
        className={[styles.heartsValue, count === 0 ? styles.heartsEmpty : ''].join(' ')}
      >
        <HeartIcon />
        <span aria-hidden="true">{count}</span>
      </span>
      {timer !== null && <span className={styles.heartsTimer}>{timer}</span>}
    </span>
  );
}
