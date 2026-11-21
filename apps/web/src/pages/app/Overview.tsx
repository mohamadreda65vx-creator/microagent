import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, Check, Circle, UserPlus, Users, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Overview as OverviewData } from '../../lib/types';
import { Button, Card, ErrorState, Skeleton } from '../../components/ui/primitives';

function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-burgundy-50 text-burgundy-700">{icon}</div>
        <p className="text-sm font-medium text-mist-500">{label}</p>
      </div>
      <p className="mt-4 font-display text-3xl font-semibold text-mist-900 tabular-nums">{value}</p>
      {sub ? <p className="mt-1 text-[13px] text-mist-500">{sub}</p> : null}
    </Card>
  );
}

function UsageChart({ data }: { data: Array<{ day: string; count: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div>
      <div className="flex h-36 items-end gap-1.5" role="img" aria-label={`API requests for the last ${data.length} days`}>
        {data.map((d) => (
          <div key={d.day} className="group relative flex h-full flex-1 items-end">
            <div className="w-full rounded-t-md bg-burgundy-200 transition-colors group-hover:bg-burgundy-600" style={{ height: `${Math.max(3, (d.count / max) * 100)}%` }} />
            <span className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded-md bg-burgundy-950 px-2 py-0.5 text-xs whitespace-nowrap text-white opacity-0 group-hover:opacity-100">
              {d.day.slice(5)} · {d.count}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-mist-400">
        <span>{data[0]?.day.slice(5)}</span>
        <span>{data[data.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}

export default function Overview() {
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api<OverviewData>('/overview') });

  if (q.isPending) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading overview">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}
        </div>
        <Skeleton className="h-56 rounded-2xl" />
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const firstName = me?.user.fullName.split(' ')[0];

  const steps = [
    { done: true, title: 'Create your workspace', to: undefined as string | undefined },
    { done: d.onboarding.hasAiEmployee, title: 'Create your first AI employee', to: '/app/ai-employees' },
    { done: d.onboarding.hasTeammate, title: 'Invite a teammate', to: '/app/team' },
  ];
  const allDone = steps.every((s) => s.done);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-mist-900">Welcome, {firstName}</h2>
        <p className="mt-1 text-[15px] text-mist-500">Here is what’s happening in {me?.tenant?.name}.</p>
      </div>

      {!allDone ? (
        <Card className="overflow-hidden border-burgundy-200 bg-gradient-to-br from-burgundy-50 to-white p-6">
          <h3 className="font-display text-lg font-semibold text-burgundy-950">Get started</h3>
          <ul className="mt-4 space-y-2.5">
            {steps.map((s) => (
              <li key={s.title} className="flex items-center gap-3 text-[15px]">
                {s.done ? <span className="grid size-5 place-items-center rounded-full bg-burgundy-700 text-white"><Check className="size-3" strokeWidth={3} /></span> : <Circle className="size-5 text-burgundy-300" />}
                <span className={s.done ? 'text-mist-500 line-through' : 'font-medium text-mist-900'}>{s.title}</span>
                {!s.done && s.to ? (
                  <Link to={s.to} className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-burgundy-700 hover:underline">
                    Start <ArrowRight className="size-3.5" />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat icon={<Users className="size-5" />} label="AI employees" value={d.aiEmployees.total} sub={`${d.aiEmployees.active} active · ${d.aiEmployees.draft} draft · ${d.aiEmployees.paused} paused`} />
        <Stat icon={<UsersRound className="size-5" />} label="Team members" value={d.team.members} sub={d.team.pendingInvitations ? `${d.team.pendingInvitations} pending invitation${d.team.pendingInvitations > 1 ? 's' : ''}` : 'No pending invitations'} />
        <Stat icon={<Activity className="size-5" />} label="API requests this month" value={d.usage.apiRequestsMonth.toLocaleString()} sub="Counted per workspace" />
      </div>

      <Card className="p-6">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h3 className="font-display text-lg font-semibold text-mist-900">Workspace activity</h3>
            <p className="text-[13px] text-mist-500">API requests, last 14 days (UTC)</p>
          </div>
        </div>
        <UsageChart data={d.usage.dailyApiRequests} />
      </Card>

      {d.aiEmployees.total === 0 ? (
        <Card>
          <div className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="font-display text-lg font-semibold text-mist-900">No AI employees yet</h3>
              <p className="mt-1 text-sm text-mist-500">Create your first one to start building your AI team.</p>
            </div>
            <Link to="/app/ai-employees"><Button icon={UserPlus}>Create AI employee</Button></Link>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
