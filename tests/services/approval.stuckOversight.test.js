/**
 * What is stuck, and what an administrator can do about it (T1).
 *
 * Production holds 332 PENDING approval instances, 198 older than a month.
 * Listed flat, that screen answers nothing. Classified against the live data
 * it collapses to something an admin can act on:
 *
 *   overtaken  215   approving changes nothing — the RFQ's bid window closed
 *   waiting    114   a live person could act right now
 *   blocked      3   nobody can act at all
 *
 * The classification is the feature, so these tests are about the boundaries
 * between those three words, and about the guards on the one action that
 * changes who authorises spend.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN = IDS.users.companyA_admin;
const APPROVER = IDS.users.a1_proc_poApp;
const SUCCESSOR = IDS.users.a1_proc_commApp;
const STUCK_URL = "/api/v1/general/hospitality/approval/stuck";

let restoreAdminType;
let restoreBAdminType;
let restoreApproverStatus;
const madeInstances = [];
const madeRfqs = [];

/** Naive IST wall clock, which is what tbl_rfq.bid_end_date holds. */
const istWallClock = (offsetMs) => {
  const d = new Date(Date.now() + offsetMs + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
};

const seedRfqApproval = async ({ bidOffsetMs, approverId = APPROVER, ageDays = 0 }) => {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq (rfq_no, comment, company_name, response_email, contact_name,
                          contact_number, location, created_by, updated_by,
                          hospitality_company_id, hotel_id, bid_end_date, status)
     VALUES ((SELECT COALESCE(MAX(rfq_no), 0) + 1 FROM tbl_rfq),
             'Stuck-oversight probe', 'Company A', 'probe@example.com', 'Probe',
             '9000000000', 'Pune', $1, $1, $2, $3, $4, 1)
     RETURNING id`,
    [IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, istWallClock(bidOffsetMs)]
  );
  madeRfqs.push(Number(rfq.id));

  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step, initiated_by,
        hospitality_company_id, hotel_id, department_id, created_at)
     VALUES ('RFQ', $1, $2, 'PENDING', 1, $3, $4, $5, $6, now() - ($7 || ' days')::interval)
     RETURNING id`,
    [Number(rfq.id), IDS.policies.A1_P1_RFQ, IDS.users.a1_proc_buyer,
     IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, ageDays]
  );
  madeInstances.push(Number(inst.id));

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
    [Number(inst.id)]
  );
  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [Number(step.id), approverId]
  );
  return { instanceId: Number(inst.id), stepId: Number(step.id), rfqId: Number(rfq.id) };
};

const rowFor = (body, instanceId) =>
  (body?.data?.items || []).find((r) => Number(r.id) === instanceId);

beforeAll(async () => {
  ({ user_type: restoreAdminType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]
  ));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
  // Company B's administrator is a real administrator too — otherwise the
  // cross-tenant test would pass on a 403 from the route gate rather than on
  // the scoping actually holding.
  ({ user_type: restoreBAdminType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1", [IDS.users.companyB_admin]
  ));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [IDS.users.companyB_admin]);
  ({ status: restoreApproverStatus } = await db.one(
    "SELECT status FROM tbl_users WHERE id = $1", [APPROVER]
  ));
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreAdminType]);
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1",
    [IDS.users.companyB_admin, restoreBAdminType]);
  await db.none("UPDATE tbl_users SET status = $2 WHERE id = $1", [APPROVER, restoreApproverStatus]);
  for (const id of madeInstances) {
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
         (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1)`, [id]);
    await db.none("DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = $1", [id]);
    await db.none("DELETE FROM tbl_approval_instances WHERE id = $1", [id]);
  }
  for (const id of madeRfqs) await db.none("DELETE FROM tbl_rfq WHERE id = $1", [id]);
  await db.none(
    `DELETE FROM tbl_audit_row_changes WHERE table_name IN
       ('tbl_approval_instances','tbl_approval_instance_steps','tbl_approval_step_approvers','tbl_rfq','tbl_users')`
  );
  await closeDb();
});

describe("classifying what is stuck", () => {
  it("identifies the item by the number the rest of the product uses", async () => {
    // entity_id is a primary key. An admin sent to chase "RFQ #112" will not
    // find it — the listing, the emails and the PDF all say RFQ 1.
    const { instanceId, rfqId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    const { rfq_no } = await db.one("SELECT rfq_no FROM tbl_rfq WHERE id = $1", [rfqId]);

    const client = await httpClient(ADMIN);
    const row = rowFor((await client.get(STUCK_URL)).body, instanceId);
    expect(row.entity_ref).toBe(String(rfq_no));
    expect(row.entity_ref).not.toBe(String(rfqId));
  });

  it("calls it waiting when a live person could act right now", async () => {
    const { instanceId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    const client = await httpClient(ADMIN);

    const res = await client.get(STUCK_URL);
    expect(res.status).toBe(200);
    expect(rowFor(res.body, instanceId).class).toBe("waiting");
  });

  it("calls it overtaken when approving could no longer change anything", async () => {
    // 214 of production's 227 pending RFQ approvals are this: the bid window
    // closed, so no further quote can arrive and the approval to publish is
    // moot. The right action is to cancel it, not to chase somebody.
    const { instanceId } = await seedRfqApproval({ bidOffsetMs: -7 * 86400_000 });
    const client = await httpClient(ADMIN);

    const res = await client.get(STUCK_URL);
    expect(rowFor(res.body, instanceId).class).toBe("overtaken");
  });

  it("calls it blocked when the only approver's account is switched off", async () => {
    const { instanceId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    await db.none("UPDATE tbl_users SET status = 0 WHERE id = $1", [APPROVER]);
    try {
      const client = await httpClient(ADMIN);
      const row = rowFor((await client.get(STUCK_URL)).body, instanceId);
      expect(row.class).toBe("blocked");
      // Blocked outranks overtaken and waiting: nobody can act at all, which
      // is the one state where the admin is the only way forward.
      expect(row.approvers).toHaveLength(1);
      expect(row.approvers[0].can_act).toBe(false);
      expect(row.approvers[0].account_active).toBe(false);
    } finally {
      await db.none("UPDATE tbl_users SET status = 1 WHERE id = $1", [APPROVER]);
    }
  });

  it("keeps counting the whole company while the list is filtered", async () => {
    // "3 blocked" has to mean three in the company. A summary that moves with
    // the filter is a summary of the filter, which is not what anybody reads
    // it for.
    await seedRfqApproval({ bidOffsetMs: -7 * 86400_000 });
    const client = await httpClient(ADMIN);

    const all = await client.get(STUCK_URL);
    const filtered = await client.get(`${STUCK_URL}?classes=blocked`);

    expect(filtered.body.data.counts).toEqual(all.body.data.counts);
    expect(filtered.body.data.total).toBeLessThan(all.body.data.total);
  });
});

describe("an approver who can no longer sign in (UM-11)", () => {
  it("says so in the approval panel's own payload", async () => {
    // The engine keeps an approver row rather than deleting it, so a
    // deactivated account leaves its row PENDING forever and every panel shows
    // the name beside the word "Waiting". Production carries 24 such rows
    // across 19 live approvals. The panel cannot distinguish them without
    // being told, and it was never told.
    const { instanceId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    await db.none("UPDATE tbl_users SET status = 0 WHERE id = $1", [APPROVER]);
    try {
      const client = await httpClient(ADMIN);
      const res = await client.get(
        `/api/v1/general/hospitality/approval/instance/${instanceId}`
      );
      expect(res.status).toBe(200);

      const approvers = (res.body.data?.steps || []).flatMap((st) => st.approvers || []);
      const row = approvers.find((a) => Number(a.user_id) === APPROVER);
      expect(row).toBeDefined();
      // Still pending — the row genuinely has not been acted on. What is new
      // is the panel being able to tell that nobody can act on it.
      expect(row.status).toBe("PENDING");
      expect(row.account_active).toBe(false);
    } finally {
      await db.none("UPDATE tbl_users SET status = 1 WHERE id = $1", [APPROVER]);
    }
  });

  it("does not mark a live approver as unreachable", async () => {
    const { instanceId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    const client = await httpClient(ADMIN);
    const res = await client.get(
      `/api/v1/general/hospitality/approval/instance/${instanceId}`
    );

    const approvers = (res.body.data?.steps || []).flatMap((st) => st.approvers || []);
    expect(approvers.find((a) => Number(a.user_id) === APPROVER).account_active).toBe(true);
  });
});

describe("handing a stuck approval to somebody else", () => {
  it("refuses without a reason", async () => {
    const { instanceId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    const client = await httpClient(ADMIN);

    const res = await client
      .post(`${STUCK_URL}/${instanceId}/reassign`)
      .send({ from_user_id: APPROVER, to_user_id: SUCCESSOR, reason: "stuck" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REASON_REQUIRED");
  });

  it("moves the step and keeps the old approver as a tombstone", async () => {
    // The engine never deletes an approver — REMOVED with removed_at and a
    // reason — so a later reader can see who was taken off and why. Deleting
    // would make the reassignment itself invisible.
    const { instanceId, stepId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    const client = await httpClient(ADMIN);

    const res = await client
      .post(`${STUCK_URL}/${instanceId}/reassign`)
      .send({
        from_user_id: APPROVER,
        to_user_id: SUCCESSOR,
        reason: "Approver is on leave until the end of the month",
      });
    expect(res.status).toBe(200);

    const rows = await db.any(
      `SELECT approver_user_id, status, removal_reason FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id = $1 ORDER BY id`, [stepId]);
    const old = rows.find((r) => Number(r.approver_user_id) === APPROVER);
    const next = rows.find((r) => Number(r.approver_user_id) === SUCCESSOR);

    expect(old.status).toBe("REMOVED");
    expect(old.removal_reason).toMatch(/on leave/);
    expect(next.status).toBe("PENDING");
  });

  it("refuses to hand it to somebody who could not approve here anyway", async () => {
    // Otherwise reassignment becomes a way to grant authority the role model
    // refuses — the admin picks anyone in the database and the approval chain
    // means nothing.
    const { instanceId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    const client = await httpClient(ADMIN);

    const res = await client
      .post(`${STUCK_URL}/${instanceId}/reassign`)
      .send({
        from_user_id: APPROVER,
        to_user_id: IDS.users.companyB_admin,
        reason: "Trying to reach outside this company entirely",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_ELIGIBLE");
  });

  it("refuses once the step has been decided", async () => {
    const { instanceId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    await db.none(
      `UPDATE tbl_approval_instance_steps SET status = 'APPROVED' WHERE approval_instance_id = $1`,
      [instanceId]
    );
    const client = await httpClient(ADMIN);

    const res = await client
      .post(`${STUCK_URL}/${instanceId}/reassign`)
      .send({
        from_user_id: APPROVER,
        to_user_id: SUCCESSOR,
        reason: "Trying to rewrite who authorised something already settled",
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("APPROVAL_NOT_PENDING");
  });

  it("is not something an ordinary buyer can do", async () => {
    const { instanceId } = await seedRfqApproval({ bidOffsetMs: 7 * 86400_000 });
    const client = await httpClient(IDS.users.a1_proc_buyer);

    const res = await client
      .post(`${STUCK_URL}/${instanceId}/reassign`)
      .send({ from_user_id: APPROVER, to_user_id: SUCCESSOR, reason: "Because I would like to" });

    expect(res.status).toBe(403);
  });

  it("does not leak another company's approvals", async () => {
    const client = await httpClient(IDS.users.companyB_admin);
    const res = await client.get(STUCK_URL);
    expect(res.status).toBe(200);
    const leaked = (res.body.data.items || []).filter(
      (r) => Number(r.hospitality_company_id) === IDS.hospitality.A
    );
    expect(leaked).toHaveLength(0);
  });
});
