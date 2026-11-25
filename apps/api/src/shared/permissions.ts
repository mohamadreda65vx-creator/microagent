/**
 * RBAC — single source of truth.
 *
 * Roles
 *   platform_admin  MicroAgent staff. Not tied to a tenant. Only reaches /platform/* routes.
 *   owner           The Business Owner. One per tenant.
 *   admin           Manages the workspace and team (except the owner and other admins).
 *   manager         Creates and edits AI Employees. Read-only on team/settings.
 *   viewer          Read-only.
 *
 * The database additionally enforces the hard boundary (tenant isolation) through RLS;
 * these permissions decide what a user may do INSIDE their own tenant.
 */
export const ROLES = ['platform_admin', 'owner', 'admin', 'manager', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export type TenantRole = Exclude<Role, 'platform_admin'>;

export const PERMISSIONS = [
  'overview:read',
  'ai_employees:read',
  'ai_employees:write',
  /** Change what an employee is ALLOWED to do (discounts, orders, refunds...) and activate/rollback it. Higher bar than editing text. */
  'ai_permissions:manage',
  'knowledge:read',
  'knowledge:write',
  'rules:read',
  'rules:write',
  'simulation:run',
  'approvals:read',
  'approvals:decide',
  'audit:read',
  'channels:read',
  /** Connect/disconnect channels (they hold credentials). */
  'channels:manage',
  'conversations:read',
  'conversations:reply',
  /** Assign, change status, take over / hand back to the AI. */
  'conversations:manage',
  'conversations:forward',
  'customers:read',
  /** Edit tags, notes, status and consent of customers. */
  'customers:manage',
  'campaigns:read',
  /** Create and edit drafts, pause / resume / cancel. */
  'campaigns:manage',
  /** Approve and launch a campaign: a message to many people. Higher bar on purpose. */
  'campaigns:approve',
  'team:read',
  'team:manage',
  'settings:read',
  'settings:manage',
  'platform:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const tenantAll: Permission[] = [
  'overview:read',
  'ai_employees:read',
  'ai_employees:write',
  'ai_permissions:manage',
  'knowledge:read',
  'knowledge:write',
  'rules:read',
  'rules:write',
  'simulation:run',
  'approvals:read',
  'approvals:decide',
  'audit:read',
  'channels:read',
  'channels:manage',
  'conversations:read',
  'conversations:reply',
  'conversations:manage',
  'conversations:forward',
  'customers:read',
  'customers:manage',
  'campaigns:read',
  'campaigns:manage',
  'campaigns:approve',
  'team:read',
  'team:manage',
  'settings:read',
  'settings:manage',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  platform_admin: ['platform:manage'],
  owner: tenantAll,
  admin: tenantAll,
  manager: ['overview:read', 'ai_employees:read', 'ai_employees:write', 'knowledge:read', 'knowledge:write', 'rules:read', 'rules:write', 'simulation:run', 'approvals:read', 'approvals:decide', 'channels:read', 'conversations:read', 'conversations:reply', 'conversations:manage', 'conversations:forward', 'customers:read', 'customers:manage', 'campaigns:read', 'campaigns:manage', 'team:read', 'settings:read'],
  viewer: ['overview:read', 'ai_employees:read', 'knowledge:read', 'rules:read', 'approvals:read', 'channels:read', 'conversations:read', 'customers:read', 'campaigns:read', 'team:read', 'settings:read'],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Which roles an actor may assign / invite. */
export function assignableRoles(actor: Role): Array<'admin' | 'manager' | 'viewer'> {
  if (actor === 'owner') return ['admin', 'manager', 'viewer'];
  if (actor === 'admin') return ['manager', 'viewer'];
  return [];
}

/** Whether the actor may modify (change role / disable) a user who currently has `target` role. */
export function canManageRole(actor: Role, target: Role): boolean {
  if (target === 'owner' || target === 'platform_admin') return false;
  if (actor === 'owner') return true;
  if (actor === 'admin') return target === 'manager' || target === 'viewer';
  return false;
}
