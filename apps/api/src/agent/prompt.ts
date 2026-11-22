import { ACTIONS, ACTION_TYPES, TASK_INFO, resolvePermissions, type TaskKey } from './catalog.js';
import type { EmployeeProfile } from './employee.js';
import type { EffectiveRule } from './effects.js';
import { describeItem, type KnowledgeItem } from './knowledge.js';
import type { ChatMessage } from '../ai/types.js';

const DIALECT_TEXT: Record<string, string> = {
  egyptian: 'Write in natural Egyptian Arabic (اللهجة المصرية).',
  gulf: 'Write in Gulf Arabic dialect.',
  levantine: 'Write in Levantine Arabic dialect.',
  maghrebi: 'Write in Maghrebi Arabic dialect.',
  msa: 'Write in Modern Standard Arabic.',
};

export interface EffectiveStyle {
  language: 'auto' | 'ar' | 'en';
  dialect: string;
}

/** Rules override the profile for language/dialect. (Rules never widen permissions: that is enforced in the policy engine.) */
export function effectiveStyle(e: EmployeeProfile, rules: EffectiveRule[]): EffectiveStyle {
  let language = e.language;
  let dialect = e.dialect;
  for (const r of rules) {
    if (r.effect.type === 'language') language = r.effect.value;
    if (r.effect.type === 'dialect') dialect = r.effect.value;
  }
  return { language, dialect };
}

/**
 * The system prompt is ASSEMBLED per message from separate parts (profile, rules grouped by category, the few facts that
 * matter for this message, the permission table). It is not one big stored prompt. Safety does NOT depend on this text:
 * every action and every reply is re-checked by the backend (policy engine + guards).
 */
export function buildSystemPrompt(e: EmployeeProfile, rules: EffectiveRule[], facts: KnowledgeItem[], style: EffectiveStyle): string {
  const perms = resolvePermissions(e.permissions);
  const tasks = e.tasks.map((t) => `- ${TASK_INFO[t as TaskKey]?.label ?? t}`).join('\n') || '- (none)';
  const behaviour = rules.filter((r) => r.category === 'behavior_update').map((r) => `- ${r.instruction}`);
  const workflow = rules.filter((r) => r.category === 'workflow_update').map((r) => `- ${r.instruction}`);
  const actions = ACTION_TYPES.map((t) => {
    const p = perms[t];
    const lim = p.maxPercent !== undefined ? ` (max ${p.maxPercent}%)` : p.maxAmount !== undefined ? ` (max ${p.maxAmount})` : '';
    return `- ${t}: ${ACTIONS[t].description} [${p.mode}${lim}] e.g. ${JSON.stringify(ACTIONS[t].example)}`;
  }).join('\n');

  const lang =
    style.language === 'ar' ? `Always answer in Arabic. ${DIALECT_TEXT[style.dialect] ?? ''}`
    : style.language === 'en' ? 'Always answer in English.'
    : `Answer in the language the customer writes in. ${style.dialect !== 'none' ? `When Arabic, ${DIALECT_TEXT[style.dialect] ?? ''}` : ''}`;

  return [
    `You are ${e.name}${e.jobTitle ? `, ${e.jobTitle}` : ''}, an AI employee of a business, talking to the business's customers.`,
    e.description && `About your role: ${e.description}`,
    e.personality && `Personality: ${e.personality}`,
    lang,
    `\n## Your tasks\n${tasks}`,
    `\n## Facts you may use (confirmed by the business owner)\n${facts.length ? facts.map((f) => `- ${describeItem(f)}`).join('\n') : '- (no confirmed facts match this message)'}`,
    `\n## Hard rules about facts\n- Use ONLY the facts above for prices, offers, products, hours and policies.\n- NEVER invent or guess a price, a discount, an offer or stock/availability. If a fact is not listed, say you will check with the team.\n- You have NO access to live inventory. Do not say anything is in stock or out of stock.\n- Do not promise discounts unless a listed offer says so.`,
    behaviour.length ? `\n## Behaviour rules from the owner\n${behaviour.join('\n')}` : '',
    workflow.length ? `\n## Workflow rules from the owner\n${workflow.join('\n')}` : '',
    `\n## Actions you may PROPOSE\nProposing is not doing: the platform decides. Never say an action is done unless it is allowed.\n${actions}`,
    `\n## Output format\nReply with ONLY a JSON object: {"reply": "<message to the customer>", "actions": [{"type": "<action>", "params": {...}}]}. "actions" may be empty. No text outside the JSON.`,
  ].filter(Boolean).join('\n');
}

export function buildMessages(system: string, history: ChatMessage[]): ChatMessage[] {
  return [{ role: 'system', content: system }, ...history];
}
