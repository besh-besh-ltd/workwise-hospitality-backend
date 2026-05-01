# CLAUDE.md — Workwise Hospitality Procurement Backend

> Read this file every time you sit down to work in this repo. It captures
> what was learned the hard way; do not relearn it.

## 1. What this project is

A multi-tenant hospitality procurement platform with three personas:

- **Buyer** — creates RFQs / Tenders, manages clarifications, runs technical
  evaluation, runs negotiation rounds, finalises vendors, generates POs.
- **Vendor** — receives inquiries, raises clarifications, submits quotes,
  participates in negotiation rounds, accepts/rejects POs.
- **Company Admin** — manages hospitality companies, hotels, departments,
  users, roles, RBAC scopes, approval policies (per process per BU per
  entity type).

Built with: **Express 4.21** · **PostgreSQL via pg-promise 11** ·
**Passport JWT** · **Joi/Celebrate** · **AWS S3 + Scheduler + EventBridge** ·
**Puppeteer** for ARC PDFs · **Socket.io** · **Nodemailer** · ESM modules,
Node ≥ 16. Lives at port `8002`.

The frontend is a separate Next.js project; this repo is backend-only.

---

## 2. Code quality you must maintain

These are the rules. They are not aspirational — drift creates the kind of
controller files that already exist here (15k-line `rfqController.js` with
500-line function bodies). Push back against any temptation to "just add
one more branch" to an existing function.

1. **One function, one job.** If you find yourself writing "and then" in the
   function's name or doc, split it. `validateThenInsertThenNotify` is three
   functions stitched together.
2. **Stay maintainable — extract sub-functions early.** When a function
   grows past ~50 lines or 3 levels of nesting, it almost always wants
   sub-functions. Examples already done here that you can mimic:
   `app/controllers/rfq/rfqUpdateHelpers.js` (extracted from the Edit RFQ
   path) and `app/controllers/general/reapprovalService.js` (extracted from
   the controller's submit path).
3. **Stay simple. Do not chase complexity.** Simpler is better. If the
   simplest thing works, ship that. Don't pre-build configurability for
   needs that don't exist yet.
4. **Names must read like English.** A reader skimming the file should be
   able to predict what every function and variable does from its name.
   `getApprovalPolicyForRfq(rfq)` beats `lookupPolicy(input, ctx)`.
   `unitPriceCents`, `vendorIds`, `approvedAt` — not `up`, `arr`, `ts`.
5. **Self-documenting code over comments.** Comments are documentation that
   silently rots. Use them only for things the code itself cannot say:
   - **Deprecation** — "DEPRECATED: scope-via-headers; use entity-driven
     resolution".
   - **Non-obvious WHY** — a workaround for a known bug, a non-trivial
     trade-off, an external constraint (RDS limitation, etc.).
   - **Locked-in defects** — see `AUDIT_REPORT.md`; tests use comments to
     mark "current behaviour locked, flip when fix lands".

   If you need a comment that says WHAT the code does, the code has the
   wrong names.
6. **Generic helpers must keep ONE responsibility.** Reusable does not mean
   over-parameterised. A helper with 9 boolean flags that does 9 different
   things is 9 helpers in a trench coat. Build the one helper for one job;
   if a second site needs a slightly different thing, build a sibling, not a
   superset.
7. **Boundaries validate. Internals trust.** Validate at HTTP / external-API
   boundaries (Joi schemas, request body checks). Inside the codebase, trust
   internal callers — don't double-validate on every function entry.
8. **Errors carry their semantics.** Don't `JSON.stringify` an object into
   `new Error(...)` and parse it back in the catch — that's how
   `saveRfqDraft → saveDraft` (defect F-DRAFT-500) ended up returning 500
   for "user lacks access". Throw structured errors:

       const err = new Error('You do not have access...');
       err.statusCode = 403;
       err.isHttpError = true;
       throw err;

   See `app/controllers/rfq/rfqUpdateHelpers.js#httpError` and how `update`
   maps `error.statusCode` to the response. Mirror that.
9. **No try/catch as a swallow.** If you don't have a real recovery,
   re-throw. Silent catches (`catch { /* swallow */ }`) are how
   `cancelAndReissueApproval` failures masked policy gaps in production.
10. **Don't widen function signatures to make a test pass.** If a test needs
    a hook, build the hook into the design — usually by extracting the
    hook's target into a smaller helper that the test can call directly.
    Don't add `txContext`, `_testOnly`, or `dryRun` flags just for tests.
11. **Default exports go at the bottom of the file, named exports prefer
    explicit naming, no `export default {...}` for grab-bag controllers.**
    The grab-bag pattern in `rfqController.js` is the reason that file is
    15k lines. New controllers should be split per concern.
12. **Database calls live in models. Email / S3 / scheduler / Puppeteer
    calls live in helpers/services.** Controllers compose. A controller
    that's writing raw SQL is doing the model's job.

---

## 3. Stop-and-think gotchas (the ones that bit us)

These are real defects we hit during the audit. Read each one before you
modify the corresponding area.

### 3.1 Approval policy resolution is process-scoped — no fall-through

`tbl_approval_policies.process_id` is part of the resolution key. If you
create an approval instance without passing `process_id`, the resolver
treats it as "match any process", which is **NEVER** the intent.

The bug `F-DUPLICATE-001` exists because `duplicateRfqForHotels`
(`rfqController.js:2950`) drops `process_id` + `department_id` from its
INSERT. Multi-hotel RFQs lose their process; the resolver fails;
`startApprovalForRfq`'s catch corrupts the savepoint chain and rolls back
the entire create transaction. **When working in `duplicateRfqForHotels` or
any flow that creates approval-eligible entities: copy the parent's
`process_id` and `department_id` into the new row.**

Tests that lock this contract:
- `tests/services/approvalPolicyResolution.test.js` (11 tests)
- `tests/services/rfq.create.flow.test.js` "F-APPROVAL-001 lock"
- `tests/services/techEval.flow.test.js` (cross-process tests)

### 3.2 `tbl_users.user_type` is a deprecated routing hint — DO NOT use it

The architectural rule is: every buyer is a procurement account; access is
scoped via RBAC + ABAC (`tbl_user_role_scopes`, `tbl_user_department`,
`tbl_hospitality_user_mappings`). Several controllers still gate on
`req.user.user_type ∈ {3,4}` — that's the `F-USERTYPE-QUOTE` defect.

**If you need to know "is this caller a vendor for this RFQ?", check
`tbl_rfq_product_vendors` membership. If you need "is this caller a buyer
in this scope?", check the RBAC role+scope. Never branch on `user_type`.**

### 3.3 Scope is derived from the entity, NOT from headers

The headers `x-company-id`, `x-hotel-ids`, `x-department-id` are
**deprecated**. The earlier version of this CLAUDE.md described them as
"common headers" — that was wrong. Any new endpoint must derive scope from
the target entity row's `hotel_id` / `department_id` / `process_id`. The
acting user is then filtered against RBAC scopes that match.

If you find yourself reading `req.headers['x-hotel-ids']`, stop and check
whether the entity already has the answer. The audit's
`tests/security/headerlessScope.test.js` (Wave 3, scoped) will treat any
endpoint that depends on these headers as a defect.

### 3.4 `checkIfExists` returns `[]` for "not found", which is truthy

`rfqModel.checkIfExists` returns `db.any(...)` — i.e. an empty array on no
match, NOT `null`. Code that does `if (!result) return 404` will never
fire; the next line `result[0].id` then crashes with TypeError.

This is `F-QUOTE-NOTFOUND-001`. **When using `checkIfExists`, always check
`result.length === 0` (or use `db.oneOrNone`).** Better: stop using
`checkIfExists` for existence checks; use `db.oneOrNone` directly.

### 3.5 `TRUNCATE … CASCADE` chains farther than you'd expect

`tbl_vendor_payments` has FKs to both `tbl_rfq` and `tbl_quotes`.
`tbl_vendor_hotel_category_subscription` has an FK to `tbl_vendor_payments`.
Truncating `tbl_rfq` cascades through both, wiping vendor subscriptions.

The test harness `truncateDynamic` re-seeds subscriptions to compensate. If
you ever add a maintenance script that truncates dynamic tables in
production, you must replicate the re-seed. Do not assume CASCADE is
contained.

### 3.6 Savepoints poison the outer transaction when not handled

When a model wraps a write in a savepoint and the inner work fails, the
savepoint must be rolled back — not just caught and ignored. The
`startApprovalForRfq` catch logs and continues, but the savepoint is
already aborted, so every subsequent statement on `t` errors with
"savepoint sp_X_Y does not exist".

Pattern:

    const sp = await t.savepoint('start_approval');
    try {
      // ... work ...
    } catch (err) {
      await sp.rollback();
      logger.warn('approval lookup failed', { rfq_id, err });
      // continue OR re-throw, but the outer tx is no longer poisoned.
    }

Use this pattern any time you swallow an error inside a transaction.

### 3.7 Withdraw / Terminate must delete the scheduler job

When the buyer withdraws or terminates a pre-publish RFQ, both the approval
instance AND the AWS Scheduler / EventBridge publish-fire job must be
cancelled. Forgetting the scheduler job leads to the publish firing on a
withdrawn RFQ — vendors get an inquiry email for an RFQ that no longer
exists. See `app/helper/cronManager.js#removeRfqPublishJob` and how
`rfqController.withdrawPublish` / `terminateRFQ` call it.

### 3.8 Idempotency: `is_published === 1` short-circuits publish

`publishRfqById` checks `is_published === 1` and returns
`{skipped: true, reason: 'already_published'}` rather than re-running. Any
new publish-side hook (emails, schedulers, history rows) **must** be inside
the `if (rfq.is_published !== 1)` branch — otherwise replays will
double-fire.

### 3.9 The Edit RFQ unlock branches are subtle

When `bid_end_date` has passed, edits are normally rejected. Two unlocks:

- **Zero participation** (no `tbl_quotes` rows for this RFQ): full edit
  allowed. The buyer can do anything — change dates, swap products, add
  vendors.
- **Tech-stuck** (any product's tech-eval has
  `blocked_insufficient_vendors=true` + `total_passed_verified=0`):
  RESTRICTED edit only. Just `bid_end_date` and Refresh Vendors are
  allowed. Other RFQ fields, product specs, files, comments, terms — all
  rejected.

The check ordering matters: `assertEditDateConstraints` runs BEFORE the
restricted-edit guard, so a snapshot with a past `bid_end_date` short-
circuits with a date error rather than the intended restricted-edit
rejection. If you're testing or debugging restricted edits, always include
a future `bid_end_date` in the snapshot.

### 3.10 Timezone discipline: dates flow as IST wall-clock strings

RFQ form dates (bid_end_date, vendor_clarification_date,
tender_publish_date) are sent as `YYYY-MM-DD HH:mm:ss` with NO timezone
suffix, treated as IST. Use `parseIstWallTimeToEpoch`
(`rfqUpdateHelpers.js`) to compare them against `Date.now()`. Never call
`new Date(input)` directly on these strings — the result depends on the
server's timezone.

---

## 4. Architectural rules locked by stakeholder

These were confirmed by the product owner and are non-negotiable. Older
docs may contradict — those docs are stale. Trust this list:

| Rule | Where it's enforced |
|---|---|
| ARC + full Tender flow are out of audit scope; RFQ-only this pass. Tests do not exercise `is_tender=1` flows. | `tests/setup/fixtures.md` |
| `tbl_users.user_type` is unused for routing/auth in hospitality. | `tests/services/quote.submission.test.js#F-USERTYPE-QUOTE` |
| Scope-via-headers (`x-company-id`, `x-hotel-ids`, `x-department-id`) is deprecated. Scope is entity-derived. | `tests/helpers/auth.js` (returns only `Authorization` header) |
| Vendor mapping is at product CATEGORY level, NOT subcategory. | `app/models/hospitalityModel.js#getEligibleVendorsForVariant` + `tests/services/vendorEligibility.test.js` |
| Lapsed-was-active vendors STILL receive inquiries (continuity rule). Subscription is enforced only at the quote-send page. | `tests/services/vendorEligibility.test.js` "lapsed-was-active" |
| `tbl_approval_policies.process_id` is part of resolution. No cross-process fall-through. | `tests/services/approvalPolicyResolution.test.js` |
| Pre-publish creator actions (Withdraw, Terminate) MUST cancel approval instances AND delete the scheduler job. | `tests/services/rfq.withdrawTerminate.test.js` |
| PO merge prompt: when same vendor is finalised across multiple products of one RFQ and a draft PO already exists, the final approver gets a merge-vs-separate choice. | (test deferred — Wave 5) |

---

## 5. Test discipline

### 5.1 The contract

Every test calls a **production** controller, model, or helper directly.
Never duplicate SQL inside a test. If production logic changes,
the test catches it; if a test changes without a production change, the
contract has shifted and the test name should describe the new contract.

### 5.2 Running the suite

    cd backend
    npm test                    # full suite, ~15s on local Postgres
    npm test -- tests/services/rfq.update.flow.test.js   # one file
    npm run test:setup          # rebuild test DB without running tests
    npm run test:teardown       # drop the per-runId test DB
    npm run test:cleanup        # drop orphan hospitality_test_* DBs (>24h)

The harness creates a runId-scoped Postgres database
(`hospitality_test_<runId>`), applies `tests/setup/schema.sql` +
`seed_reference.sql` + JS fixtures, runs every suite, drops the DB. Total
runtime ≈ 15s. Local Postgres only — see §6.

### 5.3 Conventions

Documented in full in `tests/CONVENTIONS.md`. Headlines:

- **Two isolation patterns:** `withTx(fn)` for pure-read tests
  (sentinel-rollback, fast); commit + cleanup for tests that need to
  observe committed state across transactions (track concrete IDs in
  `inserted.{xxxIds}`, delete them in `afterEach`; never delete by range).
- **Approver-acting helper:** `tests/helpers/approval.js` — exports
  `approveStep`, `rejectStep`, `approveFully`, `getInstanceState`,
  `getLatestAction`. Drives the production approval engine end-to-end.
  Use this for any multi-step approval flow; do not write your own.
- **Scoring helpers:** `tests/factories/techEval.js#setupScoredVendor`
  builds a fully-scored vendor in one call.
- **Auth helper:** `tests/helpers/auth.js#loginAs(userId)` returns only
  `{Authorization, User-Agent}`. Honours the entity-derived scope rule.

### 5.4 Locking defects in tests

When you find a defect during the audit, write the test to assert the
**current (broken)** behaviour, not the post-fix behaviour. Add a comment:

    // CURRENT BEHAVIOUR (defect F-XXX-001): controller returns 500 for
    // access denial. When fixed, flip to expect 4xx + matching message.

The test stays green today; the day someone fixes the defect, the test
fails and tells the engineer to flip the assertion. Don't skip a defect
test — that's a silent gap. See `tests/services/po.acceptReject.test.js`
F-PO-CASCADE-001 for the canonical pattern.

### 5.5 `it.todo` discipline

Every `it.todo(...)` MUST have a corresponding row in `tests/TODOS.md` with
location, blocker, and target wave/task. A todo without a registry row is
a silent leak. Wave 5 verifies the file is empty before declaring the
suite production-ready. Currently 9 todos, all blocker-tracked.

---

## 6. Test infrastructure

### 6.1 Local Postgres (default)

Tests run against `brew install postgresql@17` on `localhost`. The brew
install creates a superuser matching `$USER` (e.g. `apple`) with no
password — peer auth on localhost. `.env.test` reflects this:

    HOST=localhost
    DATABASE_USERNAME=apple
    DATABASE_PASSWORD=
    DATABASE_PORT=5432
    TEST_DB_NO_SSL=1
    NODE_ENV=test

The full suite drops from ~100s on shared RDS to ~15s on local Postgres,
with zero ECONNRESET flakes. Production `app/config/dbConn.js` honours
`TEST_DB_NO_SSL=1` so tests using production controllers don't try TLS
against a local server. In real production deploys, the var is unset →
SSL stays on.

### 6.2 Test-DB safety

Three guards prevent us from ever touching staging or production from
tests:

1. The DB name MUST match `^hospitality_test(_[a-zA-Z0-9_-]+)?$`.
2. `NODE_ENV` MUST be `test`.
3. The protected-name list (`hospitality`, `hospitality_stage`,
   `hospitality_prod`, etc.) is rejected outright.

These checks live in `tests/setup/envguard.js` and are duplicated in the
prepare/drop scripts as defence-in-depth.

### 6.3 Fixtures

`tests/fixtures/index.js` orchestrates the seed:

- 2 buyer parent companies + 5 vendor parent companies (`tbl_company`)
- 2 hospitality companies, 5 hotels (3 under A, 2 under B), 4 global
  departments
- 16 buyer users covering every (role × scope) the audit needs +
  5 vendor users with varied subscription states
- 3 approval processes (A.P1 Standard Procurement, A.P2 Daily Bazaar,
  B.P1) — used to exercise process-scoped routing
- ~16 approval policies covering every (process × hotel × entity) combo
  including a deliberately-empty A2_P1_RFQ (zero-approver auto-skip)
  and a deliberately-missing A3_P1_PO (under-configured BU)
- Vendor subscriptions in 5 distinct states: active, multi-category,
  expired (lapsed-was-active), cancelled, pending

All IDs are stable across runs; see `tests/fixtures/ids.js` for the
canonical map.

---

## 7. Codebase map

```
backend/
├── server.js                 entry point
├── app/
│   ├── config/
│   │   ├── database.js       pg-promise (legacy, points to dbConn)
│   │   ├── dbConn.js         active pg-promise instance — honours TEST_DB_NO_SSL
│   │   ├── passport.js       Passport strategies (localUsr, localAdm, jwtUsr)
│   │   └── s3config.js       AWS S3 client
│   ├── controllers/
│   │   ├── rfq/              RFQ + clarifications + tech-eval + finalize
│   │   ├── negotiation/      Negotiation rounds
│   │   ├── po/               Purchase orders (initiate, approve, accept, reject)
│   │   ├── arc/              ARC PDF generation (out of audit scope)
│   │   ├── rbac/             Roles + permissions
│   │   ├── general/          Approval engine + reapprovalService + hospitality
│   │   ├── users/            User mgmt + hospitality companies
│   │   └── products/         Product catalogue
│   ├── models/               pg-promise SQL queries — keep SQL HERE not in controllers
│   ├── routes/               /api/v1/* route definitions
│   ├── middleware/
│   │   ├── auth.js           passportSignIn (JWT)
│   │   ├── acl.js            role-list whitelist (legacy — prefer can())
│   │   └── can.js            permission-key middleware (RBAC; entity-derived scope)
│   ├── services/
│   │   ├── approvalActionService.js  executeApprovalAction wrapper
│   │   └── notificationService.js
│   ├── helper/
│   │   ├── common.js         sendMail
│   │   ├── cronManager.js    AWS Scheduler + EventBridge integration
│   │   ├── quoteVisibility.js  IST-anchored quote-visibility window
│   │   └── sendEmailFunctions/  per-flow email functions
│   ├── validations/          Joi schemas (Celebrate)
│   └── util/                 constants, logger, error
└── tests/
    ├── setup/                harness (db, prepareTestDb, jestEnv, envguard)
    ├── fixtures/             JS fixture orchestrator (network, users, processes, policies, vendors)
    ├── factories/            per-entity factories (rfq, techEval)
    ├── helpers/              loginAs, http, approval, time
    ├── services/             flow/integration tests
    ├── CONVENTIONS.md        the discipline doc — read before writing tests
    └── TODOS.md              every it.todo MUST be registered here
```

---

## 8. Database patterns

### 8.1 pg-promise basics

    import db from '../config/dbConn.js';

    await db.any(sql, params);          // 0..N rows
    await db.one(sql, params);          // exactly 1 — throws otherwise
    await db.oneOrNone(sql, params);    // 0 or 1, returns null on empty
    await db.none(sql, params);         // execute, no result expected
    await db.result(sql, params);       // returns { rowCount, ... }

    await db.tx(async t => {            // transaction
      const row = await t.one('INSERT ... RETURNING *', [...]);
      await t.none('INSERT child ...', [row.id, ...]);
      return row;
    });

### 8.2 Always parameterise

`$1`, `$2`, ... — never string-concat user input into SQL. There ARE
spots in this codebase that do (`rfqController.js#5385` is one) — those
are pre-existing technical debt; do not extend the pattern.

### 8.3 Transactions and savepoints

Pass the `t` context down to every model call inside a transaction.
Models that hit `db` directly (instead of the passed `t`) silently break
isolation — see `tests/CONVENTIONS.md` §6 "withTx vs commit+cleanup".

When wrapping risky calls in a savepoint, ALWAYS call
`savepoint.rollback()` on the failure path (see §3.6).

### 8.4 Schema quirks worth knowing

- `tbl_rfq.bid_end_date` is `TEXT`, not a timestamp. Treat it as IST
  wall-clock string (`YYYY-MM-DD HH:mm:ss`).
- `tbl_rfq.rfq_no` is `INTEGER`, NOT auto-incremented in some flows
  (multi-hotel duplicate uses `MAX(rfq_no) + 1` subquery).
- `tbl_department` is GLOBAL — only `id` + `title` + `access_type`.
  Hotel/dept binding lives in `tbl_user_role_scopes`.
- `tbl_user_role_scopes` and `tbl_user_department` have NO FK constraints.
- `tbl_approval_processes.company_id` → `tbl_company.id` (parent identity),
  NOT `tbl_hospitality_companies.id`.
- `tbl_approval_policies.hospitality_company_id` →
  `tbl_hospitality_companies.id`.
- The schema sets `search_path = ''` — `prepareTestDb.js` resets it to
  `public, pg_catalog` between sections. If you write a one-off SQL
  script, do the same.

---

## 9. API conventions

### 9.1 Response shape (current — has gaps)

    // Success: HTTP 200, status: 1
    { status: 1, message: 'Success', data: {...} }

    // Not found: HTTP 4xx, status: 2
    { status: 2, message: 'Resource not found' }

    // Server / generic error: HTTP 4xx/5xx, status: 3
    { status: 3, message: 'Error description' }

    // Validation / business rule: HTTP 400, status: 0
    { status: 0, message: '...' }

The `status` field overlaps with HTTP status in unhelpful ways and is the
root of several inconsistency defects (`F-DRAFT-500`, `F-CLAUSE-NOTFOUND-001`).
For new endpoints: use HTTP status correctly, keep `status: 1` for success,
and use a single `error` object on failures. Don't extend the current 4-way
mess.

### 9.2 Authentication

    Authorization: Bearer <jwt>

That is the ONLY required header for hospitality endpoints. No
`x-company-id`, no `x-hotel-ids`, no `x-department-id` (deprecated, see §3.3).

### 9.3 Routes

All routes are prefixed `/api/v1/`. Definitions live in `app/routes/`.
Keep route definitions thin — auth + ACL + Joi + handler. Business logic
goes in the controller, not the route.

---

## 10. Approval engine

### 10.1 What it is

`tbl_approval_policies` defines who must approve a given (entity_type ×
hospitality_company_id × hotel_id × department_id × process_id) combo.
Steps live in `tbl_approval_policy_steps` with a rule (`ANY` / `ALL`) and
a source (USER / ROLE / DEPARTMENT). When an entity transitions into an
approval-required state, an instance is created in `tbl_approval_instances`.

Entity types in scope: `RFQ`, `TENDER` (out of scope this pass), `PO`,
`NEGOTIATION`, `NEGOTIATION_QUOTE`, `TECHNICAL`. (`ARC`, `INDENT` exist but
out of scope.)

Instance statuses: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`.

### 10.2 Core functions

- `generalModel.findBestMatchingPolicyTx(scope, t)` — resolves the policy
  for a given scope. Process-aware. **No cross-process fall-through.**
- `generalModel.createApprovalInstance(args, t)` — creates an instance
  against the resolved policy. Throws if no policy exists.
- `services/approvalActionService.executeApprovalAction(args)` — runs an
  approve/reject. Wraps `submitApprovalAction` from the model layer with
  the right post-action dispatch. **Always use this from controllers
  rather than calling `submitApprovalAction` directly.**
- `controllers/general/reapprovalService.cancelAndReissueApproval(rfq, ...)` —
  used by Edit RFQ to cancel in-flight approvals and start fresh.

### 10.3 Post-approval actions (per entity type)

After an instance reaches APPROVED, the engine dispatches:

- **RFQ / TENDER** — sets RFQ status to READY_TO_PUBLISH (4) and schedules
  publish.
- **TECHNICAL** — moves passed vendors to the cleared list.
- **NEGOTIATION** — flips the round PENDING_APPROVAL → ACTIVE.
- **NEGOTIATION_QUOTE** — moves selected quotes into finalisation.
- **PO** — flips PO pending_approval → acceptance_pending and emails the
  vendor.

The dispatch is the engine's responsibility; controllers should not
duplicate it.

---

## 11. Active defects (read AUDIT_REPORT.md for the full list)

These are the defects locked by tests. When you fix one, flip the test
assertion and update `AUDIT_REPORT.md`.

| ID | Severity | What's wrong |
|---|---|---|
| F-PO-CASCADE-001 | P0 | Multi-vendor PO rejection wipes ALL vendors' finalisation. |
| F-DUPLICATE-001 | P1 | Multi-hotel RFQ duplicate INSERT drops process_id+department_id. |
| F-WITHDRAW-RACE | P1 | Concurrent withdraw + scheduler-fire race. |
| F-NEGO-001 | P1 | getActiveRound exposes all vendors' per-vendor fields to every vendor. |
| F-USERTYPE-QUOTE | P1 | createQuote / requireActiveSubscription gate on user_type. |
| F-PO-IDEM-001 | P1 | Ambiguous error for "wrong vendor" vs "already actioned". |
| F-QUOTE-NOTFOUND-001 | P1 | updateQuoteItems crashes 500 on missing quote (truthy `[]`). |
| F-VALIDATION-001 | P2 | Edit RFQ doesn't enforce ≥1 vendor per product. |
| F-CLAR-002 | P2 | Buyer can close clarification without answering; no notification. |
| F-DRAFT-500 | P2 | saveDraft returns 500 for any error including auth. |
| F-CLAUSE-NOTFOUND-001 | P2 | addClause on missing RFQ returns 200/status=0 instead of 404. |

Two reports cover defects in detail:
- `deployment_notes/AUDIT_REPORT.md` — engineering, with file:line references and proposed fixes.
- `deployment_notes/AUDIT_SUMMARY_PRODUCT.md` — business-language summary for product/sales.
- `deployment_notes/TEST_COVERAGE_REPORT.md` — every test in the suite + what it covers.

---

## 12. Things that LOOK like a feature but are deprecated / dead

Don't touch these unless you're removing them:

- `tbl_role_menu` — looks RBAC-related; it's NOT. Legacy main-portal
  sidebar/menu config. Stakeholder confirmed.
- `tbl_role_permission` (singular) — replaced by plural `tbl_role_permissions`.
- `tbl_user_subscriptions`, `tbl_subscription_plans`, `tbl_offer`,
  `tbl_subscriptions_payment` — legacy main-portal billing. Hospitality
  uses `tbl_vendor_hotel_category_subscription` only.
- `tbl_approval_hierarchy*`, `tbl_hierarchy_*_mapping` — pre-`tbl_approval_policies`
  engine. Replaced.
- `tbl_attributes`, `tbl_variants` — replaced by `tbl_product_*`.
- `tbl_cms_*`, `tbl_blog*`, `tbl_faq`, `tbl_testimonials`, `tbl_media`,
  `users_book_demo`, `tbl_company_logo` — main-portal era CMS.
- `tbl_projects`, `tbl_project_team`, `tbl_project_files` — legacy.
- `tbl_admin_rfq_service`, `holidays`, `tbl_reject_reason`,
  `tbl_communication_settings*`, `tbl_portal_tour_*` — unused per stakeholder.
- `_migration_*_backup`, `audit_log_temp`, `*_bkp` — backup tables;
  excluded from `schema.sql` snapshot.
- The `rfqController` `getQUOTES` / `downloadQuoteResults` legacy pair
  (line ~8106) — replaced by `downloadQuoteResultsProductWise`.

---

## 13. Common commands

    npm install                 install deps
    npm run dev                 nodemon dev server (port 8002)
    npm start                   production server
    npm test                    full Jest suite
    npm run test:setup          rebuild test DB only
    npm run test:teardown       drop test DB only
    npm run test:cleanup        drop orphan test DBs
    npm run test:snapshot-staging   re-pull schema.sql + seed_reference.sql

---

## 14. Where to start when adding a feature

1. **Find the wave / step it belongs to.** The audit plan
   (`/Users/apple/.claude/plans/okay-this-is-a-rosy-flurry.md`) maps every
   user-flow step to a controller. Don't add new top-level controllers
   when an existing one has the right home.
2. **Read the test for that flow first.** `tests/services/<flow>.test.js`
   shows the contract every controller in that flow must keep. New code
   must keep those tests green.
3. **Write the test first.** TDD here pays off because the test harness is
   fast (~15s) and seeded with realistic fixtures. If you can't write the
   test, the design isn't clear yet.
4. **Extract to a sub-helper if the function exceeds ~50 lines.** See
   `app/controllers/rfq/rfqUpdateHelpers.js` for the pattern.
5. **Update `AUDIT_REPORT.md` if you find a new defect** while working.
   Lock it with a test (see §5.4).
6. **Update this file** if the rule you discovered belongs in §3 or §4.
   Future-you will thank you.

---

## 15. Things to NEVER do

- Do not gate on `tbl_users.user_type`.
- Do not read `x-company-id` / `x-hotel-ids` / `x-department-id` headers.
- Do not write SQL inside controllers — use a model.
- Do not duplicate gate logic between `createX` and `updateX` controllers
  — extract a shared helper (see how `getQuoteVisibilityForRfq` is used).
- Do not throw `new Error(JSON.stringify({...}))`. Throw a structured
  error with `statusCode` / `isHttpError` / `code`.
- Do not catch-and-swallow without a real recovery. Re-throw or handle.
- Do not skip a defect test (`it.skip`) — lock it with a current-behaviour
  assertion (see §5.4).
- Do not add `_testOnly` / `dryRun` flags to production functions for
  testability — refactor for testability instead.
- Do not commit to `main` without `npm test` green.
