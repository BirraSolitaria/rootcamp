import type { MeDto } from '@rootcamp/api-contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/queries';
import { Mascot } from '../components/Mascot';

/** «Путь» (`/`): a stub until the course map lands; greets the user by nick. */
export function Path({ me }: { me: MeDto }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });

  return (
    <section style={{ display: 'grid', gap: 'var(--space-lg)' }}>
      <h1 className="t-display">Путь</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
        <Mascot state="happy" size={56} />
        <p className="t-heading">
          Привет, <span data-testid="nick">{me.user.nick}</span>!
        </p>
      </div>
      <p className="t-body">Курсы появятся здесь совсем скоро.</p>
      <div>
        <button type="button" className="btn btn-ghost" onClick={() => logout.mutate()}>
          Выйти
        </button>
      </div>
    </section>
  );
}
