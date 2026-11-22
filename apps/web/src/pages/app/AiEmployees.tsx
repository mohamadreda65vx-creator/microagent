import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, statusTone as tone } from './employee/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { AiEmployee } from '../../lib/types';
import { Badge, Button, Card, EmptyState, ErrorState, FormError, Modal, Skeleton, TextAreaField, TextField } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';


function NewEmployeeForm({ onCancel }: { onCancel: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', jobTitle: '', description: '' });
  const m = useMutation({
    mutationFn: () => api<AiEmployee>('/ai-employees', { body: { ...f, name: f.name.trim() } }),
    onSuccess: async (e) => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['ai-employees'] }), qc.invalidateQueries({ queryKey: ['overview'] })]);
      toast.success('Created. Next: choose its tasks and test it.');
      nav(`/app/ai-employees/${e.id}`);
    },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      <FormError error={m.error} />
      <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} required autoFocus placeholder="e.g. Layla" />
      <TextField label="Role" value={f.jobTitle} onChange={(e) => setF({ ...f, jobTitle: e.target.value })} maxLength={120} placeholder="e.g. Customer support agent" />
      <TextAreaField label="What should this employee do?" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={1000} placeholder="Describe the role in a few sentences." />
      <p className="text-[13px] text-mist-500">It starts as a draft. You will set its tasks and permissions, then test it before it can go live.</p>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={m.isPending} disabled={!f.name.trim()}>Create and set up</Button>
      </div>
    </form>
  );
}

export default function AiEmployees() {
  const { can } = useAuth();
  const canWrite = can('ai_employees:write');
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  const [deleting, setDeleting] = useState<AiEmployee | null>(null);

  const q = useQuery({ queryKey: ['ai-employees'], queryFn: () => api<{ items: AiEmployee[] }>('/ai-employees') });
  const del = useMutation({
    mutationFn: (id: string) => api(`/ai-employees/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['ai-employees'] }), qc.invalidateQueries({ queryKey: ['overview'] })]);
      toast.success('AI employee deleted');
      setDeleting(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const newBtn = canWrite ? <Button icon={Plus} onClick={() => setCreating(true)}>New AI employee</Button> : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-mist-900">AI Employees</h2>
          <p className="mt-1 text-[15px] text-mist-500">The AI team that works for your business.</p>
        </div>
        {q.data?.items.length ? newBtn : null}
      </div>

      {q.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
        </div>
      ) : q.isError ? (
        <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>
      ) : q.data.items.length === 0 ? (
        <Card>
          <EmptyState icon={Bot} title="No AI employees yet" description={canWrite ? 'Create your first AI employee: give it a name and a job, and you’re set.' : 'Your team hasn’t created any AI employees yet.'} action={newBtn} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {q.data.items.map((e) => (
            <Card key={e.id} className="flex flex-col p-5">
              <div className="flex items-start gap-3">
                <Avatar avatar={e.avatar} name={e.name} />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-display text-base font-semibold text-mist-900">{e.name}</h3>
                  <p className="truncate text-[13px] text-mist-500">{e.jobTitle || 'No job title'}</p>
                </div>
                <Badge tone={tone[e.status]}>{e.status}</Badge>
              </div>
              <p className="mt-4 line-clamp-3 flex-1 text-sm text-mist-600">{e.description || 'No description yet.'}</p>
              <p className="mt-2 text-[12px] text-mist-500">{e.tasks.length ? `${e.tasks.length} task${e.tasks.length > 1 ? 's' : ''}` : 'No tasks yet'}{e.testedAt ? ' · tested' : ''}</p>
              {canWrite ? (
                <div className="mt-4 flex gap-2 border-t border-mist-100 pt-4">
                  <Button size="sm" variant="secondary" icon={Pencil} onClick={() => nav(`/app/ai-employees/${e.id}`)}>Open</Button>
                  <Button size="sm" variant="danger" icon={Trash2} onClick={() => setDeleting(e)}>Delete</Button>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New AI employee">
        {creating ? <NewEmployeeForm onCancel={() => setCreating(false)} /> : null}
      </Modal>
      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="Delete AI employee?" description={deleting ? `“${deleting.name}” will be permanently removed. This can’t be undone.` : undefined}>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" loading={del.isPending} onClick={() => deleting && del.mutate(deleting.id)}>Delete</Button>
        </div>
      </Modal>
    </div>
  );
}
