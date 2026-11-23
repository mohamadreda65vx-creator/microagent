import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Copy, Plug, Plus, QrCode, RefreshCw, Settings2, Trash2, Unplug } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, FormError, Modal, SelectField, Skeleton, TextAreaField, TextField } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ALL_PLATFORMS, PlatformBadge } from '../../lib/platforms';
import type { AiEmployee, CatalogItem, Channel, ChannelStatus } from '../../lib/types';

const STATUS: Record<ChannelStatus, { label: string; tone: 'gray' | 'green' | 'amber' | 'red' }> = {
  pending: { label: 'Not connected', tone: 'gray' },
  connecting: { label: 'Waiting for QR scan', tone: 'amber' },
  connected: { label: 'Connected', tone: 'green' },
  disconnected: { label: 'Disconnected', tone: 'red' },
  error: { label: 'Needs reconnecting', tone: 'red' },
  awaiting_approval: { label: 'Awaiting Meta approval', tone: 'amber' },
  not_configured: { label: 'Server not configured', tone: 'gray' },
};
const HEALTH: Record<Channel['healthStatus'], { label: string; dot: string }> = {
  healthy: { label: 'Healthy', dot: 'bg-emerald-500' },
  degraded: { label: 'Degraded', dot: 'bg-amber-500' },
  down: { label: 'Down', dot: 'bg-red-500' },
  unknown: { label: 'Not checked yet', dot: 'bg-mist-300' },
};
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};

export default function Channels() {
  const { can } = useAuth();
  const manage = can('channels:manage');
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const catalog = useQuery({ queryKey: ['channels', 'catalog'], queryFn: () => api<{ vaultConfigured: boolean; publicHttps: boolean; items: CatalogItem[] }>('/channels/catalog') });
  const list = useQuery({ queryKey: ['channels'], queryFn: () => api<{ items: Channel[] }>('/channels'), refetchInterval: 15_000 });
  const [adding, setAdding] = useState<CatalogItem | null>(null);
  const [setup, setSetup] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Channel | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  // Coming back from Facebook login: ?channel=ID&meta=select | ?meta_error=...
  useEffect(() => {
    const ch = params.get('channel');
    if (params.get('meta_error')) setMetaError(params.get('meta_error'));
    if (ch) setSetup(ch);
    if (ch || params.get('meta_error')) setParams({}, { replace: true });
  }, [params, setParams]);

  const items = list.data?.items ?? [];
  const setupChannel = items.find((c) => c.id === setup) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-mist-900">Channels</h2>
        <p className="mt-1 text-[15px] text-mist-500">Connect the places your customers write to you. Each connection is private to your company.</p>
      </div>

      {catalog.data && !catalog.data.vaultConfigured ? (
        <div role="alert" className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>The server has no <code>CHANNEL_SECRET_KEY</code>, so channels cannot be created. Ask whoever runs the server to set it (see the deploy guide).</p>
        </div>
      ) : null}

      {manage ? (
        <section aria-label="Add a channel">
          <h3 className="mb-3 text-sm font-semibold tracking-wide text-mist-500 uppercase">Add a channel</h3>
          {catalog.isPending ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
          ) : catalog.isError ? (
            <Card><ErrorState error={catalog.error} onRetry={() => catalog.refetch()} /></Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {catalog.data.items.map((c) => (
                <Card key={c.type} className="flex items-start gap-3 p-4">
                  <PlatformBadge type={c.type} size="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 font-medium text-mist-900">
                      {c.label}
                      {c.unofficial ? <Badge tone="amber">Unofficial</Badge> : null}
                      {!c.available ? <Badge>Coming later</Badge> : null}
                      {c.available && (c.type === 'messenger' || c.type === 'instagram') ? <Badge tone="amber">Not verified</Badge> : null}
                    </p>
                    <p className="mt-0.5 text-[13px] text-mist-500">{c.setup === 'qr' ? 'Link a phone with a QR code' : c.setup === 'token' ? 'Paste your bot token' : c.setup === 'oauth' ? 'Log in with Facebook' : c.setup === 'none' && c.available ? 'Embed a chat widget on your site' : 'Planned for a later release'}</p>
                    <Button size="sm" variant="secondary" className="mt-2.5" icon={Plus} disabled={!c.available} onClick={() => setAdding(c)}>Add</Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <section aria-label="Your channels" className="space-y-3">
        <h3 className="text-sm font-semibold tracking-wide text-mist-500 uppercase">Your channels</h3>
        {list.isPending ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : list.isError ? (
          <Card><ErrorState error={list.error} onRetry={() => list.refetch()} /></Card>
        ) : items.length === 0 ? (
          <Card><EmptyState icon={Plug} title="No channels yet" description={manage ? 'Add your first channel above. Your AI employees answer customers there once a channel is connected and an employee is assigned.' : 'An owner or admin can connect channels.'} /></Card>
        ) : (
          items.map((c) => <ChannelCard key={c.id} channel={c} manage={manage} onSetup={() => setSetup(c.id)} onDetails={() => setDetails(c.id)} onRemove={() => setRemoving(c)} />)
        )}
      </section>

      {adding ? <AddChannel item={adding} onClose={() => setAdding(null)} onCreated={(id) => { setAdding(null); setSetup(id); void qc.invalidateQueries({ queryKey: ['channels'] }); }} /> : null}
      {setupChannel ? <SetupModal channel={setupChannel} metaError={metaError} onClose={() => { setSetup(null); setMetaError(null); void qc.invalidateQueries({ queryKey: ['channels'] }); }} /> : null}
      {details ? <DetailsModal id={details} onClose={() => setDetails(null)} /> : null}
      <RemoveModal channel={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); toast.success('Channel deleted'); void qc.invalidateQueries({ queryKey: ['channels'] }); void qc.invalidateQueries({ queryKey: ['conversations'] }); }} />
    </div>
  );
}

/* ───────────────────────── channel card ───────────────────────── */
function ChannelCard({ channel: c, manage, onSetup, onDetails, onRemove }: { channel: Channel; manage: boolean; onSetup: () => void; onDetails: () => void; onRemove: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useQuery({ queryKey: ['ai-employees'], queryFn: () => api<{ items: AiEmployee[] }>('/ai-employees') });
  const st = STATUS[c.status];
  const patch = useMutation({
    mutationFn: (body: object) => api(`/channels/${c.id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
    onError: (e) => toast.error(e.message),
  });
  const health = useMutation({
    mutationFn: () => api<{ status: string; detail?: string }>(`/channels/${c.id}/health-check`, { method: 'POST', body: {} }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['channels'] }); r.status === 'healthy' ? toast.success('Channel is healthy') : toast.error(r.detail ?? `Channel is ${r.status}`); },
    onError: (e) => toast.error(e.message),
  });
  const disconnect = useMutation({
    mutationFn: () => api(`/channels/${c.id}/disconnect`, { method: 'POST', body: {} }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['channels'] }); toast.success('Disconnected'); },
    onError: (e) => toast.error(e.message),
  });
  const live = ['connected', 'awaiting_approval'].includes(c.status);
  const emp = employees.data?.items.find((e) => e.id === c.employeeId);
  const answering = live && c.autoReply && emp?.status === 'active';
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <PlatformBadge type={c.type} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-display text-base font-semibold text-mist-900">{c.name}</h4>
            <Badge tone={st.tone}>{st.label}</Badge>
            {c.unofficial ? <Badge tone="amber">Unofficial connection</Badge> : null}
          </div>
          <p className="mt-0.5 text-[13px] text-mist-500">{ALL_PLATFORMS.find((p) => p.type === c.type)?.label}{c.account ? ` · ${c.account}` : ''}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {manage && ['pending', 'disconnected', 'error', 'connecting', 'not_configured'].includes(c.status) && c.type !== 'website' ? <Button size="sm" icon={c.type === 'whatsapp' ? QrCode : Plug} onClick={onSetup} disabled={c.status === 'not_configured'}>{c.status === 'connecting' ? 'Show QR code' : c.status === 'pending' ? 'Connect' : 'Reconnect'}</Button> : null}
          {manage && c.status === 'awaiting_approval' ? <Button size="sm" variant="secondary" icon={RefreshCw} onClick={onSetup}>Change page</Button> : null}
          {manage && c.type === 'website' ? <Button size="sm" variant="secondary" icon={Settings2} onClick={onSetup}>Settings &amp; embed code</Button> : null}
          {manage && live && c.type !== 'website' ? <Button size="sm" variant="secondary" icon={RefreshCw} loading={health.isPending} onClick={() => health.mutate()}>Check health</Button> : null}
          <Button size="sm" variant="secondary" onClick={onDetails}>Details</Button>
          {manage && c.type !== 'website' && (live || c.status === 'connecting') ? <Button size="sm" variant="secondary" icon={Unplug} loading={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button> : null}
          {manage ? <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete ${c.name}`} onClick={onRemove} /> : null}
        </div>
      </div>

      {c.status === 'awaiting_approval' ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900">Connected to Meta but <strong>not verified</strong>. This changes to “Connected” only when the first real customer message arrives. Meta requires app review before customers outside your team can reach this channel.</p>
      ) : null}
      {c.lastError && !['connected'].includes(c.status) ? <p className="mt-3 rounded-xl bg-red-50 px-3.5 py-2.5 text-[13px] text-red-800">Last problem: {c.lastError}</p> : null}

      <div className="mt-4 grid gap-4 border-t border-mist-100 pt-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <div>
          <SelectField label="AI employee answering here" value={c.employeeId ?? ''} disabled={!manage || patch.isPending} onChange={(e) => patch.mutate({ employeeId: e.target.value || null })}>
            <option value="">No AI employee (people answer)</option>
            {employees.data?.items.map((e) => <option key={e.id} value={e.id}>{e.name}{e.status !== 'active' ? ` (${e.status})` : ''}</option>)}
          </SelectField>
          <p className={clsx('mt-1.5 text-[12.5px]', answering ? 'text-emerald-700' : 'text-mist-500')}>
            {!c.employeeId ? 'Nobody is assigned: messages wait for your team.' : emp?.status !== 'active' ? `${emp?.name ?? 'This employee'} is not live yet. Test and activate it in AI Employees; until then your team answers.` : !c.autoReply ? 'Auto-reply is off: your team answers.' : !live ? 'Connect the channel to start answering.' : `${emp.name} is answering new conversations.`}
          </p>
        </div>
        <label className="flex items-center gap-2 pb-6 text-sm text-mist-700">
          <input type="checkbox" className="size-4 accent-burgundy-700" checked={c.autoReply} disabled={!manage || patch.isPending} onChange={(e) => patch.mutate({ autoReply: e.target.checked })} />
          Auto-reply
        </label>
        <dl className="grid grid-cols-3 gap-4 pb-1 text-center text-xs text-mist-500 sm:pb-6">
          <div><dd className="text-lg font-semibold text-mist-900 tabular-nums">{c.conversations}</dd><dt>Chats</dt></div>
          <div><dd className="text-lg font-semibold text-mist-900 tabular-nums">{c.unread}</dd><dt>Unread</dt></div>
          <div><dd className={clsx('text-lg font-semibold tabular-nums', c.failedMessages ? 'text-red-700' : 'text-mist-900')}>{c.failedMessages}</dd><dt>Failed</dt></div>
        </dl>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mist-500">
        <span className="inline-flex items-center gap-1.5"><span className={clsx('size-2 rounded-full', HEALTH[c.healthStatus].dot)} />{HEALTH[c.healthStatus].label}{c.lastHealthAt ? ` · checked ${ago(c.lastHealthAt)}` : ''}</span>
        <span>Last message received: {ago(c.lastInboundAt)}</span>
        <span>Last sent: {ago(c.lastOutboundAt)}</span>
      </p>
    </Card>
  );
}

/* ───────────────────────── add ───────────────────────── */
function AddChannel({ item, onClose, onCreated }: { item: CatalogItem; onClose: () => void; onCreated: (id: string) => void }) {
  const employees = useQuery({ queryKey: ['ai-employees'], queryFn: () => api<{ items: AiEmployee[] }>('/ai-employees') });
  const [name, setName] = useState(`${item.label}`);
  const [employeeId, setEmployeeId] = useState('');
  const create = useMutation({
    mutationFn: () => api<Channel>('/channels', { body: { type: item.type, name: name.trim(), employeeId: employeeId || null } }),
    onSuccess: (c) => onCreated(c.id),
  });
  return (
    <Modal open onClose={onClose} title={`Add ${item.label}`} description="Give it a name your team will recognise. You connect it in the next step.">
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }} className="space-y-4">
        <FormError error={create.error} />
        {item.notes.length ? (
          <ul className="space-y-1.5 rounded-xl bg-mist-50 p-3.5 text-[13px] text-mist-700">
            {item.notes.map((n) => <li key={n} className="flex gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />{n}</li>)}
          </ul>
        ) : null}
        <TextField label="Channel name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <SelectField label="AI employee that answers here (optional)" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">None yet</option>
          {employees.data?.items.map((e) => <option key={e.id} value={e.id}>{e.name}{e.status !== 'active' ? ` (${e.status})` : ''}</option>)}
        </SelectField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────────────────── connect / settings ───────────────────────── */
function SetupModal({ channel: c, metaError, onClose }: { channel: Channel; metaError: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [polling, setPolling] = useState(c.status === 'connecting');

  const connect = useMutation({
    mutationFn: () => api<{ status: ChannelStatus; qr: string | null }>(c.status === 'disconnected' || c.status === 'error' || c.status === 'connecting' ? `/channels/${c.id}/reconnect` : `/channels/${c.id}/connect`, { body: c.type === 'telegram' ? { botToken: token.trim() } : {} }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['channels'] });
      if (r.status === 'connected') { toast.success(`${c.name} is connected`); onClose(); }
      else if (r.qr) { setQr(r.qr); setPolling(true); }
    },
  });

  // WhatsApp: poll while the QR is on screen; the code refreshes by itself about once a minute.
  const status = useQuery({
    queryKey: ['channels', c.id, 'status'],
    queryFn: () => api<{ status: ChannelStatus; state: string; qr: string | null; detail: string | null }>(`/channels/${c.id}/status`),
    enabled: c.type === 'whatsapp' && polling,
    refetchInterval: 3000,
    retry: false,
  });
  useEffect(() => {
    if (status.data?.qr) setQr(status.data.qr);
    if (status.data?.state === 'connected') { toast.success('WhatsApp is connected'); void qc.invalidateQueries({ queryKey: ['channels'] }); onClose(); }
  }, [status.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const oauth = useMutation({
    mutationFn: () => api<{ url: string }>(`/channels/${c.id}/oauth/start`),
    onSuccess: (r) => { window.location.href = r.url; },
  });
  const pick = useMutation({
    mutationFn: (pageId: string) => api<{ status: ChannelStatus; message: string | null }>(`/channels/${c.id}/meta/select-page`, { body: { pageId } }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['channels'] }); toast.success(r.message ?? 'Connected'); onClose(); },
  });

  if (c.type === 'website') return <WebsiteSettings channel={c} onClose={onClose} />;
  return (
    <Modal open onClose={onClose} title={`Connect ${c.name}`}>
      <div className="space-y-4">
        <FormError error={connect.error ?? oauth.error ?? pick.error ?? status.error} />
        {metaError ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">{metaError}</div> : null}

        {c.type === 'telegram' ? (
          <form onSubmit={(e) => { e.preventDefault(); connect.mutate(); }} className="space-y-4">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-mist-700">
              <li>In Telegram, open <strong>@BotFather</strong> and send <code>/newbot</code>.</li>
              <li>Copy the token it gives you (looks like <code>123456789:ABC…</code>).</li>
              <li>Paste it here. We register the webhook for you.</li>
            </ol>
            <TextField label="Bot token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} hint="Stored encrypted on the server. It is never shown again." />
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={connect.isPending} disabled={token.trim().length < 20}>Connect bot</Button></div>
          </form>
        ) : null}

        {c.type === 'whatsapp' ? (
          <div className="space-y-4">
            <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900">This is an <strong>unofficial</strong> connection (WhatsApp Web). WhatsApp can restrict numbers used this way. Use it for testing and keep a plan to move to the official WhatsApp Cloud API. Your company gets its own private session; it is never shared.</p>
            {qr ? (
              <div className="text-center">
                <img src={qr} alt="WhatsApp QR code" className="mx-auto size-56 rounded-xl border border-mist-200 bg-white p-2" />
                <ol className="mx-auto mt-3 max-w-xs list-decimal space-y-1 pl-5 text-left text-[13px] text-mist-700">
                  <li>Open WhatsApp on the phone.</li>
                  <li>Settings → Linked devices → Link a device.</li>
                  <li>Scan this code. This page updates by itself.</li>
                </ol>
                <p className="mt-2 text-xs text-mist-500">Waiting for the scan… the code refreshes automatically.</p>
              </div>
            ) : (
              <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={QrCode} loading={connect.isPending} onClick={() => connect.mutate()}>Generate QR code</Button></div>
            )}
          </div>
        ) : null}

        {c.type === 'messenger' || c.type === 'instagram' ? (
          c.pendingPages.length ? (
            <div className="space-y-3">
              <p className="text-sm text-mist-700">Choose the {c.type === 'instagram' ? 'Instagram account (through its Facebook Page)' : 'Facebook Page'} to connect:</p>
              <ul className="space-y-2">
                {c.pendingPages.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => pick.mutate(p.id)} disabled={pick.isPending} className="flex w-full items-center gap-3 rounded-xl border border-mist-200 p-3 text-left hover:border-burgundy-300 hover:bg-burgundy-50/40 disabled:opacity-60">
                      <PlatformBadge type={c.type} /> <span className="font-medium text-mist-900">{c.type === 'instagram' && p.igUsername ? `@${p.igUsername}` : p.name}</span>
                      {c.type === 'instagram' ? <span className="text-xs text-mist-500">via {p.name}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900">Prepared but <strong>not verified with Meta</strong>. It needs a Meta app with approved permissions (App Review) and a public HTTPS address. After you log in and choose a page, the channel stays “Awaiting Meta approval” until a real message arrives.</p>
              <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={oauth.isPending} onClick={() => oauth.mutate()}>Connect with Facebook</Button></div>
            </div>
          )
        ) : null}
      </div>
    </Modal>
  );
}

function WebsiteSettings({ channel: c, onClose }: { channel: Channel; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(c.config.title ?? c.name);
  const [welcome, setWelcome] = useState(c.config.welcome ?? 'Hi! How can we help you?');
  const [color, setColor] = useState(c.config.color ?? '#8B1E3F');
  const [origins, setOrigins] = useState((c.config.allowedOrigins ?? []).join('\n'));
  const snippet = useMemo(() => `<script src="${window.location.origin}/api/v1/widget.js" data-key="${c.publicKey}" async></script>`, [c.publicKey]);
  const list = origins.split('\n').map((o) => o.trim()).filter(Boolean);
  const bad = list.find((o) => { try { return new URL(o).origin !== o.replace(/\/+$/, ''); } catch { return true; } });
  const save = useMutation({
    mutationFn: () => api(`/channels/${c.id}`, { method: 'PATCH', body: { config: { title, welcome, color, allowedOrigins: list.map((o) => o.replace(/\/+$/, '')) } } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['channels'] }); toast.success('Widget settings saved'); },
  });
  return (
    <Modal open onClose={onClose} title="Website chat widget" description="Paste the embed code before </body> on every page where the chat should appear.">
      <div className="space-y-4">
        <FormError error={save.error} />
        <div>
          <p className="mb-1.5 text-sm font-medium text-mist-800">Embed code</p>
          <div className="flex items-start gap-2 rounded-xl bg-mist-900 p-3 text-xs text-mist-100">
            <code className="min-w-0 flex-1 break-all">{snippet}</code>
            <button aria-label="Copy embed code" className="rounded-md p-1.5 hover:bg-white/10" onClick={() => { void navigator.clipboard?.writeText(snippet); toast.success('Copied'); }}><Copy className="size-4" /></button>
          </div>
        </div>
        <TextField label="Chat title" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
        <TextField label="Welcome message" value={welcome} maxLength={300} onChange={(e) => setWelcome(e.target.value)} />
        <label className="flex items-center gap-3 text-sm text-mist-800">Colour <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 cursor-pointer rounded-lg border border-mist-300" aria-label="Widget colour" /></label>
        <TextAreaField label="Allowed websites (one per line)" rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://www.your-shop.com" error={bad ? `“${bad}” is not a valid origin (use https://domain, no path)` : undefined}
          hint={list.length === 0 ? 'Empty = any website can embed this chat. Add your domain to restrict it.' : 'Only these websites can load the chat in a browser.'} />
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={save.isPending} disabled={!!bad} onClick={() => save.mutate()}>Save settings</Button></div>
      </div>
    </Modal>
  );
}

/* ───────────────────────── details & health ───────────────────────── */
function DetailsModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['channels', id], queryFn: () => api<Channel>(`/channels/${id}`), refetchInterval: 10_000 });
  const c = q.data;
  return (
    <Modal open onClose={onClose} title={c ? `${c.name}: details` : 'Details'}>
      {!c ? <Skeleton className="h-40" /> : (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5">
            <Row k="Status" v={STATUS[c.status].label} />
            <Row k="Health" v={HEALTH[c.healthStatus].label} />
            <Row k="Last health check" v={ago(c.lastHealthAt)} />
            <Row k="Consecutive send failures" v={String(c.consecutiveFailures)} />
            <Row k="Webhook problems (24h)" v={`${c.last24h?.rejected ?? 0} rejected · ${c.last24h?.errors ?? 0} errors`} />
            <Row k="Duplicate deliveries ignored (24h)" v={String(c.last24h?.duplicates ?? 0)} />
            <Row k="Reply window" v={c.capabilities.replyWindowHours ? `${c.capabilities.replyWindowHours} hours after the customer’s last message` : 'No limit'} />
            <Row k="Files" v={c.capabilities.sendFiles ? 'Can send files' : 'Text only (for now)'} />
          </dl>
          {c.lastError ? <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-[13px] text-red-800">Last problem ({ago(c.lastErrorAt)}): {c.lastError}</p> : null}
          {c.webhookUrl ? <div><p className="mb-1 text-xs font-medium text-mist-500 uppercase">Webhook address (set automatically)</p><code className="block rounded-lg bg-mist-100 px-3 py-2 text-xs break-all">{c.webhookUrl}</code></div> : null}
          <div>
            <p className="mb-1.5 text-xs font-medium text-mist-500 uppercase">Recent provider events</p>
            {c.recentEvents?.length ? (
              <ul className="max-h-48 divide-y divide-mist-100 overflow-y-auto rounded-xl border border-mist-200">
                {c.recentEvents.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <Badge tone={e.status === 'processed' ? 'green' : e.status === 'duplicate' ? 'gray' : e.status === 'ignored' ? 'gray' : 'red'}>{e.status}</Badge>
                    <span className="font-medium text-mist-800">{e.kind}</span><span className="min-w-0 flex-1 truncate text-mist-500">{e.detail}</span><span className="text-mist-400">{ago(e.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-mist-500">Nothing received yet.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}
const Row = ({ k, v }: { k: string; v: string }) => (<div><dt className="text-xs text-mist-500">{k}</dt><dd className="font-medium text-mist-900">{v}</dd></div>);

function RemoveModal({ channel, onClose, onDone }: { channel: Channel | null; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const del = useMutation({ mutationFn: () => api(`/channels/${channel!.id}?confirm=DELETE`, { method: 'DELETE' }), onSuccess: onDone });
  useEffect(() => setText(''), [channel]);
  return (
    <Modal open={channel !== null} onClose={onClose} title={`Delete ${channel?.name ?? ''}?`} description="This disconnects it and permanently deletes every conversation and message stored for this channel.">
      <div className="space-y-4">
        <FormError error={del.error} />
        <TextField label="Type DELETE to confirm" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" icon={CheckCircle2} loading={del.isPending} disabled={text !== 'DELETE'} onClick={() => del.mutate()}>Delete channel</Button></div>
      </div>
    </Modal>
  );
}
