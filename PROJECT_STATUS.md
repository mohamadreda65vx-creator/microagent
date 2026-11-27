# PROJECT_STATUS — MicroAgent

**Part 1 (Foundation & UI): done.  Part 2 (AI Employees & Intelligence): implemented, tested against a local stand-in AI only.  Part 3 (Channels & Conversations): implemented and tested against LOCAL STAND-INS of Telegram / Evolution API / Meta Graph — no real provider has been reached.  Part 4 (Customers & AI Retargeting): implemented and tested against the same stand-ins and synthetic customers only — no real customer was messaged. Part 5 (Workflows, Analytics, Security, Load testing, Deployment prep): implemented and tested locally; NOT deployed anywhere.**
Last verified: 2026-11-27.

## Verification summary

| Check | Result |
|---|---|
| API integration tests (`npm test`) | 312 / 312 pass (Part 5: workflows 29, performance 11, super admin 8, security 29; Part 4 customers & campaigns: 67; Part 3 channels & conversations: 53; policy 19, AI layer 15, knowledge 14, agent runtime 31, platform AI 1, plus Part 1 suites incl. RLS guard) |
| TypeScript typecheck (api + web) | clean |
| Production build (`npm run build`) | OK |
| Browser E2E, Part 5 (Chromium, stand-in providers, `apps/api/test/e2e-part5.ts` harness + a Playwright script that is not committed) | Workflow list → builder renders saved graph → Validate → dry Test run with step log → add node by click and by drag-and-drop → save (new version) → activation refused while invalid → versions list → fix → Activate → People-tasks page → Performance (filters, definitions, notes) → notifications bell → mobile 390 px (no horizontal scroll) → Super Admin dashboard → change a company's plan (list updates) → Companies page. Only expected console errors (401 before login, 422 on the refused activation). |
| Browser E2E, Part 2 flows (Chromium, against stand-in AI) | 24 checks pass |
| Browser E2E, Part 1 (business + admin) | 27 checks pass (earlier run) |
| Browser E2E, Part 3 (Chromium, stand-in providers) | Login → Telegram section (list, open thread, AI answered, staff reply takes over, forward preview + send to second bot) → Website Chat section shows only the website visitor → WhatsApp section empty → unknown platform redirects → Channels page → mobile 390px (no horizontal scroll) → embed script on an external page opens the widget, visitor message arrives and is answered. Harness: `apps/api/test/e2e-server.ts` (manual, not an automated test) |
| Real OpenRouter call | **NOT done** (no key, no network from the build sandbox) |
| Real Telegram / Evolution API / Meta call | **NOT done** (no tokens, no public HTTPS URL, no Evolution server) |

Browser scripts were run by hand and are **not** committed as automated tests.
All AI tests use a local stand-in server (`FakeOpenRouter`, tests only). It proves our code handles responses, errors, retries, budgets and cost correctly; it does not prove the quality of any real model.

## Part 2 — completed

- **AI Employees:** full profile (name, role, language/dialect, tone, greeting, business description, rules…), 8 multi-select tasks, status gate (draft → tested → live/paused), versions + rollback.
- **Business Discovery:** website crawl (SSRF-safe), pasted/JSON social posts (default 30, adjustable), PDF, Word, Excel/CSV, product lists, business info. Every fact has source, source reference, date, evidence and status; only confirmed facts reach the employee. Prices are never invented: deterministic table reading, and AI facts must carry an exact quote that contains the number.
- **Smart questions:** missing price / conflicts / outdated / missing basics; unique per subject (never repeated), at most 5 shown, auto-closed when solved.
- **Teach & Correct:** knowledge / behavior / workflow updates → structured, editable, versioned, revertible rules; enforced vs “guidance only” clearly labelled; instructions that grant power are refused.
- **Permissions Engine (backend):** per-action deny / allow / approval, limits, required fields, hand-off always allowed; approvals queue (decide once), audit log, agent-action log.
- **AI Engine:** OpenRouter provider (timeout, retry/backoff, allow-list), per-company monthly token budget with platform override, tokens + provider-reported cost per call (null when not reported), key only on the server.
- **Simulation Playground:** single-message test with full trace + real-data scenario suite; activation requires a passing suite for the current configuration.
- **Isolation:** RLS on all new tables + composite FKs; cross-company tests in API and SQL.
- **Platform admin:** AI tokens / limit per company.

## Part 3 — completed (against stand-ins only)

- **Channel Manager** with connectors kept separate from the AI engine (a connector never touches the DB or the AI). Registry keyed by `type:provider`, so replacing the unofficial WhatsApp connector with the official Cloud API means adding one connector (a stub exists, marked unavailable).
- **Telegram:** bot token (validated with getMe), webhook registered automatically with a secret header, receive text/photo/document, send (long text split), recipient-specific errors don't mark the channel broken.
- **WhatsApp (Evolution API, UNOFFICIAL / experimental):** one instance per company, QR, status, reconnect, receive, send, health check, no shared sessions. Needs your own Evolution server.
- **Messenger / Instagram:** OAuth, page selection, webhook signature check (`X-Hub-Signature-256`), send API, 24-hour window warning. **Status stays "awaiting approval / not verified" until a real customer message arrives.** Never tested against real Meta.
- **Website Chat:** embed script (`/api/v1/widget.js`, Shadow DOM, text only), signed visitor sessions, allowed-origins, rate limits, polling.
- **Platform-separate conversations** (no merged inbox): sections WhatsApp / Messenger / Instagram / Telegram / Website Chat, each with list, search, filters (all/unread/unassigned/mine/needs a person, status, channel), unread counts, customer details, timeline, reply box, attachments (Telegram/WhatsApp), assignment, status, human takeover / hand back to AI. Separation is enforced in the database (composite FKs `channel ↔ platform ↔ contact ↔ conversation ↔ message`), not only in the UI. The conversation list API requires `platform`.
- **Forwarding** to another connected channel as a NEW message that states its source (with optional comment), preview before sending, send result recorded (`message_forwards` + audit). Warns when the target is disconnected or outside Meta's 24-hour window.
- **Reliability:** idempotent inbound (unique `(channel, direction, external_id)` + `ON CONFLICT DO NOTHING`, replays create no duplicates), delivery statuses, retry with backoff (30s/2m/10m/30m, 5 attempts) by an in-process worker, stuck message recovery, health checks, webhook event log (pruned at 14 days).
- **Security:** credentials AES-256-GCM encrypted (`CHANNEL_SECRET_KEY`), never returned by the API, scrubbed from errors; per-tenant RLS; platform admin has no access to conversations; permissions `channels:*` and `conversations:*`.
- **AI bridge:** inbound messages go through the Part 2 runtime (policy, guards, approvals); hand-off sets the conversation to "needs a person"; staff reply takes over automatically.

## Part 4 — Customers & AI Retargeting (completed against stand-ins + synthetic data only)
- **Customers**: each channel contact is a customer (name, platform id, phone/email only if the platform supplied them or staff typed them, first/last interaction, last message, tags, interests, notes, status new/lead/customer/inactive, marketing consent + source, activity timeline). No identity merging across platforms. Page: Customers (filters, bulk tags, detail, consent with required note on re-opt-in).
- **Campaigns**: one channel per campaign. AI builder turns a sentence into a DRAFT (audience filter validated by whitelist, numbers not in the owner's text flagged, unknown tags dropped). Audience computed by SQL, eligibility by a pure rules function re-run at send time.
- **Compliance rules enforced**: opted-out and unreachable excluded; Messenger/Instagram only inside the 24h window (Meta Marketing Messages NOT implemented, so older contacts are excluded with a reason); WhatsApp inside window, or outside only for explicit opt-in on the unofficial QR connection with a risk acknowledgement (official Cloud API needs templates: excluded as `template_required`); Telegram needs a started chat; website chat not supported. Excluded counts + reasons shown.
- **Approval**: owner/admin only, bound to a hash of message+audience+eligible ids, typed recipient count; any edit voids it; launch recomputes and refuses if the audience changed.
- **Sending engine**: background worker, per-platform rate limits (campaign can only lower), daily cap for WhatsApp, retries, duplicate prevention (DB unique per campaign+customer and per campaign message), pause/resume/cancel, auto-pause when the channel disconnects, scheduling, opt-out footer, STOP/إيقاف handling.
- **Analytics**: audience, eligible, sent, delivered (only if the channel reports it — Telegram never does), failed, replies (7d), leads/conversions (14d, from staff-set statuses), opt-outs.
- **Tests**: 67 new API tests (rules, audience selection, excluding ineligible, duplicate prevention, stopping a campaign, recording results, cross-company isolation incl. DB-level and platform-admin denial). Browser E2E (Chromium): Customers list/detail, AI draft with stand-in AI → preview (9 in audience, 8 eligible, 1 opted-out excluded) → typed approval → launch → 8 sent to a stand-in Telegram bot, monitor, mobile 390px with no horizontal scroll. Harness: `apps/api/test/e2e-campaigns.ts` (manual).

## Not completed / known gaps (Part 4)
- No real provider was called; real Telegram/Meta/WhatsApp behaviour (limits, window rules, errors) is untested.
- Meta Marketing Messages and WhatsApp official templates/Cloud API sending are not implemented. WhatsApp QR is unofficial (ban risk).
- Delivery receipts: Telegram none. Leads/conversions depend on staff updating statuses (no orders/purchase integration; "previous purchases" = status customer).
- No customer export/erasure, no cross-platform identity linking, no "send test to myself", audience cap 10,000, the campaign worker runs inside one API process, scheduled audience is frozen at approval (eligibility re-checked when sending).
- The Arabic+English opt-out footer renders with mixed text direction on one line (cosmetic).

## Not completed / known gaps (Part 3)

1. **No real provider was ever called.** Telegram, Evolution API and Meta were tested only against local stand-ins that I wrote from the public API docs. Real behaviour (payload variants, rate limits, QR timing) may differ. Test each with a real account before relying on it.
2. **WhatsApp via QR is unofficial:** it can be banned or disconnected by WhatsApp. Messages the phone owner sends from the phone (fromMe), groups and broadcasts are ignored.
3. **Meta (Messenger/Instagram) is prepared, not live:** needs a Meta app, App Review, business verification, public HTTPS; the data-deletion and deauthorize callbacks are not implemented. Messenger/Instagram cannot send files yet.
4. **Not implemented:** WhatsApp Cloud API (stub), TikTok, Telegram groups, file upload by website visitors, inbound attachment download for Messenger/Instagram/Website (metadata only).
5. **Staff UI uses polling** (4–8 s), no websockets. Worker and per-conversation AI queue run in the API process: single instance only (no job queue yet).
6. **Telegram needs a public HTTPS `APP_URL`;** local development cannot register the webhook.
7. Conversation search is `ILIKE` (fine for small volumes, no full-text index yet).
8. Forwarding to an arbitrary recipient is privacy-sensitive: guarded by permission + audit + UI warning, attachments are not forwarded.
9. Browser E2E ran in Chromium only, by hand. Real Chromium blocks a public page from calling `localhost`, so the widget test used a localhost page with that check disabled.

## Not completed / known gaps (Part 2)

1. **Real OpenRouter never called.** Needs your key; test one Playground message and one suite before going live. Model answer quality is unknown until then.
2. **Social networks are not synced.** Facebook/Instagram etc. are import-only (paste/JSON). No API connection.
3. ~~Channels not connected~~ → see Part 3 (connected against stand-ins only).
4. **No inventory integration.** Any stock/availability claim is blocked by design until one exists.
5. **Actions are recorded and decided, not executed.** Orders, bookings, refunds, follow-ups do not reach any external system.
6. **Scanned PDFs / images are not supported** (no OCR). Text PDFs only.
7. **Guards are text heuristics.** They may miss unusual phrasing (e.g. prices written in words) and may rarely over-block. They sit on top of the Policy Engine.
8. **Analysis is synchronous** (≤12 AI calls per request); no job queue yet, large sources may be slow.
9. **Simulation suite** needs a configured AI provider and checks behaviour deterministically; it is not a quality score.
10. Rate limit store is in-memory per process (unchanged from Part 1).
11. UI is English only; no RTL. Only Chromium tested.
12. `npm audit`: 2 moderate (uuid via exceljs). exceljs uses uuid v4 without the `buf` argument, so the advisory is not reachable; the only fix is a breaking downgrade, so it is left and documented.

## Part 1 gaps still open
Not deployed to Hostinger (VPS required); SMTP untested against a real server; no email verification/2FA; one email = one tenant; plan/billing not enforced; no CI or automated backups; Safari/Firefox untested.

## Decisions to carry forward
See `docs/ARCHITECTURE.md` §10 and §11–20 (Part 2).

## Next (after Part 5)
 Before it: test Telegram with a real bot on a public HTTPS server, and (if wanted) an Evolution API server, and the real OpenRouter key.

# PART 5 — Workflows, Analytics, Security, Load testing, Deployment prep

## Final report

### Completed features (each exercised by automated tests and/or the browser run above)
- **Visual Workflow Builder** (React Flow canvas, dark toolbar, nodes library, drag & drop or click-to-add, connections with labelled branch outputs, per-node settings forms, validation panel with clickable issues, mobile quick-add). 9 nodes with real backend logic: Trigger (manual, message received [platform/keywords], conversation handed to a person, customer status changed), AI Agent (write text / choose one option; really calls the AI, metered), Action (send message, add/remove tag, set customer/conversation status, hand over to a person, add note), Condition (safe rule evaluator, no `eval`), Delay (≤30 days, survives restarts), Notification (in-app, to roles), Human Task (approve / reject / timeout, role-enforced), Loop (count or list, ≤100), Subprocess (another active workflow; depth ≤3, cycles refused).
- **Versioning**: immutable versions; save creates a version only if the graph changed; optimistic concurrency (409); restore = new version; live runs use the **activated** version only; activation requires zero validation errors and owner/admin.
- **Test run**: dry run (nothing is sent, waits skipped, human tasks auto-answered with a chosen outcome); full step-by-step execution log; live runs and logs are listed per workflow; runs can be cancelled.
- **Safety limits**: 200 steps/run, 60 live runs/workflow/minute (excess skipped and logged), idempotent steps (no double sends after crash/retry), workflow actions never trigger other workflows, send-message guards (channel connected, opt-out, unreachable, reply window, missing placeholders).
- **Performance dashboard**: conversations, leads, qualified leads, order requests, conversions, human handoffs, unanswered messages, AI usage, AI cost (provider-reported only), campaign results; filters date / AI employee / platform / campaign; every tile shows its exact definition; limits of each metric stated on screen (e.g. AI usage ignores platform/campaign filters).
- **Super Admin dashboard**: total/active tenants, AI employees, connected channels, message volume, AI consumption (+top companies), system errors, usage limits vs. plan per company, **subscription management** (plan, status, trial end, per-company limit overrides, audited). Counts and metadata only: the platform role cannot read messages, customers, credentials, campaigns or workflows (tested).
- **Plan limits enforced**: AI employees and channels (402 `plan_limit`), campaign messages per month (blocks preview), AI tokens.
- **Security review** with 29 adversarial tests; 5 findings fixed (see `docs/SECURITY_REVIEW.md`).
- **Load / recovery tests** with real measurements (`docs/LOAD_TEST_REPORT.md`); two bottlenecks fixed (unanswered-messages query, missing time-range index).
- **Deployment preparation**: production build verified and booted from a clean database; migrations; nginx, systemd, backup (tested restore), restore, health check scripts; `DEPLOYMENT_GUIDE.md`, `ENVIRONMENT_VARIABLES.md`, `.env.production.example`. **Hosting finding:** Hostinger web/cloud hosting cannot run this (no PostgreSQL); a **VPS is required**.
- Bug found by the deployment rehearsal and fixed: production server answered 403 on `/`.

### Incomplete features / not built
- No payment processor: subscriptions are set manually by a platform admin; **plan limit numbers are my placeholder defaults** (`apps/api/src/shared/plans.ts`), not a pricing decision.
- No generic HTTP/webhook node and no email/WhatsApp-notification node in workflows (in-app notifications only) — deliberate (not an n8n clone, no outbound calls to arbitrary URLs), but it limits integrations.
- No order/payment system: "orders" are **order requests** recorded by AI employees; "conversions" are customers whose status was changed to *customer*; "qualified leads" = leads with a phone or email (no scoring). Leads/conversions depend on staff or workflows setting statuses.
- Monthly message limit is enforced at campaign preview only, not on every conversational reply.
- Workflow engine, campaign worker and message retry queue run inside the single API process; no separate worker, no multi-instance operation (untested).
- Workflow builder: no undo/redo, no copy/paste, no auto-layout, no real-time collaboration (a conflict asks you to reload).
- UI is English only; Chromium only; the Playwright scripts are not committed as automated tests.

### Failed tests
- **None at the end of this run: 312 / 312 API tests pass; browser run clean.** Failures seen and fixed during Part 5 (kept for honesty): trial plan limits capped unrelated suites (test helper now upgrades test tenants; limit tests use trial explicitly); RLS guard flagged new tables and caught `system_errors` without RLS (fixed, migration 0012); production `/` returned 403 (fixed); a run of my rehearsal reset the shared DB role passwords on the dev machine (restored; the setup script is for dedicated servers only).

### Known limitations
- **No real provider was ever called** (OpenRouter, Telegram, Evolution/WhatsApp, Meta): everything ran against local stand-ins written from public documentation. Real behaviour may differ.
- Load numbers come from a 2-vCPU sandbox with fake providers and everything in one process; **no capacity is claimed** for any number of customers. Single-process design, ~200 inbound messages/s in that setup.
- `/performance` scans the selected period's messages (~350 ms at 200k messages in one tenant); will need pre-aggregation at millions.
- Security: no MFA, no external penetration test, in-memory rate limits (per process), shared unread counter resettable by viewers, uuid advisory (not reachable). Full list in `docs/SECURITY_REVIEW.md`.
- Backups protect only if copied off the server and the `.env` key is saved separately.

### Deployment requirements
Hostinger **VPS** (Ubuntu, root), Node ≥ 20, PostgreSQL ≥ 14 with `citext`, nginx + HTTPS (mandatory: Secure cookies), a domain with an A record, one API process. Steps: `DEPLOYMENT_GUIDE.md`. **Nothing has been deployed; deployment happens only after your approval.**

### Remaining credentials / integrations (none included in the project or the ZIP)
OpenRouter API key · SMTP account · VPS + domain/DNS access · Telegram bot tokens (per channel) · Evolution API server (WhatsApp QR, unofficial) · Meta app + App Review + business verification (Messenger/Instagram) · WhatsApp Cloud API and TikTok are not implemented.

### Production readiness — honest verdict
**Not production-ready yet.** It is ready for a **private pilot on a VPS with a few friendly customers** once you (1) deploy with HTTPS and SMTP, (2) test each real provider with real accounts (Telegram first), (3) run the load script on the real VPS, (4) confirm plan limits/pricing, (5) restore-test a backup, and (6) accept the known limitations above. Passing tests and screens do not prove security or capacity; the evidence we have is listed above and is limited to local stand-ins.
