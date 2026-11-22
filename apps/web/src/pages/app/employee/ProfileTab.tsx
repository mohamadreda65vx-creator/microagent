import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import type { AiEmployeeDetail } from '../../../lib/types';
import { Button, Card, FormError, SelectField, TextAreaField, TextField } from '../../../components/ui/primitives';
import { useToast } from '../../../components/ui/Toast';
import { Avatar, AVATARS, useCatalog } from './shared';

const DIALECT_LABEL: Record<string, string> = { none: 'No specific dialect', egyptian: 'Egyptian Arabic', gulf: 'Gulf Arabic', levantine: 'Levantine Arabic', maghrebi: 'Maghrebi Arabic', msa: 'Modern Standard Arabic' };
const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', website_chat: 'Website chat' };

export function ProfileTab({ e }: { e: AiEmployeeDetail }) {
  const { can } = useAuth();
  const canWrite = can('ai_employees:write');
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useCatalog();
  const models = useQuery({ queryKey: ['ai-models'], queryFn: () => api<{ models: Array<{ id: string; name: string }>; configured: boolean }>('/ai/models') });
  const [f, setF] = useState({ name: e.name, jobTitle: e.jobTitle, description: e.description, personality: e.personality, avatar: e.avatar, language: e.language, dialect: e.dialect, channels: e.channels, model: e.model ?? '' });
  const save = useMutation({
    mutationFn: () => api<{ pausedForRetest?: boolean }>(`/ai-employees/${e.id}`, { method: 'PATCH', body: { ...f, name: f.name.trim(), model: f.model || null } }),
    onSuccess: async (r) => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['ai-employee', e.id] }), qc.invalidateQueries({ queryKey: ['ai-employees'] })]);
      toast.success(r.pausedForRetest ? 'Saved. This employee was paused until it passes the tests again.' : 'Profile saved');
    },
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  return (
    <Card className="space-y-5 p-6">
      <FormError error={save.error} />
      <div>
        <p className="mb-2 text-sm font-medium text-mist-800">Avatar</p>
        <div className="flex flex-wrap gap-2">
          {AVATARS.map((a) => (
            <button key={a} type="button" disabled={!canWrite} onClick={() => set('avatar', a)} aria-label={`Avatar ${a}`} aria-pressed={f.avatar === a} className={`rounded-2xl p-1 ring-2 ${f.avatar === a ? 'ring-burgundy-600' : 'ring-transparent'}`}>
              <Avatar avatar={a} name={f.name || '?'} />
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" value={f.name} maxLength={80} disabled={!canWrite} onChange={(x) => set('name', x.target.value)} />
        <TextField label="Role / job title" value={f.jobTitle} maxLength={120} disabled={!canWrite} onChange={(x) => set('jobTitle', x.target.value)} placeholder="e.g. Customer support agent" />
      </div>
      <TextAreaField label="Description" value={f.description} maxLength={1000} disabled={!canWrite} onChange={(x) => set('description', x.target.value)} placeholder="What does this employee do for your business?" />
      <TextAreaField label="Personality" hint="How should it sound? e.g. warm, patient, to the point." value={f.personality} maxLength={2000} disabled={!canWrite} onChange={(x) => set('personality', x.target.value)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Language" value={f.language} disabled={!canWrite} onChange={(x) => set('language', x.target.value as typeof f.language)}>
          <option value="auto">Same as the customer</option>
          <option value="ar">Arabic</option>
          <option value="en">English</option>
        </SelectField>
        <SelectField label="Arabic dialect" value={f.dialect} disabled={!canWrite} onChange={(x) => set('dialect', x.target.value)}>
          {(catalog.data?.dialects ?? ['none']).map((d) => <option key={d} value={d}>{DIALECT_LABEL[d] ?? d}</option>)}
        </SelectField>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-mist-800">Connected channels</p>
        <p className="mb-2 text-[13px] text-mist-500">Choose where this employee will work. Actually connecting these accounts comes in a later phase; for now your choice is saved.</p>
        <div className="flex flex-wrap gap-2">
          {(catalog.data?.channels ?? []).map((c) => {
            const on = f.channels.includes(c);
            return (
              <label key={c} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${on ? 'border-burgundy-300 bg-burgundy-50 text-burgundy-800' : 'border-mist-300 text-mist-700'}`}>
                <input type="checkbox" disabled={!canWrite} checked={on} onChange={() => set('channels', on ? f.channels.filter((x) => x !== c) : [...f.channels, c])} className="accent-burgundy-700" />
                {CHANNEL_LABEL[c] ?? c}
              </label>
            );
          })}
        </div>
      </div>
      <SelectField label="AI model" value={f.model} disabled={!canWrite} onChange={(x) => set('model', x.target.value)}>
        <option value="">Default ({catalog.data?.defaultModel ?? '…'})</option>
        {(models.data?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
      </SelectField>
      {canWrite ? (
        <div className="flex justify-end">
          <Button loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate()}>Save profile</Button>
        </div>
      ) : null}
    </Card>
  );
}
