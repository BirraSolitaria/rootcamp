import type { ReactNode } from 'react';
import { Nav } from './Nav';
import styles from './Shell.module.css';
import { useLayout } from './useLayout';

/**
 * App frame for signed-in screens (§8.2): bottom tabs below 1024 px, side navigation above;
 * `aside` is the right column at ≥ 1280 px and drops under the main column below that.
 */
export function Shell({
  children,
  aside,
  isAdmin,
}: {
  children: ReactNode;
  aside?: ReactNode;
  isAdmin?: boolean;
}) {
  const layout = useLayout();
  const side = layout === 'laptop' || layout === 'desktop';
  return (
    <div className={`${styles.shell} ${styles[layout]}`} data-layout={layout}>
      {side && <Nav variant="side" isAdmin={isAdmin} />}
      <div className={styles.columns}>
        <main className={styles.main}>{children}</main>
        {aside && <aside className={styles.aside}>{aside}</aside>}
      </div>
      {!side && <Nav variant="bottom" isAdmin={isAdmin} />}
    </div>
  );
}
