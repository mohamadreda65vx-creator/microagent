import { Bell, CircleDot, Clock, GitBranch, GitFork, Layers, Play, Redo2, Repeat, Save, Undo2, UserCheck, Workflow, Zap, type LucideIcon } from 'lucide-react';
import { Button } from '../../components/ui/primitives';

/**
 * Workflow Builder: toolbar + nodes library + canvas.
 * Part 1 ships the layout and the node vocabulary only. Placing, connecting and running nodes
 * (and saving workflows) arrives in the next phase, so the canvas is intentionally empty: no sample workflow is faked.
 */
const nodes: Array<{ icon: LucideIcon; name: string; text: string }> = [
  { icon: Zap, name: 'Trigger', text: 'Start the workflow' },
  { icon: Play, name: 'Action', text: 'Perform a task' },
  { icon: Bell, name: 'Notification', text: 'Send an alert' },
  { icon: GitBranch, name: 'Conditional', text: 'Branch the workflow' },
  { icon: Clock, name: 'Delay', text: 'Pause the workflow' },
  { icon: UserCheck, name: 'User task', text: 'Assign to a person' },
  { icon: Repeat, name: 'Loop', text: 'Repeat a set of steps' },
  { icon: Layers, name: 'Sub-process', text: 'Embed another workflow' },
  { icon: GitFork, name: 'Parallel', text: 'Run branches together' },
  { icon: CircleDot, name: 'Decision', text: 'Route the workflow' },
];

function ToolbarButton({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <button disabled aria-label={label} title={label} className="grid size-8 place-items-center rounded-lg text-burgundy-200/70 disabled:cursor-not-allowed">
      <Icon className="size-4" />
    </button>
  );
}

export default function Workflows() {
  return (
    <div className="overflow-hidden rounded-3xl border border-mist-200 bg-white shadow-soft">
      {/* Dark toolbar */}
      <div className="flex h-14 items-center gap-1 bg-burgundy-950 px-4">
        <ToolbarButton icon={Save} label="Save (available next phase)" />
        <ToolbarButton icon={Undo2} label="Undo" />
        <ToolbarButton icon={Redo2} label="Redo" />
        <p className="mx-auto truncate px-3 text-sm text-burgundy-200/80">
          Workflows <span className="text-burgundy-300/50">/</span> <span className="font-medium text-white">Untitled workflow</span>
        </p>
        <Button size="sm" variant="light" disabled title="Available in the next phase">
          Run
        </Button>
      </div>

      <div className="grid min-h-[600px] lg:grid-cols-[250px_minmax(0,1fr)]">
        {/* Nodes library */}
        <aside className="border-b border-mist-200 bg-white p-4 lg:border-r lg:border-b-0" aria-label="Nodes library">
          <h2 className="font-display text-base font-semibold text-mist-900">Nodes Library</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {nodes.map(({ icon: Icon, name, text }) => (
              <li key={name} className="flex items-center gap-3 rounded-xl border border-mist-200 bg-white px-3 py-2.5 shadow-sm">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-burgundy-50 text-burgundy-700">
                  <Icon className="size-[18px]" strokeWidth={1.7} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm leading-tight font-medium text-mist-900">{name}</span>
                  <span className="block truncate text-xs text-mist-500">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </aside>

        {/* Canvas */}
        <div
          className="relative grid place-items-center bg-mist-100"
          style={{ backgroundImage: 'radial-gradient(circle, rgb(122 35 66 / 0.18) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
        >
          <div className="mx-4 max-w-sm rounded-2xl border border-mist-200 bg-white/95 px-7 py-9 text-center shadow-soft backdrop-blur">
            <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-burgundy-50 text-burgundy-600">
              <Workflow className="size-6" strokeWidth={1.6} />
            </div>
            <h3 className="mt-4 font-display text-lg font-semibold text-mist-900">Your canvas is empty</h3>
            <p className="mt-1.5 text-sm text-pretty text-mist-500">Building workflows (drag nodes here, connect them and run) arrives in the next phase. The nodes on the left are the building blocks you’ll use.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
