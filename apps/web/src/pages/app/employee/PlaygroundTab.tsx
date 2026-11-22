import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FlaskConical, Send, ShieldAlert, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import type { AiEmployeeDetail, Decision, SimTrace, SuiteResult } from '../../../lib/types';
import { Badge, Button, Card, FormError } from '../../../components/ui/primitives';
import { useToast } from '../../../components/ui/Toast';

interface Turn { role: 'user' | 'assistant'; content: string; trace?: SimTrace }
const DEC_TONE = { allowed: 'green', denied: 'red', pending_approval: 'amber', invalid: 'amber' } as const;
const DEC_LABEL: Record<Decision['decision'], string> = { allowed: 'Allowed', denied: 'Blocked', pending_approval: 'Waiting for approval', invalid: 'Rejected: invalid' };

function Trace({ t }: { t: SimTrace }) {
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-mist-200 bg-mist-50 p-3 text-[12px] text-mist-700" data-testid="trace">
      {t.error ? <p className="flex items-center gap-1.5 text-red-700"><ShieldAlert className="size-3.5" /> AI unavailable ({t.error.code}): the customer was handed to a person instead.</p> : null}
      {t.handoff ? <p className="font-medium text-amber-800">Handed to a human: {t.handoff.reason}</p> : null}
      {t.modelReply && t.modelReply !== t.reply ? <p><span className="font-medium text-red-700">Blocked answer:</span> “{t.modelReply}”</p> : null}
      {t.findings.map((f, i) => <p key={i} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700" />{f.message}</p>)}
      {t.decisions.map((d, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Badge tone={DEC_TONE[d.decision]}>{DEC_LABEL[d.decision]}</Badge><code className="rounded bg-white px-1.5 py-0.5">{d.type} {JSON.stringify(d.params)}</code>
          {d.reasons.map((r, j) => <span key={j} className="text-mist-500">{r.message}</span>)}
        </div>
      ))}
      {t.facts.length ? <p className="text-mist-500">Facts used: {t.facts.map((f) => f.name).join(', ')}</p> : <p className="text-mist-500">No confirmed facts matched this message.</p>}
      {t.usage ? <p className="text-mist-400">{t.usage.totalTokens} tokens · {t.usage.model}{t.usage.costUsd !== null ? ` · $${t.usage.costUsd.toFixed(5)}` : ''}</p> : null}
    </div>
  );
}

export function PlaygroundTab({ e }: { e: AiEmployeeDetail }) {
  const { can } = useAuth();
  const canRun = can('simulation:run');
  const qc = useQueryClient();
  const toast = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [suite, setSuite] = useState<SuiteResult | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: (message: string) => api<SimTrace>(`/ai-employees/${e.id}/simulate`, { body: { message, history: turns.map(({ role, content }) => ({ role, content })) } }),
    onSuccess: (trace, message) => {
      setTurns((t) => [...t, { role: 'user', content: message }, { role: 'assistant', content: trace.reply, trace }]);
      setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    },
  });
  const runSuite = useMutation({
    mutationFn: () => api<SuiteResult>(`/ai-employees/${e.id}/simulate/suite`, { body: {} }),
    onSuccess: async (r) => { setSuite(r); await qc.invalidateQueries({ queryKey: ['ai-employee', e.id] }); r.passed ? toast.success('All tests passed. This configuration can go live.') : toast.error('Some tests failed. See the details below.'); },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="flex h-[34rem] flex-col">
        <div className="border-b border-mist-200 px-5 py-3"><h3 className="font-display text-base font-semibold text-mist-900">Playground</h3><p className="text-[12px] text-mist-500">Talk to {e.name} as a customer would. Nothing here reaches real customers or real systems.</p></div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
          {turns.length === 0 ? <p className="mt-10 text-center text-sm text-mist-400">Try: “How much is …?”, “Can I get a discount?”, “Is it in stock?”, “I want to talk to a person”.</p> : null}
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'flex justify-end' : ''}>
              <div className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm ${t.role === 'user' ? 'bg-burgundy-700 text-white' : 'bg-mist-100 text-mist-900'}`} dir="auto">
                {t.content}
                {t.trace ? <Trace t={t.trace} /> : null}
              </div>
            </div>
          ))}
          {send.isPending ? <p className="text-sm text-mist-400">{e.name} is typing…</p> : null}
          <div ref={end} />
        </div>
        <form className="space-y-2 border-t border-mist-200 p-3" onSubmit={(ev) => { ev.preventDefault(); const m = text.trim(); if (m && canRun) { setText(''); send.mutate(m); } }}>
          <FormError error={send.error} />
          <div className="flex gap-2">
            <input value={text} onChange={(x) => setText(x.target.value)} disabled={!canRun} maxLength={2000} dir="auto" aria-label="Customer message" placeholder="Write as a customer…" className="h-11 flex-1 rounded-xl border border-mist-300 px-3.5 text-sm focus:border-burgundy-500 focus:ring-4 focus:ring-burgundy-100 focus:outline-none" />
            <Button type="submit" icon={Send} loading={send.isPending} disabled={!canRun || !text.trim()}>Send</Button>
            {turns.length ? <Button variant="ghost" onClick={() => setTurns([])}>Clear</Button> : null}
          </div>
        </form>
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-2"><FlaskConical className="size-5 text-burgundy-700" /><h3 className="font-display text-base font-semibold text-mist-900">Test before going live</h3></div>
        <p className="text-sm text-mist-500">Runs real scenarios built from your own business data: a real price, an unknown product, a discount request, a stock question, a refund request, an angry customer, a request for a person. The employee can go live only after passing them for its current setup.</p>
        {e.readiness.checks.map((c) => (
          <p key={c.key} className="flex items-start gap-2 text-sm">{c.ok ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" /> : c.blocking ? <XCircle className="mt-0.5 size-4 text-red-600" /> : <AlertTriangle className="mt-0.5 size-4 text-amber-600" />}<span className={c.ok ? 'text-mist-600' : 'text-mist-900'}>{c.ok ? ({ tasks: 'Has tasks', tested: 'Passed the tests for its current setup', knowledge: 'Has confirmed knowledge', ai: 'AI provider is configured' } as Record<string, string>)[c.key] : c.message}</span></p>
        ))}
        <FormError error={runSuite.error} />
        {canRun ? <Button icon={FlaskConical} loading={runSuite.isPending} onClick={() => runSuite.mutate()}>Run the test suite</Button> : null}
        {suite ? (
          <div className="space-y-3" data-testid="suite-results">
            <div className={`rounded-xl p-3 text-sm font-medium ${suite.passed ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{suite.passed ? 'Passed' : 'Not passed'}: {suite.ran} ran, {suite.failed} failed, {suite.skipped} skipped.{suite.note ? ` ${suite.note}` : ''}</div>
            {suite.results.map((r) => (
              <div key={r.id} className="rounded-xl border border-mist-200 p-3 text-sm">
                <p className="flex items-center gap-2 font-medium text-mist-900">{r.skipped ? <Badge>Skipped</Badge> : r.ok ? <Badge tone="green">Passed</Badge> : <Badge tone="red">Failed</Badge>}{r.title}</p>
                {r.skipped ? <p className="mt-1 text-[12px] text-mist-500">{r.skipped}</p> : null}
                {r.input ? <p className="mt-1 text-[12px] text-mist-500" dir="auto">Customer: “{r.input}”</p> : null}
                {r.trace ? <p className="mt-1 text-[12px] text-mist-700" dir="auto">Reply: “{r.trace.reply}”</p> : null}
                {r.checks?.map((c, i) => <p key={i} className={`mt-1 text-[12px] ${c.ok ? 'text-emerald-700' : 'text-red-700'}`}>{c.ok ? '✓' : '✗'} {c.name}{c.detail ? ` (${c.detail})` : ''}</p>)}
              </div>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
