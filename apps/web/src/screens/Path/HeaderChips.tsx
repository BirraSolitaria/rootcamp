import type { MeDto } from '@rootcamp/api-contract';
import { HeartsIndicator } from '../../player/HeartsIndicator';
import styles from './Path.module.css';

function FlameIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 2c1 3.5 5 6 5 11a5 5 0 0 1-10 0c0-2.4 1.2-4 2.5-5.3.2 1.6 1 2.8 2.2 3.3C11 8 11 5 12 2z" />
    </svg>
  );
}

/** Status chips of the path header: streak, XP today / goal, hearts, rank. */
export function HeaderChips({ me }: { me: MeDto }) {
  return (
    <ul className={styles.chips} aria-label="Статус">
      <li className={styles.chip} aria-label={`Серия: ${me.streak.current}`}>
        <span className={styles.flame}>
          <FlameIcon />
        </span>
        <span aria-hidden="true">{me.streak.current}</span>
      </li>
      <li className={`${styles.chip} ${styles.xp}`}>{`XP ${me.xpToday}/${me.dailyGoal}`}</li>
      <li className={styles.chip}>
        <HeartsIndicator count={me.hearts.count} msToNext={me.hearts.msToNext} />
      </li>
      <li className={`${styles.chip} ${styles.rank}`} aria-label={`Ранг: ${me.rank}`}>
        <span aria-hidden="true">{me.rank}</span>
      </li>
    </ul>
  );
}
