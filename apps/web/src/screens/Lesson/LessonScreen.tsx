import type { MeDto } from '@rootcamp/api-contract';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { errorText } from '../../api/messages';
import { useSection } from '../../content/useContent';
import { TheoryCardView } from '../../player/TheoryCardView';
import styles from '../shared/Session.module.css';
import { Loading, SessionView } from '../shared/SessionView';
import { sectionOf, useLearningSession } from '../shared/useLearningSession';

/**
 * «Урок» (`/lesson/:lessonId`, §8.1): the theory card, then the tasks. The session starts on
 * entry, so a locked lesson or an empty heart supply shows up before the theory.
 */
export function LessonScreen({ me }: { me: MeDto }) {
  const { lessonId = '' } = useParams();
  // Another lesson is a fresh screen (theory first).
  return <Lesson key={lessonId} me={me} lessonId={lessonId} />;
}

function Lesson({ me, lessonId }: { me: MeDto; lessonId: string }) {
  const trackPath = `/track/${lessonId.split('.')[0] ?? ''}`;
  const section = useSection(sectionOf(lessonId));
  const lesson = section.data?.lessons.find((l) => l.id === lessonId);
  const session = useLearningSession({ kind: 'lesson', lessonId });
  const [theoryRead, setTheoryRead] = useState(false);
  const { phase } = session.state;

  if (section.error || (section.data && lesson?.kind !== 'lesson')) {
    return (
      <div className={styles.message}>
        <p role="alert" className="alert">
          {section.error ? errorText(section.error) : 'Урок не найден.'}
        </p>
        <Link to={trackPath} className="btn btn-ghost">
          К пути
        </Link>
      </div>
    );
  }
  const playing = phase === 'starting' || phase === 'task' || phase === 'idle';
  if (!theoryRead && playing) {
    if (lesson?.kind !== 'lesson') return <Loading />;
    return <TheoryCardView theory={lesson.theory} onStart={() => setTheoryRead(true)} />;
  }
  return (
    <SessionView
      session={session}
      exitTo={trackPath}
      progressLabel="Прогресс урока"
      fallbackMsToNext={me.hearts.msToNext}
    />
  );
}
