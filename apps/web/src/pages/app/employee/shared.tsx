import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import type { Catalog } from '../../../lib/types';

export const useCatalog = () => useQuery({ queryKey: ['ai-catalog'], queryFn: () => api<Catalog>('/ai/catalog'), staleTime: 5 * 60_000 });

const AVATAR_COLORS = ['bg-burgundy-700', 'bg-burgundy-500', 'bg-mist-700', 'bg-emerald-700', 'bg-amber-700', 'bg-sky-700', 'bg-violet-700', 'bg-rose-700'];
export const AVATARS = Array.from({ length: 8 }, (_, i) => `bot-${i + 1}`);

export function Avatar({ avatar, name, size = 'md' }: { avatar: string; name: string; size?: 'md' | 'lg' }) {
  const n = Number(avatar.split('-')[1] ?? 1) - 1;
  return <div className={`grid shrink-0 place-items-center rounded-xl font-display font-semibold text-white ${AVATAR_COLORS[((n % 8) + 8) % 8]} ${size === 'lg' ? 'size-14 text-2xl' : 'size-11 text-lg'}`}>{name[0]?.toUpperCase() ?? '?'}</div>;
}

export const statusTone = { draft: 'gray', active: 'green', paused: 'amber' } as const;
export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
