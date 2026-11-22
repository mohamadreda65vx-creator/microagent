# PROJECT_STATUS — MicroAgent

**Part 1 (Foundation & UI): done.  Part 2 (AI Employees & Intelligence): implemented and tested against a local stand-in AI — NOT yet tested against the real OpenRouter.  Part 3: NOT started.**
Last verified: 2026-11-22.

## Verification summary

| Check | Result |
|---|---|
| API integration tests (`npm test`) | 115 / 115 pass (policy 19, AI layer 15, knowledge 14, agent runtime 31, platform AI 1, plus Part 1 suites incl. RLS guard) |
| TypeScript typecheck (api + web) | clean |
| Production build (`npm run build`) | OK |
| Browser E2E, Part 2 flows (Chromium, against stand-in AI) | 24 checks pass |
| Browser E2E, Part 1 (business + admin) | 27 checks pass (earlier run) |
| Real OpenRouter call | **NOT done** (no key, no network from the build sandbox) |

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

## Not completed / known gaps (Part 2)

1. **Real OpenRouter never called.** Needs your key; test one Playground message and one suite before going live. Model answer quality is unknown until then.
2. **Social networks are not synced.** Facebook/Instagram etc. are import-only (paste/JSON). No API connection.
3. **Channels are not connected** (Part 3). Channel selection is saved only; nothing receives real customer messages.
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
Part 3 — **not started**. Waiting for your go-ahead.
