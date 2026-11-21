import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Building2, Search, UserCheck, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import type { PlatformSummary, PlatformTenant } from '../../lib/types';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, Skeleton } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';

function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string | number; sub?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-burgundy-50 text-burgundy-700">{icon}</div>
        <p className="text-sm font-medium text-mist-500">{label}</p>
      </div>
      <p className="mt-4 font-display text-3xl font-semibold text-mist-900 tabular-nums">{value}</p>
      {sub ? <p className="mt-1 text-[13px] text-mist-500">{sub}</p> : null}
    </Card>
  );
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

export default function Companies() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'suspended'>('');
  const [confirm, setConfirm] = useState<PlatformTenant | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const summary = useQuery({ queryKey: ['platform', 'summary'], queryFn: () => api<PlatformSummary>('/platform/summary') });
  const list = useQuery({
    queryKey: ['platform', 'tenants', debounced, status],
    placeholderData: keepPreviousData,
    queryFn: () => api<{ items: PlatformTenant[]; total: number }>(`/platform/tenants?${new URLSearchParams({ ...(debounced ? { search: debounced } : {}), ...(status ? { status } : {}) })}`),
  });

  const toggle = useMutation({
    mutationFn: (t: PlatformTenant) => api(`/platform/tenants/${t.id}`, { method: 'PATCH', body: { status: t.status === 'active' ? 'suspended' : 'active' } }),
    onSuccess: async (_d, t) => {
      await qc.invalidateQueries({ queryKey: ['platform'] });
      toast.success(`${t.name} was ${t.status === 'active' ? 'suspended' : 'activated'}`);
      setConfirm(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const s = summary.data;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-mist-900">Companies</h2>
        <p className="mt-1 text-[15px] text-mist-500">Every business on the platform.</p>
      </div>

      {summary.isError ? (
        <Card><ErrorState error={summary.error} onRetry={() => summary.refetch()} /></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {!s ? (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-2xl" />)
          ) : (
            <>
              <Stat icon={<Building2 className="size-5" />} label="Companies" value={s.companies} sub={`${s.activeCompanies} active · ${s.suspendedCompanies} suspended`} />
              <Stat icon={<UserCheck className="size-5" />} label="Customers (users)" value={s.users} sub={`${s.newCompanies30d} new companies in 30 days`} />
              <Stat icon={<Users className="size-5" />} label="AI employees" value={s.aiEmployees} />
              <Stat icon={<Activity className="size-5" />} label="API requests this month" value={s.apiRequestsMonth.toLocaleString()} />
            </>
          )}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-mist-200 p-4">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search companies…"
              aria-label="Search companies"
              className="h-10 w-full rounded-xl border border-mist-300 bg-white pr-3 pl-9 text-sm focus:border-burgundy-500 focus:ring-4 focus:ring-burgundy-100 focus:outline-none"
            />
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status" className="h-10 rounded-xl border border-mist-300 bg-white px-3 text-sm focus:border-burgundy-500 focus:ring-4 focus:ring-burgundy-100 focus:outline-none">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>

        {list.isPending ? (
          <div className="space-y-3 p-5" aria-busy="true">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={Building2} title={debounced || status ? 'No companies match' : 'No companies yet'} description={debounced || status ? 'Try a different search or filter.' : 'Companies appear here when businesses sign up.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-mist-50 text-xs tracking-wide text-mist-500 uppercase">
                <tr>
                  <th className="px-5 py-3 font-medium">Company</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 text-right font-medium">Users</th>
                  <th className="px-3 py-3 text-right font-medium">AI employees</th>
                  <th className="px-3 py-3 text-right font-medium">Requests (month)</th>
                  <th className="px-3 py-3 font-medium">Created</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-mist-100">
                {list.data.items.map((t) => (
                  <tr key={t.id} className="hover:bg-mist-50/60">
                    <td className="px-5 py-3.5">
                      <p className="font-medium text-mist-900">{t.name}</p>
                      <p className="text-xs text-mist-500">{t.slug}</p>
                    </td>
                    <td className="px-3"><Badge tone={t.status === 'active' ? 'green' : 'red'}>{t.status}</Badge></td>
                    <td className="px-3 text-right tabular-nums">{t.usersCount}</td>
                    <td className="px-3 text-right tabular-nums">{t.aiEmployeesCount}</td>
                    <td className="px-3 text-right tabular-nums">{t.apiRequestsMonth.toLocaleString()}</td>
                    <td className="px-3 text-mist-500">{fmt(t.createdAt)}</td>
                    <td className="px-5 text-right">
                      <Button size="sm" variant={t.status === 'active' ? 'danger' : 'secondary'} onClick={() => setConfirm(t)}>
                        {t.status === 'active' ? 'Suspend' : 'Activate'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.status === 'active' ? `Suspend ${confirm?.name}?` : `Activate ${confirm?.name}?`}
        description={confirm?.status === 'active' ? 'Everyone in this company is signed out and can’t log in until you activate it again.' : 'Their team will be able to log in again.'}
      >
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant={confirm?.status === 'active' ? 'danger' : 'primary'} loading={toggle.isPending} onClick={() => confirm && toggle.mutate(confirm)}>
            {confirm?.status === 'active' ? 'Suspend company' : 'Activate company'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
