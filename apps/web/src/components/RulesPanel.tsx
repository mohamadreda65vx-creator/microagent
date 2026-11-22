import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GraduationCap, History, ShieldCheck, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AiEmployee, Proposal, TeachRule } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorState, FormError, Modal, SelectField, Skeleton, TextAreaField } from './ui/primitives';
import { useToast } from './ui/Toast';

const CAT_LABEL = { knowledge_update: 'Knowledge update', behavior_update: 'Behavior update', workflow_update: 'Workflow update' } as const;
const CAT_TONE = { knowledge_update: 'burgundy', behavior_update: 'gray', workflow_update: 'amber' } as const;
const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function RulesPanel({ employeeId }: { employeeId?: string }) {
  const { can } = useAuth();
  const canWrite = can('rules:write');
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [scope, setScope] = useState<string>(employeeId ?? '');
  const [preview, setPreview] = useState<{ proposals: Proposal[]; refused: { message: string } | null } | null>(null);
  const [history, setHistory] = useState<TeachRule | null>(null);

  const employees = useQuery({ queryKey: ['ai-employees'], queryFn: () => api<{ items: AiEmployee[] }>('/ai-employees'), enabled: !employeeId });
  const rules = useQuery({ queryKey: ['teach-rules', employeeId ?? 'all'], queryFn: () => api<{ items: TeachRule[] }>(`/teach/rules${employeeId ? `?employeeId=${employeeId}` : ''}`) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['teach-rules'] }), qc.invalidateQueries({ queryKey: ['knowledge'] }), qc.invalidateQueries({ queryKey: ['ai-employee'] })]);

  const doPreview = useMutation({
    mutationFn: () => api<{ proposals: Proposal[]; refused: { message: string } | null }>('/teach/preview', { body: { instruction: text.trim(), employeeId: scope || null } }),
    onSuccess: setPreview,
  });
  const doSave = useMutation({
    mutationFn: () => api('/teach/rules', { body: { instruction: text.trim(), employeeId: scope || null, effects: preview!.proposals.filter((p) => !p.duplicateOf).map((p) => p.effect) } }),
    onSuccess: async () => { await refresh(); toast.success('Saved. Your employee will follow this from the next message.'); setText(''); setPreview(null); },
  });
  const toggle = useMutation({
    mutationFn: (r: TeachRule) => api(`/teach/rules/${r.id}`, { method: 'PATCH', body: { status: r.status === 'active' ? 'disabled' : 'active' } }),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      {canWrite ? (
        <Card className="space-y-4 p-6">
          <div className="flex items-center gap-2 text-mist-900"><GraduationCap className="size-5 text-burgundy-700" /><h3 className="font-display text-lg font-semibold">Teach your AI employee</h3></div>
          <p className="text-sm text-mist-500">Write it the way you would tell a new colleague, in Arabic or English. For example: “No discounts”, “Check the inventory before replying”, “Collect the phone number before any order”, “Use the Egyptian dialect”, “Hand angry customers to a human”, “The cappuccino costs 60 EGP”.</p>
          <FormError error={doPreview.error ?? doSave.error} />
          <TextAreaField label="Instruction" value={text} maxLength={1000} onChange={(e) => { setText(e.target.value); setPreview(null); }} placeholder="e.g. اجمع رقم التليفون قبل أي أوردر" />
          {!employeeId ? (
            <SelectField label="Applies to" value={scope} onChange={(e) => { setScope(e.target.value); setPreview(null); }}>
              <option value="">All employees of my company</option>
              {employees.data?.items.map((e) => <option key={e.id} value={e.id}>Only {e.name}</option>)}
            </SelectField>
          ) : null}
          <div className="flex justify-end"><Button icon={Sparkles} loading={doPreview.isPending} disabled={text.trim().length < 3} onClick={() => doPreview.mutate()}>Review what will change</Button></div>

          {preview ? (
            <div className="space-y-3 rounded-xl border border-burgundy-100 bg-burgundy-50/40 p-4" data-testid="teach-preview">
              {preview.refused ? <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{preview.refused.message}</div> : null}
              {preview.proposals.map((p, i) => (
                <div key={i} className="space-y-1.5 rounded-lg bg-white p-3 text-sm shadow-soft">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={CAT_TONE[p.category]}>{CAT_LABEL[p.category]}</Badge>
                    {p.enforced ? <Badge tone="green"><ShieldCheck className="size-3" /> Enforced by the platform</Badge> : <Badge tone="amber">Guidance only: not enforced</Badge>}
                  </div>
                  <p className="text-mist-800">{p.summary}</p>
                  {p.duplicateOf ? <p className="text-[13px] text-amber-800">You already have this rule, so it won’t be added again.</p> : null}
                  {p.replaces ? <p className="text-[13px] text-mist-500">This replaces your current rule: “{p.replaces.instruction}” (it stays in the history).</p> : null}
                </div>
              ))}
              {preview.proposals.length ? <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setPreview(null)}>Cancel</Button><Button loading={doSave.isPending} disabled={preview.proposals.every((p) => p.duplicateOf)} onClick={() => doSave.mutate()}>Confirm and save</Button></div> : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <div className="border-b border-mist-200 px-5 py-4"><h3 className="font-display text-base font-semibold text-mist-900">Rules in effect</h3></div>
        {rules.isPending ? <div className="space-y-3 p-5">{[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}</div>
          : rules.isError ? <ErrorState error={rules.error} onRetry={() => rules.refetch()} />
          : rules.data.items.length === 0 ? <EmptyState icon={GraduationCap} title="No rules yet" description="Teach your employee above. Every rule can be switched off or rolled back." />
          : (
            <ul className="divide-y divide-mist-100">
              {rules.data.items.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <div className="min-w-60 flex-1">
                    <p className={`text-sm font-medium ${r.status === 'active' ? 'text-mist-900' : 'text-mist-400 line-through'}`}>{r.instruction}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-mist-500">
                      <Badge tone={CAT_TONE[r.category]}>{CAT_LABEL[r.category]}</Badge>
                      {r.enforced ? <Badge tone="green">Enforced</Badge> : <Badge tone="amber">Guidance only</Badge>}
                      <span>{r.employeeName ? `Only ${r.employeeName}` : 'All employees'}</span><span>· v{r.version}</span>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" icon={History} onClick={() => setHistory(r)}>History</Button>
                  {canWrite ? <Button size="sm" variant="secondary" loading={toggle.isPending && toggle.variables?.id === r.id} onClick={() => toggle.mutate(r)}>{r.status === 'active' ? 'Turn off' : 'Turn on'}</Button> : null}
                </li>
              ))}
            </ul>
          )}
      </Card>
      <RuleHistory rule={history} onClose={() => setHistory(null)} canWrite={canWrite} onChanged={refresh} />
    </div>
  );
}

function RuleHistory({ rule, onClose, canWrite, onChanged }: { rule: TeachRule | null; onClose: () => void; canWrite: boolean; onChanged: () => Promise<unknown> }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['teach-rule-versions', rule?.id], enabled: !!rule, queryFn: () => api<{ items: Array<{ version: number; instruction: string; status: string; summary: string; createdAt: string; changedBy: string | null }> }>(`/teach/rules/${rule!.id}/versions`) });
  const rb = useMutation({
    mutationFn: (version: number) => api(`/teach/rules/${rule!.id}/rollback`, { body: { version } }),
    onSuccess: async () => { await onChanged(); toast.success('Rolled back'); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Modal open={rule !== null} onClose={onClose} title="Rule history" description="Going back creates a new version. Nothing is ever deleted.">
      {q.isPending ? <Skeleton className="h-24" /> : q.isError ? <ErrorState error={q.error} /> : (
        <ul className="max-h-80 divide-y divide-mist-100 overflow-y-auto">
          {q.data.items.map((v, i) => (
            <li key={v.version} className="flex items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1"><p className="font-medium text-mist-900">v{v.version} · {v.summary || 'Changed'}</p><p className="truncate text-[12px] text-mist-500">{v.instruction} · {v.status} · {fmt(v.createdAt)}{v.changedBy ? ` · ${v.changedBy}` : ''}</p></div>
              {canWrite && i > 0 ? <Button size="sm" variant="secondary" loading={rb.isPending} onClick={() => rb.mutate(v.version)}>Go back to this</Button> : <Badge tone="green">{i === 0 ? 'Current' : ''}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
