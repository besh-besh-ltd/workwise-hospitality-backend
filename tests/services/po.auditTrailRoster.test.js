// Wave: PO detail audit trail — the FULL per-level approver roster.
// ----------------------------------------------------------------------------
// Client issue: "In the Audit trail section, at each level, we are not showing
// all the list of users who need or has approved or were skipped due to ANY ONE
// rule, its only showing one user's name instead of all. In L3 there are 7
// approvers but names are only shown of 1."
//
// Ground truth this suite is modelled on (stage, PO 29 / approval instance 253):
//   L1  ANY  APPROVED  1 approver  (Vineet I, APPROVED)
//   L2  ALL  APPROVED  1 approver  (Vineet II, APPROVED)
//   L3  ALL  PENDING   7 approvers (1 APPROVED, 6 PENDING)  <- the reported bug
// The trail collapsed each level to one `by` name plus the string "7 approvers".
//
// Product-level tests over real HTTP (supertest -> buildTestApp) against the
// local Postgres seed, hitting GET /api/v1/po/detail/:po_id. Every assertion is
// on the observable response body; nothing here reaches into the model.
//
// TENANT SCOPE: same strategy as po.dashboard.test.js — no hospitality headers
// are sent, so poDashboardController.deriveScope() falls back to
// po.company_id === req.user.company_id, and a1_proc_buyer (company A) sees the
// seeded company-A PO.
//
// TWO-AGGREGATE INVARIANT (the thing most likely to regress): the model runs
// TWO approver aggregates per step — an active-only one that feeds the legacy
// `by` / `policy` / summary counts, and an unfiltered one that feeds the new
// `approvers[]` roster. Several tests below assert BOTH halves on the same
// response so that widening the active filter (or narrowing the roster) fails
// here rather than in production.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

afterAll(async () => {
  await closeDb();
});

// A real product_variant id from the staging snapshot so the detail endpoint's
// INNER JOIN tbl_product_variant resolves an item name.
let VARIANT_ID = 1;

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_ID = v.id;
});

// ---- Row tracking -----------------------------------------------------------
const inserted = {
  rfqIds: [],
  poIds: [],
  poProductIds: [],
  rfqProductIds: [],
  quoteIds: [],
  approvalInstanceIds: [],
  approvalStepIds: [],
  approverIds: [],
};

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.approverIds.length) {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE id = ANY($1::int[])`, [inserted.approverIds]);
  }
  if (inserted.approvalStepIds.length) {
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = ANY($1::int[])`, [inserted.approvalStepIds]);
  }
  if (inserted.poIds.length) {
    // Detach the instance from the PO before deleting the instance (FK safety).
    await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.approvalInstanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
  }
  if (inserted.poProductIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`, [inserted.poProductIds]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

// ---- Setup helpers ----------------------------------------------------------
let PO_NO = 7_100_000;
const nextPoNo = () => `ROSTER-PO-${++PO_NO}`;

async function makeRfqWithProductAndVendor() {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: oneDayAgo,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, 'Spec text', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, VARIANT_ID]
  );
  inserted.rfqProductIds.push(product.id);

  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT_ID, IDS.users.vendor_alpha]
  );

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, IDS.users.vendor_alpha]
  );
  inserted.quoteIds.push(quote.id);

  return { rfq_id, rfq_product_id: product.id, quote_id: quote.id };
}

async function makePo({ rfq_id, status = "pending_approval", rfq_product_ids = [], quote_ids = [], approvalInstanceId = null }) {
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, approval_instance_id,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, 100, $6, 100, $7, $8, $9, NOW(), NOW())
     RETURNING id`,
    [rfq_id, IDS.companies.A, nextPoNo(), status, rfq_product_ids, IDS.users.vendor_alpha,
      quote_ids, IDS.users.a1_proc_buyer, approvalInstanceId]
  );
  inserted.poIds.push(po.id);

  const line = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, $3, 2, 'NOS', 50, 100) RETURNING id`,
    [po.id, rfq_product_ids[0], quote_ids[0]]
  );
  inserted.poProductIds.push(line.id);

  return po.id;
}

/**
 * Author an approval instance from a declarative spec so each test states only
 * the shape it cares about.
 *
 *   steps: [{ rule, status, completed_at?, added_mid_flight?, removed_mid_flight?,
 *             approvers: [{ user, status, acted_at?, removed_at?, removal_reason?,
 *                           added_mid_flight?, comment? }] }]
 *
 * `comment` writes a matching tbl_approval_actions row (APPROVE/REJECT) carrying
 * the approver's own note, scoped to that step — the same way the live approve/
 * reject controller writes it.
 */
async function makeApproval({ instanceStatus = "PENDING", currentStep = 1, steps }) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
     VALUES ('PO', 0, $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [IDS.policies.A1_P1_PO, instanceStatus, currentStep, IDS.hospitality.A, IDS.hotels.A1,
      IDS.departments.proc, IDS.users.a1_proc_buyer, IDS.processes.A_P1]
  );
  inserted.approvalInstanceIds.push(inst.id);

  const stepIds = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status, completed_at,
          added_mid_flight, removed_mid_flight)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [inst.id, i + 1, s.rule, s.status, s.completed_at ?? null,
        !!s.added_mid_flight, !!s.removed_mid_flight]
    );
    inserted.approvalStepIds.push(step.id);
    stepIds.push(step.id);

    for (const a of s.approvers || []) {
      const row = await db.one(
        `INSERT INTO tbl_approval_step_approvers
           (approval_instance_step_id, approver_user_id, status, acted_at,
            removed_at, removal_reason, added_mid_flight)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [step.id, a.user, a.status, a.acted_at ?? null, a.removed_at ?? null,
          a.removal_reason ?? null, !!a.added_mid_flight]
      );
      inserted.approverIds.push(row.id);

      if (a.comment !== undefined) {
        await db.none(
          `INSERT INTO tbl_approval_actions
             (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
           VALUES ($1, $2, $3, $4, $5)`,
          [inst.id, step.id, a.user, a.status === "REJECTED" ? "REJECT" : "APPROVE", a.comment]
        );
      }
    }
  }
  return { instanceId: inst.id, stepIds };
}

// Wire the instance to a freshly created PO and read the trail back over HTTP.
async function detailFor({ instanceId, poStatus = "pending_approval" }) {
  const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
  const po_id = await makePo({
    rfq_id, status: poStatus, rfq_product_ids: [rfq_product_id],
    quote_ids: [quote_id], approvalInstanceId: instanceId,
  });
  await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instanceId]);

  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await client.get(`/api/v1/po/detail/${po_id}`);
  expect(res.status).toBe(200);
  return { po_id, body: res.body.data, level: (n) => res.body.data.workflow.find((w) => w.title === `L${n} approval`) };
}

const nameOf = async (userId) => (await db.one(`SELECT name FROM tbl_users WHERE id=$1`, [userId])).name;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ===========================================================================
// 1) The reported bug: a level with 7 approvers must return all 7.
// ===========================================================================
describe("GET /po/detail/:po_id — full approver roster per level", () => {
  it("an ALL level with 7 approvers where only 1 has acted returns all 7 with their individual statuses", async () => {
    // Exactly the shape of stage instance 253 step 268: ALL rule, still PENDING,
    // seven approvers, one of whom has already approved.
    const actor = IDS.users.a1_proc_poApp;
    const others = [
      IDS.users.a1_proc_finance,
      IDS.users.a1_proc_techApp,
      IDS.users.a1_proc_commApp,
      IDS.users.a1_proc_techEval,
      IDS.users.a1_proc_commEval,
      IDS.users.companyA_admin,
    ];
    const { instanceId } = await makeApproval({
      instanceStatus: "PENDING",
      currentStep: 1,
      steps: [{
        rule: "ALL",
        status: "PENDING",
        approvers: [
          { user: others[0], status: "PENDING" },
          { user: actor, status: "APPROVED", acted_at: "2026-05-05 07:39:22", comment: "Approved from my side" },
          { user: others[1], status: "PENDING" },
          { user: others[2], status: "PENDING" },
          { user: others[3], status: "PENDING" },
          { user: others[4], status: "PENDING" },
          { user: others[5], status: "PENDING" },
        ],
      }],
    });

    const { level } = await detailFor({ instanceId });
    const l1 = level(1);
    expect(l1).toBeDefined();

    // THE FIX: all seven names come back, not one.
    expect(l1.approvers).toHaveLength(7);
    expect(l1.approvers.map((a) => a.user_id).sort()).toEqual([actor, ...others].sort());
    for (const a of l1.approvers) expect(a.name).toBeTruthy();

    // ...with per-person statuses, not a single collapsed one.
    const byId = Object.fromEntries(l1.approvers.map((a) => [a.user_id, a]));
    expect(byId[actor].status).toBe("APPROVED");
    expect(byId[actor].effective_status).toBe("APPROVED");
    expect(byId[actor].acted_at).toMatch(ISO);
    expect(byId[actor].comment).toBe("Approved from my side");
    for (const u of others) {
      expect(byId[u].status).toBe("PENDING");
      // The step is still open, so these people genuinely still owe an action.
      expect(byId[u].effective_status).toBe("PENDING");
      expect(byId[u].acted_at).toBeNull();
      expect(byId[u].removed_at).toBeNull();
      expect(byId[u].removal_reason).toBeNull();
      expect(byId[u].added_mid_flight).toBe(false);
    }

    // The level identity + rule the frontend needs to say "1 of 7, all must approve".
    expect(l1.level).toBe(1);
    expect(l1.decision_rule).toBe("ALL");
    expect(l1.approver_summary).toEqual({
      total_active: 7, approved: 1, rejected: 0, pending: 6,
      not_required: 0, not_reached: 0, removed: 0,
    });
    expect(l1.step_added_mid_flight).toBe(false);
    expect(l1.step_removed_mid_flight).toBe(false);

    // Server order: the person who acted comes first, the rest keep row order.
    expect(l1.approvers[0].user_id).toBe(actor);

    // ADDITIVE ONLY — the legacy fields keep their exact previous values.
    expect(l1.by).toBe(await nameOf(actor));
    expect(l1.policy).toBe("7 approvers");
    expect(l1.status).toBe("current");
    expect(l1.reason).toBeNull();
  });

  it("carries designation/department so the panel can identify who each approver is", async () => {
    const { instanceId } = await makeApproval({
      steps: [{ rule: "ANY", status: "PENDING", approvers: [{ user: IDS.users.a1_proc_poApp, status: "PENDING" }] }],
    });
    const { level } = await detailFor({ instanceId });
    const a = level(1).approvers[0];
    expect(a).toHaveProperty("designation");
    expect(a).toHaveProperty("department");
    // a1_proc_poApp is seeded into the Procurement department.
    const dept = await db.oneOrNone(
      `SELECT d.title FROM tbl_user_department ud JOIN tbl_department d ON d.id = ud.department_id
        WHERE ud.user_id = $1 ORDER BY ud.id DESC LIMIT 1`,
      [IDS.users.a1_proc_poApp]
    );
    expect(a.department).toBe(dept ? dept.title : null);
  });

  it("non-approval nodes (PO created, Sent to vendor) are untouched — no roster fields leak onto them", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "approved", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);
    expect(res.status).toBe(200);

    const created = res.body.data.workflow.find((w) => w.title === "PO created");
    const sent = res.body.data.workflow.find((w) => w.title === "Sent to vendor");
    expect(created).toBeDefined();
    expect(sent).toBeDefined();
    for (const n of [created, sent]) {
      expect(n.approvers).toBeUndefined();
      expect(n.approver_summary).toBeUndefined();
      expect(n.decision_rule).toBeUndefined();
      expect(n.level).toBeUndefined();
    }
  });
});

// ===========================================================================
// 2) The "skipped due to ANY ONE rule" group the client asked about.
//     An ANY step that closed leaves the non-actors at literal PENDING forever
//     (736 such rows on stage). They are NOT waiting — they were never needed.
// ===========================================================================
describe("GET /po/detail/:po_id — ANY rule closed by one approval", () => {
  it("approvers who never acted on a closed ANY level report effective_status NOT_REQUIRED", async () => {
    const actor = IDS.users.a1_proc_poApp;
    const bystanders = [IDS.users.a1_proc_finance, IDS.users.a1_proc_techApp];
    const { instanceId } = await makeApproval({
      instanceStatus: "APPROVED",
      currentStep: 1,
      steps: [{
        rule: "ANY",
        status: "APPROVED",
        completed_at: "2026-05-05 07:39:22",
        approvers: [
          { user: actor, status: "APPROVED", acted_at: "2026-05-05 07:39:22", comment: "ok" },
          { user: bystanders[0], status: "PENDING" },
          { user: bystanders[1], status: "PENDING" },
        ],
      }],
    });

    const { level } = await detailFor({ instanceId, poStatus: "approved" });
    const l1 = level(1);

    // All three are listed — the two who never acted are not hidden.
    expect(l1.approvers).toHaveLength(3);
    const byId = Object.fromEntries(l1.approvers.map((a) => [a.user_id, a]));
    expect(byId[actor].status).toBe("APPROVED");
    expect(byId[actor].effective_status).toBe("APPROVED");
    for (const u of bystanders) {
      // The stored row still says PENDING — that value is passed through
      // unchanged, and the derived field is what says "never needed".
      expect(byId[u].status).toBe("PENDING");
      expect(byId[u].effective_status).toBe("NOT_REQUIRED");
      expect(byId[u].acted_at).toBeNull();
    }

    expect(l1.decision_rule).toBe("ANY");
    expect(l1.status).toBe("done");
    // The summary speaks the SAME vocabulary as the rows it summarises. It used
    // to count raw statuses and report `pending: 2` for this level while both
    // of those rows rendered "not required" — a spreadsheet built off the
    // summary would have claimed two people were holding up a closed order.
    expect(l1.approver_summary).toEqual({
      total_active: 3, approved: 1, rejected: 0, pending: 0,
      not_required: 2, not_reached: 0, removed: 0,
    });
    // Legacy fields unchanged: the one who acted is still the named actor.
    expect(l1.by).toBe(await nameOf(actor));
    expect(l1.policy).toBe("3 approvers");
  });

  it("the summary reconciles with the roster row-for-row on a closed ANY level", async () => {
    // The generic invariant behind the assertion above: whatever the rows say,
    // the summary is a tally OF THOSE ROWS. Anything else and an export would
    // contradict the page it was exported from.
    const actor = IDS.users.a1_proc_poApp;
    const bystanders = [IDS.users.a1_proc_finance, IDS.users.a1_proc_techApp, IDS.users.a1_proc_commApp];
    const tombstone = IDS.users.a1_proc_commEval;
    const { instanceId } = await makeApproval({
      instanceStatus: "APPROVED",
      currentStep: 1,
      steps: [{
        rule: "ANY",
        status: "APPROVED",
        completed_at: "2026-05-05 07:39:22",
        approvers: [
          { user: actor, status: "APPROVED", acted_at: "2026-05-05 07:39:22" },
          ...bystanders.map((u) => ({ user: u, status: "PENDING" })),
          { user: tombstone, status: "REMOVED", removed_at: "2026-05-04 10:00:00+00", removal_reason: "role_removed" },
        ],
      }],
    });

    const { level } = await detailFor({ instanceId, poStatus: "approved" });
    const l1 = level(1);
    const s = l1.approver_summary;

    // Tally the emitted roster by effective_status, excluding tombstones the
    // way every other derived value on the node does.
    const active = l1.approvers.filter((a) => a.status !== "REMOVED");
    const tally = (v) => active.filter((a) => a.effective_status === v).length;
    expect(s.total_active).toBe(active.length);
    expect(s.approved).toBe(tally("APPROVED"));
    expect(s.rejected).toBe(tally("REJECTED"));
    expect(s.pending).toBe(tally("PENDING"));
    expect(s.not_required).toBe(tally("NOT_REQUIRED"));
    expect(s.not_reached).toBe(tally("NOT_REACHED"));
    expect(s.removed).toBe(l1.approvers.filter((a) => a.status === "REMOVED").length);
    // ...and the five active buckets partition total_active exactly.
    expect(s.approved + s.rejected + s.pending + s.not_required + s.not_reached)
      .toBe(s.total_active);
    // Concretely, for this level.
    expect(s).toEqual({
      total_active: 4, approved: 1, rejected: 0, pending: 0,
      not_required: 3, not_reached: 0, removed: 1,
    });
  });
});

// ===========================================================================
// 3) REMOVED tombstones: visible in the roster, invisible to every derivation.
// ===========================================================================
describe("GET /po/detail/:po_id — REMOVED approvers", () => {
  it("a removed approver appears in approvers[] with its raw reason token + removal time", async () => {
    const live = IDS.users.a1_proc_poApp;
    const removed = IDS.users.a1_proc_finance;
    const { instanceId } = await makeApproval({
      steps: [{
        rule: "ALL",
        status: "PENDING",
        approvers: [
          { user: live, status: "PENDING" },
          { user: removed, status: "REMOVED", removed_at: "2026-06-01 10:00:00+00", removal_reason: "role_removed" },
        ],
      }],
    });

    const { level } = await detailFor({ instanceId });
    const l1 = level(1);

    // Present — the panel can now answer "who was removed, when, why".
    expect(l1.approvers).toHaveLength(2);
    const tomb = l1.approvers.find((a) => a.user_id === removed);
    expect(tomb).toBeDefined();
    expect(tomb.name).toBe(await nameOf(removed));
    expect(tomb.status).toBe("REMOVED");
    expect(tomb.effective_status).toBe("REMOVED");
    // RAW snake_case token — the frontend owns the human label.
    expect(tomb.removal_reason).toBe("role_removed");
    expect(tomb.removed_at).toMatch(ISO);
    // Tombstones sort last.
    expect(l1.approvers[l1.approvers.length - 1].user_id).toBe(removed);

    // ...and excluded from every derived value (the regression this guards).
    expect(l1.approver_summary.total_active).toBe(1);
    expect(l1.approver_summary.removed).toBe(1);
    expect(l1.approver_summary.pending).toBe(1);
    expect(l1.by).toBe(await nameOf(live));
    expect(l1.by).not.toBe(await nameOf(removed));
    // One ACTIVE approver -> no "N approvers" string, exactly as before.
    expect(l1.policy).toBeNull();
  });

  it("a policy_change removal is reported with its own token, not normalised", async () => {
    const { instanceId } = await makeApproval({
      steps: [{
        rule: "ANY",
        status: "PENDING",
        approvers: [
          { user: IDS.users.a1_proc_poApp, status: "PENDING" },
          { user: IDS.users.a1_proc_finance, status: "REMOVED", removed_at: "2026-06-01 10:00:00+00", removal_reason: "policy_change" },
        ],
      }],
    });
    const { level } = await detailFor({ instanceId });
    const tomb = level(1).approvers.find((a) => a.status === "REMOVED");
    expect(tomb.removal_reason).toBe("policy_change");
  });

  it("a step whose approvers are ALL removed still lists them, with total_active 0 and a null actor", async () => {
    const { instanceId } = await makeApproval({
      steps: [{
        rule: "ALL",
        status: "PENDING",
        approvers: [
          { user: IDS.users.a1_proc_poApp, status: "REMOVED", removed_at: "2026-06-01 10:00:00+00", removal_reason: "role_removed" },
          { user: IDS.users.a1_proc_finance, status: "REMOVED", removed_at: "2026-06-01 10:00:00+00", removal_reason: "policy_change" },
        ],
      }],
    });
    const { level } = await detailFor({ instanceId });
    const l1 = level(1);
    expect(l1.approvers).toHaveLength(2);
    expect(l1.approver_summary).toEqual({
      total_active: 0, approved: 0, rejected: 0, pending: 0,
      not_required: 0, not_reached: 0, removed: 2,
    });
    expect(l1.by).toBeNull();
    expect(l1.policy).toBeNull();
  });
});

// ===========================================================================
// 4) Mid-flight additions — "was this person always here, or added later?"
// ===========================================================================
describe("GET /po/detail/:po_id — mid-flight markers", () => {
  it("flags approvers and steps that were introduced after the instance started", async () => {
    const { instanceId } = await makeApproval({
      instanceStatus: "PENDING",
      currentStep: 1,
      steps: [{
        rule: "ALL",
        status: "PENDING",
        added_mid_flight: true,
        approvers: [
          { user: IDS.users.a1_proc_poApp, status: "PENDING" },
          { user: IDS.users.a1_proc_finance, status: "PENDING", added_mid_flight: true },
        ],
      }],
    });
    const { level } = await detailFor({ instanceId });
    const l1 = level(1);
    expect(l1.step_added_mid_flight).toBe(true);
    expect(l1.step_removed_mid_flight).toBe(false);
    const byId = Object.fromEntries(l1.approvers.map((a) => [a.user_id, a]));
    expect(byId[IDS.users.a1_proc_poApp].added_mid_flight).toBe(false);
    expect(byId[IDS.users.a1_proc_finance].added_mid_flight).toBe(true);
  });
});

// ===========================================================================
// 5) Steps that ended without every approver acting: REJECTED, CANCELLED,
//    SKIPPED. Nobody on these is still "waiting".
// ===========================================================================
describe("GET /po/detail/:po_id — closed levels that never reached everyone", () => {
  it("on a REJECTED level, approvers who never acted report NOT_REACHED and the rejecter carries their comment", async () => {
    const rejecter = IDS.users.a1_proc_poApp;
    const approved = IDS.users.a1_proc_finance;
    const untouched = [IDS.users.a1_proc_techApp, IDS.users.a1_proc_commApp];
    const { instanceId } = await makeApproval({
      instanceStatus: "REJECTED",
      currentStep: 1,
      steps: [{
        rule: "ALL",
        status: "REJECTED",
        completed_at: "2026-06-02 09:00:00",
        approvers: [
          { user: approved, status: "APPROVED", acted_at: "2026-06-01 09:00:00", comment: "fine by me" },
          { user: rejecter, status: "REJECTED", acted_at: "2026-06-02 09:00:00", comment: "capacity constraint" },
          { user: untouched[0], status: "PENDING" },
          { user: untouched[1], status: "PENDING" },
        ],
      }],
    });

    const { level } = await detailFor({ instanceId, poStatus: "rejected" });
    const l1 = level(1);
    const byId = Object.fromEntries(l1.approvers.map((a) => [a.user_id, a]));

    expect(l1.approvers).toHaveLength(4);
    expect(byId[rejecter].effective_status).toBe("REJECTED");
    expect(byId[rejecter].comment).toBe("capacity constraint");
    expect(byId[approved].effective_status).toBe("APPROVED");
    expect(byId[approved].comment).toBe("fine by me");
    for (const u of untouched) {
      expect(byId[u].status).toBe("PENDING");
      expect(byId[u].effective_status).toBe("NOT_REACHED");
    }
    // Acted-first ordering, oldest action first.
    expect(l1.approvers.map((a) => a.user_id).slice(0, 2)).toEqual([approved, rejecter]);

    // The two who never got a turn are counted as NOT_REACHED, matching the
    // effective_status on their own rows — not as two people still to act.
    expect(l1.approver_summary).toEqual({
      total_active: 4, approved: 1, rejected: 1, pending: 0,
      not_required: 0, not_reached: 2, removed: 0,
    });
    // Legacy behaviour intact: the node is rejected and surfaces the reason.
    expect(l1.status).toBe("rejected");
    expect(l1.reason).toBe("capacity constraint");
    expect(l1.by).toBe(await nameOf(rejecter));
  });

  it("a CANCELLED level renders as 'cancelled' — not as though it were still waiting on someone", async () => {
    // Regression guard: st.status === 'CANCELLED' had no branch in the node
    // status ladder and fell through to "pending". 84 cancelled steps exist on
    // stage, every one of them rendering as an open approval.
    const { instanceId } = await makeApproval({
      instanceStatus: "CANCELLED",
      currentStep: 1,
      steps: [{
        rule: "ALL",
        status: "CANCELLED",
        completed_at: "2026-06-03 09:00:00",
        approvers: [
          { user: IDS.users.a1_proc_poApp, status: "APPROVED", acted_at: "2026-06-01 09:00:00" },
          { user: IDS.users.a1_proc_finance, status: "PENDING" },
        ],
      }],
    });

    const { level } = await detailFor({ instanceId, poStatus: "cancelled" });
    const l1 = level(1);
    expect(l1.status).toBe("cancelled");
    expect(l1.status).not.toBe("pending");
    expect(l1.status).not.toBe("current");
    const byId = Object.fromEntries(l1.approvers.map((a) => [a.user_id, a]));
    expect(byId[IDS.users.a1_proc_poApp].effective_status).toBe("APPROVED");
    // The instance died before this person's turn — not "still waiting".
    expect(byId[IDS.users.a1_proc_finance].status).toBe("PENDING");
    expect(byId[IDS.users.a1_proc_finance].effective_status).toBe("NOT_REACHED");
  });

  it("a SKIPPED level still lists who would have approved it, marked NOT_REQUIRED", async () => {
    const { instanceId } = await makeApproval({
      instanceStatus: "PENDING",
      currentStep: 2,
      steps: [
        {
          rule: "ANY",
          status: "SKIPPED",
          approvers: [
            { user: IDS.users.a1_proc_finance, status: "PENDING" },
            { user: IDS.users.a1_proc_techApp, status: "PENDING" },
          ],
        },
        {
          rule: "ALL",
          status: "PENDING",
          approvers: [{ user: IDS.users.a1_proc_poApp, status: "PENDING" }],
        },
      ],
    });

    const { level } = await detailFor({ instanceId });
    const l1 = level(1);
    const l2 = level(2);

    expect(l1.status).toBe("skipped");
    expect(l1.level).toBe(1);
    expect(l1.approvers).toHaveLength(2);
    for (const a of l1.approvers) {
      expect(a.status).toBe("PENDING");
      expect(a.effective_status).toBe("NOT_REQUIRED");
    }
    expect(l1.approver_summary.total_active).toBe(2);

    // The live level is unaffected and still reports a genuine PENDING.
    expect(l2.status).toBe("current");
    expect(l2.level).toBe(2);
    expect(l2.approvers[0].effective_status).toBe("PENDING");
  });
});

// ===========================================================================
// 5b) effective_status is a CLOSED vocabulary. The renderers switch on it and
//     label anything unrecognised "Awaiting" — the single claim that is wrong
//     for every row this field exists to reclassify.
// ===========================================================================
describe("GET /po/detail/:po_id — effective_status vocabulary", () => {
  const VOCAB = ["APPROVED", "REJECTED", "PENDING", "REMOVED", "NOT_REQUIRED", "NOT_REACHED"];

  it("a SKIPPED approver row reports NOT_REQUIRED, not the raw token", async () => {
    // SKIPPED is not writable on an approver row today: tbl_approval_step_approvers'
    // CHECK permits PENDING/APPROVED/REJECTED/REMOVED and stage holds exactly
    // those four (1066/448/26/37, nothing else). But tbl_approval_instance_steps'
    // CHECK already permits SKIPPED and approvalPropagationService writes it
    // there, so it is the obvious next value to reach this column — and the
    // shape this guards against is any status the model does not recognise
    // being passed straight through to a renderer that has no case for it.
    // The PO page would call that person "Awaiting" while the RFQ stage panel
    // calls them "Not required": two pages, same approver, opposite claims.
    //
    // The constraint is the only thing standing between this branch and a real
    // test, so it is lifted for the width of this one test and restored from
    // its own catalogue definition in `finally`. The database is this run's
    // throwaway hospitality_test_<run id>.
    const con = await db.one(
      `SELECT conname, pg_get_constraintdef(oid) AS condef
         FROM pg_constraint
        WHERE conrelid = 'tbl_approval_step_approvers'::regclass
          AND contype = 'c' AND conname LIKE '%status%'`
    );
    await db.none(`ALTER TABLE tbl_approval_step_approvers DROP CONSTRAINT ${con.conname}`);
    try {
      const actor = IDS.users.a1_proc_poApp;
      const skipped = IDS.users.a1_proc_finance;
      const { instanceId, stepIds } = await makeApproval({
        instanceStatus: "APPROVED",
        currentStep: 1,
        steps: [{
          rule: "ANY",
          status: "APPROVED",
          completed_at: "2026-05-05 07:39:22",
          approvers: [{ user: actor, status: "APPROVED", acted_at: "2026-05-05 07:39:22" }],
        }],
      });
      const row = await db.one(
        `INSERT INTO tbl_approval_step_approvers
           (approval_instance_step_id, approver_user_id, status)
         VALUES ($1, $2, 'SKIPPED') RETURNING id`,
        [stepIds[0], skipped]
      );
      inserted.approverIds.push(row.id);

      const { level } = await detailFor({ instanceId, poStatus: "approved" });
      const l1 = level(1);
      const byId = Object.fromEntries(l1.approvers.map((a) => [a.user_id, a]));

      // The stored value is still reported verbatim — nothing is rewritten.
      expect(byId[skipped].status).toBe("SKIPPED");
      // ...but the derived field speaks the vocabulary the pages share.
      expect(byId[skipped].effective_status).toBe("NOT_REQUIRED");
      for (const a of l1.approvers) expect(VOCAB).toContain(a.effective_status);
      // A person who did not need to act is not "pending" in the tally either.
      expect(l1.approver_summary.pending).toBe(0);
      expect(l1.approver_summary.not_required).toBe(1);
      expect(l1.approver_summary.total_active).toBe(2);
    } finally {
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE status = 'SKIPPED'`);
      await db.none(
        `ALTER TABLE tbl_approval_step_approvers ADD CONSTRAINT ${con.conname} ${con.condef}`
      );
    }
  });

  it("every emitted effective_status across mixed levels stays inside the vocabulary", async () => {
    const { instanceId } = await makeApproval({
      instanceStatus: "PENDING",
      currentStep: 3,
      steps: [
        {
          rule: "ANY", status: "APPROVED", completed_at: "2026-05-05 07:39:22",
          approvers: [
            { user: IDS.users.a1_proc_poApp, status: "APPROVED", acted_at: "2026-05-05 07:39:22" },
            { user: IDS.users.a1_proc_finance, status: "PENDING" },
          ],
        },
        {
          rule: "ALL", status: "CANCELLED", completed_at: "2026-05-06 07:39:22",
          approvers: [{ user: IDS.users.a1_proc_techApp, status: "PENDING" }],
        },
        {
          rule: "ALL", status: "PENDING",
          approvers: [
            { user: IDS.users.a1_proc_commApp, status: "PENDING" },
            { user: IDS.users.a1_proc_commEval, status: "REMOVED", removed_at: "2026-05-06 07:39:22", removal_reason: "policy_change" },
          ],
        },
      ],
    });
    const { body } = await detailFor({ instanceId });
    const rows = body.workflow.flatMap((w) => w.approvers || []);
    expect(rows.length).toBe(5);
    for (const a of rows) expect(VOCAB).toContain(a.effective_status);
  });
});

// ===========================================================================
// 6) Comments are scoped to the level they were written on — the same person
//    legitimately sits on more than one level (stage instance 253 has Vineet I
//    on both L1 and L3), so a user-only match would smear one note onto both.
// ===========================================================================
describe("GET /po/detail/:po_id — per-approver comments are per level", () => {
  it("the same approver on two levels gets each level's own comment", async () => {
    const dual = IDS.users.a1_proc_poApp;
    const { instanceId } = await makeApproval({
      instanceStatus: "PENDING",
      currentStep: 3,
      steps: [
        {
          rule: "ANY", status: "APPROVED", completed_at: "2026-05-05 07:39:22",
          approvers: [{ user: dual, status: "APPROVED", acted_at: "2026-05-05 07:39:22", comment: "L1 note" }],
        },
        {
          rule: "ALL", status: "APPROVED", completed_at: "2026-06-04 08:06:56",
          approvers: [{ user: dual, status: "APPROVED", acted_at: "2026-06-04 08:06:56", comment: "L2 note" }],
        },
        {
          rule: "ALL", status: "PENDING",
          approvers: [
            { user: dual, status: "APPROVED", acted_at: "2026-06-04 08:06:56", comment: "L3 note" },
            { user: IDS.users.a1_proc_finance, status: "PENDING" },
          ],
        },
      ],
    });

    const { level } = await detailFor({ instanceId });
    expect(level(1).approvers[0].comment).toBe("L1 note");
    expect(level(2).approvers[0].comment).toBe("L2 note");
    expect(level(3).approvers.find((a) => a.user_id === dual).comment).toBe("L3 note");
    // Someone who never acted has no comment, rather than inheriting one.
    expect(level(3).approvers.find((a) => a.user_id === IDS.users.a1_proc_finance).comment).toBeNull();
  });
});

// ===========================================================================
// 6) Confidentiality: the roster is BUYER-ONLY.
//
// A vendor is an external counterparty. The buyer's internal approval chain —
// who sits at each level, their designation and department, when each acted,
// why one was removed, and above all the free-text comment each approver wrote
// to the next — must never reach them. The vendor still gets the trail's SHAPE
// (level, status, timestamps) so "where has my PO got to" keeps working.
//
// This mirrors the existing `comparison` gate on the same endpoint, which
// suppresses competitors' quote amounts for the same reason. The roster shipped
// without one; this pins it.
// ===========================================================================
describe("GET /po/vendor/detail/:po_id — approver roster is redacted for vendors", () => {
  it("gives the vendor the approval levels but never the approvers, their details or their comments", async () => {
    const { instanceId } = await makeApproval({
      currentStep: 2,
      steps: [
        {
          rule: "ANY", status: "APPROVED", completed_at: "2026-05-05 07:39:22",
          approvers: [{
            user: IDS.users.a1_proc_buyer, status: "APPROVED",
            acted_at: "2026-05-05 07:39:22", comment: "Rate looks high, approving under protest",
          }],
        },
        {
          rule: "ALL", status: "PENDING",
          approvers: [{ user: IDS.users.a1_proc_finance, status: "PENDING" }],
        },
      ],
    });

    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({
      rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: instanceId,
    });
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instanceId]);

    // The buyer sees the whole roster…
    const buyer = await httpClient(IDS.users.a1_proc_buyer);
    const buyerRes = await buyer.get(`/api/v1/po/detail/${po_id}`);
    expect(buyerRes.status).toBe(200);
    const buyerL1 = buyerRes.body.data.workflow.find((w) => w.title === "L1 approval");
    expect(buyerL1.approvers).toHaveLength(1);
    expect(buyerL1.approvers[0].comment).toBe("Rate looks high, approving under protest");

    // …the vendor, on the same PO, sees none of it.
    // The vendor routes are acl([3]); the shared fixture user is not guaranteed
    // to carry that user_type, so assert it the way po.vendor.module.test.js does.
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [IDS.users.vendor_alpha]);
    const vendor = await httpClient(IDS.users.vendor_alpha);
    const vendorRes = await vendor.get(`/api/v1/po/vendor/detail/${po_id}`);
    expect(vendorRes.status).toBe(200);

    const levels = vendorRes.body.data.workflow.filter((w) => /^L\d+ approval$/.test(w.title));
    expect(levels).toHaveLength(2);
    for (const lvl of levels) {
      // Omitted, not emptied — an empty array would assert "this level has no
      // approvers", which is a different and false claim.
      expect(lvl).not.toHaveProperty("approvers");
      expect(lvl).not.toHaveProperty("approver_summary");
      // The shape a vendor legitimately needs survives.
      expect(lvl.status).toBeTruthy();
      expect(lvl).toHaveProperty("level");
    }

    // The activity feed leaked the same thing by another route — the vendor PO
    // detail page renders `activity`, and every APPROVE/REJECT entry named the
    // approver and quoted their note. Internal approval chatter is redacted;
    // the vendor-side lifecycle it actually needs is not.
    const vendorActivity = vendorRes.body.data.activity || [];
    expect(vendorActivity.some((a) => a.type === "approval" || a.type === "rejection")).toBe(false);
    expect(vendorActivity.some((a) => a.type === "created")).toBe(true);

    // Belt and braces: the approver's private note must not appear ANYWHERE in
    // the vendor payload, however the shape is later refactored.
    expect(JSON.stringify(vendorRes.body)).not.toContain("approving under protest");
  });
});
