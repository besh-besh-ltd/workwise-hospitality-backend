// Wave: GET /api/v1/rfq/quote-comparison-view/:id  →  `stage_actors`
// ----------------------------------------------------------------------------
// The buyer standing in front of the comparison sheet has to know ONE thing
// before anything else on the page matters: whose move is it? The RFQ workspace
// answers that in a strip that truncates to "three names +4"; the banner above
// the comparison table must not truncate, and must say plainly when the viewer
// is one of the named people.
//
// This suite pins the contract that makes that renderable:
//
//   stage_actors: {
//     stage_label, role_label, decision_rule,
//     actors: [{ user_id, name, role, is_me }],
//     next: { stage_label, role_label, actors: [{ user_id, name, role }] } | null
//   } | null
//
// and the two properties that keep it honest:
//
//   1. IDENTITY IS AN ID, NOT A NAME. `is_me` is decided server-side from the
//      authenticated caller against tbl_users.id. Two people called "Amit
//      Sharma" must not both light up as "you".
//   2. IT SITS BEHIND THE PRE-DEADLINE LOCK. Before bid_end_date passes,
//      quoteCompareViewModel already blanks every cell, every vendor name and
//      `p.approval` wholesale. Who will evaluate and who will approve is data of
//      exactly that kind, so it must be absent too — not merely hidden by the
//      client.
//
// Product-level throughout: everything is asserted through real HTTP against
// the seeded local Postgres, never against internal call wiring.
//
// Run:
//   TEST_RUN_ID=<unique> npm test -- --testPathPatterns "quoteComparisonView.stageActors"

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

const HOSP_HEADER = "x-hospitality-company";
const url = (rfqId) => `/api/v1/rfq/quote-comparison-view/${rfqId}`;

let VARIANT_A = 1;

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_A = v.id;
});

// ---- Row tracking -----------------------------------------------------------
const inserted = {
  rfqIds: [], rfqProductIds: [], quoteIds: [],
  finalizationIds: [], approvalInstanceIds: [],
};

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.approvalInstanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id IN (
          SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [inserted.approvalInstanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
  }
  if (inserted.finalizationIds.length) {
    await db.none(`DELETE FROM tbl_quote_finalization WHERE id = ANY($1::int[])`, [inserted.finalizationIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

// ---- Seeding ----------------------------------------------------------------

// bid_end_date is naive IST wall-clock text, and the lifecycle SQL compares it
// against (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'). Building the string
// from the SESSION's IST clock rather than the Node process clock keeps
// "3 hours ago" meaning three hours ago under a UTC session too (CI), where
// new Date() would be 5h30m adrift and silently flip the lock.
const istOffsetString = async (interval) => {
  const r = await db.one(
    `SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') + $1::interval,
                    'YYYY-MM-DD HH24:MI:SS') AS ts`,
    [interval]
  );
  return r.ts;
};

async function seedRfq({ bidEnd }) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: bidEnd,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  const p = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, VARIANT_A]
  );
  inserted.rfqProductIds.push(p.id);

  // One vendor quote — an RFQ with zero eligible quoters is "stuck", not
  // "under commercial evaluation", and would resolve a different actor set.
  const vendorId = IDS.users.vendor_alpha;
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
    [rfq_id, VARIANT_A, vendorId]
  );
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`,
    [rfq_id, rfq_no, vendorId]
  );
  inserted.quoteIds.push(q.id);
  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
     VALUES ($1, $2, $3, $4, 100, 1000, 0, 18, 0, 0, '', '7', '10', 'percentage', '[]')`,
    [rfq_id, rfq_no, q.id, VARIANT_A]
  );

  return { rfq_id, rfq_no, rfq_product_id: p.id, quote_id: q.id, vendorId };
}

// Park the RFQ on QUOTATION_APPROVAL: a finalized product whose NEGOTIATION_QUOTE
// instance is still PENDING. `approvers` is a list of user ids on one step, so a
// multi-approver step can be asserted in full (no truncation anywhere).
async function seedPendingQuoteApproval(
  { rfq_id, rfq_no, rfq_product_id, quote_id, vendorId },
  approvers,
  decisionRule = "ANY"
) {
  const fin = await db.one(
    `INSERT INTO tbl_quote_finalization
       (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, variant)
     VALUES ($1, $2, $3, $4, $5, $6, 0) RETURNING id`,
    [rfq_id, rfq_no, quote_id, VARIANT_A, vendorId, IDS.users.a1_proc_buyer]
  );
  inserted.finalizationIds.push(fin.id);

  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id, metadata)
     VALUES ('NEGOTIATION_QUOTE', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id`,
    [
      rfq_product_id, IDS.policies.A1_P1_NEGOTIATION_QUOTE,
      IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc,
      IDS.users.a1_proc_buyer, IDS.processes.A_P1,
      JSON.stringify({ rfq_id }),
    ]
  );
  inserted.approvalInstanceIds.push(inst.id);

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, $2, 'PENDING') RETURNING id`,
    [inst.id, decisionRule]
  );
  for (const uid of approvers) {
    // acted_at/created_at are naive timestamps holding IST wall-clock — stamp
    // through the session's IST clock, never NOW() (UTC under CI).
    await db.none(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status, created_at)
       VALUES ($1, $2, 'PENDING', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'))`,
      [step.id, uid]
    );
  }
  return inst.id;
}

const fetchView = async (userId, rfqId) => {
  const client = await httpClient(userId);
  return client.get(url(rfqId)).set(HOSP_HEADER, String(IDS.hospitality.A));
};

// ---- Tests ------------------------------------------------------------------

describe("GET /rfq/quote-comparison-view/:id — stage_actors", () => {
  it("names every commercial evaluator on an RFQ under evaluation", async () => {
    const rfq = await seedRfq({ bidEnd: await istOffsetString("-3 hours") });

    const res = await fetchView(IDS.users.a1_proc_buyer, rfq.rfq_id);
    expect(res.status).toBe(200);

    const sa = res.body.stage_actors;
    expect(sa).toBeTruthy();
    expect(sa.stage_label).toBe("Negotiation & Award");
    expect(sa.role_label).toBe("Commercial Evaluators");
    expect(Array.isArray(sa.actors)).toBe(true);
    expect(sa.actors.length).toBeGreaterThan(0);

    // Every actor is nameable AND matchable. A banner that has to say "you are
    // one of these people" cannot do it on a name.
    for (const a of sa.actors) {
      expect(Number.isInteger(a.user_id)).toBe(true);
      expect(typeof a.name).toBe("string");
      expect(a.name.length).toBeGreaterThan(0);
      expect(a).toHaveProperty("role");
      expect(typeof a.is_me).toBe("boolean");
    }

    // The seeded commercial negotiator holds quote-compare read+create on A-1
    // and must be among them.
    expect(sa.actors.map((a) => a.user_id)).toContain(IDS.users.a1_proc_commEval);

    // No identity beyond what the banner needs — emails in particular never
    // travel with an actor.
    for (const a of sa.actors) {
      expect(Object.keys(a).sort()).toEqual(["is_me", "name", "role", "user_id"]);
    }

    // "Up next" points past this stage, and carries no is_me: nobody is being
    // asked to act there yet.
    expect(sa.next).toBeTruthy();
    expect(sa.next.stage_label).toBe("Purchase Order");
    expect(sa.next.actors.length).toBeGreaterThan(0);
    for (const a of sa.next.actors) {
      expect(Object.keys(a).sort()).toEqual(["name", "role", "user_id"]);
    }
  });

  it("names every pending approver, with the step's decision rule, once a product is awaiting approval", async () => {
    const rfq = await seedRfq({ bidEnd: await istOffsetString("-3 hours") });
    await seedPendingQuoteApproval(
      rfq,
      [IDS.users.a1_proc_commApp, IDS.users.a1_proc_finance],
      "ALL"
    );

    const res = await fetchView(IDS.users.a1_proc_buyer, rfq.rfq_id);
    expect(res.status).toBe(200);

    const sa = res.body.stage_actors;
    expect(sa).toBeTruthy();
    expect(sa.stage_label).toBe("Negotiation & Award");
    expect(sa.role_label).toBe("Pending Approvers");
    expect(sa.decision_rule).toBe("ALL");

    // BOTH approvers, not a truncated head of the list — the whole point of the
    // banner is that "+1" is never enough to know whether you have to act.
    const ids = sa.actors.map((a) => a.user_id).sort();
    expect(ids).toEqual([IDS.users.a1_proc_commApp, IDS.users.a1_proc_finance].sort());
  });

  it("marks is_me on exactly the caller, and on nobody else", async () => {
    const rfq = await seedRfq({ bidEnd: await istOffsetString("-3 hours") });
    await seedPendingQuoteApproval(
      rfq,
      [IDS.users.a1_proc_commApp, IDS.users.a1_proc_finance],
      "ALL"
    );

    // Viewed by an approver: their own row is flagged, the co-approver's is not.
    const mine = await fetchView(IDS.users.a1_proc_commApp, rfq.rfq_id);
    expect(mine.status).toBe(200);
    const flagged = mine.body.stage_actors.actors.filter((a) => a.is_me);
    expect(flagged.map((a) => a.user_id)).toEqual([IDS.users.a1_proc_commApp]);

    // Viewed by the buyer, who is on neither step: nobody is "you", even though
    // the same names are listed.
    const theirs = await fetchView(IDS.users.a1_proc_buyer, rfq.rfq_id);
    expect(theirs.status).toBe(200);
    expect(theirs.body.stage_actors.actors.some((a) => a.is_me)).toBe(false);
    expect(theirs.body.stage_actors.actors.length).toBe(2);
  });

  it("withholds actors entirely while quotes are locked", async () => {
    // Deadline three hours away → the same pre-deadline lock that blanks every
    // cell, every vendor name and p.approval.
    const rfq = await seedRfq({ bidEnd: await istOffsetString("3 hours") });

    const res = await fetchView(IDS.users.a1_proc_buyer, rfq.rfq_id);
    expect(res.status).toBe(200);
    expect(res.body.quotes_locked).toBe(true);
    expect(res.body.stage_actors).toBeNull();

    // Guard the risk, not just the field name. Evaluator identity is the class
    // of data this feature newly surfaces, and it must not reach a locked
    // payload by any route — not stage_actors, not a stray field elsewhere.
    //
    // Approver identity is deliberately NOT asserted here: `approval_chain`
    // already names the policy's USER-source approver before the deadline, and
    // has since it shipped. That is pre-existing behaviour on a different field;
    // this feature neither widens nor relies on it, and stage_actors is strictly
    // stricter (absent, not merely blanked).
    const serialized = JSON.stringify(res.body);
    const evaluator = await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [
      IDS.users.a1_proc_commEval,
    ]);
    expect(serialized).not.toContain(evaluator.name);
  });
});
