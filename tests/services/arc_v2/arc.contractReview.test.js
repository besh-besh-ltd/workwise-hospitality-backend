// ARC v2 — contract copies are reviewed by the buyer before they go to vendors.
//
// Committee approval generates one DRAFT contract per awarded vendor
// (contract 'generated', ARC 'contract_generated'). Nothing reaches a vendor
// until a buyer with commercial write access sends the copies:
//   GET  /arc-v2/:id/contracts/review
//   GET  /arc-v2/:id/contracts/:contractId/preview
//   POST /arc-v2/:id/contracts/send   { contract_ids? }
//
// Proves:
//   1. Review/preview need arc-comm read in the ARC's scope; send needs
//      arc-comm.evaluate (or arc.admin). Other departments, other tenants
//      and vendors are refused.
//   2. While the copies are drafts, no vendor can see, sign, decline or
//      clarify them, no vendor is told it won or lost, and the vendor
//      dashboard/activity show nothing about contracts.
//   3. Send is a guarded transition: partial send keeps the ARC in review,
//      mixed ids roll back, replays get 409, and only the vendors just sent
//      are notified.
//
// Calls the committee post-approval hook directly (same function the
// approval engine dispatches to), like arc.contract.multiVendor.test.js.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;     // creator + arc-comm.evaluate (fixture role)
const READER   = IDS.users.a1_proc_finance;   // arc-comm.read only (fixture role below)
const OTHER_DEPT = IDS.users.a1_eng_buyer;    // scoped to Engineering, not this ARC's dept
const CROSS    = IDS.users.companyB_admin;    // another tenant
const APPROVER = IDS.users.superAdmin;        // stands in for the last committee approver
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const VENDOR_C = IDS.users.vendor_gamma;      // invited + quoted, not awarded
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const COMMITTEE_POLICY_ID = 64930;
const READ_ROLE_ID = 95200;
const READ_SCOPE_ID = 95210;
const API = "/api/v1/arc-v2";

describe("ARC v2 — review contract copies before sending to vendors", () => {
  let arcId, otherArcId, itemId, commId, contractA, contractB, otherContract;
  let buyer, reader, otherDept, cross, vendorA, vendorB, vendorC;

  async function notifRecipients(type) {
    const rows = await db.any(
      `SELECT recipient_user_id FROM tbl_notifications
        WHERE additional_data->>'arc_id' = $1 AND type = $2`,
      [String(arcId), type]
    );
    return rows.map((r) => Number(r.recipient_user_id)).sort((a, b) => a - b);
  }

  beforeAll(async () => {
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[BUYER, READER, OTHER_DEPT, CROSS]]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = ANY($1::int[])`, [[VENDOR_A, VENDOR_B, VENDOR_C]]);

    await seedArcEvalPerms(db, [BUYER], { hospitality: HC, hotel: HOTEL });
    // READER: arc-comm.read only, at this hotel.
    const commRead = await db.one(
      `SELECT id FROM tbl_permissions WHERE resource = 'arc-comm' AND action = 'read' ORDER BY id LIMIT 1`);
    await db.none(
      `INSERT INTO tbl_roles (id, title, description, created_by)
       VALUES ($1, 'ARC Comm Read Fixture', 'contract review test fixture', NULL)
       ON CONFLICT (id) DO NOTHING`, [READ_ROLE_ID]);
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, $2 WHERE NOT EXISTS
         (SELECT 1 FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2)`,
      [READ_ROLE_ID, commRead.id]);
    await db.none(
      `INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
      [READ_SCOPE_ID, READER, READ_ROLE_ID, HC, HOTEL]);

    buyer     = await httpClient(BUYER);
    reader    = await httpClient(READER);
    otherDept = await httpClient(OTHER_DEPT);
    cross     = await httpClient(CROSS);
    vendorA   = await httpClient(VENDOR_A);
    vendorB   = await httpClient(VENDOR_B);
    vendorC   = await httpClient(VENDOR_C);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          payment_terms_expected, delivery_expected, penalty_clause, created_by)
       VALUES ('ARC-TEST-REVIEW-1', 'Contract review test', $1, $2, $3, $4, $5, 'committee_review',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               'Net 30', 'Within 7 days of call-off', '1% per week of delay', $6)
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    itemId = (await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 100) RETURNING id`, [arcId, VARIANT_ID])).id;

    const lineFor = async (vendor, rate) => {
      const q = await db.one(
        `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, payment_terms)
         VALUES ($1, $2, NOW(), 'Net 30') RETURNING id`, [arcId, vendor]);
      return (await db.one(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
         VALUES ($1, $2, $3, 5) RETURNING id`, [q.id, itemId, rate])).id;
    };
    const qlA = await lineFor(VENDOR_A, 90);
    const qlB = await lineFor(VENDOR_B, 95);
    await lineFor(VENDOR_C, 99);
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       VALUES ($1, $2, 'submitted'), ($1, $3, 'submitted'), ($1, $4, 'submitted')`,
      [arcId, VENDOR_A, VENDOR_B, VENDOR_C]);

    commId = (await db.one(
      `INSERT INTO tbl_arc_comm_evaluation (arc_id, status) VALUES ($1, 'finalized') RETURNING id`, [arcId])).id;
    await db.none(
      `INSERT INTO tbl_arc_comm_evaluation_award
         (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id, awarded_quote_line_id,
          allocated_qty, l_rank, is_l1_default, awarded_quote_snapshot)
       VALUES ($1, $2, $3, $4, 600, 'L1', false, $5::jsonb),
              ($1, $2, $6, $7, 400, 'L2', false, $8::jsonb)`,
      [commId, itemId,
        VENDOR_A, qlA, JSON.stringify({ rate: 90, gst_pct: 5, payment_terms: 'Net 30' }),
        VENDOR_B, qlB, JSON.stringify({ rate: 95, gst_pct: 5, payment_terms: 'Net 45' })]
    );

    // A second ARC in the same scope with its own contract, for the
    // cross-ARC id checks.
    const other = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-REVIEW-2', 'Other ARC', $1, $2, $3, $4, $5, 'contract_generated',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days', $6) RETURNING id`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    otherArcId = other.id;
    otherContract = (await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'generated') RETURNING id`,
      [otherArcId, VENDOR_A])).id;

    // The concluded committee vote the lifecycle reads (the engine would have
    // written it before dispatching the hook below).
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_COMMITTEE', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [COMMITTEE_POLICY_ID, HC, HOTEL, BUYER, PROC]);
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, hospitality_company_id, hotel_id,
          initiated_by, status, completed_at)
       VALUES ('ARC_COMMITTEE', $1, $2, $3, $4, $5, 'APPROVED', NOW()) RETURNING id`,
      [arcId, COMMITTEE_POLICY_ID, HC, HOTEL, BUYER]);

    const { handleArcCommitteeApproval } = await import(
      "../../../app/controllers/arc_v2/arcCommitteeController.js");
    await handleArcCommitteeApproval(inst.id, APPROVER, {
      instance: { id: inst.id, entity_type: 'ARC_COMMITTEE', entity_id: arcId, status: 'APPROVED' },
    });
    contractA = Number((await db.one(
      `SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, VENDOR_A])).id);
    contractB = Number((await db.one(
      `SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, VENDOR_B])).id);
  });

  afterAll(async () => {
    const arcIds = [arcId, otherArcId].filter(Boolean);
    await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`, [arcIds.map(String)]);
    await db.none(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::int[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::int[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id = $1`, [commId]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::int[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE entity_type = 'ARC_COMMITTEE' AND entity_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [COMMITTEE_POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [READ_SCOPE_ID]);
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [READ_ROLE_ID]);
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [READ_ROLE_ID]);
    await cleanupArcEvalPerms(db, [BUYER]);
    await db.none(`DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`, [CATEGORY, DEPT]);
  });

  // ── 1. committee approval holds drafts ─────────────────────────────────

  test("committee approval generates drafts and holds the ARC in contract review", async () => {
    const contracts = await db.any(`SELECT status, awaiting_until FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    expect(contracts).toHaveLength(2);
    expect(contracts.every((c) => c.status === "generated" && c.awaiting_until === null)).toBe(true);
    expect((await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId])).status).toBe("contract_generated");

    // Buyers are told the copies are ready; no vendor is told anything.
    expect(await notifRecipients("CONTRACT_GENERATED")).toContain(BUYER);
    expect(await notifRecipients("CONTRACT_AWAITING_ACCEPTANCE")).toEqual([]);
    const events = (await db.any(`SELECT event_type FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId])).map((e) => e.event_type);
    expect(events).toContain("contract_generated");
    expect(events).not.toContain("contract_awaiting_acceptance");
  });

  // ── 2. review + preview permissions ────────────────────────────────────

  test("buyer lifecycle: Awarding holds the review, Contract Active waits", async () => {
    const lc = await buyer.get(`${API}/${arcId}/lifecycle`);
    expect(lc.status).toBe(200);
    expect(lc.body.data.stages.find((s) => s.key === "awarding")).toMatchObject({ state: "active", reason: "contract_review" });
    expect(lc.body.data.stages.find((s) => s.key === "active")).toMatchObject({ state: "locked", reason: "contracts_in_review" });
    expect(lc.body.data.default_stage).toBe("awarding");
  });

  test("buyer with commercial write sees both drafts with lines and can send", async () => {
    const res = await buyer.get(`${API}/${arcId}/contracts/review`);
    expect(res.status).toBe(200);
    const { contracts, can_send, drafts } = res.body.data;
    expect(can_send).toBe(true);
    expect(drafts).toBe(2);
    const a = contracts.find((c) => c.id === contractA);
    expect(a).toMatchObject({ vendor_id: VENDOR_A, status: "generated" });
    expect(a.lines).toHaveLength(1);
    expect(Number(a.lines[0].committed_qty)).toBe(600);
    expect(Number(a.lines[0].unit_rate)).toBe(90);
    expect(a.committed_value).toBe(54000);
    const b = contracts.find((c) => c.id === contractB);
    expect(b.lines[0].payment_terms).toBe("Net 45");
  });

  test("a commercial reader can review and preview but cannot send", async () => {
    const res = await reader.get(`${API}/${arcId}/contracts/review`);
    expect(res.status).toBe(200);
    expect(res.body.data.can_send).toBe(false);
    expect((await reader.get(`${API}/${arcId}/contracts/${contractA}/preview`)).status).toBe(200);
    const send = await reader.post(`${API}/${arcId}/contracts/send`).send({});
    expect(send.status).toBe(403);
    expect((await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractA])).status).toBe("generated");
  });

  test("other departments, other tenants and vendors are refused", async () => {
    for (const client of [otherDept, cross]) {
      expect((await client.get(`${API}/${arcId}/contracts/review`)).status).toBe(403);
      expect((await client.get(`${API}/${arcId}/contracts/${contractA}/preview`)).status).toBe(403);
      expect((await client.post(`${API}/${arcId}/contracts/send`).send({})).status).toBe(403);
    }
    // Vendors never reach the buyer routes (acl([2, 8])).
    expect((await vendorA.get(`${API}/${arcId}/contracts/review`)).status).toBe(403);
    expect((await vendorA.get(`${API}/${arcId}/contracts/${contractA}/preview`)).status).toBe(403);
    expect((await vendorA.post(`${API}/${arcId}/contracts/send`).send({})).status).toBe(403);
  });

  test("preview renders the exact contract document for that vendor", async () => {
    const res = await buyer.get(`${API}/${arcId}/contracts/${contractB}/preview`);
    expect(res.status).toBe(200);
    const { html, contract } = res.body.data;
    expect(contract).toMatchObject({ id: contractB, vendor_id: VENDOR_B, status: "generated" });
    expect(html).toMatch(/Annual Rate Contract Agreement/);
    expect(html).toMatch(/ARC-TEST-REVIEW-1/);
    expect(html).toMatch(/Draft pending signature/);
    expect(html).toMatch(/Within 7 days of call-off/);
    expect(html).toMatch(/1% per week of delay/);
    expect(html).not.toMatch(/<script/i);
  });

  test("a contract of another ARC is not previewable through this ARC", async () => {
    expect((await buyer.get(`${API}/${arcId}/contracts/${otherContract}/preview`)).status).toBe(404);
    expect((await buyer.get(`${API}/${arcId}/contracts/999999999/preview`)).status).toBe(404);
  });

  // ── 3. vendors see nothing while the copies are drafts ─────────────────

  test("an awarded vendor cannot open, sign, decline or clarify a draft", async () => {
    expect((await vendorA.get(`${API}/vendor/contracts/${contractA}`)).status).toBe(404);
    expect((await vendorA.post(`${API}/vendor/contracts/${contractA}/otp/request`).send({})).status).toBe(409);
    expect((await vendorA.post(`${API}/vendor/contracts/${contractA}/otp/verify`).send({ code: "123456" })).status).toBe(409);
    expect((await vendorA.post(`${API}/vendor/contracts/${contractA}/decline`).send({ reason: "x" })).status).toBe(404);
    const lines = await db.any(`SELECT id FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractA]);
    expect((await vendorA.post(`${API}/vendor/contracts/${contractA}/clarification`)
      .send({ items: [{ arc_contract_line_id: lines[0].id, field: "base_price", comment: "x" }] })).status).toBe(409);
    expect((await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractA])).status).toBe("generated");

    const pending = await vendorA.get(`${API}/vendor/pending-acceptance`);
    expect(pending.body.data.contracts.map((c) => Number(c.id))).not.toContain(contractA);
  });

  test("no vendor is told it won or lost during review", async () => {
    for (const [client] of [[vendorA], [vendorC]]) {
      const lc = await client.get(`${API}/vendor/requests/${arcId}/lifecycle`);
      expect(lc.status).toBe(200);
      const awarding = lc.body.data.stages.find((s) => s.key === "awarding");
      expect(awarding).toMatchObject({ state: "locked", reason: "awaiting_decision", vendor_action: "none" });
      expect(lc.body.data.default_stage).not.toBe("awarding");
    }
  });

  test("vendor dashboard and requests show the ARC as still under evaluation", async () => {
    const dash = await vendorA.get(`${API}/vendor/dashboard`);
    expect(dash.status).toBe(200);
    const row = dash.body.data.needs_action.find((n) => n.arc_id === arcId);
    expect(row).toMatchObject({ status: "evaluating", contract_id: null });
    expect(dash.body.data.counts.awaiting_sign).toBe(0);
    expect(dash.body.data.activity.map((e) => e.event_type)).not.toContain("contract_generated");

    const reqs = await vendorA.get(`${API}/vendor/requests`);
    expect(reqs.body.data.requests.map((r) => r.id)).toContain(arcId);
  });

  // ── 4. send ────────────────────────────────────────────────────────────

  test("send rejects a malformed body", async () => {
    for (const body of [{ contract_ids: [] }, { contract_ids: "1" }, { contract_ids: [0] }, { contract_ids: ["x"] }]) {
      expect((await buyer.post(`${API}/${arcId}/contracts/send`).send(body)).status).toBe(400);
    }
  });

  test("mixing in a contract of another ARC sends nothing (rollback)", async () => {
    const res = await buyer.post(`${API}/${arcId}/contracts/send`).send({ contract_ids: [contractA, otherContract] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_DRAFT");
    expect((await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractA])).status).toBe("generated");
    expect((await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [otherContract])).status).toBe("generated");
    expect(await notifRecipients("CONTRACT_AWAITING_ACCEPTANCE")).toEqual([]);
  });

  test("sending one vendor's copy keeps the ARC in review and notifies only that vendor", async () => {
    const res = await buyer.post(`${API}/${arcId}/contracts/send`).send({ contract_ids: [contractA] });
    expect(res.status).toBe(200);
    expect(res.body.data.sent.map((c) => c.id)).toEqual([contractA]);
    expect(res.body.data.arc_status).toBe("contract_generated");
    expect(res.body.data.drafts_remaining).toBe(1);

    const a = await db.one(`SELECT status, awaiting_until FROM tbl_arc_contract WHERE id = $1`, [contractA]);
    expect(a.status).toBe("awaiting_acceptance");
    expect(a.awaiting_until).not.toBeNull();
    expect((await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractB])).status).toBe("generated");
    expect((await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId])).status).toBe("contract_generated");
    expect(await notifRecipients("CONTRACT_AWAITING_ACCEPTANCE")).toEqual([VENDOR_A]);

    // Vendor A can now open it; B still cannot.
    expect((await vendorA.get(`${API}/vendor/contracts/${contractA}`)).status).toBe(200);
    expect((await vendorB.get(`${API}/vendor/contracts/${contractB}`)).status).toBe(404);
  });

  test("sending the rest moves the ARC to awaiting vendor acceptance", async () => {
    const res = await buyer.post(`${API}/${arcId}/contracts/send`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.sent.map((c) => c.id)).toEqual([contractB]);
    expect(res.body.data.arc_status).toBe("awaiting_vendor_acceptance");
    expect((await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId])).status).toBe("awaiting_vendor_acceptance");
    // A was not notified a second time.
    expect(await notifRecipients("CONTRACT_AWAITING_ACCEPTANCE")).toEqual([VENDOR_A, VENDOR_B].sort((x, y) => x - y));

    const review = await buyer.get(`${API}/${arcId}/contracts/review`);
    expect(review.body.data.drafts).toBe(0);
    expect(review.body.data.can_send).toBe(false);

    const lc = await buyer.get(`${API}/${arcId}/lifecycle`);
    expect(lc.body.data.stages.find((s) => s.key === "awarding")).toMatchObject({ state: "complete" });
    expect(lc.body.data.stages.find((s) => s.key === "active")).toMatchObject({ state: "active", reason: "awaiting_vendor_acceptance" });
  });

  test("a replay sends nothing (409) and notifies nobody again", async () => {
    const res = await buyer.post(`${API}/${arcId}/contracts/send`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOTHING_TO_SEND");
    expect(await notifRecipients("CONTRACT_AWAITING_ACCEPTANCE")).toHaveLength(2);
  });

  test("after send: vendors see their own contract; a non-awarded vendor learns it lost", async () => {
    const lcA = await vendorA.get(`${API}/vendor/requests/${arcId}/lifecycle`);
    expect(lcA.body.data.stages.find((s) => s.key === "awarding")).toMatchObject({ reason: "awaiting_sign", vendor_action: "sign_contract" });
    expect(lcA.body.data.default_stage).toBe("awarding");

    const lcC = await vendorC.get(`${API}/vendor/requests/${arcId}/lifecycle`);
    expect(lcC.body.data.stages.find((s) => s.key === "awarding")).toMatchObject({ state: "complete", reason: "not_awarded" });

    const dash = await vendorA.get(`${API}/vendor/dashboard`);
    expect(dash.body.data.counts.awaiting_sign).toBe(1);
    const row = dash.body.data.needs_action.find((n) => n.arc_id === arcId);
    expect(row.status).toBe("awaiting_sign");
    expect(Number(row.contract_id)).toBe(contractA);
    // Each vendor's "sent for signature" event names only that vendor.
    const sentEvents = dash.body.data.activity.filter((e) => e.event_type === "contract_awaiting_acceptance");
    expect(sentEvents).toHaveLength(1);
    expect(Number(sentEvents[0].payload.vendor_id)).toBe(VENDOR_A);
  });

  test("sign then decline: a signed contract can no longer be declined", async () => {
    const otp = await vendorA.post(`${API}/vendor/contracts/${contractA}/otp/request`).send({});
    expect(otp.status).toBe(200);
    const verify = await vendorA.post(`${API}/vendor/contracts/${contractA}/otp/verify`).send({ code: otp.body.data.dev_code });
    expect(verify.status).toBe(200);
    expect(verify.body.data.contract.status).toBe("active");

    const decline = await vendorA.post(`${API}/vendor/contracts/${contractA}/decline`).send({ reason: "changed my mind" });
    expect(decline.status).toBe(409);
    expect((await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractA])).status).toBe("active");

    // B can still decline its sent copy.
    const declineB = await vendorB.post(`${API}/vendor/contracts/${contractB}/decline`).send({ reason: "capacity" });
    expect(declineB.status).toBe(200);
    expect(declineB.body.data.contract.status).toBe("declined");
  });
});
