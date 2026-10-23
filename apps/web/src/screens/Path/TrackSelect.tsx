import type { Track } from '@rootcamp/content-schema';
import { useId } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './Path.module.css';

/** Track picker of the path header: choosing a track opens `/track/:trackId`. */
export function TrackSelect({ tracks, value }: { tracks: Track[]; value: string }) {
  const navigate = useNavigate();
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="visually-hidden">
        Трек
      </label>
      <select
        id={id}
        className={styles.select}
        value={value}
        onChange={(e) => navigate(`/track/${e.target.value}`)}
      >
        {tracks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
    </>
  );
}
