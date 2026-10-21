/** Russian plural form for n: `one` (1, 21, …), `few` (2–4, 22–24, …), `many` (0, 5–20, …). */
export function pluralRu<T extends string>(n: number, one: T, few: T, many: T): T {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Russian plural form of «день» for n (§7.8). */
export function pluralDays(n: number): 'день' | 'дня' | 'дней' {
  return pluralRu(n, 'день', 'дня', 'дней');
}
