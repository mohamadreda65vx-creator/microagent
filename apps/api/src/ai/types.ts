import { AppError } from '../shared/errors.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object response. */
  json?: boolean;
}

export interface LlmResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD as reported by the provider; null when the provider did not report one. We never guess a cost. */
  costUsd: number | null;
  latencyMs: number;
  attempts: number;
  requestId?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
}

/** The only thing the rest of the platform knows about "an AI provider". OpenRouter is one implementation. */
export interface LlmProvider {
  chat(req: LlmRequest): Promise<LlmResult>;
  listModels(): Promise<ModelInfo[]>;
}

export type AiErrorCode =
  | 'ai_not_configured'
  | 'ai_auth'
  | 'ai_insufficient_credits'
  | 'ai_rate_limited'
  | 'ai_timeout'
  | 'ai_unavailable'
  | 'ai_bad_request'
  | 'ai_bad_response'
  | 'ai_budget_exceeded'
  | 'ai_model_not_allowed';

const STATUS: Record<AiErrorCode, number> = {
  ai_not_configured: 503,
  ai_auth: 502,
  ai_insufficient_credits: 502,
  ai_rate_limited: 503,
  ai_timeout: 504,
  ai_unavailable: 502,
  ai_bad_request: 502,
  ai_bad_response: 502,
  ai_budget_exceeded: 429,
  ai_model_not_allowed: 400,
};

/** Safe-to-show messages. Provider bodies and keys are never put into these. */
const MESSAGE: Record<AiErrorCode, string> = {
  ai_not_configured: 'AI is not configured on this server yet.',
  ai_auth: 'The AI provider rejected the server’s credentials. Contact the platform administrator.',
  ai_insufficient_credits: 'The AI provider account is out of credits. Contact the platform administrator.',
  ai_rate_limited: 'The AI provider is busy right now. Please try again in a moment.',
  ai_timeout: 'The AI provider took too long to answer. Please try again.',
  ai_unavailable: 'The AI provider is temporarily unavailable. Please try again.',
  ai_bad_request: 'The AI provider could not process this request.',
  ai_bad_response: 'The AI provider returned an unreadable answer. Please try again.',
  ai_budget_exceeded: 'This workspace reached its monthly AI usage limit.',
  ai_model_not_allowed: 'This model is not available on this platform.',
};

export class AiError extends AppError {
  constructor(
    public readonly aiCode: AiErrorCode,
    public readonly attempts = 1,
    public readonly detail?: string,
    /** True for failures that may succeed if the same call is repeated (timeouts, 429, 5xx). */
    public readonly retryable = false,
  ) {
    super(STATUS[aiCode], aiCode, MESSAGE[aiCode]);
    this.name = 'AiError';
  }
}
