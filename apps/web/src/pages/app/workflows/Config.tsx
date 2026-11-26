import { Plus, Trash2 } from 'lucide-react';
import { SelectField, TextAreaField, TextField, Button } from '../../../components/ui/primitives';
import type { AiEmployee, WfNodeType } from '../../../lib/types';

type D = Record<string, any>;
const PLATFORMS = ['telegram', 'whatsapp', 'messenger', 'instagram', 'website'];
const OPS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'gt', 'lt', 'exists', 'not_exists'];

/** Settings form for the selected node. Every field maps 1:1 to the backend's strict schema. */
export function NodeConfig({ type, data, set, employees, workflows, readOnly }: { type: WfNodeType; data: D; set: (d: D) => void; employees: AiEmployee[]; workflows: Array<{ id: string; name: string }>; readOnly: boolean }) {
  const up = (patch: D) => {
    const next = { ...data, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
    set(next);
  };
  const f = { disabled: readOnly };
  switch (type) {
    case 'trigger':
      return (
        <div className="space-y-3">
          <SelectField label="Starts when" value={data.kind ?? 'manual'} onChange={(e) => up({ kind: e.target.value })} {...f}>
            <option value="message_received">A customer message arrives</option>
            <option value="conversation_handoff">A conversation is handed to a person</option>
            <option value="customer_status_changed">A customer's status changes</option>
            <option value="manual">Manual / test only</option>
          </SelectField>
          {data.kind === 'message_received' ? (
            <>
              <TextField label="Only these platforms (comma separated)" hint={PLATFORMS.join(', ') + ' — empty = all'} value={(data.platforms ?? []).join(', ')} onChange={(e) => up({ platforms: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} {...f} />
              <TextField label="Only if the message contains any of" hint="Comma separated. Empty = any message." value={(data.containsAny ?? []).join(', ')} onChange={(e) => up({ containsAny: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} {...f} />
            </>
          ) : null}
          {data.kind === 'customer_status_changed' ? (
            <SelectField label="Only when the new status is" value={data.toStatus ?? ''} onChange={(e) => up({ toStatus: e.target.value })} {...f}>
              <option value="">Any status</option>{['new', 'lead', 'customer', 'inactive'].map((s) => <option key={s}>{s}</option>)}
            </SelectField>
          ) : null}
        </div>
      );
    case 'ai_agent':
      return (
        <div className="space-y-3">
          <SelectField label="AI employee" value={data.employeeId ?? ''} onChange={(e) => up({ employeeId: e.target.value })} {...f}>
            <option value="">Choose…</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </SelectField>
          <SelectField label="What should it do?" value={data.mode ?? 'text'} onChange={(e) => up({ mode: e.target.value })} {...f}>
            <option value="text">Write a text</option><option value="choice">Choose one option</option>
          </SelectField>
          <TextAreaField label="Instruction" hint="You can use {{trigger.message.text}} or {{customer.first_name}}." rows={4} value={data.prompt ?? ''} onChange={(e) => up({ prompt: e.target.value })} {...f} />
          {data.mode === 'choice' ? <TextField label="Options (comma separated, 2–8)" value={(data.choices ?? []).join(', ')} onChange={(e) => up({ choices: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} {...f} /> : null}
          <TextField label="Save the answer as" hint="Use later as {{vars.name}} (lowercase, numbers, _)" value={data.outputVar ?? ''} onChange={(e) => up({ outputVar: e.target.value })} {...f} />
        </div>
      );
    case 'action':
      return (
        <div className="space-y-3">
          <SelectField label="Action" value={data.kind ?? 'send_message'} onChange={(e) => up({ kind: e.target.value })} {...f}>
            <option value="send_message">Send a message to the customer</option><option value="add_tag">Add a tag</option><option value="remove_tag">Remove a tag</option>
            <option value="set_customer_status">Set customer status</option><option value="set_conversation_status">Set conversation status</option><option value="handoff_to_human">Hand over to a person</option><option value="add_note">Add an internal note</option>
          </SelectField>
          {data.kind === 'send_message' ? <TextAreaField label="Message" hint="Never sent if a {{placeholder}} has no value." rows={4} value={data.text ?? ''} onChange={(e) => up({ text: e.target.value })} {...f} /> : null}
          {data.kind === 'add_tag' || data.kind === 'remove_tag' ? <TextField label="Tag" value={data.tag ?? ''} onChange={(e) => up({ tag: e.target.value })} {...f} /> : null}
          {data.kind === 'set_customer_status' ? <SelectField label="Status" value={data.status ?? ''} onChange={(e) => up({ status: e.target.value })} {...f}><option value="">Choose…</option>{['new', 'lead', 'customer', 'inactive'].map((s) => <option key={s}>{s}</option>)}</SelectField> : null}
          {data.kind === 'set_conversation_status' ? <SelectField label="Status" value={data.status ?? ''} onChange={(e) => up({ status: e.target.value })} {...f}><option value="">Choose…</option>{['open', 'resolved'].map((s) => <option key={s}>{s}</option>)}</SelectField> : null}
          {data.kind === 'handoff_to_human' ? <TextField label="Reason (shown to your team)" value={data.reason ?? ''} onChange={(e) => up({ reason: e.target.value })} {...f} /> : null}
          {data.kind === 'add_note' ? <TextAreaField label="Note" rows={3} value={data.note ?? ''} onChange={(e) => up({ note: e.target.value })} {...f} /> : null}
        </div>
      );
    case 'condition': {
      const rules: D[] = data.rules ?? [];
      const setRule = (i: number, p: D) => up({ rules: rules.map((r, j) => (j === i ? { ...r, ...p } : r)) });
      return (
        <div className="space-y-3">
          <SelectField label="True when" value={data.match ?? 'all'} onChange={(e) => up({ match: e.target.value })} {...f}><option value="all">All rules match</option><option value="any">Any rule matches</option></SelectField>
          {rules.map((r, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-mist-200 p-3">
              <TextField label="Value" value={r.left ?? ''} onChange={(e) => setRule(i, { left: e.target.value })} {...f} />
              <SelectField label="Check" value={r.op ?? 'contains'} onChange={(e) => setRule(i, { op: e.target.value })} {...f}>{OPS.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</SelectField>
              {!['exists', 'not_exists'].includes(r.op) ? <TextField label="Compare to" value={r.right ?? ''} onChange={(e) => setRule(i, { right: e.target.value })} {...f} /> : null}
              {rules.length > 1 && !readOnly ? <Button variant="ghost" size="sm" icon={Trash2} onClick={() => up({ rules: rules.filter((_, j) => j !== i) })}>Remove rule</Button> : null}
            </div>
          ))}
          {!readOnly && rules.length < 10 ? <Button variant="secondary" size="sm" icon={Plus} onClick={() => up({ rules: [...rules, { left: '', op: 'contains', right: '' }] })}>Add rule</Button> : null}
        </div>
      );
    }
    case 'delay':
      return (
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Wait" type="number" min={1} value={data.amount ?? ''} onChange={(e) => up({ amount: e.target.value === '' ? undefined : Number(e.target.value) })} {...f} />
          <SelectField label="Unit" value={data.unit ?? 'hours'} onChange={(e) => up({ unit: e.target.value })} {...f}><option>minutes</option><option>hours</option><option>days</option></SelectField>
          <p className="col-span-2 text-xs text-mist-500">Up to 30 days. Test runs skip the wait.</p>
        </div>
      );
    case 'notification':
      return (
        <div className="space-y-3">
          <TextField label="Notify roles (comma separated)" hint="owner, admin, manager" value={(data.roles ?? []).join(', ')} onChange={(e) => up({ roles: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} {...f} />
          <TextField label="Title" value={data.title ?? ''} onChange={(e) => up({ title: e.target.value })} {...f} />
          <TextAreaField label="Details" rows={3} value={data.body ?? ''} onChange={(e) => up({ body: e.target.value })} {...f} />
        </div>
      );
    case 'human_task':
      return (
        <div className="space-y-3">
          <TextField label="Task title" value={data.title ?? ''} onChange={(e) => up({ title: e.target.value })} {...f} />
          <TextAreaField label="Instructions" rows={3} value={data.instructions ?? ''} onChange={(e) => up({ instructions: e.target.value })} {...f} />
          <SelectField label="Who can answer" value={data.assigneeRole ?? 'manager'} onChange={(e) => up({ assigneeRole: e.target.value })} {...f}><option>manager</option><option>admin</option><option>owner</option></SelectField>
          <TextField label="Time limit (hours, optional)" hint="After that the 'timeout' branch runs." type="number" min={1} value={data.dueHours ?? ''} onChange={(e) => up({ dueHours: e.target.value === '' ? undefined : Number(e.target.value) })} {...f} />
        </div>
      );
    case 'loop':
      return (
        <div className="space-y-3">
          <SelectField label="Repeat" value={data.source ?? 'count'} onChange={(e) => up({ source: e.target.value })} {...f}><option value="count">A fixed number of times</option><option value="list">For each item of a list</option></SelectField>
          {data.source === 'list' ? <TextField label="List variable" hint="e.g. trigger.items" value={data.listVar ?? ''} onChange={(e) => up({ listVar: e.target.value })} {...f} /> : <TextField label="Times (1–100)" type="number" min={1} max={100} value={data.count ?? ''} onChange={(e) => up({ count: e.target.value === '' ? undefined : Number(e.target.value) })} {...f} />}
          <p className="text-xs text-mist-500">Connect "body" to the steps to repeat (and back to this node), "done" to continue afterwards.</p>
        </div>
      );
    case 'subprocess':
      return (
        <div className="space-y-3">
          <SelectField label="Workflow to run" value={data.workflowId ?? ''} onChange={(e) => up({ workflowId: e.target.value })} {...f}><option value="">Choose…</option>{workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</SelectField>
          <p className="text-xs text-mist-500">It must be active. Up to 3 levels, no cycles.</p>
        </div>
      );
  }
}
