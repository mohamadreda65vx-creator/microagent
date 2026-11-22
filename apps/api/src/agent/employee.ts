import { createHash } from 'node:crypto';
import type { Client } from '../db/pool.js';
import { effectSchema, type EffectiveRule } from './effects.js';
import { resolvePermissions, type PermissionConfig } from './catalog.js';

export interface EmployeeProfile {
  id: string;
  name: string;
  jobTitle: string;
  description: string;
  personality: string;
  avatar: string;
  language: 'auto' | 'ar' | 'en';
  dialect: string;
  tasks: string[];
  knowledgeMode: 'all' | 'selected';
  permissions: PermissionConfig;
  channels: string[];
  model: string | null;
  status: 'draft' | 'active' | 'paused';
  version: number;
  testedFingerprint: string | null;
  testedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const EMPLOYEE_COLUMNS = `id, name, job_title AS "jobTitle", description, personality, avatar, language, dialect, tasks,
  knowledge_mode AS "knowledgeMode", permissions, channels, model, status, version,
  tested_fingerprint AS "testedFingerprint", tested_at AS "testedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function loadEmployee(c: Client, id: string): Promise<EmployeeProfile | null> {
  const { rows } = await c.query(`SELECT ${EMPLOYEE_COLUMNS} FROM ai_employees WHERE id = $1`, [id]);
  return (rows[0] as EmployeeProfile | undefined) ?? null;
}

/** Active rules that apply to this employee (company-wide rules + its own). Invalid stored effects are skipped, never trusted. */
export async function loadRules(c: Client, employeeId: string): Promise<EffectiveRule[]> {
  const { rows } = await c.query(
    `SELECT id, instruction, category, effect, employee_id AS "employeeId" FROM teach_rules
     WHERE status = 'active' AND (employee_id IS NULL OR employee_id = $1) ORDER BY created_at`,
    [employeeId],
  );
  const out: EffectiveRule[] = [];
  for (const r of rows) {
    const parsed = effectSchema.safeParse(r.effect);
    if (parsed.success) out.push({ id: r.id, instruction: r.instruction, category: r.category, effect: parsed.data, employeeId: r.employeeId });
  }
  return out;
}

/** The employee fields that define its behaviour (what a test run is valid for, and what a version snapshot stores). */
export function behaviourSnapshot(e: EmployeeProfile) {
  return {
    name: e.name,
    jobTitle: e.jobTitle,
    description: e.description,
    personality: e.personality,
    avatar: e.avatar,
    language: e.language,
    dialect: e.dialect,
    tasks: [...e.tasks].sort(),
    knowledgeMode: e.knowledgeMode,
    permissions: resolvePermissions(e.permissions),
    channels: [...e.channels].sort(),
    model: e.model,
  };
}

/**
 * Fingerprint of everything that changes what the employee says or may do: profile, permissions, active rules,
 * and the confirmed knowledge it can see. A simulation is only valid for the fingerprint it ran against.
 */
export async function configFingerprint(c: Client, e: EmployeeProfile): Promise<string> {
  const rules = await loadRules(c, e.id);
  const ids = await knowledgeIdsFor(c, e);
  const h = createHash('sha256');
  h.update(JSON.stringify(behaviourSnapshot(e)));
  h.update(JSON.stringify(rules.map((r) => [r.id, r.effect]).sort()));
  h.update(JSON.stringify(ids));
  return h.digest('hex').slice(0, 32);
}

async function knowledgeIdsFor(c: Client, e: EmployeeProfile): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT id || ':' || extract(epoch from updated_at)::text AS k FROM knowledge_items
     WHERE status = 'confirmed' AND ${visibleSql('$1', e.knowledgeMode)} ORDER BY id`,
    [e.id],
  );
  return rows.map((r) => r.k as string);
}

/** SQL fragment: knowledge an employee may use. 'all' = every confirmed item of the company; 'selected' = items from chosen sources + owner/teach items. */
export function visibleSql(employeeParam: string, mode: 'all' | 'selected'): string {
  return mode === 'all'
    ? `${employeeParam}::uuid IS NOT NULL`
    : `(source_id IS NULL OR source_id IN (SELECT source_id FROM employee_sources WHERE employee_id = ${employeeParam}))`;
}

export async function audit(c: Client, tenantId: string, actor: string | null, action: string, entityType: string, entityId: string | null, meta: Record<string, unknown> = {}): Promise<void> {
  await c.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, meta) VALUES ($1, $2, $3, $4, $5::text, $6)`,
    [tenantId, actor, action, entityType, entityId, JSON.stringify(meta)],
  );
}
