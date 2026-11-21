import clsx from 'clsx';
import { AtSign, Inbox, MessageSquareDashed, Search, UserX, Users, Layers } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/primitives';

/**
 * Conversations: the 3-pane inbox layout (filters → list → thread).
 * Part 1 ships the layout only. There is no messaging backend yet, so every pane shows an honest empty state
 * and nothing here is mock data. Real conversations arrive together with Channels in the next phase.
 */
const views = [
  { label: 'All', icon: Layers },
  { label: 'Unassigned', icon: UserX },
  { label: 'Your inbox', icon: Inbox },
  { label: 'Mentions', icon: AtSign },
  { label: 'Team', icon: Users },
];

export default function Conversations() {
  return (
    <div className="overflow-hidden rounded-3xl border border-mist-200 bg-white shadow-soft">
      <div className="grid min-h-[620px] lg:grid-cols-[230px_320px_minmax(0,1fr)]">
        {/* Pane 1: views + channels */}
        <div className="border-b border-mist-200 bg-mist-50/70 p-4 lg:border-r lg:border-b-0">
          <p className="px-2 text-xs font-semibold tracking-wide text-mist-500 uppercase">Conversations</p>
          <ul className="mt-2 space-y-0.5">
            {views.map(({ label, icon: Icon }, i) => (
              <li key={label}>
                <span
                  aria-current={i === 0 ? 'page' : undefined}
                  className={clsx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm', i === 0 ? 'bg-burgundy-100 font-medium text-burgundy-900' : 'text-mist-600')}
                >
                  <Icon className="size-4" strokeWidth={1.8} /> {label}
                  <span className="ml-auto text-xs text-mist-400 tabular-nums">0</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-6 px-2 text-xs font-semibold tracking-wide text-mist-500 uppercase">Channels</p>
          <p className="mt-2 rounded-xl border border-dashed border-mist-300 bg-white px-3 py-3 text-[13px] text-mist-500">No channels connected yet. Channels are added in the next phase.</p>
        </div>

        {/* Pane 2: list */}
        <div className="border-b border-mist-200 lg:border-r lg:border-b-0">
          <div className="border-b border-mist-200 p-4">
            <h2 className="font-display text-lg font-semibold text-mist-900">Inbox</h2>
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
              <input disabled aria-label="Search conversations" placeholder="Search conversations" className="h-10 w-full rounded-xl border border-mist-200 bg-mist-50 pr-3 pl-9 text-sm placeholder:text-mist-400" />
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-mist-500">
              <span>0 open</span>
              <span>Newest</span>
            </div>
          </div>
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <div className="grid size-12 place-items-center rounded-2xl bg-burgundy-50 text-burgundy-600">
              <Inbox className="size-5" strokeWidth={1.6} />
            </div>
            <p className="mt-4 text-sm font-medium text-mist-900">Your inbox is empty</p>
            <p className="mt-1 text-[13px] text-mist-500">Customer conversations will show up here.</p>
          </div>
        </div>

        {/* Pane 3: thread */}
        <div className="flex flex-col items-center justify-center bg-mist-50/50 px-6 py-16 text-center">
          <div className="relative mb-5">
            <div className="absolute inset-0 -m-3 rounded-full bg-burgundy-100/70 blur-xl" aria-hidden="true" />
            <div className="relative grid size-14 place-items-center rounded-2xl border border-burgundy-100 bg-white text-burgundy-600 shadow-soft">
              <MessageSquareDashed className="size-6" strokeWidth={1.6} />
            </div>
          </div>
          <h3 className="font-display text-lg font-semibold text-mist-900">Select a conversation</h3>
          <p className="mt-1.5 max-w-sm text-sm text-pretty text-mist-500">Once your AI employees are connected to a channel, you’ll read and join their conversations here.</p>
          <Link to="/app/ai-employees" className="mt-5">
            <Button variant="secondary">Set up an AI employee</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
