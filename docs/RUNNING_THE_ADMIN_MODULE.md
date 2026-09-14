# Running the company admin module end to end

Kept because the setup is fiddly to rediscover, and because the findings below
argue for repeating it before every release of this module.

## The environment

The worktree's `.env` points at staging RDS. **The seven company-admin
migrations are now applied to both staging and production** (production on
2026-09-04), so the paragraph that used to warn they were missing no longer
applies. Staging access is read-only by default; ask before writing to it.

A local database is still the right thing for a real end-to-end run — it is
disposable, and it carries the fixture users these tests assume:

```bash
cd .worktrees/admin-be
TEST_RUN_ID=e2elive npm run test:setup   # schema.sql + seed + every pending migration
# then point a scratch copy of .env at hospitality_test_e2elive
# (HOST=localhost, empty password, TEST_DB_NO_SSL=1) and start the server.
```

Frontend: `npx next dev -p 3111` **without** `--turbopack` — Turbopack refuses
the worktree's symlinked `node_modules` ("Symlink node_modules is invalid").
Running `npm ci` in the worktree replaces that symlink with a real directory,
after which `--turbopack` works; note that it also makes git see the tracked
symlink as deleted, so keep it out of your commit.

Auth for probing: mint a JWT the way `tests/helpers/auth.js` does — `sub` is the
cryptr-encrypted id, `ag` the cryptr-encrypted user agent, which must equal
`tbl_users.user_agent`. For the browser, also seed `persist:root` with a
`userProfile` carrying `is_hospitality: 1`, or `HospitalityAdminGate` sits on
its loading spinner forever.

## What it caught that the test suites did not

Fourteen defects, two of them shipping blockers, against a suite of ~2,700
backend and ~1,000 frontend tests that were all green.

Every one lived in a **seam between layers**, with a passing test sitting on one
side of it:

| Seam | What got through |
|---|---|
| route guard above component | a capability administrator was bounced out of every admin screen |
| controller above model | `is_company_admin` dropped by the response field whitelist, so the badge never rendered |
| mocked router above real router | `router.isReady` — HN-1's URL state silently wiped on a cold load |
| HTTP verb above intent | 57 read-shaped POST routes flooding the activity feed |
| read above write | a reassignment race leaving two live approvers on one step |

Component tests render *below* the guard. Model tests run *below* the
controller. A mocked router is *more* synchronous than the real one. None of
those gaps is visible from inside the layer being tested — which is the whole
argument for doing this by hand before shipping.
