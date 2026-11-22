import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Badge, Button, Card, ErrorState, Skeleton } from '../../../components/ui/primitives';
import { useToast } from '../../../components/ui/Toast';
import { fmtDate } from './shared';

export function HistoryTab({ id, current }: { id: string; current: number }) {
  const { can } = useAuth();
  const canRollback = can('ai_permissions:manage');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ai-employee-versions', id], queryFn: () => api<{ items: Array<{ version: number; summary: string; createdAt: string; changedBy: string | null }> }>(`/ai-employees/${id}/versions`) });
  const rb = useMutation({
    mutationFn: (version: number) => api(`/ai-employees/${id}/rollback`, { body: { version } }),
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['ai-employee', id] }), qc.invalidateQueries({ queryKey: ['ai-employee-versions', id] })]); toast.success('Rolled back. Run the tests again before going live.'); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Card className="overflow-hidden">
      {q.isPending ? <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <ul className="divide-y divide-mist-100">
          {q.data.items.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-3 px-5 py-4 text-sm">
              <div className="min-w-48 flex-1"><p className="font-medium text-mist-900">Version {v.version} · {v.summary}</p><p className="text-[12px] text-mist-500">{fmtDate(v.createdAt)}{v.changedBy ? ` · ${v.changedBy}` : ''}</p></div>
              {v.version === current ? <Badge tone="green">Current</Badge> : canRollback ? <Button size="sm" variant="secondary" loading={rb.isPending && rb.variables === v.version} onClick={() => rb.mutate(v.version)}>Roll back to this version</Button> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
