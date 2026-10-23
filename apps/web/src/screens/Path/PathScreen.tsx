import type { MeDto, PracticeStatus } from '@rootcamp/api-contract';
import type { Track } from '@rootcamp/content-schema';
import { lessonStatuses, pluralRu, practiceAvailability } from '@rootcamp/logic';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { errorText } from '../../api/messages';
import { authApi } from '../../api/queries';
import { Mascot } from '../../components/Mascot';
import { useCatalog, useProgress } from '../../content/useContent';
import { Shell } from '../../layout/Shell';
import { ProgressBar } from '../../player/ProgressBar';
import { HeaderChips } from './HeaderChips';
import { RightColumn } from './RightColumn';
import { type SectionState, SectionBlock } from './SectionBlock';
import { TrackSelect } from './TrackSelect';
import styles from './Path.module.css';

/** The last track opened on «Путь»; `/` goes back to it. */
export const LAST_TRACK_KEY = 'rc:lastTrack';

function readLastTrack(): string | null {
  try {
    return window.localStorage.getItem(LAST_TRACK_KEY);
  } catch {
    return null;
  }
}

function rememberTrack(id: string): void {
  try {
    window.localStorage.setItem(LAST_TRACK_KEY, id);
  } catch {
    // storage unavailable (private mode): `/` falls back to the first track
  }
}

const byOrder = (tracks: Track[]) => [...tracks].sort((a, b) => a.order - b.order);

/** «Привет, nick!» and «Выйти» (the profile screen takes them over later). */
function Account({ me }: { me: MeDto }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });
  return (
    <div className={styles.account}>
      <span>
        Привет, <span data-testid="nick">{me.user.nick}</span>!
      </span>
      <button type="button" className="btn btn-ghost" onClick={() => logout.mutate()}>
        Выйти
      </button>
    </div>
  );
}

/** Shell + the path's top row; `header` and `children` fill the rest. */
function PathFrame({
  me,
  dueCount,
  header,
  children,
}: {
  me: MeDto;
  dueCount?: number;
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Shell isAdmin={me.user.isAdmin} aside={<RightColumn me={me} dueCount={dueCount} />}>
      <div className={styles.screen}>
        <header className={styles.header}>
          <div className={styles.topRow}>
            <h1 className={styles.kicker}>Путь</h1>
            <Account me={me} />
          </div>
          {header}
          <HeaderChips me={me} />
        </header>
        {children}
      </div>
    </Shell>
  );
}

function Pending({ error }: { error: Error | null }) {
  if (error) {
    return (
      <p role="alert" className="alert">
        {errorText(error)}
      </p>
    );
  }
  return (
    <div className={styles.center}>
      <Mascot state="waiting" />
    </div>
  );
}

/** `/`: the last opened track (`rc:lastTrack`), otherwise the first by `order`. */
export function PathIndex({ me }: { me: MeDto }) {
  const catalog = useCatalog();
  if (!catalog.data) {
    return (
      <PathFrame me={me}>
        <Pending error={catalog.error} />
      </PathFrame>
    );
  }
  const tracks = byOrder(catalog.data.tracks);
  const last = readLastTrack();
  const target = tracks.find((t) => t.id === last) ?? tracks[0];
  if (!target) {
    return (
      <PathFrame me={me}>
        <p className="t-body">Курсы появятся здесь совсем скоро.</p>
      </PathFrame>
    );
  }
  return <Navigate to={`/track/${target.id}`} replace />;
}

/** Sections before the one holding the current lesson are done, after it locked. */
function sectionStates(track: Track, lessons: Record<string, string>): SectionState[] {
  let passed = false;
  return track.sections.map((s) => {
    const current = s.nodes.some((n) => n.kind === 'lesson' && lessons[n.lessonId] === 'current');
    if (current) {
      passed = true;
      return 'current';
    }
    return passed ? 'locked' : 'done';
  });
}

/** «Путь» of one track (`/track/:trackId`, §8.1). */
export function PathScreen({ me }: { me: MeDto }) {
  const { trackId } = useParams();
  const catalog = useCatalog();
  const progress = useProgress();
  const track = catalog.data?.tracks.find((t) => t.id === trackId);

  useEffect(() => {
    if (track) rememberTrack(track.id);
  }, [track]);

  if (catalog.data && !track) return <Navigate to="/" replace />;
  if (!catalog.data || !track || !progress.data) {
    return (
      <PathFrame me={me} dueCount={progress.data?.dueCount}>
        <Pending error={catalog.error ?? progress.error} />
      </PathFrame>
    );
  }

  const done = progress.data.completedLessonIds;
  const lessons = lessonStatuses(track, done);
  // Availability follows the path; the server's status adds `solved`.
  const practices: Record<string, PracticeStatus> = practiceAvailability(track, done);
  for (const [id, status] of Object.entries(progress.data.practiceStatuses)) {
    if (id in practices) practices[id] = status;
  }
  const states = sectionStates(track, lessons);
  const statuses = Object.values(lessons);
  const total = statuses.length;
  const built = statuses.filter((s) => s === 'completed').length;

  const header = (
    <>
      <TrackSelect tracks={byOrder(catalog.data.tracks)} value={track.id} />
      <div className={styles.trackProgress}>
        <ProgressBar value={total ? built / total : 0} label="Прогресс трека" />
        <span className={styles.trackProgressText}>
          {`${built} из ${total} ${pluralRu(total, 'урока', 'уроков', 'уроков')}`}
        </span>
      </div>
    </>
  );

  return (
    <PathFrame me={me} dueCount={progress.data.dueCount} header={header}>
      <div className={styles.sections}>
        {track.sections.map((section, i) => (
          <SectionBlock
            key={section.id}
            section={section}
            state={states[i] ?? 'locked'}
            lessons={lessons}
            practices={practices}
          />
        ))}
      </div>
    </PathFrame>
  );
}
