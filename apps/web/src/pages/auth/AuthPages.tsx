import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { homePathFor, useAuth } from '../../lib/auth';
import { Button, FormError, TextField } from '../../components/ui/primitives';
import { AuthLayout } from './AuthLayout';

const linkCls = 'font-medium text-burgundy-700 hover:text-burgundy-900 hover:underline';

function useRedirectIfSignedIn() {
  const { me } = useAuth();
  return me ? <Navigate to={homePathFor(me)} replace /> : null;
}

/* ───────── Login ───────── */
export function Login() {
  const redirect = useRedirectIfSignedIn();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const m = useMutation({
    mutationFn: () => login(email.trim(), password),
    onSuccess: (me) => {
      const from = location.state?.from;
      navigate(from && from.startsWith('/') ? from : homePathFor(me), { replace: true });
    },
  });
  if (redirect) return redirect;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Log in to manage your AI employees."
      footer={
        <>
          New to MicroAgent? <Link to="/signup" className={linkCls}>Create your workspace</Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={m.error} />
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          action={<Link to="/forgot-password" className="text-[13px] font-medium text-burgundy-700 hover:underline">Forgot password?</Link>}
        />
        <Button type="submit" size="lg" className="w-full" loading={m.isPending} disabled={!email || !password}>
          Log in
        </Button>
      </form>
    </AuthLayout>
  );
}

/* ───────── Signup ───────── */
export function Signup() {
  const redirect = useRedirectIfSignedIn();
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useState({ businessName: '', fullName: '', email: '', password: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const m = useMutation({
    mutationFn: () => signup({ ...f, businessName: f.businessName.trim(), fullName: f.fullName.trim(), email: f.email.trim() }),
    onSuccess: (me) => navigate(homePathFor(me), { replace: true }),
  });
  if (redirect) return redirect;
  const err = m.error instanceof ApiError ? m.error : undefined;

  return (
    <AuthLayout
      title="Create your workspace"
      subtitle="Set up your business and hire your first AI employee."
      footer={
        <>
          Already have an account? <Link to="/login" className={linkCls}>Log in</Link>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        className="space-y-4"
        noValidate
      >
        {err && !err.details ? <FormError error={err} /> : null}
        <TextField label="Business name" value={f.businessName} onChange={set('businessName')} autoComplete="organization" error={err?.fieldError('businessName')} required autoFocus />
        <TextField label="Your name" value={f.fullName} onChange={set('fullName')} autoComplete="name" error={err?.fieldError('fullName')} required />
        <TextField label="Work email" type="email" value={f.email} onChange={set('email')} autoComplete="email" error={err?.fieldError('email') ?? (err?.code === 'email_taken' ? err.message : undefined)} required />
        <TextField label="Password" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" hint="At least 10 characters." error={err?.fieldError('password')} required />
        <Button type="submit" size="lg" className="w-full" loading={m.isPending} disabled={!f.businessName || !f.fullName || !f.email || f.password.length < 10}>
          Create workspace
        </Button>
      </form>
    </AuthLayout>
  );
}

/* ───────── Forgot password ───────── */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const m = useMutation({ mutationFn: () => api('/auth/forgot-password', { body: { email: email.trim() } }) });

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email and we’ll send you a link to choose a new one."
      footer={<Link to="/login" className={linkCls}>Back to login</Link>}
    >
      {m.isSuccess ? (
        <div className="flex gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
          <p>If an account exists for <strong>{email}</strong>, a reset link is on its way. It is valid for 1 hour.</p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
          className="space-y-4"
          noValidate
        >
          <FormError error={m.error} />
          <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <Button type="submit" size="lg" className="w-full" loading={m.isPending} disabled={!email}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/* ───────── Reset password ───────── */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const m = useMutation({ mutationFn: () => api('/auth/reset-password', { body: { token, password } }) });
  const mismatch = confirm.length > 0 && confirm !== password;

  if (!token) {
    return (
      <AuthLayout title="Link not valid" subtitle="This password reset link is incomplete." footer={<Link to="/forgot-password" className={linkCls}>Request a new link</Link>}>
        <span />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password" subtitle="You’ll be signed out of all devices after the change.">
      {m.isSuccess ? (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
            <p>Your password was changed.</p>
          </div>
          <Button size="lg" className="w-full" onClick={() => navigate('/login', { replace: true })}>Go to login</Button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
          className="space-y-4"
          noValidate
        >
          <FormError error={m.error} />
          <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 10 characters." required autoFocus />
          <TextField label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? 'Passwords do not match' : undefined} required />
          <Button type="submit" size="lg" className="w-full" loading={m.isPending} disabled={password.length < 10 || password !== confirm}>
            Change password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/* ───────── Accept invitation ───────── */
export function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { acceptInvitation } = useAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');

  const invite = useQuery({
    queryKey: ['invitation', token],
    enabled: !!token,
    retry: false,
    queryFn: () => api<{ businessName: string; email: string; role: string }>(`/auth/invitations/${encodeURIComponent(token)}`),
  });
  const m = useMutation({
    mutationFn: () => acceptInvitation({ token, fullName: fullName.trim(), password }),
    onSuccess: (me) => navigate(homePathFor(me), { replace: true }),
  });

  if (!token || invite.isError) {
    return (
      <AuthLayout title="Invitation not valid" subtitle="This invitation is invalid or has expired. Ask your team owner to send a new one." footer={<Link to="/login" className={linkCls}>Go to login</Link>}>
        <span />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title={invite.data ? `Join ${invite.data.businessName}` : 'Join your team'}
      subtitle={invite.data ? `You’ve been invited as ${invite.data.role}. Create your account for ${invite.data.email}.` : 'Loading invitation…'}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        className="space-y-4"
        noValidate
      >
        <FormError error={m.error} />
        <TextField label="Your name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required autoFocus />
        <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" hint="At least 10 characters." required />
        <Button type="submit" size="lg" className="w-full" loading={m.isPending} disabled={!invite.data || !fullName || password.length < 10}>
          Join team
        </Button>
      </form>
    </AuthLayout>
  );
}
