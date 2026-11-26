import { Handle, Position, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { Bell, Bot, Clock, GitBranch, Layers, Play, Repeat, UserCheck, Zap, type LucideIcon } from 'lucide-react';
import type { WfNodeType } from '../../../lib/types';

export const HANDLES: Record<WfNodeType, string[]> = {
  trigger: ['out'], ai_agent: ['out'], action: ['out'], condition: ['true', 'false'], delay: ['out'], notification: ['out'], human_task: ['approved', 'rejected', 'timeout'], loop: ['body', 'done'], subprocess: ['out'],
};
export const CATALOG: Array<{ type: WfNodeType; label: string; icon: LucideIcon; text: string; tone: string; defaults: Record<string, any> }> = [
  { type: 'trigger', label: 'Trigger', icon: Zap, text: 'Starts the workflow', tone: 'bg-amber-100 text-amber-800', defaults: { kind: 'message_received' } },
  { type: 'ai_agent', label: 'AI Agent', icon: Bot, text: 'Ask an AI employee', tone: 'bg-burgundy-100 text-burgundy-800', defaults: { mode: 'text', prompt: '', outputVar: 'answer' } },
  { type: 'action', label: 'Action', icon: Play, text: 'Message, tag, status…', tone: 'bg-emerald-100 text-emerald-800', defaults: { kind: 'send_message', text: '' } },
  { type: 'condition', label: 'Condition', icon: GitBranch, text: 'True / false split', tone: 'bg-sky-100 text-sky-800', defaults: { match: 'all', rules: [{ left: '{{trigger.message.text}}', op: 'contains', right: '' }] } },
  { type: 'delay', label: 'Delay', icon: Clock, text: 'Wait, then continue', tone: 'bg-mist-200 text-mist-800', defaults: { amount: 1, unit: 'hours' } },
  { type: 'notification', label: 'Notification', icon: Bell, text: 'Alert your team', tone: 'bg-orange-100 text-orange-800', defaults: { roles: ['owner'], title: '', body: '' } },
  { type: 'human_task', label: 'Human Task', icon: UserCheck, text: 'Wait for approval', tone: 'bg-violet-100 text-violet-800', defaults: { title: '', instructions: '', assigneeRole: 'manager' } },
  { type: 'loop', label: 'Loop', icon: Repeat, text: 'Repeat steps', tone: 'bg-teal-100 text-teal-800', defaults: { source: 'count', count: 3 } },
  { type: 'subprocess', label: 'Subprocess', icon: Layers, text: 'Run another workflow', tone: 'bg-rose-100 text-rose-800', defaults: {} },
];
export const META = Object.fromEntries(CATALOG.map((c) => [c.type, c])) as Record<WfNodeType, (typeof CATALOG)[number]>;

export function summary(type: WfNodeType, d: Record<string, any>): string {
  switch (type) {
    case 'trigger': return ({ manual: 'Manual / test only', message_received: 'Customer message received', conversation_handoff: 'Conversation handed to a person', customer_status_changed: `Customer status changed${d.toStatus ? ` to ${d.toStatus}` : ''}` } as Record<string, string>)[d.kind] ?? 'Choose when it starts';
    case 'ai_agent': return d.prompt ? `${d.mode === 'choice' ? 'Choose' : 'Write'}: ${d.prompt}` : 'Not set up';
    case 'action': return d.kind ? String(d.kind).replace(/_/g, ' ') + (d.tag ? `: ${d.tag}` : d.status ? `: ${d.status}` : '') : 'Choose an action';
    case 'condition': return d.rules?.length ? `${d.rules.length} rule${d.rules.length > 1 ? 's' : ''} (${d.match})` : 'No rules';
    case 'delay': return `Wait ${d.amount ?? '?'} ${d.unit ?? ''}`;
    case 'notification': return d.title || 'No title';
    case 'human_task': return d.title || 'No title';
    case 'loop': return d.source === 'list' ? `Each item of ${d.listVar || '…'}` : `${d.count ?? '?'} times`;
    case 'subprocess': return d.workflowId ? 'Runs a workflow' : 'Pick a workflow';
  }
}

export interface NodeData extends Record<string, unknown> { kind: WfNodeType; config: Record<string, any>; issue?: 'error' | 'warning' | null; running?: string | null }

/** One component for all nine node types: header, one-line summary, an input on the left and one labelled output per branch on the right. */
export function WfNode({ data, selected }: NodeProps) {
  const d = data as NodeData;
  const m = META[d.kind];
  const outs = HANDLES[d.kind];
  return (
    <div className={clsx('w-56 rounded-xl border bg-white shadow-soft transition', selected ? 'border-burgundy-600 ring-2 ring-burgundy-200' : d.issue === 'error' ? 'border-red-400' : d.issue === 'warning' ? 'border-amber-400' : 'border-mist-300', d.running === 'ok' && 'ring-2 ring-emerald-300', d.running === 'error' && 'ring-2 ring-red-300')} style={{ minHeight: 56 + (outs.length > 1 ? outs.length * 14 : 0) }}>
      {d.kind !== 'trigger' ? <Handle type="target" position={Position.Left} className="!size-3 !border-2 !border-white !bg-mist-500" /> : null}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className={clsx('grid size-7 place-items-center rounded-lg', m.tone)}><m.icon className="size-4" /></span>
        <p className="text-sm font-semibold text-mist-900">{m.label}</p>
        {d.issue ? <span className={clsx('ml-auto size-2 rounded-full', d.issue === 'error' ? 'bg-red-500' : 'bg-amber-500')} title={d.issue} /> : null}
      </div>
      <p className="truncate px-3 pt-1 pb-2.5 pr-14 text-xs text-mist-600">{summary(d.kind, d.config)}</p>
      {outs.map((h, i) => (
        <Handle key={h} id={h} type="source" position={Position.Right} style={{ top: outs.length === 1 ? '50%' : `${28 + i * (100 - 40) / Math.max(outs.length - 1, 1)}%` }} className="!size-3 !border-2 !border-white !bg-burgundy-600">
        </Handle>
      ))}
      {outs.length > 1 ? outs.map((h, i) => <span key={h} className="pointer-events-none absolute right-4 text-[10px] font-medium text-mist-500" style={{ top: `calc(${28 + i * (100 - 40) / Math.max(outs.length - 1, 1)}% - 7px)` }}>{h}</span>) : null}
    </div>
  );
}
