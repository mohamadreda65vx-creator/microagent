import { BarChart3, BookOpen, GraduationCap, LayoutDashboard, MessageSquare, Megaphone, Radio, Settings, Users, UserSquare2, Workflow, UsersRound, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { Permission } from '../../lib/types';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
  /** Not built yet: the page shows an honest "coming in a later phase" state instead of fake data. */
  planned?: boolean;
  end?: boolean;
}

export const NAV: NavItem[] = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, permission: 'overview:read', end: true },
  { to: '/app/ai-employees', label: 'AI Employees', icon: Users, permission: 'ai_employees:read' },
  { to: '/app/conversations', label: 'Conversations', icon: MessageSquare, permission: 'overview:read', planned: true },
  { to: '/app/channels', label: 'Channels', icon: Radio, permission: 'overview:read', planned: true },
  { to: '/app/customers', label: 'Customers', icon: UserSquare2, permission: 'overview:read', planned: true },
  { to: '/app/campaigns', label: 'Campaigns', icon: Megaphone, permission: 'overview:read', planned: true },
  { to: '/app/knowledge', label: 'Business Knowledge', icon: BookOpen, permission: 'knowledge:read' },
  { to: '/app/workflows', label: 'Workflow Builder', icon: Workflow, permission: 'overview:read', planned: true },
  { to: '/app/teach', label: 'Teach & Correct', icon: GraduationCap, permission: 'rules:read' },
  { to: '/app/activity', label: 'Approvals & Audit', icon: ShieldCheck, permission: 'approvals:read' },
  { to: '/app/performance', label: 'Performance', icon: BarChart3, permission: 'overview:read', planned: true },
  { to: '/app/team', label: 'Team', icon: UsersRound, permission: 'team:read' },
  { to: '/app/settings', label: 'Settings', icon: Settings, permission: 'settings:read' },
];

export const PLANNED_COPY: Record<string, { title: string; description: string }> = {
  conversations: { title: 'Conversations', description: 'Every customer conversation your AI employees handle will appear here, with full history and hand-off to your team.' },
  channels: { title: 'Channels', description: 'Connect Messenger, WhatsApp, Instagram and your website chat so your AI employees can reach customers.' },
  customers: { title: 'Customers', description: 'A profile for every person who talks to your business, with their conversation history and details.' },
  campaigns: { title: 'Campaigns', description: 'Send planned outreach and follow-ups through your AI employees, and see what works.' },
  knowledge: { title: 'Business Knowledge', description: 'Upload your products, prices, policies and FAQs so your AI employees answer from facts about your business.' },
  workflows: { title: 'Workflow Builder', description: 'Design the steps an AI employee follows and connect it to the tools your team already uses.' },
  teach: { title: 'Teach & Correct', description: 'Review answers, correct mistakes once, and watch your AI employees improve.' },
  performance: { title: 'Performance', description: 'Response times, resolved conversations and quality for each AI employee.' },
};
