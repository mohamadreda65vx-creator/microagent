import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailPlus, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Invitation, Member, Role } from '../../lib/types';
import { Badge, Button, Card, EmptyState, ErrorState, FormError, Modal, SelectField, Skeleton, TextField } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';

const roleLabel: Record<string, string> = { owner: 'Owner', admin: 'Admin', manager: 'Manager', viewer: 'Viewer' };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Never');

function assignable(actor: Role): Array<'admin' | 'manager' | 'viewer'> {
  return actor === 'owner' ? ['admin', 'manager', 'viewer'] : actor === 'admin' ? ['manager', 'viewer'] : [];
}
function canManage(actor: Role, target: Role): boolean {
  if (target === 'owner' || target === 'platform_admin') return false;
  return actor === 'owner' || (actor === 'admin' && (target === 'manager' || target === 'viewer'));
}

function InviteForm({ onDone }: { onDone: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = assignable(me!.user.role);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(roles[roles.length - 1] ?? 'viewer');
  const m = useMutation({
    mutationFn: () => api('/team/invitations', { body: { email: email.trim(), role } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['team'] });
      toast.success(`Invitation sent to ${email.trim()}`);
      onDone();
    },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      <FormError error={m.error} />
      <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
        {roles.map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}
      </SelectField>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" loading={m.isPending} disabled={!email}>Send invitation</Button>
      </div>
    </form>
  );
}

export default function Team() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const manage = can('team:manage');

  const members = useQuery({ queryKey: ['team', 'members'], queryFn: () => api<{ items: Member[] }>('/team/members') });
  const invites = useQuery({ queryKey: ['team', 'invitations'], queryFn: () => api<{ items: Invitation[] }>('/team/invitations') });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: string; status?: string }) => api(`/team/members/${id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['team'] }), qc.invalidateQueries({ queryKey: ['overview'] })]);
      toast.success('Team member updated');
    },
    onError: (e) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/team/invitations/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['team'] }), qc.invalidateQueries({ queryKey: ['overview'] })]);
      toast.success('Invitation revoked');
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-mist-900">Team</h2>
          <p className="mt-1 text-[15px] text-mist-500">People who can access this workspace.</p>
        </div>
        {manage ? <Button icon={MailPlus} onClick={() => setInviting(true)}>Invite teammate</Button> : null}
      </div>

      <Card className="overflow-hidden">
        {members.isPending ? (
          <div className="space-y-3 p-5" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : members.isError ? (
          <ErrorState error={members.error} onRetry={() => members.refetch()} />
        ) : (
          <ul className="divide-y divide-mist-100">
            {members.data.items.map((m) => {
              const editable = manage && me && m.id !== me.user.id && canManage(me.user.role, m.role);
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
                  <div className="grid size-10 shrink-0 place-items-center rounded-full bg-burgundy-100 text-sm font-semibold text-burgundy-800">{m.fullName[0]?.toUpperCase()}</div>
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm font-medium text-mist-900">{m.fullName}{m.id === me?.user.id ? <span className="ml-1.5 text-mist-400">(you)</span> : null}</p>
                    <p className="truncate text-[13px] text-mist-500">{m.email}</p>
                  </div>
                  <p className="hidden text-[13px] text-mist-500 md:block">Last login: {fmt(m.lastLoginAt)}</p>
                  {m.status === 'disabled' ? <Badge tone="red">Disabled</Badge> : null}
                  {editable ? (
                    <>
                      <select
                        aria-label={`Role for ${m.fullName}`}
                        value={m.role}
                        disabled={update.isPending}
                        onChange={(e) => update.mutate({ id: m.id, role: e.target.value })}
                        className="h-9 rounded-lg border border-mist-300 bg-white px-2.5 text-sm focus:border-burgundy-500 focus:ring-4 focus:ring-burgundy-100 focus:outline-none"
                      >
                        {assignable(me!.user.role).map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}
                      </select>
                      <Button size="sm" variant={m.status === 'active' ? 'danger' : 'secondary'} disabled={update.isPending} onClick={() => update.mutate({ id: m.id, status: m.status === 'active' ? 'disabled' : 'active' })}>
                        {m.status === 'active' ? 'Disable' : 'Enable'}
                      </Button>
                    </>
                  ) : (
                    <Badge tone={m.role === 'owner' ? 'burgundy' : 'gray'}>{roleLabel[m.role]}</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div>
        <h3 className="mb-3 font-display text-lg font-semibold text-mist-900">Pending invitations</h3>
        <Card>
          {invites.isPending ? (
            <div className="p-5"><Skeleton className="h-10" /></div>
          ) : invites.isError ? (
            <ErrorState error={invites.error} onRetry={() => invites.refetch()} />
          ) : invites.data.items.length === 0 ? (
            <EmptyState icon={MailPlus} title="No pending invitations" description="Invitations you send will wait here until they’re accepted." />
          ) : (
            <ul className="divide-y divide-mist-100">
              {invites.data.items.map((i) => (
                <li key={i.id} className="flex items-center gap-4 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-mist-900">{i.email}</p>
                    <p className="text-[13px] text-mist-500">{roleLabel[i.role]} · expires {fmt(i.expiresAt)}</p>
                  </div>
                  {manage ? <Button size="sm" variant="ghost" icon={X} loading={revoke.isPending && revoke.variables === i.id} onClick={() => revoke.mutate(i.id)}>Revoke</Button> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal open={inviting} onClose={() => setInviting(false)} title="Invite a teammate" description="They’ll get an email with a link to join this workspace.">
        {inviting ? <InviteForm onDone={() => setInviting(false)} /> : null}
      </Modal>
    </div>
  );
}
