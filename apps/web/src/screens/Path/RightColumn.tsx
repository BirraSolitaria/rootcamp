import type { MeDto } from '@rootcamp/api-contract';
import { useId } from 'react';
import { Link } from 'react-router-dom';
import { usePractices } from '../../api/practice';
import { features } from '../../config';
import { ProgressBar } from '../../player/ProgressBar';
import styles from './Path.module.css';

/**
 * Right column of the path (≥ 1280 px; under the main column below that): today's goal and
 * «Инцидент дня» and the review counter. «Неделя» joins in M5.
 */
export function RightColumn({ me, dueCount }: { me: MeDto; dueCount: number | undefined }) {
  const goalId = useId();
  const reviewId = useId();
  return (
    <div className={styles.aside}>
      <section className={styles.card} aria-labelledby={goalId}>
        <h2 id={goalId} className={styles.cardTitle}>
          Цель на сегодня
        </h2>
        <div className={styles.cardRow}>
          <ProgressBar value={me.xpToday / me.dailyGoal} label="Цель на сегодня" />
          <span className={styles.cardValue}>{`${me.xpToday}/${me.dailyGoal}`}</span>
        </div>
        <p className={styles.cardText}>
          {me.xpToday >= me.dailyGoal ? 'Цель дня выполнена' : 'XP за сегодня'}
        </p>
      </section>

      {features.practice && <IncidentOfDay />}

      <section className={styles.card} aria-labelledby={reviewId}>
        <h2 id={reviewId} className={styles.cardTitle}>
          Повторение
        </h2>
        {dueCount !== undefined && (
          <p className={styles.cardText}>
            {dueCount > 0 ? (
              <>
                К повторению: <span className={styles.cardValue}>{dueCount}</span>
              </>
            ) : (
              'Повторять пока нечего — можно потренироваться'
            )}
          </p>
        )}
        <Link to="/review" className={`btn btn-ghost ${styles.cardButton}`}>
          {dueCount ? 'Повторить' : 'Тренировка'}
        </Link>
      </section>
    </div>
  );
}

/**
 * «Инцидент дня»: the first available practice not solved yet (§8.1). Hidden while there is
 * none (no practices in the content, all solved or locked) or the list did not load.
 */
function IncidentOfDay() {
  const id = useId();
  const practices = usePractices();
  const next = practices.data?.find((p) => p.status === 'available');
  if (!next) return null;
  return (
    <section className={styles.card} aria-labelledby={id}>
      <h2 id={id} className={styles.cardTitle}>
        Инцидент дня
      </h2>
      <p className={styles.cardText}>{next.title}</p>
      <Link to={`/practice/${next.id}`} className={`btn ${styles.cardButton}`}>
        Чинить
      </Link>
    </section>
  );
}
