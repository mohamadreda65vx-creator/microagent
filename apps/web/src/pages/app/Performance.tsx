import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { Badge, Card, ErrorState, SelectField, Skeleton, TextField } from '../../components/ui/primitives';
import { api } from '../../lib/api';

interface Perf {
  period: { from: string; to: string; days: number };
  kpis: {
    conversations: number; inboundMessages: number; aiReplies: number; staffReplies: number; leadsMarked: number; leadsCollectedByAi: number; qualifiedLeads: number; orders: number; conversions: number; handoffs: number; staffTakeovers: number;
    unanswered: { count: number; oldestAt: string | null; afterMinutes: number };
    ai: { calls: number; errors: number; tokens: number; costUsd: number; callsWithoutReportedCost: number; byPurpose: Array<{ purpose: string; calls: number; tokens: number }> };
  };
  series: Array<{ day: string; conversations: number; aiTokens: number }>;
  campaigns: Array<{ id: string; name: string; platform: string; status: string; counts: Record<string, number> }>;
  agents: Array<{ id: string; name: string }>;
  definitions: Record<string, string>;
  notes: string[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString();

function Tile({ label, value, def, sub }: { label: string; value: string; def: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2"><p className="text-sm text-mist-600">{label}</p><span title={def} aria-label={`${label}: ${def}`} tabIndex={0} className="text-mist-400"><Info className="size-4" /></span></div>
      <p className="mt-1 text-2xl font-semibold text-mist-900">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-mist-500">{sub}</p> : null}
      <p className="mt-2 line-clamp-3 text-[11px] leading-snug text-mist-500">{def}</p>
    </Card>
  );
}

function Bars({ data, pick, label }: { data: Perf['series']; pick: (r: Perf['series'][number]) => number; label: string }) {
  const max = Math.max(1, ...data.map(pick));
  return (
    <div role="img" aria-label={`${label}: ${data.map((d) => `${d.day} ${pick(d)}`).join(', ')}`}>
      <div className="flex h-28 items-end gap-0.5">{data.map((d) => <div key={d.day} title={`${d.day}: ${fmt(pick(d))}`} className="min-w-px flex-1 rounded-t bg-burgundy-500/80" style={{ height: `${Math.max(2, (pick(d) / max) * 100)}%`, opacity: pick(d) ? 1 : 0.25 }} />)}</div>
      <div className="mt-1 flex justify-between text-[10px] text-mist-500"><span>{data[0]?.day}</span><span>peak {fmt(max)}</span><span>{data.at(-1)?.day}</span></div>
    </div>
  );
}

export default function Performance() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 864e5)));
  const [to, setTo] = useState(iso(new Date()));
  const [employeeId, setEmp] = useState('');
  const [platform, setPlatform] = useState('');
  const [campaignId, setCamp] = useState('');
  const params = new URLSearchParams({ from, to });
  if (employeeId) params.set('employeeId', employeeId);
  if (platform) params.set('platform', platform);
  if (campaignId) params.set('campaignId', campaignId);
  const q = useQuery({ queryKey: ['performance', from, to, employeeId, platform, campaignId], queryFn: () => api<Perf>(`/performance?${params}`), placeholderData: (p) => p });
  const allCamps = useQuery({ queryKey: ['performance-campaign-options'], queryFn: () => api<Perf>(`/performance?from=${iso(new Date(Date.now() - 89 * 864e5))}&to=${iso(new Date())}`) });

  const d = q.data;
  const k = d?.kpis;
  return (
    <div className="space-y-5">
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <TextField label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="To" type="date" value={to} min={from} max={iso(new Date())} onChange={(e) => setTo(e.target.value)} />
        <SelectField label="AI employee" value={employeeId} onChange={(e) => setEmp(e.target.value)}><option value="">All</option>{(d?.agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</SelectField>
        <SelectField label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="">All</option>{['whatsapp', 'messenger', 'instagram', 'telegram', 'website'].map((p) => <option key={p}>{p}</option>)}</SelectField>
        <SelectField label="Campaign" value={campaignId} onChange={(e) => setCamp(e.target.value)}><option value="">All</option>{(allCamps.data?.campaigns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
      </Card>

      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d || !k ? <Skeleton className="h-64" /> : (
        <>
          {d.notes.length ? <ul className="space-y-1 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">{d.notes.map((n) => <li key={n}>• {n}</li>)}</ul> : null}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label="Conversations" value={fmt(k.conversations)} def={d.definitions.conversations!} sub={`${fmt(k.inboundMessages)} customer messages · ${fmt(k.aiReplies)} AI / ${fmt(k.staffReplies)} team replies`} />
            <Tile label="Leads" value={fmt(k.leadsMarked)} def={d.definitions.leadsMarked!} sub={`${fmt(k.leadsCollectedByAi)} saved by AI`} />
            <Tile label="Qualified leads" value={fmt(k.qualifiedLeads)} def={d.definitions.qualifiedLeads!} />
            <Tile label="Order requests" value={fmt(k.orders)} def={d.definitions.orders!} />
            <Tile label="Conversions" value={fmt(k.conversions)} def={d.definitions.conversions!} />
            <Tile label="Human handoffs" value={fmt(k.handoffs)} def={d.definitions.handoffs!} sub={`${fmt(k.staffTakeovers)} team takeovers`} />
            <Tile label="Unanswered messages" value={fmt(k.unanswered.count)} def={d.definitions.unanswered!} sub={`waiting more than ${k.unanswered.afterMinutes} min${k.unanswered.oldestAt ? ` · oldest ${new Date(k.unanswered.oldestAt).toLocaleString()}` : ''}`} />
            <Tile label="AI usage" value={`${fmt(k.ai.tokens)} tokens`} def={d.definitions.aiTokens!} sub={`${fmt(k.ai.calls)} calls · ${fmt(k.ai.errors)} failed`} />
            <Tile label="AI cost (reported)" value={`$${k.ai.costUsd.toFixed(4)}`} def={d.definitions.aiCost!} sub={k.ai.callsWithoutReportedCost ? `${fmt(k.ai.callsWithoutReportedCost)} calls had no reported cost (not estimated)` : undefined} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4"><p className="mb-2 text-sm font-medium text-mist-900">Conversations per day</p><Bars data={d.series} pick={(r) => r.conversations} label="Conversations per day" /></Card>
            <Card className="p-4"><p className="mb-2 text-sm font-medium text-mist-900">AI tokens per day</p><Bars data={d.series} pick={(r) => r.aiTokens} label="AI tokens per day" /></Card>
          </div>

          <Card className="p-4">
            <p className="mb-2 text-sm font-medium text-mist-900">Campaign results</p>
            {d.campaigns.length === 0 ? <p className="text-sm text-mist-500">No campaigns started in this period.</p> : (
              <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-mist-500"><tr><th className="py-1.5 pr-3">Campaign</th><th className="pr-3">Platform</th><th className="pr-3">Status</th>{Object.keys(d.campaigns[0]!.counts).map((c) => <th key={c} className="pr-3 capitalize">{c.replace(/_/g, ' ')}</th>)}</tr></thead>
                <tbody>{d.campaigns.map((c) => <tr key={c.id} className="border-t border-mist-100"><td className="py-1.5 pr-3 font-medium">{c.name}</td><td className="pr-3">{c.platform}</td><td className="pr-3"><Badge tone={c.status === 'completed' ? 'green' : 'gray'}>{c.status}</Badge></td>{Object.keys(d.campaigns[0]!.counts).map((n) => <td key={n} className="pr-3 tabular-nums">{fmt(c.counts[n] ?? 0)}</td>)}</tr>)}</tbody></table></div>
            )}
            <p className="mt-2 text-xs text-mist-500">Only what the platform actually recorded: queued, sent, delivered/failed as reported by each channel. Replies are not attributed to campaigns.</p>
          </Card>

          {k.ai.byPurpose.length ? <Card className="p-4"><p className="mb-2 text-sm font-medium text-mist-900">AI usage by purpose</p><ul className="grid gap-1 text-sm sm:grid-cols-2">{k.ai.byPurpose.map((p) => <li key={p.purpose} className="flex justify-between border-b border-mist-100 py-1"><span className="capitalize">{p.purpose.replace(/_/g, ' ')}</span><span className="tabular-nums text-mist-600">{fmt(p.tokens)} tokens · {fmt(p.calls)} calls</span></li>)}</ul></Card> : null}
        </>
      )}
    </div>
  );
}
