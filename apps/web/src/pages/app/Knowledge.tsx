import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, CheckCheck, FileUp, Globe, HelpCircle, Plus, Share2, Table2, Trash2, Building } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, uploadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { BusinessQuestion, KnowledgeItem, KnowledgeSource } from '../../lib/types';
import { Badge, Button, Card, EmptyState, ErrorState, FormError, Modal, SelectField, Skeleton, TextAreaField, TextField } from '../../components/ui/primitives';
import { Tabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';

const TYPE_INFO = {
  website: { label: 'Website', icon: Globe, help: 'We read your public pages (menu, products, services, prices, contact).' },
  social: { label: 'Social media', icon: Share2, help: 'Paste your recent posts. We analyze the latest 30 by default (you can change it).' },
  document: { label: 'PDF / Word / Excel', icon: FileUp, help: 'Upload a PDF, a Word file, or paste text.' },
  product_list: { label: 'Product list', icon: Table2, help: 'Excel or CSV with a name column and a price column. Read exactly as written, no AI guessing.' },
  business_info: { label: 'Business information', icon: Building, help: 'Opening hours, address, phone, delivery and payment, typed by you.' },
} as const;
type SourceType = keyof typeof TYPE_INFO;
const STATUS_TONE = { unconfirmed: 'amber', confirmed: 'green', rejected: 'red', outdated: 'gray' } as const;
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const priceText = (i: KnowledgeItem) => (typeof i.data.price === 'number' ? `${i.data.price}${i.data.currency ? ' ' + String(i.data.currency) : ''}` : '—');

type Tab = 'questions' | 'facts' | 'sources';

export default function Knowledge() {
  const { can } = useAuth();
  const summary = useQuery({ queryKey: ['knowledge', 'summary'], queryFn: () => api<{ items: Array<{ kind: string; status: string; n: number }>; openQuestions: number }>('/knowledge/summary') });
  const [tab, setTab] = useState<Tab>('sources');
  const unconfirmed = summary.data?.items.filter((i) => i.status === 'unconfirmed').reduce((a, b) => a + b.n, 0) ?? 0;
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold text-mist-900">Business Knowledge</h2>
        <p className="mt-1 text-[15px] text-mist-500">Teach your AI employees about your business. They only use facts you have confirmed, and they never invent prices or stock.</p>
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ key: 'sources', label: 'Sources' }, { key: 'facts', label: 'Facts to review', badge: unconfirmed || undefined }, { key: 'questions', label: 'Questions for you', badge: summary.data?.openQuestions || undefined }]} />
      {tab === 'sources' ? <Sources canWrite={can('knowledge:write')} /> : tab === 'facts' ? <Facts canWrite={can('knowledge:write')} /> : <Questions canWrite={can('knowledge:write')} />}
    </div>
  );
}

const useRefresh = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['knowledge'] });
};

/* ───────────────────────── Sources ───────────────────────── */
function Sources({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [adding, setAdding] = useState(false);
  const [feeding, setFeeding] = useState<KnowledgeSource | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeSource | null>(null);
  const q = useQuery({ queryKey: ['knowledge', 'sources'], queryFn: () => api<{ items: KnowledgeSource[] }>('/knowledge/sources') });
  const analyze = useMutation({
    mutationFn: (s: KnowledgeSource) => api<{ created: number; duplicates: number; stats: Record<string, number> }>(`/knowledge/sources/${s.id}/analyze`, { body: {} }),
    onSuccess: async (r) => { await refresh(); toast.success(`Found ${r.created} new fact${r.created === 1 ? '' : 's'}. Review them in “Facts to review”.`); },
    onError: async (e) => { await refresh(); toast.error(e.message); },
  });
  const del = useMutation({
    mutationFn: (s: KnowledgeSource) => api(`/knowledge/sources/${s.id}`, { method: 'DELETE' }),
    onSuccess: async () => { await refresh(); setDeleting(null); toast.success('Source and its facts removed'); },
  });
  const btn = canWrite ? <Button icon={Plus} onClick={() => setAdding(true)}>Add a source</Button> : null;
  return (
    <div className="space-y-4">
      {q.data?.items.length ? <div className="flex justify-end">{btn}</div> : null}
      {q.isPending ? <Skeleton className="h-40 rounded-2xl" /> : q.isError ? <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card> : q.data.items.length === 0 ? (
        <Card><EmptyState icon={BookOpen} title="No sources yet" description="Add your website, social posts, a price list or documents. We’ll extract products, services, prices, offers and FAQs for you to confirm." action={btn} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {q.data.items.map((s) => {
            const info = TYPE_INFO[s.type];
            const Icon = info.icon;
            return (
              <Card key={s.id} className="space-y-3 p-5">
                <div className="flex items-start gap-3">
                  <div className="grid size-10 place-items-center rounded-xl bg-burgundy-50 text-burgundy-700"><Icon className="size-5" /></div>
                  <div className="min-w-0 flex-1"><p className="truncate font-medium text-mist-900">{s.name}</p><p className="text-[12px] text-mist-500">{info.label}{s.type === 'social' ? ` · latest ${s.postLimit} posts` : ''}</p></div>
                  <Badge tone={s.status === 'analyzed' ? 'green' : s.status === 'failed' ? 'red' : 'gray'}>{s.status}</Badge>
                </div>
                <p className="text-[13px] text-mist-500">{s.itemCount} facts · {s.contentCount} item{s.contentCount === 1 ? '' : 's'} stored{s.lastAnalyzedAt ? ` · analyzed ${fmt(s.lastAnalyzedAt)}` : ''}</p>
                {s.lastError ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">{s.lastError}</p> : null}
                {canWrite ? (
                  <div className="flex flex-wrap gap-2 border-t border-mist-100 pt-3">
                    {s.type !== 'website' ? <Button size="sm" variant="secondary" onClick={() => setFeeding(s)}>{s.type === 'business_info' ? 'Edit details' : 'Add content'}</Button> : null}
                    {s.type !== 'business_info' ? <Button size="sm" loading={analyze.isPending && analyze.variables?.id === s.id} disabled={s.contentCount === 0 && s.type !== 'website'} onClick={() => analyze.mutate(s)}>{s.status === 'analyzed' ? 'Analyze again' : 'Analyze'}</Button> : null}
                    <Button size="sm" variant="danger" icon={Trash2} onClick={() => setDeleting(s)}>Remove</Button>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a source">{adding ? <AddSource onDone={(s) => { setAdding(false); if (s.type !== 'website') setFeeding(s); }} /> : null}</Modal>
      <Modal open={feeding !== null} onClose={() => setFeeding(null)} title={feeding ? `Add content to “${feeding.name}”` : ''} description={feeding ? TYPE_INFO[feeding.type].help : undefined}>{feeding ? <Feed source={feeding} onDone={() => setFeeding(null)} /> : null}</Modal>
      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="Remove this source?" description="Its stored content and every fact extracted from it will be deleted. Facts you typed yourself stay.">
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="danger" loading={del.isPending} onClick={() => deleting && del.mutate(deleting)}>Remove</Button></div>
      </Modal>
    </div>
  );
}

function AddSource({ onDone }: { onDone: (s: KnowledgeSource) => void }) {
  const refresh = useRefresh();
  const [type, setType] = useState<SourceType>('website');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [limit, setLimit] = useState(30);
  const m = useMutation({
    mutationFn: () => api<KnowledgeSource>('/knowledge/sources', { body: { type, name: name.trim() || TYPE_INFO[type].label, postLimit: limit, config: type === 'website' ? { url: url.trim() } : {} } }),
    onSuccess: async (s) => { await refresh(); onDone(s); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      <FormError error={m.error} />
      <SelectField label="Type" value={type} onChange={(e) => setType(e.target.value as SourceType)}>{(Object.keys(TYPE_INFO) as SourceType[]).map((t) => <option key={t} value={t}>{TYPE_INFO[t].label}</option>)}</SelectField>
      <p className="-mt-2 text-[13px] text-mist-500">{TYPE_INFO[type].help}</p>
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder={TYPE_INFO[type].label} />
      {type === 'website' ? <TextField label="Website address" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-business.com" /> : null}
      {type === 'social' ? <TextField label="Number of latest posts to analyze" type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(Math.min(200, Math.max(1, Number(e.target.value) || 30)))} hint="Default 30. Newest posts are used first." /> : null}
      <div className="flex justify-end"><Button type="submit" loading={m.isPending}>Add source</Button></div>
    </form>
  );
}

function Feed({ source, onDone }: { source: KnowledgeSource; onDone: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState({ hours: '', address: '', phone: '', delivery: '', payment: '', notes: '' });
  const m = useMutation({
    mutationFn: async () => {
      if (source.type === 'business_info') return api(`/knowledge/sources/${source.id}/content`, { body: { fields: Object.fromEntries(Object.entries(info).filter(([, v]) => v.trim())) } });
      if (file) return uploadFile(`/knowledge/sources/${source.id}/upload`, file);
      const body = source.type === 'social' ? { posts: text } : source.type === 'product_list' ? { csv: text } : { text };
      return api(`/knowledge/sources/${source.id}/content`, { body });
    },
    onSuccess: async () => { await refresh(); toast.success(source.type === 'business_info' ? 'Saved' : 'Content added. Now press Analyze.'); onDone(); },
  });
  const accept = source.type === 'product_list' ? '.xlsx,.csv' : '.pdf,.docx,.xlsx,.csv,.txt';
  const canFile = source.type === 'document' || source.type === 'product_list';
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      <FormError error={m.error} />
      {source.type === 'business_info' ? (
        <>
          <TextField label="Opening hours" value={info.hours} onChange={(e) => setInfo({ ...info, hours: e.target.value })} placeholder="Every day 9am to 11pm" />
          <TextField label="Address" value={info.address} onChange={(e) => setInfo({ ...info, address: e.target.value })} />
          <TextField label="Phone" value={info.phone} onChange={(e) => setInfo({ ...info, phone: e.target.value })} />
          <TextField label="Delivery" value={info.delivery} onChange={(e) => setInfo({ ...info, delivery: e.target.value })} placeholder="Yes, 30 EGP inside Cairo" />
          <TextField label="Payment methods" value={info.payment} onChange={(e) => setInfo({ ...info, payment: e.target.value })} placeholder="Cash, card" />
        </>
      ) : (
        <>
          {canFile ? <label className="block text-sm font-medium text-mist-800">File<input type="file" accept={accept} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1.5 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-burgundy-50 file:px-3 file:py-2 file:text-burgundy-700" /></label> : null}
          {!file ? <TextAreaField label={canFile ? 'Or paste text' : source.type === 'social' ? 'Paste your posts' : 'Content'} value={text} onChange={(e) => setText(e.target.value)} rows={8} maxLength={250000}
            hint={source.type === 'social' ? 'Separate posts with a line containing ---. Optionally start a post with “date: 2026-11-01”. A JSON list of posts also works.' : source.type === 'product_list' ? 'First row = column names, for example: name,price,description' : undefined} /> : null}
        </>
      )}
      <div className="flex justify-end"><Button type="submit" loading={m.isPending} disabled={source.type !== 'business_info' && !file && !text.trim()}>Save</Button></div>
    </form>
  );
}

/* ───────────────────────── Facts ───────────────────────── */
function Facts({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [status, setStatus] = useState('unconfirmed');
  const [kind, setKind] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<KnowledgeItem | 'new' | null>(null);
  const q = useQuery({ queryKey: ['knowledge', 'items', status, kind], queryFn: () => api<{ items: KnowledgeItem[] }>(`/knowledge/items?${new URLSearchParams({ ...(status ? { status } : {}), ...(kind ? { kind } : {}) })}`) });
  const setItemStatus = useMutation({
    mutationFn: (v: { id: string; status: string }) => api(`/knowledge/items/${v.id}`, { method: 'PATCH', body: { status: v.status } }),
    onSuccess: refresh, onError: (e) => toast.error(e.message),
  });
  const bulk = useMutation({
    mutationFn: () => api<{ updated: number }>('/knowledge/items/bulk-status', { body: { ids: q.data!.items.filter((i) => i.status === 'unconfirmed').map((i) => i.id), status: 'confirmed' } }),
    onSuccess: async (r) => { await refresh(); toast.success(`${r.updated} facts confirmed`); },
  });
  const pending = q.data?.items.filter((i) => i.status === 'unconfirmed').length ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 rounded-xl border border-mist-300 bg-white px-3 text-sm"><option value="unconfirmed">To review</option><option value="confirmed">Confirmed</option><option value="rejected">Rejected</option><option value="outdated">Outdated</option><option value="">All</option></select>
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="h-10 rounded-xl border border-mist-300 bg-white px-3 text-sm"><option value="">All kinds</option>{['product', 'service', 'offer', 'faq', 'business_info', 'audience'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select>
        <div className="ml-auto flex gap-2">
          {canWrite && status === 'unconfirmed' && pending > 0 ? <Button variant="secondary" icon={CheckCheck} loading={bulk.isPending} onClick={() => bulk.mutate()}>Confirm all {pending}</Button> : null}
          {canWrite ? <Button icon={Plus} onClick={() => setEditing('new')}>Add a fact</Button> : null}
        </div>
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.items.length === 0 ? (
          <EmptyState icon={BookOpen} title={status === 'unconfirmed' ? 'Nothing to review' : 'No facts here'} description="Facts appear after you analyze a source or add one yourself." />
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-mist-50 text-xs tracking-wide text-mist-500 uppercase"><tr><th className="px-5 py-3 font-medium">Fact</th><th className="px-3 font-medium">Kind</th><th className="px-3 font-medium">Price</th><th className="px-3 font-medium">Source</th><th className="px-3 font-medium">Date</th><th className="px-3 font-medium">Status</th><th className="px-5" /></tr></thead>
            <tbody className="divide-y divide-mist-100">
              {q.data.items.map((i) => (
                <FactRow key={i.id} i={i} open={open === i.id} onToggle={() => setOpen(open === i.id ? null : i.id)}>
                  {canWrite ? (<>
                    {i.status !== 'confirmed' ? <Button size="sm" onClick={() => setItemStatus.mutate({ id: i.id, status: 'confirmed' })}>Confirm</Button> : null}
                    {i.status !== 'rejected' ? <Button size="sm" variant="danger" onClick={() => setItemStatus.mutate({ id: i.id, status: 'rejected' })}>Reject</Button> : null}
                    <Button size="sm" variant="secondary" onClick={() => setEditing(i)}>Edit</Button>
                  </>) : null}
                </FactRow>
              ))}
            </tbody></table></div>
        )}
      </Card>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add a fact' : 'Edit fact'}>{editing !== null ? <FactForm item={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}</Modal>
    </div>
  );
}

function FactRow({ i, open, onToggle, children }: { i: KnowledgeItem; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <tr className="hover:bg-mist-50/60">
        <td className="px-5 py-3"><button onClick={onToggle} className="text-left font-medium text-mist-900 hover:underline" dir="auto">{i.name}</button>{i.kind === 'faq' ? <p className="max-w-xs truncate text-[12px] text-mist-500" dir="auto">{String(i.data.answer ?? '')}</p> : i.kind === 'business_info' ? <p className="text-[12px] text-mist-500" dir="auto">{String(i.data.text ?? '')}</p> : null}</td>
        <td className="px-3 text-mist-600">{i.kind.replace('_', ' ')}</td>
        <td className="px-3 tabular-nums">{priceText(i)}</td>
        <td className="px-3 text-mist-600">{i.sourceName ?? (i.origin === 'owner' ? 'You' : '—')}</td>
        <td className="px-3 text-mist-500">{fmt(i.sourceDate)}</td>
        <td className="px-3"><Badge tone={STATUS_TONE[i.status]}>{i.status}</Badge></td>
        <td className="space-x-1.5 px-5 text-right whitespace-nowrap">{children}</td>
      </tr>
      {open ? <tr className="bg-mist-50"><td colSpan={7} className="px-5 py-3 text-[13px] text-mist-600"><span className="font-medium">Evidence:</span> <span dir="auto">“{i.evidence || 'entered by you'}”</span><br /><span className="font-medium">From:</span> {i.sourceRef || '—'}</td></tr> : null}
    </>
  );
}

function FactForm({ item, onDone }: { item: KnowledgeItem | null; onDone: () => void }) {
  const refresh = useRefresh();
  const [f, setF] = useState({ kind: item?.kind ?? 'product', name: item?.name ?? '', price: typeof item?.data.price === 'number' ? String(item.data.price) : '', currency: String(item?.data.currency ?? ''), description: String(item?.data.description ?? ''), question: String(item?.data.question ?? ''), answer: String(item?.data.answer ?? ''), text: String(item?.data.text ?? '') });
  const m = useMutation({
    mutationFn: () => {
      const data: Record<string, unknown> = {};
      if (f.kind !== 'faq' && f.kind !== 'business_info') { data.price = f.price.trim() === '' ? null : Number(f.price); data.currency = f.currency.trim() || null; data.description = f.description.trim() || null; }
      if (f.kind === 'faq') { data.question = f.question.trim(); data.answer = f.answer.trim(); }
      if (f.kind === 'business_info') data.text = f.text.trim();
      return item ? api(`/knowledge/items/${item.id}`, { method: 'PATCH', body: { name: f.name.trim(), data, status: 'confirmed' } }) : api('/knowledge/items', { body: { kind: f.kind, name: f.name.trim(), data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)) } });
    },
    onSuccess: async () => { await refresh(); onDone(); },
  });
  const priceBad = f.price.trim() !== '' && !(Number(f.price) >= 0);
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      <FormError error={m.error} />
      {!item ? <SelectField label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })}>{['product', 'service', 'offer', 'faq', 'business_info'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</SelectField> : null}
      <TextField label={f.kind === 'faq' ? 'Topic' : 'Name'} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={300} dir="auto" />
      {f.kind === 'faq' ? (<><TextField label="Question" value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} dir="auto" /><TextAreaField label="Answer" value={f.answer} onChange={(e) => setF({ ...f, answer: e.target.value })} dir="auto" /></>)
        : f.kind === 'business_info' ? <TextField label="Value" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} dir="auto" />
        : (<><div className="grid grid-cols-2 gap-3"><TextField label="Price" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} error={priceBad ? 'Enter a number' : undefined} /><TextField label="Currency" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} placeholder="EGP" maxLength={10} /></div><TextField label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} dir="auto" /></>)}
      <p className="text-[13px] text-mist-500">Saving marks this fact as confirmed by you.</p>
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onDone}>Cancel</Button><Button type="submit" loading={m.isPending} disabled={!f.name.trim() || priceBad}>Save</Button></div>
    </form>
  );
}

/* ───────────────────────── Questions ───────────────────────── */
function Questions({ canWrite }: { canWrite: boolean }) {
  const refresh = useRefresh();
  const toast = useToast();
  const q = useQuery({ queryKey: ['knowledge', 'questions'], queryFn: () => api<{ items: BusinessQuestion[]; openTotal: number }>('/knowledge/questions?limit=5') });
  const answer = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) => api(`/knowledge/questions/${v.id}/answer`, { body: v.body }),
    onSuccess: async () => { await refresh(); toast.success('Thanks, saved'); },
    onError: (e) => toast.error(e.message),
  });
  if (q.isPending) return <Skeleton className="h-40 rounded-2xl" />;
  if (q.isError) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  if (q.data.items.length === 0) return <Card><EmptyState icon={HelpCircle} title="No questions right now" description="When we find a missing price, two different prices, or information that looks old, we’ll ask you here, a few at a time and never the same question twice." /></Card>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-mist-500">Showing the {q.data.items.length} most important of {q.data.openTotal} open question{q.data.openTotal === 1 ? '' : 's'}.</p>
      {q.data.items.map((x) => <QuestionCard key={x.id} q={x} canWrite={canWrite} busy={answer.isPending} onAnswer={(body) => answer.mutate({ id: x.id, body })} />)}
    </div>
  );
}

function QuestionCard({ q, canWrite, busy, onAnswer }: { q: BusinessQuestion; canWrite: boolean; busy: boolean; onAnswer: (b: Record<string, unknown>) => void }) {
  const [v, setV] = useState('');
  const t = q.options.type;
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center gap-2"><Badge tone={q.kind === 'conflict' ? 'red' : q.kind === 'outdated' ? 'amber' : 'burgundy'}>{q.kind === 'conflict' ? 'Different prices' : q.kind === 'outdated' ? 'Maybe outdated' : 'Missing'}</Badge></div>
      <p className="text-[15px] font-medium text-mist-900" dir="auto">{q.question}</p>
      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          {t === 'price' ? (<><input aria-label="Price" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="Price" className="h-10 w-32 rounded-xl border border-mist-300 px-3 text-sm" /><Button size="sm" loading={busy} disabled={!(Number(v) >= 0) || v.trim() === ''} onClick={() => onAnswer({ price: Number(v) })}>Save price</Button><Button size="sm" variant="secondary" onClick={() => onAnswer({ notSold: true })}>We don’t sell this</Button></>) : null}
          {t === 'choose_item' ? q.options.choices?.map((c) => <Button key={c.itemId} size="sm" variant="secondary" loading={busy} onClick={() => onAnswer({ itemId: c.itemId })}>{c.price}{c.source ? ` · ${c.source}` : ''}{c.date ? ` · ${fmt(c.date)}` : ''}</Button>) : null}
          {t === 'still_valid' ? (<><Button size="sm" loading={busy} onClick={() => onAnswer({ stillValid: true })}>Yes, still valid</Button><Button size="sm" variant="danger" onClick={() => onAnswer({ stillValid: false })}>No, it’s outdated</Button></>) : null}
          {t === 'info' ? (<><input aria-label="Answer" value={v} onChange={(e) => setV(e.target.value)} dir="auto" className="h-10 min-w-64 flex-1 rounded-xl border border-mist-300 px-3 text-sm" /><Button size="sm" loading={busy} disabled={!v.trim()} onClick={() => onAnswer({ text: v.trim() })}>Save</Button></>) : null}
          <Button size="sm" variant="ghost" onClick={() => onAnswer({ dismiss: true })}>Skip, don’t ask again</Button>
        </div>
      ) : null}
    </Card>
  );
}
