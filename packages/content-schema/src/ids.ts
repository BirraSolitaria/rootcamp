/** ID formats (spec §4.1). Each pattern matches the whole string. */
export const ID_RE = {
  track: /^t\d{1,2}$/,
  section: /^t\d{1,2}\.s\d{2}$/,
  lesson: /^t\d{1,2}\.s\d{2}\.l\d{2}$/,
  task: /^t\d{1,2}\.s\d{2}\.l\d{2}\.t\d{2}$/,
  practice: /^inc-[a-z0-9-]{3,40}$/,
  goal: /^[a-z0-9-]{2,30}$/,
} as const satisfies Record<string, RegExp>;
