/** XP for solving an already-solved practice again. */
export const PRACTICE_REPEAT_XP = 10;

export interface PracticeReward {
  base: number;
  noHintBonus: number;
  hintCost: number;
}

/**
 * XP for a solved practice (§practice reward). First solve:
 * `base − hintCost × hintsRevealed + (hintsRevealed == 0 ? noHintBonus : 0)`, never below 0;
 * repeat solves give `PRACTICE_REPEAT_XP`.
 */
export function practiceXp(
  reward: PracticeReward,
  hintsRevealed: number,
  firstSolve: boolean,
): number {
  if (!firstSolve) return PRACTICE_REPEAT_XP;
  const bonus = hintsRevealed === 0 ? reward.noHintBonus : 0;
  return Math.max(0, reward.base - reward.hintCost * hintsRevealed + bonus);
}
