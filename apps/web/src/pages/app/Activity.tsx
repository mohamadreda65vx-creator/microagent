import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollText, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { AiUsage, ApprovalRow, AuditRow } from '../../lib/types';
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton } from '../../components/ui/primitives';
import { Tabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
type Tab = 'approvals' | 'audit' | 'usage';

export default function Activity() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('approvals');
  const tabs: Array<{ key: Tab; label: string }> = [{ key: 'approvals', label: 'Approvals' }, ...(can('audit:read') ? [{ key: 'audit' as const, label: 'Audit log' }, { key: 'usage' as const, label: 'AI usage' }] : [])];
  return (
    <div className="space-y-5">
      <div><h2 className="text-2xl font-semibold text-mist-900">Approvals & Audit</h2><p className="mt-1 text-[15px] text-mist-500">What your AI employees ask permission for, everything that changed, and what the AI costs.</p></div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'approvals' ? <Approvals /> : tab === 'audit' ? <Audit /> : <Usage />}
    </div>
  );
}

function Approvals() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('pending');
  const [mode, setMode] = useState('live');
  const q = useQuery({ queryKey: ['approvals', status, mode], queryFn: () => api<{ items: ApprovalRow[] }>(`/approvals?status=${status}&mode=${mode}`) });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' }) => api(`/approvals/${v.id}/decision`, { body: { decision: v.decision } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['approvals'] }); toast.success('Decision saved'); },
    onError: async (e) => { await qc.invalidateQueries({ queryKey: ['approvals'] }); toast.error(e.message); },
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 rounded-xl border border-mist-300 bg-white px-3 text-sm"><option value="pending">Waiting</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
        <select aria-label="Source" value={mode} onChange={(e) => setMode(e.target.value)} className="h-10 rounded-xl border border-mist-300 bg-white px-3 text-sm"><option value="live">Real customers</option><option value="simulation">Playground tests</option><option value="all">Both</option></select>
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? <div className="space-y-3 p-5">{[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}</div> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.items.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Nothing here" description="When an employee wants to do something that needs your approval, such as creating an order, it shows up here. Real customer conversations connect in a later phase; Playground tests are under “Playground tests”." />
        ) : (
          <ul className="divide-y divide-mist-100">
            {q.data.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-4 text-sm">
                <div className="min-w-60 flex-1">
                  <p className="font-medium text-mist-900">{a.employeeName} wants to: {a.type.replace(/_/g, ' ')} {a.mode === 'simulation' ? <Badge>test</Badge> : null}</p>
                  <code className="block max-w-full truncate text-[12px] text-mist-500">{JSON.stringify(a.params)}</code>
                  <p className="text-[12px] text-mist-400">{fmt(a.createdAt)}{a.decidedByName ? ` · ${a.approvalStatus} by ${a.decidedByName}` : ''}</p>
                </div>
                {a.approvalStatus === 'pending' && can('approvals:decide') ? (<><Button size="sm" loading={decide.isPending && decide.variables?.id === a.id} onClick={() => decide.mutate({ id: a.id, decision: 'approved' })}>Approve</Button><Button size="sm" variant="danger" onClick={() => decide.mutate({ id: a.id, decision: 'rejected' })}>Reject</Button></>) : <Badge tone={a.approvalStatus === 'approved' ? 'green' : a.approvalStatus === 'rejected' ? 'red' : 'amber'}>{a.approvalStatus}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const q = useQuery({ queryKey: ['audit', action], queryFn: () => api<{ items: AuditRow[] }>(`/audit-logs?limit=100${action ? `&action=${action}` : ''}`) });
  return (
    <div className="space-y-4">
      <select aria-label="Filter" value={action} onChange={(e) => setAction(e.target.value)} className="h-10 rounded-xl border border-mist-300 bg-white px-3 text-sm"><option value="">Everything</option><option value="ai_employee">Employee changes</option><option value="ai_employee.permissions_changed">Permission changes</option><option value="teach_rule">Teach & Correct rules</option><option value="agent_action">Blocked or waiting actions</option><option value="knowledge">Knowledge</option><option value="approval">Approvals</option></select>
      <Card className="overflow-hidden">
        {q.isPending ? <Skeleton className="m-5 h-24" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.items.length === 0 ? <EmptyState icon={ScrollText} title="No entries" description="Changes will be recorded here." /> : (
          <ul className="divide-y divide-mist-100">
            {q.data.items.map((l) => (
              <li key={l.id} className="px-5 py-3 text-sm"><p className="font-medium text-mist-900">{l.action}</p><p className="truncate text-[12px] text-mist-500">{l.actorName ?? 'System'} · {fmt(l.createdAt)}{Object.keys(l.meta).length ? ` · ${JSON.stringify(l.meta).slice(0, 160)}` : ''}</p></li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Usage() {
  const q = useQuery({ queryKey: ['ai-usage'], queryFn: () => api<AiUsage>('/ai/usage') });
  if (q.isPending) return <Skeleton className="h-40 rounded-2xl" />;
  if (q.isError) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const u = q.data;
  const pct = u.limit > 0 ? Math.min(100, Math.round((Number(u.month.tokens) / u.limit) * 100)) : 100;
  return (
    <div className="space-y-4">
      {!u.configured ? <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">The AI provider is not configured on this server (no OpenRouter key). Features that need AI will say so instead of guessing.</div> : null}
      <Card className="space-y-3 p-5">
        <p className="text-sm text-mist-500">Tokens this month</p>
        <p className="font-display text-3xl font-semibold text-mist-900 tabular-nums">{Number(u.month.tokens).toLocaleString()} <span className="text-base font-normal text-mist-500">/ {u.limit.toLocaleString()}</span></p>
        <div className="h-2 overflow-hidden rounded-full bg-mist-100"><div className={`h-full ${pct > 90 ? 'bg-red-500' : 'bg-burgundy-600'}`} style={{ width: `${pct}%` }} /></div>
        <p className="text-[13px] text-mist-500">{u.month.calls} calls · {u.month.errors} failed · cost ${Number(u.month.cost).toFixed(4)}{u.month.callsWithoutCost ? ` (the provider did not report a cost for ${u.month.callsWithoutCost} call${u.month.callsWithoutCost > 1 ? 's' : ''}, so the real total may be higher)` : ''}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {([['By purpose', u.byPurpose.map((r) => [r.purpose, r]) as Array<[string, { tokens: number; calls: number }]>], ['By model', u.byModel.map((r) => [r.model, r]) as Array<[string, { tokens: number; calls: number }]>]] as const).map(([title, rows]) => (
          <Card key={title} className="p-5"><p className="mb-3 text-sm font-medium text-mist-800">{title}</p>{rows.length === 0 ? <p className="text-sm text-mist-400">No usage yet.</p> : rows.map(([k, r]) => <p key={k} className="flex justify-between border-t border-mist-100 py-2 text-sm first:border-0"><span>{k}</span><span className="tabular-nums text-mist-600">{Number(r.tokens).toLocaleString()} tokens · {r.calls} calls</span></p>)}</Card>
        ))}
      </div>
    </div>
  );
}
