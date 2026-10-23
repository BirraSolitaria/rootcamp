import type { MeDto, ReviewMode } from '@rootcamp/api-contract';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { errorText } from '../../api/messages';
import { Mascot } from '../../components/Mascot';
import { useProgress } from '../../content/useContent';
import { Shell } from '../../layout/Shell';
import styles from '../shared/Session.module.css';
import { Loading, SessionView } from '../shared/SessionView';
import { useLearningSession } from '../shared/useLearningSession';

/**
 * «Повторение» (`/review`, §8.1): «Повторение (N)» while tasks are due, otherwise «Тренировка»
 * on random tasks of completed lessons; the same player as the lesson.
 */
export function ReviewScreen({ me }: { me: MeDto }) {
  const progress = useProgress();
  const [mode, setMode] = useState<ReviewMode | null>(null);
  const session = useLearningSession(mode === null ? null : { kind: 'review', mode });

  if (mode !== null && session.state.phase !== 'empty') {
    return <SessionView session={session} exitTo="/" progressLabel="Прогресс повторения" />;
  }

  let body;
  if (mode !== null) {
    body = (
      <>
        <Mascot state="idle" />
        <h1 className={styles.introTitle}>Пока нечего тренировать</h1>
        <p className={styles.introText}>Пройди хотя бы один урок — его задания появятся здесь.</p>
        <Link to="/" className="btn btn-ghost">
          К пути
        </Link>
      </>
    );
  } else if (!progress.data) {
    body = progress.error ? (
      <p role="alert" className="alert">
        {errorText(progress.error)}
      </p>
    ) : (
      <Loading />
    );
  } else {
    const due = progress.data.dueCount;
    body = (
      <>
        <Mascot state="happy" />
        <h1 className={styles.introTitle}>{due > 0 ? `Повторение (${due})` : 'Тренировка'}</h1>
        <p className={styles.introText}>
          {due > 0
            ? 'Задания, в которых были ошибки, — пора закрепить. Сердечки не тратятся, а за сессию — +1.'
            : 'К повторению ничего нет: случайные задания из пройденных уроков. За сессию — +1 сердечко.'}
        </p>
        <button
          type="button"
          className={['btn', styles.wide].join(' ')}
          onClick={() => setMode(due > 0 ? 'review' : 'drill')}
        >
          Начать
        </button>
      </>
    );
  }
  return (
    <Shell isAdmin={me.user.isAdmin}>
      <div className={styles.intro}>{body}</div>
    </Shell>
  );
}
