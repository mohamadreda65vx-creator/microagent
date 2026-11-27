# Load & failure-recovery test report (Part 5)

Script: `apps/api/test/load.ts` — run with `cd apps/api && node --import tsx test/load.ts [conversations|campaign|recovery|db]`.

## Read this first — what these numbers are and are not
- Measured on a **2-vCPU / 8 GB** sandbox. The API, PostgreSQL 16, the load generator **and the fake providers** all ran on the same machine and the API ran in **one Node process**.
- OpenRouter, Telegram, WhatsApp and Meta were **local fakes** with configured latency (AI 300 ms, Telegram 20–30 ms). The numbers therefore describe **MicroAgent itself** (HTTP handling, database, queues, workers). They say nothing about how fast the real providers answer, or about their own rate limits.
- **No claim is made about how many customers the platform can serve.** The tests show one process on a small machine; capacity on your Hostinger plan must be measured there (the same script can be run against it).

## Results (measured)
### 1. Concurrent inbound conversations (each: webhook → save → AI reply → send, plus one live workflow)
| Simultaneous customers | Webhook errors | Webhook p50 / p95 | All AI replies sent after | Replies delivered to provider |
|---|---|---|---|---|
| 20 | 0 | ~200 / 250 ms | 0.7 s | 20 / 20 |
| 100 | 0 | ~440 / 540 ms | 1.3 s | 100 / 100 |
| 300 | 0 | ~1200 / 1500 ms | 3.1 s | 300 / 300 |
- No message was lost; no conversation was left without a reply.
- Throughput in this setup ≈ **200 inbound messages/second**; latency grows linearly with the number of simultaneous requests (CPU-bound in a single process). Raising the DB pool from 10 to 30 did **not** help (`DB_POOL_MAX` is now configurable) — the limit is the single Node process, not the pool.
- A burst of 15 messages from the same customer produced 15 saved messages and only 2 AI replies (the AI answers the batch, not each message).
- Workflow runs: only ~61–65 of the 420 matching messages started a run. This is the **designed** cap of 60 live runs per workflow per minute (excess events are skipped and logged in `system_errors`, `rate_limited`). It protects customers from a runaway workflow; raise it only deliberately.

### 2. Campaign sending queue
- Production pacing is deliberate: Telegram 300/min, Messenger 120/min, Instagram 60/min, WhatsApp 10/min and 300/day (see `PLATFORM_LIMITS`). These are the real ceilings for campaigns and are **not** a performance problem.
- To measure the engine itself the pacing was lifted for the test only:
| Recipients | Provider failure rate | Result | Rate |
|---|---|---|---|
| 500 | 0 % | 500 sent, 0 duplicates | ~27/s |
| 2000 | 0 % | 2000 sent, 0 duplicates | ~27/s |
| 1000 | 15 % random HTTP 500 | all 1000 sent after retries (1152 provider calls) | ~24/s |
- Retry delays in production are 30 s / 2 min / 10 min / 30 min (shortened to 1 s in this test); after 300 s with production delays 140 of 1000 were still correctly waiting for their retry.

### 3. Failure recovery
- Campaign of 600 recipients, app stopped abruptly after 150 were sent (no graceful drain), a **new app instance** started on the same database: it finished the remaining 450 in 25 s; **0 recipients were sent twice**.
- Earlier automated tests (workflows suite) also cover: a workflow run stuck in `running` for >5 min is recovered, delayed runs resume, idempotent step keys prevent double messages.
- Limit of this test: a send that was in flight at the exact moment of the crash cannot be known to have reached the provider. The design prefers "at most once" (a unique index allows one message per campaign recipient), so such a customer may be marked failed rather than receive a duplicate.

### 4. Database queries (one tenant with 200,000 messages / 20,000 contacts / 20,000 conversations; median of 5)
| Endpoint | Before tuning | After |
|---|---|---|
| GET /conversations | 30 ms | 21 ms |
| GET /customers | 80 ms | ~90 ms |
| GET /customers (filter + search) | 55 ms | ~49 ms |
| GET /overview | 3 ms | 3 ms |
| **GET /performance (30 days)** | **526 ms** | **~350 ms** |
| POST /campaigns/audience/preview | 57 ms | 35 ms |
| GET /platform/dashboard | 127 ms | 58 ms |
Bottlenecks found and fixed: (a) "unanswered messages" scanned all message history → rewritten per-conversation (LATERAL, uses the existing index); (b) no index for tenant + time-range filters on `messages` → `0011_perf_indexes.sql`.

## Bottlenecks / risks still open
1. **Single process**: API, webhooks, AI calls, campaign worker and workflow worker share one Node process. Fine for a small deployment; for growth run the workers separately (not implemented) and add a second API instance (the workers use `FOR UPDATE SKIP LOCKED`, so a second instance is designed to be safe but **was not load-tested**).
2. **No shared queue / Redis**: queues live in PostgreSQL. This avoids extra services (important on a small VPS) but puts the load on the database.
3. `/performance` still scans the period's messages; at millions of messages per tenant it will need pre-aggregated daily counters.
4. Real provider latency, rate limits and failures were **not** measured.
5. Not tested: long soak (hours), memory growth, many tenants at once, multi-instance operation.
