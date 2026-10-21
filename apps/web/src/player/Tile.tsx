import type { ReactNode } from 'react';
import { NATIVE_ENTER } from './keys';
import styles from './Tile.module.css';

/** `pairN` — colour of a linked pair in match_pairs (up to 5, cycled). */
export type TileTone = 'idle' | 'selected' | 'wrong' | `pair${0 | 1 | 2 | 3 | 4}`;

export interface TileProps {
  children: ReactNode;
  onClick(): void;
  tone?: TileTone;
  disabled?: boolean;
  mono?: boolean;
  /** Toggle state for screen readers (`aria-pressed`). */
  pressed?: boolean;
  /** Keyboard hint shown on the tile (option number). */
  hint?: string;
  /** Enter on this tile activates it (default) or means «Проверить» (false). */
  nativeEnter?: boolean;
  label?: string;
  className?: string;
  dataKey?: string;
}

/** Answer tile shared by the task views: dark chip on a thicker bottom edge, ≥ 44 px tall. */
export function Tile({
  children,
  onClick,
  tone = 'idle',
  disabled = false,
  mono = false,
  pressed,
  hint,
  nativeEnter = true,
  label,
  className,
  dataKey,
}: TileProps) {
  return (
    <button
      type="button"
      className={[styles.tile, styles[tone], mono ? styles.mono : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={label}
      data-key={dataKey}
      onClick={onClick}
      {...(nativeEnter ? NATIVE_ENTER : {})}
    >
      {hint !== undefined && (
        <span className={styles.hint} aria-hidden="true">
          {hint}
        </span>
      )}
      <span className={styles.label}>{children}</span>
    </button>
  );
}

/** Empty slot left in a bank when a tile is in use (keeps the layout from jumping). */
export function TileGhost({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={[styles.tile, styles.ghost, mono ? styles.mono : ''].join(' ')}
      aria-hidden="true"
    >
      <span className={styles.label}>{children}</span>
    </span>
  );
}
