import { Email, Nick, Password } from '@rootcamp/api-contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorText } from '../../api/messages';
import { authApi, ME_KEY } from '../../api/queries';
import { AuthCard, Field, FormError } from './AuthCard';
import styles from './AuthCard.module.css';

/** The zone the user's browser is in; the api checks it (spec §5.1). */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function Register() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [nick, setNick] = useState('');
  const [password, setPassword] = useState('');
  // Honeypot: invisible to people, bots fill it in (the api then creates nothing).
  const [website, setWebsite] = useState('');

  const register = useMutation({
    mutationFn: authApi.register,
    onSuccess: () => {
      qc.removeQueries({ queryKey: ME_KEY });
      navigate('/check-email', { replace: true });
    },
  });

  const valid =
    Email.safeParse(email.trim()).success &&
    Nick.safeParse(nick).success &&
    Password.safeParse(password).success;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    register.mutate({ email: email.trim(), nick, password, tz: browserTimeZone(), website });
  }

  return (
    <AuthCard title="Регистрация" mascot={register.isError ? 'sad' : 'idle'}>
      <form onSubmit={submit} noValidate>
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Ник"
          name="nick"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          required
          hint="3–20 символов: a–z, 0–9, _ и ."
          value={nick}
          onChange={(e) => setNick(e.target.value.toLowerCase())}
        />
        <Field
          label="Пароль"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          hint="Не меньше 10 символов"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="visually-hidden" aria-hidden="true">
          <label htmlFor="f-website">Сайт</label>
          <input
            id="f-website"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>
        <FormError text={register.isError ? errorText(register.error) : null} />
        <button type="submit" className="btn" disabled={!valid || register.isPending}>
          Создать аккаунт
        </button>
      </form>
      <div className={styles.links}>
        <span className="t-small">Уже есть аккаунт?</span>
        <Link to="/login">Войти</Link>
      </div>
    </AuthCard>
  );
}
