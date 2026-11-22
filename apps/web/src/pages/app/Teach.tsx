import { RulesPanel } from '../../components/RulesPanel';

export default function Teach() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold text-mist-900">Teach & Correct</h2>
        <p className="mt-1 text-[15px] text-mist-500">Correct your AI employees in plain words. Each instruction becomes a small, editable rule: a knowledge update, a behavior update or a workflow update. Rules can only add limits; what an employee is allowed to do is set in its Permissions.</p>
      </div>
      <RulesPanel />
    </div>
  );
}
