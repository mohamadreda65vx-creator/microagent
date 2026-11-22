import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import type { AiEmployeeDetail } from '../../../lib/types';
import { Button, Card, FormError } from '../../../components/ui/primitives';
import { useToast } from '../../../components/ui/Toast';
import { useCatalog } from './shared';

export function TasksTab({ e }: { e: AiEmployeeDetail }) {
  const { can } = useAuth();
  const canWrite = can('ai_employees:write');
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useCatalog();
  const [tasks, setTasks] = useState<string[]>(e.tasks);
  const save = useMutation({
    mutationFn: () => api(`/ai-employees/${e.id}`, { method: 'PATCH', body: { tasks } }),
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['ai-employee', e.id] }), qc.invalidateQueries({ queryKey: ['ai-employees'] })]); toast.success('Tasks saved'); },
  });
  return (
    <Card className="space-y-4 p-6">
      <p className="text-sm text-mist-500">Pick every job this employee is hired for. Tasks also decide which actions it may ever use (for example, only employees with the Booking task can create bookings).</p>
      <FormError error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {(catalog.data?.tasks ?? []).map((t) => {
          const on = tasks.includes(t.key);
          return (
            <label key={t.key} className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${on ? 'border-burgundy-300 bg-burgundy-50/60' : 'border-mist-200'}`}>
              <input type="checkbox" disabled={!canWrite} checked={on} onChange={() => setTasks(on ? tasks.filter((x) => x !== t.key) : [...tasks, t.key])} className="mt-1 accent-burgundy-700" />
              <span>
                <span className="block text-sm font-medium text-mist-900">{t.label}</span>
                <span className="block text-[13px] text-mist-500">{t.description}</span>
              </span>
            </label>
          );
        })}
      </div>
      {canWrite ? <div className="flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate()}>Save tasks</Button></div> : null}
    </Card>
  );
}
