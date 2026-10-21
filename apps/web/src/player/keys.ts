import { useEffect, useRef } from 'react';

/**
 * Elements marked with this attribute keep the browser's own Enter behaviour (activate the
 * focused tile, start a keyboard drag) instead of Enter meaning «Проверить» / «Продолжить».
 */
export const NATIVE_ENTER = { 'data-native-enter': '' } as const;

export function hasModifier(e: KeyboardEvent): boolean {
  return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
}

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/** Keys «1»…«4» pick the n-th shown option (single_choice, true_false). */
export function useDigitKeys(
  count: number,
  enabled: boolean,
  onPick: (shownIndex: number) => void,
) {
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  });
  useEffect(() => {
    if (!enabled) return;
    const max = Math.min(4, count);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || hasModifier(e) || isTextEntry(e.target)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= max) {
        e.preventDefault();
        pick.current(n - 1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [count, enabled]);
}
