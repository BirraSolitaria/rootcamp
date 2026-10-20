import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { errorText } from '../../api/messages';
import { authApi, ME_KEY } from '../../api/queries';
import { AuthCard, Field, FormError } from './AuthCard';
import styles from './AuthCard.module.css';
import { safeNext } from './nav';

export function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: authApi.login,
    onSuccess: ({ user }) => {
      qc.removeQueries({ queryKey: ME_KEY });
      navigate(user.emailVerified ? safeNext(params.get('next')) : '/check-email', {
        replace: true,
      });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate({ email: email.trim(), password });
  }

  return (
    <AuthCard title="Вход" mascot={login.isError ? 'sad' : 'idle'}>
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
          label="Пароль"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <FormError text={login.isError ? errorText(login.error) : null} />
        <button
          type="submit"
          className="btn"
          disabled={login.isPending || !email.trim() || !password}
        >
          Войти
        </button>
      </form>
      <div className={styles.links}>
        <Link to="/forgot">Забыли пароль?</Link>
        <Link to="/register">Регистрация</Link>
      </div>
    </AuthCard>
  );
}
