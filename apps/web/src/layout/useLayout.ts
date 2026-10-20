import { useSyncExternalStore } from 'react';

/** §8.2 layouts: phone < 640, tablet 640–1023, laptop 1024–1279, desktop ≥ 1280. */
export type Layout = 'phone' | 'tablet' | 'laptop' | 'desktop';

export function layoutFor(width: number): Layout {
  if (width < 640) return 'phone';
  if (width < 1024) return 'tablet';
  if (width < 1280) return 'laptop';
  return 'desktop';
}

function subscribe(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

const snapshot = () => layoutFor(window.innerWidth);

/** Current layout, re-rendering when the window crosses a breakpoint. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, snapshot, () => 'desktop');
}
