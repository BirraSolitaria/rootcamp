import { layerHash, type LessonStatus } from '@rootcamp/logic';
import { Link } from 'react-router-dom';
import styles from './Path.module.css';

const BADGE: Record<LessonStatus, (lessonId: string) => string> = {
  completed: (id) => `слой ${layerHash(id)}`,
  current: () => 'СЕЙЧАС',
  locked: () => 'закрыт',
};

/**
 * One lesson as a layer of the image: a built layer with its hash, the current one in amber,
 * locked ones dashed. Completed and current lessons open the lesson screen.
 */
export function LessonLayer({
  lessonId,
  title,
  num,
  status,
}: {
  lessonId: string;
  title: string;
  num: number;
  status: LessonStatus;
}) {
  const inner = (
    <>
      <span className={styles.layerNum} aria-hidden="true">
        {String(num).padStart(2, '0')}
      </span>
      <span className={styles.layerTitle}>{title}</span>
      <span className={styles.layerBadge}>{BADGE[status](lessonId)}</span>
    </>
  );
  return (
    <li data-status={status}>
      {status === 'locked' ? (
        <div className={styles.layer} aria-disabled="true">
          {inner}
        </div>
      ) : (
        <Link
          to={`/lesson/${lessonId}`}
          className={styles.layer}
          aria-current={status === 'current' ? 'step' : undefined}
        >
          {inner}
        </Link>
      )}
    </li>
  );
}
