export type Role = 'platform_admin' | 'owner' | 'admin' | 'manager' | 'viewer';
export type Permission =
  | 'overview:read'
  | 'ai_employees:read'
  | 'ai_employees:write'
  | 'ai_permissions:manage'
  | 'channels:read'
  | 'channels:manage'
  | 'conversations:read'
  | 'conversations:reply'
  | 'conversations:manage'
  | 'conversations:forward'
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

/* ───────── Part 3: channels & conversations ───────── */
export type ChannelType = 'whatsapp' | 'messenger' | 'instagram' | 'telegram' | 'website' | 'tiktok';
export type ChannelStatus = 'pending' | 'connecting' | 'connected' | 'disconnected' | 'error' | 'awaiting_approval' | 'not_configured';
export interface ChannelCapabilities { sendFiles: boolean; deliveryStatus: boolean; replyWindowHours: number | null; maxTextLength: number }
export interface CatalogItem { type: ChannelType; label: string; provider: string; available: boolean; setup: 'token' | 'qr' | 'oauth' | 'none'; serverReady: boolean; unofficial: boolean; notes: string[]; capabilities: ChannelCapabilities }
export interface Channel {
  id: string;
  type: ChannelType;
  provider: string;
  name: string;
  status: ChannelStatus;
  employeeId: string | null;
  employeeName: string | null;
  employeeStatus: EmployeeStatus | null;
  autoReply: boolean;
  config: Record<string, unknown> & { title?: string; welcome?: string; color?: string; allowedOrigins?: string[]; verified?: boolean };
  healthStatus: 'healthy' | 'degraded' | 'down' | 'unknown';
  lastHealthAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  consecutiveFailures: number;
  createdAt: string;
  conversations: number;
  unread: number;
  failedMessages: number;
  hasQr: boolean;
  account: string | null;
  webhookUrl: string | null;
  setup: 'token' | 'qr' | 'oauth' | 'none';
  unofficial: boolean;
  pendingPages: Array<{ id: string; name: string; igId?: string; igUsername?: string }>;
  capabilities: ChannelCapabilities;
  publicKey?: string;
  recentEvents?: Array<{ id: number; kind: string; status: string; detail: string | null; createdAt: string }>;
  last24h?: { rejected: number; errors: number; duplicates: number };
}
export type ConvStatus = 'open' | 'pending' | 'resolved';
export type AiState = 'ai_answering' | 'human_has_it' | 'no_employee' | 'employee_not_live' | 'auto_reply_off' | 'channel_not_connected';
export interface Conversation {
  id: string;
  platform: ChannelType;
  channelId: string;
  channelName: string;
  channelStatus: ChannelStatus;
  status: ConvStatus;
  handler: 'ai' | 'human';
  assignedTo: { id: string; name: string } | null;
  employeeId: string | null;
  employeeName: string | null;
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastInboundAt: string | null;
  handoffReason: string | null;
  handoffAt: string | null;
  createdAt: string;
  contact: { id: string; name: string | null; phone: string | null; externalId?: string; firstSeenAt: string };
  aiState: AiState;
  stats?: { messages: number; inbound: number };
  capabilities?: ChannelCapabilities;
  platformLabel?: string;
}
export interface ConversationList { platform: ChannelType; items: Conversation[]; next: string | null; counts: { all: number; unread: number; unassigned: number; mine: number; pending: number; open: number; resolved: number; human: number } }
export interface ChatAttachment { kind: string; name?: string; mime?: string; size?: number; fileId?: string }
export interface ChatMessage {
  id: string;
  direction: 'in' | 'out';
  senderType: 'customer' | 'ai' | 'human' | 'system';
  senderName: string | null;
  body: string;
  attachments: ChatAttachment[];
  status: 'received' | 'queued' | 'sending' | 'retry' | 'sent' | 'delivered' | 'read' | 'failed';
  error: string | null;
  errorCode: string | null;
  attempts: number;
  meta: { forward?: { fromPlatform: string }; ai?: { blocked?: string[]; error?: string | null } };
  createdAt: string;
  forwardCount: number;
}
export interface PlatformCounters { total: number; unreadConversations: number; unread: number; needsHuman: number }
