import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { TenantInfo } from '../../lib/types';
import { Badge, Button, Card, ErrorState, FormError, Skeleton, TextField } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <h3 className="font-display text-lg font-semibold text-mist-900">{title}</h3>
      <p className="mt-1 mb-5 text-sm text-mist-500">{description}</p>
      {children}
    </Card>
  );
}

export default function Settings() {
  const { me, can, setProfileName } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can('settings:manage');

  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<TenantInfo>('/tenant') });
  const [businessName, setBusinessName] = useState('');
  const [fullName, setFullName] = useState(me?.user.fullName ?? '');
  useEffect(() => {
    if (tenant.data) setBusinessName(tenant.data.name);
  }, [tenant.data]);

  const saveTenant = useMutation({
    mutationFn: () => api<TenantInfo>('/tenant', { method: 'PATCH', body: { name: businessName.trim() } }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['tenant'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
      toast.success('Workspace updated');
    },
  });
  const saveProfile = useMutation({
    mutationFn: () => api('/account', { method: 'PATCH', body: { fullName: fullName.trim() } }),
    onSuccess: () => {
      setProfileName(fullName.trim());
      void qc.invalidateQueries({ queryKey: ['team'] });
      toast.success('Profile updated');
    },
  });

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-mist-900">Settings</h2>
        <p className="mt-1 text-[15px] text-mist-500">Manage your workspace and your profile.</p>
      </div>

      <Section title="Workspace" description="Your business’s private space on MicroAgent.">
        {tenant.isPending ? (
          <Skeleton className="h-24" />
        ) : tenant.isError ? (
          <ErrorState error={tenant.error} onRetry={() => tenant.refetch()} />
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); saveTenant.mutate(); }} className="space-y-4">
            <FormError error={saveTenant.error} />
            <TextField label="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} disabled={!manage} maxLength={120} />
            <div className="flex items-center gap-2 text-sm text-mist-500">
              Plan: <Badge tone="burgundy">{tenant.data.plan}</Badge> Status: <Badge tone="green">{tenant.data.status}</Badge>
            </div>
            {manage ? (
              <Button type="submit" loading={saveTenant.isPending} disabled={businessName.trim().length < 2 || businessName.trim() === tenant.data.name}>Save workspace</Button>
            ) : (
              <p className="text-[13px] text-mist-500">Only an owner or admin can change workspace settings.</p>
            )}
          </form>
        )}
      </Section>

      <Section title="Your profile" description="How you appear to your team.">
        <form onSubmit={(e) => { e.preventDefault(); saveProfile.mutate(); }} className="space-y-4">
          <FormError error={saveProfile.error} />
          <TextField label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} />
          <TextField label="Email" value={me?.user.email ?? ''} disabled readOnly />
          <Button type="submit" loading={saveProfile.isPending} disabled={!fullName.trim() || fullName.trim() === me?.user.fullName}>Save profile</Button>
        </form>
      </Section>
    </div>
  );
}
