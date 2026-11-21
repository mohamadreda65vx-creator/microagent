import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, LogOut, Menu, Settings, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useAuth } from '../../lib/auth';
import { Logo } from '../brand/Logo';
import { Badge } from '../ui/primitives';
import { NAV } from './nav';

const roleLabel: Record<string, string> = { platform_admin: 'Platform admin', owner: 'Owner', admin: 'Admin', manager: 'Manager', viewer: 'Viewer' };

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
}

function SidebarLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { can, me } = useAuth();
  const items = me?.user.role === 'platform_admin' ? [] : NAV.filter((n) => can(n.permission));
  return (
    <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4" aria-label="Main">
      {me?.user.role === 'platform_admin' ? (
        <NavLink to="/admin" end onClick={onNavigate} className={({ isActive }) => linkCls(isActive)}>
          <ShieldCheck className="size-[18px]" strokeWidth={1.8} /> Companies
        </NavLink>
      ) : null}
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} onClick={onNavigate} className={({ isActive }) => linkCls(isActive)}>
          <n.icon className="size-[18px] shrink-0" strokeWidth={1.8} />
          <span className="flex-1 truncate">{n.label}</span>
          {n.planned ? <span className="size-1.5 shrink-0 rounded-full bg-burgundy-400" title="Coming in a later phase" aria-label="Coming soon" /> : null}
        </NavLink>
      ))}
    </nav>
  );
}
const linkCls = (active: boolean) =>
  clsx(
    'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
    active ? 'bg-white text-burgundy-900 shadow-sm' : 'text-burgundy-100/85 hover:bg-white/10 hover:text-white',
  );

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { me } = useAuth();
  return (
    <div className="flex h-full flex-col bg-burgundy-950">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link to={me?.user.role === 'platform_admin' ? '/admin' : '/app'} onClick={onNavigate} aria-label="Dashboard home">
          <Logo tone="light" size={32} />
        </Link>
      </div>
      <SidebarLinks onNavigate={onNavigate} />
      {me?.tenant ? (
        <div className="m-3 rounded-xl border border-white/10 bg-white/5 p-3.5">
          <p className="text-[11px] font-medium tracking-wide text-burgundy-300 uppercase">Workspace</p>
          <p className="mt-0.5 truncate text-sm font-semibold text-white">{me.tenant.name}</p>
        </div>
      ) : null}
    </div>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!me) return null;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex items-center gap-2.5 rounded-xl py-1.5 pr-2 pl-1.5 hover:bg-mist-100">
        <span className="grid size-8 place-items-center rounded-full bg-burgundy-700 text-xs font-semibold text-white">{initials(me.user.fullName)}</span>
        <span className="hidden text-left sm:block">
          <span className="block max-w-[140px] truncate text-sm leading-tight font-medium text-mist-900">{me.user.fullName}</span>
          <span className="block text-xs leading-tight text-mist-500">{roleLabel[me.user.role]}</span>
        </span>
        <ChevronDown className="size-4 text-mist-400" />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 z-50 mt-2 w-60 rounded-xl border border-mist-200 bg-white p-1.5 shadow-lift"
          >
            <div className="px-3 py-2">
              <p className="truncate text-sm font-medium text-mist-900">{me.user.fullName}</p>
              <p className="truncate text-xs text-mist-500">{me.user.email}</p>
            </div>
            <div className="my-1 h-px bg-mist-200" />
            {me.tenant ? (
              <button role="menuitem" onClick={() => { setOpen(false); navigate('/app/settings'); }} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-mist-700 hover:bg-mist-100">
                <Settings className="size-4" /> Settings
              </button>
            ) : null}
            <button
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                await logout();
                navigate('/login', { replace: true });
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-mist-700 hover:bg-mist-100"
            >
              <LogOut className="size-4" /> Log out
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function AppShell({ banner }: { banner?: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  const { me } = useAuth();
  const current = NAV.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)));
  const title = me?.user.role === 'platform_admin' ? 'Companies' : (current?.label ?? 'Dashboard');

  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="min-h-dvh bg-mist-50">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <SidebarBody />
      </aside>

      <AnimatePresence>
        {drawer ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div className="absolute inset-0 bg-burgundy-950/50 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawer(false)} />
            <motion.div className="absolute inset-y-0 left-0 w-72 max-w-[85%]" initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }} transition={{ type: 'tween', duration: 0.25 }}>
              <SidebarBody onNavigate={() => setDrawer(false)} />
              <button onClick={() => setDrawer(false)} className="absolute top-4 right-3 rounded-lg p-2 text-white/80 hover:bg-white/10" aria-label="Close menu">
                <X className="size-5" />
              </button>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-mist-200 bg-white/85 px-4 backdrop-blur-xl sm:px-6">
          <button onClick={() => setDrawer(true)} className="rounded-lg p-2 text-mist-700 hover:bg-mist-100 lg:hidden" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <h1 className="font-display text-lg font-semibold text-mist-900">{title}</h1>
          {me?.user.role === 'platform_admin' ? <Badge tone="burgundy">Platform</Badge> : null}
          <div className="ml-auto">
            <UserMenu />
          </div>
        </header>
        {banner}
        <main className="mx-auto max-w-6xl px-4 py-7 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
