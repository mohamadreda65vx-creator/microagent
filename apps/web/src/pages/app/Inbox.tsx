import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ArrowLeft, Bot, Check, CheckCheck, Clock, CornerUpRight, Hand, Inbox as InboxIcon, Paperclip, RefreshCw, Search, Send, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, FormError, Modal, Skeleton, TextAreaField, TextField } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { PLATFORMS, PlatformBadge, platformOf } from '../../lib/platforms';
import type { AiState, Channel, ChannelType, ChatMessage, Conversation, ConversationList, ConvStatus, Member } from '../../lib/types';

const AI_STATE: Record<AiState, { text: string; tone: 'green' | 'amber' | 'gray' | 'burgundy' }> = {
  ai_answering: { text: 'AI employee is answering', tone: 'green' },
  human_has_it: { text: 'A person has this conversation', tone: 'burgundy' },
  no_employee: { text: 'No AI employee on this channel', tone: 'gray' },
  employee_not_live: { text: 'AI employee is not live: your team answers', tone: 'amber' },
  auto_reply_off: { text: 'Auto-reply is off: your team answers', tone: 'amber' },
  channel_not_connected: { text: 'Channel is not connected', tone: 'amber' },
};
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'mine', label: 'Mine' },
  { key: 'human', label: 'Needs a person' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

const timeLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const displayName = (c: Conversation) => c.contact.name ?? c.contact.phone ?? (c.platform === 'website' ? 'Website visitor' : 'Customer');
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

export default function Inbox() {
  const { platform: slug } = useParams();
  const meta = PLATFORMS.find((p) => p.slug === slug);
  if (!meta) return <Navigate to="/app/inbox/whatsapp" replace />;
  return <InboxFor key={meta.type} type={meta.type} />;
}

function InboxFor({ type }: { type: ChannelType }) {
  const meta = platformOf(type)!;
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [status, setStatus] = useState<'' | ConvStatus>('');
  const [channelId, setChannelId] = useState('');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setSearch(searchText.trim()), 300); return () => clearTimeout(t); }, [searchText]);

  const channels = useQuery({ queryKey: ['channels'], queryFn: () => api<{ items: Channel[] }>('/channels'), enabled: can('channels:read') });
  const mine = (channels.data?.items ?? []).filter((c) => c.type === type);
  const query = useMemo(() => {
    const p = new URLSearchParams({ platform: type, limit: '30' });
    if (filter === 'unread') p.set('unread', '1');
    if (filter === 'unassigned') p.set('assigned', 'unassigned');
    if (filter === 'mine') p.set('assigned', 'me');
    if (filter === 'human') p.set('handler', 'human');
    if (status) p.set('status', status);
    if (channelId) p.set('channelId', channelId);
    if (search) p.set('search', search);
    return p;
  }, [type, filter, status, channelId, search]);
  const list = useInfiniteQuery({
    queryKey: ['conversations', type, query.toString()],
    initialPageParam: '',
    queryFn: ({ pageParam }) => api<ConversationList>(`/conversations?${query}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (l) => l.next ?? undefined,
    refetchInterval: 8000,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = list.data?.pages[0]?.counts;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['conversations'] }); };

  return (
    <div className="-m-4 flex h-[calc(100dvh-4rem)] min-h-[520px] sm:-m-6" data-testid={`inbox-${type}`}>
      {/* ───────── list pane ───────── */}
      <section className={clsx('flex w-full flex-col border-r border-mist-200 bg-white md:w-[340px] md:shrink-0', selected && 'hidden md:flex')} aria-label={`${meta.label} conversations`}>
        <header className="space-y-3 border-b border-mist-200 p-4">
          <div className="flex items-center gap-2.5">
            <PlatformBadge type={type} />
            <h2 className="font-display text-lg font-semibold text-mist-900">{meta.label} conversations</h2>
          </div>
          <p className="-mt-1 text-xs text-mist-500">Only {meta.label} messages appear here.</p>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search name, phone or message…" aria-label="Search conversations" className="h-10 w-full rounded-xl border border-mist-300 bg-white pr-3 pl-9 text-sm focus:border-burgundy-500 focus:ring-4 focus:ring-burgundy-100 focus:outline-none" />
          </div>
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter">
            {FILTERS.map((f) => {
              const n = counts ? (f.key === 'all' ? counts.all : counts[f.key]) : undefined;
              return (
                <button key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)} className={clsx('rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors', filter === f.key ? 'bg-burgundy-700 text-white ring-burgundy-700' : 'bg-white text-mist-600 ring-mist-200 hover:bg-mist-50')}>
                  {f.label}{n !== undefined ? <span className="ml-1 opacity-70">{n}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | ConvStatus)} className="h-9 min-w-0 flex-1 rounded-lg border border-mist-300 bg-white px-2 text-xs">
              <option value="">Any status</option><option value="open">Open</option><option value="pending">Waiting for a person</option><option value="resolved">Resolved</option>
            </select>
            {mine.length > 1 ? (
              <select aria-label="Channel" value={channelId} onChange={(e) => setChannelId(e.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-mist-300 bg-white px-2 text-xs">
                <option value="">All {meta.label} channels</option>{mine.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : null}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isPending ? (
            <div className="space-y-2 p-3" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16" />)}</div>
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={InboxIcon} title={search || filter !== 'all' || status ? 'No conversations match' : `No ${meta.label} conversations yet`} description={search || filter !== 'all' || status ? 'Try another filter or search.' : mine.length === 0 && channels.data ? `Connect ${meta.label} in Channels to start receiving messages here.` : 'When a customer writes to you, the conversation appears here.'} />
          ) : (
            <ul>
              {items.map((c) => <Row key={c.id} c={c} active={c.id === selected} onClick={() => setSelected(c.id)} />)}
              {list.hasNextPage ? <li className="p-3 text-center"><Button size="sm" variant="secondary" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Load more</Button></li> : null}
            </ul>
          )}
        </div>
      </section>

      {/* ───────── thread ───────── */}
      <section className={clsx('min-w-0 flex-1 bg-mist-50', !selected && 'hidden md:block')}>
        {selected ? <Thread key={selected} id={selected} type={type} meId={me!.user.id} onBack={() => setSelected(null)} onChanged={refresh} /> : (
          <div className="grid h-full place-items-center p-6"><EmptyState icon={meta.icon} title="Select a conversation" description={`Pick a ${meta.label} conversation to read it, reply, or hand it back to the AI employee.`} /></div>
        )}
      </section>
    </div>
  );
}

function Row({ c, active, onClick }: { c: Conversation; active: boolean; onClick: () => void }) {
  const name = displayName(c);
  return (
    <li>
      <button onClick={onClick} aria-current={active} className={clsx('flex w-full items-start gap-3 border-b border-mist-100 px-4 py-3 text-left transition-colors', active ? 'bg-burgundy-50' : 'hover:bg-mist-50')}>
        <span className="relative grid size-10 shrink-0 place-items-center rounded-full bg-burgundy-100 text-sm font-semibold text-burgundy-800">
          {initials(name)}
          <span className={clsx('absolute -right-0.5 -bottom-0.5 grid size-4 place-items-center rounded-full ring-2 ring-white', c.handler === 'ai' ? 'bg-emerald-500 text-white' : 'bg-burgundy-700 text-white')} title={c.handler === 'ai' ? 'AI employee' : 'A person'}>
            {c.handler === 'ai' ? <Bot className="size-2.5" /> : <UserRound className="size-2.5" />}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2"><span className={clsx('truncate text-sm text-mist-900', c.unreadCount ? 'font-semibold' : 'font-medium')}>{name}</span><span className="ml-auto shrink-0 text-[11px] text-mist-400">{timeLabel(c.lastMessageAt)}</span></span>
          <span className="mt-0.5 flex items-center gap-2"><span className={clsx('truncate text-[13px]', c.unreadCount ? 'text-mist-800' : 'text-mist-500')}>{c.lastMessagePreview || '…'}</span>
            {c.unreadCount ? <span className="ml-auto grid min-w-5 shrink-0 place-items-center rounded-full bg-burgundy-600 px-1.5 text-[11px] font-semibold text-white">{c.unreadCount}</span> : null}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {c.status === 'pending' ? <Badge tone="amber">Needs a person</Badge> : c.status === 'resolved' ? <Badge>Resolved</Badge> : null}
            {c.assignedTo ? <Badge tone="burgundy">{c.assignedTo.name}</Badge> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

/* ───────────────────────── thread ───────────────────────── */
function Thread({ id, type, meId, onBack, onChanged }: { id: string; type: ChannelType; meId: string; onBack: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const conv = useQuery({ queryKey: ['conversation', id], queryFn: () => api<Conversation>(`/conversations/${id}`), refetchInterval: 6000 });
  const msgs = useQuery({ queryKey: ['conversation', id, 'messages'], queryFn: () => api<{ items: ChatMessage[]; hasMore: boolean }>(`/conversations/${id}/messages?limit=100`), refetchInterval: 4000 });
  const members = useQuery({ queryKey: ['team', 'members'], queryFn: () => api<{ items: Member[] }>('/team/members'), enabled: can('conversations:manage') });
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  const info = true;
  const bottom = useRef<HTMLDivElement>(null);
  const c = conv.data;
  const refetchAll = () => { void qc.invalidateQueries({ queryKey: ['conversation', id] }); onChanged(); };

  const markRead = useMutation({ mutationFn: () => api(`/conversations/${id}/read`, { method: 'POST', body: {} }), onSuccess: onChanged });
  useEffect(() => { if (c && c.unreadCount > 0 && !markRead.isPending) markRead.mutate(); }, [c?.unreadCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = msgs.data?.items.length ?? 0;
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [count]);

  const patch = useMutation({ mutationFn: (b: object) => api(`/conversations/${id}`, { method: 'PATCH', body: b }), onSuccess: refetchAll, onError: (e) => toast.error(e.message) });
  const takeover = useMutation({ mutationFn: () => api(`/conversations/${id}/takeover`, { method: 'POST', body: {} }), onSuccess: () => { toast.success('You have this conversation. The AI employee stopped answering it.'); refetchAll(); }, onError: (e) => toast.error(e.message) });
  const release = useMutation({ mutationFn: () => api(`/conversations/${id}/release`, { method: 'POST', body: {} }), onSuccess: () => { toast.success('Handed back to the AI employee'); refetchAll(); }, onError: (e) => toast.error(e.message) });
  const retry = useMutation({ mutationFn: (mid: string) => api(`/messages/${mid}/retry`, { method: 'POST', body: {} }), onSuccess: refetchAll, onError: (e) => toast.error(e.message) });

  if (conv.isError) return <div className="grid h-full place-items-center"><ErrorState error={conv.error} onRetry={() => conv.refetch()} /></div>;
  if (!c) return <div className="space-y-3 p-6"><Skeleton className="h-14" /><Skeleton className="h-64" /></div>;
  // Safety net: a conversation of another platform must never render inside this section.
  if (c.platform !== type) return <div className="p-6"><ErrorState error={new Error('This conversation belongs to another platform.')} /></div>;
  const name = displayName(c);
  const st = AI_STATE[c.aiState];
  const canManage = can('conversations:manage');
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-mist-200 bg-white px-4 py-3">
          <button onClick={onBack} className="rounded-lg p-1.5 text-mist-600 hover:bg-mist-100 md:hidden" aria-label="Back to the list"><ArrowLeft className="size-5" /></button>
          <span className="grid size-10 place-items-center rounded-full bg-burgundy-100 text-sm font-semibold text-burgundy-800">{initials(name)}</span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-display text-base font-semibold text-mist-900">{name}</h3>
            <p className="flex items-center gap-1.5 truncate text-xs text-mist-500"><PlatformBadge type={c.platform} size="sm" /> {c.channelName}{c.contact.phone ? ` · ${c.contact.phone}` : ''}</p>
          </div>
          {canManage ? (
            <div className="flex basis-full flex-wrap items-center gap-2">
              <select aria-label="Conversation status" value={c.status} onChange={(e) => patch.mutate({ status: e.target.value })} className="h-9 rounded-lg border border-mist-300 bg-white px-2 text-sm">
                <option value="open">Open</option><option value="pending">Waiting for a person</option><option value="resolved">Resolved</option>
              </select>
              <select aria-label="Assigned to" value={c.assignedTo?.id ?? ''} onChange={(e) => patch.mutate({ assignedUserId: e.target.value || null })} className="h-9 max-w-40 rounded-lg border border-mist-300 bg-white px-2 text-sm">
                <option value="">Unassigned</option>
                {members.data?.items.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.id === meId ? 'Me' : m.fullName}</option>)}
              </select>
              {c.handler === 'ai' ? <Button size="sm" icon={Hand} loading={takeover.isPending} onClick={() => takeover.mutate()}>Take over</Button> : <Button size="sm" variant="secondary" icon={Bot} loading={release.isPending} onClick={() => release.mutate()} disabled={c.aiState === 'no_employee'}>Hand back to AI</Button>}
            </div>
          ) : <Badge tone={st.tone}>{c.handler === 'ai' ? 'AI' : 'Person'}</Badge>}
        </header>

        <div className={clsx('flex items-center gap-2 border-b px-4 py-1.5 text-xs', st.tone === 'green' ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : st.tone === 'amber' ? 'border-amber-100 bg-amber-50 text-amber-900' : 'border-mist-200 bg-mist-100 text-mist-600')}>
          {c.handler === 'ai' ? <Bot className="size-3.5" /> : <UserRound className="size-3.5" />}{st.text}
          {c.handoffReason ? <span className="truncate opacity-80">· {c.handoffReason}</span> : null}
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4" aria-live="polite" aria-label="Messages">
          {msgs.isPending ? <Skeleton className="h-24" /> : msgs.isError ? <ErrorState error={msgs.error} onRetry={() => msgs.refetch()} /> : msgs.data.items.length === 0 ? <p className="py-10 text-center text-sm text-mist-500">No messages yet.</p> : (
            msgs.data.items.map((m, i, arr) => <Bubble key={m.id} m={m} showDate={i === 0 || new Date(arr[i - 1]!.createdAt).toDateString() !== new Date(m.createdAt).toDateString()} canForward={can('conversations:forward')} onForward={() => setForwarding(m)} onRetry={() => retry.mutate(m.id)} />)
          )}
          <div ref={bottom} />
        </div>

        {can('conversations:reply') ? <ReplyBox conv={c} onSent={refetchAll} /> : <p className="border-t border-mist-200 bg-white px-4 py-3 text-center text-sm text-mist-500">You have read-only access to conversations.</p>}
      </div>

      {info ? <Details c={c} /> : null}
      {forwarding ? <ForwardModal message={forwarding} sourceChannelId={c.channelId} onClose={() => setForwarding(null)} onDone={() => { setForwarding(null); refetchAll(); }} /> : null}
    </div>
  );
}

function Tick({ m }: { m: ChatMessage }) {
  if (m.direction === 'in') return null;
  if (m.status === 'failed') return <AlertTriangle className="size-3.5 text-red-600" aria-label="Failed" />;
  if (m.status === 'queued' || m.status === 'sending' || m.status === 'retry') return <Clock className="size-3.5 opacity-70" aria-label="Sending" />;
  if (m.status === 'read') return <CheckCheck className="size-3.5 text-sky-500" aria-label="Read" />;
  if (m.status === 'delivered') return <CheckCheck className="size-3.5 opacity-70" aria-label="Delivered" />;
  return <Check className="size-3.5 opacity-70" aria-label="Sent" />;
}

function Bubble({ m, showDate, canForward, onForward, onRetry }: { m: ChatMessage; showDate: boolean; canForward: boolean; onForward: () => void; onRetry: () => void }) {
  const out = m.direction === 'out';
  const who = m.senderType === 'ai' ? 'AI employee' : m.senderType === 'human' ? (m.senderName ?? 'Team') : m.senderType === 'system' ? 'System' : null;
  return (
    <>
      {showDate ? <p className="py-2 text-center text-[11px] font-medium text-mist-400">{new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</p> : null}
      <div className={clsx('group flex items-end gap-1.5', out ? 'justify-end' : 'justify-start')}>
        {out && canForward && m.body ? <button onClick={onForward} aria-label="Forward message" title="Forward to another channel" className="mb-1 rounded-md p-1 text-mist-400 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-mist-200"><CornerUpRight className="size-4" /></button> : null}
        <div className={clsx('max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-soft', out ? (m.senderType === 'ai' ? 'rounded-br-md bg-burgundy-50 text-mist-900 ring-1 ring-burgundy-100' : 'rounded-br-md bg-burgundy-700 text-white') : 'rounded-bl-md bg-white text-mist-900')}>
          {who ? <p className={clsx('mb-0.5 flex items-center gap-1 text-[11px] font-semibold', m.senderType === 'ai' ? 'text-burgundy-700' : 'text-burgundy-100')}>{m.senderType === 'ai' ? <Bot className="size-3" /> : null}{who}</p> : null}
          {m.meta.forward ? <p className="mb-1 flex items-center gap-1 text-[11px] opacity-80"><CornerUpRight className="size-3" />Forwarded from {platformOf(m.meta.forward.fromPlatform)?.label ?? m.meta.forward.fromPlatform}</p> : null}
          {m.body ? <p className="break-words whitespace-pre-wrap">{m.body}</p> : null}
          {m.attachments.map((a, i) => (
            <a key={i} href={`/api/v1/messages/${m.id}/attachments/${i}`} className={clsx('mt-1.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ring-1 ring-inset', out && m.senderType !== 'ai' ? 'bg-white/10 ring-white/30' : 'bg-mist-50 ring-mist-200')} download>
              <Paperclip className="size-3.5 shrink-0" /><span className="truncate">{a.name ?? a.kind}</span>{a.size ? <span className="opacity-60">{Math.max(1, Math.round(a.size / 1024))} KB</span> : null}
            </a>
          ))}
          <p className={clsx('mt-1 flex items-center justify-end gap-1 text-[11px]', out && m.senderType !== 'ai' ? 'text-burgundy-100' : 'text-mist-400')}>
            {m.forwardCount ? <span title="Forwarded">↪ {m.forwardCount}</span> : null}
            {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}<Tick m={m} />
          </p>
          {m.status === 'failed' ? <p className="mt-1 text-xs text-red-700">Not delivered: {m.error ?? 'unknown error'} <button className="font-semibold underline" onClick={onRetry}>Retry</button></p> : null}
          {m.status === 'retry' ? <p className="mt-1 text-xs text-amber-700">Delivery failed; retrying automatically (attempt {m.attempts}).</p> : null}
          {m.meta.ai?.blocked?.length ? <p className="mt-1 text-[11px] text-amber-700">A safety check replaced the AI’s first answer.</p> : null}
        </div>
      </div>
    </>
  );
}

function ReplyBox({ conv, onSent }: { conv: Conversation; onSent: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const send = useMutation({
    mutationFn: () => api<{ status: string; error?: string }>(`/conversations/${conv.id}/messages`, { body: { text, attachmentIds: files.map((f) => f.id) } }),
    onSuccess: (r) => { setText(''); setFiles([]); if (r.status === 'failed') toast.error(`Not delivered: ${r.error ?? 'error'}`); onSent(); },
    onError: (e) => toast.error(e.message),
  });
  const canFiles = conv.capabilities?.sendFiles;
  const upload = async (f: File) => {
    setUploading(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await fetch(`/api/v1/conversations/${conv.id}/attachments`, { method: 'POST', body: fd, credentials: 'include', headers: { 'X-Requested-With': 'microagent' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message ?? 'Upload failed');
      setFiles((x) => [...x, { id: j.id, name: j.name }]);
    } catch (e) { toast.error((e as Error).message); } finally { setUploading(false); }
  };
  const disabled = !['connected', 'awaiting_approval'].includes(conv.channelStatus);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (text.trim() || files.length) send.mutate(); }} className="border-t border-mist-200 bg-white p-3">
      {conv.handler === 'ai' && conv.aiState === 'ai_answering' ? <p className="mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900">The AI employee is answering this conversation. Sending a message takes it over.</p> : null}
      {disabled ? <p className="mb-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-800">This channel is not connected, so messages cannot be sent. Reconnect it in Channels.</p> : null}
      {files.length ? <ul className="mb-2 flex flex-wrap gap-1.5">{files.map((f) => <li key={f.id} className="flex items-center gap-1 rounded-full bg-mist-100 py-0.5 pr-1 pl-2.5 text-xs"><Paperclip className="size-3" />{f.name}<button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} className="rounded-full p-0.5 hover:bg-mist-200"><X className="size-3" /></button></li>)}</ul> : null}
      <div className="flex items-end gap-2">
        {canFiles ? (
          <label className={clsx('grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl text-mist-500 hover:bg-mist-100', uploading && 'opacity-50')} title="Attach a file (max 5 MB)">
            <Paperclip className="size-5" /><span className="sr-only">Attach a file</span>
            <input type="file" className="sr-only" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          </label>
        ) : null}
        <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} rows={1} maxLength={8000} placeholder="Write a reply… (Enter = send)" aria-label="Reply" className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-mist-300 px-3.5 py-2 text-sm focus:border-burgundy-500 focus:ring-4 focus:ring-burgundy-100 focus:outline-none" />
        <Button type="submit" icon={Send} loading={send.isPending} disabled={disabled || (!text.trim() && files.length === 0)}>Send</Button>
      </div>
      {!canFiles ? <p className="mt-1.5 text-[11px] text-mist-400">Sending files is not available on this channel yet (text only).</p> : null}
    </form>
  );
}

function Details({ c }: { c: Conversation }) {
  const st = AI_STATE[c.aiState];
  const L = ({ k, v }: { k: string; v: string | null | undefined }) => (v ? <div><dt className="text-[11px] tracking-wide text-mist-400 uppercase">{k}</dt><dd className="text-sm text-mist-800">{v}</dd></div> : null);
  return (
    <aside className="hidden w-72 shrink-0 space-y-5 overflow-y-auto border-l border-mist-200 bg-white p-5 xl:block" aria-label="Customer details">
      <div className="text-center">
        <span className="mx-auto grid size-16 place-items-center rounded-full bg-burgundy-100 text-xl font-semibold text-burgundy-800">{initials(displayName(c))}</span>
        <p className="mt-2 font-display text-base font-semibold text-mist-900">{displayName(c)}</p>
        <p className="text-xs text-mist-500">{platformOf(c.platform)?.label} customer</p>
      </div>
      <dl className="space-y-3">
        <L k="Phone" v={c.contact.phone} />
        <L k="Channel" v={c.channelName} />
        <L k="First contact" v={new Date(c.contact.firstSeenAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} />
        <L k="Messages" v={c.stats ? `${c.stats.messages} (${c.stats.inbound} from the customer)` : null} />
        <L k="Status" v={c.status === 'pending' ? 'Waiting for a person' : c.status[0]!.toUpperCase() + c.status.slice(1)} />
        <L k="Assigned to" v={c.assignedTo?.name ?? 'Nobody'} />
        <L k="AI employee" v={c.employeeName ?? 'None on this channel'} />
      </dl>
      <div className="rounded-xl bg-mist-50 p-3 text-[13px] text-mist-700"><Badge tone={st.tone}>{c.handler === 'ai' ? 'AI' : 'Person'}</Badge><p className="mt-1.5">{st.text}</p>{c.handoffReason ? <p className="mt-1.5 text-mist-500">Why: {c.handoffReason}</p> : null}</div>
      {c.capabilities?.replyWindowHours ? <p className="text-xs text-mist-500">{platformOf(c.platform)?.label} only lets you reply within {c.capabilities.replyWindowHours} hours of the customer’s last message.</p> : null}
    </aside>
  );
}

/* ───────────────────────── forwarding ───────────────────────── */
function ForwardModal({ message, sourceChannelId, onClose, onDone }: { message: ChatMessage; sourceChannelId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const channels = useQuery({ queryKey: ['channels'], queryFn: () => api<{ items: Channel[] }>('/channels') });
  const targets = (channels.data?.items ?? []).filter((c) => c.id !== sourceChannelId && ['connected', 'awaiting_approval'].includes(c.status) && c.type !== 'website');
  const [target, setTarget] = useState('');
  const [searchText, setSearchText] = useState('');
  const [recipient, setRecipient] = useState('');
  const [comment, setComment] = useState('');
  const contacts = useQuery({ queryKey: ['channels', target, 'contacts', searchText], queryFn: () => api<{ items: Array<{ id: string; name: string | null; phone: string | null }> }>(`/channels/${target}/contacts?search=${encodeURIComponent(searchText)}`), enabled: !!target });
  const body = { targetChannelId: target, recipientContactId: recipient, comment: comment.trim() || undefined };
  const preview = useMutation({ mutationFn: () => api<{ text: string; warnings: string[]; note: string; target: { channelName: string }; recipient: { name: string | null; phone: string | null } }>(`/messages/${message.id}/forward/preview`, { body }) });
  const send = useMutation({
    mutationFn: () => api<{ status: string; error: string | null }>(`/messages/${message.id}/forward`, { body }),
    onSuccess: (r) => { toast.success(r.status === 'sent' ? 'Forwarded' : 'Forward queued'); onDone(); },
  });
  useEffect(() => { preview.reset(); }, [target, recipient, comment]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = target && recipient;
  return (
    <Modal open onClose={onClose} title="Forward to another channel" description="Sends a NEW message to a person on another connected channel that says where it came from. No platform forwards natively to another platform.">
      <div className="space-y-4">
        <FormError error={preview.error ?? send.error} />
        <blockquote className="rounded-xl border-l-4 border-burgundy-300 bg-mist-50 px-3.5 py-2.5 text-sm text-mist-700">{message.body}</blockquote>
        <div>
          <p className="mb-1.5 text-sm font-medium text-mist-800">1. Channel to send to</p>
          {targets.length === 0 ? <p className="text-sm text-mist-500">No other connected channel yet. Connect one in Channels first.</p> : (
            <select aria-label="Target channel" value={target} onChange={(e) => { setTarget(e.target.value); setRecipient(''); }} className="h-11 w-full rounded-xl border border-mist-300 bg-white px-3 text-sm">
              <option value="">Choose a channel…</option>{targets.map((c) => <option key={c.id} value={c.id}>{platformOf(c.type)?.label} · {c.name}</option>)}
            </select>
          )}
        </div>
        {target ? (
          <div>
            <p className="mb-1.5 text-sm font-medium text-mist-800">2. Recipient (someone who has written to that channel)</p>
            <TextField label="Search recipients" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
            <ul className="mt-2 max-h-36 divide-y divide-mist-100 overflow-y-auto rounded-xl border border-mist-200">
              {contacts.data?.items.length === 0 ? <li className="px-3 py-2 text-sm text-mist-500">Nobody found.</li> : contacts.data?.items.map((p) => (
                <li key={p.id}><label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-mist-50"><input type="radio" name="recipient" className="accent-burgundy-700" checked={recipient === p.id} onChange={() => setRecipient(p.id)} />{p.name ?? p.phone ?? 'Customer'}{p.phone && p.name ? <span className="text-mist-400">{p.phone}</span> : null}</label></li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-amber-800">Privacy: the customer’s words are sent to that person. Forward only to colleagues or people who should see it.</p>
          </div>
        ) : null}
        {ready ? <TextAreaField label="3. Add a comment (optional)" rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} /> : null}
        {preview.data ? (
          <div className="space-y-2" data-testid="forward-preview">
            <p className="text-sm font-medium text-mist-800">Preview: this is exactly what will be sent to {preview.data.recipient.name ?? preview.data.recipient.phone} on {preview.data.target.channelName}</p>
            <pre className="rounded-xl bg-burgundy-50 px-3.5 py-3 text-sm whitespace-pre-wrap text-mist-900 ring-1 ring-burgundy-100">{preview.data.text}</pre>
            {preview.data.warnings.map((w) => <p key={w} className="flex gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{w}</p>)}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {!preview.data ? <Button icon={RefreshCw} loading={preview.isPending} disabled={!ready} onClick={() => preview.mutate()}>Preview</Button> : <Button icon={CornerUpRight} loading={send.isPending} onClick={() => send.mutate()}>Send forward</Button>}
        </div>
      </div>
    </Modal>
  );
}
