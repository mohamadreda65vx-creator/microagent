import type { Config } from '../config/env.js';
import { withTenant } from '../db/tx.js';
import type { Pools } from '../db/pool.js';
import { OpenRouterProvider } from './openrouter.js';
import { AiError, type LlmProvider, type LlmRequest, type LlmResult, type ModelInfo } from './types.js';

export type AiPurpose = 'agent_reply' | 'simulation' | 'extraction' | 'classification' | 'campaign_builder';

export interface AiCallContext {
  tenantId: string;
  employeeId?: string | null;
  purpose: AiPurpose;
}

interface Log {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
}

const MODELS_TTL_MS = 60 * 60 * 1000;

/**
 * The single door to the AI provider for the whole platform.
 * Responsibilities: model allow-list, per-company monthly budget, provider call (with retries),
 * and a usage row (tokens, provider-reported cost, latency, attempts, error code) for EVERY call, success or failure.
 * Callers never talk to the provider directly, so nothing can bypass metering or the budget.
 */
export class AiService {
  private provider: LlmProvider | null;
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;

  constructor(
    private readonly config: Config,
    private readonly pools: Pools,
    private readonly log: Log,
    provider?: LlmProvider | null,
  ) {
    this.provider =
      provider !== undefined
        ? provider
        : config.ai.apiKey
          ? new OpenRouterProvider(config.ai, { appUrl: config.appUrl, log })
          : null;
  }

  get configured(): boolean {
    return this.provider !== null;
  }

  get defaultModel(): string {
    return this.config.ai.defaultModel;
  }

  assertModelAllowed(model: string): void {
    const allowed = this.config.ai.models;
    if (allowed.length > 0 && !allowed.includes(model)) throw new AiError('ai_model_not_allowed');
  }

  /** Models a company can pick: the admin allow-list if one is set, otherwise what the provider lists. */
  async listModels(): Promise<{ models: ModelInfo[]; source: 'configured' | 'provider' | 'default' }> {
    const allowed = this.config.ai.models;
    if (this.provider) {
      if (!this.modelsCache || Date.now() - this.modelsCache.at > MODELS_TTL_MS) {
        try {
          this.modelsCache = { at: Date.now(), models: await this.provider.listModels() };
        } catch (err) {
          this.log.warn({ err: (err as Error).message }, 'could not list provider models');
        }
      }
    }
    const listed = this.modelsCache?.models ?? [];
    if (allowed.length > 0) {
      const byId = new Map(listed.map((m) => [m.id, m]));
      return { models: allowed.map((id) => byId.get(id) ?? { id, name: id }), source: 'configured' };
    }
    if (listed.length > 0) return { models: listed, source: 'provider' };
    return { models: [{ id: this.defaultModel, name: this.defaultModel }], source: 'default' };
  }

  async usageSummary(tenantId: string) {
    return withTenant(this.pools.app, tenantId, async (c) => {
      const limit = await this.limitFor(c, tenantId);
      const month = `date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`;
      const total = await c.query(
        `SELECT COALESCE(sum(total_tokens), 0)::bigint AS tokens, COALESCE(sum(cost_usd), 0)::float8 AS cost,
                count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors,
                count(*) FILTER (WHERE cost_usd IS NULL AND status = 'ok')::int AS "callsWithoutCost"
         FROM ai_usage WHERE created_at >= ${month}`,
      );
      const byPurpose = await c.query(
        `SELECT purpose, sum(total_tokens)::bigint AS tokens, COALESCE(sum(cost_usd), 0)::float8 AS cost, count(*)::int AS calls
         FROM ai_usage WHERE created_at >= ${month} GROUP BY purpose ORDER BY tokens DESC`,
      );
      const byModel = await c.query(
        `SELECT model, sum(total_tokens)::bigint AS tokens, COALESCE(sum(cost_usd), 0)::float8 AS cost, count(*)::int AS calls
         FROM ai_usage WHERE created_at >= ${month} GROUP BY model ORDER BY tokens DESC`,
      );
      return { month: total.rows[0], limit, byPurpose: byPurpose.rows, byModel: byModel.rows, configured: this.configured };
    });
  }

  private async limitFor(c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, tenantId: string): Promise<number> {
    const { rows } = await c.query('SELECT ai_monthly_token_limit AS l FROM tenants WHERE id = $1', [tenantId]);
    const override = rows[0]?.l;
    return typeof override === 'number' ? override : this.config.ai.monthlyTokenLimit;
  }

  async complete(ctx: AiCallContext, req: LlmRequest): Promise<LlmResult> {
    if (!this.provider) throw new AiError('ai_not_configured');
    this.assertModelAllowed(req.model);

    // Budget: checked BEFORE spending. (Soft limit: a burst of parallel calls can overshoot slightly.)
    const { used, limit } = await withTenant(this.pools.app, ctx.tenantId, async (c) => ({
      limit: await this.limitFor(c, ctx.tenantId),
      used: (
        await c.query(
          `SELECT COALESCE(sum(total_tokens), 0)::bigint AS n FROM ai_usage
           WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`,
        )
      ).rows[0]!.n as number,
    }));
    if (used >= limit) throw new AiError('ai_budget_exceeded');

    try {
      const result = await this.provider.chat(req);
      await this.record(ctx, req.model, { ok: true, result });
      return result;
    } catch (err) {
      const e = err instanceof AiError ? err : new AiError('ai_unavailable', 1, err instanceof Error ? err.message : 'unknown');
      this.log.warn({ code: e.aiCode, attempts: e.attempts, detail: e.detail }, 'ai call failed');
      await this.record(ctx, req.model, { ok: false, error: e });
      throw e;
    }
  }

  private async record(ctx: AiCallContext, model: string, r: { ok: true; result: LlmResult } | { ok: false; error: AiError }): Promise<void> {
    try {
      await withTenant(this.pools.app, ctx.tenantId, (c) =>
        c.query(
          `INSERT INTO ai_usage (tenant_id, employee_id, purpose, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, cost_source, latency_ms, attempts, status, error_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          r.ok
            ? [ctx.tenantId, ctx.employeeId ?? null, ctx.purpose, r.result.model, r.result.promptTokens, r.result.completionTokens, r.result.totalTokens, r.result.costUsd, r.result.costUsd === null ? 'unknown' : 'provider', r.result.latencyMs, r.result.attempts, 'ok', null]
            : [ctx.tenantId, ctx.employeeId ?? null, ctx.purpose, model, 0, 0, 0, null, 'unknown', 0, r.error.attempts, 'error', r.error.aiCode],
        ),
      );
    } catch (err) {
      // Metering must never break a customer-facing answer, but a failure here must be visible in the logs.
      this.log.warn({ err: (err as Error).message }, 'failed to record ai usage');
    }
  }
}
