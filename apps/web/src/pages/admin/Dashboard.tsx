import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, ErrorState, FormError, Modal, SelectField, Skeleton, TextField } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';

interface Meter { key: string; used: number; limit: number; percent: number }
interface Company { id: string; name: string; plan: string; status: string; subscriptionStatus: string; trialEndsAt: string | null; meters: Meter[]; nearLimit: boolean; overridden: boolean; connectedChannels: number; campaignsMonth: number; workflowRunsMonth: number }
interface Dash {
  days: number;
  tenants: { total: number; active: number; suspended: number; new30d: number; signedIn7d: number; trialsExpired: number; byPlan: Array<{ plan: string; n: number }>; bySubscription: Array<{ status: string; n: number }>; activeDefinition: string };
  aiEmployees: { total: number; active: number };
  channels: { total: number; connected: number; byTypeStatus: Array<{ type: string; status: string; count: number }> };
  messageVolume: { series: Array<{ day: string; inbound: number; aiOut: number; humanOut: number; systemOut: number; failed: number }>; totals: { inbound: number; aiOut: number; humanOut: number; systemOut: number; failed: number } };
  aiConsumption: { calls: number; errors: number; tokens: number; costUsd: number; callsWithoutReportedCost: number; daily: Array<{ day: string; tokens: number }>; topCompanies: Array<{ id: string; name: string; tokens: number; calls: number }> };
  errors: { last24h: { failedMessages: number; failedCampaignMessages: number; failedWorkflowRuns: number; webhookRejectedOrErrors: number }; channelsInError: number; byCode: Array<{ source: string; code: string; n: number; lastAt: string }>; recent: Array<{ id: number; source: string; code: string; message: string; createdAt: string; tenantName: string | null }> };
  usageLimits: { note: string; companies: Company[] };
  privacy: string;
}
const n = (x: number) => x.toLocaleString();
const LABEL: Record<string, string> = { maxAiEmployees: 'AI employees', maxChannels: 'Channels', maxMonthlyMessages: 'Messages / month', aiTokensMonth: 'AI tokens / month' };

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <Card className="p-4"><p className="text-sm text-mist-600">{label}</p><p className="mt-1 text-2xl font-semibold text-mist-900 tabular-nums">{value}</p>{sub ? <p className="mt-0.5 text-xs text-mist-500">{sub}</p> : null}</Card>;
}
function Bars({ values, label }: { values: Array<{ day: string; v: number }>; label: string }) {
  const max = Math.max(1, ...values.map((x) => x.v));
  return <div role="img" aria-label={label}><div className="flex h-24 items-end gap-0.5">{values.map((x) => <div key={x.day} title={`${x.day}: ${n(x.v)}`} className="min-w-px flex-1 rounded-t bg-burgundy-500/80" style={{ height: `${Math.max(2, (x.v / max) * 100)}%`, opacity: x.v ? 1 : 0.25 }} />)}</div><p className="mt-1 text-[10px] text-mist-500">{values[0]?.day} → {values.at(-1)?.day} · peak {n(max)}</p></div>;
}

function Manage({ c, onClose }: { c: Company; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [plan, setPlan] = useState(c.plan);
  const [sub, setSub] = useState(c.subscriptionStatus);
  const [trial, setTrial] = useState(c.trialEndsAt ? c.trialEndsAt.slice(0, 10) : '');
  const meter = (k: string) => c.meters.find((m) => m.key === k)!;
  const [lim, setLim] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: () => {
      const limits: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(lim)) limits[k] = v.trim() === '' ? null : Number(v);
      return api(`/platform/tenants/${c.id}/subscription`, { method: 'PATCH', body: { plan, subscriptionStatus: sub, trialEndsAt: trial ? new Date(trial + 'T23:59:59Z').toISOString() : null, ...(Object.keys(limits).length ? { limits } : {}) } });
    },
    onSuccess: async () => { toast.success('Subscription updated.'); await qc.invalidateQueries({ queryKey: ['platform', 'dashboard'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={`Subscription — ${c.name}`} description="Set by hand. No payment processor is connected, so this does not charge anyone.">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)}>{['trial', 'starter', 'growth', 'scale'].map((p) => <option key={p}>{p}</option>)}</SelectField>
          <SelectField label="Status" value={sub} onChange={(e) => setSub(e.target.value)}>{['trialing', 'active', 'past_due', 'canceled'].map((p) => <option key={p}>{p}</option>)}</SelectField>
        </div>
        <TextField label="Trial ends (optional)" type="date" value={trial} onChange={(e) => setTrial(e.target.value)} />
        <p className="text-xs font-medium text-mist-700">Limit overrides (empty box = leave as is; type “-” to clear)</p>
        <div className="grid grid-cols-3 gap-2">
          {(['maxAiEmployees', 'maxChannels', 'maxMonthlyMessages'] as const).map((k) => (
            <TextField key={k} label={LABEL[k]!} hint={`now ${n(meter(k).limit)}`} inputMode="numeric" value={lim[k] ?? ''} onChange={(e) => setLim({ ...lim, [k]: e.target.value === '-' ? '' : e.target.value })} placeholder="" />
          ))}
        </div>
        <FormError error={m.error} />
        <Button loading={m.isPending} onClick={() => m.mutate()}>Save</Button>
      </div>
    </Modal>
  );
}

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const [manage, setManage] = useState<Company | null>(null);
  const q = useQuery({ queryKey: ['platform', 'dashboard', days], queryFn: () => api<Dash>(`/platform/dashboard?days=${days}`), placeholderData: (p) => p });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  if (!d) return <Skeleton className="h-96" />;
  const e = d.errors;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-mist-500">{d.privacy}</p><div className="w-40"><SelectField label="Period" value={String(days)} onChange={(x) => setDays(Number(x.target.value))}>{[7, 30, 90].map((x) => <option key={x} value={x}>Last {x} days</option>)}</SelectField></div></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Total tenants" value={n(d.tenants.total)} sub={`${n(d.tenants.new30d)} new in 30 days`} />
        <Stat label="Active tenants" value={n(d.tenants.active)} sub={`${n(d.tenants.suspended)} suspended · ${n(d.tenants.signedIn7d)} signed in last 7 days`} />
        <Stat label="AI employees" value={n(d.aiEmployees.total)} sub={`${n(d.aiEmployees.active)} active`} />
        <Stat label="Connected channels" value={`${n(d.channels.connected)} / ${n(d.channels.total)}`} sub={`${n(e.channelsInError)} in error`} />
        <Stat label="Messages in" value={n(d.messageVolume.totals.inbound)} sub={`${n(d.messageVolume.totals.aiOut)} AI · ${n(d.messageVolume.totals.humanOut)} team · ${n(d.messageVolume.totals.systemOut)} system out`} />
        <Stat label="AI consumption" value={`${n(d.aiConsumption.tokens)} tokens`} sub={`${n(d.aiConsumption.calls)} calls · $${d.aiConsumption.costUsd.toFixed(4)} reported${d.aiConsumption.callsWithoutReportedCost ? ` (${n(d.aiConsumption.callsWithoutReportedCost)} calls without cost, not estimated)` : ''}`} />
        <Stat label="System errors (24h)" value={n(e.last24h.failedMessages + e.last24h.failedCampaignMessages + e.last24h.failedWorkflowRuns + e.last24h.webhookRejectedOrErrors + e.byCode.reduce((s, x) => s + x.n, 0))} sub={`${n(e.last24h.failedMessages)} messages · ${n(e.last24h.failedCampaignMessages)} campaign · ${n(e.last24h.failedWorkflowRuns)} workflow runs · ${n(e.last24h.webhookRejectedOrErrors)} webhook`} />
        <Stat label="Trials expired" value={n(d.tenants.trialsExpired)} sub={d.tenants.bySubscription.map((s) => `${s.n} ${s.status}`).join(' · ')} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4"><p className="mb-2 text-sm font-medium">Message volume (inbound)</p><Bars values={d.messageVolume.series.map((r) => ({ day: r.day, v: r.inbound }))} label="Inbound messages per day" /></Card>
        <Card className="p-4"><p className="mb-2 text-sm font-medium">AI tokens per day</p><Bars values={d.aiConsumption.daily.map((r) => ({ day: r.day, v: r.tokens }))} label="AI tokens per day" /></Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4"><p className="mb-2 text-sm font-medium">Top companies by AI use</p>{d.aiConsumption.topCompanies.length ? <ul className="text-sm">{d.aiConsumption.topCompanies.map((c) => <li key={c.id} className="flex justify-between border-b border-mist-100 py-1"><span>{c.name}</span><span className="tabular-nums text-mist-600">{n(c.tokens)} tokens</span></li>)}</ul> : <p className="text-sm text-mist-500">No AI usage in this period.</p>}</Card>
        <Card className="p-4"><p className="mb-2 text-sm font-medium">Recent system errors</p>{e.recent.length ? <ul className="max-h-60 space-y-1 overflow-auto text-xs">{e.recent.map((r) => <li key={r.id} className="border-b border-mist-100 py-1"><b>{r.code}</b> · {r.source}{r.tenantName ? ` · ${r.tenantName}` : ''}<br /><span className="text-mist-500">{new Date(r.createdAt).toLocaleString()} — {r.message}</span></li>)}</ul> : <p className="text-sm text-mist-500">No errors recorded.</p>}</Card>
      </div>
      <Card className="p-4">
        <p className="text-sm font-medium">Usage limits & subscriptions</p>
        <p className="mb-3 text-xs text-mist-500">{d.usageLimits.note}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm"><thead className="text-xs text-mist-500"><tr><th className="py-1.5 pr-3">Company</th><th className="pr-3">Plan</th><th className="pr-3">Status</th>{Object.keys(LABEL).map((k) => <th key={k} className="pr-3">{LABEL[k]}</th>)}<th /></tr></thead>
            <tbody>{d.usageLimits.companies.map((c) => (
              <tr key={c.id} className="border-t border-mist-100">
                <td className="py-1.5 pr-3 font-medium">{c.name}{c.status === 'suspended' ? <> <Badge tone="red">suspended</Badge></> : null}{c.overridden ? <> <Badge tone="burgundy">custom</Badge></> : null}</td>
                <td className="pr-3">{c.plan}</td><td className="pr-3"><Badge tone={c.subscriptionStatus === 'active' ? 'green' : c.subscriptionStatus === 'past_due' || c.subscriptionStatus === 'canceled' ? 'red' : 'gray'}>{c.subscriptionStatus}</Badge></td>
                {c.meters.map((m) => <td key={m.key} className={`pr-3 tabular-nums ${m.percent >= 100 ? 'font-semibold text-red-700' : m.percent >= 80 ? 'text-amber-700' : ''}`}>{n(m.used)} / {n(m.limit)}</td>)}
                <td><Button size="sm" variant="secondary" onClick={() => setManage(c)}>Manage</Button></td>
              </tr>))}</tbody></table>
        </div>
      </Card>
      {manage ? <Manage c={manage} onClose={() => setManage(null)} /> : null}
    </div>
  );
}
