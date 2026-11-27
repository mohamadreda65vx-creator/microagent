import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCall {
  path: string;
  body: any;
  headers: http.IncomingHttpHeaders;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** Raw JSON body. If omitted, a normal chat completion is built from `content`. */
  body?: unknown;
  content?: string;
  delayMs?: number;
  /** Provider-reported cost in USD. `null` = omit the field. */
  cost?: number | null;
}

/**
 * A local stand-in for OpenRouter, used ONLY by automated tests. The real OpenRouter is not reachable from the build
 * environment and no API key exists, so this fake speaks the same wire format (OpenAI-compatible /chat/completions
 * with `usage.cost`) and can simulate 429 / 5xx / timeouts / errors inside a 200 body.
 */
export class FakeOpenRouter {
  private server!: http.Server;
  url = '';
  calls: FakeCall[] = [];
  private queue: FakeReply[] = [];
  /** Decides the model's answer when no one-shot reply is queued. Receives the parsed request body. */
  /** Load tests: simulated model latency for every call that has no explicit one-shot delay. */
  defaultDelayMs = 0;
  responder: (body: any) => string = () => '{"reply":"ok","actions":[]}';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => void this.handle(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  reset(): void {
    this.calls = [];
    this.queue = [];
  }

  /** The next request gets this reply (FIFO). */
  enqueue(...replies: FakeReply[]): void {
    this.queue.push(...replies);
  }

  get chatCalls(): FakeCall[] {
    return this.calls.filter((c) => c.path.endsWith('/chat/completions'));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
    const body = raw ? JSON.parse(raw) : undefined;
    this.calls.push({ path: req.url ?? '', body, headers: req.headers });

    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'test/model-a', name: 'Model A', context_length: 32000 }, { id: 'test/model-b', name: 'Model B' }] }));
      return;
    }

    const reply = this.queue.shift();
    const wait = reply?.delayMs ?? this.defaultDelayMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const status = reply?.status ?? 200;
    for (const [k, v] of Object.entries(reply?.headers ?? {})) res.setHeader(k, v);
    res.setHeader('content-type', 'application/json');
    res.statusCode = status;

    if (reply?.body !== undefined) {
      res.end(JSON.stringify(reply.body));
      return;
    }
    const content = reply?.content ?? this.responder(body);
    const promptChars = JSON.stringify(body?.messages ?? '').length;
    const prompt = Math.ceil(promptChars / 4);
    const completion = Math.ceil(content.length / 4);
    const cost = reply?.cost === null ? undefined : (reply?.cost ?? Number(((prompt + completion) * 0.000001).toFixed(6)));
    res.end(
      JSON.stringify({
        id: `gen-${this.calls.length}`,
        model: body?.model ?? 'unknown',
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...(cost === undefined ? {} : { cost }) },
      }),
    );
  }
}
