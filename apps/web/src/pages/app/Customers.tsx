import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ExternalLink, Search, Tag, UserSquare2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, FormError, Modal, SelectField, Skeleton, TextAreaField, TextField } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { PlatformBadge, PLATFORMS, platformOf } from '../../lib/platforms';
import type { ChannelType, Consent, Customer, CustomerDetail, CustomerStatus } from '../../lib/types';

const STATUS: Record<CustomerStatus, { label: string; tone: 'gray' | 'amber' | 'green' | 'red' }> = {
  new: { label: 'New', tone: 'gray' }, lead: { label: 'Lead', tone: 'amber' }, customer: { label: 'Customer', tone: 'green' }, inactive: { label: 'Inactive', tone: 'red' },
};
const CONSENT: Record<Consent, { label: string; tone: 'gray' | 'green' | 'red' }> = {
  unknown: { label: 'No marketing consent recorded', tone: 'gray' }, opted_in: { label: 'Opted in', tone: 'green' }, opted_out: { label: 'Opted out', tone: 'red' },
};
const KIND: Record<string, string> = {
  first_contact: 'First message received', details_updated: 'Details edited', tag_added: 'Tag added', tag_removed: 'Tag removed', status_changed: 'Status changed',
  consent_changed: 'Consent changed', campaign_sent: 'Campaign message sent', unreachable: 'Platform says unreachable', reachable_again: 'Wrote again (reachable)',
};
const ago = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const nameOf = (c: { name: string | null; phone: string | null; platform: ChannelType }) => c.name ?? c.phone ?? (c.platform === 'website' ? 'Website visitor' : 'Unnamed customer');
const eventText = (e: CustomerDetail['events'][number]) => {
  const d = e.detail;
  if (e.kind === 'status_changed') return `${KIND[e.kind]}: ${d.from} → ${d.to}`;
  if (e.kind === 'consent_changed') return `${KIND[e.kind]}: ${d.from} → ${d.to}${d.source ? ` (${String(d.source).replace('_', ' ')})` : ''}${d.note ? `. ${d.note}` : ''}`;
  if (e.kind === 'tag_added' || e.kind === 'tag_removed') return `${KIND[e.kind]}: ${d.tag}`;
  if (e.kind === 'campaign_sent') return `${KIND[e.kind]}: ${d.name}`;
  return KIND[e.kind] ?? e.kind;
};

export default function Customers() {
  const { can } = useAuth();
  const [platform, setPlatform] = useState<'' | ChannelType>('');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [status, setStatus] = useState('');
  const [consent, setConsent] = useState('');
  const [limit, setLimit] = useState(30);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSearch(searchText.trim()), 300); return () => clearTimeout(t); }, [searchText]);
  useEffect(() => setLimit(30), [platform, search, tag, status, consent]);

  const summary = useQuery({ queryKey: ['customers', 'summary'], queryFn: () => api<{ platforms: Record<string, { total: number; optedOut: number; optedIn: number; customers: number; leads: number }> }>('/customers/summary') });
  const tags = useQuery({ queryKey: ['customers', 'tags'], queryFn: () => api<{ items: Array<{ tag: string; count: number }> }>('/customers/tags') });
  const qs = new URLSearchParams({ limit: String(limit) });
  if (platform) qs.set('platform', platform);
  if (search) qs.set('search', search);
  if (tag) qs.set('tag', tag);
  if (status) qs.set('status', status);
  if (consent) qs.set('consent', consent);
  const list = useQuery({ queryKey: ['customers', 'list', qs.toString()], queryFn: () => api<{ items: Customer[]; total: number; next: number | null }>(`/customers?${qs}`), placeholderData: (p) => p });
  const items = list.data?.items ?? [];
  const total = summary.data ? Object.values(summary.data.platforms).reduce((n, p) => n + p.total, 0) : null;
  const canManage = can('customers:manage');
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold text-mist-900">Customers</h1>
        <p className="mt-1 max-w-3xl text-sm text-mist-600">Everyone who wrote to your business on a connected channel. Each platform keeps its own identity: the same person on Messenger and on WhatsApp appears as two customers, because nothing reliable proves they are one person.</p>
      </header>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Platform">
        <Chip active={platform === ''} onClick={() => setPlatform('')}>All platforms{total !== null ? <b className="ml-1.5 font-semibold opacity-70">{total}</b> : null}</Chip>
        {PLATFORMS.map((p) => (
          <Chip key={p.type} active={platform === p.type} onClick={() => setPlatform(p.type)}>
            <p.icon className="mr-1.5 size-4" />{p.label}<b className="ml-1.5 font-semibold opacity-70">{summary.data?.platforms[p.type]?.total ?? 0}</b>
          </Chip>
        ))}
      </div>

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search customers" placeholder="Search name, phone or email…" className="h-11 w-full rounded-xl border border-mist-300 pr-3 pl-9 text-sm focus:border-burgundy-500 focus:ring-4 focus:ring-burgundy-100 focus:outline-none" />
          </div>
          <select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className="h-11 rounded-xl border border-mist-300 bg-white px-3 text-sm"><option value="">Any tag</option>{tags.data?.items.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}</select>
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-11 rounded-xl border border-mist-300 bg-white px-3 text-sm"><option value="">Any status</option>{(Object.keys(STATUS) as CustomerStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}</select>
          <select aria-label="Consent" value={consent} onChange={(e) => setConsent(e.target.value)} className="h-11 rounded-xl border border-mist-300 bg-white px-3 text-sm"><option value="">Any consent</option><option value="opted_in">Opted in</option><option value="opted_out">Opted out</option><option value="unknown">Not recorded</option></select>
        </div>
        {canManage && picked.size > 0 ? (
          <div className="mt-3 flex items-center gap-3 rounded-xl bg-burgundy-50 px-3 py-2 text-sm text-burgundy-900">
            <b>{picked.size} selected</b>
            <Button size="sm" variant="secondary" icon={Tag} onClick={() => setBulk(true)}>Add or remove tags</Button>
            <button className="ml-auto text-xs underline" onClick={() => setPicked(new Set())}>Clear</button>
          </div>
        ) : null}
      </Card>

      <Card className="overflow-hidden">
        {list.isPending ? <div className="space-y-2 p-4" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14" />)}</div>
          : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
          : items.length === 0 ? <EmptyState icon={UserSquare2} title={search || tag || status || consent || platform ? 'No customers match' : 'No customers yet'} description={search || tag || status || consent || platform ? 'Try another filter.' : 'Customers appear here automatically when someone writes to one of your connected channels.'} />
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-mist-200 bg-mist-50 text-xs tracking-wide text-mist-500 uppercase">
                  <tr>{canManage ? <th className="w-10 px-4 py-3" /> : null}<th className="px-4 py-3">Customer</th><th className="px-3 py-3">Last interaction</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Marketing consent</th><th className="px-3 py-3">Tags</th></tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.id} className="cursor-pointer border-b border-mist-100 hover:bg-mist-50" onClick={() => setOpen(c.id)}>
                      {canManage ? <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${nameOf(c)}`} checked={picked.has(c.id)} onChange={() => toggle(c.id)} className="size-4 accent-burgundy-700" /></td> : null}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3"><PlatformBadge type={c.platform} />
                          <div className="min-w-0"><button className="truncate text-left font-medium text-mist-900 hover:underline" onClick={() => setOpen(c.id)}>{nameOf(c)}</button><p className="max-w-[22rem] truncate text-xs text-mist-500">{c.lastMessage ?? '—'}</p></div></div>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap text-mist-600">{ago(c.lastInteractionAt)}</td>
                      <td className="px-3 py-3"><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></td>
                      <td className="px-3 py-3"><Badge tone={CONSENT[c.consentStatus].tone}>{CONSENT[c.consentStatus].label}</Badge>{c.unreachableAt ? <Badge tone="amber">Unreachable</Badge> : null}</td>
                      <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{c.tags.slice(0, 3).map((t) => <span key={t} className="rounded-full bg-burgundy-50 px-2 py-0.5 text-xs text-burgundy-800">{t}</span>)}{c.tags.length > 3 ? <span className="text-xs text-mist-400">+{c.tags.length - 3}</span> : null}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {list.data && list.data.next !== null ? <div className="border-t border-mist-100 p-3 text-center"><Button size="sm" variant="secondary" onClick={() => setLimit((l) => l + 30)}>Show more ({list.data.total - items.length} left)</Button></div> : null}
      </Card>

      {open ? <CustomerModal id={open} onClose={() => setOpen(null)} canManage={canManage} /> : null}
      {bulk ? <BulkTags ids={[...picked]} onClose={() => setBulk(false)} onDone={() => { setBulk(false); setPicked(new Set()); }} /> : null}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button role="tab" aria-selected={active} onClick={onClick} className={clsx('inline-flex items-center rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors', active ? 'bg-burgundy-700 text-white ring-burgundy-700' : 'bg-white text-mist-700 ring-mist-200 hover:bg-mist-50')}>{children}</button>;
}

const splitList = (s: string) => [...new Set(s.split(/[,،\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

function CustomerModal({ id, onClose, canManage }: { id: string; onClose: () => void; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['customers', id], queryFn: () => api<CustomerDetail>(`/customers/${id}`) });
  const c = q.data;
  const [f, setF] = useState<{ name: string; email: string; phone: string; status: CustomerStatus; notes: string; tags: string; interests: string } | null>(null);
  useEffect(() => { if (c) setF({ name: c.name ?? '', email: c.email ?? '', phone: c.phone ?? '', status: c.status, notes: c.notes ?? '', tags: c.tags.join(', '), interests: c.interests.join(', ') }); }, [c?.id, c?.status, c?.consentStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => { void qc.invalidateQueries({ queryKey: ['customers'] }); };
  const save = useMutation({
    mutationFn: () => api<Customer>(`/customers/${id}`, { method: 'PATCH', body: { name: f!.name, email: f!.email || null, ...(c?.phoneEditable ? { phone: f!.phone || null } : {}), status: f!.status, notes: f!.notes || null, tags: splitList(f!.tags), interests: splitList(f!.interests) } }),
    onSuccess: () => { toast.success('Saved'); done(); }, onError: (e) => toast.error(e.message),
  });
  const [consentOpen, setConsentOpen] = useState<Consent | null>(null);
  return (
    <Modal open onClose={onClose} title={c ? nameOf(c) : 'Customer'} description={c ? `${platformOf(c.platform)?.label} · ${c.channelName}` : undefined}>
      {q.isPending || !f ? <Skeleton className="h-64" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : c ? (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-mist-50 p-3 text-sm">
            <Info k="Platform ID" v={c.platformUserId} /><Info k="Messages" v={`${c.stats.messages} (${c.stats.inbound} from the customer)`} />
            <Info k="First interaction" v={ago(c.firstInteractionAt)} /><Info k="Last interaction" v={ago(c.lastInteractionAt)} />
          </dl>
          {c.unreachableAt ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">The platform refused our messages ({c.unreachableReason?.replace('_', ' ')}). They are skipped in campaigns until they write again.</p> : null}

          <section className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Name" value={f.name} disabled={!canManage} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <SelectField label="Status" value={f.status} disabled={!canManage} onChange={(e) => setF({ ...f, status: e.target.value as CustomerStatus })}>{(Object.keys(STATUS) as CustomerStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}</SelectField>
              <TextField label="Phone" value={f.phone} disabled={!canManage || !c.phoneEditable} hint={c.phoneEditable ? 'Only if the platform did not give it.' : 'Given by the platform.'} onChange={(e) => setF({ ...f, phone: e.target.value })} />
              <TextField label="Email" type="email" value={f.email} disabled={!canManage} hint="Only what you or the customer entered. We never guess it." onChange={(e) => setF({ ...f, email: e.target.value })} />
            </div>
            <TextField label="Tags (comma separated)" value={f.tags} disabled={!canManage} onChange={(e) => setF({ ...f, tags: e.target.value })} />
            <TextField label="Interests (comma separated)" value={f.interests} disabled={!canManage} onChange={(e) => setF({ ...f, interests: e.target.value })} />
            <TextAreaField label="Notes" rows={3} maxLength={4000} value={f.notes} disabled={!canManage} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            {save.error ? <FormError error={save.error} /> : null}
            {canManage ? <div className="flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button></div> : null}
          </section>

          <section className="space-y-2 border-t border-mist-100 pt-4">
            <h3 className="text-sm font-semibold text-mist-900">Marketing consent</h3>
            <p className="text-sm"><Badge tone={CONSENT[c.consentStatus].tone}>{CONSENT[c.consentStatus].label}</Badge>{c.consentSource ? <span className="ml-2 text-xs text-mist-500">source: {c.consentSource.replace('_', ' ')}{c.consentAt ? `, ${ago(c.consentAt)}` : ''}</span> : null}</p>
            <p className="text-xs text-mist-500">A customer who writes STOP is opted out automatically. Only record an opt-in if the person really agreed.</p>
            {canManage ? <div className="flex flex-wrap gap-2">
              {c.consentStatus !== 'opted_in' ? <Button size="sm" variant="secondary" onClick={() => setConsentOpen('opted_in')}>Record opt-in</Button> : null}
              {c.consentStatus !== 'opted_out' ? <Button size="sm" variant="secondary" onClick={() => setConsentOpen('opted_out')}>Mark as opted out</Button> : null}
            </div> : null}
          </section>

          {c.campaigns.length ? <section className="space-y-2 border-t border-mist-100 pt-4"><h3 className="text-sm font-semibold text-mist-900">Campaigns received</h3>
            <ul className="space-y-1 text-sm">{c.campaigns.map((x) => <li key={x.id}><Link className="text-burgundy-700 hover:underline" to={`/app/campaigns/${x.id}`}>{x.name}</Link> <span className="text-mist-500">· {x.status}{x.sentAt ? `, ${ago(x.sentAt)}` : ''}</span></li>)}</ul></section> : null}

          <section className="space-y-2 border-t border-mist-100 pt-4">
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-mist-900">Activity</h3>
              {c.conversationId ? <Link className="inline-flex items-center gap-1 text-sm text-burgundy-700 hover:underline" to={`/app/inbox/${platformOf(c.platform)?.slug}?c=${c.conversationId}`}>Open conversation <ExternalLink className="size-3.5" /></Link> : null}</div>
            <ol className="space-y-1.5 text-sm">{c.events.length === 0 ? <li className="text-mist-500">Nothing yet.</li> : c.events.map((e) => <li key={e.id} className="flex gap-2"><span className="w-24 shrink-0 text-xs text-mist-400">{ago(e.createdAt)}</span><span className="text-mist-700">{eventText(e)}{e.actorName ? <span className="text-mist-400"> · {e.actorName}</span> : null}</span></li>)}</ol>
          </section>
          {consentOpen ? <ConsentModal id={id} to={consentOpen} was={c.consentStatus} onClose={() => setConsentOpen(null)} onDone={() => { setConsentOpen(null); done(); }} /> : null}
        </div>
      ) : null}
    </Modal>
  );
}
const Info = ({ k, v }: { k: string; v: string | null }) => <div><dt className="text-[11px] tracking-wide text-mist-400 uppercase">{k}</dt><dd className="truncate text-mist-800">{v ?? '—'}</dd></div>;

function ConsentModal({ id, to, was, onClose, onDone }: { id: string; to: Consent; was: Consent; onClose: () => void; onDone: () => void }) {
  const [source, setSource] = useState('verbal');
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api(`/customers/${id}/consent`, { body: { status: to, source, note: note || undefined } }), onSuccess: onDone });
  return (
    <Modal open onClose={onClose} title={to === 'opted_in' ? 'Record marketing opt-in' : 'Mark as opted out'}>
      <div className="space-y-3">
        <FormError error={m.error} />
        <SelectField label="How did they agree?" value={source} onChange={(e) => setSource(e.target.value)}><option value="verbal">They told us (phone / in person)</option><option value="form">Form or checkbox</option><option value="customer_message">They wrote to us</option><option value="manual">Other</option></SelectField>
        <TextAreaField label={was === 'opted_out' && to === 'opted_in' ? 'Where and when did they agree? (required)' : 'Note (optional)'} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate()}>Save</Button></div>
      </div>
    </Modal>
  );
}

function BulkTags({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [add, setAdd] = useState('');
  const [remove, setRemove] = useState('');
  const m = useMutation({ mutationFn: () => api<{ updated: number }>('/customers/bulk-tags', { body: { ids, add: splitList(add), remove: splitList(remove) } }), onSuccess: (r) => { toast.success(`${r.updated} customers updated`); void qc.invalidateQueries({ queryKey: ['customers'] }); onDone(); } });
  return (
    <Modal open onClose={onClose} title={`Tags for ${ids.length} customers`}>
      <div className="space-y-3"><FormError error={m.error} />
        <TextField label="Add tags (comma separated)" value={add} onChange={(e) => setAdd(e.target.value)} />
        <TextField label="Remove tags (comma separated)" value={remove} onChange={(e) => setRemove(e.target.value)} />
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!add.trim() && !remove.trim()} onClick={() => m.mutate()}>Apply</Button></div></div>
    </Modal>
  );
}
