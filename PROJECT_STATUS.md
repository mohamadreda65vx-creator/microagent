# PROJECT_STATUS — MicroAgent

**Part 1 (Foundation & UI): implemented and tested.  Part 2: NOT started.**
Last verified: 2026-11-21.

## Verification summary

| Check | Result |
|---|---|
| API integration tests (`npm test`) | 35 / 35 pass |
| TypeScript typecheck (api + web) | clean |
| Production build (`npm run build`) | OK |
| Browser E2E, business flow (Chromium) | 19 / 19 pass |
| Browser E2E, platform admin flow (Chromium) | 8 / 8 pass |

The two browser scripts were run by hand and are **not** committed as automated tests.

## Completed

**Brand & landing**
- Original logo mark + wordmark and animated mascot (SVG; eyes follow the pointer, blink, float). Palette: white, burgundy, dark burgundy, light gray.
- Landing page: hero, animated agent with orbiting chips, scroll-reveal sections, features, how-it-works, security block, Create Your AI Agent + Login. Respects reduced-motion. No horizontal overflow at 390px.

**Dashboard**
- Sidebar (desktop) / drawer (mobile), top navigation with user menu, responsive layout, loading skeletons, empty and error states, toasts.
- Collapsible sidebar (state remembered in the browser). Browser-tested: collapse, persist after reload, expand, navigation, mobile layout of the two new pages.
- All 12 sections exist in navigation. **Working with real data:** Overview, AI Employees (create / edit / delete), Team (invite, change role, disable, revoke), Settings. **Layout only (empty states):** Conversations, Workflow Builder. **Placeholders:** Channels, Customers, Campaigns, Business Knowledge, Teach & Correct, Performance — each shows an honest "Coming in a later phase" state, no fake numbers.

**Authentication**
- Sign up (creates business + owner), login, logout (server-side revocation), password reset (single-use, 1 h), invitation acceptance, protected routes (client and API).

**Multi-tenancy**
- Tenant isolation enforced by PostgreSQL Row Level Security, with three least-privilege DB roles; fail-closed when no tenant is set; secrets unreadable by app roles.
- Platform Admin: list/search/filter companies, users count, AI employees count, monthly API usage, suspend/activate (takes effect immediately, sessions blocked).
- Business Owner: independent account, data, employees, settings.
- RBAC: owner / admin / manager / viewer / platform_admin.

**Docs:** README, `docs/ARCHITECTURE.md`, `docs/DEPLOY_HOSTINGER.md`, this file.

## Not completed / known gaps (be aware before Part 2)

1. **Reference images (received later, applied):** the sidebar is collapsible to an icon rail; **Conversations** uses the 3-pane inbox layout (views → list → thread); **Workflow Builder** has a dark toolbar, Nodes Library and a dotted canvas. These two pages are **layout only**: no messaging or workflow engine exists yet, so they show empty states (no sample conversations or workflows). Same visual spirit, MicroAgent palette and original artwork — nothing copied from the references.
2. **Not deployed to a real Hostinger server.** Hostinger Web/Cloud plans do not support PostgreSQL (per their support docs); a **VPS is required**. The deploy guide was written but not executed on Hostinger.
3. **Email delivery is untested against a real SMTP server.** Without `SMTP_HOST` emails go to an `email_outbox` table (dev only). Reset/invite flows are tested through that outbox.
4. **UI paths not covered by browser tests:** Team page actions, invitation acceptance screen, password-reset screens, Settings. Their API behaviour is covered by the 35 API tests; the screens themselves were type-checked and built but not clicked through.
5. Only Chromium was tested. No Safari/Firefox check.
6. No email verification at signup, no 2FA, no login lockout beyond per-IP rate limiting (in-memory, resets on restart, per process).
7. One email = one tenant (a person cannot belong to two businesses yet).
8. Plan/billing fields exist (`trial/starter/growth/scale`) but nothing enforces limits or charges.
9. Usage metering counts API requests only; AI/messaging usage arrives with the features that produce it.
10. No Arabic/RTL interface yet (the UI is English). The landing/dashboard layout was not built RTL-ready.
11. No CI pipeline; no automated backups configured (command documented).
12. Local dev database was created with generated passwords in `.env` (git-ignored). The `.env` file is not part of the repository.

## Decisions to carry forward
See `docs/ARCHITECTURE.md` §10.

## Next (Part 2) — not started
Waiting for your go-ahead and your reference images.
