export type Role = 'platform_admin' | 'owner' | 'admin' | 'manager' | 'viewer';
export type Permission =
  | 'overview:read'
  | 'ai_employees:read'
  | 'ai_employees:write'
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
export interface AiEmployee {
  id: string;
  name: string;
  jobTitle: string;
  description: string;
  status: EmployeeStatus;
  createdAt: string;
  updatedAt: string;
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
}
