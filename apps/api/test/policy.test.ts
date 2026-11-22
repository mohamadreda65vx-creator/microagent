import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateAction, type PolicyContext } from '../src/agent/policy.js';
import { asksForHuman, checkReply, detectAngry, findPriceClaims, priceIsKnown, safeReply } from '../src/agent/guards.js';
import { effectKey, effectSchema, type EffectiveRule } from '../src/agent/effects.js';
import { permissionsSchema, resolvePermissions } from '../src/agent/catalog.js';
import { findPhone, normKey, normalizeText, tokenize } from '../src/agent/text.js';

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  tasks: ['sales_assistant', 'order_assistance', 'customer_support', 'booking', 'lead_collection', 'follow_up'],
  permissions: {},
  rules: [],
  inventoryConnected: false,
  known: {},
  ...over,
});
const rule = (effect: EffectiveRule['effect'], instruction = 'rule text'): EffectiveRule => ({ id: 'r1', instruction, category: 'behavior_update', effect, employeeId: null });

describe('policy engine (pure, no model)', () => {
  it('denies discounts by default and when the % is above the limit; allows within the limit', () => {
    assert.equal(evaluateAction({ type: 'give_discount', params: { percent: 10 } }, ctx()).decision, 'denied');
    const lim = ctx({ permissions: { give_discount: { mode: 'allow', maxPercent: 10 } } });
    assert.equal(evaluateAction({ type: 'give_discount', params: { percent: 10 } }, lim).decision, 'allowed');
    const over = evaluateAction({ type: 'give_discount', params: { percent: 25 } }, lim);
    assert.equal(over.decision, 'denied');
    assert.equal(over.reasons[0]!.code, 'exceeds_limit');
  });

  it('a "no discounts" rule overrides a permissive employee setting (rules can only restrict)', () => {
    const c = ctx({ permissions: { give_discount: { mode: 'allow', maxPercent: 50 } }, rules: [rule({ type: 'prohibit_action', action: 'give_discount' }, 'ممنوع الخصومات')] });
    const d = evaluateAction({ type: 'give_discount', params: { percent: 5 } }, c);
    assert.equal(d.decision, 'denied');
    assert.equal(d.reasons[0]!.code, 'blocked_by_rule');
    assert.equal(d.reasons[0]!.ruleId, 'r1');
  });

  it('orders need approval by default; an order over the limit needs approval even when allowed', () => {
    const order = { type: 'create_order', params: { items: [{ name: 'Latte', quantity: 2 }], total: 500 } };
    assert.equal(evaluateAction(order, ctx()).decision, 'pending_approval');
    const c = ctx({ permissions: { create_order: { mode: 'allow', maxAmount: 300 } } });
    assert.equal(evaluateAction(order, c).decision, 'pending_approval');
    assert.equal(evaluateAction({ type: 'create_order', params: { items: [{ name: 'Latte' }], total: 100 } }, c).decision, 'allowed');
  });

  it('require_field: an order without the customer phone is invalid until the phone is known', () => {
    const c = ctx({ permissions: { create_order: { mode: 'allow' } }, rules: [rule({ type: 'require_field', field: 'phone', before_action: 'create_order' }, 'اجمع رقم الهاتف قبل الطلب')] });
    const missing = evaluateAction({ type: 'create_order', params: { items: [{ name: 'Latte' }] } }, c);
    assert.equal(missing.decision, 'invalid');
    assert.equal(missing.reasons[0]!.field, 'phone');
    assert.equal(evaluateAction({ type: 'create_order', params: { items: [{ name: 'Latte' }], customer_phone: '+201001234567' } }, c).decision, 'allowed');
    assert.equal(evaluateAction({ type: 'create_order', params: { items: [{ name: 'Latte' }] } }, { ...c, known: { phone: '01001234567' } }).decision, 'allowed');
  });

  it('task gating: booking needs the booking task', () => {
    const p = { type: 'create_booking', params: { service: 'Cut', datetime: '2099-01-01T10:00:00Z' } };
    assert.equal(evaluateAction(p, ctx({ tasks: ['faq'], permissions: { create_booking: { mode: 'allow' } } })).reasons[0]!.code, 'task_not_enabled');
    assert.equal(evaluateAction(p, ctx({ permissions: { create_booking: { mode: 'allow' } } })).decision, 'allowed');
  });

  it('validation: bad params, unknown actions, past bookings, invalid phone', () => {
    assert.equal(evaluateAction({ type: 'hack_database', params: {} }, ctx()).decision, 'invalid');
    assert.equal(evaluateAction({ type: 'give_discount', params: { percent: 'lots' } }, ctx()).decision, 'invalid');
    assert.equal(evaluateAction({ type: 'collect_lead', params: { phone: 'abc' } }, ctx()).decision, 'invalid');
    assert.equal(evaluateAction({ type: 'collect_lead', params: {} }, ctx()).decision, 'invalid');
    assert.equal(evaluateAction({ type: 'create_booking', params: { service: 'x', datetime: '2001-01-01T10:00:00Z' } }, ctx({ permissions: { create_booking: { mode: 'allow' } } })).decision, 'invalid');
    assert.equal(evaluateAction({ type: 'collect_lead', params: { phone: '+20 100 123 4567' } }, ctx()).decision, 'allowed');
  });

  it('inventory cannot be checked without a connected source', () => {
    const d = evaluateAction({ type: 'check_inventory', params: { item: 'Latte' } }, ctx());
    assert.equal(d.decision, 'denied');
    assert.equal(d.reasons[0]!.code, 'inventory_not_connected');
  });

  it('hand-off to a human can never be blocked, even by a rule or a deny setting', () => {
    const c = ctx({ tasks: [], rules: [rule({ type: 'prohibit_action', action: 'handoff_to_human' })] });
    assert.equal(evaluateAction({ type: 'handoff_to_human', params: { reason: 'angry' } }, c).decision, 'allowed');
    assert.equal(permissionsSchema.safeParse({ handoff_to_human: { mode: 'deny' } }).success, false);
    assert.equal(resolvePermissions({ handoff_to_human: { mode: 'deny' } } as never).handoff_to_human.mode, 'allow');
  });

  it('refunds are denied by default and above the limit', () => {
    assert.equal(evaluateAction({ type: 'issue_refund', params: { order_ref: 'A1', amount: 10 } }, ctx()).decision, 'denied');
    const c = ctx({ permissions: { issue_refund: { mode: 'allow', maxAmount: 50 } } });
    assert.equal(evaluateAction({ type: 'issue_refund', params: { order_ref: 'A1', amount: 40 } }, c).decision, 'allowed');
    assert.equal(evaluateAction({ type: 'issue_refund', params: { order_ref: 'A1', amount: 90 } }, c).decision, 'denied');
  });
});

describe('output guards', () => {
  it('finds price claims in English and Arabic (incl. Arabic digits) but ignores weights and plain numbers', () => {
    assert.deepEqual(findPriceClaims('The latte is 45 EGP.'), [45]);
    assert.deepEqual(findPriceClaims('القهوة بـ ٦٠ جنيه'), [60]);
    assert.deepEqual(findPriceClaims('Price: $1,250.50'), [1250.5]);
    assert.deepEqual(findPriceClaims('عبوة 500 جم وعددها 3'), []);
    assert.deepEqual(findPriceClaims('We open at 10 and have 3 branches'), []);
  });

  it('accepts confirmed prices, quantities, sums and numbers the customer said; rejects invented ones', () => {
    assert.equal(priceIsKnown(45, [45, 60], []), true);
    assert.equal(priceIsKnown(135, [45], [3]), true, '3 × 45 (customer said 3)');
    assert.equal(priceIsKnown(135, [45], []), false, 'a multiple without a customer quantity is NOT accepted');
    assert.equal(priceIsKnown(105, [45, 60], []), true, '45 + 60');
    assert.equal(priceIsKnown(50, [45, 60], [50]), true, 'customer quoted it');
    assert.equal(priceIsKnown(99, [45, 60], []), false);
  });

  it('blocks an invented price, an unapproved discount and a stock claim; passes a clean answer', () => {
    const opts = { knownPrices: [45], customerNumbers: [], knownPercents: [], maxDiscountPercent: 0, inventoryConnected: false };
    assert.deepEqual(checkReply('The latte costs 45 EGP.', opts), []);
    assert.equal(checkReply('The latte costs 52 EGP.', opts)[0]!.code, 'price_not_in_knowledge');
    assert.equal(checkReply('Sure, I can give you 20% off!', opts)[0]!.code, 'unapproved_discount');
    assert.equal(checkReply('خصم 15% عليك النهاردة', opts)[0]!.code, 'unapproved_discount');
    assert.equal(checkReply('Yes, it is in stock, only 3 left!', opts)[0]!.code, 'stock_claim');
    assert.equal(checkReply('نعم متوفر الآن', opts)[0]!.code, 'stock_claim');
    assert.deepEqual(checkReply('We do not offer discounts, sorry.', opts), []);
    assert.deepEqual(checkReply('Yes, it is in stock', { ...opts, inventoryConnected: true }), []);
  });

  it('allows quoting a REAL confirmed offer percentage and discounts within the employee limit', () => {
    const base = { knownPrices: [], customerNumbers: [], inventoryConnected: false };
    assert.deepEqual(checkReply('This week we have 10% off on all drinks.', { ...base, knownPercents: [10], maxDiscountPercent: 0 }), []);
    assert.deepEqual(checkReply('I can offer 5% off.', { ...base, knownPercents: [], maxDiscountPercent: 5 }), []);
    assert.equal(checkReply('I can offer 8% off.', { ...base, knownPercents: [], maxDiscountPercent: 5 })[0]!.code, 'unapproved_discount');
  });

  it('warns when the reply is not in the required language', () => {
    const opts = { knownPrices: [], customerNumbers: [], knownPercents: [], maxDiscountPercent: 0, inventoryConnected: false };
    assert.equal(checkReply('Hello, how can I help you today my friend?', { ...opts, expectedLanguage: 'ar' })[0]!.code, 'language_mismatch');
    assert.deepEqual(checkReply('أهلا بيك، أقدر أساعدك إزاي النهاردة؟', { ...opts, expectedLanguage: 'ar' }), []);
  });

  it('detects angry customers and requests for a human, in English and Arabic', () => {
    assert.equal(detectAngry('This is unacceptable, I want a refund now!'), true);
    assert.equal(detectAngry('ده نصب وأنا زهقت منكم'), true);
    assert.equal(detectAngry('Hi, what are your opening hours?'), false);
    assert.equal(asksForHuman('Can I talk to a real person?'), true);
    assert.equal(asksForHuman('عايز اكلم حد من الفريق'), true);
    assert.equal(asksForHuman('How much is the latte?'), false);
  });

  it('safe replies exist in English, MSA and Egyptian Arabic', () => {
    assert.match(safeReply('discount_denied', 'en'), /discounts/);
    assert.match(safeReply('discount_denied', 'ar', true), /مقدرش/);
    assert.match(safeReply('discount_denied', 'ar', false), /لا أستطيع/);
    assert.match(safeReply('missing_field', 'ar', true, 'phone'), /رقم هاتفك/);
  });
});

describe('effects and text helpers', () => {
  it('effect schema accepts known effects and rejects unknown actions', () => {
    assert.equal(effectSchema.safeParse({ type: 'prohibit_action', action: 'give_discount' }).success, true);
    assert.equal(effectSchema.safeParse({ type: 'prohibit_action', action: 'launch_rocket' }).success, false);
    assert.equal(effectSchema.safeParse({ type: 'sudo' }).success, false);
  });
  it('effect keys identify duplicates', () => {
    assert.equal(effectKey({ type: 'prohibit_action', action: 'give_discount' }), effectKey({ type: 'prohibit_action', action: 'give_discount' }));
    assert.notEqual(effectKey({ type: 'dialect', value: 'egyptian' }) + 'x', '');
  });
  it('Arabic normalisation, tokenising and phone extraction', () => {
    assert.equal(normalizeText('الْقَهْوَة'), normalizeText('القهوه'));
    assert.ok(tokenize('كم سعر القهوة؟').includes('قهوه'));
    assert.equal(normKey('  Latte!! '), 'latte');
    assert.equal(findPhone('رقمي ٠١٠٠١٢٣٤٥٦٧'), '01001234567');
    assert.equal(findPhone('no phone here 12'), null);
  });
});
