# Purchase Requisitions (PR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an end-to-end Purchase Requisition module. A requester raises a PR (catalog or free-text lines). Category-driven technical review comes next, then a value-aware, separation-of-duties, fail-closed approval. Approved lines then wait in a buyer pool, where buyers merge them into an RFQ draft that opens in the existing RFQ wizard. A platform catalog-request loop handles free-text items with no catalog match.

**Architecture:**
- **Backend:** a new `pr` domain (`app/{routes,controllers,models,services}/pr/`). It sits on the existing approval engine, extended generically but gated per entity type (min-amount steps, initiator exclusion, strict steps).
- **Downstream line progress is derived in SQL** from `tbl_pr_line_rfq` → `tbl_rfq` → `tbl_rfq_purchase_order`. No hooks are added to RFQ or PO code.
- **Frontend:** new pages under `/dashboard/buyer/purchase-requisitions/`. They follow the MR pages' `arc_v2.css` / `.main-body` conventions, plus additions to the admin approval-hierarchy wizard and the Approvals page.
- **admin-panel:** gets a Catalog requests queue.

**Tech Stack:**
- BE: Node 20 ESM, Express 4, pg-promise (raw SQL), Jest with real Postgres via supertest (`tests/helpers/http.js`).
- FE: Next.js pages router, React, axios (`@/lib/axios`), Jest + Testing Library.
- admin-panel: Next 13 pages + RTK + react-bootstrap.

**Spec:** `docs/superpowers/specs/2026-10-13-purchase-requisitions-design.md`. Read it first; section numbers below (§n) refer to it.

**Worktrees / branches:**
- BE: `/Users/apple/Documents/Workwise/hospitality/.worktrees/purchase-req/backend`, branch `feat/purchase-requisitions`, off `feat/vendor-networks` (62a8de8a).
- FE: `/Users/apple/Documents/Workwise/hospitality/.worktrees/purchase-req/frontend`, branch `feat/purchase-requisitions`, off `feat/vendor-networks` (c93cb888).
- admin-panel: `/Users/apple/Documents/Workwise/hospitality/admin-panel`. Create branch `feat/purchase-requisitions` from its current HEAD in Task 18, using a worktree at `/Users/apple/Documents/Workwise/hospitality/.worktrees/purchase-req/admin-panel`.

## Global Constraints

- **Running tests:**
  - Always `npm test -- --testPathPatterns "<regex>"` (plural flag). Never `npx jest`.
  - The BE test DB is isolated by `TEST_RUN_ID=preq` in `.env.test` (skip-worktree; do not commit it).
- **Tenant scope:**
  - Scope (company / hotel / department) is **always** derived from `req.user` and the PR row. Never trust `hospitality_company_id`, `hotel_id` or a user id from the body or query for authorization. The only exceptions are `hotel_id`/`department_id` on *create*: they choose the cell and are then verified with `pr.create` on that cell.
  - Use `acl([2, 8])` route gates plus in-controller scope checks. **Never** the `can()` middleware.
- **SQL:**
  - Parameterized only (`$1…`).
  - Never `NOT IN (subquery)`; use `NOT EXISTS`. The `sql.notInNullGuard` test enforces this.
- **Money:** `NUMERIC` in SQL; strings or `Number` only at the API edge. The server recomputes every total; client totals are ignored. Line value = `ROUND(quantity * estimated_unit_price, 2)`.
- **State changes:**
  - Every state change runs in `db.tx`, locks the PR row (`SELECT … FOR UPDATE`), and re-checks the expected status. A wrong state → HTTP **409** `{ status: 0, code: 'PR_STATE_CONFLICT', message }`.
  - Error responses are `{ status: 0, code, message, details? }`, using codes from `app/services/pr/prErrors.js` (Task 3).
- **Audit:** every mutation writes a `tbl_pr_event` row in the same transaction (Task 3, `prEvents.record`).
- **Migrations:**
  - `migrations/YYYYMMDDHHMMSS_name.sql` plus `.down.sql`, written to be idempotent.
  - Each must be appended to `tests/setup/pendingMigrations.json`.
  - New enum values are added in their **own transaction** before they are used.
- **Test files:**
  - New BE test files must match exactly one shard in `tests/shards.json`. Task 1 adds shard `pr` with pattern `tests/services/pr\\.`. Run `npm run test:shards`.
  - Tests are **product-level**: real HTTP via `httpClient(userId)` against real Postgres. Assert observable behaviour (HTTP status, body, DB rows), not internals.
  - DB setup uses Pattern B: commit, then `afterAll`/`afterEach` cleanup by tracked IDs (`tests/CONVENTIONS.md`).
- **FE:**
  - `arc_v2.css` tokens and classes; every page content is wrapped in `<div className="main-body">`.
  - Services in `services/pr.js` (`import axiosInstance from "@/lib/axios"`, `const BASE = "/pr"`).
  - URLs only via `components/dashboard/shared/dashboardLinks.js` builders.
  - Indian number formatting `₹` with `toLocaleString('en-IN')`.
- **Commits:**
  - Commit after each green task step. Messages are `feat(pr): …` / `test(pr): …` / `fix(pr): …`.
  - End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - **Do not push.**

## Review Focus

These failure modes are not otherwise covered; each line names the task that pins it with a test.

1. **The requester's role is revoked, or the reviewing department loses its last reviewer, while a review is pending.** The PR must not silently stall. Detail shows "No eligible reviewer — contact your admin" and the admin can fix it by granting the role. Reviewers are resolved at read time (Task 6, test `review.no-eligible-reviewer-mid-flight`).
2. **The submit or Convert button is double-clicked, or two tabs are open.** Exactly one instance or one RFQ must result; the second call gets 409 (Task 6 `submit.double`, Task 9 `convert.concurrent`).
3. **The requester edits a draft in one tab after it was submitted from another.** The update returns 409 `PR_STATE_CONFLICT`; nothing changes (Task 3 `update.after-submit`).
4. **The catalog changes between draft and use.** A contract that becomes active, or a variant that is deactivated, after drafting is re-checked at submit, map and convert (Task 6 `submit.contract-appeared`, Task 9 `convert.variant-deactivated`).
5. **Fractional or very large quantities and prices.** 0.5 kg; ₹ 12,50,00,000.75 at the threshold boundary. Values must stay exact through NUMERIC, the threshold compare and RFQ `Quantity` specs (Task 7 `threshold.boundary-exact`, Task 9 `convert.fractional-sum`).

---

## File Structure

### Backend (`.worktrees/purchase-req/backend`)

| File | Responsibility |
|---|---|
| `migrations/20261013100000_pr_permissions.sql` (+ `.down.sql`) | enum values `pr` / `convert`; permissions; system roles |
| `migrations/20261013101000_pr_tables.sql` (+ `.down.sql`) | all `tbl_pr*` / `tbl_purchase_requisition*` tables, `min_amount` column |
| `app/services/approval/approvalEntityRules.js` | per-entity engine rules: `excludesInitiator`, `stepAppliesAtAmount`, `filterInitiator` |
| `app/models/generalModel.js` (modify) | resource map `PR→'pr'`; createApprovalInstance `amount`/`strictSteps`; SoD filter; insertPolicySteps `min_amount` |
| `app/services/approvalPropagationService.js` (modify) | SoD and threshold filters on the 4 re-resolve call sites; `min_amount` in the diff; PR in `dispatchPostApprovalHandler` + `IDENTIFIER_KEYS_BY_ENTITY` |
| `app/services/approvalActionService.js` (modify) | PR in `postActionRegistry`; `pr_number` identifier |
| `app/controllers/general/generalController.js` (modify) | `validEntityTypes += 'MR','PR'` |
| `app/services/pr/prErrors.js` | error codes + `PrError` + `sendPrError(res, err)` |
| `app/services/pr/prEvents.js` | `record(t, {prId, lineId, revision, actorId, type, payload})` |
| `app/models/pr/prModel.js` | SQL: PR/line CRUD, scope predicates, `LINE_PROGRESS_SQL`, list, pool |
| `app/services/pr/prAccess.js` | `canReadPr`, `assertPerm`, scope helpers (wraps `authorizationService`) |
| `app/services/pr/prCatalog.js` | category derivation, usable-variant check, contract-coverage check, duplicate hints |
| `app/services/pr/prRouting.js` | review groups, reviewer resolution, approval-chain preview (thresholds / SoD / problems) |
| `app/services/pr/prWorkflow.js` | submit / withdraw / cancel / send-back / review actions / instance creation |
| `app/services/pr/prConversion.js` | pool → RFQ draft builder |
| `app/services/pr/prNotify.js` | all PR notifications (in-app + email) |
| `app/controllers/pr/prController.js` | thin HTTP layer + `handlePrPostApproval` / `handlePrRejection` |
| `app/controllers/pr/prAdminController.js` | category-routing map (company admin) |
| `app/controllers/admin/prCatalogRequestController.js` | platform catalog requests (`jwtAdm`) |
| `app/routes/pr/index.js` | `/api/v1/pr/*` |
| `app/routes/index.js` (modify) | mount `v1.use('/pr', PrRoutes)` |
| admin route file for `/api/v1/admin/pr-catalog-requests` (modify the existing admin router — Task 10 locates it) | |
| `app/services/notificationLinks.js` (modify) | `buyerPrDetail`, `ENTITY_LABELS.PR`, `approvalActionUrl` case |
| `app/helper/approvalEmailContext.js` (modify) | PR identifier |
| `app/services/activity/eventRegistry.js` + `app/models/activityModel.js` (modify) | PR activity events |
| `tests/helpers/prFixtures.js` | PR test helpers (grant roles, policies, drafts, cleanup) |
| `tests/services/pr.*.test.js` | product-level tests per task |

### Frontend (`.worktrees/purchase-req/frontend`)

| File | Responsibility |
|---|---|
| `services/pr.js` | API client |
| `components/dashboard/purchase-requisitions/prFormat.js` | money / qty / status label / progress label helpers |
| `components/dashboard/purchase-requisitions/PrStatusPill.js`, `PrProgressPill.js` | pills |
| `components/dashboard/purchase-requisitions/PrLineEditor.js` | line rows: catalog picker / free text, guided-buying block |
| `components/dashboard/purchase-requisitions/PrRoutingPreview.js` | review + approval preview with problems |
| `components/dashboard/purchase-requisitions/PrReviewPanel.js` | reviewer editing (spec, clauses, attachments) + complete / send back |
| `components/dashboard/purchase-requisitions/PrApprovalPanel.js` | chain + approve / reject / send back |
| `components/dashboard/purchase-requisitions/PrConversation.js`, `PrTimeline.js` | comments, events |
| `components/dashboard/purchase-requisitions/PrListPage.js` | list with tabs / facets / KPIs |
| `components/dashboard/purchase-requisitions/PrQueuePage.js`, `ConvertModal.js`, `MapVariantModal.js` | buyer pool |
| `pages/dashboard/buyer/purchase-requisitions/{index,create,[prId],review,queue}.js` | routes |
| `components/dashboard/admin/approvals/PrReviewRouting.js` | category → review department mapping |
| approval-hierarchy `constants.js`, `wizard/*`, `dashboard/DashboardView.js`, `index.js` (modify) | PR flow + `min_amount` |
| `components/layout/Header/headerConfig.js`, `DashboardShell/navIcons.js`, `shared/dashboardLinks.js`, `hooks/usePendingApprovalIndicators.js`, `dashboard-components/PendingApprovalsModal.js`, `admin/shared/permissionLabels.js` (modify) | registration |
| `tests/pages/purchase-requisitions/*.test.js` | page tests |

### admin-panel (`.worktrees/purchase-req/admin-panel`)
`pages/catalog-requests/index.js`, `components/catalog-requests/index.js`, `utils/services/catalog-requests.js`, `components/layout/sidebar/menu.json` (modify).

---
## Phase A — Backend

### Task 1: Schema, permissions, roles, test shard

**Files:**
- Create: `migrations/20261013100000_pr_permissions.sql`, `migrations/20261013100000_pr_permissions.down.sql`
- Create: `migrations/20261013101000_pr_tables.sql`, `migrations/20261013101000_pr_tables.down.sql`
- Modify: `tests/setup/pendingMigrations.json` (append both, in order)
- Modify: `tests/shards.json` (add shard `pr`)
- Test: `tests/services/pr.schema.test.js`

**Interfaces:**
- Produces:
  - Tables named in spec §5.
  - Permissions `pr.{read,create,evaluate,approve,convert}`.
  - System roles `PR Requester`, `PR Technical Reviewer`, `PR Approver`, `PR Buyer` (`created_by IS NULL`).
  - Column `tbl_approval_policy_steps.min_amount NUMERIC(18,2) NULL`.

- [ ] **Step 1: Write the failing schema test** `tests/services/pr.schema.test.js`

```js
import { db } from "../setup/db.js";

const roleId = (title) => db.one(`SELECT id FROM tbl_roles WHERE title=$1 AND created_by IS NULL`, [title]).then(r => r.id);
const perms = (roleTitle) => db.map(
  `SELECT p.resource::text || '.' || p.action::text AS k
     FROM tbl_role_permissions rp JOIN tbl_permissions p ON p.id = rp.permission_id
     JOIN tbl_roles r ON r.id = rp.role_id
    WHERE r.title = $1 AND r.created_by IS NULL ORDER BY 1`, [roleTitle], r => r.k);

describe("PR schema", () => {
  it("seeds pr.* permissions and the four system roles", async () => {
    expect(await perms("PR Requester")).toEqual(["pr.create", "pr.read"]);
    expect(await perms("PR Technical Reviewer")).toEqual(["pr.evaluate", "pr.read"]);
    expect(await perms("PR Approver")).toEqual(["pr.approve", "pr.read"]);
    expect(await perms("PR Buyer")).toEqual(["pr.convert", "pr.read"]);
    const admin = await perms("Company Administrator");
    for (const k of ["pr.read","pr.create","pr.evaluate","pr.approve","pr.convert"]) expect(admin).toContain(k);
  });

  it("creates every PR table", async () => {
    const names = await db.map(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'
      AND table_name = ANY($1)`, [[
      "tbl_purchase_requisition","tbl_purchase_requisition_line","tbl_pr_line_clause","tbl_pr_attachment",
      "tbl_pr_review_category_map","tbl_pr_review","tbl_pr_review_line","tbl_pr_line_rfq",
      "tbl_pr_catalog_request","tbl_pr_comment","tbl_pr_event"]], r => r.table_name);
    expect(names.sort()).toHaveLength(11);
  });

  it("adds a nullable min_amount to policy steps", async () => {
    const c = await db.one(`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name='tbl_approval_policy_steps' AND column_name='min_amount'`);
    expect(c).toEqual({ data_type: "numeric", is_nullable: "YES" });
  });

  describe("line CHECKs", () => {
    // Each case inserts a PR + one line inside a rolled-back tx and expects a constraint error.
    const cases = [
      ["catalog line without variant", { line_kind: "catalog", product_variant_id: null, free_text_name: null }],
      ["free-text line without name", { line_kind: "free_text", product_variant_id: null, free_text_name: null }],
      ["zero quantity", { quantity: 0 }],
      ["zero price", { estimated_unit_price: 0 }],
    ];
    it.each(cases)("rejects %s", async (_n, patch) => {
      await expect(db.tx(async t => {
        const pr = await t.one(`INSERT INTO tbl_purchase_requisition
          (pr_number,title,pr_type,hospitality_company_id,hotel_id,department_id,urgency,required_by_date,justification,status,raised_by)
          VALUES ('PR-T-CHK','t','goods',10001,10101,10201,'normal',CURRENT_DATE+7,'j','draft',80011) RETURNING id`);
        const row = { line_kind: "catalog", product_variant_id: 1, free_text_name: null, quantity: 1, estimated_unit_price: 1, ...patch };
        await t.none(`INSERT INTO tbl_purchase_requisition_line
          (pr_id,line_no,line_kind,product_variant_id,free_text_name,category_id,quantity,uom,estimated_unit_price)
          VALUES ($1,1,$2,$3,$4,1,$5,'nos',$6)`,
          [pr.id, row.line_kind, row.product_variant_id, row.free_text_name, row.quantity, row.estimated_unit_price]);
        throw new Error("ROLLBACK_SENTINEL_NOT_REACHED");
      })).rejects.toThrow(/violates check constraint/);
    });
  });
});
```

- [ ] **Step 2: Add the shard and run the test to verify it fails**

  Add to `tests/shards.json` `shards` (before `arc-core`):

  ```json
  { "name": "pr", "pattern": "tests/services/pr\\.", "description": "Purchase Requisitions: drafts, review, approval, buyer pool, conversion, catalog requests" }
  ```

  Then run `npm run test:shards` (expected: OK) and `npm test -- --testPathPatterns "tests/services/pr\.schema"`. Expected: FAIL (roles and tables missing).

- [ ] **Step 3: Write `migrations/20261013100000_pr_permissions.sql`**

```sql
-- Purchase Requisitions: the `pr` RBAC resource, a new `convert` action, and four system roles.
-- Two transactions: Postgres refuses to use an enum value in the transaction that added it.
BEGIN;
ALTER TYPE public.resource_type ADD VALUE IF NOT EXISTS 'pr';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'convert';
COMMIT;

BEGIN;
INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT 'pr'::public.resource_type, v.action::public.permission_action_type, v.ordering
  FROM (VALUES ('read',200),('create',201),('evaluate',202),('approve',203),('convert',204)) AS v(action, ordering)
 WHERE NOT EXISTS (SELECT 1 FROM public.tbl_permissions p
                    WHERE p.resource = 'pr'::public.resource_type
                      AND p.action = v.action::public.permission_action_type);

INSERT INTO public.tbl_roles (title, description, created_by)
SELECT v.title, v.descr, NULL
  FROM (VALUES
    ('PR Requester',          'Raise purchase requisitions for a hotel/department'),
    ('PR Technical Reviewer', 'Technical review of purchase requisition lines for a department'),
    ('PR Approver',           'Approve purchase requisitions'),
    ('PR Buyer',              'Purchase team: purchase requisition queue, mapping and conversion to RFQ')
  ) AS v(title, descr)
 WHERE NOT EXISTS (SELECT 1 FROM public.tbl_roles r WHERE r.title = v.title AND r.created_by IS NULL);

INSERT INTO public.tbl_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM (VALUES
    ('PR Requester','read'),('PR Requester','create'),
    ('PR Technical Reviewer','read'),('PR Technical Reviewer','evaluate'),
    ('PR Approver','read'),('PR Approver','approve'),
    ('PR Buyer','read'),('PR Buyer','convert'),
    ('Company Administrator','read'),('Company Administrator','create'),('Company Administrator','evaluate'),
    ('Company Administrator','approve'),('Company Administrator','convert')
  ) AS g(title, action)
  JOIN public.tbl_roles r ON r.title = g.title AND r.created_by IS NULL
  JOIN public.tbl_permissions p ON p.resource = 'pr'::public.resource_type
                               AND p.action = g.action::public.permission_action_type
 WHERE NOT EXISTS (SELECT 1 FROM public.tbl_role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);
COMMIT;
```

  `…_pr_permissions.down.sql`: delete `tbl_role_permissions` joined to `pr` permissions, then the `pr` permissions, then the four roles (only if no `tbl_user_role_scopes` row references them; otherwise `RAISE NOTICE` and keep them). The enum labels stay; see the reports `.down.sql` comment for why.

- [ ] **Step 4: Write `migrations/20261013101000_pr_tables.sql`**

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_purchase_requisition (
  id                      SERIAL PRIMARY KEY,
  pr_number               VARCHAR(32) NOT NULL UNIQUE,
  title                   VARCHAR(200) NOT NULL,
  pr_type                 VARCHAR(16) NOT NULL DEFAULT 'goods' CHECK (pr_type IN ('goods','service','capex')),
  hospitality_company_id  INTEGER NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  hotel_id                INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  department_id           INTEGER NOT NULL REFERENCES public.tbl_department(id),
  process_id              INTEGER NULL,
  urgency                 VARCHAR(8) NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','urgent')),
  required_by_date        DATE NOT NULL,
  justification           TEXT NOT NULL CHECK (length(btrim(justification)) > 0),
  delivery_location       TEXT,
  status                  VARCHAR(20) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','in_review','pending_approval','returned','approved','rejected','cancelled')),
  revision                INTEGER NOT NULL DEFAULT 0,
  estimated_total         NUMERIC(18,2),
  raised_by               INTEGER NOT NULL REFERENCES public.tbl_users(id),
  submitted_at            TIMESTAMPTZ,
  approved_at             TIMESTAMPTZ,
  approval_instance_id    INTEGER,
  assigned_buyer_id       INTEGER REFERENCES public.tbl_users(id),
  assigned_at             TIMESTAMPTZ,
  returned_note           TEXT,
  cancelled_reason        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_company_status ON public.tbl_purchase_requisition (hospitality_company_id, status);
CREATE INDEX IF NOT EXISTS idx_pr_hotel_dept ON public.tbl_purchase_requisition (hotel_id, department_id);
CREATE INDEX IF NOT EXISTS idx_pr_raised_by ON public.tbl_purchase_requisition (raised_by);

CREATE TABLE IF NOT EXISTS public.tbl_purchase_requisition_line (
  id                    SERIAL PRIMARY KEY,
  pr_id                 INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  line_no               INTEGER NOT NULL,
  line_kind             VARCHAR(10) NOT NULL CHECK (line_kind IN ('catalog','free_text')),
  product_variant_id    INTEGER REFERENCES public.tbl_product_variant(id),
  free_text_name        VARCHAR(300),
  category_id           INTEGER NOT NULL REFERENCES public.tbl_category(id),
  quantity              NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  uom                   VARCHAR(50) NOT NULL CHECK (length(btrim(uom)) > 0),
  estimated_unit_price  NUMERIC(18,2) NOT NULL CHECK (estimated_unit_price > 0),
  specification         TEXT,
  suggested_vendor_note TEXT,
  status                VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','closed')),
  close_reason          TEXT,
  closed_by             INTEGER REFERENCES public.tbl_users(id),
  closed_at             TIMESTAMPTZ,
  mapped_variant_id     INTEGER REFERENCES public.tbl_product_variant(id),
  mapped_by             INTEGER REFERENCES public.tbl_users(id),
  mapped_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pr_id, line_no),
  CONSTRAINT chk_pr_line_kind_shape CHECK (
    (line_kind = 'catalog'   AND product_variant_id IS NOT NULL AND free_text_name IS NULL AND mapped_variant_id IS NULL) OR
    (line_kind = 'free_text' AND product_variant_id IS NULL AND free_text_name IS NOT NULL AND length(btrim(free_text_name)) > 0)
  ),
  CONSTRAINT chk_pr_line_closed_reason CHECK (status <> 'closed' OR (close_reason IS NOT NULL AND length(btrim(close_reason)) > 0))
);
CREATE INDEX IF NOT EXISTS idx_pr_line_pr ON public.tbl_purchase_requisition_line (pr_id);
CREATE INDEX IF NOT EXISTS idx_pr_line_variant ON public.tbl_purchase_requisition_line (COALESCE(product_variant_id, mapped_variant_id));

CREATE TABLE IF NOT EXISTS public.tbl_pr_line_clause (
  id          SERIAL PRIMARY KEY,
  pr_line_id  INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  clause_text TEXT NOT NULL CHECK (length(btrim(clause_text)) > 0),
  clause_type VARCHAR(30) NOT NULL DEFAULT 'mandatory',
  weightage   NUMERIC(6,2),
  added_by    INTEGER NOT NULL REFERENCES public.tbl_users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_attachment (
  id          SERIAL PRIMARY KEY,
  pr_id       INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  pr_line_id  INTEGER REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  kind        VARCHAR(10) NOT NULL CHECK (kind IN ('spec','datasheet','qap','other')),
  file_url    TEXT NOT NULL,
  file_name   VARCHAR(300),
  uploaded_by INTEGER NOT NULL REFERENCES public.tbl_users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_review_category_map (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INTEGER NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  category_id            INTEGER NOT NULL REFERENCES public.tbl_category(id),
  department_id          INTEGER NOT NULL REFERENCES public.tbl_department(id),
  created_by             INTEGER NOT NULL REFERENCES public.tbl_users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hospitality_company_id, category_id)
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_review (
  id             SERIAL PRIMARY KEY,
  pr_id          INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL,
  department_id  INTEGER NOT NULL REFERENCES public.tbl_department(id),
  status         VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','sent_back','superseded')),
  acted_by       INTEGER REFERENCES public.tbl_users(id),
  acted_at       TIMESTAMPTZ,
  note           TEXT,
  self_reviewed  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pr_id, revision, department_id),
  CONSTRAINT chk_pr_review_sendback_note CHECK (status <> 'sent_back' OR (note IS NOT NULL AND length(btrim(note)) > 0))
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_review_line (
  review_id  INTEGER NOT NULL REFERENCES public.tbl_pr_review(id) ON DELETE CASCADE,
  pr_line_id INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  PRIMARY KEY (review_id, pr_line_id)
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_line_rfq (
  id             SERIAL PRIMARY KEY,
  pr_line_id     INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  rfq_id         INTEGER NOT NULL REFERENCES public.tbl_rfq(id) ON DELETE CASCADE,
  rfq_product_id INTEGER NOT NULL REFERENCES public.tbl_rfq_products(id) ON DELETE CASCADE,
  quantity       NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  converted_by   INTEGER NOT NULL REFERENCES public.tbl_users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_line_rfq_line ON public.tbl_pr_line_rfq (pr_line_id);
CREATE INDEX IF NOT EXISTS idx_pr_line_rfq_rfq ON public.tbl_pr_line_rfq (rfq_id);

CREATE TABLE IF NOT EXISTS public.tbl_pr_catalog_request (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INTEGER NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  pr_line_id             INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  requested_name         VARCHAR(300) NOT NULL,
  description            TEXT,
  category_id            INTEGER REFERENCES public.tbl_category(id),
  status                 VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','rejected')),
  requested_by           INTEGER NOT NULL REFERENCES public.tbl_users(id),
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by            INTEGER,
  resolved_at            TIMESTAMPTZ,
  resolution_note        TEXT,
  resolved_variant_id    INTEGER REFERENCES public.tbl_product_variant(id),
  CONSTRAINT chk_pr_catreq_resolution CHECK (
    (status = 'open') OR (status = 'fulfilled' AND resolved_variant_id IS NOT NULL) OR
    (status = 'rejected' AND resolution_note IS NOT NULL AND length(btrim(resolution_note)) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_catreq_open_per_line ON public.tbl_pr_catalog_request (pr_line_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.tbl_pr_comment (
  id         SERIAL PRIMARY KEY,
  pr_id      INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES public.tbl_users(id),
  body       TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_comment_pr ON public.tbl_pr_comment (pr_id, created_at);

CREATE TABLE IF NOT EXISTS public.tbl_pr_event (
  id          BIGSERIAL PRIMARY KEY,
  pr_id       INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  pr_line_id  INTEGER,
  revision    INTEGER NOT NULL DEFAULT 0,
  actor_id    INTEGER,
  event_type  VARCHAR(40) NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_event_pr ON public.tbl_pr_event (pr_id, id);

ALTER TABLE public.tbl_approval_policy_steps ADD COLUMN IF NOT EXISTS min_amount NUMERIC(18,2) NULL;

COMMIT;
```

  `.down.sql`: `DROP TABLE IF EXISTS` in reverse dependency order, then `ALTER TABLE tbl_approval_policy_steps DROP COLUMN IF EXISTS min_amount`.

- [ ] **Step 5: Append both files to `tests/setup/pendingMigrations.json`** (after `20261006100000_vendor_networks.sql`). Then run `npm test -- --testPathPatterns "tests/services/pr\.schema"`. Expected: PASS (all 8 tests).

  If the test DB template is cached, follow the instructions printed by `tests/setup/prepareTestDb.js`, or run `npm run test:cleanup` and retry. Check whether `tbl_hospitality_company_hotels.is_deleted` exists and whether `tbl_category`/`tbl_product_variant` ids are `integer`; match the FK types to `tests/setup/schema.sql`.

- [ ] **Step 6: Apply to a scratch DB to prove idempotency.** Run each migration twice against the test DB with `psql -v ON_ERROR_STOP=1`, then run the `.down.sql` and the up again. Expected: no errors.

- [ ] **Step 7: Commit** — `feat(pr): schema, pr.* permissions, system roles, test shard`.

---

### Task 2: Approval engine — PR entity, min-amount steps, separation of duties, strict steps

**Files:**
- Create: `app/services/approval/approvalEntityRules.js`
- Modify: `app/models/generalModel.js`:
  - `ENTITY_APPROVE_RESOURCE_MAP` (~:9-138): add `'PR': 'pr'`
  - `insertPolicySteps` (~:2031-2073)
  - `resolveApprovers` callers inside `createApprovalInstance` (~:2404-2960) and the call at ~:3119
- Modify: `app/services/approvalPropagationService.js`:
  - `computePolicyStepDiff` (~:270)
  - re-resolve sites ~:968, ~:1178, ~:1973, ~:2112
  - `IDENTIFIER_KEYS_BY_ENTITY` (~:211)
- Modify: `app/controllers/general/generalController.js:1022-1026`: add `'MR'` and `'PR'` to `validEntityTypes`
- Test: `tests/services/approval.prRules.test.js` (shard `security-approval`, matches `approval`)

**Interfaces:**
- Produces, in `approvalEntityRules.js`:

```js
// Entity types whose initiator may never approve their own instance (spec §7 SoD).
export const SOD_EXCLUDE_INITIATOR = new Set(['PR']);
// Entity types whose policy steps honour min_amount.
export const AMOUNT_GATED = new Set(['PR']);
export const excludesInitiator = (entityType) => SOD_EXCLUDE_INITIATOR.has(String(entityType || '').toUpperCase());
// A step applies when it has no threshold, the entity is not amount-gated, or amount >= min_amount.
// Compare as fixed-point paise (integers) to avoid float error: toPaise('1250000.75') === 125000075n.
export function toPaise(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid money value: ${s}`);
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2)) * (s.startsWith('-') ? -1n : 1n);
}
export function stepAppliesAtAmount(entityType, step, amount) {
  if (!AMOUNT_GATED.has(String(entityType || '').toUpperCase())) return true;
  if (step.min_amount === null || step.min_amount === undefined) return true;
  if (amount === null || amount === undefined) return true; // amount unknown → never silently drop a step
  return toPaise(amount) >= toPaise(step.min_amount);
}
// Remove the initiator from a resolved approver id list when SoD applies.
export function filterInitiator(entityType, approverIds, initiatedBy) {
  if (!excludesInitiator(entityType) || !initiatedBy) return approverIds;
  return approverIds.filter(id => Number(id) !== Number(initiatedBy));
}
```

- Produces, the `createApprovalInstance` contract (new optional params):
  - `amount` (string|number|null) is stored as `metadata.amount` (string).
  - `strictSteps` (bool):
    - When true, any *applicable* step resolving to zero approvers (before the SoD filter) throws `Object.assign(new Error('...'), { code: 'APPROVAL_STEP_UNRESOLVED', httpStatus: 422, step_order })`.
    - A step that resolves **only** to the initiator under SoD is skipped and recorded in `metadata.approval_diagnostics` as `{ step_order, reason: 'sod_self' }`.
    - If no step remains, it throws `{ code: 'APPROVAL_NO_INDEPENDENT_APPROVER', httpStatus: 422 }`.
  - Steps with `min_amount` above `amount` are dropped before instance-step creation and recorded as `{ step_order, reason: 'below_threshold', min_amount }`.
  - For SoD entity types the initiator is **never** inserted as an approver and never auto-approved.
  - Behaviour for every other entity type is unchanged. Prove it with the existing `security-approval` shard.

- [ ] **Step 1: Write the failing tests** `tests/services/approval.prRules.test.js`

  Use `IDS` fixtures: `HC=IDS.hospitality.A`, `HOTEL=IDS.hotels.A1`, `DEPT=IDS.departments.eng`, `REQ=IDS.users.a1_eng_buyer`, `A1=IDS.users.a1_proc_commApp`, `A2=IDS.users.a1_proc_finance`. Make A1 and A2 approvable via `ensureApprovable(db, [A1, A2, REQ], 'pr', HC, HOTEL, DEPT)`; add `"pr": 89308` to `ROLE_ID_BY_RESOURCE` in `tests/helpers/arcApproverPerms.js`. Create the policy directly (`entity_type 'PR'`, hotel `HOTEL`, `department_id NULL`) with USER steps. Call the production `createApprovalInstance` from `app/models/generalModel.js` with `entity_type:'PR', entity_id: <synthetic id 990000+n>, initiated_by: REQ, amount, strictSteps:true`. Clean up instances/actions/steps/policy in `afterEach` by tracked ids.

  Tests (each `it` asserts DB rows of `tbl_approval_instance_steps` / `tbl_approval_step_approvers` / instance `status` and `metadata`):
  1. `below_threshold`: steps `[A1 (min null), A2 (min 50000.00)]`, amount `'49999.99'` → one instance step (A1); metadata diagnostics contains `{step_order:2, reason:'below_threshold'}`.
  2. `threshold.boundary-exact`: same policy, amount `'50000.00'` → two steps. Amount `'12500000.75'` with min `'12500000.75'` → applies; min `'12500000.76'` → dropped.
  3. `sod.requester-never-approver`: steps `[REQ+A1 via ROLE that both hold]`. Grant via `grantRoleScope` and role 89308 for a ROLE step → `tbl_approval_step_approvers` contains A1 only. No APPROVE action by REQ. Instance `PENDING`.
  4. `sod.self-only-step-skipped`: steps `[USER REQ, USER A1]` → instance has one step (A1); diagnostics `{step_order:1, reason:'sod_self'}`; status `PENDING`.
  5. `sod.no-independent`: steps `[USER REQ]` → rejects with `code 'APPROVAL_NO_INDEPENDENT_APPROVER'`; no instance row was written (count by `entity_id`).
  6. `strict.unresolved`: steps `[ROLE <a role nobody holds in scope>, USER A1]` → rejects with `code 'APPROVAL_STEP_UNRESOLVED', step_order: 1`.
  7. `non-PR unchanged`: same SoD-shaped policy with `entity_type 'MR'`, initiator `REQ` as sole approver → existing behaviour (auto-approved, `autoApproved:true`). This guards against regressions.
  8. `propagation.no-readd`: create a PR instance (steps `[ROLE 89308]`; holders REQ and A1). Grant REQ a second scope and call `revalidateApproverMembership({ userId: REQ, ... })` (production function). REQ is still absent from step approvers. Then edit the policy step (`computePolicyStepDiff` + `propagatePolicyChangeToInstances`) and assert REQ is absent.
  9. `propagation.min_amount-diff`: `computePolicyStepDiff([{step_order:1,approver_source_type:'USER',approver_source_id:A1,decision_rule:'ANY',min_amount:null}], [{...same, min_amount:'1000.00'}])` reports a modification for step 1.
  10. `policy upsert accepts PR and MR`: `POST /api/v1/general/hospitality/approval/policies` as `IDS.users.companyA_admin` with `entity_type:'PR'` and a step `min_amount:'25000'` → 200; DB step row has `min_amount = 25000.00`. The same with `'MR'` → 200.

- [ ] **Step 2: Run them to verify they fail** — `npm test -- --testPathPatterns "approval\.prRules"`. Expected: FAIL (the resource map throws `ENTITY_TYPE_NOT_IN_RESOURCE_MAP`, etc.).

- [ ] **Step 3: Implement**
  1. Create `approvalEntityRules.js` exactly as above.
  2. In `ENTITY_APPROVE_RESOURCE_MAP` add `'PR': 'pr'`.
  3. In `createApprovalInstance` destructure `amount = null, strictSteps = false`. Put `amount: amount === null ? null : String(amount)` into the metadata object that is inserted.
  4. Before the step-resolution loop, filter `policySteps` with `stepAppliesAtAmount(entity_type, s, amount)`. Push `below_threshold` diagnostics for the dropped steps. Keep `step_order` values; existing code renumbers or uses the order, so verify `current_step` semantics stay consistent.
  5. In the loop, after `resolveApprovers(...)`:
     - `const raw = approverUserIds;`
     - `if (strictSteps && raw.length === 0) throw unresolved(step)`.
     - `const ids = filterInitiator(entity_type, raw, initiated_by);`
     - If `ids.length === 0 && raw.length > 0 && excludesInitiator(entity_type)`, skip the step with a `sod_self` diagnostic.
     - Use `ids` from here on.
  6. In the initiator auto-approve block (~:2837-2881), guard with `if (!excludesInitiator(entity_type))`.
  7. After the loop, if `excludesInitiator(entity_type)` and no surviving steps remain, throw `APPROVAL_NO_INDEPENDENT_APPROVER` before any INSERT. Check the insert order and move the guard so no instance row is written.
  8. In `approvalPropagationService.js`, at each of the 4 re-resolve sites, apply `filterInitiator(instance.entity_type, resolvedIds, instance.initiated_by)` (select `entity_type, initiated_by` where the row is loaded if missing). Where steps are **added** by propagation (`STEP_ADDED` path), skip added steps for which `stepAppliesAtAmount(instance.entity_type, newStep, instance.metadata?.amount)` is false.
  9. Delegation: `resolveApprovers` applies delegations last. Because filtering happens on its output, a delegate equal to the initiator is removed too. Add a test for this in Step 1, as test 11 `sod.delegation`: A1 delegates to REQ via `tbl_approval_delegations` (use the production create-delegation function; locate it with `grep -n "delegat" app/models/generalModel.js`) → REQ is not an approver.
  10. In `computePolicyStepDiff`, treat a differing `min_amount` (compare via `toPaise`, null-safe) as a modify.
  11. In `insertPolicySteps`, add `min_amount` to the column list and values (`step.min_amount ?? null`; validate with `toPaise` and reject negatives with a 400 in `upsertApprovalPolicy`).
  12. In `generalController.js` `validEntityTypes`, add `'MR', 'PR'`.

- [ ] **Step 4: Run the tests** — `npm test -- --testPathPatterns "approval\.prRules"`. Expected: PASS (11 tests). Then run the whole `security-approval` shard (`npm test -- --testPathPatterns "tests/services/(security\.|approval|authorizationService|rbac\.|userRoleScope\.|hospitality\.|arc\.approvers)"`) and the `arc-mr` shard. Expected: all green, the same as the baseline at `/tmp/preq/baseline/summary.txt`.

- [ ] **Step 5: Commit** — `feat(approval): PR entity — min-amount steps, initiator exclusion, strict steps`.

---
### API surface (all under `/api/v1/pr`, `passportSignIn` + `acl([2, 8])`; static paths registered before `/:id`)

| Method & path | Who | Task |
|---|---|---|
| `GET /form/hotels`, `GET /form/departments?hotel_id=` | holders of `pr.create` | 3 |
| `GET /search-items?hotel_id=&department_id=&q=` | `pr.create` on the cell | 3 |
| `GET /categories?q=` | any buyer | 3 |
| `POST /` (create draft), `GET /:id`, `PUT /:id` (replace draft), `POST /:id/cancel`, `POST /:id/copy` | requester | 3 |
| `GET /` (list), `GET /kpis`, `GET /duplicates?hotel_id=&variant_id=` | readers | 4 |
| `GET /admin/review-routing`, `POST /admin/review-routing`, `DELETE /admin/review-routing/:mapId` | company admin | 5 |
| `POST /routing-preview` (body: hotel, department, lines); `GET /:id/routing-preview` | `pr.create` on the cell / readers | 5 |
| `POST /:id/submit`, `POST /:id/withdraw` | requester | 6 |
| `GET /review-queue`; `POST /:id/reviews/:reviewId/complete`; `POST /:id/reviews/:reviewId/send-back` | `pr.evaluate` | 7 |
| `PUT /:id/lines/:lineId/specification`; `POST/DELETE /:id/lines/:lineId/clauses[/:clauseId]` | reviewer of the line's group | 7 |
| `POST/DELETE /:id/attachments[/:attId]` | requester (draft/returned) or reviewer (own lines, in_review) | 7 |
| `POST /:id/send-back` | pending approver of the current step | 6 |
| `GET /pool`, `GET /buyers?hotel_id=`, `POST /:id/assign`, `POST /:id/lines/:lineId/map`, `POST /:id/lines/:lineId/catalog-request`, `POST /:id/lines/:lineId/close` | `pr.convert` on the PR hotel | 8 |
| `POST /:id/lines/:lineId/cancel` | requester (approved, not converted) | 8 |
| `POST /convert` | `pr.convert` + `rfq.create` | 9 |
| `POST /:id/comments` | readers | 11 |
| `GET/POST /api/v1/admin/pr-catalog-requests…` | platform admin (`jwtAdm`) | 10 |

### Task 3: PR foundation — errors, events, access, draft CRUD, pickers

**Files:**
- Create: `app/services/pr/prErrors.js`, `app/services/pr/prEvents.js`, `app/services/pr/prAccess.js`, `app/services/pr/prCatalog.js`, `app/models/pr/prModel.js`, `app/controllers/pr/prController.js`, `app/routes/pr/index.js`
- Modify: `app/routes/index.js` (import + `v1.use('/pr', PrRoutes);` after `/mr`)
- Create: `tests/helpers/prFixtures.js`
- Test: `tests/services/pr.draft.test.js`

**Interfaces:**
- Produces, in `prErrors.js`:

```js
export const PR_ERR = Object.freeze({
  STATE_CONFLICT: ['PR_STATE_CONFLICT', 409],
  NOT_FOUND: ['PR_NOT_FOUND', 404],
  FORBIDDEN: ['PR_FORBIDDEN', 403],
  VALIDATION: ['PR_VALIDATION', 422],
  LINE_ON_CONTRACT: ['PR_LINE_ON_CONTRACT', 422],
  VARIANT_NOT_USABLE: ['PR_VARIANT_NOT_USABLE', 422],
  NO_POLICY: ['PR_NO_POLICY', 422],
  STEP_UNRESOLVED: ['PR_STEP_UNRESOLVED', 422],
  NO_INDEPENDENT_APPROVER: ['PR_NO_INDEPENDENT_APPROVER', 422],
  NO_REVIEWER: ['PR_NO_REVIEWER', 422],
  LINE_NOT_CONVERTIBLE: ['PR_LINE_NOT_CONVERTIBLE', 409],
  UNIT_MISMATCH: ['PR_UNIT_MISMATCH', 422],
  HOTEL_MISMATCH: ['PR_HOTEL_MISMATCH', 422],
});
export class PrError extends Error {
  constructor([code, httpStatus], message, details) { super(message); this.code = code; this.httpStatus = httpStatus; this.details = details; }
}
export const prError = (kind, message, details) => new PrError(kind, message, details);
export function sendPrError(res, err, logger) {
  if (err instanceof PrError) return res.status(err.httpStatus).json({ status: 0, code: err.code, message: err.message, details: err.details });
  logger?.error?.({ err }, '[PR] unexpected error');
  return res.status(500).json({ status: 3, code: 'PR_INTERNAL', message: 'Something went wrong' });
}
```

- Produces, in `prEvents.js`: `export async function record(t, { prId, lineId = null, revision = 0, actorId = null, type, payload = {} })`, which inserts into `tbl_pr_event`. Event types used across tasks: `created, updated, submitted, review_created, review_completed, self_reviewed, review_sent_back, review_superseded, spec_edited, clause_added, clause_removed, attachment_added, attachment_removed, approval_started, approval_sent_back, approved, rejected, withdrawn, cancelled, copied_from, assigned, line_mapped, catalog_requested, catalog_fulfilled, catalog_rejected, line_closed, line_cancelled, converted, comment_added`.
- Produces, in `prAccess.js`:
  - `hasPerm(userId, perm, {companyId, hotelId, departmentId}, t)` → bool. It uses `authorizationService.assertUserHasScope` (`'pr.create'` etc.) and catches `isAuthorizationError` → false.
  - `assertPerm(userId, perm, cell, t)` → throws `prError(PR_ERR.FORBIDDEN, ...)`.
  - `canReadPr(user, pr, t)` → bool, true when any of these holds:
    - `user_type === 8`;
    - the user is the requester;
    - `pr.read` on (company, hotel, department);
    - `pr.evaluate` on (company, hotel, d) for any `d` in the PR's review departments of any revision;
    - the user is a step approver on `pr.approval_instance_id`;
    - `pr.convert` on (company, hotel, any department).
  - `readableScopeSql(userId, alias, paramOffset)` → `{ clause, params }`: the same rule set as SQL for lists (an EXISTS over `tbl_user_role_scopes` + `tbl_role_permissions` + `tbl_permissions`, plus `raised_by = $user`). A list must never answer a wider question than a point read.
- Produces, in `prCatalog.js`:
  - `variantCategoryId(variantId, t)` → the category id from `tbl_product_categories` of the variant's product (the first by `category_id` asc), or `null`.
  - `isUsableVariant(variantId, t)` → bool, using the RFQ predicate `p.status=1 AND p.is_deleted=0 AND p.is_review=0 AND p.is_approve=1 AND pv.is_approve=1` (copy from `rfqModel.searchProduct`).
  - `contractCoverage({ hotelId, departmentId, variantIds }, t)` → `Map<variantId, {arc_contract_id, arc_number}>` using the `mrModel.searchContractedItems` predicate (active/expiring_soon contract, matching ARC department, hotel or group-line hotel not suspended, remaining qty > 0). **Re-use** that SQL by extracting it into an exported helper in `mrModel` (`contractedVariantPredicateSql`) rather than copying it. Keep MR behaviour identical; the `arc-mr` shard must stay green.
- Produces, in `prModel.js`:
  - `nextPrNumber(t)` → `'PR-' + YYYY + '-' + base36(seq)`, mirroring `generateMrNumber` (`mrController.js:194`).
  - `insertPr(t, header)`, `replaceLines(t, prId, lines)`, `updateHeader(t, prId, patch)`, `lockPr(t, prId)` (`SELECT * … FOR UPDATE`), `getPrRow(prId, t)`.
  - `getDetail(prId, t)` → `{ pr, lines[] (with clauses[], attachments[], progress, links[]), reviews[], events[], comments[] }`.
  - `LINE_PROGRESS_SQL` (below) and `estimateTotalSql`.

```js
// Derived line progress — single source of truth (spec §4.2). `l` = line alias, `p` = PR alias.
// Live link = RFQ product still exists (FK cascade) AND (RFQ not closed/withdrawn OR a live PO exists for it).
export const LIVE_PO_EXISTS = (lk) => `EXISTS (
  SELECT 1 FROM tbl_rfq_purchase_order po_l
    JOIN tbl_purchase_order_product pop_l ON pop_l.purchase_order_id = po_l.id
   WHERE po_l.rfq_id = ${lk}.rfq_id AND pop_l.rfq_product_id = ${lk}.rfq_product_id
     AND po_l.status NOT IN ('rejected','rejected_by_vendor','cancelled','draft'))`;
export const LIVE_LINK_EXISTS = (l) => `EXISTS (
  SELECT 1 FROM tbl_pr_line_rfq lk JOIN tbl_rfq r ON r.id = lk.rfq_id
   WHERE lk.pr_line_id = ${l}.id AND (r.status NOT IN (2,5) OR ${LIVE_PO_EXISTS('lk')}))`;
export const LINE_PROGRESS_SQL = (l, p) => `CASE
  WHEN ${l}.status = 'cancelled' THEN 'cancelled'
  WHEN ${l}.status = 'closed' THEN 'closed'
  WHEN ${p}.status <> 'approved' THEN 'pending'
  WHEN EXISTS (SELECT 1 FROM tbl_pr_line_rfq lk WHERE lk.pr_line_id = ${l}.id AND ${LIVE_PO_EXISTS('lk')}) THEN 'ordered'
  WHEN ${LIVE_LINK_EXISTS(l)} THEN 'in_sourcing'
  WHEN ${l}.line_kind = 'free_text' AND ${l}.mapped_variant_id IS NULL
       AND EXISTS (SELECT 1 FROM tbl_pr_catalog_request cr WHERE cr.pr_line_id = ${l}.id AND cr.status = 'open') THEN 'awaiting_catalog'
  WHEN ${l}.line_kind = 'free_text' AND ${l}.mapped_variant_id IS NULL THEN 'needs_mapping'
  ELSE 'in_pool' END`;
```

- Produces, in `tests/helpers/prFixtures.js`:
  - `prRoleId(title)`.
  - `grantPr(userId, roleTitle, { companyId=IDS.hospitality.A, hotelId=IDS.hotels.A1, departmentId=null })`: uses `grantRoleScope` and returns the scope row id for cleanup.
  - `revokeAllPr(userIds)`.
  - `makePrPolicy({ hotelId=null, steps:[{ source:'USER'|'ROLE', id, rule='ANY', min_amount=null }] })` → policyId.
  - `dropPrPolicies()`: deletes `entity_type='PR'` policies created by tests (tracked ids).
  - `draftBody(overrides)`: a valid create payload with one catalog line (variant from `firstUsableVariant()`) and one free-text line.
  - `firstUsableVariant()` → `{ variant_id, category_id }` queried with the usable predicate.
  - `cleanupPrs(prIds)`: deletes approval instances/actions for `entity_type 'PR'` and those entity ids, then the PRs (cascade).
  - `mapCategory(companyId, categoryId, departmentId)`, `unmapAll(companyId)`.

- [ ] **Step 1: Write the failing tests** `tests/services/pr.draft.test.js`. Personas:
  - `REQ = a1_eng_buyer`: granted `PR Requester` at (A, A1, eng).
  - `OTHER = a1_proc_buyer`: no PR role.
  - `XCO = companyB_admin`: another company.

  Tests:
  1. `create.ok`: `POST /api/v1/pr` with `draftBody()` → 200 `{status:1, data:{id, pr_number}}`. In the DB:
     - status `draft`, revision 0;
     - lines `line_no` 1..2;
     - the catalog line's `category_id` equals `firstUsableVariant().category_id` even though the client sent a different `category_id` (server derives it);
     - `estimated_total` is NULL (computed at submit);
     - an event `created` exists.
  2. `create.forbidden-cell`: OTHER creates for (A1, eng) → 403 `PR_FORBIDDEN`. REQ creates for (A1, proc) → 403.
  3. `create.cross-tenant-ids`: REQ sends `hotel_id = IDS.hotels.B1` → 403. A variant id that doesn't exist → 422 `PR_VALIDATION`. A free-text line with a `category_id` that doesn't exist → 422.
  4. `create.validation`, each → 422 `PR_VALIDATION` with `details` naming the field:
     - empty title; empty justification; `required_by_date` in the past (IST date);
     - 0 lines; more than 200 lines;
     - quantity `0`, `-1` or `'abc'`; quantity with 4 decimals;
     - price with 3 decimals; price above 99999999999999.99;
     - uom empty;
     - a line with both a variant and a free-text name.
  5. `create.fractional`: quantity `'0.5'`, price `'1250000.75'` → stored exactly (`quantity::text = '0.500'`, `estimated_unit_price::text = '1250000.75'`).
  6. `create.on-contract-blocked`: seed an active ARC contract for the variant at (A1, eng), using the `mr.flow.test.js` seeding shape but with department eng → 422 `PR_LINE_ON_CONTRACT`, `details[0].line_no = 1` and `arc_number` set.
  7. `create.unusable-variant`: set the variant's `is_approve=0` temporarily (restore in `finally`) → 422 `PR_VARIANT_NOT_USABLE`.
  8. `get.detail`: REQ `GET /pr/:id` → the lines carry `progress:'pending'` and the events list. OTHER → 404 `PR_NOT_FOUND` (don't leak existence). XCO → 404.
  9. `update.replace`: `PUT /pr/:id` with 1 changed line → lines replaced (line_no restarts at 1); an `updated` event carries a header diff.
  10. `update.after-submit` (Review Focus 3): set status `in_review` directly in the DB → PUT → 409 `PR_STATE_CONFLICT`; lines unchanged.
  11. `update.not-owner`: another user with `PR Requester` on the same cell → 404 (only the requester edits).
  12. `cancel`: from draft with a reason → status `cancelled`, `cancelled_reason`; cancelling again → 409.
  13. `copy`: `POST /pr/:id/copy` (works from any terminal or non-terminal status) → a new draft with the same header (`required_by_date` reset if in the past), lines copied (catalog + free text, without mapping/status), clauses and attachments **not** copied; event `copied_from` on the new PR referencing the old `pr_number`.
  14. `form pickers`: `/form/hotels` returns A1 only for REQ; `/form/departments?hotel_id=A1` returns eng only. With `hotel_id=B1` → 403.
  15. `search-items`: `/search-items?hotel_id=A1&department_id=eng&q=<2+ chars of the variant name>` → rows include `{variant_id, variant_name, product_name, category_id, on_contract:false}`. With the contract from test 6 → `on_contract:true, arc_number`.
  16. `categories`: `/categories?q=` returns active, non-deleted categories `{id, title, parent_id}` (limit 50).

- [ ] **Step 2: Run** — `npm test -- --testPathPatterns "pr\.draft"`. Expected: FAIL (404 route).

- [ ] **Step 3: Implement**
  - **Validation:** use a plain validator in the controller (`validateDraftBody(body) → {header, lines, errors[]}`) and return all errors at once.
    - Decimal regexes: quantity `^\d{1,15}(\.\d{1,3})?$`, price `^\d{1,16}(\.\d{1,2})?$`, positive.
    - Dates are compared to the IST date: `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`.
    - Keep money as strings into SQL.
  - **Create:**
    1. `db.tx`.
    2. Derive `hospitality_company_id` from the hotel (`tbl_hospitality_company_hotels`).
    3. `assertPerm(user, 'pr.create', cell)`.
    4. Validate the department exists.
    5. For catalog lines: `isUsableVariant`, `variantCategoryId` (422 if null), `contractCoverage` → 422.
    6. For free-text lines: the category exists, `status=1`, `is_deleted=0`.
    7. Insert the header and lines, then `record(created)`.
  - **Update:** `lockPr` → requester only → status in (`draft`, `returned`) else 409 → same validations → `replaceLines` (DELETE + INSERT inside the tx) → event `updated` with the changed header keys.
  - **getById:** load the row, `canReadPr`, else 404. Return `getDetail` plus `capabilities` (computed booleans for the FE): `{can_edit, can_submit, can_withdraw, can_cancel, can_copy}`. Later tasks extend `capabilities` (`can_review:{reviewId}`, `can_approve`, `can_send_back`, `can_convert`…).
  - **Routes file:** follow `app/routes/mr/index.js`; every handler wraps errors via `sendPrError`.

- [ ] **Step 4: Run** `npm test -- --testPathPatterns "pr\.draft"`. Expected: PASS. Also run the `arc-mr` shard (the extracted contract predicate must not change MR). Expected: green.

- [ ] **Step 5: Commit** — `feat(pr): drafts, access rules, catalog guards, pickers`.

---

### Task 4: List, KPIs, duplicate hints

**Files:**
- Modify: `app/models/pr/prModel.js` (`list`, `kpis`, `duplicates`), `app/controllers/pr/prController.js`, `app/routes/pr/index.js`
- Test: `tests/services/pr.list.test.js`

**Interfaces:**
- `GET /pr?tab=&status=&hotel_id=&department_id=&pr_type=&urgency=&progress=&q=&page=1&page_size=20`:
  - `tab ∈ {mine, all}`. `mine` = `raised_by = me`. `all` = `readableScopeSql`.
  - Returns `{ rows:[{id, pr_number, title, status, header_progress, hotel_name, department_name, raised_by_name, estimated_total, line_count, required_by_date, urgency, pr_type, submitted_at, approved_at, now_with}], total, facets:{status:{…}, hotel:{…}, department:{…}, pr_type:{…}, urgency:{…}} }`.
  - `estimated_total` for drafts = the live `Σ ROUND(qty*price,2)` of active lines.
  - `header_progress` is derived from line progress:
    - all lines `pending` → `null`;
    - every active line `in_pool`/`needs_mapping`/`awaiting_catalog` → `in_queue`;
    - some `in_sourcing` and some pool → `partly_in_sourcing`;
    - all non-terminal `in_sourcing` → `in_sourcing`;
    - some `ordered`, others not terminal → `partly_ordered`;
    - all active lines `ordered` → `ordered`;
    - no active lines left and at least one ordered or closed → `completed`.
  - `now_with`: `in_review` → `"Technical review: <dept titles>"`; `pending_approval` → `"Approval step <n>: <approver names, max 3>"`; `approved` → `"Purchase team"` or `"<assigned buyer name>"`; `returned`/`draft` → `"You"` (requester).
  - Facet counts are computed over the scope-filtered set **before** facet filters (facet-invariant, like `MrAllPage`).
- `GET /pr/kpis` → `{ open, awaiting_me, in_purchase_queue, avg_days_to_approval }` for the readable set (last 90 days for the average).
  - `awaiting_me` = reviews where I'm an eligible reviewer + PR approval steps pending on me (`tbl_approval_step_approvers` with status PENDING on the current step) + returned PRs I raised.
- `GET /pr/duplicates?hotel_id=&variant_id=` → `{ count, items:[{kind:'pr'|'rfq', id, number, hotel_name, department_name, created_at, readable:boolean}] }`:
  - Covers the same company, the last 30 days, open PR lines (PR not terminal, line active, effective variant = `variant_id`) and RFQs containing the variant (status not 2/5).
  - Items the caller can't read come back with `readable:false` and no title.

- [ ] **Step 1: Write the failing tests** `tests/services/pr.list.test.js`. Seed via the API (create drafts) plus direct status updates for later states.
  1. `mine-vs-all`: REQ sees their own drafts. An approver with `pr.read` on (A1, eng) sees the eng PRs in `all` but not the proc ones. `OTHER` sees nothing.
  2. `facets`: counts per status sum to `total`. Applying `status=draft` keeps the facet counts unchanged.
  3. `search`: `q` matches `pr_number`, title and line item names (case-insensitive).
  4. `pagination`: page 2 with page_size 1 returns the second row; `total` is stable.
  5. `header_progress` matrix: create an approved PR with 3 lines and wire each state via fixtures (insert `tbl_rfq` rows with `makeRFQ` from `tests/factories/rfq.js`, `tbl_rfq_products`, `tbl_pr_line_rfq`, a PO + PO product with status `approved`) to assert `in_queue`, `partly_in_sourcing`, `partly_ordered` and `completed`.
  6. `kpis.awaiting_me`: a pending review for REQ2 (eng reviewer) counts 1 for REQ2 and 0 for REQ.
  7. `duplicates`: two PRs with the same variant in A1 and A2 within 30 days → count 2. The caller without read on the A2 PR gets `readable:false` and no title. A PR older than 30 days (update `created_at`) is excluded.
  8. `tenant isolation`: a company B PR never appears for any company A user (all tabs, facets, duplicates).

- [ ] **Step 2: Run** — `npm test -- --testPathPatterns "pr\.list"`. Expected: FAIL.
- [ ] **Step 3: Implement** in the model. One CTE `scoped` (readable set) feeds `rows` and the facets. Progress uses `LINE_PROGRESS_SQL`. Avoid N+1: compute `now_with` with lateral subqueries.
- [ ] **Step 4: Run** `npm test -- --testPathPatterns "pr\.(list|draft)"`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(pr): listing, facets, KPIs, duplicate hints`.

---

### Task 5: Review routing map + routing preview

**Files:**
- Create: `app/services/pr/prRouting.js`, `app/controllers/pr/prAdminController.js`
- Modify: `app/routes/pr/index.js` (admin routes use the `requireCompanyAdmin` middleware from `app/middleware/companyAdmin.js`; read how it derives the company)
- Test: `tests/services/pr.routing.test.js`

**Interfaces:**
- `prRouting.resolveReviewDepartment(companyId, categoryId, t)` → `department_id | null`: an exact category mapping, else the parent category's mapping (walk up to 3 levels via `tbl_category.parent_id`).
- `prRouting.computeReviewGroups({ companyId, lines:[{id?, line_no, category_id}] }, t)` → `[{ department_id, department_title, line_nos:[…], line_ids:[…] }]`, sorted by department title.
- `prRouting.resolveReviewers({ companyId, hotelId, departmentId }, t)` → `[{id, name}]`: users holding `pr.evaluate` with a scope row covering (company, hotel or NULL, department or NULL). Active users only (`tbl_users.status=1`), joined via `tbl_hospitality_user_mappings` like `resolveApprovers`. Use `authorizationService.listUsersWithAnyScope(['pr.evaluate'], scope)` if its semantics match; otherwise write the SQL and comment why.
- `prRouting.previewApproval({ companyId, hotelId, departmentId, amount, requesterId }, t)` → `{ policy_id|null, steps:[{ step_order, label, min_amount, applies:boolean, approvers:[{id,name}], skipped_reason: null|'below_threshold'|'sod_self' }], problems:[{code, message, step_order?}] }`:
  - It uses `findBestMatchingPolicyTx({entity_type:'PR', process_id:null})`, the policy steps (`mrModel.policySteps` shape plus `min_amount`) and `resolveApprovers` + `filterInitiator` + `stepAppliesAtAmount`.
  - The `problems` codes are the same as submit's: `PR_NO_POLICY`, `PR_STEP_UNRESOLVED`, `PR_NO_INDEPENDENT_APPROVER`.
  - **Submit (Task 6/7) must call this same function** so preview and submit can never disagree.
- `POST /pr/routing-preview` with body `{hotel_id, department_id, lines:[{product_variant_id?|category_id, quantity, estimated_unit_price}]}` → `{ amount, reviews:[{department_id, department_title, line_nos, reviewers:[…], problem?}], approval:{…as above}, problems:[…all…] }`. `assertPerm('pr.create', cell)`. Amount computed server-side.
- `GET /pr/:id/routing-preview` → the same for a saved draft (requester or reader).
- Admin endpoints:
  - `GET /pr/admin/review-routing` → `[{id, category_id, category_title, parent_title, department_id, department_title, created_by_name, created_at}]` for the admin's company.
  - `POST` with `{category_id, department_id}` → upsert on `(company, category)`.
  - `DELETE /:mapId` → only within the admin's company, else 404.
  - The company always comes from the admin's context (as `requireCompanyAdmin` provides), never the body.

- [ ] **Step 1: Write the failing tests** `tests/services/pr.routing.test.js`
  1. `map.crud`: the company A admin creates a mapping (category C → eng), lists it, upserts it to proc (the same row id changes department), and deletes it. The company B admin's `DELETE` on A's map id → 404. A non-admin buyer → 403.
  2. `groups.exact-and-parent`: map parent P → eng; a line whose category's parent is P → eng group. Map child C → proc; a line in C → proc (exact beats parent). An unmapped category → no group.
  3. `groups.parallel`: lines in eng-mapped and proc-mapped categories → 2 groups, sorted, with correct `line_nos`.
  4. `reviewers`: grant `PR Technical Reviewer` to U1 at (A, A1, eng) and to U2 at (A, NULL hotel, eng). Both are listed. U3, granted at (A, A2, eng), is not listed for hotel A1. An inactive user is not listed.
  5. `preview.problems`:
     - no PR policy → `PR_NO_POLICY`;
     - a policy with a ROLE step nobody holds → `PR_STEP_UNRESOLVED` with `step_order`;
     - a policy whose only step is USER = requester → `PR_NO_INDEPENDENT_APPROVER`, and the step is `skipped_reason:'sod_self'`;
     - an eng-mapped line with no eng reviewer → a `reviews[0].problem` of `PR_NO_REVIEWER`.
  6. `preview.thresholds`: steps `[A1, A2(min 50000)]`. Lines totalling 49999.99 → step 2 `applies:false, skipped_reason:'below_threshold'`. 50000.00 → applies.
  7. `preview.amount-server-side`: a body with an extra `amount: 1` field is ignored; the returned amount equals Σ round(qty×price, 2).
  8. `preview.authz`: a caller without `pr.create` on the cell → 403.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pr\.routing` → PASS.
- [ ] **Step 5: Commit** — `feat(pr): category review routing and routing preview`.

---
### Task 6: Submit (no-review path), approval integration, withdraw, approver send-back

**Files:**
- Create: `app/services/pr/prWorkflow.js`, `app/services/pr/prNotify.js` (approval-related notifications only; Task 11 completes the rest)
- Modify:
  - `app/controllers/pr/prController.js` (`submit`, `withdraw`, `sendBack`, `handlePrPostApproval`, `handlePrRejection`)
  - `app/routes/pr/index.js`
  - `app/services/approvalActionService.js` (`postActionRegistry.PR`, `pr_number` in the identifier chain ~:261)
  - `app/services/approvalPropagationService.js` (`dispatchPostApprovalHandler` PR entry ~:448, `IDENTIFIER_KEYS_BY_ENTITY.PR = ['pr_number']`)
  - `app/models/generalModel.js` (identifier chain ~:3945; `cancelApprovalInstance` gains an optional 4th arg `{ t } = {}`; when given it runs `t.tx(...)` (savepoint) and defers its notifications to the caller via a returned `notify()` thunk; the default behaviour is unchanged)
  - `app/services/notificationLinks.js` (`buyerPrDetail`, `ENTITY_LABELS.PR = 'Purchase Requisition'`, `approvalActionUrl` case `'PR'`)
  - `app/helper/approvalEmailContext.js` (PR → `pr_number`)
  - the BE pending-approvals query behind `GET /dashboard-v2/pending-approvals` (`dashboardController.getPendingApprovals`), so PR rows appear with title/number/link
- Test: `tests/services/pr.approval.test.js`

**Interfaces:**
- `prWorkflow.startApproval(t, pr, actorId)`:
  1. Calls `previewApproval(...)`; if there are problems, throws the first as a `PrError` (same codes).
  2. Calls `createApprovalInstance({ entity_type:'PR', entity_id: pr.id, hospitality_company_id, hotel_id, department_id, process_id:null, initiated_by: pr.raised_by, amount: pr.estimated_total, strictSteps:true, metadata:{ pr_number, pr_id, title } }, t)`. Check how the engine accepts a tx — `createApprovalInstance(params, txContext)` — and how MR passes it.
  3. Maps engine errors `APPROVAL_STEP_UNRESOLVED` → `PR_STEP_UNRESOLVED`, `APPROVAL_NO_INDEPENDENT_APPROVER` → `PR_NO_INDEPENDENT_APPROVER`, and `APPROVAL_POLICY_RESOLVES_TO_NOBODY` → `PR_STEP_UNRESOLVED`.
  4. Sets `approval_instance_id`, status `pending_approval`; event `approval_started` with `{instance_id, amount, steps}`.
  5. Returns `{ instance, autoApproved }`.
- `prWorkflow.submit(prId, user)`:
  1. tx, `lockPr`, requester only, status ∈ {draft, returned} else 409.
  2. Re-validates every active line (usable variant, contract coverage, category exists), otherwise 422 with line details.
  3. `revision += 1`; `estimated_total` = server Σ; `submitted_at = now()`; `returned_note = NULL`.
  4. **Review groups exist** → Task 7 (`startReview`). **None** → `startApproval`.
  5. Returns the detail. If auto-approved (should not happen for PR, but handle it), call `dispatchPostApprovalAction` after commit, as `mrController.js:436` does.
- `prWorkflow.withdraw(prId, user)`: requester only; status ∈ {in_review, pending_approval} else 409. Cancels the PENDING instance (`cancelApprovalInstance(id, user.id, 'Withdrawn by requester', { t })`); pending reviews → `superseded`; status `draft`; event `withdrawn`.
- `prWorkflow.approverSendBack(prId, user, note)`:
  - The note is required (1..2000 chars).
  - Status must be `pending_approval`, else 409.
  - The caller must be a PENDING approver on the instance's **current** step (`tbl_approval_instance_steps` + `tbl_approval_step_approvers`), else 403.
  - Cancels the instance with reason `Sent back: <note>`; status `returned`; `returned_note = note`; event `approval_sent_back`; notify the requester.
- `handlePrPostApproval(approvalInstanceId, actorUserId, { instance })` and `handlePrRejection(...)`: find the PR by `approval_instance_id` (and `entity_id`), `lockPr`; if status ≠ `pending_approval`, log and return (idempotent). Set `approved` + `approved_at` (or `rejected`); event; notifications (requester; on approve also every buyer holding `pr.convert` for the hotel). Register them in **both** registries with the lazy-import shape used for MR.

- [ ] **Step 1: Write the failing tests** `tests/services/pr.approval.test.js`. No review mappings exist for the company in this suite (call `unmapAll` in `beforeAll`). Personas:
  - REQ (`PR Requester` eng@A1);
  - AP1 = `a1_proc_commApp`, AP2 = `a1_proc_finance` (made approvable for `pr` at (A, A1, eng));
  - BUY = `a1_proc_buyer` (`PR Buyer` @A1, dept NULL).

  Policy: USER AP1 (ANY), USER AP2 (min 100000).

  Tests:
  1. `submit.below-threshold`: total 99,999.99 → 200; status `pending_approval`; instance steps = [AP1]; event `approval_started`; `estimated_total = '99999.99'` even though the client posted `estimated_total: 1`.
  2. `approve.via-generic-endpoint`: AP1 `POST /general/hospitality/approval/action` (APPROVE) → PR `approved`, `approved_at` set; event `approved`. In-app notifications (`tbl_notifications`, or whatever `notificationService.dispatch` writes) exist for REQ and BUY with `action_url = /dashboard/buyer/purchase-requisitions/<id>`.
  3. `two-step-above-threshold`: total 100,000.00 → AP1 then AP2. After AP1 the PR is still `pending_approval` and `GET /pr/:id` `now_with` names AP2. After AP2 → `approved`.
  4. `reject`: AP1 rejects → `rejected`; requester notified; resubmit → 409 (rejected is terminal); `copy` works.
  5. `sod`: grant REQ the approver role too, policy ROLE step → REQ is never in the step approvers; the PR stays pending until AP1 approves. REQ calling the approval action → engine rejection (403/400); the PR is unchanged.
  6. `fail-closed.no-policy`: delete the policy → submit 422 `PR_NO_POLICY`; PR still `draft`, revision unchanged (tx rolled back), no instance row.
  7. `fail-closed.unresolved`: a policy ROLE step held by nobody → 422 `PR_STEP_UNRESOLVED` with `details.step_order`.
  8. `submit.double` (Review Focus 2): fire two submits concurrently (`Promise.all`) → one 200, one 409; exactly one approval instance for the entity.
  9. `submit.contract-appeared` (Review Focus 4): save the draft, then seed an active contract for the line variant at (A1, eng) → submit 422 `PR_LINE_ON_CONTRACT`.
  10. `withdraw`: from `pending_approval` → `draft`; the instance is `CANCELLED`; AP1's pending task is gone (`/general/hospitality/approval/pending` no longer lists it); AP1's later APPROVE on the old step fails and the PR stays `draft`. Resubmit → revision 2, new instance.
  11. `approver send-back`: AP1 `POST /pr/:id/send-back {note}` → `returned`, `returned_note`, instance CANCELLED, requester notified. AP2 (not on the current step) → 403. An empty note → 422. REQ edits and resubmits → revision 2 → `pending_approval`.
  12. `handler idempotent`: call `handlePrPostApproval` twice for the same instance → one `approved` event.
  13. `pending-approvals surface`: AP1 `GET /dashboard-v2/pending-approvals` includes an item for the PR with `entity_type 'PR'` and the `pr_number`.
  14. `approval email context`: call `approvalStepEmailContext` (production) for a PR instance → the identifier equals `pr_number`, the link equals `buyerPrDetail(id)`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pr\.(approval|draft)` plus the `security-approval` and `dashboard` shards → green.
- [ ] **Step 5: Commit** — `feat(pr): submit, approval chain, withdraw, send back`.

---

### Task 7: Technical review

**Files:**
- Modify: `app/services/pr/prWorkflow.js` (`startReview`, `completeReview`, `reviewSendBack`, reviewer edits, attachments), `app/models/pr/prModel.js` (`reviewQueue`), `app/controllers/pr/prController.js`, `app/routes/pr/index.js`, `app/services/pr/prNotify.js`
- Test: `tests/services/pr.review.test.js`

**Interfaces:**
- `startReview(t, pr, groups)`:
  - For each group, `resolveReviewers` returns no one → throw `PR_NO_REVIEWER` with `details:{department_id, department_title}`.
  - Also call `previewApproval` up front and throw its first problem, so a reviewer never works on a PR whose approval is already known to be broken.
  - Insert `tbl_pr_review(pending)` + `tbl_pr_review_line`; status `in_review`; events `review_created` per group.
  - After commit, notify each group's reviewers.
- **Reviewer eligibility for review R:**
  - The PR is `in_review`, `R.revision = pr.revision`, `R.status = 'pending'`.
  - The user holds `pr.evaluate` for (company, PR hotel, R.department).
  - Resolved **at action time** (Review Focus 1).
- `PUT /pr/:id/lines/:lineId/specification {specification}`:
  - The line must belong to a pending review the caller is eligible for, otherwise 403.
  - Event `spec_edited {before, after}`.
  - Quantity, price, uom, item and category are **not** editable here; extra fields → 422.
- `POST /pr/:id/lines/:lineId/clauses {clause_text, clause_type ∈ ('mandatory','desirable'), weightage 0..100 | null}`. Check the RFQ clause types in `rfqController.js` (`/rfq/add-clause`) and use the same set, so conversion can copy them unchanged.
- `DELETE …/clauses/:clauseId` → events.
- `POST /pr/:id/attachments {pr_line_id|null, kind, file_url, file_name}`:
  - Requester: status ∈ {draft, returned}.
  - Reviewer: in_review and the line is in their group; a header attachment (`pr_line_id` null) is not allowed for reviewers.
  - `file_url` must pass the same URL validation the RFQ file endpoints use. Find the S3 upload endpoint the RFQ wizard uses (`grep -n "upload" app/routes/rfq/rfqRoutes.js`) and accept only URLs with our bucket host prefix. If no helper exists, add `isOwnUploadUrl(url)` in `prCatalog.js` built from the `S3_BUCKET`/`AWS_REGION` env vars, and unit-test it.
- `DELETE /pr/:id/attachments/:attId`: same rules; only the uploader or the requester.
- `POST /pr/:id/reviews/:reviewId/complete {note?}`:
  - Eligibility check, then the review → `completed`, `acted_by`, `acted_at`; `self_reviewed = (user.id === pr.raised_by)`; event `review_completed` or `self_reviewed`.
  - If every review of this revision is completed → `startApproval(t, pr)` in the **same tx**.
  - If `startApproval` throws a config problem → the whole tx rolls back (the review stays pending) and the response is 422 with the code; the FE shows "Approval chain problem — contact your admin".
- `POST /pr/:id/reviews/:reviewId/send-back {note}`: this review → `sent_back` with the note; other pending reviews of the revision → `superseded`; PR `returned`, `returned_note`; event; notify the requester.
- `GET /pr/review-queue` → pending reviews of current revisions where the caller is eligible: `[{review_id, pr_id, pr_number, title, hotel_name, department_title (reviewing), requester_name, line_count, submitted_at, age_days}]`.
- `GET /pr/:id` capabilities add `review: {review_id, can_edit_lines:[ids]} | null`. Detail `reviews[]` include `{id, department_title, status, acted_by_name, note, self_reviewed, eligible_reviewers:[names], no_eligible_reviewer:boolean}`.

- [ ] **Step 1: Write the failing tests** `tests/services/pr.review.test.js`. Setup:
  - Map category CE (the variant's category) → eng and category CK (a second category used by a free-text line) → proc.
  - RV_ENG = `a1_proc_techEval` granted `PR Technical Reviewer` (A, A1, eng); RV_PROC = `a1_proc_techApp` granted `PR Technical Reviewer` (A, A1, proc).
  - The approval policy USER AP1.

  Tests:
  1. `submit.creates-parallel-reviews`: a PR with a CE line and a CK line → `in_review`; 2 reviews (eng: line 1, proc: line 2); both reviewers notified; the review queue lists the PR for each reviewer only.
  2. `reviewer.edit-own-lines`: RV_ENG edits line 1's spec → 200 + event with before/after. RV_ENG on line 2 → 403. RV_ENG sending `quantity` → 422 and no change.
  3. `reviewer.clauses+attachments`: RV_ENG adds 2 clauses and 1 datasheet to line 1, then deletes one clause → the detail shows 1 clause + 1 attachment; events recorded. A foreign URL (`https://evil.example.com/x.pdf`) → 422.
  4. `complete.partial`: RV_ENG completes → the PR is still `in_review`; no instance.
  5. `complete.last-starts-approval`: RV_PROC completes → `pending_approval` with an instance. AP1 approves → `approved`.
  6. `send-back.supersedes`: a new PR; RV_ENG sends back with a note → `returned`; the proc review is `superseded`; RV_PROC completing it now → 409. Requester resubmits → revision 2 with fresh pending reviews; the old reviews are untouched (history).
  7. `self-review`: grant REQ `PR Technical Reviewer` at eng as well → REQ can complete the eng review → `self_reviewed = true`, event `self_reviewed`; the approval still excludes REQ.
  8. `no-reviewer`: unmap proc's reviewer (revoke RV_PROC) → submit → 422 `PR_NO_REVIEWER` naming Procurement; the PR is still `draft`.
  9. `review.no-eligible-reviewer-mid-flight` (Review Focus 1): after submit, revoke RV_ENG → `GET /pr/:id` shows the eng review with `no_eligible_reviewer:true`; `now_with` contains "No eligible reviewer". Re-grant → RV_ENG can complete.
  10. `approval-broken-at-last-review`: after reviews start, delete the PR policy → the last completion returns 422 `PR_NO_POLICY` and that review stays `pending`. Restore the policy → complete → `pending_approval`.
  11. `requester-attachments`: the requester adds and removes attachments in draft; in `in_review` → 409.
  12. `withdraw during review`: → `draft`; pending reviews `superseded`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pr\.` (all PR suites) → PASS.
- [ ] **Step 5: Commit** — `feat(pr): category-driven technical review`.

---

### Task 8: Buyer pool — list, assign, map, catalog request, close/cancel line

**Files:**
- Modify: `app/models/pr/prModel.js` (`pool`, `buyersForHotel`), `app/services/pr/prWorkflow.js`, `app/controllers/pr/prController.js`, `app/routes/pr/index.js`, `app/services/pr/prNotify.js`
- Test: `tests/services/pr.pool.test.js`

**Interfaces:**
- `GET /pr/pool?hotel_id=&department_id=&category_id=&progress=&assigned=me|unassigned|any&q=&page=&page_size=`:
  - Returns lines of `approved` PRs whose progress ∈ {`in_pool`, `needs_mapping`, `awaiting_catalog`} (default: all three), limited to hotels where the caller holds `pr.convert`.
  - Rows: `{line_id, pr_id, pr_number, pr_title, hotel_id, hotel_name, department_id, department_title, line_kind, item_name (variant name or free text), effective_variant_id, category_title, quantity, uom, estimated_unit_price, line_value, required_by_date, urgency, approved_at, age_days, age_band ('ok'|'amber'|'red'), assigned_buyer_id, assigned_buyer_name, progress, duplicate_count, clause_count, attachment_count, open_catalog_request_id}`.
  - Age bands: `ok` < 3 days, `amber` 3–6, `red` ≥ 7. `age_days` is computed in IST calendar days from `approved_at`.
  - Sorted by urgency (urgent first), then `required_by_date`, then `approved_at`.
- `GET /pr/buyers?hotel_id=` → `[{id, name}]` holding `pr.convert` on that hotel (caller must hold it too).
- `POST /pr/:id/assign {buyer_id}`:
  - The caller holds `pr.convert` on the PR hotel; `buyer_id` must also hold it (else 422); the PR must be `approved` (else 409).
  - Sets `assigned_buyer_id/assigned_at`; event `assigned {from, to}`; notifies the assignee (if not self) and the requester ("Handled by …").
- `POST /pr/:id/lines/:lineId/map {variant_id}`:
  - The caller holds `pr.convert`; the line is `free_text`, active, `approved`, and has no live link, else 409.
  - The variant must be usable (else 422 `PR_VARIANT_NOT_USABLE`) and not on contract for the PR cell (else 422 `PR_LINE_ON_CONTRACT`). Re-mapping before conversion is allowed.
  - Event `line_mapped {from, to}`.
  - An open catalog request for the line → set `fulfilled` with `resolved_variant_id` and `resolved_by` (buyer), note "Mapped by buyer".
- `POST /pr/:id/lines/:lineId/catalog-request {requested_name, description}`:
  - The line must be free text, unmapped and active; a second open request → 409.
  - Inserts `tbl_pr_catalog_request(open)`; event; notifies platform admins: `notificationService` has no admin channel, so email `PR_CATALOG_REQUEST_EMAIL` (env, optional; skip with a log if unset) and rely on the admin-panel queue (Task 10).
- `POST /pr/:id/lines/:lineId/close {reason}`: buyer; line active with no live link, else 409; status `closed`, `close_reason`, `closed_by/at`; event; notify the requester.
- `POST /pr/:id/lines/:lineId/cancel {reason}`: requester; PR `approved`, line active, no live link; status `cancelled`; event; notify the assigned buyer.

- [ ] **Step 1: Write the failing tests** `tests/services/pr.pool.test.js`. Helper `approvedPr(lines)`: creates and submits a PR through the API with a no-review USER-step policy, then approves via the API. Personas: BUY (`PR Buyer` @A1), BUY2 (`PR Buyer` @A2 only), BUY3 (`PR Buyer` @A1).
  1. `pool.scope`: BUY sees the A1 lines; BUY2 sees none of them; a requester without the role → 403.
  2. `pool.progress+age`: set `approved_at` to now − 8 days → `age_band 'red'`, −3 → `'amber'`, today → `'ok'`. A free-text line → `needs_mapping`.
  3. `pool.excludes-non-approved`: drafts and pending PRs never appear.
  4. `assign`: BUY assigns to BUY3 → the requester's detail shows `assigned_buyer_name`; BUY3 is notified. Assigning to BUY2 (no A1 scope) → 422.
  5. `map`: BUY maps a free-text line to a usable variant → progress `in_pool`, `effective_variant_id` set. An unusable variant → 422. An on-contract variant → 422. Mapping a catalog line → 409.
  6. `catalog-request`: create → progress `awaiting_catalog`; a second request → 409. A buyer mapping the line afterwards → the request is `fulfilled` by the buyer.
  7. `close`: the reason is required → 422 when empty. Close → progress `closed`; the requester is notified; the line leaves the pool.
  8. `cancel-line`: the requester cancels an approved line → `cancelled`; the buyer cannot convert it later (asserted in Task 9). Cancelling a line with a live link → 409 (insert a link via a fixture).
  9. `tenant`: BUY passing a company B PR id to assign/map/close → 404.

- [ ] **Step 2–4:** Run → FAIL; implement; run `pr\.` → PASS.
- [ ] **Step 5: Commit** — `feat(pr): buyer pool, assignment, mapping, catalog requests, line close`.

---
### Task 9: Conversion — pool lines → RFQ draft; derived progress across the RFQ/PO lifecycle

**Files:**
- Create: `app/services/pr/prConversion.js`
- Modify: `app/controllers/pr/prController.js` (`convert`), `app/routes/pr/index.js`, `app/services/pr/prNotify.js`
- Test: `tests/services/pr.convert.test.js`, `tests/services/pr.progress.test.js`

**Interfaces:**
- `POST /pr/convert {line_ids:[int, 1..200], department_id, process_id?}` → `{ rfq_id, rfq_no, redirect: '/dashboard/buyer/rfq-management?tab=create-rfq&draft_id=<rfq_id>' }`.
- `prConversion.convertLines({ user, lineIds, departmentId, processId }, t)`, all in one tx:
  1. **Lock:**
     - `SELECT … FROM tbl_purchase_requisition_line l JOIN tbl_purchase_requisition p … WHERE l.id = ANY($1) ORDER BY l.id FOR UPDATE OF l, p`.
     - Any missing id, or one from another company (`p.hospitality_company_id` differs from the first line's) → 404 for the whole request.
     - Also take `pg_advisory_xact_lock(hashtext('pr_line_convert'), l.id)` per line in id order (two-key form), as a backstop against a racing map/close.
  2. **Validate** and collect per-line failures into `details:[{line_id, pr_number, line_no, reason}]`, where reason ∈ `not_approved | not_active | needs_mapping | awaiting_catalog | already_sourced | on_contract | variant_not_usable`. If any → 409 `PR_LINE_NOT_CONVERTIBLE`.
     - All lines share one `hotel_id`, else 422 `PR_HOTEL_MISMATCH`.
     - The caller holds `pr.convert` (company, hotel) and `rfq.create` (company, hotel, `departmentId`, `processId`) — use the same `assertUserHasScope` call that `saveRfqDraft` uses (`rfqController.js:2418` pattern). Else 403.
     - The department exists.
  3. **Group** by effective variant (`COALESCE(product_variant_id, mapped_variant_id)`). Within a group the `uom` values, compared trimmed and case-insensitively, must match, else 422 `PR_UNIT_MISMATCH` with `details:[{variant_id, units:[…], line_ids}]`. The group quantity is the NUMERIC sum, computed in SQL (`SUM(quantity)`) or with exact decimal string arithmetic. **Never JS float.** Format it without trailing zeros (`'1.5'`, `'12'`).
  4. **Insert the RFQ header**, mirroring `copyRfq`'s `tbl_rfq` insert (`rfqController.js:6164-6250`):
     - `rfq_no` = MAX+1 (same as copyRfq; known racy, accepted platform-wide);
     - `company_name` from the hotel's company; `contact_name`/`contact_number`/`response_email` from the converting buyer's `tbl_users` row;
     - `location` from the hotel (city/address, as the wizard expects); `bid_end_date = ''`, `is_published = 0`, `status = 1`;
     - `hospitality_company_id`, `hotel_id`, `department_id`, `process_id`;
     - `title = 'From ' || <comma-joined distinct PR numbers, max 3 then "+N">`;
     - `comment` = a summary listing the PR numbers and requesters;
     - `created_by = updated_by = buyer`.

     Then `tbl_rfq_hotel_mappings(rfq_id, hotel_id, created_by)`.
  5. **Per group:**
     - `tbl_rfq_products`:
       - `product_variant_id`; `variant` (the variant name as `copyRfq` uses it; check what the column holds in existing rows); `sheet_id` NULL or what the add-product flow sets — mirror `addProductToDraft` (`rfqController.js` ~:7335).
       - `comment` = the merged specifications, one block per source line: `"[PR-2026-xxxx · Engineering · 5 nos] <specification>"`.
       - `spec_file`/`qap_file` = `''` (NOT NULL).
     - `tbl_rfq_products_specs`: `('Quantity', <sum>)` and `('Unit', <uom as entered on the first line>)`.
     - `tbl_rfq_product_files` from the PR line attachments: `spec→'SPEC'`, `datasheet→'TDS'`, `qap→'QAP'`, `other→'SPEC'`.
     - Tech evaluation: if any source line has clauses → one `tbl_rfq_product_tech_evaluation(rfq_id, tbl_rfq_product_id, minimum_passing_score)`, using the default the RFQ wizard uses (find it in `/rfq/add-clause`; if none exists, use NULL and say so in the commit message), plus `…_clauses` rows copied from `tbl_pr_line_clause` (`clause_text`, `weightage`, `clause_type`).
     - **Vendors:**
       - `hospitalityModel.getEligibleVendorsForVariant(variantId, [hotelId])` → ids.
       - Then `directInviteIdsForLine(t, { rfqId, productVariantId, variant }, ids)` (Vendor Networks).
       - Insert `tbl_rfq_product_vendors(rfq_id, product_variant_id, user_id, variant, is_rfq_viewed=0)`.
       - Then `propagateRoutedCopiesLocked(t, rfqId)` once after all groups. Find its import in `rfqController.js`.
       - Zero vendors is allowed; the wizard's `checkProductVendors` blocks publish, which is correct.
     - `tbl_pr_line_rfq(pr_line_id, rfq_id, rfq_product_id, quantity = line.quantity, converted_by)` for each source line.
     - Event `converted {rfq_id, rfq_no, rfq_product_id}` per line, on each PR.
  6. **After commit:** notify the requesters (one notification per PR, "PR-… is being sourced: RFQ #<rfq_no>") with a link to the PR detail.
- `GET /pr/:id` detail lines gain `links:[{rfq_id, rfq_no, rfq_status_label, live:boolean, po:[{po_id, po_number, status}]}]`. The labels come from `RFQ_STATUSES` (`app/util/constants.js:32`): 1 + unpublished = "Draft", 1 + published = "Open", 2 "Closed", 3 "Pending approval", 4 "Ready to publish", 5 "Withdrawn". Do **not** use `quoteCompareViewModel`'s label map.

- [ ] **Step 1: Write the failing tests** `tests/services/pr.convert.test.js`. Setup:
  - BUY holds `PR Buyer` @A1 and the role that grants `rfq.create` at (A, A1, proc). Check `tests/fixtures/users.js` `ROLE_IDS` for an RFQ creator role; `a1_proc_buyer` is the fixture "RFQ creator" in A1/proc, so use it as BUY.
  - Three approved PRs (via the `approvedPr` helper from Task 8; move it into `prFixtures.js`):
    - PR1: variant V ×2 'nos' + variant W ×1 'kg' with 2 clauses and a datasheet;
    - PR2: variant V ×3.5 'Nos';
    - PR3 at hotel A2: variant V ×1.

  Tests:
  1. `convert.merge`: PR1 + PR2 lines → 200 with `redirect`.
     - `tbl_rfq`: status 1, `is_published` 0, `hotel_id` A1, `department_id` proc, `created_by` BUY.
     - Two `tbl_rfq_products` (V, W).
     - V's `Quantity` spec = `'5.5'`, `Unit` = `'nos'`.
     - W has a tech evaluation with 2 clauses and a TDS file.
     - `tbl_rfq_product_vendors` rows exist for eligible vendors (compare with `getEligibleVendorsForVariant` called directly).
     - 3 link rows; events `converted` on PR1 and PR2; both requesters notified.
  2. `convert.wizard-opens`: BUY `GET /api/v1/rfq/get-draft-by-id/<rfq_id>` → 200 with `rfq_products` length 2 and the Quantity/Unit specs present. The `rfq_form_data` contains contact fields and the mapped hotel (the FE needs `mappedHotels` + `contact_number`).
  3. `convert.progress`: after conversion, the pool no longer lists those lines; `GET /pr/:id` lines show `progress:'in_sourcing'` and `links[0].rfq_no`.
  4. `convert.hotel-mismatch`: PR1 line + PR3 line → 422 `PR_HOTEL_MISMATCH`; nothing inserted (count `tbl_rfq` before and after).
  5. `convert.unit-mismatch`: PR1 V (`nos`) + another PR's V (`box`) → 422 `PR_UNIT_MISMATCH` with details.
  6. `convert.not-convertible`: a mix of a converted line (already_sourced), a cancelled line, a `needs_mapping` free-text line and a pending PR's line → 409 with one detail per line and the correct reasons; nothing inserted.
  7. `convert.concurrent` (Review Focus 2): two parallel converts of the same line by BUY and BUY3 → exactly one 200 and one 409; exactly one link row.
  8. `convert.variant-deactivated` (Review Focus 4): the variant is deactivated after approval → 409 with `variant_not_usable`.
  9. `convert.on-contract-now`: a contract appears after approval → 409 `on_contract`.
  10. `convert.authz`: a caller without `rfq.create` for the chosen department → 403. BUY2 (A2 only) converting A1 lines → 403. A company B line id → 404.
  11. `convert.fractional-sum` (Review Focus 5): quantities `0.125 + 0.375` → spec `'0.5'`; `1000000.5 + 0.5` → `'1000001'`.
  12. `convert.free-text-mapped`: a mapped free-text line converts using the mapped variant; its RFQ product comment contains the free-text name.

  `tests/services/pr.progress.test.js` (derived progress; no code paths in RFQ/PO are modified):
  1. `draft-deleted → in_pool`: `DELETE /api/v1/rfq/delete-draft/<rfq_id>` as BUY → the link rows are gone (cascade) and the line is back in the pool. Note the `deleteDraft` quirk recorded in the BE fact sheet: the cascade comes from `tbl_rfq_products` deletion; assert the links are gone either way.
  2. `rfq-withdrawn → in_pool`: set `tbl_rfq.status = 5` → `in_pool`; the old link is still in `links` with `live:false`; the line can be re-converted (a second conversion succeeds and creates a new live link).
  3. `po-live → ordered`: insert a PO (`makePO` from `tests/helpers/dashboardSeed.js`) with a `tbl_purchase_order_product` for the RFQ product and status `approved` → `ordered`; the PR `header_progress` reflects it.
  4. `po-cancelled, rfq-open → in_sourcing`; `po-cancelled, rfq-closed (status 2) → in_pool`.
  5. `rfq-closed with PO on another product only` → this line `in_pool` (partial-award return).
  6. `rfq-approval-rejected → still in_sourcing` (status back to 1, unpublished).

- [ ] **Step 2–4:** Run → FAIL; implement; run `pr\.` and the `rfq` shard (no RFQ behaviour changed) → green.
- [ ] **Step 5: Commit** — `feat(pr): convert pool lines to an RFQ draft; derived sourcing progress`.

---

### Task 10: Platform catalog requests (admin API)

**Files:**
- Create: `app/controllers/admin/prCatalogRequestController.js`
- Modify: the admin router. Locate the router serving `/api/v1/admin/product/...` (`grep -rn "admin-product-add" app/routes`) and add `/pr-catalog-requests` routes with the same `jwtAdm` middleware.
- Test: `tests/services/pr.catalogRequest.test.js` (use `stampAdmin` / the admin login helper in `tests/helpers/auth.js`; read how existing admin tests authenticate, e.g. `grep -rln "jwtAdm\|stampAdmin" tests | head`)

**Interfaces:**
- `GET /api/v1/admin/pr-catalog-requests?status=open|fulfilled|rejected&q=&page=` → `{rows:[{id, requested_name, description, category_title, company_name, hotel_name, pr_number, pr_id, line_no, requested_by_name, requested_at, status, resolved_variant_id, resolved_variant_name, resolution_note}], total}`.
- `POST /api/v1/admin/pr-catalog-requests/:id/fulfil {variant_id, note?}`:
  1. The request must be `open`, else 409.
  2. The variant must be usable, else 422.
  3. Sets `fulfilled`, `resolved_by` (admin id), `resolved_at`, `resolved_variant_id`.
  4. If the line is still free text, active and unmapped, and the variant is not on contract for the PR cell, sets the line's `mapped_variant_id`, `mapped_by = NULL` (platform) and `mapped_at`; otherwise leaves the line unmapped and records why in the event payload.
  5. Events `catalog_fulfilled` (+ `line_mapped`).
  6. Notifies the requester and the assigned buyer, or all `pr.convert` holders of the hotel.
- `POST /api/v1/admin/pr-catalog-requests/:id/reject {note}`: the note is required; sets `rejected`; event; same notifications. The line returns to `needs_mapping`.

- [ ] **Step 1: Write the failing tests:**
  1. `list.filters`;
  2. `fulfil.maps-line` (pool progress becomes `in_pool` with `effective_variant_id`);
  3. `fulfil.unusable` → 422;
  4. `fulfil.already-mapped-by-buyer` → request fulfilled, line mapping unchanged, event payload `{line_mapped:false, reason:'already_mapped'}`;
  5. `reject.note-required`, then `reject` → `needs_mapping`, notifications;
  6. `authz` — buyer JWT → 401/403 on admin routes.
- [ ] **Step 2–4:** Run → FAIL; implement; run → PASS.
- [ ] **Step 5: Commit** — `feat(pr): platform catalog request queue API`.

---

### Task 11: Conversation, notification matrix, activity trail

**Files:**
- Modify: `app/services/pr/prNotify.js`, `app/controllers/pr/prController.js` (`addComment`), `app/routes/pr/index.js`, `app/services/activity/eventRegistry.js` (PR route events, new category `PURCHASE_REQUISITIONS: 'Purchase Requisitions'`), `app/models/activityModel.js` (`ENTITY_SCOPE_SQL.PR` like MR :123)
- Test: `tests/services/pr.notify.test.js`, `tests/services/activity.pr.test.js` (shard `activity`: pattern `tests/services/(activity|admin)\.` matches `activity.pr`)

**Interfaces:**
- `POST /pr/:id/comments {body}`:
  - Any reader (`canReadPr`); the body is 1..4000 chars after trim, else 422.
  - Inserts the comment and event `comment_added`.
  - Notifies participants except the author: requester, the assigned buyer, reviewers who acted on or are eligible for current pending reviews, current-step pending approvers, and prior commenters.
- Detail `comments[]` = `{id, author_id, author_name, body, created_at}` ascending.
- `prNotify` exports one function per event: `notifyReviewTasks`, `notifyReturned`, `notifyApproved`, `notifyRejected`, `notifyAssigned`, `notifyConverted`, `notifyLineClosed`, `notifyLineCancelled`, `notifyCatalogResolved`, `notifyComment`.
  - All are called **after commit** and never throw (each catches and logs).
  - In-app via `notificationService.dispatch({ userIds, senderUserId, category:'pr', type, title, body, data:{pr_id}, actionUrl: buyerPrDetail(id) })`.
  - Email via `sendMail` for action-required events (review task, returned, approved, assigned) using `notificationEmailLayout`.
  - Recipients are deduplicated and never include the actor.

- [ ] **Step 1: Write the failing tests**
  - `pr.notify.test.js`: a table-driven test over the spec §11 matrix. For each event, perform the action through HTTP and assert the set of recipient user ids written by `dispatch` for `category='pr'` (read the table `notificationService.dispatch` writes, e.g. `tbl_notifications`; mock `sendMail` via `jest.unstable_mockModule` on `app/helper/common.js`'s `sendMail` and assert recipients). Include `comment` (the author is excluded; a non-reader cannot comment → 404) and that the actor is never notified.
  - `activity.pr.test.js`: creating a draft and submitting produces `tbl_activity_events` rows with category "Purchase Requisitions" and entity `PR/<id>`; a user without read on the PR cannot see them via the activity endpoint (follow an existing `activity.*.test.js` for shape).
- [ ] **Step 2–4:** Run → FAIL; implement; run `pr\.|activity\.pr` → PASS.
- [ ] **Step 5: Commit** — `feat(pr): conversation, notifications, activity trail`.

### Task 11b: Backend whole-domain check
- [ ] Run every shard with `/tmp/preq/run-shards.sh <be> /tmp/preq/after-be`. Compare with `/tmp/preq/baseline/summary.txt`: there must be no new failures and the test counts must grow. Then run `npm run test:shards`, plus `npx eslint app/services/pr app/controllers/pr app/models/pr app/routes/pr` if the repo has eslint configured. Fix and commit.

---
## Phase B — Frontend (`.worktrees/purchase-req/frontend`)

FE conventions (all tasks):
- Read `pages/dashboard/buyer/material-requisitions/create.js` and `[mrId].js` before writing anything; they are the reference for layout, `arc_v2.css` classes, toasts (`.arc-toast`), `getApiErrorMessage` and the cancelled-effect guard.
- Page tests mock `@/services/pr` with `jest.mock`, mock `next/router`, and render the page default export (pattern: `tests/pages/material-requisitions/create.groupArc.test.js`).
- Run with `npm test -- <path>` in the FE worktree.
- Error codes from the BE (`code`) map to human copy in `prFormat.js` `ERROR_COPY`, so the UI never shows raw codes:

```js
export const ERROR_COPY = {
  PR_NO_POLICY: "No approval chain is set up for purchase requisitions at this hotel. Ask your admin to add one.",
  PR_STEP_UNRESOLVED: "An approval step has nobody assigned. Ask your admin to fix the PR approval chain.",
  PR_NO_INDEPENDENT_APPROVER: "Someone other than you has to approve this PR, and no one else is set up as an approver.",
  PR_NO_REVIEWER: "No technical reviewer is set up for one of the departments. Ask your admin.",
  PR_LINE_ON_CONTRACT: "This item is on an active rate contract. Raise a Material Requisition instead.",
  PR_VARIANT_NOT_USABLE: "This catalog item can't be used right now.",
  PR_STATE_CONFLICT: "This PR changed since you opened it. Refresh to see the latest.",
  PR_LINE_NOT_CONVERTIBLE: "Some selected lines can't be converted.",
  PR_UNIT_MISMATCH: "The same item is requested in different units. Select lines with one unit.",
  PR_HOTEL_MISMATCH: "An RFQ is for one hotel. Select lines from a single hotel.",
};
```

### Task 12: Service layer + registration (links, nav, approvals surfaces, permission labels)

**Files:**
- Create: `services/pr.js`, `components/dashboard/purchase-requisitions/prFormat.js`, `PrStatusPill.js`, `PrProgressPill.js`
- Modify:
  - `components/dashboard/shared/dashboardLinks.js`: builders `purchaseRequisitions()`, `purchaseRequisition(id)`, `purchaseRequisitionCreate(id?)`, `purchaseRequisitionReview()`, `purchaseRequisitionQueue()`; `approvalHref`/`approvalQueue` case `'PR'`; `ALL_LINK_BUILDERS`; and its test's entity list
  - `components/layout/Header/headerConfig.js`: "Purchase Requisitions" section in the "Requisition & Orders" group with My requisitions / New / To review / Purchase queue
  - `components/layout/DashboardShell/navIcons.js`
  - `hooks/usePendingApprovalIndicators.js`: `ENTITY_TYPE_TO_HREF.PR`
  - `components/dashboard/buyer/dashboard-components/PendingApprovalsModal.js`: `ENTITY_CONFIG`, `approvalRowHref`, `getTitle`, `getNumber`, `ORDER`
  - `components/dashboard/admin/shared/permissionLabels.js`: labels for `pr` + `convert`
- Test: `components/dashboard/purchase-requisitions/prFormat.test.js`, plus the existing `dashboardLinks.test.js` (it must pass with the new pages; the pages are created as stubs in this task and filled in later tasks)

**Interfaces** (`services/pr.js`; every function returns the unwrapped `data` exactly as `services/mr.js` does):
`listPrs(params)`, `getPrKpis()`, `getPr(id)`, `createPr(body)`, `updatePr(id, body)`, `submitPr(id)`, `withdrawPr(id)`, `cancelPr(id, reason)`, `copyPr(id)`, `sendBackPr(id, note)`, `previewRouting(body)`, `previewRoutingForPr(id)`, `getFormHotels()`, `getFormDepartments(hotelId)`, `searchItems(params)`, `searchCategories(q)`, `getDuplicates(params)`, `getReviewQueue()`, `completeReview(id, reviewId, note)`, `sendBackReview(id, reviewId, note)`, `updateLineSpec(id, lineId, specification)`, `addClause(id, lineId, body)`, `deleteClause(id, lineId, clauseId)`, `addAttachment(id, body)`, `deleteAttachment(id, attId)`, `addComment(id, body)`, `getPool(params)`, `getBuyers(hotelId)`, `assignPr(id, buyerId)`, `mapLine(id, lineId, variantId)`, `requestCatalogItem(id, lineId, body)`, `closeLine(id, lineId, reason)`, `cancelLine(id, lineId, reason)`, `convertLines(body)`, `getReviewRouting()`, `saveReviewRouting(body)`, `deleteReviewRouting(id)`.

`prFormat.js` exports:
- `formatINR(v)`: string-safe; `"1250000.75"` → `"₹12,50,000.75"`; integers show no decimals.
- `formatQty(v)`: strips trailing zeros.
- `lineValue(qty, price)`: exact via integer paise math on strings; used for the live total only, the server is authoritative.
- `STATUS_LABEL`, `PROGRESS_LABEL`, `HEADER_PROGRESS_LABEL`, `ERROR_COPY`, `errorCopy(err)` (reads `err.response.data.code`, falls back to `getApiErrorMessage`).

- [ ] **Step 1: Failing tests** for `prFormat`: `formatINR('1250000.75') === '₹12,50,000.75'`; `formatINR('100000') === '₹1,00,000'`; `lineValue('0.125','8.00') === '1.00'`; `lineValue('3','33.33') === '99.99'`; `errorCopy({response:{data:{code:'PR_NO_POLICY'}}})` returns the copy.
- [ ] **Step 2–4:** Implement and run `npm test -- components/dashboard/purchase-requisitions components/dashboard/shared` → PASS.
- [ ] **Step 5: Commit** — `feat(pr): FE service, formatting, navigation and approval surfaces`.

### Task 13: Create / edit page

**Files:**
- Create: `pages/dashboard/buyer/purchase-requisitions/create.js`, `components/dashboard/purchase-requisitions/PrLineEditor.js`, `PrRoutingPreview.js`
- Test: `tests/pages/purchase-requisitions/create.test.js`

**Behaviour:**
- **Header:** hotel (from `getFormHotels`), department (`getFormDepartments`), title, type, urgency, need-by date (min = today IST), justification, delivery location.
- **Lines:** "Add catalog item" opens a typeahead on `searchItems` (250 ms debounce, ≥ 2 chars, stale-request guard copied from `AddProductsModal.js:143-172`). "Add item not in catalog" adds a free-text row with name, a category typeahead (`searchCategories`) and a unit.
  - Each row has quantity, unit, estimated unit price, specification and a suggested-vendor note.
  - The row value and grand total are computed with `lineValue`.
- **Guided buying:** a search result with `on_contract:true` renders disabled with "On contract <arc_number> — raise an MR" and a link to `dashboardLinks.materialRequisition…` create. It can't be added.
- **Duplicate hint** under a catalog row: `getDuplicates` → "3 open requests for this item in your company in the last 30 days". Readable items are links; unreadable ones show the hotel and department only.
- **Routing preview panel:** `previewRouting` debounced 400 ms on hotel / department / line changes. It shows review groups with reviewer names, the approval steps with "Not required below ₹X" and "Skipped — you raised this PR" notes, and a red **problems** box using `ERROR_COPY`. **Submit is disabled while there are problems.**
- **Actions:** Save draft (`createPr` / `updatePr`), Submit (save, then `submitPr`; on 422 show `errorCopy` and the line details inline). With `?id=`, load via `getPr` and allow editing only if `capabilities.can_edit`; otherwise redirect to detail.

- [ ] **Step 1: Failing tests:**
  1. Renders the hotels/departments pickers and blocks adding lines until both are chosen.
  2. A catalog search result with `on_contract` is disabled and shows the MR link.
  3. Adding a free-text line requires name, category and unit before save (inline errors; `createPr` not called).
  4. The live total shows `₹12,50,000.75` for qty `1`, price `1250000.75`.
  5. A preview with `problems:[{code:'PR_NO_POLICY'}]` disables Submit and shows the copy.
  6. A submit 422 `PR_LINE_ON_CONTRACT` with `details:[{line_no:1}]` highlights line 1.
  7. Edit mode loads an existing draft and calls `updatePr` on save.
- [ ] **Step 2–4:** Implement and run → PASS.
- [ ] **Step 5: Commit** — `feat(pr): create/edit requisition page with guided buying and routing preview`.

### Task 14: Detail page

**Files:**
- Create: `pages/dashboard/buyer/purchase-requisitions/[prId].js`, `components/dashboard/purchase-requisitions/{PrReviewPanel,PrApprovalPanel,PrConversation,PrTimeline}.js`
- Test: `tests/pages/purchase-requisitions/detail.test.js`

**Behaviour:**
- **Hero:** PR number, title, status pill + header progress, hotel/department/type/urgency/need-by, estimated total, raised by, and a **"Now with: …"** line.
- **Returned banner** showing `returned_note`.
- **Lines table:** item (catalog or free text, with a "mapped to …" note), category, qty + unit, est. price, value, spec (expandable), clauses, attachments, progress pill, RFQ/PO links (`links[]` → RFQ detail via the existing builder; PO numbers).
- **Review section** (`reviews[]`):
  - Per department: status, reviewer, note, "self-reviewed" badge, and a red "No eligible reviewer — contact your admin" when `no_eligible_reviewer`.
  - If `capabilities.review` is set: inline spec editing per eligible line, add/remove clause (text, type, weightage), add/remove attachment (reuse the RFQ upload component/service; find the one the RFQ wizard uses for TDS/SPEC uploads), Complete review (optional note), Send back (note required, in a modal).
- **Approval section:** reuse the chain rendering from `[mrId].js:571-597`.
  - Steps that don't apply are greyed with the reason (`below_threshold` → "Not required below ₹X"; `sod_self` → "Skipped — raised by the requester").
  - Approve / Reject call `submitApprovalAction` exactly as MR does. Send back calls `sendBackPr` (note modal).
- **Conversation:** a list plus a textarea (1..4000 chars, counter).
- **Timeline:** `events[]` rendered with human labels and actor/time, and before/after for `spec_edited`.
- **Action dock by capabilities:** Edit, Submit, Withdraw, Cancel (reason), Copy as new, Cancel line (approved, not converted; reason).
- Every mutation shows a toast and refetches. A 409 shows `ERROR_COPY.PR_STATE_CONFLICT` with a Refresh button.

- [ ] **Step 1: Failing tests:**
  1. A requester-draft fixture shows Edit/Submit/Cancel and no approve buttons.
  2. A reviewer fixture (`capabilities.review`) can edit the spec of an eligible line only, and Send back requires a note.
  3. An approver fixture (`approval.can_user_approve`) shows Approve/Reject/Send back; Approve calls `submitApprovalAction` with the instance and step ids.
  4. A below-threshold step renders "Not required below ₹1,00,000".
  5. An approved PR with links shows the RFQ number and progress "In sourcing".
  6. A 409 on submit shows the conflict copy and a Refresh button that refetches.
  7. A comment post appends to the list.
- [ ] **Step 2–4:** Implement and run → PASS.
- [ ] **Step 5: Commit** — `feat(pr): requisition detail with review, approval, conversation, timeline`.

### Task 15: List page + review queue page

**Files:**
- Create: `pages/dashboard/buyer/purchase-requisitions/index.js`, `review.js`, `components/dashboard/purchase-requisitions/PrListPage.js`
- Test: `tests/pages/purchase-requisitions/list.test.js`, `review.test.js`

**Behaviour:**
- **List:**
  - KPI tiles (`getPrKpis`): Open, Awaiting me, In purchase queue, Avg days to approval.
  - Tabs: Mine / All I can see.
  - Status tabs from facets; left facet sidebar (hotel, department, type, urgency); search; pagination.
  - Rows show PR number, title, status/progress pills, hotel · department, total, need-by, Now with.
  - "New requisition" CTA. Empty state with an explanation of what a PR is and a link to MR for contracted items.
- **Review queue:** a table from `getReviewQueue` with age, linking to detail.

- [ ] **Step 1: Failing tests:** facet click sends `status=` and keeps the counts; search debounced; empty state copy; the review queue renders rows with age.
- [ ] **Step 2–4:** Implement and run → PASS.
- [ ] **Step 5: Commit** — `feat(pr): requisition list and review queue`.

### Task 16: Buyer queue (pool) + convert + wizard handoff

**Files:**
- Create: `pages/dashboard/buyer/purchase-requisitions/queue.js`, `components/dashboard/purchase-requisitions/{PrQueuePage,ConvertModal,MapVariantModal}.js`
- Modify (only if needed): `components/dashboard/buyer/createRFQ/CreateRFQ.js`. Change it only if a server-built draft fails to load (e.g. the hotel is not selected because `mappedHotels` is only read inside the `contact_number` branch, :2008-2025). Make the smallest fix, with a test.
- Test: `tests/pages/purchase-requisitions/queue.test.js`

**Behaviour:**
- **Filters:** hotel (required when the buyer has several), department, category, progress chips, assigned (me / unassigned / any), search.
- **Rows:** checkbox, PR number (link), department, item, qty + unit, value, need-by, urgency, **age badge** (ok/amber/red), assignee, duplicate count, progress.
- **Row actions:** Assign (to me / pick from `getBuyers`), Map (`MapVariantModal` using `searchItems` with on-contract results disabled), Request catalog item (prefilled name; description), Close line (reason).
- **Selection rules in the UI:** only `in_pool` lines are selectable, and all selected lines must be from one hotel (others are disabled with a tooltip). The server re-checks.
- **Convert:**
  - `ConvertModal` shows the grouped preview: same variant merged, summed qty, and a unit-mismatch warning (client-side grouping mirrors the server, which stays authoritative).
  - Department select: defaults to the common PR department if uniform, else required.
  - Confirm → `convertLines` → `router.push(res.redirect)`.
  - A 409 shows the per-line reasons.

- [ ] **Step 1: Failing tests:**
  1. Lines from 2 hotels can't be selected together.
  2. A `needs_mapping` line is not selectable and shows Map.
  3. The convert modal merges two V lines into one row with summed qty `5.5`.
  4. A 409 response renders the per-line reasons.
  5. Success navigates to `/dashboard/buyer/rfq-management?tab=create-rfq&draft_id=…`.
  6. Age badge colours for 0 / 3 / 7 days.
- [ ] **Step 2–4:** Implement and run → PASS.
- [ ] **Step 5: Commit** — `feat(pr): purchase queue, mapping, conversion to RFQ`.

### Task 17: Admin — PR approval flow with value thresholds; category review routing

**Files:**
- Modify (approval-hierarchy):
  - `constants.js`: `entityTypes` + `PR` and `MR` entries; `FLOW_TYPE.PR`; `PR_PROCESS_STAGES`; `ALL_STAGE_ENTITY_ORDER`
  - `wizard/WorkflowWizard.js`: `PROCESS_FREE_FLOWS` + PR
  - `wizard/StepSelectProcessOnly.js`: flow card "Purchase Requisition"
  - `wizard/StepConfigureStages.js`: `min_amount: null` on new steps
  - `wizard/ApprovalStepCard.js`: "Only when PR value ≥ ₹" numeric input, shown only for the PR flow; validated ≥ 0, max 2 decimals
  - `workflowPayloads.js` (`BASE_STAGE`)
  - `dashboard/DashboardView.js`: PR group; **fix the Edit-wired-to-delete bug for process-free orphans** (:131-133) so Edit opens the wizard
  - `index.js`: edit/delete branches
- Create: `components/dashboard/admin/approvals/PrReviewRouting.js` (+ `Approvals.module.css` additions); a new `?view=pr-routing` tab in `ApprovalsPage.js`
- Test: `WorkflowWizard.pr.test.js` (next to the existing `WorkflowWizard.groupArc.test.js`), `components/dashboard/admin/approvals/PrReviewRouting.test.js`

**Behaviour:**
- The admin creates a PR policy: hotel (or all), steps with source (role/user/department), rule and optional min amount. Saving posts `entity_type:'PR'` with `steps[].min_amount`.
- The review step text explains: "Steps with a minimum apply only when the PR's estimated value is at or above it."
- **PR review routing tab:**
  - Table of category → reviewing department.
  - Add row: category typeahead (`searchCategories`) and department select (the company departments endpoint the admin pages already use; find it in `ApprovalCover.js`).
  - Delete with confirm.
  - Help text: "Lines in a mapped category (or its sub-categories) are reviewed by that department's PR Technical Reviewers before approval."

- [ ] **Step 1: Failing tests:**
  1. The wizard shows a Purchase Requisition flow card; configuring 2 steps with min `100000` on step 2 posts the payload with `entity_type 'PR'`, `process_id null`, `steps[1].min_amount '100000'`.
  2. A min-amount input of `-5` or `1.234` shows a validation error and Save is disabled.
  3. An existing process-free policy's Edit opens the wizard (not delete).
  4. The routing tab lists mappings, adds one (calls `saveReviewRouting`) and deletes one after confirm.
- [ ] **Step 2–4:** Implement and run → PASS; then run the full FE suite `npm test` and `npm run build` → green.
- [ ] **Step 5: Commit** — `feat(pr): admin PR approval flow with value thresholds and review routing`.

## Phase C — admin-panel

### Task 18: Catalog requests queue (platform admin)

**Setup:** `git -C /Users/apple/Documents/Workwise/hospitality/admin-panel worktree add -b feat/purchase-requisitions ../.worktrees/purchase-req/admin-panel HEAD`. Symlink `node_modules` from the admin-panel checkout and copy its `.env*` files.

**Files:**
- Create: `pages/catalog-requests/index.js`, `components/catalog-requests/index.js`, `utils/services/catalog-requests.js`
- Modify: `components/layout/sidebar/menu.json` (Product group: "Catalog Requests"). Find how the `access` tiles that filter the sidebar are issued (admin login response / DB table). If a tile must be granted server-side, add the minimal BE migration or seed in the BE worktree (Task 10 files) and note it in the deploy notes.

**Behaviour:**
- List with status tabs (Open / Fulfilled / Rejected), search and pagination (mirror `components/product-preview/index.js`).
- Each row: requested item, description, category, company · hotel, PR number + line, requested by and time.
- **Fulfil:** a modal to search an existing variant (reuse the product search the admin panel already has; else a simple `GET /admin/product/...` list call) with a link "Create product" to `/product-management/add-product` in a new tab; confirm → `POST /fulfil`.
- **Reject:** a modal with a required note.

- [ ] **Step 1:** If the admin-panel has a jest setup, write component tests for the list rendering and fulfil/reject calls. If it has **no** test runner, don't add one; verify in the browser in Task 19 and record that in the report.
- [ ] **Step 2:** Implement; `npm run build` passes.
- [ ] **Step 3: Commit** — `feat(pr): catalog requests queue`.

## Phase D — End-to-end verification and release

### Task 19: Local E2E stack, seed and browser pass

**Files:**
- Create: `scripts/pr/seed_e2e.mjs` (BE). It is idempotent and seeds the `hospitality_test_e2e`-style DB used by `scripts/vendor_networks/e2e_server.sh`; read that script and reuse its DB and port conventions. **Never point it at stage or prod.**
- Create: `docs/superpowers/plans/2026-10-13-purchase-requisitions-e2e.md` (the E2E checklist and results).

**Seed:**
- Company A, hotel A1, departments Engineering/Housekeeping/Procurement.
- Users:
  - REQ_HK (PR Requester HK);
  - REQ_ENG (PR Requester + PR Technical Reviewer Eng);
  - RV_ENG (Technical Reviewer Eng);
  - HOD_HK (PR Approver HK scope);
  - FC (PR Approver, hotel-wide);
  - GM (PR Approver, hotel-wide);
  - BUY1 and BUY2 (PR Buyer + RFQ creator at Procurement).
- PR policy: ROLE "HOD" → FC → GM (min ₹1,00,000).
- Review routing: Kitchen equipment → Engineering.
- An active contract on one variant (to show the MR redirect).

**Browser pass** (chrome-devtools MCP, per memory: the chrome extension can't reach localhost). Take screenshots for each step:
1. REQ_HK creates a PR:
   - an on-contract item is blocked with the MR link;
   - one catalog line in Kitchen equipment, one free-text line;
   - the preview shows the Eng review and the HOD → FC chain (GM greyed below ₹1L);
   - submit.
2. RV_ENG reviews: edits the spec, adds 2 clauses and a datasheet, completes the review.
3. HOD_HK approves → FC sends back with a note → REQ_HK edits the quantity above ₹1L → resubmit → RV_ENG completes → HOD → FC → GM approve.
4. BUY1 opens the queue:
   - assigns to self;
   - maps the free-text line (or files a catalog request → fulfils it in the admin-panel → the line becomes mappable);
   - converts both lines;
   - the RFQ wizard opens prefilled (products, quantity/unit, clauses, files, vendors);
   - sets the bid end date and submits the RFQ.
5. REQ_HK's detail shows "In sourcing" with the RFQ number; the conversation works; the timeline is complete.
6. Negative paths in the UI:
   - Withdraw during review.
   - Self-approval impossible: REQ_ENG raising for Eng has the HOD step skipped as self.
   - The admin deletes the policy → Submit is disabled with copy.
   - A 409 on a stale tab.
7. Mobile width 390 px sanity check for list, detail and queue.

For every defect found: write the failing test in the owning task's suite first, fix, re-run that suite, commit `fix(pr): …`.

### Task 20: Final verification, review and release notes
- [ ] Run the BE: all shards via `/tmp/preq/run-shards.sh` (compare with the baseline) plus `npm run test:shards`. Run the FE: `npm test` + `npm run build`. Run the admin-panel `npm run build`.
- [ ] Do a whole-branch code review (security: tenant scope on every route, IDOR; money: NUMERIC everywhere; state machine: locks; consistency: preview = submit). Fix all findings.
- [ ] Write the release notes: `hospitality/docs/releases/2026-10-purchase-requisitions/PR_RELEASE_NOTES.md`. Cover what it does (with screenshots), roles to grant, policy setup, review routing setup, deploy order (DB-first migrations `20261013100000`, `20261013101000`), known limits (spec §2 non-goals), and the evidence summary.
- [ ] Final report to the user.
