import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import type { AiEmployeeDetail, PermissionEntry, PermissionMode } from '../../../lib/types';
import { Badge, Button, Card, FormError } from '../../../components/ui/primitives';
import { useToast } from '../../../components/ui/Toast';
import { useCatalog } from './shared';

const MODE_LABEL: Record<PermissionMode, string> = { deny: 'Never', allow: 'Allowed', require_approval: 'Needs my approval' };

export function PermissionsTab({ e }: { e: AiEmployeeDetail }) {
  const { can } = useAuth();
  const canManage = can('ai_permissions:manage');
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useCatalog();
  const [perms, setPerms] = useState<Record<string, PermissionEntry>>(e.effectivePermissions);
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, PermissionEntry> = {};
      for (const a of catalog.data?.actions ?? []) if (a.key !== 'handoff_to_human' && perms[a.key]) body[a.key] = perms[a.key]!;
      return api(`/ai-employees/${e.id}`, { method: 'PATCH', body: { permissions: body } });
    },
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['ai-employee', e.id] }), qc.invalidateQueries({ queryKey: ['ai-employee-versions', e.id] })]); toast.success('Permissions saved and recorded in the audit log'); },
  });
  const upd = (k: string, patch: Partial<PermissionEntry>) => setPerms((p) => ({ ...p, [k]: { ...p[k]!, ...patch } }));

  return (
    <Card className="space-y-4 p-6">
      <p className="text-sm text-mist-500">What may this employee actually <em>do</em>? These limits are enforced by the platform itself, not just written in its instructions, so the AI cannot go beyond them even if a customer asks. {canManage ? '' : 'Only an owner or admin can change them.'}</p>
      <FormError error={save.error} />
      <div className="divide-y divide-mist-100 rounded-xl border border-mist-200">
        {(catalog.data?.actions ?? []).map((a) => {
          const p = perms[a.key] ?? { mode: a.defaultMode };
          const locked = a.key === 'handoff_to_human';
          const taskOk = a.tasks.length === 0 || a.tasks.some((t) => e.tasks.includes(t));
          return (
            <div key={a.key} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-56 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-mist-900">{a.label}{locked ? <Lock className="size-3.5 text-mist-400" /> : null}{!taskOk ? <Badge tone="amber">needs a matching task</Badge> : null}</p>
                <p className="text-[13px] text-mist-500">{a.description}</p>
              </div>
              {locked ? (
                <Badge tone="green">Always allowed</Badge>
              ) : (
                <>
                  <select aria-label={`${a.label} permission`} disabled={!canManage} value={p.mode} onChange={(x) => upd(a.key, { mode: x.target.value as PermissionMode })} className="h-10 rounded-xl border border-mist-300 bg-white px-3 text-sm disabled:bg-mist-50">
                    {(['deny', 'allow', 'require_approval'] as const).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                  </select>
                  {a.limit && p.mode !== 'deny' ? (
                    <label className="flex items-center gap-2 text-[13px] text-mist-600">
                      {a.limit === 'maxPercent' ? 'Up to' : 'Up to amount'}
                      <input type="number" min={0} max={a.limit === 'maxPercent' ? 100 : undefined} disabled={!canManage} value={p[a.limit] ?? (a.limit === 'maxPercent' ? 0 : '')} placeholder={a.limit === 'maxAmount' ? 'No limit' : undefined} onChange={(x) => upd(a.key, { [a.limit!]: x.target.value === '' ? undefined : Math.max(0, Number(x.target.value)) })} className="h-10 w-24 rounded-xl border border-mist-300 px-3 text-sm" aria-label={`${a.label} limit`} />
                      {a.limit === 'maxPercent' ? '%' : ''}
                    </label>
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[13px] text-mist-500">Checking live stock needs an inventory connection, which isn’t available yet: until then your employee will never state that something is in or out of stock.</p>
      {canManage ? <div className="flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate()}>Save permissions</Button></div> : null}
    </Card>
  );
}
