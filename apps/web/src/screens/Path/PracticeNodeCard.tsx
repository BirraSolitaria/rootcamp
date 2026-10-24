import type { PracticeStatus } from '@rootcamp/api-contract';
import { Link } from 'react-router-dom';
import { features } from '../../config';
import styles from './Path.module.css';

const LABEL: Record<PracticeStatus, string> = {
  locked: 'закрыта',
  available: 'практика',
  solved: 'решена',
};

/** A practice node of the path: a card with a terminal icon, opening `/practice/:id` unless locked. */
export function PracticeNodeCard({
  practiceId,
  title,
  status,
}: {
  practiceId: string;
  title: string;
  status: PracticeStatus;
}) {
  const inner = (
    <>
      <span className={styles.termIcon} aria-hidden="true">
        &gt;_
      </span>
      <span className={styles.layerTitle}>{title}</span>
      <span className={styles.layerBadge}>{LABEL[status]}</span>
    </>
  );
  const open = features.practice && status !== 'locked';
  return (
    <li data-status={status} className={styles.practice}>
      {open ? (
        <Link to={`/practice/${practiceId}`} className={styles.layer}>
          {inner}
        </Link>
      ) : (
        <div className={styles.layer} aria-disabled={status === 'locked' ? 'true' : undefined}>
          {inner}
        </div>
      )}
    </li>
  );
}
