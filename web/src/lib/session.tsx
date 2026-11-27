import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { hasRole, type Role } from '../../../shared/constants';
import { ApiError, get, post, setCsrfToken } from './api';
import type { Me } from './types';
import { effectiveLocale, getLocale, setLocale } from './i18n';

export interface WorkspaceSettingsView {
  timezone: string;
  currency: string;
  locale: string;
  industry?: string;
  description?: string;
  approval: { requireDistinctApprover: boolean };
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<unknown>;
  setMe: (me: Me | null) => void;
  logout: () => Promise<void>;
  can: (min: Role) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await get<Me>('/auth/me');
        setCsrfToken(me.csrfToken);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  // Con la sesión se sabe qué idioma corresponde: el que eligió la persona o el de su organización.
  const me = q.data;
  useEffect(() => {
    if (!me) return;
    const orgTag = me.workspace?.locale ?? null;
    void setLocale(me.workspace || me.user.locale ? effectiveLocale(me.user.locale, orgTag) : getLocale(), { orgTag });
  }, [me]);
  const value: SessionValue = {
    me: q.data ?? null,
    loading: q.isLoading,
    refresh: () => q.refetch(),
    setMe: (me) => {
      setCsrfToken(me?.csrfToken ?? null);
      qc.setQueryData(['me'], me);
    },
    logout: async () => {
      await post('/auth/logout').catch(() => {});
      setCsrfToken(null);
      // No usar qc.clear(): dejaría al observador de la sesión apuntando a una consulta eliminada.
      qc.setQueryData(['me'], null);
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
    },
    can: (min) => hasRole(q.data?.workspace?.role, min),
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession fuera de SessionProvider'); // i18n-ignore (error de programación)
  return v;
}
