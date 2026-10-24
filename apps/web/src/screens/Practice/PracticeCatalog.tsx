import type { MeDto, PracticeStatus } from '@rootcamp/api-contract';
import { Link } from 'react-router-dom';
import { usePractices } from '../../api/practice';
import { Mascot } from '../../components/Mascot';
import { useCatalog } from '../../content/useContent';
import { Shell } from '../../layout/Shell';
import { practiceErrorText } from './messages';
import styles from './Practice.module.css';

const LABEL: Record<PracticeStatus, string> = {
  locked: 'закрыта',
  available: 'доступна',
  solved: 'решена',
};

/** «Практика» (`/practice`, §8.1): incident cards with their status. */
export function PracticeCatalog({ me }: { me: MeDto }) {
  const practices = usePractices();
  const catalog = useCatalog();
  const trackTitle = (id: string) => catalog.data?.tracks.find((t) => t.id === id)?.title ?? id;

  let body;
  if (practices.error) {
    body = (
      <p role="alert" className="alert">
        {practiceErrorText(practices.error)}
      </p>
    );
  } else if (!practices.data) {
    body = (
      <div className={styles.message}>
        <Mascot state="waiting" />
      </div>
    );
  } else if (practices.data.length === 0) {
    body = <p className="t-body">Инциденты появятся здесь совсем скоро.</p>;
  } else {
    body = (
      <ul className={styles.catalog}>
        {practices.data.map((p) => {
          const inner = (
            <>
              <span className={styles.termIcon} aria-hidden="true">
                &gt;_
              </span>
              <span className={styles.catalogText}>
                <span className={styles.catalogTitle}>{p.title}</span>
                <span className="t-small">{trackTitle(p.track)}</span>
              </span>
              <span className={styles.badge}>{LABEL[p.status]}</span>
            </>
          );
          return (
            <li key={p.id} data-status={p.status}>
              {p.status === 'locked' ? (
                <div className={styles.catalogCard} aria-disabled="true">
                  {inner}
                </div>
              ) : (
                <Link to={`/practice/${p.id}`} className={styles.catalogCard}>
                  {inner}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Shell isAdmin={me.user.isAdmin}>
      <div className={styles.screen}>
        <header className={styles.head}>
          <h1 className="t-display">Практика</h1>
          <p className="t-body">
            Настоящие поломки на отдельном сервере: найди причину в терминале и почини.
          </p>
        </header>
        {body}
      </div>
    </Shell>
  );
}
