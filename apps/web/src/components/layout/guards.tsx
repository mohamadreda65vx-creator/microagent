import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { homePathFor, useAuth } from '../../lib/auth';
import type { Permission, Role } from '../../lib/types';
import { LogoMark } from '../brand/Logo';
import { Button, ErrorState } from '../ui/primitives';

export function FullPageLoader() {
  return (
    <div className="grid min-h-dvh place-items-center bg-white" role="status" aria-label="Loading">
      <div className="animate-pulse">
        <LogoMark size={56} />
      </div>
    </div>
  );
}

/** Wraps everything that needs a signed-in user. */
export function RequireAuth({ roles }: { roles: 'tenant' | 'platform' }) {
  const { me, loading, error, retry } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (error) {
    return (
      <div className="grid min-h-dvh place-items-center bg-white px-4">
        <div>
          <ErrorState error={error} onRetry={retry} />
        </div>
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;

  const isPlatform = me.user.role === 'platform_admin';
  if (roles === 'platform' && !isPlatform) return <Navigate to={homePathFor(me)} replace />;
  if (roles === 'tenant' && isPlatform) return <Navigate to={homePathFor(me)} replace />;
  return <Outlet />;
}

/** Hides a page the role cannot use (the API enforces this too; this is only the friendly side). */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  if (can(permission)) return <>{children}</>;
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h2 className="font-display text-xl font-semibold text-mist-900">You don’t have access to this page</h2>
      <p className="mt-2 text-sm text-mist-500">Ask the workspace owner to change your role if you need it.</p>
      <Button className="mt-5" variant="secondary" onClick={() => history.back()}>
        Go back
      </Button>
    </div>
  );
}

export type { Role };
