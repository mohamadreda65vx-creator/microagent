import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Megaphone, Pause, Play, Plus, Rocket, Send, Sparkles, Trash2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, FormError, SelectField, Skeleton, TextAreaField, TextField } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { PlatformBadge, platformOf } from '../../lib/platforms';
import type { AudienceFilter, Campaign, CampaignCounts, CampaignPlatformInfo, CampaignPreview, CampaignStatus, CustomerStatus } from '../../lib/types';

const ST: Record<CampaignStatus, { label: string; tone: 'gray' | 'amber' | 'green' | 'red' | 'burgundy' }> = {
  draft: { label: 'Draft', tone: 'gray' }, approved: { label: 'Approved, not launched', tone: 'burgundy' }, scheduled: { label: 'Scheduled', tone: 'amber' },
  running: { label: 'Sending', tone: 'green' }, paused: { label: 'Paused', tone: 'amber' }, completed: { label: 'Completed', tone: 'green' }, cancelled: { label: 'Cancelled', tone: 'red' },
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const keyOf = (id: string) => ['campaign', id];

export default function Campaigns() {
  return (
    <Routes>
      <Route index element={<CampaignList />} />
      <Route path="new" element={<NewCampaign />} />
      <Route path=":id" element={<CampaignPage />} />
    </Routes>
  );
}

// ───────────────────────── list ─────────────────────────
function CampaignList() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => api<{ items: Campaign[] }>('/campaigns'), refetchInterval: 8000 });
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="font-display text-2xl font-semibold text-mist-900">Campaigns</h1>
          <p className="mt-1 max-w-3xl text-sm text-mist-600">Send an offer to people who already wrote to you. Nothing is sent until you review the exact audience and approve it, and every platform’s messaging rules are enforced.</p></div>
        {can('campaigns:manage') ? <Link to="/app/campaigns/new"><Button icon={Plus}>Create campaign</Button></Link> : null}
      </header>
      <Card className="overflow-hidden">
        {q.isPending ? <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
          : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
          : q.data.items.length === 0 ? <EmptyState icon={Megaphone} title="No campaigns yet" description="Describe your offer in a sentence and the AI will prepare the audience and the message for your review." action={can('campaigns:manage') ? <Link to="/app/campaigns/new"><Button icon={Sparkles}>Create your first campaign</Button></Link> : undefined} />
          : <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-mist-200 bg-mist-50 text-xs tracking-wide text-mist-500 uppercase"><tr><th className="px-4 py-3">Campaign</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Audience</th><th className="px-3 py-3">Sent</th><th className="px-3 py-3">Failed</th><th className="px-3 py-3">Created</th></tr></thead>
            <tbody>{q.data.items.map((c) => (
              <tr key={c.id} className="border-b border-mist-100 hover:bg-mist-50">
                <td className="px-4 py-3"><Link to={`/app/campaigns/${c.id}`} className="flex items-center gap-3"><PlatformBadge type={c.platform} /><span className="font-medium text-mist-900 hover:underline">{c.name}</span>{c.createdByAi ? <Badge tone="burgundy">AI</Badge> : null}</Link></td>
                <td className="px-3 py-3"><Badge tone={ST[c.status].tone}>{ST[c.status].label}</Badge></td>
                <td className="px-3 py-3 text-mist-700">{c.totalAudience ?? c.snapshot.eligible ?? '—'}</td><td className="px-3 py-3 text-mist-700">{c.sent ?? 0}</td><td className="px-3 py-3 text-mist-700">{c.failed ?? 0}</td>
                <td className="px-3 py-3 text-mist-500">{when(c.createdAt)}</td></tr>))}</tbody></table></div>}
      </Card>
    </div>
  );
}

// ───────────────────────── create ─────────────────────────
type Needs = { needs: 'platform' | 'channel' | 'channel_missing'; channels?: Array<{ id: string; name: string; type: string }> };
function NewCampaign() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const plats = useQuery({ queryKey: ['campaign-platforms'], queryFn: () => api<{ platforms: CampaignPlatformInfo[] }>('/campaigns/platforms') });
  const [prompt, setPrompt] = useState('');
  const [channelId, setChannelId] = useState('');
  const [needs, setNeeds] = useState<Needs | null>(null);
  const [manual, setManual] = useState(false);
  const [name, setName] = useState('');
  const all = useMemo(() => (plats.data?.platforms ?? []).flatMap((p) => p.channels.map((c) => ({ ...c, platform: p.platform }))), [plats.data]);

  const ai = useMutation({
    mutationFn: (cid?: string) => api<{ campaign?: Campaign } & Partial<Needs>>('/campaigns/ai/draft', { body: { prompt, ...(cid || channelId ? { channelId: cid ?? channelId } : {}) } }),
    onSuccess: (r) => { if (r.campaign) nav(`/app/campaigns/${r.campaign.id}`); else setNeeds({ needs: r.needs!, channels: r.channels as Needs['channels'] }); },
  });
  const create = useMutation({
    mutationFn: () => api<Campaign>('/campaigns', { body: { name: name || 'New campaign', channelId, message: '', audience: {} } }),
    onSuccess: (c) => { toast.success('Draft created'); nav(`/app/campaigns/${c.id}`); },
  });
  if (!can('campaigns:manage')) return <ErrorState error={new Error('You do not have permission to create campaigns.')} />;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="/app/campaigns" className="inline-flex items-center gap-1 text-sm text-mist-600 hover:text-mist-900"><ArrowLeft className="size-4" />Campaigns</Link>
      <h1 className="font-display text-2xl font-semibold text-mist-900">Create campaign</h1>
      <Card className="space-y-3 p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-mist-900"><Sparkles className="size-4 text-burgundy-700" />Describe it in your own words</div>
        <TextAreaField label="What do you want to send, and to whom?" rows={4} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Send my new Ramadan offer, 20% off, to everyone who messaged us on Messenger in the last 90 days" hint="The AI prepares a draft only. You will see the exact audience and message, and nothing is sent until you approve." />
        {needs?.needs === 'platform' ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Which platform should this go to? Pick a channel below, then draft again.</p> : null}
        {needs?.needs === 'channel_missing' ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">That platform has no channel connected yet. Connect it first from Integrations.</p> : null}
        {needs?.needs === 'channel' ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">More than one channel matches. Choose which one to use.</p> : null}
        {all.length ? <SelectField label="Channel (optional, the AI picks if the request names one platform)" value={channelId} onChange={(e) => setChannelId(e.target.value)}><option value="">Let the AI decide</option>{all.map((c) => <option key={c.id} value={c.id}>{platformOf(c.platform)?.label} · {c.name}{c.status !== 'connected' ? ` (${c.status})` : ''}</option>)}</SelectField> : null}
        <FormError error={ai.error} />
        <div className="flex justify-end"><Button icon={Sparkles} loading={ai.isPending} disabled={prompt.trim().length < 5} onClick={() => ai.mutate(undefined)}>Draft with AI</Button></div>
      </Card>

      <Card className="space-y-3 p-5">
        <button className="text-sm font-semibold text-mist-900" onClick={() => setManual((m) => !m)}>{manual ? '▾' : '▸'} Or start from a blank draft</button>
        {manual ? <div className="space-y-3">
          <TextField label="Campaign name" value={name} onChange={(e) => setName(e.target.value)} />
          <SelectField label="Channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}><option value="">Select…</option>{all.map((c) => <option key={c.id} value={c.id}>{platformOf(c.platform)?.label} · {c.name}</option>)}</SelectField>
          <FormError error={create.error} />
          <div className="flex justify-end"><Button variant="secondary" loading={create.isPending} disabled={!channelId} onClick={() => create.mutate()}>Create draft</Button></div>
        </div> : null}
      </Card>
      {plats.data ? <Card className="p-5"><h2 className="mb-2 text-sm font-semibold text-mist-900">What each platform allows</h2>
        <div className="grid gap-4 sm:grid-cols-2">{plats.data.platforms.map((p) => <div key={p.platform}><div className="mb-1 flex items-center gap-2 text-sm font-medium"><PlatformBadge type={p.platform} size="sm" />{platformOf(p.platform)?.label}<span className="text-xs text-mist-400">up to {p.limits.perMinute}/min{p.limits.perDay ? `, ${p.limits.perDay}/day` : ''}</span></div>
          <ul className="list-disc space-y-1 pl-5 text-xs text-mist-600">{p.rules.map((r) => <li key={r}>{r}</li>)}</ul></div>)}</div></Card> : null}
    </div>
  );
}

// ───────────────────────── single campaign ─────────────────────────
function CampaignPage() {
  const { id } = useParams() as { id: string };
  const q = useQuery({ queryKey: keyOf(id), queryFn: () => api<Campaign>(`/campaigns/${id}`), refetchInterval: (s) => (['running', 'scheduled', 'paused'].includes(s.state.data?.status ?? '') ? 4000 : false) });
  return (
    <div className="space-y-5">
      <Link to="/app/campaigns" className="inline-flex items-center gap-1 text-sm text-mist-600 hover:text-mist-900"><ArrowLeft className="size-4" />Campaigns</Link>
      {q.isPending ? <Skeleton className="h-64" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : ['draft', 'approved'].includes(q.data.status) ? <Editor c={q.data} /> : <Monitor c={q.data} />}
    </div>
  );
}

const splitList = (s: string) => [...new Set(s.split(/[,،\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
const STATUSES: CustomerStatus[] = ['new', 'lead', 'customer', 'inactive'];

function Editor({ c }: { c: Campaign }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [name, setName] = useState(c.name);
  const [message, setMessage] = useState(c.message);
  const [footer, setFooter] = useState(c.optoutFooter);
  const [aud, setAud] = useState<AudienceFilter>(c.audience);
  const [tagsAny, setTagsAny] = useState((c.audience.tagsAny ?? []).join(', '));
  const [excl, setExcl] = useState((c.audience.excludeTags ?? []).join(', '));
  const [instr, setInstr] = useState('');
  const full: AudienceFilter = useMemo(() => {
    const a: AudienceFilter = { ...aud };
    const t = splitList(tagsAny), e = splitList(excl);
    if (t.length) a.tagsAny = t; else delete a.tagsAny;
    if (e.length) a.excludeTags = e; else delete a.excludeTags;
    return a;
  }, [aud, tagsAny, excl]);
  const dirty = name !== c.name || message !== c.message || footer !== c.optoutFooter || JSON.stringify(full) !== JSON.stringify(c.audience);
  const manage = can('campaigns:manage');

  const [pv, setPv] = useState<CampaignPreview | null>(null);
  const [pvErr, setPvErr] = useState<unknown>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api<CampaignPreview>('/campaigns/audience/preview', { body: { channelId: c.channelId, audience: full, message, optoutFooter: footer } }).then((r) => { setPv(r); setPvErr(null); }).catch(setPvErr);
    }, 400);
    return () => clearTimeout(t);
  }, [c.channelId, full, message, footer]);

  const refresh = () => { void qc.invalidateQueries({ queryKey: keyOf(c.id) }); void qc.invalidateQueries({ queryKey: ['campaigns'] }); };
  const save = useMutation({ mutationFn: () => api<Campaign>(`/campaigns/${c.id}`, { method: 'PATCH', body: { name, message, optoutFooter: footer, audience: full } }), onSuccess: () => { toast.success('Saved'); refresh(); } });
  const revise = useMutation({
    mutationFn: () => api<{ campaign: Campaign }>(`/campaigns/${c.id}/ai/revise`, { body: { instruction: instr } }),
    onSuccess: (r) => { setInstr(''); setName(r.campaign.name); setMessage(r.campaign.message); setFooter(r.campaign.optoutFooter); setAud(r.campaign.audience); setTagsAny((r.campaign.audience.tagsAny ?? []).join(', ')); setExcl((r.campaign.audience.excludeTags ?? []).join(', ')); refresh(); },
  });
  const del = useMutation({ mutationFn: () => api(`/campaigns/${c.id}`, { method: 'DELETE' }), onSuccess: () => { refresh(); nav('/app/campaigns'); } });
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState(false);
  const [sched, setSched] = useState('');
  const approve = useMutation({
    mutationFn: async () => { if (dirty) await api(`/campaigns/${c.id}`, { method: 'PATCH', body: { name, message, optoutFooter: footer, audience: full } }); const fresh = await api<CampaignPreview>(`/campaigns/${c.id}/preview`); return api(`/campaigns/${c.id}/approve`, { body: { hash: fresh.hash, confirmRecipients: Number(typed), ...(ack ? { acknowledgeUnofficialRisk: true } : {}) } }); },
    onSuccess: () => { toast.success('Approved. Nothing has been sent yet.'); refresh(); },
  });
  const launch = useMutation({
    mutationFn: () => api(`/campaigns/${c.id}/launch`, { body: sched ? { scheduleAt: new Date(sched).toISOString() } : {} }),
    onSuccess: () => { toast.success(sched ? 'Scheduled' : 'Campaign started'); refresh(); },
  });
  const approved = c.status === 'approved';
  const eligible = pv?.eligible ?? 0;
  const canApprove = can('campaigns:approve') && pv && pv.blockers.length === 0 && eligible > 0 && Number(typed) === eligible && (!pv.requiresUnofficialAck || ack) && !dirty;

  return (
    <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
      <div className="space-y-5">
        <div className="flex items-center gap-3"><PlatformBadge type={c.platform} size="lg" /><div className="min-w-0 flex-1"><h1 className="truncate font-display text-2xl font-semibold text-mist-900">{c.name}</h1><p className="text-sm text-mist-500">{platformOf(c.platform)?.label} · {c.channelName} <Badge tone={ST[c.status].tone}>{ST[c.status].label}</Badge>{c.createdByAi ? <> <Badge tone="burgundy">AI draft</Badge></> : null}</p></div></div>

        {c.channelStatus && c.channelStatus !== 'connected' ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">This channel is {c.channelStatus.replace('_', ' ')}. Campaigns can only be launched while it is connected.</p> : null}
        {c.aiNotes.warnings?.length ? <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"><b>Check these:</b><ul className="list-disc pl-5">{c.aiNotes.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div> : null}

        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-mist-900">1 · The offer</h2>
          <TextField label="Campaign name" value={name} disabled={!manage} onChange={(e) => setName(e.target.value)} />
          <TextAreaField label="Message" rows={5} maxLength={1500} value={message} disabled={!manage} onChange={(e) => setMessage(e.target.value)} hint="Use {{first_name}} to personalise. If a customer has no name it is left out, never invented." />
          <label className="flex items-start gap-2 text-sm text-mist-700"><input type="checkbox" className="mt-0.5 size-4 accent-burgundy-700" checked={footer} disabled={!manage} onChange={(e) => setFooter(e.target.checked)} />Add a line telling people how to stop messages (recommended; replying STOP opts them out automatically)</label>
          <Templates onPick={(b) => setMessage(b)} canManage={manage} current={message} />
        </Card>

        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-mist-900">2 · The audience <span className="font-normal text-mist-500">(only people from {c.channelName})</span></h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Last wrote within (days)" type="number" min={1} disabled={!manage} value={aud.lastInteraction?.withinDays ?? ''} onChange={(e) => setAud((a) => ({ ...a, lastInteraction: { ...a.lastInteraction, withinDays: e.target.value ? Number(e.target.value) : undefined } }))} />
            <TextField label="Last wrote more than (days ago)" type="number" min={1} disabled={!manage} value={aud.lastInteraction?.olderThanDays ?? ''} onChange={(e) => setAud((a) => ({ ...a, lastInteraction: { ...a.lastInteraction, olderThanDays: e.target.value ? Number(e.target.value) : undefined } }))} />
            <TextField label="Has any of these tags" value={tagsAny} disabled={!manage} onChange={(e) => setTagsAny(e.target.value)} hint="Comma separated" />
            <TextField label="Never send to these tags" value={excl} disabled={!manage} onChange={(e) => setExcl(e.target.value)} hint="Comma separated" />
          </div>
          <div><p className="mb-1 text-sm font-medium text-mist-800">Status</p><div className="flex flex-wrap gap-3 text-sm">{STATUSES.map((s) => <label key={s} className="flex items-center gap-1.5"><input type="checkbox" className="size-4 accent-burgundy-700" disabled={!manage} checked={aud.statuses?.includes(s) ?? false} onChange={(e) => setAud((a) => { const set = new Set(a.statuses ?? []); if (e.target.checked) set.add(s); else set.delete(s); const arr = [...set]; const n = { ...a }; if (arr.length) n.statuses = arr; else delete n.statuses; return n; })} />{s}</label>)}</div></div>
          <div className="flex flex-wrap gap-5 text-sm">
            <label className="flex items-center gap-1.5"><input type="checkbox" className="size-4 accent-burgundy-700" disabled={!manage} checked={aud.optedInOnly ?? false} onChange={(e) => setAud((a) => { const n = { ...a }; if (e.target.checked) n.optedInOnly = true; else delete n.optedInOnly; return n; })} />Only customers who opted in to marketing</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" className="size-4 accent-burgundy-700" disabled={!manage} checked={aud.purchased === false} onChange={(e) => setAud((a) => { const n = { ...a }; if (e.target.checked) n.purchased = false; else delete n.purchased; return n; })} />Didn’t buy yet (status isn’t “customer”)</label>
          </div>
        </Card>

        {manage ? <Card className="space-y-2 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-mist-900"><Sparkles className="size-4 text-burgundy-700" />Ask the AI to change it</h2>
          <TextField label="Instruction" value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="e.g. make it shorter, only last 30 days, exclude VIP" />
          <FormError error={revise.error} />
          <div className="flex justify-end"><Button variant="secondary" loading={revise.isPending} disabled={instr.trim().length < 3 || dirty} onClick={() => revise.mutate()}>{dirty ? 'Save your edits first' : 'Revise'}</Button></div>
          {c.aiNotes.improvements?.length ? <div className="rounded-lg bg-burgundy-50 px-3 py-2 text-sm text-burgundy-900"><b>AI suggestions:</b><ul className="list-disc pl-5">{c.aiNotes.improvements.map((w) => <li key={w}>{w}</li>)}</ul></div> : null}
          {c.aiNotes.questions?.length ? <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"><b>The AI needs you to decide:</b><ul className="list-disc pl-5">{c.aiNotes.questions.map((w) => <li key={w}>{w}</li>)}</ul></div> : null}
        </Card> : null}
      </div>

      <div className="space-y-5 lg:sticky lg:top-4 lg:self-start">
        <Card className="space-y-3 p-5" >
          <h2 className="text-sm font-semibold text-mist-900">3 · Preview</h2>
          {pvErr ? <FormError error={pvErr} /> : !pv ? <Skeleton className="h-40" /> : (
            <>
              <div className="grid grid-cols-3 gap-2 text-center"><Tile k="In audience" v={pv.total} /><Tile k="Will receive" v={pv.eligible} strong /><Tile k="Excluded" v={pv.total - pv.eligible} /></div>
              {pv.excluded.length ? <ul className="space-y-1 text-xs text-mist-600">{pv.excluded.map((x) => <li key={x.reason} className="flex justify-between gap-3"><span>{x.label}</span><b>{x.count}</b></li>)}</ul> : null}
              {pv.sample.length ? <div><p className="mb-1 text-xs font-medium text-mist-500">Exactly what {pv.sample.length > 1 ? 'the first people' : 'one person'} would get</p>{pv.sample.slice(0, 2).map((s) => <p key={s.contactId} className="mb-1.5 rounded-xl bg-mist-100 px-3 py-2 text-sm whitespace-pre-wrap text-mist-800"><span className="mb-0.5 block text-[11px] text-mist-400">{s.name ?? 'No name known'}</span>{s.text}</p>)}</div> : null}
              {pv.warnings.map((w) => <p key={w} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{w}</p>)}
              {pv.blockers.map((b) => <p key={b.code} className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{b.text}</p>)}
              <p className="text-xs text-mist-500">About {pv.estimatedMinutes} min at {pv.ratePerMinute} messages/min.</p>
            </>
          )}
        </Card>

        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-mist-900">4 · Approve and launch</h2>
          <FormError error={save.error ?? approve.error ?? launch.error ?? del.error} />
          {!approved ? <>
            {dirty && manage ? <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">You have unsaved changes.<Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></div> : null}
            {can('campaigns:approve') ? <>
              <TextField label={`Type ${eligible} to confirm you approve sending to exactly ${eligible} people`} inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value.replace(/\D/g, ''))} />
              {pv?.requiresUnofficialAck ? <label className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900"><input type="checkbox" className="mt-0.5 size-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />This WhatsApp connection is unofficial (QR). Messaging people outside 24 hours can get the number restricted or banned by WhatsApp. I accept this risk.</label> : null}
              <Button icon={CheckCircle2} className="w-full" loading={approve.isPending} disabled={!canApprove} onClick={() => approve.mutate()}>Approve this campaign</Button>
              <p className="text-xs text-mist-500">Approving does not send anything. If the audience or message changes afterwards, the approval is cancelled.</p>
            </> : <p className="text-sm text-mist-600">Only an owner or admin can approve campaigns.</p>}
          </> : <>
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">Approved for {c.approvedEligible} people on {when(c.approvedAt)}. Nothing has been sent.</p>
            <TextField label="Send later (optional)" type="datetime-local" value={sched} onChange={(e) => setSched(e.target.value)} hint="Leave empty to start now." />
            <Button icon={sched ? Send : Rocket} className="w-full" loading={launch.isPending} disabled={!can('campaigns:approve')} onClick={() => launch.mutate()}>{sched ? 'Schedule' : 'Launch now'}</Button>
          </>}
          {manage ? <button className="inline-flex items-center gap-1 text-xs text-mist-500 hover:text-red-700" onClick={() => { if (confirm('Delete this draft?')) del.mutate(); }}><Trash2 className="size-3.5" />Delete draft</button> : null}
        </Card>
      </div>
    </div>
  );
}
const Tile = ({ k, v, strong }: { k: string; v: number | string; strong?: boolean }) => <div className={strong ? 'rounded-xl bg-burgundy-50 py-2' : 'rounded-xl bg-mist-50 py-2'}><p className="text-xl font-semibold text-mist-900">{v}</p><p className="text-[11px] text-mist-500">{k}</p></div>;

function Templates({ onPick, canManage, current }: { onPick: (b: string) => void; canManage: boolean; current: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['campaign-templates'], queryFn: () => api<{ items: Array<{ id: string; name: string; body: string }> }>('/campaign-templates') });
  const [nm, setNm] = useState('');
  const add = useMutation({ mutationFn: () => api('/campaign-templates', { body: { name: nm, body: current } }), onSuccess: () => { setNm(''); void qc.invalidateQueries({ queryKey: ['campaign-templates'] }); } });
  const del = useMutation({ mutationFn: (id: string) => api(`/campaign-templates/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['campaign-templates'] }) });
  if (!q.data) return null;
  return (
    <details className="text-sm"><summary className="cursor-pointer text-mist-600">Saved templates ({q.data.items.length})</summary>
      <ul className="mt-2 space-y-1">{q.data.items.map((t) => <li key={t.id} className="flex items-center gap-2"><button className="text-burgundy-700 hover:underline" onClick={() => onPick(t.body)}>{t.name}</button>{canManage ? <button aria-label={`Delete ${t.name}`} onClick={() => del.mutate(t.id)} className="text-mist-400 hover:text-red-600"><XCircle className="size-3.5" /></button> : null}</li>)}</ul>
      {canManage ? <div className="mt-2 flex gap-2"><input value={nm} onChange={(e) => setNm(e.target.value)} placeholder="Save current message as…" aria-label="Template name" className="h-9 flex-1 rounded-lg border border-mist-300 px-2 text-sm" /><Button size="sm" variant="secondary" loading={add.isPending} disabled={!nm.trim() || !current.trim()} onClick={() => add.mutate()}>Save</Button></div> : null}
    </details>
  );
}

// ───────────────────────── monitor ─────────────────────────
type Analytics = { counts: CampaignCounts; excluded: Array<{ reason: string; label: string; count: number }>; skippedOrFailed: Array<{ reason: string; label: string; count: number }>; deliveryReported: boolean; definitions: Record<string, string> };
type Recipient = { id: string; name: string | null; phone: string | null; status: string; reason: string | null; sentAt: string | null; messageStatus: string | null; attempts: number | null };

function Monitor({ c }: { c: Campaign }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const live = ['running', 'scheduled', 'paused'].includes(c.status);
  const an = useQuery({ queryKey: ['campaign', c.id, 'analytics'], queryFn: () => api<Analytics>(`/campaigns/${c.id}/analytics`), refetchInterval: live ? 4000 : false });
  const [rs, setRs] = useState('');
  const rec = useQuery({ queryKey: ['campaign', c.id, 'recipients', rs], queryFn: () => api<{ items: Recipient[]; total: number }>(`/campaigns/${c.id}/recipients?limit=100${rs ? `&status=${rs}` : ''}`), refetchInterval: live ? 6000 : false });
  const ev = useQuery({ queryKey: ['campaign', c.id, 'events'], queryFn: () => api<{ items: Array<{ id: string; kind: string; detail: Record<string, unknown>; createdAt: string; actorName: string | null }> }>(`/campaigns/${c.id}/events`), refetchInterval: live ? 6000 : false });
  const ctl = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'cancel') => api(`/campaigns/${c.id}/${a}`, { body: {} }),
    onSuccess: (_r, a) => { toast.success(a === 'pause' ? 'Paused' : a === 'resume' ? 'Resumed' : 'Cancelled'); void qc.invalidateQueries({ queryKey: keyOf(c.id) }); void qc.invalidateQueries({ queryKey: ['campaign', c.id] }); },
  });
  const n = an.data?.counts;
  const tiles: Array<[string, number | undefined, string]> = [
    ['Total audience', n?.totalAudience, 'Everyone the filter matched'], ['Eligible', n?.eligible, 'Allowed to receive it'], ['Sent', n?.sent, 'Accepted by the platform'],
    ['Delivered', n?.delivered, an.data?.deliveryReported ? 'Confirmed by the platform' : 'This platform never reports delivery'], ['Failed', n?.failed, 'Not sent after retries'],
    ['Replies', n?.replies, 'Wrote back within 7 days'], ['Leads', n?.leads, 'Marked lead within 14 days'], ['Conversions', n?.conversions, 'Marked customer within 14 days'], ['Opt-outs', n?.optOuts, 'Asked to stop'],
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <PlatformBadge type={c.platform} size="lg" />
        <div className="min-w-0 flex-1"><h1 className="truncate font-display text-2xl font-semibold text-mist-900">{c.name}</h1>
          <p className="text-sm text-mist-500">{platformOf(c.platform)?.label} · {c.channelName} <Badge tone={ST[c.status].tone}>{ST[c.status].label}</Badge> {c.scheduledAt && c.status === 'scheduled' ? `starts ${when(c.scheduledAt)}` : `started ${when(c.startedAt)}`}{c.finishedAt ? `, finished ${when(c.finishedAt)}` : ''}</p></div>
        {can('campaigns:manage') && live ? <div className="flex gap-2">
          {c.status === 'paused' ? <Button icon={Play} loading={ctl.isPending} onClick={() => ctl.mutate('resume')}>Resume</Button> : <Button variant="secondary" icon={Pause} loading={ctl.isPending} onClick={() => ctl.mutate('pause')}>Pause</Button>}
          <Button variant="secondary" icon={XCircle} onClick={() => { if (confirm('Cancel this campaign? Messages not sent yet will not be sent.')) ctl.mutate('cancel'); }}>Cancel</Button></div> : null}
      </div>
      <FormError error={ctl.error} />
      {c.status === 'paused' && c.channelStatus !== 'connected' ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Paused automatically: the channel is {c.channelStatus?.replace('_', ' ')}. Reconnect it, then resume.</p> : null}

      {an.isError ? <ErrorState error={an.error} onRetry={() => an.refetch()} /> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{tiles.map(([k, v, hint]) => <Card key={k} className="p-3"><p className="text-2xl font-semibold text-mist-900">{v ?? '…'}</p><p className="text-xs font-medium text-mist-700">{k}</p><p className="text-[11px] text-mist-400">{hint}</p></Card>)}</div>
      )}
      {n ? <p className="text-xs text-mist-500">Queued {n.queued + n.inFlight} · Skipped at send time {n.skipped} · Cancelled {n.cancelled}. Leads and conversions count only customers your team marked as such.</p> : null}
      {an.data?.excluded.length ? <Card className="p-4"><h2 className="mb-2 text-sm font-semibold text-mist-900">Not included, and why</h2><ul className="grid gap-1 text-sm text-mist-700 sm:grid-cols-2">{an.data.excluded.map((x) => <li key={x.reason} className="flex justify-between gap-3"><span>{x.label}</span><b>{x.count}</b></li>)}</ul></Card> : null}

      <Card className="p-4"><h2 className="mb-2 text-sm font-semibold text-mist-900">Message</h2><p className="text-sm whitespace-pre-wrap text-mist-700">{c.message}</p></Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-mist-100 p-4"><h2 className="text-sm font-semibold text-mist-900">Recipients {rec.data ? `(${rec.data.total})` : ''}</h2>
          <select aria-label="Filter recipients" value={rs} onChange={(e) => setRs(e.target.value)} className="h-9 rounded-lg border border-mist-300 bg-white px-2 text-sm"><option value="">All</option>{['queued', 'sending', 'sent', 'retrying', 'failed', 'skipped', 'cancelled', 'excluded'].map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        {rec.isPending ? <Skeleton className="m-4 h-24" /> : rec.data && rec.data.items.length ? <div className="max-h-96 overflow-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="sticky top-0 bg-mist-50 text-xs text-mist-500 uppercase"><tr><th className="px-4 py-2">Customer</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Channel says</th><th className="px-3 py-2">Why / sent</th></tr></thead>
          <tbody>{rec.data.items.map((r) => <tr key={r.id} className="border-t border-mist-100"><td className="px-4 py-2">{r.name ?? r.phone ?? 'Unnamed'}</td><td className="px-3 py-2"><Badge tone={r.status === 'sent' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'excluded' || r.status === 'skipped' ? 'amber' : 'gray'}>{r.status}</Badge></td><td className="px-3 py-2 text-mist-600">{r.messageStatus ?? '—'}{r.attempts && r.attempts > 1 ? ` (${r.attempts} tries)` : ''}</td><td className="px-3 py-2 text-xs text-mist-500">{r.reason ?? (r.sentAt ? when(r.sentAt) : '—')}</td></tr>)}</tbody></table></div> : <p className="p-4 text-sm text-mist-500">No recipients in this view.</p>}
      </Card>

      <Card className="overflow-hidden p-4"><h2 className="mb-2 text-sm font-semibold text-mist-900">Campaign log</h2>
        <ol className="space-y-1 text-sm">{ev.data?.items.map((e) => <li key={e.id} className="flex gap-3"><span className="w-24 shrink-0 text-xs text-mist-400 sm:w-32">{when(e.createdAt)}</span><span className="min-w-0 break-words text-mist-700">{e.kind.replace(/_/g, ' ')}{e.actorName ? <span className="text-mist-400"> · {e.actorName}</span> : null}{Object.keys(e.detail).length ? <span className="text-xs break-all text-mist-400"> {JSON.stringify(e.detail).slice(0, 140)}</span> : null}</span></li>)}</ol></Card>
    </div>
  );
}
