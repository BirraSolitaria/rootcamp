import { type RefObject, useLayoutEffect, useState } from 'react';

/** Never squeeze the terminal below this, even with the keyboard open on a tiny screen. */
export const MIN_TERMINAL_AREA_PX = 120;

/**
 * §8.3: the height from the top of `ref` down to the bottom of the visual viewport, so the
 * terminal and its key row stay above the soft keyboard (the last line stays visible). `null`
 * when disabled or the browser has no `visualViewport` — the caller keeps its CSS height then.
 */
export function useVisualViewport(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
    if (!enabled || !vv) {
      setHeight(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      // Both in layout-viewport coordinates: the visible bottom is offsetTop + height.
      const top = el.getBoundingClientRect().top;
      const next = Math.max(MIN_TERMINAL_AREA_PX, Math.floor(vv.offsetTop + vv.height - top));
      setHeight((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('orientationchange', schedule);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('orientationchange', schedule);
    };
  }, [ref, enabled]);

  return height;
}
