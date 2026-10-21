import { Email, type MeDto } from '@rootcamp/api-contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiClientError } from '../../api/client';
import { errorText, retryWait } from '../../api/messages';
import { authApi, ME_KEY, useMe } from '../../api/queries';
import { AuthCard, Field, FormError } from './AuthCard';
import styles from './AuthCard.module.css';
import { useSecondsLeft } from './useSecondsLeft';

const COOLDOWN_MS = 60_000;
/** After this many resends the screen suggests writing to the administrator (§9). */
const RESENDS_BEFORE_ADMIN = 3;

/** «Проверь почту» (§8.1, §9): shown after registration and to unverified users. */
export function CheckEmail() {
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // The registration (or login) that led here has just sent a letter.
  const [until, setUntil] = useState(() => Date.now() + COOLDOWN_MS);
  const left = useSecondsLeft(until);
  const [resends, setResends] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');

  const verified = me.data?.user.emailVerified === true;
  useEffect(() => {
    if (verified) navigate('/', { replace: true });
  }, [verified, navigate]);

  function failed(err: unknown) {
    if (err instanceof ApiClientError && err.code === 'email_already_verified') {
      void qc.invalidateQueries({ queryKey: ME_KEY });
      navigate('/', { replace: true });
      return;
    }
    if (err instanceof ApiClientError && err.code === 'rate_limited') {
      setUntil(Date.now() + (err.retryAfter ?? 60) * 1000);
    }
    setNotice(null);
    setError(errorText(err));
  }

  const resend = useMutation({
    mutationFn: authApi.resendVerification,
    onSuccess: () => {
      setResends((n) => n + 1);
      setUntil(Date.now() + COOLDOWN_MS);
      setError(null);
      setNotice('Письмо отправлено ещё раз');
    },
    onError: failed,
  });

  const changeEmail = useMutation({
    mutationFn: authApi.changeEmail,
    onSuccess: ({ user }) => {
      qc.setQueryData<MeDto>(ME_KEY, (old) => (old ? { ...old, user } : old));
      setNewEmail('');
      setUntil(Date.now() + COOLDOWN_MS);
      setError(null);
      setNotice('Письмо отправлено на новый адрес');
    },
    onError: failed,
  });

  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });

  function submitEmail(e: FormEvent) {
    e.preventDefault();
    changeEmail.mutate(newEmail.trim());
  }

  const email = me.data?.user.email;
  return (
    <AuthCard title="Проверь почту" mascot="waiting">
      <p className="t-body">
        Мы отправили письмо со ссылкой на <strong>{email ?? '…'}</strong>. Открой его, чтобы
        подтвердить адрес. Ссылка действует 24 часа.
      </p>
      <p className="t-small">Не видно письма? Загляни в папку «Спам».</p>
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      <FormError text={error} />
      <button
        type="button"
        className="btn"
        disabled={left > 0 || resend.isPending}
        onClick={() => resend.mutate()}
      >
        {left > 0 ? `Отправить ещё раз (${retryWait(left)})` : 'Отправить ещё раз'}
      </button>
      {resends >= RESENDS_BEFORE_ADMIN && (
        <p className="t-body">
          Письмо так и не приходит? Напиши администратору — он подтвердит адрес вручную.
        </p>
      )}
      <form onSubmit={submitEmail} noValidate>
        <Field
          label="Новый email"
          name="new-email"
          type="email"
          autoComplete="email"
          hint="Ошибся адресом? Укажи другой — письмо уйдёт на него."
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-ghost"
          disabled={!Email.safeParse(newEmail.trim()).success || changeEmail.isPending}
        >
          Сменить email
        </button>
      </form>
      <div className={styles.links}>
        <button type="button" className="btn btn-ghost" onClick={() => logout.mutate()}>
          Выйти
        </button>
      </div>
    </AuthCard>
  );
}
