import { NavLink } from 'react-router-dom';
import { type Feature, features } from '../config';
import styles from './Nav.module.css';

type Item = { to: string; label: string; glyph: string; feature?: Feature; adminOnly?: boolean };

/** §8.2 tabs; Админка lives in the profile on phones, so only the side menu lists it. */
const ITEMS: Item[] = [
  { to: '/', label: 'Путь', glyph: '≡' },
  { to: '/practice', label: 'Практика', glyph: '>_', feature: 'practice' },
  { to: '/review', label: 'Повторение', glyph: '↻', feature: 'review' },
  { to: '/leaderboard', label: 'Лидерборд', glyph: '#', feature: 'leaderboard' },
  { to: '/profile', label: 'Профиль', glyph: '@', feature: 'profile' },
  { to: '/admin', label: 'Админка', glyph: '$', feature: 'admin', adminOnly: true },
];

export function Nav({
  variant,
  isAdmin = false,
}: {
  variant: 'bottom' | 'side';
  isAdmin?: boolean;
}) {
  const items = ITEMS.filter(
    (it) =>
      (!it.feature || features[it.feature]) && (!it.adminOnly || (isAdmin && variant === 'side')),
  );
  return (
    <nav aria-label={variant === 'bottom' ? 'Вкладки' : 'Меню'} className={styles[variant]}>
      {variant === 'side' && <div className={`${styles.brand} t-display`}>rootcamp</div>}
      <ul className={styles.list}>
        {items.map((it) => (
          <li key={it.to}>
            <NavLink
              to={it.to}
              end={it.to === '/'}
              className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
            >
              <span className={styles.glyph} aria-hidden="true">
                {it.glyph}
              </span>
              <span>{it.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
