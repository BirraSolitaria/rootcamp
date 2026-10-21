import { Password } from '@rootcamp/api-contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { errorText } from '../../api/messages';
import { authApi } from '../../api/queries';
import { AuthCard, Field, FormError } from './AuthCard';

/** `/reset?token=…` from the reset letter (1 h, one-time; signs out everywhere). */
export function Reset() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const reset = useMutation({
    mutationFn: authApi.reset,
    // Every session is gone now, ours included.
    onSuccess: () => qc.clear(),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    reset.mutate({ token, password });
  }

  if (!token) {
    return (
      <AuthCard title="Ссылка недействительна" mascot="sad">
        <Link to="/forgot">Запросить новую ссылку</Link>
      </AuthCard>
    );
  }

  if (reset.isSuccess) {
    return (
      <AuthCard title="Пароль изменён" mascot="happy">
        <p className="t-body">Войди с новым паролем.</p>
        <Link to="/login">Ко входу</Link>
      </AuthCard>
    );
  }

  const mismatch = repeat.length > 0 && repeat !== password;
  return (
    <AuthCard title="Новый пароль" mascot={reset.isError ? 'sad' : 'idle'}>
      <form onSubmit={submit} noValidate>
        <Field
          label="Новый пароль"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="Не меньше 8 символов"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          label="Повтори пароль"
          name="repeat"
          type="password"
          autoComplete="new-password"
          hint={mismatch ? 'Пароли не совпадают' : undefined}
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
        <FormError text={reset.isError ? errorText(reset.error) : null} />
        <button
          type="submit"
          className="btn"
          disabled={!Password.safeParse(password).success || repeat !== password || reset.isPending}
        >
          Сохранить пароль
        </button>
      </form>
      {reset.isError && <Link to="/forgot">Запросить новую ссылку</Link>}
    </AuthCard>
  );
}
