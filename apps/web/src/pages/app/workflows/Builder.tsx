import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, History, ListChecks, Pause, Play, Rocket, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, ErrorState, FormError, Modal, SelectField, Skeleton, TextAreaField, TextField } from '../../../components/ui/primitives';
import { useToast } from '../../../components/ui/Toast';
import { api, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import type { AiEmployee, WfDetail, WfGraph, WfIssue, WfNodeType, WfRun, WfStep } from '../../../lib/types';
import { NodeConfig } from './Config';
import { CATALOG, META, WfNode, type NodeData } from './nodes';

const nodeTypes = { wf: WfNode };
let seq = 0;
const newId = (t: string) => `${t}_${Date.now().toString(36)}${(seq++).toString(36)}`;

const toRf = (g: WfGraph): { nodes: Node[]; edges: Edge[] } => ({
  nodes: g.nodes.map((n) => ({ id: n.id, type: 'wf', position: n.position, data: { kind: n.type, config: n.data } satisfies NodeData })),
  edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? 'out' })),
});
const fromRf = (nodes: Node[], edges: Edge[]): WfGraph => ({
  nodes: nodes.map((n) => ({ id: n.id, type: (n.data as NodeData).kind, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: (n.data as NodeData).config })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? 'out' })),
});

export default function Builder() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}

function Inner() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('workflows:manage');
  const canPublish = can('workflows:publish');
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);

  const q = useQuery({ queryKey: ['workflow', id], queryFn: () => api<WfDetail>(`/workflows/${id}`) });
  const emps = useQuery({ queryKey: ['ai-employees'], queryFn: () => api<{ items: AiEmployee[] }>('/ai-employees'), enabled: can('ai_employees:read') });
  const list = useQuery({ queryKey: ['workflows'], queryFn: () => api<{ items: Array<{ id: string; name: string }> }>('/workflows') });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [baseVersion, setBaseVersion] = useState(1);
  const [issues, setIssues] = useState<WfIssue[]>([]);
  const [panel, setPanel] = useState<'none' | 'issues' | 'versions' | 'runs'>('none');
  const [testOpen, setTestOpen] = useState(false);
  const [stepMarks, setStepMarks] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback((d: WfDetail) => {
    const g = toRf(d.graph);
    setNodes(g.nodes);
    setEdges(g.edges);
    setBaseVersion(d.latestVersion);
    setIssues(d.issues);
    setDirty(false);
    setStepMarks({});
  }, [setNodes, setEdges]);
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (q.data && loadedFor.current !== `${q.data.id}`) {
      loadedFor.current = q.data.id;
      load(q.data);
    }
  }, [q.data, load]);

  // Unsaved changes: warn on tab close.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const issueByNode = useMemo(() => {
    const m: Record<string, 'error' | 'warning'> = {};
    for (const i of issues) if (i.nodeId && m[i.nodeId] !== 'error') m[i.nodeId] = i.level;
    return m;
  }, [issues]);
  const shown = useMemo(() => nodes.map((n) => ({ ...n, data: { ...n.data, issue: issueByNode[n.id] ?? null, running: stepMarks[n.id] ?? null } })), [nodes, issueByNode, stepMarks]);

  const onConnect = useCallback((c: Connection) => {
    if (!canEdit) return;
    setEdges((es) => addEdge({ ...c, id: newId('e') }, es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? 'out') === (c.sourceHandle ?? 'out')))));
    setDirty(true);
  }, [canEdit, setEdges]);

  const addNode = (type: WfNodeType, pos?: { x: number; y: number }) => {
    if (!canEdit) return;
    if (type === 'trigger' && nodes.some((n) => (n.data as NodeData).kind === 'trigger')) { toast.error('A workflow has only one trigger.'); return; }
    const p = pos ?? rf.screenToFlowPosition({ x: (wrap.current?.getBoundingClientRect().left ?? 0) + 260, y: (wrap.current?.getBoundingClientRect().top ?? 0) + 120 + nodes.length * 20 });
    const n: Node = { id: newId(type), type: 'wf', position: p, data: { kind: type, config: structuredClone(META[type].defaults) } satisfies NodeData };
    setNodes((ns) => [...ns, n]);
    setSelected(n.id);
    setDirty(true);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const t = e.dataTransfer.getData('application/wf-node') as WfNodeType;
    if (t && META[t]) addNode(t, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const graph = () => fromRf(nodes, edges);
  const sel = nodes.find((n) => n.id === selected);
  const setConfig = (cfg: Record<string, any>) => { setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, data: { ...n.data, config: cfg } } : n))); setDirty(true); };
  const removeSelected = () => { if (!selected) return; setNodes((ns) => ns.filter((n) => n.id !== selected)); setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected)); setSelected(null); setDirty(true); };

  const save = useMutation({
    mutationFn: async () => api<{ version: number; changed: boolean; issues: WfIssue[] }>(`/workflows/${id}/graph`, { method: 'PUT', body: { graph: graph(), baseVersion } }),
    onSuccess: async (r) => { setBaseVersion(r.version); setIssues(r.issues); setDirty(false); setErr(null); toast.success(r.changed ? `Saved as version ${r.version}` : 'No changes to save'); await Promise.all([qc.invalidateQueries({ queryKey: ['workflow', id] }), qc.invalidateQueries({ queryKey: ['workflows'] })]); },
    onError: (e) => { setErr(e); if (e instanceof ApiError && e.status === 422) toast.error('Some settings are invalid — check the highlighted steps.'); },
  });
  const check = useMutation({
    mutationFn: () => api<{ issues: WfIssue[] }>(`/workflows/${id}/validate`, { body: { graph: graph() } }),
    onSuccess: (r) => { setIssues(r.issues); setPanel('issues'); },
    onError: setErr,
  });
  const act = useMutation({
    mutationFn: (a: 'activate' | 'pause') => api(`/workflows/${id}/${a}`, { body: {} }),
    onSuccess: async (_r, a) => { toast.success(a === 'activate' ? 'Workflow is live (this saved version).' : 'Workflow paused.'); setErr(null); await Promise.all([qc.invalidateQueries({ queryKey: ['workflow', id] }), qc.invalidateQueries({ queryKey: ['workflows'] })]); },
    onError: (e) => { setErr(e); if (e instanceof ApiError && Array.isArray((e.details as any)?.issues)) { setIssues((e.details as any).issues); setPanel('issues'); } },
  });
  const del = useMutation({ mutationFn: () => api(`/workflows/${id}`, { method: 'DELETE' }), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['workflows'] }); nav('/app/workflows'); }, onError: setErr });

  if (q.isLoading) return <Skeleton className="m-6 h-96" />;
  if (q.isError || !q.data) return <div className="p-6"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const w = q.data;
  const errors = issues.filter((i) => i.level === 'error').length;

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-[560px] flex-col">
      {/* dark toolbar */}
      <div className="flex flex-wrap items-center gap-2 bg-mist-900 px-3 py-2 text-white">
        <Link to="/app/workflows" aria-label="Back to workflows" className="grid size-8 place-items-center rounded-lg hover:bg-white/10"><ArrowLeft className="size-4" /></Link>
        <div className="min-w-0 pr-2"><p className="truncate text-sm font-semibold">{w.name}</p><p className="text-[11px] text-mist-400">Version {baseVersion}{dirty ? ' · unsaved changes' : ''}</p></div>
        <Badge tone={w.status === 'active' ? 'green' : w.status === 'paused' ? 'amber' : 'gray'}>{w.status}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" icon={ShieldCheck} loading={check.isPending} onClick={() => check.mutate()}>Validate{errors ? ` (${errors})` : ''}</Button>
          <Button size="sm" variant="secondary" icon={Play} disabled={!canEdit} onClick={() => setTestOpen(true)}>Test run</Button>
          <Button size="sm" variant="secondary" icon={History} onClick={() => setPanel(panel === 'versions' ? 'none' : 'versions')}>Versions</Button>
          <Button size="sm" variant="secondary" icon={ListChecks} onClick={() => setPanel(panel === 'runs' ? 'none' : 'runs')}>Runs</Button>
          {canEdit ? <Button size="sm" icon={Save} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>Save</Button> : null}
          {canPublish ? (w.status === 'active'
            ? <Button size="sm" variant="secondary" icon={Pause} loading={act.isPending} onClick={() => act.mutate('pause')}>Pause</Button>
            : <Button size="sm" icon={Rocket} loading={act.isPending} disabled={dirty} title={dirty ? 'Save first' : undefined} onClick={() => act.mutate('activate')}>Activate</Button>) : null}
          {canPublish ? <Button size="sm" variant="ghost" className="text-white" icon={Trash2} aria-label="Delete workflow" onClick={() => { if (confirm('Delete this workflow and its history?')) del.mutate(); }} /> : null}
        </div>
      </div>
      {err ? <div className="px-3 pt-2"><FormError error={err} /></div> : null}
      {err instanceof ApiError && err.code === 'version_conflict' ? <div className="px-3 pt-2"><Button size="sm" variant="secondary" onClick={() => { loadedFor.current = null; q.refetch().then((r) => r.data && (loadedFor.current = r.data.id, load(r.data))); setErr(null); }}>Discard my edits and reload</Button></div> : null}

      <div className="flex min-h-0 flex-1">
        {/* nodes library */}
        <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-mist-200 bg-white p-3 sm:block" aria-label="Nodes library">
          <p className="mb-2 text-xs font-semibold tracking-wide text-mist-500 uppercase">Nodes</p>
          <div className="space-y-2">
            {CATALOG.map((c) => (
              <button key={c.type} type="button" draggable={canEdit} disabled={!canEdit} onDragStart={(e) => e.dataTransfer.setData('application/wf-node', c.type)} onClick={() => addNode(c.type)} className="flex w-full cursor-grab items-center gap-2.5 rounded-xl border border-mist-200 p-2 text-left hover:border-burgundy-300 hover:bg-burgundy-50/40 disabled:cursor-not-allowed disabled:opacity-60">
                <span className={`grid size-8 place-items-center rounded-lg ${c.tone}`}><c.icon className="size-4" /></span>
                <span><span className="block text-sm font-medium text-mist-900">{c.label}</span><span className="block text-[11px] text-mist-500">{c.text}</span></span>
              </button>
            ))}
          </div>
          {!canEdit ? <p className="mt-3 text-xs text-mist-500">You can view this workflow but not edit it.</p> : <p className="mt-3 text-xs text-mist-500">Drag onto the canvas, or click to add.</p>}
        </aside>

        {/* canvas */}
        <div ref={wrap} className="relative min-w-0 flex-1 bg-mist-50" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}>
          <ReactFlow nodes={shown} edges={edges} nodeTypes={nodeTypes} onNodesChange={(c) => { onNodesChange(c); if (c.some((x) => x.type === 'position' || x.type === 'remove')) setDirty(true); }} onEdgesChange={(c) => { onEdgesChange(c); if (c.some((x) => x.type === 'remove')) setDirty(true); }} onConnect={onConnect} onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)} nodesDraggable={canEdit} nodesConnectable={canEdit} elementsSelectable deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null} fitView fitViewOptions={{ maxZoom: 1, padding: 0.3 }} proOptions={{ hideAttribution: true }}>
            <Background gap={20} color="#d8d3d0" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!hidden md:!block" />
          </ReactFlow>
          <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5 sm:hidden">
            {CATALOG.map((c) => <button key={c.type} type="button" onClick={() => addNode(c.type)} disabled={!canEdit} className={`rounded-full px-2.5 py-1 text-xs font-medium ${c.tone}`}>+ {c.label}</button>)}
          </div>
        </div>

        {/* right: node settings or side panel */}
        {sel || panel !== 'none' ? (
          <aside className="absolute inset-y-0 right-0 z-20 w-full max-w-sm overflow-y-auto border-l border-mist-200 bg-white p-4 shadow-xl sm:static sm:w-80 sm:shadow-none" aria-label="Details">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-mist-900">{sel ? `${META[(sel.data as NodeData).kind].label} settings` : panel === 'issues' ? 'Validation' : panel === 'versions' ? 'Versions' : 'Runs & logs'}</p>
              <button type="button" aria-label="Close" onClick={() => { setSelected(null); setPanel('none'); }} className="grid size-8 place-items-center rounded-lg hover:bg-mist-100"><X className="size-4" /></button>
            </div>
            {sel ? (
              <div className="space-y-4">
                <NodeConfig type={(sel.data as NodeData).kind} data={(sel.data as NodeData).config} set={setConfig} employees={emps.data?.items ?? []} workflows={(list.data?.items ?? []).filter((x) => x.id !== id)} readOnly={!canEdit} />
                {issues.filter((i) => i.nodeId === sel.id).map((i, k) => <p key={k} className={`rounded-lg px-3 py-2 text-xs ${i.level === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>{i.message}</p>)}
                {canEdit ? <Button variant="secondary" size="sm" icon={Trash2} onClick={removeSelected}>Delete step</Button> : null}
              </div>
            ) : panel === 'issues' ? <IssueList issues={issues} onPick={(nid) => nid && setSelected(nid)} />
              : panel === 'versions' ? <Versions w={w} canEdit={canEdit} dirty={dirty} onRestored={async () => { loadedFor.current = null; const r = await q.refetch(); if (r.data) { loadedFor.current = r.data.id; load(r.data); } }} />
              : <Runs id={id!} onMarks={setStepMarks} />}
          </aside>
        ) : null}
      </div>

      {testOpen ? <TestModal id={id!} dirty={dirty} onSave={async () => { await save.mutateAsync(); }} onClose={() => setTestOpen(false)} onMarks={setStepMarks} /> : null}
    </div>
  );
}

function IssueList({ issues, onPick }: { issues: WfIssue[]; onPick: (id?: string) => void }) {
  if (!issues.length) return <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">No problems found. This workflow can be activated.</p>;
  return <ul className="space-y-2">{issues.map((i, k) => <li key={k}><button type="button" onClick={() => onPick(i.nodeId)} className={`w-full rounded-lg px-3 py-2 text-left text-xs ${i.level === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}><b>{i.level === 'error' ? 'Error' : 'Warning'}:</b> {i.message}</button></li>)}</ul>;
}

function Versions({ w, canEdit, dirty, onRestored }: { w: WfDetail; canEdit: boolean; dirty: boolean; onRestored: () => void }) {
  const toast = useToast();
  const m = useMutation({ mutationFn: (v: number) => api(`/workflows/${w.id}/versions/${v}/restore`, { body: {} }), onSuccess: () => { toast.success('Restored as a new version.'); onRestored(); }, onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed') });
  return (
    <ul className="space-y-2">
      {w.versions.map((v) => (
        <li key={v.version} className="rounded-xl border border-mist-200 p-3 text-sm">
          <div className="flex items-center justify-between"><b>Version {v.version}</b>{v.active ? <Badge tone="green">live</Badge> : null}</div>
          <p className="text-xs text-mist-500">{new Date(v.createdAt).toLocaleString()}{v.createdByName ? ` · ${v.createdByName}` : ''}</p>
          {v.note ? <p className="text-xs text-mist-600">{v.note}</p> : null}
          {canEdit && v.version !== w.latestVersion ? <Button size="sm" variant="secondary" className="mt-2" disabled={dirty} title={dirty ? 'Save or discard your edits first' : undefined} loading={m.isPending} onClick={() => m.mutate(v.version)}>Restore</Button> : null}
        </li>
      ))}
    </ul>
  );
}

function StepLog({ steps }: { steps: WfStep[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((s) => (
        <li key={s.seq} className="rounded-lg border border-mist-200 p-2.5 text-xs">
          <div className="flex items-center gap-2"><Badge tone={s.status === 'ok' ? 'green' : s.status === 'error' ? 'red' : s.status === 'waiting' ? 'amber' : 'gray'}>{s.status}</Badge><b>{s.seq}. {META[s.nodeType]?.label ?? s.nodeType}</b>{s.dryRun ? <span className="text-mist-500">dry run</span> : null}</div>
          {s.error ? <p className="mt-1 text-red-700">{s.error}</p> : null}
          {Object.keys(s.output ?? {}).length ? <pre className="mt-1 max-h-32 overflow-auto rounded bg-mist-50 p-2 whitespace-pre-wrap">{JSON.stringify(s.output, null, 1)}</pre> : null}
        </li>
      ))}
    </ol>
  );
}

function Runs({ id, onMarks }: { id: string; onMarks: (m: Record<string, string>) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [open, setOpen] = useState<string | null>(null);
  const runs = useQuery({ queryKey: ['wf-runs', id], queryFn: () => api<{ items: WfRun[] }>(`/workflows/${id}/runs`), refetchInterval: 8000 });
  const d = useQuery({ queryKey: ['wf-run', open], enabled: !!open, queryFn: () => api<{ run: WfRun; steps: WfStep[] }>(`/workflow-runs/${open}`) });
  useEffect(() => { if (d.data) onMarks(Object.fromEntries(d.data.steps.map((s) => [s.nodeId, s.status === 'error' ? 'error' : 'ok']))); }, [d.data, onMarks]);
  const cancel = useMutation({ mutationFn: (rid: string) => api(`/workflow-runs/${rid}/cancel`, { body: {} }), onSuccess: () => { toast.success('Run cancelled.'); qc.invalidateQueries({ queryKey: ['wf-runs', id] }); qc.invalidateQueries({ queryKey: ['wf-run', open] }); } });
  if (runs.isLoading) return <Skeleton className="h-24" />;
  if (!runs.data?.items.length) return <p className="text-sm text-mist-500">No runs yet. Test runs are saved here too.</p>;
  return (
    <div className="space-y-2">
      {runs.data.items.map((r) => (
        <div key={r.id} className="rounded-xl border border-mist-200 p-2.5 text-xs">
          <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
            <Badge tone={r.status === 'completed' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'waiting' || r.status === 'running' ? 'amber' : 'gray'}>{r.status}</Badge>
            <Badge tone={r.mode === 'test' ? 'gray' : 'burgundy'}>{r.mode}</Badge>
            <span className="ml-auto text-mist-500">{new Date(r.createdAt).toLocaleString()}</span>
          </button>
          {r.error ? <p className="mt-1 text-red-700">{r.error}</p> : null}
          {open === r.id && d.data ? <div className="mt-2 space-y-2"><StepLog steps={d.data.steps} />{['waiting', 'queued', 'running'].includes(r.status) && can('workflows:manage') ? <Button size="sm" variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate(r.id)}>Cancel run</Button> : null}</div> : null}
        </div>
      ))}
    </div>
  );
}

function TestModal({ id, dirty, onSave, onClose, onMarks }: { id: string; dirty: boolean; onSave: () => Promise<void>; onClose: () => void; onMarks: (m: Record<string, string>) => void }) {
  const [text, setText] = useState('Hi, what are your prices?');
  const [platform, setPlatform] = useState('telegram');
  const [name, setName] = useState('Sara Ahmed');
  const [status, setStatus] = useState('new');
  const [outcome, setOutcome] = useState('approved');
  const [res, setRes] = useState<{ run: WfRun; steps: WfStep[] } | null>(null);
  const run = useMutation({
    mutationFn: async () => { if (dirty) await onSave(); return api<{ run: WfRun; steps: WfStep[] }>(`/workflows/${id}/test`, { body: { payload: { platform, message: { text }, customer: { name, phone: '', status, tags: '' } }, taskOutcome: outcome } }); },
    onSuccess: (r) => { setRes(r); onMarks(Object.fromEntries(r.steps.map((s) => [s.nodeId, s.status === 'error' ? 'error' : 'ok']))); },
  });
  return (
    <Modal open onClose={onClose} title="Test run" description="A safe dry run: nothing is sent to customers, waits are skipped, people tasks are answered automatically. AI steps really call the AI.">
      <div className="space-y-3">
        {dirty ? <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">Your unsaved changes will be saved as a new version first.</p> : null}
        <TextAreaField label="Customer message" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>{['telegram', 'whatsapp', 'messenger', 'instagram', 'website'].map((p) => <option key={p}>{p}</option>)}</SelectField>
          <SelectField label="Customer status" value={status} onChange={(e) => setStatus(e.target.value)}>{['new', 'lead', 'customer', 'inactive'].map((p) => <option key={p}>{p}</option>)}</SelectField>
          <TextField label="Customer name" value={name} onChange={(e) => setName(e.target.value)} />
          <SelectField label="If a person task appears" value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="timeout">Timed out</option></SelectField>
        </div>
        <FormError error={run.error} />
        <Button loading={run.isPending} icon={Play} onClick={() => run.mutate()}>Run test</Button>
        {res ? <div className="space-y-2"><div className="flex items-center gap-2 text-sm"><Badge tone={res.run.status === 'completed' ? 'green' : 'red'}>{res.run.status}</Badge><span>{res.steps.length} steps</span></div>{res.run.error ? <p className="text-sm text-red-700">{res.run.error}</p> : null}<div className="max-h-80 overflow-y-auto"><StepLog steps={res.steps} /></div></div> : null}
      </div>
    </Modal>
  );
}
