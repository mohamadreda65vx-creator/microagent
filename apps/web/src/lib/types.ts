export type Role = 'platform_admin' | 'owner' | 'admin' | 'manager' | 'viewer';
export type Permission =
  | 'overview:read'
  | 'ai_employees:read'
  | 'ai_employees:write'
  | 'ai_permissions:manage'
  | 'knowledge:read'
  | 'knowledge:write'
  | 'rules:read'
  | 'rules:write'
  | 'simulation:run'
  | 'approvals:read'
  | 'approvals:decide'
  | 'audit:read'
  | 'team:read'
  | 'team:manage'
  | 'settings:read'
  | 'settings:manage'
  | 'platform:manage';

export interface Me {
  user: { id: string; email: string; fullName: string; role: Role };
  tenant: { id: string; name: string; slug: string } | null;
  permissions: Permission[];
}

export type EmployeeStatus = 'draft' | 'active' | 'paused';
export type PermissionMode = 'deny' | 'allow' | 'require_approval';
export interface PermissionEntry { mode: PermissionMode; maxPercent?: number; maxAmount?: number }
export interface AiEmployee {
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
  permissions: Record<string, PermissionEntry>;
  channels: string[];
  model: string | null;
  status: EmployeeStatus;
  version: number;
  testedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Readiness { ready: boolean; fingerprint: string; checks: Array<{ key: string; ok: boolean; blocking: boolean; message: string }> }
export interface AiEmployeeDetail extends AiEmployee {
  effectivePermissions: Record<string, PermissionEntry>;
  sourceIds: string[];
  readiness: Readiness;
}
export interface Catalog {
  tasks: Array<{ key: string; label: string; description: string }>;
  actions: Array<{ key: string; label: string; description: string; tasks: string[]; defaultMode: PermissionMode; limit: 'maxPercent' | 'maxAmount' | null }>;
  dialects: string[];
  languages: string[];
  channels: string[];
  defaultModel: string;
}

export interface KnowledgeSource {
  id: string; type: 'website' | 'social' | 'document' | 'product_list' | 'business_info'; name: string; config: Record<string, unknown>;
  postLimit: number; status: 'pending' | 'analyzing' | 'analyzed' | 'failed'; lastAnalyzedAt: string | null; lastError: string | null;
  stats: Record<string, number>; itemCount: number; contentCount: number; createdAt: string;
}
export interface KnowledgeItem {
  id: string; sourceId: string | null; sourceName: string | null; kind: 'product' | 'service' | 'offer' | 'faq' | 'business_info' | 'audience';
  name: string; data: Record<string, unknown>; evidence: string; sourceRef: string; sourceDate: string | null; origin: 'extracted' | 'owner';
  status: 'unconfirmed' | 'confirmed' | 'rejected' | 'outdated'; confirmedAt: string | null; createdAt: string;
}
export interface BusinessQuestion {
  id: string; kind: 'missing' | 'conflict' | 'outdated'; question: string; priority: number;
  options: { type: 'price' | 'choose_item' | 'still_valid' | 'info'; en?: string; choices?: Array<{ itemId: string; price: number; source: string | null; date: string | null }>; name?: string; label?: string };
}

export interface Effect { type: string; [k: string]: unknown }
export interface Proposal { effect: Effect; category: 'knowledge_update' | 'behavior_update' | 'workflow_update'; enforced: boolean; summary: string; via: 'pattern' | 'ai' | 'advisory'; duplicateOf: string | null; replaces: { id: string; instruction: string } | null }
export interface TeachRule { id: string; employeeId: string | null; employeeName: string | null; instruction: string; category: Proposal['category']; effect: Effect; status: 'active' | 'disabled'; version: number; enforced: boolean; updatedAt: string }

export interface Decision { type: string; params: Record<string, unknown>; decision: 'allowed' | 'denied' | 'pending_approval' | 'invalid'; reasons: Array<{ code: string; message: string }> }
export interface SimTrace {
  reply: string; modelReply: string | null; decisions: Decision[]; findings: Array<{ code: string; severity: string; message: string }>;
  handoff: { reason: string } | null; usedModel: boolean; usage: { totalTokens: number; costUsd: number | null; model: string } | null;
  facts: Array<{ id: string; kind: string; name: string }>; error: { code: string; message: string } | null;
}
export interface SuiteResult {
  runId: string; passed: boolean; ran: number; failed: number; skipped: number; minimum: number; markedTested: boolean; note: string | null;
  results: Array<{ id: string; title: string; input?: string; ok?: boolean; skipped?: string; checks?: Array<{ name: string; ok: boolean; detail?: string }>; trace?: SimTrace }>;
}
export interface ApprovalRow { id: string; employeeId: string; employeeName: string; mode: 'simulation' | 'live'; type: string; params: Record<string, unknown>; decision: string; reasons: Array<{ message: string }>; approvalStatus: 'pending' | 'approved' | 'rejected' | null; decidedAt: string | null; decisionNote: string | null; decidedByName: string | null; createdAt: string }
export interface AuditRow { id: number; action: string; entityType: string; entityId: string | null; meta: Record<string, unknown>; createdAt: string; actorName: string | null }
export interface AiUsage {
  configured: boolean; limit: number;
  month: { tokens: number; cost: number; calls: number; errors: number; callsWithoutCost: number };
  byPurpose: Array<{ purpose: string; tokens: number; cost: number; calls: number }>;
  byModel: Array<{ model: string; tokens: number; cost: number; calls: number }>;
}

export interface Member {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: 'admin' | 'manager' | 'viewer';
  expiresAt: string;
  createdAt: string;
}

export interface Overview {
  aiEmployees: { total: number; active: number; draft: number; paused: number };
  team: { members: number; pendingInvitations: number };
  usage: { apiRequestsMonth: number; dailyApiRequests: Array<{ day: string; count: number }> };
  onboarding: { hasAiEmployee: boolean; hasTeammate: boolean };
}

export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  plan: string;
  createdAt: string;
}

export interface PlatformSummary {
  companies: number;
  activeCompanies: number;
  suspendedCompanies: number;
  users: number;
  aiEmployees: number;
  apiRequestsMonth: number;
  newCompanies30d: number;
}

export interface PlatformTenant {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  plan: string;
  createdAt: string;
  usersCount: number;
  aiEmployeesCount: number;
  apiRequestsMonth: number;
  lastLoginAt: string | null;
  aiMonthlyTokenLimit: number | null;
  aiTokensMonth: number;
  aiCostMonthUsd: number | null;
}
