# MicroAgent — Architecture (Part 1)

## 1. Principles

- **Modular monolith.** One deployable. Modules (`auth`, `tenants`, `team`, `ai-employees`, `overview`, `platform`) are separate folders with their own routes. No microservices until a real need appears.
- **Isolation lives in the database.** The application can have a bug; PostgreSQL still refuses to show one tenant another tenant's rows.
- **No fake data.** Sections that are not built yet show an explicit "Coming in a later phase" state. Every number on screen comes from the database.

## 2. Repository layout

```
apps/api          Fastify API (TypeScript)
  migrations/     0001 schema · 0002 RLS + grants · 0003 auth functions
  src/config      env validation
  src/db          pools, tenant transactions, migration runner
  src/plugins     auth (sessions, permissions), usage metering
  src/shared      errors, RBAC definitions, password/token crypto, mailer
  src/modules     auth · tenants · team · ai-employees · overview · platform
  scripts         create-platform-admin
  test            integration tests (35)
apps/web          React SPA
infra/db/setup.sh DB roles + databases bootstrap
docs/             this file, deploy guide
```

## 3. Multi-tenancy model

Shared database, shared schema, `tenant_id` on every tenant-owned table.

### Three database roles

| Role | Used by | Power |
|---|---|---|
| `microagent_owner` | migrations only | owns tables; never used by the running API |
| `microagent_app` | every tenant request | **RLS applies**; column-level grants; no access to `password_hash`, `token_hash`, `sessions` |
| `microagent_platform` | Platform Admin module only | explicit cross-tenant policies: read tenants/users/employees/usage; update tenant `status`/`plan`; append audit logs. Cannot read secrets or write business data |

None is superuser or `BYPASSRLS` (asserted by a test).

### How a request is isolated

1. The session cookie is resolved to `(user, tenant, role)` by `auth_resolve_session()`.
2. `app.tenantTx(req, fn)` opens a transaction and runs `set_config('app.tenant_id', <id>, true)` (transaction-local, so it can never leak to the next request on a pooled connection).
3. Every policy is `USING (tenant_id = app_current_tenant())`. **No setting = no rows** (fail closed). A malformed value raises an error rather than matching everything.
4. The tenant id comes only from the server-side session — never from the request body, URL or headers.

### Pre-authentication operations

Signup, login lookup, sessions, password reset and invitation acceptance happen before a tenant is known. They are narrow `SECURITY DEFINER` functions (`auth_*`, migration 0003) with a pinned `search_path`, executable only by `microagent_app`. The app role has no direct access to `sessions` or `password_reset_tokens`.

### Guard rails

`test/rls.test.ts` fails the build if a new table with a `tenant_id` column ships without RLS + a policy, or if the app/platform roles get privileges outside the whitelist or `SELECT` on a secret column.

**Rule for future migrations:** a new tenant table must `ENABLE ROW LEVEL SECURITY`, add a policy, grant only the needed columns, and be added to the guard test's expected list.

## 4. Authentication & sessions

- Passwords: scrypt (N=2^15, r=8, p=3), parameters stored in each hash. Minimum 10 characters.
- Session: 256-bit random token in an `httpOnly`, `SameSite=Lax`, `Secure` (production) cookie. Only its SHA-256 is stored. 14-day TTL (configurable). Logout, password reset, disabling a user and suspending a tenant all take effect immediately because sessions are checked in the database on every request.
- Login never reveals whether an email exists (same error, same CPU cost). Disabled/suspended status is only revealed after a correct password.
- Password reset: one-hour single-use token (hashed), response is identical for unknown emails, and a reset revokes every session of that user.
- CSRF: `SameSite=Lax` cookie plus an `Origin` check on every non-GET request against `APP_URL`.
- Rate limits (per IP): login 10/min, signup 5/10 min, forgot/reset password, invitation lookup.
- Headers: Helmet with a strict CSP (`script-src 'self'`).

## 5. RBAC

Roles: `platform_admin`, `owner`, `admin`, `manager`, `viewer`. Single source of truth in `apps/api/src/shared/permissions.ts`; the web app receives the permission list from `/auth/me` and only uses it to hide UI — the API enforces it.

| Permission | owner | admin | manager | viewer |
|---|---|---|---|---|
| overview:read, ai_employees:read, team:read, settings:read | ✅ | ✅ | ✅ | ✅ |
| ai_employees:write | ✅ | ✅ | ✅ | — |
| knowledge:read, rules:read, approvals:read | ✅ | ✅ | ✅ | ✅ |
| knowledge:write, rules:write, simulation:run, approvals:decide | ✅ | ✅ | ✅ | — |
| ai_permissions:manage (change what an employee may DO, activate, roll back), audit:read | ✅ | ✅ | — | — |
| team:manage, settings:manage | ✅ | ✅ | — | — |

Rules: exactly one owner per tenant (unique index); nobody can change their own role/status; the owner cannot be modified; admins can only manage managers/viewers; platform admins have no access to tenant business routes.

## 6. Database schema (Part 1)

`tenants` · `users` (platform admins have `tenant_id NULL`) · `sessions` · `password_reset_tokens` · `invitations` · `ai_employees` · `usage_daily` (per tenant/day/metric) · `audit_logs` (append-only for the app) · `email_outbox` (dev fallback when SMTP is not configured) · `schema_migrations`.

Decision: **one email = one account = one tenant** in Part 1.

## 7. API (all under `/api/v1`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup` `/auth/login` `/auth/logout` `/auth/forgot-password` `/auth/reset-password` `/auth/accept-invitation` · `GET /auth/me` `/auth/invitations/:token` · `PATCH /account` |
| Workspace | `GET/PATCH /tenant` · `GET /overview` |
| Team | `GET /team/members` · `PATCH /team/members/:id` · `GET/POST /team/invitations` · `DELETE /team/invitations/:id` |
| AI Employees | `GET/POST /ai-employees` · `GET/PATCH/DELETE /ai-employees/:id` |
| Platform Admin | `GET /platform/summary` `/platform/tenants` `/platform/tenants/:id` · `PATCH /platform/tenants/:id` |
| Ops | `GET /health` |

Errors: `{ "error": { "code", "message", "details?" } }`. Validation with Zod.

## 8. Usage metering

An `onResponse` hook increments `usage_daily(tenant, day, 'api_requests')`. Later phases add messages, AI tokens, etc. to the same table. Platform Admin sees the monthly total per company.

## 9. Frontend

React SPA, route groups `/app/*` (business) and `/admin` (platform), each behind `RequireAuth` (server session) and `RequirePermission`. Brand tokens (White, Burgundy, Dark Burgundy, Light Gray) are defined once in `apps/web/src/index.css`. The mascot and logo are original SVGs. Animations respect `prefers-reduced-motion`.

## 10. Decisions to keep for later parts (Part 1)

- Keep adding tenant tables with RLS in the same migration; extend the guard test.
- Background jobs (AI calls, channel webhooks) will need either a worker process using the same DB roles or a queue table; decide in Part 2 based on Hostinger plan.
- Channel webhooks are public, tenant-less entry points: resolve tenant from a signed channel id, then use `withTenant`.
- Real email (SMTP) must be configured before onboarding real customers.


---

# Part 2 — AI Employees & Intelligence

## 11. Principle: the backend decides, the model only proposes

The model never executes anything and is never trusted to follow instructions. For every customer message:

1. **Hand-off rules run first, in code** (angry customer, customer asks for a person). If one fires, the model is **not called**.
2. The model returns `{reply, actions[]}`. Every proposed action goes through the **Policy Engine** (`agent/policy.ts`, pure and deterministic).
3. The reply goes through **output guards** (`agent/guards.ts`). A blocked reply is replaced by a safe, localized one (English / MSA / Egyptian).
4. Every proposed action is stored in `agent_actions` with the decision and reasons; denials and approvals are audited.

If the AI provider is down, not configured or over budget, the employee does **not** improvise: safe reply + hand-off to a human.

## 12. Policy Engine

Order: validate shape (zod per action) → task gating → employee permission (`deny | allow | require_approval`, with `maxPercent` / `maxAmount`) → company rules → limits → required fields.
Outcome precedence: `denied > invalid > pending_approval > allowed`.
Actions: collect_lead, give_discount, create_order, create_booking, schedule_followup, check_inventory, issue_refund, handoff_to_human (always allowed, cannot be disabled).
Defaults are conservative: discounts and refunds **denied**, orders and bookings **need approval**. `check_inventory` is denied until an inventory source exists.
Approvals: `agent_actions.approval_status` can be decided **once** (trigger in the database); deciding needs `approvals:decide`.

## 13. Output guards (heuristics, with known limits)

- **Prices:** every price-looking number in a reply (EN/AR, Arabic digits, currency words/symbols) must be a confirmed price, a number the customer said, or a total derived from facts matched in this answer (quantity × price where the customer gave the quantity, or a sum of two matched prices).
- **Discounts:** a percentage near discount words must be within the employee's limit or appear in a confirmed offer.
- **Stock:** any availability / stock statement is blocked while no inventory source is connected.
- **Language:** a mismatch with the required language is reported as a warning.
- Limits: text heuristics can miss unusual phrasings (e.g. prices written in words) and can over-block rare legitimate totals. They sit **on top of** the Policy Engine, not instead of it.

## 14. Teach & Correct

An instruction is previewed, then saved as one or more **structured rules** (`teach_rules.effect`, zod-validated), classified as **Knowledge**, **Behavior** or **Workflow** update. Not one big prompt: the prompt is assembled per message (profile + rules by category + the few confirmed facts that match + permission table).
- **Enforced** effects: prohibit_action, require_approval, require_field (e.g. phone before order), handoff_trigger, require_inventory_check, dialect, language, knowledge_fact.
- **Advisory** effects (tone, free instruction) only steer wording. The UI labels them “Guidance only: not enforced”.
- Rules can only **restrict**. An instruction that grants power (“you can give 50% discounts”) is refused and must be done in the employee's Permissions by an owner/admin.
- Classification = deterministic patterns (EN + Arabic) → optional AI classification validated against the same schema → advisory fallback.
- Every rule is versioned (`teach_rule_versions`); disable / edit / roll back (a rollback is a new version). A `knowledge_fact` rule owns a confirmed knowledge item that is retired when the rule is disabled.
- Changing rules does not take a live employee offline (they only restrict), but it invalidates its “tested” state (flagged in the UI).

## 15. Business Discovery

Sources: website (SSRF-safe crawl of up to 5–10 same-site pages), social posts (**pasted / JSON**, default latest **30**, adjustable 1–200), PDF, Word, Excel/CSV, product lists, business info typed by the owner.
- Product lists / tables are read **deterministically** (no AI). Empty or unparseable prices stay empty.
- Text sources use the AI to extract facts, but each fact must carry an **exact quote** that exists in the source; a price is kept only if the number is in the quote. Otherwise the fact/price is dropped (counted in `stats`).
- Every fact stores source, source reference, date of the information, evidence, origin and status (`unconfirmed → confirmed | rejected | outdated`). Only **confirmed** facts reach an employee.
- Smart questions (`discovery/questions.ts`) are deterministic: missing price, price conflict, outdated (>90 days; offers >30), missing basics. `subject_key` is unique per company, so a question is never asked twice; solved ones close automatically; the UI shows at most 5 at a time.
- Fetcher: http/https only, DNS answer checked at connect time (private/loopback/link-local/metadata addresses refused), redirects re-checked, size and time capped.

## 16. AI layer (OpenRouter)

`LlmProvider` interface → `OpenRouterProvider` → `AiService` (the only door to the model). Key only in server env (`OPENROUTER_API_KEY`); never sent to the browser or logged.
Timeout, retry with exponential backoff + jitter (408/409/425/429/5xx/network/timeout/200-with-inner-error; honours Retry-After up to 8 s; never retries 401/402/400), model allow-list, per-company **monthly token budget** checked before each call (platform admin can override per company; 0 = AI off), a usage row for every call (tokens, provider-reported cost — `NULL` if the provider did not report one, never guessed — latency, attempts, error code). Context: system + newest turns within a token budget, messages clipped.

## 17. Versions, activation gate, simulation

- Every profile/permission change creates an `ai_employee_versions` snapshot; rollback applies an old snapshot as a **new** version (needs `ai_permissions:manage`).
- **Activation gate:** an employee can go live only with ≥1 task **and** a passing simulation suite for its **current fingerprint** (profile + permissions + active rules + visible confirmed knowledge). Any later change invalidates it; editing a live employee pauses it until retested.
- Suite scenarios are built from the company's real data (a real product and price, unknown product, discount, stock, refund, order without phone, human request, angry customer, language) with **deterministic checks**; the model is the thing under test, never the judge. At least 4 scenarios must run. The suite needs a configured AI provider; without it, it returns `ai_not_configured` and nothing is marked tested.
- Playground chat shows the trace: model answer vs. final answer, decisions, guard findings, facts used, tokens/cost.

## 18. Tenant isolation in Part 2

- All new tables have RLS (`tenant_id = app_current_tenant()`), enforced by the guard test.
- **Composite FKs `(tenant_id, id)`**: a rule, version, action, simulation or source link can never point at another company's employee/source even if application code is wrong (tested directly in SQL).
- Knowledge retrieval, rules and permissions are all loaded inside `withTenant`; tests assert that company B's prompt never contains company A's facts, rules, dialect or employee names.

## 19. New API (under `/api/v1`)

| Area | Endpoints |
|---|---|
| AI catalog | `GET /ai/catalog` `/ai/models` `/ai/usage` |
| Employees | `POST /ai-employees/:id/status` · `PUT /ai-employees/:id/sources` · `GET /ai-employees/:id/versions[/:v]` · `POST /ai-employees/:id/rollback` |
| Simulation | `POST /ai-employees/:id/simulate` `/simulate/suite` · `GET /ai-employees/:id/simulations[/:runId]` |
| Knowledge | `GET/POST /knowledge/sources` · `PATCH/DELETE /knowledge/sources/:id` · `POST …/:id/content` `/upload` `/analyze` · `GET/POST /knowledge/items` · `PATCH/DELETE /knowledge/items/:id` · `POST /knowledge/items/bulk-status` · `GET /knowledge/summary` `/knowledge/questions` · `POST /knowledge/questions/refresh` `/knowledge/questions/:id/answer` |
| Teach | `POST /teach/preview` `/teach/rules` · `GET /teach/rules` · `PATCH /teach/rules/:id` · `GET …/versions` · `POST …/rollback` |
| Governance | `GET /approvals` `/agent-actions` `/audit-logs` · `POST /approvals/:id/decision` |
| Platform | `PATCH /platform/tenants/:id/ai-limit` (tenant list now includes AI tokens/cost/limit) |

## 20. Decisions to keep for later parts

- Channels (Part 3) will call the same `runTurn(mode: 'live')`; live `agent_actions` already flow into the Approvals queue (the UI separates live from Playground tests). Executing an approved/allowed action against real systems (orders, bookings, CRM) is **not** implemented: Part 2 records and decides, it does not execute.
- Inventory: introduce an inventory connector and flip `inventoryConnected` in the policy context; until then stock claims are blocked by design.
- Long analyses currently run inside the request (≤12 AI calls). A job queue is the next step if sources get large.

## 21. Part 3 — Channels & conversations

**Layers.** `channels/*.ts` connectors (Telegram, Evolution WhatsApp, Meta, Website; WhatsApp Cloud stub, TikTok unavailable) only translate between a provider and the normalized types (`InboundMessage`, `WebhookEvent`, `ChannelError`). They never touch the DB or the AI. `ChannelManager` owns storage, idempotency, delivery, retry, health and the bridge to the Part 2 runtime. Registry key `type:provider` makes replacing a provider a one-connector change.

**Tables (migration 0007/0008).** `channels`, `contacts`, `conversations`, `messages`, `message_files`, `webhook_events`, `message_forwards`; `agent_actions.conversation_id`. RLS `tenant_id = app_current_tenant()` on all. **Platform separation is a database rule:** `conversations` has composite FKs `(tenant, channel, platform) → channels(tenant, id, type)` and `(tenant, channel, contact) → contacts`; `messages` has `(tenant, channel, conversation) → conversations`. A message cannot point to a conversation of another channel/platform. The platform-admin role has no grants on these tables.

**Webhooks.** Public endpoints resolve the tenant through SECURITY DEFINER functions (`channel_resolve`, `channel_resolve_external`) that return only what is needed. Verification: Telegram `secret_token` header, Evolution custom secret header + instance name, Meta `X-Hub-Signature-256` HMAC over the raw body. Every event is logged in `webhook_events` (pruned at 14 days).

**Idempotency.** Unique `(channel_id, direction, external_id)` + `INSERT … ON CONFLICT DO NOTHING`; a replayed webhook creates nothing and does not trigger the AI twice.

**Delivery.** Statuses received/queued/sending/retry/sent/delivered/read/failed; claim by UPDATE; backoff 30s/2m/10m/30m, max 5 attempts; recipient errors don't degrade channel health, auth errors set the channel to `error`. A worker `tick()` handles due retries, stuck queued messages, pending AI recovery and health checks (in-process, single instance; functions `worker_*` return IDs only).

**Credentials.** AES-256-GCM (`v1.iv.tag.ct`, key `CHANNEL_SECRET_KEY`); HKDF-derived purpose-bound keys for widget visitor tokens and Meta OAuth state; never returned by the API; scrubbed from errors; Meta tokens travel in the Authorization header.

**AI bridge.** Inbound message → `ai_state` pending/skipped → one `runTurn` per batch per conversation (serialized) → reply saved and delivered. Hand-off sets handler `human`, status `pending`. A staff reply takes over. `aiState` tells the UI why nobody is answering.

**Forwarding.** Always a new message ("↪ Forwarded from {Platform} · {name} · {time} UTC" + comment); preview endpoint; recorded in `message_forwards` and audit `message.forwarded`.

**Permissions.** `channels:read|manage`, `conversations:read|reply|manage|forward` (manager: read/reply/manage/forward; viewer: read).

**API (under `/api/v1`).** `/channels` (catalog, CRUD, connect, status/QR, reconnect, disconnect, health-check, contacts, Meta oauth), `/conversations` (summary, list — `platform` required —, detail, messages, read, reply, attachments, status/assign, takeover, release), `/messages/:id/{retry,forward,forward/preview,forwards,attachments/:i}`, public `/webhooks/channel/:key`, `/webhooks/meta`, `/widget.js`, `/widget/:key/*`.

**UI.** `/app/channels`, and one route per platform `/app/inbox/{whatsapp|messenger|instagram|telegram|website}` (three panes: filters+list, thread, customer details).


## 22. Part 4 — Customers & AI retargeting
- **Schema** (migration 0009): `contacts` extended (email, status, consent_*, notes, tags, interests, last_inbound_at, unreachable_*); `customer_events`, `campaign_templates`, `campaigns`, `campaign_recipients` (UNIQUE campaign+contact; composite FK keeps the contact on the campaign's channel), `campaign_events`; RLS by `tenant_id`; the platform-admin role has no grants on these tables. Unique partial index on `messages.meta->>'campaignRecipientId'` blocks double sends.
- **Eligibility** (`campaigns/audience.ts`, pure `evaluate()`): opted_out, unreachable, no_previous_conversation, outside_messaging_window (24h−10min), marketing_messages_not_supported, no_marketing_consent, template_required, platform_not_supported, channel_not_connected, no_longer_matches. Re-run at send time.
- **Approval**: sha256 over channel, message, footer, normalized filter and sorted eligible ids; approve needs `confirmRecipients` = eligible count (+ risk ack for WhatsApp QR); edits void it; launch recomputes (mismatch → 409 `audience_changed`).
- **Engine** (`campaigns/engine.ts`): tick claims recipients with FOR UPDATE SKIP LOCKED, per-platform limits, retry, stuck-recovery, auto-pause, completion; sends through `ChannelManager.sendCampaignMessage`.
- **AI builder** (`campaigns/builder.ts`): proposal only; validated like untrusted input.
- **API**: `/customers*`, `/campaigns*`, `/campaign-templates*`. Permissions `customers:read|manage`, `campaigns:read|manage|approve` (approve: owner/admin).

## 23. Part 5 — Workflows, performance, super admin
- **Workflow model** (`workflows`, immutable `workflow_versions`, `workflow_runs`, `workflow_steps`, `workflow_tasks`, `notifications`; all RLS). Graph JSON `{nodes:[{id,type,position,data}], edges:[{id,source,target,sourceHandle}]}`; handles: `out`, condition `true|false`, human task `approved|rejected|timeout`, loop `body|done`. Validation (`src/workflows/graph.ts`) is shared by save, activate and the builder.
- **Engine** (`src/workflows/engine.ts`): runs are rows; a worker (`worker_workflows_due`, `FOR UPDATE SKIP LOCKED`) picks queued/due runs every 10 s, so delays, human tasks and sub-workflows survive restarts. Step keys are unique per (run, node, visit) and sends are keyed in `messages.meta.workflowStepKey` (unique index) ⇒ at-most-once effects. Test runs are dry. Templates are `{{dot.path}}` lookups and conditions are evaluated by a small safe evaluator (no `eval`).
- **Triggers** come from the channel manager (message received, handoff) and the customers API (status change) through `app.workflows.fire`. Workflow actions never fire triggers.
- **Performance API** (`/performance`) computes every KPI from recorded events with the exact definition returned to the UI.
- **Platform dashboard**: the platform DB role reads only SECURITY DEFINER aggregate functions (`platform_channel_stats`, `platform_message_volume`, `platform_tenant_counts`, `platform_failure_counts`); no direct table access to company content. Subscription state lives on `tenants` (`plan`, `subscription_status`, `trial_ends_at`, `limits` overrides); defaults in `src/shared/plans.ts`; enforcement in `src/shared/limits.ts`.
- **Security hardening**: global per-session rate limit, `system_errors` log with RLS (migration 0012), route inventory (`app.routeTable`) used by `test/security.test.ts`.
- **Production**: one Node process serves API + web; PostgreSQL only (no Redis); see `DEPLOYMENT_GUIDE.md`.
