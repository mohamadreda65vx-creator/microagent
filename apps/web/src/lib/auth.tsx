import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { ApiError, api } from './api';
import type { Me, Permission } from './types';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  /** Set when the server refused the session for a reason other than "not signed in". */
  error: ApiError | Error | null;
  can: (permission: Permission) => boolean;
  login: (email: string, password: string) => Promise<Me>;
  signup: (input: { businessName: string; fullName: string; email: string; password: string }) => Promise<Me>;
  acceptInvitation: (input: { token: string; fullName: string; password: string }) => Promise<Me>;
  logout: () => Promise<void>;
  setProfileName: (fullName: string) => void;
  retry: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Drop every cached query EXCEPT the session one (clearing it would detach the observer that drives the UI). */
function resetCache(qc: ReturnType<typeof useQueryClient>, me: Me | null) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  qc.setQueryData(['me'], me);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  const query = useQuery<Me | null>({
    queryKey: ['me'],
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      try {
        return await api<Me>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });

  // The API tells us when the session died (401) or the workspace got suspended (403).
  useEffect(() => {
    const expired = () => resetCache(qc, null);
    const refresh = () => void qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('auth:expired', expired);
    window.addEventListener('auth:refresh', refresh);
    return () => {
      window.removeEventListener('auth:expired', expired);
      window.removeEventListener('auth:refresh', refresh);
    };
  }, [qc]);

  const establish = useCallback(
    (me: Me) => {
      // A different person may now be signed in: never show them the previous user's cached data.
      resetCache(qc, me);
      return me;
    },
    [qc],
  );

  const value = useMemo<AuthValue>(() => {
    const me = query.data ?? null;
    return {
      me,
      loading: query.isPending,
      error: query.error,
      can: (p) => !!me?.permissions.includes(p),
      login: async (email, password) => establish(await api<Me>('/auth/login', { body: { email, password } })),
      signup: async (input) => establish(await api<Me>('/auth/signup', { body: input })),
      acceptInvitation: async (input) => establish(await api<Me>('/auth/accept-invitation', { body: input })),
      logout: async () => {
        try {
          await api('/auth/logout', { method: 'POST' });
        } finally {
          resetCache(qc, null);
        }
      },
      setProfileName: (fullName) => qc.setQueryData<Me | null>(['me'], (old) => (old ? { ...old, user: { ...old.user, fullName } } : old)),
      retry: () => void query.refetch(),
    };
  }, [query.data, query.isPending, query.error, qc, establish, query]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function homePathFor(me: Me): string {
  return me.user.role === 'platform_admin' ? '/admin' : '/app';
}
