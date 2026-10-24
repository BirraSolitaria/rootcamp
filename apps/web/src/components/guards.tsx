import type { MeDto } from '@rootcamp/api-contract';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { errorText } from '../api/messages';
import { useMe } from '../api/queries';
import { Mascot } from './Mascot';

/** Full-screen waiting mascot: session lookup and lazy-loaded screens. */
export function Loading() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
      <Mascot state="waiting" />
    </div>
  );
}

/**
 * Renders `children(me)` for a signed-in user. Without a session the api client has already
 * sent the user to `/login?next=…`; `verified` also sends unconfirmed users to «Проверь почту».
 */
export function RequireUser({
  verified = true,
  children,
}: {
  verified?: boolean;
  children: (me: MeDto) => ReactNode;
}) {
  const me = useMe();
  if (me.isPending) return <Loading />;
  if (me.isError) {
    return (
      <p role="alert" className="alert" style={{ margin: 'var(--space-lg)' }}>
        {errorText(me.error)}
      </p>
    );
  }
  if (verified && !me.data.user.emailVerified) return <Navigate to="/check-email" replace />;
  return children(me.data);
}
