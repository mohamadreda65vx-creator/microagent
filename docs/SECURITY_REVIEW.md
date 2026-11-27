# Security review (Part 5)

Scope: all parts (1–5). Method: read the code for each area, then wrote **adversarial automated tests** (`apps/api/test/security.test.ts`, 28 tests) that probe every registered route instead of trusting that the screens work. Earlier parts' suites (RLS, tenant isolation, channels/webhooks, AI policy, campaigns) also count. This is an internal review, **not** an independent penetration test.

| Area | What was checked (and how) | Result |
|---|---|---|
| Authentication | Every non-public route (route inventory from the live app, 100+) answers 401 with no/forged/empty cookie; Bearer header does not authenticate; logout invalidates the token; session token stored only as a hash; cookie `HttpOnly`, `SameSite=Lax`, `Secure` in production (verified on the production build); password hashes never in responses | Pass |
| RBAC | A **viewer** was sent a request to every mutating route: all 403 except 4 documented harmless ones (own profile, shared unread counter reset, two read-only "preview/validate" POSTs). Tenant owner → every `/platform/*` route: 403. Platform admin → tenant business routes: no data. Role escalation and mass-assignment (role/tenantId in signup) ignored | Pass (see L1) |
| Tenant isolation | PostgreSQL Row Level Security + composite FKs (Parts 1–4 suites); cross-tenant by-id access (employees, workflows, runs, versions, activate, test, delete) → 403/404; workflows cannot reference another tenant's AI employee/workflow; app DB role sees 0 rows with no tenant set. **Found & fixed:** `GET /workflows/:id/runs` returned 200 `[]` for another tenant's id (no data, but inconsistent) → now 404 | Pass after fix |
| API security | Global rate limit; strict validation (zod `.strict()`); CSRF origin check (cross-origin state-changing browser requests 403); CSP/helmet headers; 5xx responses hide internals; static serving not traversable | Pass after fixes (F1, F2) |
| Webhook verification | Telegram secret-token header (missing/empty/wrong → rejected, nothing stored); Meta `X-Hub-Signature-256` (missing/malformed/wrong rejected) and verify-token handshake; unknown channel key rejected; widget endpoints reject forged tokens | Pass (providers are fakes; **not verified against real Telegram/Meta**) |
| Secret encryption | Channel credentials AES-256-GCM (random IV, auth tag): not present in plaintext in the DB row, not returned by any API/audit/dashboard; tampered blob and wrong key refused | Pass. Risk: key lives in `.env`; losing it loses credentials (documented) |
| Rate limiting | Login brute force → 429 (real limiter); every public route declares a limit; **authenticated API had no ceiling** | Fixed (F1): 600 req/min per session (per IP when anonymous) |
| File access | Knowledge/chat uploads size-limited (8 MB / 5 MB → 4xx above); files stored in the DB and served only through tenant-scoped routes/signed widget tokens (no filesystem paths ⇒ no traversal); widget file route rejects other visitors | Pass |
| Campaign permissions | Create/approve/launch require `campaigns:*` permissions; approval is bound to a hash of the audience+message (changed content ⇒ not approved); consent/opt-out/window rules enforced in the engine; plan limit blocks over-quota sends (Part 4 suite + Part 5 limits) | Pass |
| AI action permissions | AI actions pass a policy engine (per-employee permissions, approval queue, live vs simulation); workflows' AI step only returns text/choice (no actions); workflow `send_message` re-checks channel state, opt-out, reply window; workflow actions never trigger other workflows | Pass |
| Dependencies | `npm audit --omit=dev`: 2 moderate (`uuid` <11.1.1 via `exceljs`, bounds check when a caller passes its own buffer to v3/v5/v6). Our code never calls uuid that way; accepted, upgrade when exceljs releases a fix | Accepted (L3) |
| Secrets in repo | Pattern scan of tracked files (API keys, private keys): none; `.env` is git-ignored; ZIP excludes it | Pass |

## Findings fixed in this review
- **F1** No rate limit on the signed-in API → global per-session limit added.
- **F2** `GET /api/v1/webhooks/meta` handshake and `GET /widget.js` had no limit → added.
- **F3** `GET /workflows/:id/runs` did not 404 for unknown/other-tenant workflow → fixed.
- **F5** (found by the RLS guard test when the new tables were added) `system_errors` had a `tenant_id` column but no Row Level Security: a tenant-role connection could have written error rows attributed to another company. Migration `0012` enables RLS (tenant role: insert only for its own tenant, no read); the error handler now writes via the platform role; tests added.
- **F4** (found by the deployment rehearsal, not security) the production server answered **403 on `/`** (static plugin on a directory) → app shell now served explicitly; missing `/assets/*` → 404. Regression test added.

## Known limitations / residual risks (not fixed)
- **L1** Any viewer can reset a conversation's shared unread counter (`POST /conversations/:id/read`). Low impact; per-user read state would fix it.
- **L2** Rate limiting is in-memory per process: correct for the single-process design, but limits would be per-instance if you ever run several.
- **L3** `exceljs → uuid` advisory (see above).
- **L4** No 2FA/MFA, no account lockout beyond the login rate limit, no password-breach check, no email verification enforcement for new owners.
- **L5** Platform-admin sign-in is a normal password login (no IP allow-list/MFA); protect that account carefully.
- **L6** Real provider integrations (Telegram, WhatsApp/Evolution, Meta, OpenRouter) have only been exercised against local fakes; their signature/token behaviour against the real services is unverified.
- **L7** No external penetration test, no automated DAST/fuzzing, no log-shipping/SIEM.
- **L8** Backups are only as safe as where you copy them; dumps contain customer data (encrypted credentials but plaintext messages).
