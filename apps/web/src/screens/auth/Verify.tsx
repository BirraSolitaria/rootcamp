import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../../api/client';
import { errorText } from '../../api/messages';
import { authApi, ME_KEY } from '../../api/queries';
import { AuthCard } from './AuthCard';

type Outcome =
  { kind: 'pending' } | { kind: 'ok' } | { kind: 'expired' } | { kind: 'failed'; text: string };

/** `/verify?token=…` from the confirmation letter (24 h, one-time). */
export function Verify() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome>(() =>
    token ? { kind: 'pending' } : { kind: 'failed', text: 'Ссылка недействительна' },
  );
  // One POST per token, also under StrictMode's double effect run.
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!token || sent.current === token) return;
    sent.current = token;
    authApi
      .verify(token)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ME_KEY });
        setOutcome({ kind: 'ok' });
      })
      .catch(async (err: unknown) => {
        if (err instanceof ApiClientError && err.code === 'token_used') {
          // A reused link (second tab, mail scanner) is fine if the email is confirmed.
          const me = await authApi.meOrNull().catch(() => null);
          if (me?.user.emailVerified) {
            qc.setQueryData(ME_KEY, me);
            setOutcome({ kind: 'ok' });
            return;
          }
        }
        if (err instanceof ApiClientError && err.code === 'token_expired') {
          setOutcome({ kind: 'expired' });
          return;
        }
        setOutcome({ kind: 'failed', text: errorText(err) });
      });
  }, [token, qc]);

  switch (outcome.kind) {
    case 'pending':
      return (
        <AuthCard title="Проверяем ссылку…" mascot="waiting">
          <p className="t-body">Секунду.</p>
        </AuthCard>
      );
    case 'ok':
      return (
        <AuthCard title="Почта подтверждена" mascot="happy">
          <p className="t-body">Всё готово, можно учиться.</p>
          <Link className="btn" to="/" style={{ display: 'grid', placeItems: 'center' }}>
            К обучению
          </Link>
        </AuthCard>
      );
    case 'expired':
      return (
        <AuthCard title="Ссылка устарела" mascot="sad">
          <p className="t-body">Ссылка действует 24 часа. Войди и запроси новое письмо.</p>
          <Link to="/check-email">Отправить письмо ещё раз</Link>
        </AuthCard>
      );
    default:
      return (
        <AuthCard title="Не получилось" mascot="sad">
          <p role="alert" className="alert">
            {outcome.text}
          </p>
          <Link to="/login">Ко входу</Link>
        </AuthCard>
      );
  }
}
