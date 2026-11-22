import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AiError } from '../src/ai/types.js';
import { estimateTokens, extractJson, fitConversation } from '../src/ai/context.js';
import { createTestEnv, signupTenant, type Tenant, type TestEnv } from './helpers.js';

const msg = [{ role: 'user' as const, content: 'hello' }];

describe('AI provider layer (OpenRouter client, against a local fake)', () => {
  let env: TestEnv;
  let a: Tenant;
  let b: Tenant;
  before(async () => {
    env = await createTestEnv();
    a = await signupTenant(env, 'AI Co A');
    b = await signupTenant(env, 'AI Co B');
  });
  after(async () => env.close());

  const call = (t: Tenant, purpose: 'simulation' | 'extraction' = 'simulation', extra: Record<string, unknown> = {}) =>
    env.app.ai.complete({ tenantId: t.tenantId, purpose }, { model: 'test/model-a', messages: msg, ...extra });
  const usageRows = (t: Tenant) => env.owner.query('SELECT * FROM ai_usage WHERE tenant_id = $1 ORDER BY id', [t.tenantId]).then((r) => r.rows);

  it('sends the key only in the Authorization header, asks for usage + JSON, and records tokens and the provider-reported cost', async () => {
    env.fake.reset();
    env.fake.enqueue({ content: '{"x":1}', cost: 0.00042 });
    const r = await call(a, 'simulation', { json: true });
    assert.equal(r.text, '{"x":1}');
    assert.equal(r.costUsd, 0.00042);
    const sent = env.fake.chatCalls[0]!;
    assert.equal(sent.headers.authorization, 'Bearer test-key-SECRET');
    assert.deepEqual(sent.body.response_format, { type: 'json_object' });
    assert.deepEqual(sent.body.usage, { include: true });
    assert.ok(!JSON.stringify(sent.body).includes('test-key-SECRET'), 'key must not appear in the request body');
    const rows = await usageRows(a);
    const last = rows[rows.length - 1];
    assert.equal(last.status, 'ok');
    assert.equal(last.cost_source, 'provider');
    assert.equal(Number(last.cost_usd), 0.00042);
    assert.ok(last.total_tokens > 0 && last.prompt_tokens > 0);
  });

  it('does not invent a cost when the provider does not report one', async () => {
    env.fake.reset();
    env.fake.enqueue({ content: 'hi', cost: null });
    await call(a);
    const rows = await usageRows(a);
    const last = rows[rows.length - 1];
    assert.equal(last.cost_usd, null);
    assert.equal(last.cost_source, 'unknown');
  });

  it('retries 503 and 429 (honouring Retry-After) and then succeeds; attempts are recorded', async () => {
    env.fake.reset();
    env.fake.enqueue({ status: 503, body: { error: { message: 'busy' } } }, { status: 429, headers: { 'retry-after': '0' }, body: {} }, { content: 'finally' });
    const r = await call(a);
    assert.equal(r.text, 'finally');
    assert.equal(r.attempts, 3);
    assert.equal(env.fake.chatCalls.length, 3);
    const rows = await usageRows(a);
    assert.equal(rows[rows.length - 1].attempts, 3);
  });

  it('retries an error that arrives inside an HTTP 200 body', async () => {
    env.fake.reset();
    env.fake.enqueue({ body: { error: { code: 429, message: 'rate limited upstream' } } }, { content: 'ok after inner error' });
    assert.equal((await call(a)).text, 'ok after inner error');
    assert.equal(env.fake.chatCalls.length, 2);
  });

  it('does NOT retry auth, credit or bad-request errors', async () => {
    for (const [status, code] of [[401, 'ai_auth'], [402, 'ai_insufficient_credits'], [400, 'ai_bad_request']] as const) {
      env.fake.reset();
      env.fake.enqueue({ status, body: { error: { message: 'nope' } } });
      await assert.rejects(call(a), (e: AiError) => e.aiCode === code && e.attempts === 1);
      assert.equal(env.fake.chatCalls.length, 1, `${status} must not be retried`);
    }
  });

  it('gives up after the configured retries with a clean error, and logs a failed usage row', async () => {
    env.fake.reset();
    env.fake.enqueue(...Array.from({ length: 4 }, () => ({ status: 503, body: {} })));
    await assert.rejects(call(a), (e: AiError) => e.aiCode === 'ai_unavailable' && e.attempts === 4);
    assert.equal(env.fake.chatCalls.length, 4);
    const rows = await usageRows(a);
    const last = rows[rows.length - 1];
    assert.equal(last.status, 'error');
    assert.equal(last.error_code, 'ai_unavailable');
  });

  it('times out slow answers and retries', async () => {
    env.fake.reset();
    env.fake.enqueue({ delayMs: 2200, content: 'too slow' }, { content: 'fast enough' });
    const r = await call(a);
    assert.equal(r.text, 'fast enough');
    assert.equal(r.attempts, 2);
  });

  it('error messages and responses never contain the API key or provider internals', async () => {
    env.fake.reset();
    env.fake.enqueue({ status: 401, body: { error: { message: 'bad key test-key-SECRET sk-or-123' } } });
    try {
      await call(a);
      assert.fail('should throw');
    } catch (e) {
      const err = e as AiError;
      assert.ok(!err.message.includes('SECRET') && !err.message.includes('sk-or'));
      assert.ok(!JSON.stringify({ code: err.code, message: err.message }).includes('SECRET'));
    }
  });

  it('enforces the per-company monthly token budget BEFORE calling the provider', async () => {
    env.fake.reset();
    await env.owner.query('UPDATE tenants SET ai_monthly_token_limit = 1 WHERE id = $1', [b.tenantId]);
    env.fake.enqueue({ content: 'first' });
    await call(b); // used = 0 < 1 → allowed, spends tokens
    await assert.rejects(call(b), (e: AiError) => e.aiCode === 'ai_budget_exceeded');
    assert.equal(env.fake.chatCalls.length, 1, 'the second call must not reach the provider');
    await env.owner.query('UPDATE tenants SET ai_monthly_token_limit = NULL WHERE id = $1', [b.tenantId]);
    env.fake.enqueue({ content: 'again' });
    assert.equal((await call(b)).text, 'again', 'back to the platform default → works again');
  });

  it('usage is isolated per company', async () => {
    const sa = await env.app.ai.usageSummary(a.tenantId);
    const sb = await env.app.ai.usageSummary(b.tenantId);
    const rowsA = await usageRows(a);
    const rowsB = await usageRows(b);
    assert.equal(sa.month.calls, rowsA.length);
    assert.equal(sb.month.calls, rowsB.length);
    assert.notEqual(rowsA.length, rowsB.length);
  });

  it('lists models from the provider', async () => {
    const m = await env.app.ai.listModels();
    assert.equal(m.source, 'provider');
    assert.deepEqual(m.models.map((x) => x.id), ['test/model-a', 'test/model-b']);
  });
});

describe('AI not configured', () => {
  it('reports ai_not_configured instead of crashing', async () => {
    const env = await createTestEnv({ noAi: true });
    try {
      const t = await signupTenant(env, 'No AI Co');
      assert.equal(env.app.ai.configured, false);
      await assert.rejects(env.app.ai.complete({ tenantId: t.tenantId, purpose: 'simulation' }, { model: 'x/y', messages: msg }), (e: AiError) => e.aiCode === 'ai_not_configured');
      assert.equal((await env.app.ai.listModels()).source, 'default');
    } finally {
      await env.close();
    }
  });
});

describe('context management', () => {
  it('keeps the system prompt and the newest turns, drops the oldest first', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `turn-${i} ` + 'x'.repeat(400) }));
    const fit = fitConversation('SYSTEM', history, 2000);
    assert.equal(fit.messages[0]!.content, 'SYSTEM');
    assert.ok(fit.droppedTurns > 0);
    assert.ok(fit.messages.at(-1)!.content.startsWith('turn-39'), 'newest message kept');
    assert.ok(!fit.messages.some((m) => m.content.startsWith('turn-0 ')), 'oldest dropped');
    assert.ok(fit.estimatedTokens <= 2000 + 200);
  });

  it('always keeps the last message even if it alone is over budget, and clips huge messages', () => {
    const fit = fitConversation('S', [{ role: 'user', content: 'y'.repeat(50_000) }], 100);
    assert.equal(fit.messages.length, 2);
    assert.ok(fit.messages[1]!.content.length <= 4000);
  });

  it('estimates tokens conservatively and extracts JSON from fenced/chatty answers', () => {
    assert.equal(estimateTokens('abcdef'), 2);
    assert.deepEqual(extractJson('Sure!\n```json\n{"a": 1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('here you go {"b": [1,2]} thanks'), { b: [1, 2] });
    assert.throws(() => extractJson('no json here'));
  });
});
