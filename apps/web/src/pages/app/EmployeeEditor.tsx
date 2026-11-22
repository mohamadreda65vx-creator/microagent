import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { AiEmployeeDetail } from '../../lib/types';
import { RulesPanel } from '../../components/RulesPanel';
import { Badge, Button, Card, ErrorState, FormError, Skeleton } from '../../components/ui/primitives';
import { Tabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { HistoryTab } from './employee/HistoryTab';
import { KnowledgeTab } from './employee/KnowledgeTab';
import { PermissionsTab } from './employee/PermissionsTab';
import { PlaygroundTab } from './employee/PlaygroundTab';
import { ProfileTab } from './employee/ProfileTab';
import { Avatar, statusTone } from './employee/shared';
import { TasksTab } from './employee/TasksTab';

type Tab = 'profile' | 'tasks' | 'permissions' | 'knowledge' | 'rules' | 'playground' | 'history';

export default function EmployeeEditor() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('profile');
  const q = useQuery({ queryKey: ['ai-employee', id], queryFn: () => api<AiEmployeeDetail>(`/ai-employees/${id}`) });
  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'paused') => api(`/ai-employees/${id}/status`, { body: { status } }),
    onSuccess: async (_d, status) => { await Promise.all([qc.invalidateQueries({ queryKey: ['ai-employee', id] }), qc.invalidateQueries({ queryKey: ['ai-employees'] }), qc.invalidateQueries({ queryKey: ['overview'] })]); toast.success(status === 'active' ? 'Your employee is now active' : 'Paused'); },
  });

  if (q.isPending) return <div className="space-y-4"><Skeleton className="h-20" /><Skeleton className="h-96" /></div>;
  if (q.isError) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const e = q.data;
  const blocking = e.readiness.checks.filter((c) => c.blocking && !c.ok);
  // Remount tabs when the saved version changes so their local form state always starts from the server's truth.
  const key = `${e.version}-${e.readiness.fingerprint}`;

  return (
    <div className="space-y-5">
      <Link to="/app/ai-employees" className="inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-mist-800"><ArrowLeft className="size-4" /> All AI employees</Link>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar avatar={e.avatar} name={e.name} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-2xl font-semibold text-mist-900">{e.name}</h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-mist-500">{e.jobTitle || 'No role yet'} <Badge tone={statusTone[e.status]}>{e.status}</Badge> <span>v{e.version}</span></p>
        </div>
        {can('ai_employees:write') ? (
          e.status === 'active'
            ? <Button variant="secondary" icon={Pause} loading={setStatus.isPending} onClick={() => setStatus.mutate('paused')}>Pause</Button>
            : <Button icon={Play} loading={setStatus.isPending} disabled={!can('ai_permissions:manage') || blocking.length > 0} onClick={() => setStatus.mutate('active')} title={blocking[0]?.message}>Activate</Button>
        ) : null}
      </div>
      <FormError error={setStatus.error} />
      {e.status !== 'active' && blocking.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
          <p className="font-medium">Not ready to go live yet</p>
          <ul className="mt-1 list-disc pl-5">{blocking.map((c) => <li key={c.key}>{c.message}</li>)}</ul>
        </div>
      ) : null}
      {e.status === 'active' && !e.readiness.ready ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">A rule or knowledge changed since the last test. It keeps working within its limits, but run the tests again to confirm the new behaviour.</div> : null}

      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { key: 'profile', label: 'Profile' }, { key: 'tasks', label: 'Tasks', badge: e.tasks.length }, { key: 'permissions', label: 'Permissions' },
        { key: 'knowledge', label: 'Knowledge' }, { key: 'rules', label: 'Rules' }, { key: 'playground', label: 'Test & Playground' }, { key: 'history', label: 'History' },
      ]} />
      {tab === 'profile' ? <ProfileTab key={key} e={e} /> : null}
      {tab === 'tasks' ? <TasksTab key={key} e={e} /> : null}
      {tab === 'permissions' ? <PermissionsTab key={key} e={e} /> : null}
      {tab === 'knowledge' ? <KnowledgeTab key={key} e={e} /> : null}
      {tab === 'rules' ? <RulesPanel employeeId={e.id} /> : null}
      {tab === 'playground' ? <PlaygroundTab e={e} /> : null}
      {tab === 'history' ? <HistoryTab id={e.id} current={e.version} /> : null}
    </div>
  );
}
