# PROJECT_STATUS — MicroAgent

**Part 1 (Foundation & UI): done.  Part 2 (AI Employees & Intelligence): implemented, tested against a local stand-in AI only.  Part 3 (Channels & Conversations): implemented and tested against LOCAL STAND-INS of Telegram / Evolution API / Meta Graph — no real provider has been reached.  Part 4: NOT started.**
Last verified: 2026-11-23.

## Verification summary

| Check | Result |
|---|---|
| API integration tests (`npm test`) | 168 / 168 pass (Part 3 channels & conversations: 53; policy 19, AI layer 15, knowledge 14, agent runtime 31, platform AI 1, plus Part 1 suites incl. RLS guard) |
| TypeScript typecheck (api + web) | clean |
| Production build (`npm run build`) | OK |
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

## Next
Part 4 — **not started**. Before it: test Telegram with a real bot on a public HTTPS server, and (if wanted) an Evolution API server, and the real OpenRouter key.
