export type MascotState = 'idle' | 'happy' | 'sad' | 'waiting' | 'sleep';

const LABEL: Record<MascotState, string> = {
  idle: 'Терминальная мордочка',
  happy: 'Терминальная мордочка радуется',
  sad: 'Терминальная мордочка грустит',
  waiting: 'Терминальная мордочка ждёт',
  sleep: 'Терминальная мордочка спит',
};

/** Eyes, then mouth, per state. */
function Face({ state }: { state: MascotState }) {
  switch (state) {
    case 'happy':
      return (
        <>
          <path d="M22 30 l4 -4 l4 4 M42 30 l4 -4 l4 4" />
          <path d="M26 42 q10 8 20 0" />
        </>
      );
    case 'sad':
      return (
        <>
          <circle cx="26" cy="30" r="3" fill="currentColor" stroke="none" />
          <circle cx="46" cy="30" r="3" fill="currentColor" stroke="none" />
          <path d="M26 46 q10 -8 20 0" />
        </>
      );
    case 'waiting':
      return (
        <>
          <circle cx="26" cy="30" r="3" fill="currentColor" stroke="none" />
          <circle cx="46" cy="30" r="3" fill="currentColor" stroke="none" />
          <path d="M28 43 h2 M35 43 h2 M42 43 h2" />
        </>
      );
    case 'sleep':
      return (
        <>
          <path d="M22 31 h8 M42 31 h8" />
          <path d="M30 43 h12" />
          <path d="M56 14 h6 l-6 6 h6" strokeWidth="2" />
        </>
      );
    default:
      return (
        <>
          <circle cx="26" cy="30" r="3" fill="currentColor" stroke="none" />
          <circle cx="46" cy="30" r="3" fill="currentColor" stroke="none" />
          <path d="M27 43 h18" />
        </>
      );
  }
}

/** «Терминальная мордочка» (§8.1): terminal frame, two dot eyes, a bar mouth. */
export function Mascot({ state = 'idle', size = 72 }: { state?: MascotState; size?: number }) {
  const color =
    state === 'sad' ? 'var(--coral)' : state === 'happy' ? 'var(--teal)' : 'var(--amber)';
  return (
    <svg
      role="img"
      aria-label={LABEL[state]}
      data-state={state}
      width={size}
      height={size}
      viewBox="0 0 72 72"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color }}
    >
      <rect x="6" y="10" width="60" height="50" rx="8" fill="var(--term)" stroke="var(--edge)" />
      <path d="M6 20 h60" stroke="var(--edge)" strokeWidth="2" />
      <circle cx="12" cy="15" r="1.5" fill="var(--coral)" stroke="none" />
      <circle cx="17" cy="15" r="1.5" fill="var(--amber)" stroke="none" />
      <circle cx="22" cy="15" r="1.5" fill="var(--teal)" stroke="none" />
      <Face state={state} />
    </svg>
  );
}
