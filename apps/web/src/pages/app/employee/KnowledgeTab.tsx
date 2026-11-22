import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import type { AiEmployeeDetail, KnowledgeSource } from '../../../lib/types';
import { Button, Card, FormError } from '../../../components/ui/primitives';
import { useToast } from '../../../components/ui/Toast';

export function KnowledgeTab({ e }: { e: AiEmployeeDetail }) {
  const { can } = useAuth();
  const canWrite = can('ai_employees:write');
  const qc = useQueryClient();
  const toast = useToast();
  const sources = useQuery({ queryKey: ['knowledge', 'sources'], queryFn: () => api<{ items: KnowledgeSource[] }>('/knowledge/sources'), enabled: can('knowledge:read') });
  const [mode, setMode] = useState(e.knowledgeMode);
  const [ids, setIds] = useState<string[]>(e.sourceIds);
  const save = useMutation({
    mutationFn: async () => {
      await api(`/ai-employees/${e.id}`, { method: 'PATCH', body: { knowledgeMode: mode } });
      if (mode === 'selected') await api(`/ai-employees/${e.id}/sources`, { method: 'PUT', body: { sourceIds: ids } });
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['ai-employee', e.id] }); toast.success('Knowledge access saved'); },
  });
  return (
    <Card className="space-y-4 p-6">
      <p className="text-sm text-mist-500">Your employee only answers from knowledge you have <strong>confirmed</strong>. Choose which of your company’s sources it may use. It can never see another company’s data.</p>
      <FormError error={save.error} />
      <div className="space-y-2">
        {([['all', 'Everything confirmed in my business knowledge'], ['selected', 'Only the sources I pick (plus facts I typed or taught)']] as const).map(([v, label]) => (
          <label key={v} className="flex cursor-pointer items-center gap-3 rounded-xl border border-mist-200 p-3 text-sm"><input type="radio" disabled={!canWrite} checked={mode === v} onChange={() => setMode(v)} className="accent-burgundy-700" />{label}</label>
        ))}
      </div>
      {mode === 'selected' ? (
        <div className="space-y-2 rounded-xl bg-mist-50 p-4">
          {sources.data?.items.length ? sources.data.items.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-3 text-sm"><input type="checkbox" disabled={!canWrite} checked={ids.includes(s.id)} onChange={() => setIds(ids.includes(s.id) ? ids.filter((x) => x !== s.id) : [...ids, s.id])} className="accent-burgundy-700" />{s.name} <span className="text-[12px] text-mist-500">({s.itemCount} facts)</span></label>
          )) : <p className="text-sm text-mist-500">No sources yet. <Link className="font-medium text-burgundy-700 hover:underline" to="/app/knowledge">Add your first source</Link>.</p>}
        </div>
      ) : null}
      {canWrite ? <div className="flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></div> : null}
    </Card>
  );
}
