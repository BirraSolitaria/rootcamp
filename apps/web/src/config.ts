/**
 * Screens that exist in this build. Navigation hides items whose screen is not built yet;
 * later milestones flip their flag.
 */
export const features = {
  practice: false,
  review: false,
  leaderboard: false,
  profile: false,
  admin: false,
} as const;

export type Feature = keyof typeof features;

/** React Router v6: opt into v7 behaviour now (silences the future-flag warnings). */
export const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const;
