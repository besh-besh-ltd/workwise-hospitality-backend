// Closing an RFQ must cancel its pending PO approvals AND the POs themselves.
// ----------------------------------------------------------------------------
// The defect: closeRFQ cancelled every pending approval instance hanging off
// the RFQ, including PO approvals, but never touched the PO row. The PO stayed
// at 'pending_approval' with nothing pending behind it — on every PO screen as
// awaiting approval, actionable by nobody. On prod on 22 Sep 2026, 22 of the
// 29 POs showing "pending approval" were exactly this.
//
// The cancellation was also written as action 'REJECT' with a '[CANCELLED]'
// comment, so anything counting rejections counted closed RFQs: 69 prod
// "rejections" where 47 were real.
//
// Product-level: the close goes through the real route over HTTP. The backfill
// half runs the actual migration file against seeded orphans, so the SQL that
// will run on prod is the SQL under test.

import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKFILL = path.resolve(
  __dirname, "..", "..", "migrations", "20260922101000_po_cancelled_on_rfq_close_backfill.sql"
);

const BUYER = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_poApp;

let VARIANT_ID = 1;
let POLICY_ID = null;
let POLICY_STEP_ID = null;
let buyerTypeBefore = null;

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_ID = v.id;

  // /rfq/close-rfq sits behind acl([2, 8]); fixture users carry a NULL
  // user_type, which would 403 before the code under test ever ran.
  const u = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [BUYER]);
  buyerTypeBefore = u.user_type;
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);

  const pol = await db.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by)
     VALUES ('PO', $1, $2, $3, true, $4) RETURNING id`,
    [IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.users.superAdmin]
  );
  POLICY_ID = Number(pol.id);
  const st = await db.one(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'USER', $2) RETURNING id`,
    [POLICY_ID, APPROVER]
  );
  POLICY_STEP_ID = Number(st.id);
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = $1 WHERE id = $2`, [buyerTypeBefore, BUYER]);
  if (POLICY_ID) {
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
  }
  await closeDb();
});

const made = { rfqIds: [], poIds: [], rfqProductIds: [], quoteIds: [], instanceIds: [] };
beforeEach(() => { for (const k of Object.keys(made)) made[k] = []; });

afterEach(async () => {
  if (made.instanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [made.instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [made.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [made.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [made.instanceIds]);
  }
  // closeRFQ may create instances we did not track (it only cancels, but be
  // defensive about anything keyed to our POs).
  if (made.poIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [made.poIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [made.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [made.poIds]);
  }
  if (made.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [made.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [made.quoteIds]);
  }
  if (made.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [made.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [made.rfqProductIds]);
  }
  if (made.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [made.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [made.rfqIds]);
  }
});

let PO_NO = 9_950_000;

async function openRfq() {
  const later = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER, status: 1, is_published: 1, bid_end_date: later,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
  });
  made.rfqIds.push(rfq_id);
  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1,'Spec','','','','',$2,0) RETURNING id`,
    [rfq_id, VARIANT_ID]
  );
  made.rfqProductIds.push(product.id);
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1,$2,$3,0)`,
    [rfq_id, VARIANT_ID, IDS.users.vendor_alpha]
  );
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING id`,
    [rfq_id, rfq_no, IDS.users.vendor_alpha]
  );
  made.quoteIds.push(quote.id);
  return { rfq_id, rfq_product_id: product.id, quote_id: quote.id };
}

async function makePo(rfq, status) {
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,1,100,$6,5000,$7,$8,NOW(),NOW()) RETURNING id`,
    [rfq.rfq_id, IDS.companies.A, `CLOSE-PO-${++PO_NO}`, status, [rfq.rfq_product_id],
     IDS.users.vendor_alpha, [rfq.quote_id], BUYER]
  );
  made.poIds.push(po.id);
  return Number(po.id);
}

/** A PO approval instance: PENDING with a live step, or already concluded. */
async function makeInstance(poId, status = "PENDING") {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, created_at, completed_at)
     VALUES ('PO', $1, $2, $3, 1, $4, $5, $6, $7, NOW(),
             CASE WHEN $3 = 'PENDING' THEN NULL ELSE NOW() END)
     RETURNING id`,
    [poId, POLICY_ID, status, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, BUYER]
  );
  made.instanceIds.push(Number(inst.id));
  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, policy_step_id, step_order, decision_rule, status, created_at)
     VALUES ($1, $2, 1, 'ANY', $3, NOW()) RETURNING id`,
    [inst.id, POLICY_STEP_ID, status === "PENDING" ? "PENDING" : status]
  );
  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [step.id, APPROVER, status === "PENDING" ? "PENDING" : "APPROVED"]
  );
  return Number(inst.id);
}

const poStatus = async (id) =>
  (await db.one(`SELECT status::text AS s FROM tbl_rfq_purchase_order WHERE id = $1`, [id])).s;

const actionsOn = (instanceId) =>
  db.any(`SELECT action, comment FROM tbl_approval_actions WHERE approval_instance_id = $1 ORDER BY id`, [instanceId]);

async function closeRfq(rfqId, comment) {
  const client = await httpClient(BUYER);
  return client.post(`/api/v1/rfq/close-rfq/${rfqId}`).send({ comment });
}

describe("POST /rfq/close-rfq — pending PO approvals", () => {
  it("moves the PO to 'cancelled' instead of leaving it pending forever", async () => {
    const rfq = await openRfq();
    const po = await makePo(rfq, "pending_approval");
    await makeInstance(po, "PENDING");

    const res = await closeRfq(rfq.rfq_id, "specs changed");
    expect(res.status).toBe(200);

    expect(await poStatus(po)).toBe("cancelled");
  });

  it("records a CANCELLED action, not a rejection, carrying the close reason", async () => {
    const rfq = await openRfq();
    const po = await makePo(rfq, "pending_approval");
    const inst = await makeInstance(po, "PENDING");

    await closeRfq(rfq.rfq_id, "configuration does not match");

    const acts = await actionsOn(inst);
    // No REJECT: counting this as a rejection is what inflated prod's figure.
    expect(acts.map((a) => a.action)).toEqual(["CANCELLED"]);
    expect(acts[0].comment).toBe("[CANCELLED] RFQ closed by creator: configuration does not match");

    const i = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [inst]);
    expect(i.status).toBe("CANCELLED");
  });

  it("leaves an already-approved PO on the same RFQ exactly as it was", async () => {
    const rfq = await openRfq();
    const approved = await makePo(rfq, "approved");
    await makeInstance(approved, "APPROVED");
    const pending = await makePo(rfq, "pending_approval");
    await makeInstance(pending, "PENDING");

    await closeRfq(rfq.rfq_id, "no longer needed");

    // Closing an RFQ must never un-approve an order that already went through.
    expect(await poStatus(approved)).toBe("approved");
    expect(await poStatus(pending)).toBe("cancelled");
  });
});

describe("migration 20260922101000 — backfill of the existing orphans", () => {
  const runBackfill = () => db.none(fs.readFileSync(BACKFILL, "utf8"));

  /** The pre-fix shape: cancelled instance, REJECT action, PO left pending. */
  async function legacyOrphan(rfq, comment) {
    const po = await makePo(rfq, "pending_approval");
    const inst = await makeInstance(po, "CANCELLED");
    await db.none(
      `INSERT INTO tbl_approval_actions (approval_instance_id, approver_user_id, action, comment)
       VALUES ($1, $2, 'REJECT', $3)`,
      [inst, BUYER, comment]
    );
    return po;
  }

  it("cancels a PO orphaned by an RFQ closure", async () => {
    const rfq = await openRfq();
    const po = await legacyOrphan(rfq, "[CANCELLED] RFQ closed by creator: budget moved");

    await runBackfill();
    expect(await poStatus(po)).toBe("cancelled");
  });

  it("does not touch a PO that still has a live approval", async () => {
    const rfq = await openRfq();
    const po = await makePo(rfq, "pending_approval");
    await makeInstance(po, "PENDING");

    await runBackfill();
    expect(await poStatus(po)).toBe("pending_approval");
  });

  it("does not touch an orphan whose cancellation had some other cause", async () => {
    // The narrow predicate on purpose: anything that is not an RFQ closure is
    // left for a person to look at rather than swept up.
    const rfq = await openRfq();
    const po = await legacyOrphan(rfq, "[CANCELLED] Publish request withdrawn by creator");

    await runBackfill();
    expect(await poStatus(po)).toBe("pending_approval");
  });

  it("is safe to run twice", async () => {
    const rfq = await openRfq();
    const po = await legacyOrphan(rfq, "[CANCELLED] RFQ closed by creator");

    await runBackfill();
    await runBackfill();
    expect(await poStatus(po)).toBe("cancelled");
  });
});
