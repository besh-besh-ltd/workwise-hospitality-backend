# Test Suite Conventions

> **Goal:** the test suite must catch regressions before they reach staging or
> production. To do that reliably, every test must exercise the **same code
> path the user hits** — not a hand-rolled replica of it.

This document is the contract for adding new tests. Read it before writing one.

---

## 1. Always call the production function — never duplicate its SQL

If a flow step is implemented by `someModel.someFn(...)` or
`someController.someAction(req, res, next)`, the test calls **that exact
function**. Never re-implement its query in the test, even if it looks simple.

**Why:** if production logic changes, the test must catch it. A test that
runs its own copy of an outdated query stays green while production breaks.

**Bad:**
```js
const rows = await db.any(
  `SELECT vv.vendor_id FROM tbl_product_variant_vendor_mapping vv
   JOIN tbl_vendor_hotel_category_subscription cs ON ...`,
  [variantId, hotelIds]
);
expect(rows.map(r => r.vendor_id)).toContain(vendorAlpha);
```

**Good:**
```js
import hospitalityModel from "../../app/models/hospitalityModel.js";
const rows = await hospitalityModel.getEligibleVendorsForVariant(variantId, hotelIds);
expect(rows.map(r => r.vendor_id)).toContain(vendorAlpha);
```

The only acceptable raw SQL in a test is the **setup** insertion of
prerequisite data (when no factory exists) and the **assertion** read-back of
final state. Never the function under test.

---

## 2. Two isolation patterns — pick one per test

### Pattern A — `withTx(fn)` (preferred when applicable)

Use when the function under test accepts a `txContext` parameter (e.g.
`createApprovalInstance({ txContext: t })`). The test wraps everything in a
single transaction that always rolls back at the end.

```js
import { withTx } from "../setup/db.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

it("does the thing", async () => {
  await withTx(async (t) => {
    const result = await createApprovalInstance({ ..., txContext: t });
    expect(result.instance.status).toBe("PENDING");
  });
});
```

- **Fast** (no commits, no cleanup).
- **Isolated** (rollback guarantees no inter-test leakage).
- **Faithful** (production code receives a tx and behaves the same way it
  would inside a controller's `db.tx(...)`).

### Pattern B — commit + cleanup

Use when the function under test queries `db` directly (no `txContext`
parameter). Insert prerequisites with `db.none(...)` (committed), call the
function, assert, and clean up affected rows in `afterEach`.

```js
import { db } from "../setup/db.js";
import hospitalityModel from "../../app/models/hospitalityModel.js";

const inserted = { mappingIds: [], subscriptionIds: [] };

afterEach(async () => {
  if (inserted.mappingIds.length) {
    await db.none(`DELETE FROM tbl_x WHERE id = ANY($1::int[])`, [inserted.mappingIds]);
  }
  inserted.mappingIds = [];
  inserted.subscriptionIds = [];
});

it("does the thing", async () => {
  const id = await db.one(`INSERT INTO tbl_x (...) VALUES (...) RETURNING id`, [...]);
  inserted.mappingIds.push(id.id);
  const rows = await hospitalityModel.getEligibleVendorsForVariant(...);
  expect(rows).toContain(...);
});
```

- Slower than Pattern A (commits + targeted deletes).
- Faithful to production's connection/visibility model.

### Don't mix patterns within one `it(...)`. Pick one and stick with it.

---

## 3. Test the controller through HTTP for end-to-end coverage

Wherever a flow is exposed as an HTTP endpoint, the highest-fidelity test runs
the full middleware chain (auth → ACL → validation → controller). Use
`tests/helpers/http.js`'s `httpClient(userId)`:

```js
import { httpClient } from "../helpers/http.js";

it("withdraw flips RFQ status to 5", async () => {
  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await client.post(`/api/v1/rfq/withdraw-publish/${rfqId}`).send({});
  expect(res.status).toBe(200);
});
```

For controller-direct tests (when bypassing route middleware is intentional —
e.g. unit-testing the handler in isolation), call the controller method
directly with a mock `req`/`res` (see `rfq.withdrawTerminate.test.js`).

---

## 4. External integrations are stubbed at boot, not per-test

`tests/setup/jestEnv.js` (Jest `setupFiles`) runs once per worker, BEFORE any
production module is imported. It:

- Forces `NODE_ENV=test` and overrides `DATABASE_NAME` so production
  `dbConn.js` binds to the per-run `hospitality_test_<runId>` database — not
  staging.
- Stubs `nodemailer.createTransport` so SMTP calls become no-ops returning a
  fake message id.

For per-test mocking of other modules (e.g. AWS Scheduler), use
`jest.unstable_mockModule(...)` at the **top of the test file** before any
`import` statement that would transitively load the module being mocked. ESM
exports are immutable, so `cronManager.removeRfqPublishJob = stub` does NOT
work — you must mock the module.

Example: `tests/services/rfq.withdrawTerminate.test.js` mocks
`app/helper/cronManager.js` to record `removeRfqPublishJob` calls without
hitting AWS.

---

## 5. Fixtures vs factories vs in-test setup

| Where | What | When to use |
|---|---|---|
| **Fixtures** (`tests/fixtures/*.js`, runs once at globalSetup) | Ambient population that ALL tests share — companies, hotels, depts, users, role-scopes, processes, policies, vendor master, subscription set | Read-only baseline data |
| **Factories** (`tests/factories/*.js`, called per-test) | Programmatic creation of per-scenario entities — `makeRFQ(t, opts)`, `makePO(...)` | When multiple tests need the same shape of new entity |
| **In-test setup** (raw INSERT in the test file) | One-off prerequisites for a single test | Only when factory would be over-engineering for one test |

If the same setup repeats in 3+ tests, promote it to a factory.

---

## 6. The reset rules

- `withTx` tests: rollback handles isolation, no manual reset needed.
- `commit + cleanup` tests: the test is responsible for tracking what it
  inserted and deleting it in `afterEach`. **Track concrete IDs you
  inserted; never delete by range** (`WHERE rfq_no >= 8000000`-style cleanup
  wipes data committed by other suites running in the same Jest worker and
  produces cross-suite flakiness that's hard to track down).
- `truncateDynamic()` is available for tests that need committed state across
  multiple transactions (concurrency tests). It empties dynamic tables but
  preserves fixture data (it auto re-seeds vendor subscriptions, which the
  `TRUNCATE … CASCADE` chain destroys via tbl_vendor_payments → vendor_subs).
  Use sparingly — it's a heavy hammer.

### Local Postgres (default)

Tests run against **local Postgres** (`brew install postgresql@17`) by
default — `.env.test` points `HOST=localhost`, `DATABASE_USERNAME=apple`,
empty password, and sets `TEST_DB_NO_SSL=1`. This eliminates the staging-RDS
contention that previously caused intermittent ECONNRESET / "Connection
terminated" failures, and drops a full `npm test` run from ~100 s to ~12 s.

Setup:
```
brew install postgresql@17
brew services start postgresql@17
# the brew install creates a superuser matching $USER ('apple') with no password
```

The retry wrappers we added (`tests/setup/db.js` query proxy + 3-attempt
retry in `tests/setup/prepareTestDb.js`) are still in the code; they're a
no-op against local Postgres and a safety net if a future run goes back to
RDS.

**Production code change** (`app/config/dbConn.js`): added a one-line guard
that disables SSL when `TEST_DB_NO_SSL=1` so production controllers, when
called from tests, also connect to local Postgres without TLS. In real
production deployments the env var is unset, so SSL stays on for RDS.

---

## 7. When production code changes, what happens?

| Production change | Test outcome | Action |
|---|---|---|
| Function signature changes | Compile/import error in the test | Update the test call site |
| Function logic fixes a bug the test was locking in (the bad behaviour) | Test fails | Update the test — the contract has changed |
| Function logic changes in a way that violates the documented contract | Test fails | The change is the regression. Don't update the test. |
| Schema column dropped/renamed | INSERT in setup helper fails | Update fixture/factory; if widespread, refresh `schema.sql` via `npm run test:snapshot-staging` |

The **test name + assertion** is the contract. If a code change breaks a
test, the first question is: "is the test name still describing intended
behaviour?" If yes → fix the code. If no → update the test.

---

## 8. `it.todo` discipline

Every `it.todo(...)` placeholder must have a corresponding row in
`tests/TODOS.md` with: location, blocker, and the wave/task that will resolve
it. Wave 5 (final report) verifies that file is empty before declaring the
suite production-ready.

When you add a todo: also add the row in the same commit. When you resolve a
todo: delete the row.

## 9. Naming + structure

```
tests/
├── setup/                — harness (lifecycle, db, app builder, jestEnv)
├── fixtures/             — ambient population (loaded once at globalSetup)
├── factories/            — per-test entity builders
├── helpers/              — auth, http, time, approval helpers
├── __mocks__/            — manual mock modules (loaded by jest.unstable_mockModule)
└── services/             — actual test suites; one file per controller area
```

One file per **flow area**, not per controller. e.g.
`rfq.withdrawTerminate.test.js` covers both endpoints since they share state
machine semantics. Larger surfaces (RFQ create, PO flow) get their own files.
