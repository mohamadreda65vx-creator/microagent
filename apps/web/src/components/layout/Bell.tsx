import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import type { AppNotification } from '../../lib/types';

export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ items: AppNotification[]; unread: number }>('/notifications'), refetchInterval: 20000 });
  const read = useMutation({ mutationFn: () => api('/notifications/read', { body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative">
      <button type="button" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} onClick={() => setOpen(!open)} className="relative grid size-9 place-items-center rounded-lg text-mist-700 hover:bg-mist-100">
        <Bell className="size-5" />
        {unread ? <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-burgundy-600 px-1 text-[10px] font-semibold text-white">{unread > 9 ? '9+' : unread}</span> : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[85vw] rounded-2xl border border-mist-200 bg-white p-2 shadow-xl">
          <div className="flex items-center justify-between px-2 py-1"><p className="text-sm font-semibold">Notifications</p>{unread ? <button type="button" className="text-xs text-burgundy-700" onClick={() => read.mutate()}>Mark all read</button> : null}</div>
          <ul className="max-h-80 overflow-y-auto">
            {(q.data?.items ?? []).length === 0 ? <li className="px-2 py-4 text-sm text-mist-500">Nothing yet.</li> : q.data!.items.map((n) => (
              <li key={n.id} className={`rounded-lg px-2 py-2 text-sm ${n.readAt ? '' : 'bg-burgundy-50/50'}`}>
                {n.link ? <Link to={n.link} onClick={() => setOpen(false)} className="font-medium text-mist-900 hover:underline">{n.title}</Link> : <p className="font-medium text-mist-900">{n.title}</p>}
                {n.body ? <p className="text-xs text-mist-600">{n.body}</p> : null}
                <p className="text-[10px] text-mist-400">{new Date(n.createdAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
