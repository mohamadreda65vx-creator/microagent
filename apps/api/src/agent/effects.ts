import { z } from 'zod';
import { ACTION_TYPES, DIALECTS } from './catalog.js';

/**
 * A Teach & Correct rule is stored as a STRUCTURED effect, not as free text in a prompt.
 * Each effect type is either ENFORCED by backend code (policy engine / guards / data) or ADVISORY (guidance for the model).
 */
const action = z.enum(ACTION_TYPES);

export const effectSchema = z.discriminatedUnion('type', [
  // behaviour
  z.object({ type: z.literal('prohibit_action'), action }),
  z.object({ type: z.literal('dialect'), value: z.enum(DIALECTS).exclude(['none']) }),
  z.object({ type: z.literal('language'), value: z.enum(['ar', 'en']) }),
  z.object({ type: z.literal('tone'), value: z.enum(['formal', 'friendly', 'concise']) }),
  z.object({ type: z.literal('instruction'), text: z.string().trim().min(3).max(500) }),
  // workflow
  z.object({ type: z.literal('require_approval'), action }),
  z.object({ type: z.literal('require_field'), field: z.enum(['phone', 'name', 'email']), before_action: action }),
  z.object({ type: z.literal('handoff_trigger'), trigger: z.enum(['angry_customer', 'customer_requests_human']) }),
  z.object({ type: z.literal('require_inventory_check') }),
  // knowledge
  z.object({
    type: z.literal('knowledge_fact'),
    kind: z.enum(['product', 'service', 'offer', 'faq', 'business_info']),
    name: z.string().trim().min(1).max(300),
    price: z.number().nonnegative().optional(),
    currency: z.string().trim().min(1).max(10).optional(),
    text: z.string().trim().max(1000).optional(),
  }),
]);
export type Effect = z.infer<typeof effectSchema>;
export type Category = 'knowledge_update' | 'behavior_update' | 'workflow_update';

export const CATEGORY_OF: Record<Effect['type'], Category> = {
  prohibit_action: 'behavior_update',
  dialect: 'behavior_update',
  language: 'behavior_update',
  tone: 'behavior_update',
  instruction: 'behavior_update',
  require_approval: 'workflow_update',
  require_field: 'workflow_update',
  handoff_trigger: 'workflow_update',
  require_inventory_check: 'workflow_update',
  knowledge_fact: 'knowledge_update',
};

/** Advisory effects only steer the model's wording; the backend cannot verify them. Everything else is enforced in code. */
export const isEnforced = (e: Effect): boolean => e.type !== 'tone' && e.type !== 'instruction';

/** Stable identity of an effect, used to refuse duplicates and to detect rules that overlap. */
export function effectKey(e: Effect): string {
  switch (e.type) {
    case 'prohibit_action':
    case 'require_approval':
      return `${e.type}:${e.action}`;
    case 'require_field':
      return `${e.type}:${e.before_action}:${e.field}`;
    case 'handoff_trigger':
      return `${e.type}:${e.trigger}`;
    case 'dialect':
    case 'language':
    case 'tone':
      return `${e.type}`; // one dialect / language / tone at a time
    case 'require_inventory_check':
      return e.type;
    case 'instruction':
      return `instruction:${e.text.toLowerCase()}`;
    case 'knowledge_fact':
      return `fact:${e.kind}:${e.name.toLowerCase()}`;
  }
}

export interface EffectiveRule {
  id: string;
  instruction: string;
  category: Category;
  effect: Effect;
  employeeId: string | null;
}
