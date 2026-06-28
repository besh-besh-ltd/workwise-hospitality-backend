// ARC submission-close sweep — behavioural integration tests.
//
// runArcSubmissionCloseSweep flips floated ARCs whose submission_end_at has
// passed to 'submission_closed' and notifies:
//   · BUYER: creator (in-app) + NEXT-STAGE evaluators (in-app + email) — tech
//     evaluators if the ARC has tech clauses, else commercial.
//   · VENDOR: invited vendors get an in-app "submissions closed" info (no email).
//
// Real Postgres; nodemailer/sendMail stubbed (jestEnv + common.js mock).
// Separate tech/comm evaluator roles are seeded so routing is observable.

import { describe, test, expect, beforeAll, afterAll, jest } from "@jest/globals";

const mailCalls = [];
jest.unstable_mockModule("../../../app/helper/common.js", () => ({
  sendMail: async (opts) => { mailCalls.push(opts); return { messageId: "<test-mock-mail>" }; },
  logError: (..._args) => { /* swallow */ },
}));

const { runArcSubmissionCloseSweep } = await import("../../../app/services/arcSubmissionCloseService.js");

import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const BUYER     = IDS.users.a1_proc_buyer;
const TECH_EVAL = IDS.users.a1_proc_techEval;
const COMM_EVAL = IDS.users.a1_proc_commEval;
const VENDOR    = IDS.users.vendor_alpha;
const HOTEL     = IDS.hotels.A1;
const DEPT      = IDS.departments.proc;
const HC        = IDS.hospitality.A;
const CATEGORY  = TEST_CATEGORIES.beverages;
const PROC      = IDS.processes.A_P1;

// Separate roles so TECH_EVAL holds only arc-tech and COMM_EVAL only arc-comm.
const SC_TECH_ROLE = 95300, SC_COMM_ROLE = 95301;
const SC_PERMS = {
  tech_eval: { id: 95310, resource: "arc-tech", action: "evaluate" },
  comm_eval: { id: 95311, resource: "arc-comm", action: "evaluate" },
};
const SC_SCOPE_TECH = 95320, SC_SCOPE_COMM = 95321;

const now = new Date();
function plusDays(n) {
  const d = new Date(now); d.setDate(d.getDate() + n); return d.toISOString();
}
const createdArcIds = [];

async function seedRoles() {
  for (const p of Object.values(SC_PERMS)) {
    await db.none(`INSERT INTO tbl_permissions (id, resource, action, ordering)
                   VALUES ($1,$2,$3,0) ON CONFLICT (id) DO NOTHING`, [p.id, p.resource, p.action]);
  }
  await db.none(`INSERT INTO tbl_roles (id, title, description, created_by)
                 VALUES ($1,'SC Tech Eval','arc-tech only',NULL) ON CONFLICT (id) DO NOTHING`, [SC_TECH_ROLE]);
  await db.none(`INSERT INTO tbl_roles (id, title, description, created_by)
                 VALUES ($1,'SC Comm Eval','arc-comm only',NULL) ON CONFLICT (id) DO NOTHING`, [SC_COMM_ROLE]);
  await db.none(`INSERT INTO tbl_role_permissions (role_id, permission_id)
                 SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM tbl_role_permissions WHERE role_id=$1 AND permission_id=$2)`,
                [SC_TECH_ROLE, SC_PERMS.tech_eval.id]);
  await db.none(`INSERT INTO tbl_role_permissions (role_id, permission_id)
                 SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM tbl_role_permissions WHERE role_id=$1 AND permission_id=$2)`,
                [SC_COMM_ROLE, SC_PERMS.comm_eval.id]);
  await db.none(`INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
                 VALUES ($1,$2,$3,$4,$5,NULL) ON CONFLICT (id) DO NOTHING`, [SC_SCOPE_TECH, TECH_EVAL, SC_TECH_ROLE, HC, HOTEL]);
  await db.none(`INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
                 VALUES ($1,$2,$3,$4,$5,NULL) ON CONFLICT (id) DO NOTHING`, [SC_SCOPE_COMM, COMM_EVAL, SC_COMM_ROLE, HC, HOTEL]);
}
async function cleanupRoles() {
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE id IN ($1,$2)`, [SC_SCOPE_TECH, SC_SCOPE_COMM]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id IN ($1,$2)`, [SC_TECH_ROLE, SC_COMM_ROLE]);
  await db.none(`DELETE FROM tbl_roles WHERE id IN ($1,$2)`, [SC_TECH_ROLE, SC_COMM_ROLE]);
  await db.none(`DELETE FROM tbl_permissions WHERE id IN ($1,$2)`, [SC_PERMS.tech_eval.id, SC_PERMS.comm_eval.id]);
}

async function insertFloatedArc({ submissionEndAt, label, withTechClause = false }) {
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
        process_id, status, created_by,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at,
        eligibility_type, escalation_clause_json, sub_category_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'floated',$8,
        NOW() - INTERVAL '10 days', $9::timestamp, NOW() + INTERVAL '20 days', NOW() + INTERVAL '200 days',
        'open','{}'::jsonb,'[]'::jsonb)
     RETURNING id`,
    [`ARC-SC-${label}-${Date.now()}`, `Submission Close ${label}`, CATEGORY, HC, HOTEL, DEPT, PROC, BUYER, submissionEndAt]
  );
  const arcId = Number(arc.id);
  createdArcIds.push(arcId);
  // invited vendor (so the vendor info notice has a recipient)
  await db.none(`INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
                 VALUES ($1,$2,'invited') ON CONFLICT (arc_id, vendor_id) DO NOTHING`, [arcId, VENDOR]);
  if (withTechClause) {
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, 1, 100, 'litre') RETURNING id`, [arcId]);
    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [item.id]);
    await db.none(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, 'Spec compliance', 10, 'compliance')`, [te.id]);
  }
  return arcId;
}

async function notifRows(arcId) {
  return db.any(
    `SELECT recipient_user_id, type, message FROM tbl_notifications
      WHERE additional_data->>'arc_id' = $1 AND type = 'SUBMISSION_CLOSED'
      ORDER BY recipient_user_id`, [String(arcId)]);
}
async function arcStatus(arcId) {
  return (await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId])).status;
}
async function emailOf(userId) {
  return (await db.one(`SELECT email FROM tbl_users WHERE id = $1`, [userId])).email;
}

beforeAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
  await seedRoles();
});

afterAll(async () => {
  for (const arcId of createdArcIds) {
    await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`, [String(arcId)]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_clauses c
                    USING tbl_arc_item_tech_evaluation te, tbl_arc_item i
                    WHERE c.arc_item_tech_evaluation_id = te.id AND te.arc_item_id = i.id AND i.arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation te USING tbl_arc_item i
                    WHERE te.arc_item_id = i.id AND i.arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  }
  await cleanupRoles();
});

describe("ARC submission-close sweep — runArcSubmissionCloseSweep", () => {
  test("no tech clauses: floated ARC past deadline closes and routes the buyer to COMMERCIAL evaluators", async () => {
    const arcId = await insertFloatedArc({ submissionEndAt: plusDays(-1), label: "comm" });
    mailCalls.length = 0;

    await runArcSubmissionCloseSweep({ now });

    expect(await arcStatus(arcId)).toBe("submission_closed");

    const rows = await notifRows(arcId);
    const recipients = rows.map((r) => Number(r.recipient_user_id));
    expect(recipients).toEqual(expect.arrayContaining([BUYER, COMM_EVAL, VENDOR]));
    expect(recipients).not.toContain(TECH_EVAL);

    // Buyer (comm evaluator) gets the action message; vendor gets the info message.
    const commRow = rows.find((r) => Number(r.recipient_user_id) === COMM_EVAL);
    expect(commRow.message).toMatch(/begin commercial evaluation/);
    const vendorRow = rows.find((r) => Number(r.recipient_user_id) === VENDOR);
    expect(vendorRow.message).toMatch(/Thank you for participating/);

    // Email: comm evaluator emailed; vendor + tech NOT.
    const sentTo = mailCalls.map((c) => c.to);
    expect(sentTo).toContain(await emailOf(COMM_EVAL));
    expect(sentTo).not.toContain(await emailOf(VENDOR));
  });

  test("with tech clauses: routes the buyer to TECHNICAL evaluators, not commercial", async () => {
    const arcId = await insertFloatedArc({ submissionEndAt: plusDays(-1), label: "tech", withTechClause: true });
    mailCalls.length = 0;

    await runArcSubmissionCloseSweep({ now });

    expect(await arcStatus(arcId)).toBe("submission_closed");
    const rows = await notifRows(arcId);
    const recipients = rows.map((r) => Number(r.recipient_user_id));
    expect(recipients).toEqual(expect.arrayContaining([BUYER, TECH_EVAL, VENDOR]));
    expect(recipients).not.toContain(COMM_EVAL);

    const techRow = rows.find((r) => Number(r.recipient_user_id) === TECH_EVAL);
    expect(techRow.message).toMatch(/begin technical evaluation/);

    expect(mailCalls.map((c) => c.to)).toContain(await emailOf(TECH_EVAL));
  });

  test("deadline not yet passed: floated ARC is untouched", async () => {
    const arcId = await insertFloatedArc({ submissionEndAt: plusDays(5), label: "future" });

    await runArcSubmissionCloseSweep({ now });

    expect(await arcStatus(arcId)).toBe("floated");
    expect((await notifRows(arcId)).length).toBe(0);
  });

  test("not floated: a draft ARC past the deadline is not closed", async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
          process_id, status, created_by, submission_start_at, submission_end_at,
          contract_start_at, contract_end_at, eligibility_type, escalation_clause_json, sub_category_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8, NOW() - INTERVAL '10 days', $9::timestamp,
          NOW() + INTERVAL '20 days', NOW() + INTERVAL '200 days', 'open','{}'::jsonb,'[]'::jsonb)
       RETURNING id`,
      [`ARC-SC-draft-${Date.now()}`, "Submission Close draft", CATEGORY, HC, HOTEL, DEPT, PROC, BUYER, plusDays(-1)]
    );
    createdArcIds.push(Number(arc.id));

    await runArcSubmissionCloseSweep({ now });

    expect(await arcStatus(Number(arc.id))).toBe("draft");
    expect((await notifRows(Number(arc.id))).length).toBe(0);
  });

  test("idempotent: re-running the same day does not duplicate notifications", async () => {
    const arcId = await insertFloatedArc({ submissionEndAt: plusDays(-2), label: "idem" });

    await runArcSubmissionCloseSweep({ now });
    const after1 = (await notifRows(arcId)).length;
    await runArcSubmissionCloseSweep({ now });
    const after2 = (await notifRows(arcId)).length;

    expect(after2).toBe(after1); // no new rows on the second run
    expect(await arcStatus(arcId)).toBe("submission_closed");
  });
});
