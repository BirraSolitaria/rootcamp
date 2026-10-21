import { type LessonSummary, pluralDays, type ReviewSummary } from '@rootcamp/logic';
import type { ReactNode } from 'react';
import { Mascot } from '../components/Mascot';
import styles from './parts.module.css';

function Stat({
  label,
  children,
  accent,
}: {
  label: string;
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={[styles.stat, accent ? styles.statAccent : ''].join(' ')}>
      <dt className={styles.statLabel}>{label}</dt>
      <dd className={styles.statValue}>{children}</dd>
    </div>
  );
}

function title(s: LessonSummary | ReviewSummary): string {
  if (s.kind === 'lesson') return 'Урок пройден';
  return s.mode === 'drill' ? 'Тренировка завершена' : 'Повторение завершено';
}

/** End of a lesson or review: XP, mistakes / correct, daily goal, streak (+1 heart for review). */
export function Summary({
  summary,
  onContinue,
}: {
  summary: LessonSummary | ReviewSummary;
  onContinue(): void;
}) {
  const s = summary;
  return (
    <div className={styles.summary}>
      <Mascot state="happy" size={88} />
      <h2 className={styles.summaryTitle}>{title(s)}</h2>
      <dl className={styles.stats}>
        <Stat label="Опыт" accent>{`+${s.xpGained} XP`}</Stat>
        {s.kind === 'lesson' ? (
          <Stat label="Ошибки">{s.perfect ? 'без ошибок' : String(s.mistakes)}</Stat>
        ) : (
          <Stat label="Верно">{`${s.correct} из ${s.total}`}</Stat>
        )}
        <Stat label="Цель дня">{`${s.xpToday}/${s.dailyGoal}`}</Stat>
        <Stat label="Серия">{`${s.streak} ${pluralDays(s.streak)}`}</Stat>
        {s.kind === 'review' && s.heartGained && <Stat label="Награда">+1 сердечко</Stat>}
      </dl>
      {s.goalJustReached && <p className={styles.goal}>Цель дня выполнена!</p>}
      {s.streakIncreased && <p className={styles.muted}>Серия продлена — так держать.</p>}
      <button
        type="button"
        className={['btn', styles.wide].join(' ')}
        onClick={onContinue}
        autoFocus
      >
        Продолжить
      </button>
    </div>
  );
}
