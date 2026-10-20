import { Email } from '@rootcamp/api-contract';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorText } from '../../api/messages';
import { authApi } from '../../api/queries';
import { AuthCard, Field, FormError } from './AuthCard';

/** `/forgot`: always the same answer, whether or not the account exists. */
export function Forgot() {
  const [email, setEmail] = useState('');
  const forgot = useMutation({ mutationFn: authApi.forgot });

  function submit(e: FormEvent) {
    e.preventDefault();
    forgot.mutate({ email: email.trim() });
  }

  if (forgot.isSuccess) {
    return (
      <AuthCard title="Проверь почту" mascot="waiting">
        <p className="t-body">
          Если аккаунт с адресом <strong>{email.trim()}</strong> есть, мы отправили на него ссылку
          для сброса пароля. Она действует 1 час.
        </p>
        <p className="t-small">Не видно письма? Загляни в папку «Спам».</p>
        <Link to="/login">Ко входу</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Сброс пароля">
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
        <FormError text={forgot.isError ? errorText(forgot.error) : null} />
        <button
          type="submit"
          className="btn"
          disabled={!Email.safeParse(email.trim()).success || forgot.isPending}
        >
          Прислать ссылку
        </button>
      </form>
      <Link to="/login">Вспомнил пароль</Link>
    </AuthCard>
  );
}
