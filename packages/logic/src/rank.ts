export type Rank = 'guest' | 'user' | 'sudoer' | 'root';

/** Ranks from lowest to highest. */
export const RANK_ORDER: Rank[] = ['guest', 'user', 'sudoer', 'root'];

/** Requirements per rank (spec §ranks); `guest` has none. */
const RANK_REQUIREMENTS: Record<Exclude<Rank, 'guest'>, { xp: number; tracks: number }> = {
  user: { xp: 200, tracks: 0 },
  sudoer: { xp: 1500, tracks: 1 },
  root: { xp: 6000, tracks: 4 },
};

function meets(rank: Rank, totalXp: number, completedTracks: number): boolean {
  if (rank === 'guest') return true;
  const req = RANK_REQUIREMENTS[rank];
  return totalXp >= req.xp && completedTracks >= req.tracks;
}

/** Highest rank whose XP and completed-track requirements are both met. */
export function computeRank(totalXp: number, completedTracks: number): Rank {
  let result: Rank = 'guest';
  for (const rank of RANK_ORDER) {
    if (meets(rank, totalXp, completedTracks)) result = rank;
  }
  return result;
}

/** The higher of two ranks (a stored rank never drops). */
export function maxRank(a: Rank, b: Rank): Rank {
  return RANK_ORDER.indexOf(a) >= RANK_ORDER.indexOf(b) ? a : b;
}

/** What is still missing for the rank after the current one; `next: null` at `root`. */
export function nextRankProgress(
  totalXp: number,
  completedTracks: number,
): { next: Rank | null; xpNeeded: number; tracksNeeded: number } {
  const current = computeRank(totalXp, completedTracks);
  const next = RANK_ORDER[RANK_ORDER.indexOf(current) + 1];
  if (next === undefined) return { next: null, xpNeeded: 0, tracksNeeded: 0 };
  // `next` follows `current`, so it is never `guest`.
  const req = RANK_REQUIREMENTS[next as Exclude<Rank, 'guest'>];
  return {
    next,
    xpNeeded: Math.max(0, req.xp - totalXp),
    tracksNeeded: Math.max(0, req.tracks - completedTracks),
  };
}
