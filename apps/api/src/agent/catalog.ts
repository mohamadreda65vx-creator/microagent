import { z } from 'zod';
import { normalizePhone } from './text.js';

/* ───────────── Tasks an employee can be hired for ───────────── */
export const TASKS = ['customer_support', 'lead_collection', 'sales_assistant', 'follow_up', 'booking', 'order_assistance', 'faq', 'human_handoff'] as const;
export type TaskKey = (typeof TASKS)[number];

export const TASK_INFO: Record<TaskKey, { label: string; description: string }> = {
  customer_support: { label: 'Customer Support', description: 'Answers customer questions and helps solve problems using the business knowledge.' },
  lead_collection: { label: 'Lead Collection', description: 'Collects the name, phone or email of interested customers.' },
  sales_assistant: { label: 'Sales Assistant', description: 'Helps customers choose products or services and explains offers.' },
  follow_up: { label: 'Follow-up', description: 'Schedules follow-up messages for customers who did not finish.' },
  booking: { label: 'Booking', description: 'Takes booking and appointment requests.' },
  order_assistance: { label: 'Order Assistance', description: 'Helps customers place and understand their orders.' },
  faq: { label: 'FAQ', description: 'Answers frequently asked questions from the confirmed knowledge.' },
  human_handoff: { label: 'Human Handoff', description: 'Passes the conversation to a person when the customer asks or the AI should not continue.' },
};

export const DIALECTS = ['none', 'egyptian', 'gulf', 'levantine', 'maghrebi', 'msa'] as const;
export const LANGUAGES = ['auto', 'ar', 'en'] as const;
export const CHANNELS = ['whatsapp', 'messenger', 'instagram', 'website_chat'] as const;

/* ───────────── Actions an employee may PROPOSE. The backend decides whether they happen. ───────────── */
export const ACTION_TYPES = ['collect_lead', 'give_discount', 'create_order', 'create_booking', 'schedule_followup', 'check_inventory', 'issue_refund', 'handoff_to_human'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const PERMISSION_MODES = ['deny', 'allow', 'require_approval'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const phone = z
  .string()
  .max(40)
  .refine((v) => normalizePhone(v) !== null, 'invalid phone number');
const text = (max = 200) => z.string().trim().min(1).max(max);

export const ACTION_SCHEMAS = {
  collect_lead: z
    .object({ name: text().optional(), phone: phone.optional(), email: z.email().max(254).optional(), interest: text(300).optional() })
    .refine((v) => v.name || v.phone || v.email, 'at least a name, phone or email is required'),
  give_discount: z
    .object({ percent: z.number().min(0).max(100).optional(), amount: z.number().positive().optional(), item: text().optional() })
    .refine((v) => v.percent !== undefined || v.amount !== undefined, 'a percent or an amount is required'),
  create_order: z.object({
    items: z.array(z.object({ name: text(), quantity: z.number().int().min(1).max(1000).default(1) })).min(1).max(50),
    customer_phone: phone.optional(),
    customer_name: text().optional(),
    total: z.number().nonnegative().optional(),
  }),
  create_booking: z.object({
    service: text(),
    datetime: z.string().max(60).refine((v) => !Number.isNaN(Date.parse(v)), 'datetime must be a valid date'),
    customer_phone: phone.optional(),
    customer_name: text().optional(),
  }),
  schedule_followup: z.object({ delay_hours: z.number().min(1).max(720), note: text(300).optional() }),
  check_inventory: z.object({ item: text() }),
  issue_refund: z.object({ order_ref: text(60), amount: z.number().positive() }),
  handoff_to_human: z.object({ reason: text(300), urgency: z.enum(['normal', 'high']).default('normal') }),
} satisfies Record<ActionType, z.ZodType>;

export interface ActionInfo {
  label: string;
  description: string;
  /** The action is only available to employees that have at least one of these tasks. Empty = always available. */
  tasks: readonly TaskKey[];
  defaultMode: PermissionMode;
  /** Whether a numeric limit can be configured. */
  limit?: 'maxPercent' | 'maxAmount';
  /** Example parameters, shown to the model in its instructions. */
  example: Record<string, unknown>;
}

export const ACTIONS: Record<ActionType, ActionInfo> = {
  collect_lead: { label: 'Collect lead', description: 'Save a customer’s contact details.', tasks: ['lead_collection', 'sales_assistant'], defaultMode: 'allow', example: { name: 'Sara', phone: '+201001234567' } },
  give_discount: { label: 'Give discount', description: 'Offer a discount to a customer.', tasks: ['sales_assistant', 'customer_support', 'order_assistance'], defaultMode: 'deny', limit: 'maxPercent', example: { percent: 10, item: 'Sample item' } },
  create_order: { label: 'Create order', description: 'Create an order for a customer.', tasks: ['order_assistance', 'sales_assistant'], defaultMode: 'require_approval', limit: 'maxAmount', example: { items: [{ name: 'Sample item', quantity: 2 }], customer_phone: '+201001234567' } },
  create_booking: { label: 'Create booking', description: 'Book an appointment or reservation.', tasks: ['booking'], defaultMode: 'require_approval', example: { service: 'Haircut', datetime: '2030-01-15T16:00:00Z', customer_phone: '+201001234567' } },
  schedule_followup: { label: 'Schedule follow-up', description: 'Schedule a follow-up message.', tasks: ['follow_up'], defaultMode: 'allow', example: { delay_hours: 24, note: 'Ask if they still want the offer' } },
  check_inventory: { label: 'Check inventory', description: 'Look up live stock. Needs an inventory connection.', tasks: ['customer_support', 'sales_assistant', 'order_assistance'], defaultMode: 'allow', example: { item: 'Sample item' } },
  issue_refund: { label: 'Issue refund', description: 'Refund money to a customer.', tasks: ['customer_support', 'order_assistance'], defaultMode: 'deny', limit: 'maxAmount', example: { order_ref: 'A-1001', amount: 100 } },
  handoff_to_human: { label: 'Hand off to a human', description: 'Pass the conversation to a person. Always available for safety.', tasks: [], defaultMode: 'allow', example: { reason: 'Customer is upset', urgency: 'high' } },
};

/* ───────────── Per-employee permission configuration ───────────── */
export const permissionEntrySchema = z.object({
  mode: z.enum(PERMISSION_MODES),
  maxPercent: z.number().min(0).max(100).optional(),
  maxAmount: z.number().min(0).optional(),
});
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type PermissionConfig = Partial<Record<ActionType, PermissionEntry>>;

export const permissionsSchema = z
  .partialRecord(z.enum(ACTION_TYPES), permissionEntrySchema)
  .refine((v) => v.handoff_to_human === undefined || v.handoff_to_human.mode === 'allow', { message: 'Hand-off to a human can never be disabled', path: ['handoff_to_human'] });

/** The full, effective permission table (defaults + the employee's overrides). Handing off to a human is always allowed. */
export function resolvePermissions(config: PermissionConfig | null | undefined): Record<ActionType, PermissionEntry> {
  const out = {} as Record<ActionType, PermissionEntry>;
  for (const type of ACTION_TYPES) {
    const base: PermissionEntry = { mode: ACTIONS[type].defaultMode };
    if (type === 'give_discount') base.maxPercent = 0;
    out[type] = { ...base, ...(config?.[type] ?? {}) };
  }
  out.handoff_to_human = { mode: 'allow' };
  return out;
}

export const isActionType = (v: unknown): v is ActionType => typeof v === 'string' && (ACTION_TYPES as readonly string[]).includes(v);
