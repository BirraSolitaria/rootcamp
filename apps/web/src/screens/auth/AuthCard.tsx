import type { InputHTMLAttributes, ReactNode } from 'react';
import { Mascot, type MascotState } from '../../components/Mascot';
import styles from './AuthCard.module.css';

/** Centered card shared by the sign-in screens. */
export function AuthCard({
  title,
  mascot = 'idle',
  children,
}: {
  title: string;
  mascot?: MascotState;
  children: ReactNode;
}) {
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <div className={styles.head}>
          <Mascot state={mascot} size={56} />
          <span className="t-label">rootcamp</span>
        </div>
        <h1 className="t-display">{title}</h1>
        {children}
      </section>
    </main>
  );
}

/** Labelled input; `label` is the accessible name. */
export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = `f-${input.name ?? label}`;
  return (
    <div className="field">
      <label htmlFor={id} className="t-label">
        {label}
      </label>
      <input
        id={id}
        className="input"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint && (
        <span id={`${id}-hint`} className="t-small">
          {hint}
        </span>
      )}
    </div>
  );
}

/** Form-level error, announced by screen readers. */
export function FormError({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="alert">
      {text}
    </p>
  ) : null;
}
