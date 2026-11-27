# Testing

| What | Command | Notes |
|---|---|---|
| All API tests (312) | `npm test` (from repo or `apps/api`) | Needs PostgreSQL + the `microagent_test` database (`npm run db:setup`). ~5 min. Providers are local fakes in `apps/api/test/fake-*.ts`. |
| One file | `cd apps/api && node --import tsx --test --test-concurrency=1 test/<file>.test.ts` | |
| Typecheck | `npx tsc --noEmit` in `apps/api`; `npx tsc -b` in `apps/web` | |
| Production build | `npm run build` | |
| Security probes | `test/security.test.ts` | Route-by-route auth / RBAC / isolation / rate-limit / webhook / secrets checks. |
| Load & recovery | `cd apps/api && node --import tsx test/load.ts [conversations\|campaign\|recovery\|db]` | Prints measurements; results recorded in `docs/LOAD_TEST_REPORT.md`. |
| Browser harness | `node --import tsx test/e2e-part5.ts` (also `e2e-server.ts`, `e2e-campaigns.ts`) | Starts the app with seeded data and fake providers on port 5173 after `npm run build`; drive it with Playwright. The Playwright scripts used so far are not committed. |

Test files: workflows (29), performance (11), superadmin (8), security (29), rls, auth, agent, ai, policy, knowledge, channels, conversations, customers, campaigns, … (see `apps/api/test/`).
Guard tests fail when a new table lacks RLS or a new grant is not whitelisted — update them together with the migration.
