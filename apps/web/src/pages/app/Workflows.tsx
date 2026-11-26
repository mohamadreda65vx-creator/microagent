import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, ListChecks, Plus, Workflow as WfIcon } from 'lucide-react';
import { Suspense, lazy, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, FormError, Modal, Skeleton, TextAreaField, TextField } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { WfSummary, WfTask } from '../../lib/types';
const Builder = lazy(() => import('./workflows/Builder'));

const tone = (s: string) => (s === 'active' ? 'green' : s === 'paused' ? 'amber' : 'gray') as 'green' | 'amber' | 'gray';

function List() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const q = useQuery({ queryKey: ['workflows'], queryFn: () => api<{ items: WfSummary[] }>('/workflows') });
  const create = useMutation({ mutationFn: () => api<{ id: string }>('/workflows', { body: { name: name.trim(), description: desc.trim() } }), onSuccess: async (w) => { await qc.invalidateQueries({ queryKey: ['workflows'] }); nav(`/app/workflows/${w.id}`); } });
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = q.data!.items;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">{can('workflows:manage') ? <Button icon={Plus} onClick={() => setOpen(true)}>New workflow</Button> : null}</div>
      {items.length === 0 ? <EmptyState icon={WfIcon} title="No workflows yet" description="A workflow is a set of steps that runs by itself when something happens, like a new customer message." action={can('workflows:manage') ? <Button icon={Plus} onClick={() => setOpen(true)}>Create the first one</Button> : undefined} /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((w) => (
            <Link key={w.id} to={`/app/workflows/${w.id}`}>
              <Card className="h-full p-4 transition hover:border-burgundy-300">
                <div className="flex items-center justify-between gap-2"><p className="truncate font-semibold text-mist-900">{w.name}</p><Badge tone={tone(w.status)}>{w.status}</Badge></div>
                <p className="mt-1 line-clamp-2 min-h-10 text-sm text-mist-600">{w.description || 'No description'}</p>
                <p className="mt-3 text-xs text-mist-500">v{w.latestVersion} · {w.liveRuns} live runs{w.failedRuns ? ` · ${w.failedRuns} failed` : ''}{w.lastRunAt ? ` · last ${new Date(w.lastRunAt).toLocaleDateString()}` : ''}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="New workflow">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          <TextAreaField label="What is it for? (optional)" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
          <FormError error={create.error} />
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>Create</Button>
        </form>
      </Modal>
    </div>
  );
}

function Tasks() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [note, setNote] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['wf-tasks'], queryFn: () => api<{ items: WfTask[] }>('/workflow-tasks?status=open'), refetchInterval: 15000 });
  const done = useMutation({
    mutationFn: (v: { id: string; outcome: 'approved' | 'rejected' }) => api(`/workflow-tasks/${v.id}/complete`, { body: { outcome: v.outcome, note: note[v.id]?.trim() || undefined } }),
    onSuccess: async () => { toast.success('Answer sent. The workflow continues.'); await qc.invalidateQueries({ queryKey: ['wf-tasks'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });
  if (q.isLoading) return <Skeleton className="h-32" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data!.items.length) return <EmptyState icon={CheckCheck} title="Nothing waiting for you" description="When a workflow needs a person's approval, the task appears here." />;
  return (
    <div className="space-y-3">
      {q.data!.items.map((t) => (
        <Card key={t.id} className="space-y-2 p-4">
          <div className="flex items-center justify-between gap-2"><p className="font-semibold text-mist-900">{t.title}</p><Badge tone="amber">for {t.assigneeRole}+</Badge></div>
          <p className="text-xs text-mist-500">From “{t.workflowName}” · {new Date(t.createdAt).toLocaleString()}{t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleString()}` : ''}</p>
          {t.instructions ? <p className="text-sm text-mist-700">{t.instructions}</p> : null}
          {can('workflows:tasks') ? (
            <>
              <TextField label="Note (optional)" value={note[t.id] ?? ''} onChange={(e) => setNote({ ...note, [t.id]: e.target.value })} />
              <div className="flex gap-2"><Button size="sm" loading={done.isPending} onClick={() => done.mutate({ id: t.id, outcome: 'approved' })}>Approve</Button><Button size="sm" variant="secondary" loading={done.isPending} onClick={() => done.mutate({ id: t.id, outcome: 'rejected' })}>Reject</Button></div>
            </>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

function Home({ tab }: { tab: 'list' | 'tasks' }) {
  const tabs = [{ to: '/app/workflows', label: 'Workflows', end: true }, { to: '/app/workflows/tasks', label: 'People tasks', end: false }];
  return (
    <div className="space-y-4">
      <nav className="flex gap-1 border-b border-mist-200" aria-label="Workflow sections">
        {tabs.map((t) => <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${isActive ? 'border-burgundy-600 text-burgundy-700' : 'border-transparent text-mist-600'}`}>{t.label === 'People tasks' ? <ListChecks className="size-4" /> : null}{t.label}</NavLink>)}
      </nav>
      {tab === 'tasks' ? <Tasks /> : <List />}
    </div>
  );
}

export default function Workflows() {
  return (
    <Routes>
      <Route path="tasks" element={<Home tab="tasks" />} />
      <Route path=":id" element={<Suspense fallback={<Skeleton className="m-6 h-96" />}><Builder /></Suspense>} />
      <Route path="*" element={<Home tab="list" />} />
    </Routes>
  );
}
