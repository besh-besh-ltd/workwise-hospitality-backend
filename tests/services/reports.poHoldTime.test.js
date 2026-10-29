// Time a PO spends on hold is not the approver's time (client ticket T3, Task 8).
// ----------------------------------------------------------------------------
// While a PO is on hold (an approver asked someone for information) nobody on
// that step can decide it. Reports 6.1 (PO Approval TAT) and 3.2 (PO Aging by
// Approver) therefore leave that time out: for every hold on the step, the
// interval from asking to the hold closing (or to now, if it is still open),
// clipped to the step's own window so it can never go negative. Each sheet
// says so in its notes.
//
// Report 3.3 (Rejected PO Log) gains the rejection's reason category and its
// route ("Re-award" / "Cancelled"); rejections recorded before send-backs
// existed show "—" in both, and the approver's own comment stays.
//
// Real flows: the PO is awarded, initiated, held, answered, approved and
// rejected over HTTP; only the clock is moved, by rewriting timestamps.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { default: excelJS } = await import("exceljs");
const { db, closeDb } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const { grantRoleScope, revokeRoleScopes } = await import("../helpers/roleScope.js");
const { makeSendBackWorld, S } = await import("../helpers/poSendBackWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");
const { drainPoSendBackNotifications } = await import("../../app/services/po/poSendBackNotifier.js");

const world = makeSendBackWorld(db);
const READER = S.CREATOR; // downloads the reports
let ROLE_ID = null;
const scopeIds = [];

beforeAll(async () => {
  await world.setup();
  const r = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by)
     VALUES ('TEST Reports — hold time', 'test-only role', $1) RETURNING id`,
    [IDS.users.superAdmin]
  );
  ROLE_ID = Number(r.id);
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, id FROM tbl_permissions
      WHERE resource::text = 'reports'
        AND action::text IN ('po_approval_tat', 'po_aging_by_approver', 'po_rejections')`,
    [ROLE_ID]
  );
  scopeIds.push(await grantRoleScope(db, { userId: READER, roleId: ROLE_ID, companyId: IDS.hospitality.A, hotelId: null }));
});

afterEach(async () => {
  await drainPoSendBackNotifications();
  await drainPoRejectedNotifications();
  await db.none(`DELETE FROM tbl_report_exports WHERE requested_by = $1`, [READER]);
  await world.cleanup();
});

afterAll(async () => {
  await revokeRoleScopes(db, scopeIds);
  if (ROLE_ID) {
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [ROLE_ID]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = $1`, [ROLE_ID]);
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [ROLE_ID]);
  }
  await world.teardown();
  await closeDb();
});

// ── workbook reading ─────────────────────────────────────────────────────────

const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary")));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

async function download(key) {
  const res = await binary((await world.client(READER)).post(`/api/v1/reports/${key}/download`).send({}));
  expect(res.status).toBe(200);
  const wb = new excelJS.Workbook();
  await wb.xlsx.load(res.body);
  return wb;
}

const HEADER_FILL = "FFD9D9D9";
function headerRowOf(ws) {
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const fill = ws.getRow(r).getCell(1).fill;
    if (fill && fill.fgColor && fill.fgColor.argb === HEADER_FILL) return r;
  }
  throw new Error(`no header row on ${ws.name}`);
}

/** The grid as objects keyed by header, stopping at the total row or a blank. */
function rowsOf(ws) {
  const hr = headerRowOf(ws);
  const headers = [];
  ws.getRow(hr).eachCell((c, i) => { headers[i] = String(c.value ?? ""); });
  const out = [];
  for (let r = hr + 1; r <= ws.rowCount; r += 1) {
    const first = String(ws.getRow(r).getCell(1).value ?? "").trim();
    if (first === "Total" || first === "") break;
    const row = {};
    headers.forEach((h, i) => { if (h) row[h] = ws.getRow(r).getCell(i).value ?? null; });
    out.push(row);
  }
  return out;
}

/** Every text cell above the grid: the title, subtitle and notes. */
function notesOf(ws) {
  const hr = headerRowOf(ws);
  const text = [];
  for (let r = 1; r < hr; r += 1) {
    ws.getRow(r).eachCell((c) => text.push(String(c.value ?? "")));
  }
  return text.join(" | ");
}

const HOLD_NOTE = /time on hold waiting for information is excluded/i;

// ── clock ────────────────────────────────────────────────────────────────────
// Approval tables hold naive UTC wall clock; send-backs are timestamptz.

const ago = (h) => `(NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${Number(h) * 3600})`;
const agoTz = (h) => `NOW() - make_interval(secs => ${Number(h) * 3600})`;

async function setInstanceClock(instanceId, { created, completed = null }) {
  await db.none(
    `UPDATE tbl_approval_instances SET created_at = ${ago(created)}${completed === null ? "" : `, completed_at = ${ago(completed)}`} WHERE id = $1`,
    [instanceId]
  );
}
async function setStepClock(stepId, { created, completed = null }) {
  await db.none(
    `UPDATE tbl_approval_instance_steps SET created_at = ${ago(created)}${completed === null ? "" : `, completed_at = ${ago(completed)}`} WHERE id = $1`,
    [stepId]
  );
}
async function setActedClock(stepId, userId, acted) {
  await db.none(
    `UPDATE tbl_approval_step_approvers SET acted_at = ${ago(acted)} WHERE approval_instance_step_id = $1 AND approver_user_id = $2`,
    [stepId, userId]
  );
}
async function setHoldClock(sendBackId, { created, closed = null }) {
  await db.none(
    `UPDATE tbl_po_send_backs SET created_at = ${agoTz(created)}${closed === null ? "" : `, closed_at = ${agoTz(closed)}`} WHERE id = $1`,
    [sendBackId]
  );
}

const ask = async (who, poId) => {
  const res = await world.sendBack(who, poId, { target_role: "RFQ_CREATOR", reason_category: "INFO_MISSING", comment: "Which floor?" });
  expect(res.status).toBe(201);
  return res.body.data.send_back.id;
};

// ============================================================================

describe("Report 6.1 — PO Approval TAT leaves time on hold out", () => {
  it("approver TAT excludes time on hold", async () => {
    const a = await world.poAtStep2();
    const { s1, s2, s3 } = a.steps;

    // At L2: APPROVER_A asks, the RFQ creator answers; APPROVER_B asks again
    // and withdraws it; then A approves and the last approver finishes.
    const first = await ask(S.APPROVER_A, a.poId);
    expect((await world.respond(S.CREATOR, first, { response_text: "Third floor" })).status).toBe(200);
    const second = await ask(S.APPROVER_B, a.poId);
    expect((await world.withdraw(S.APPROVER_B, second)).status).toBe(200);
    expect((await world.approve(S.APPROVER_A, a.poId)).status).toBe(200);
    expect((await world.approve(S.LAST_APPROVER, a.poId)).status).toBe(200);
    expect(await world.instanceState(a.instanceId)).toMatchObject({ status: "APPROVED" });

    // The clock, in hours ago:
    //   instance 12 → 1;  L1 12 → 11;  L2 12 → 3 (A decides at 3);  L3 12 → 1
    //   hold 1: 8 → 5   (3 h, inside L2)
    //   hold 2: 4 → 2   (straddles A's decision: 1 h inside L2, 2 h inside the instance)
    await setInstanceClock(a.instanceId, { created: 12, completed: 1 });
    await setStepClock(s1, { created: 12, completed: 11 });
    await setActedClock(s1, S.PO_APPROVER, 11);
    await setStepClock(s2, { created: 12, completed: 3 });
    await setActedClock(s2, S.APPROVER_A, 3);
    await setStepClock(s3, { created: 12, completed: 1 });
    await setActedClock(s3, S.LAST_APPROVER, 1);
    await setHoldClock(first, { created: 8, closed: 5 });
    await setHoldClock(second, { created: 4, closed: 2 });

    const wb = await download("po_approval_tat");
    const nameA = await world.nameOf(S.APPROVER_A);

    const byApprover = rowsOf(wb.getWorksheet("By Approver"));
    const a2 = byApprover.find((r) => r["Approver"] === nameA && r["Step"] === "L2");
    expect(Number(a2["Avg (hrs)"])).toBeCloseTo(9 - 3 - 1, 1); // 5
    const l1 = byApprover.find((r) => r["Step"] === "L1");
    expect(Number(l1["Avg (hrs)"])).toBeCloseTo(1, 1); // no hold on L1
    const l3 = byApprover.find((r) => r["Step"] === "L3");
    expect(Number(l3["Avg (hrs)"])).toBeCloseTo(11, 1); // no hold on L3

    const byStage = rowsOf(wb.getWorksheet("By Stage"));
    expect(Number(byStage.find((r) => r["Step"] === "L2")["Avg (hrs)"])).toBeCloseTo(5, 1);
    expect(Number(byStage.find((r) => r["Step"] === "L1")["Avg (hrs)"])).toBeCloseTo(1, 1);

    // The whole approval: 11 h, less 3 h and the 2 h of hold 2 inside it.
    const bands = rowsOf(wb.getWorksheet("TAT by Value"));
    const band = bands.filter((r) => r["Approvals"] === 1);
    expect(band).toHaveLength(1);
    expect(Number(band[0]["Avg TAT (hrs)"])).toBeCloseTo(11 - 3 - 2, 1);

    for (const name of ["TAT by Value", "By Approver", "By Stage"]) {
      expect(notesOf(wb.getWorksheet(name))).toMatch(HOLD_NOTE);
    }
  });
});

describe("Report 3.2 — PO Aging by Approver stops the clock while a PO is on hold", () => {
  it("an OPEN hold counts up to now, and no further", async () => {
    const a = await world.poAtStep2();
    const { s2, s3 } = a.steps;
    const answered = await ask(S.APPROVER_A, a.poId);
    expect((await world.respond(S.CREATOR, answered, { response_text: "Third floor" })).status).toBe(200);
    const open = await ask(S.APPROVER_B, a.poId);

    // L2 opened 10 h ago; on hold 9 → 8 (answered) and since 4 h ago (still open).
    await setStepClock(s2, { created: 10 });
    await setStepClock(s3, { created: 10 });
    await setHoldClock(answered, { created: 9, closed: 8 });
    await setHoldClock(open, { created: 4 });

    const wb = await download("po_aging_by_approver");
    const queue = rowsOf(wb.getWorksheet("Pending Queue"));
    const nameA = await world.nameOf(S.APPROVER_A);
    const nameB = await world.nameOf(S.APPROVER_B);
    for (const name of [nameA, nameB]) {
      const row = queue.find((r) => r["Approver"] === name && r["Step"] === "L2");
      expect(Number(row["Hours Pending"])).toBeCloseTo(10 - 1 - 4, 1); // 5
    }
    // L3 is not the held step: its clock is untouched.
    const last = queue.find((r) => r["Step"] === "L3");
    expect(Number(last["Hours Pending"])).toBeCloseTo(10, 1);

    for (const name of ["Pending Queue", "By Approver"]) {
      expect(notesOf(wb.getWorksheet(name))).toMatch(HOLD_NOTE);
    }
  });
});

describe("Report 3.3 — Rejected PO Log", () => {
  it("rejected PO log shows reason and route", async () => {
    // Rejected for re-award, through the PO page.
    const reaward = await world.pendingPo();
    const r1 = await world.rejectOnPoPage(reaward.poId, { remarks: "rate too high", reason_category: "PRICE_TAX_QUERY" });
    expect(r1.status).toBe(200);
    expect(r1.body.data.route).toBe("COMMERCIAL");

    // Rejected as not needed: filed under Cancelled.
    const notNeeded = await world.pendingPo();
    const r2 = await world.rejectOnPoPage(notNeeded.poId, { remarks: "outlet refurbishment dropped", reason_category: "NOT_REQUIRED" });
    expect(r2.status).toBe(200);
    expect(r2.body.data.route).toBe("CANCEL");

    // A rejection recorded before send-backs existed: no reason code, no route.
    const legacy = await world.pendingPo();
    const legacyStep = await world.currentStepId(legacy.instanceId);
    await db.none(`UPDATE tbl_approval_instances SET status = 'REJECTED', completed_at = (NOW() AT TIME ZONE 'UTC') WHERE id = $1`, [legacy.instanceId]);
    await db.none(`UPDATE tbl_approval_instance_steps SET status = 'REJECTED', completed_at = (NOW() AT TIME ZONE 'UTC') WHERE approval_instance_id = $1`, [legacy.instanceId]);
    await db.none(
      `INSERT INTO tbl_approval_actions (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
       VALUES ($1, $2, $3, 'REJECT', 'old style no')`,
      [legacy.instanceId, legacyStep, S.PO_APPROVER]
    );
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'rejected' WHERE id = $1`, [legacy.poId]);

    const numberOf = async (id) => (await db.one(`SELECT po_number FROM tbl_rfq_purchase_order WHERE id = $1`, [id])).po_number;
    const [reawardNo, notNeededNo, legacyNo] = [
      await numberOf(reaward.poId), await numberOf(notNeeded.poId), await numberOf(legacy.poId),
    ];
    const wb = await download("po_rejections");
    const triple = (r) => r && [r["Reason"], r["Route"], r["Comment"]];

    const rejected = rowsOf(wb.getWorksheet("Rejected by Approver"));
    expect(rejected.map((r) => r["PO Number"]).sort()).toEqual([reawardNo, legacyNo].sort());
    expect(triple(rejected.find((r) => r["PO Number"] === reawardNo)))
      .toEqual(["Question on price, GST or calculation", "Re-award", "rate too high"]);
    expect(triple(rejected.find((r) => r["PO Number"] === legacyNo))).toEqual(["—", "—", "old style no"]);

    const cancelled = rowsOf(wb.getWorksheet("Cancelled"));
    expect(cancelled.map((r) => r["PO Number"])).toEqual([notNeededNo]);
    expect(triple(cancelled[0])).toEqual(["Not needed any more", "Cancelled", "outlet refurbishment dropped"]);

    // The sheet says what the two new columns mean.
    expect(notesOf(wb.getWorksheet("Rejected by Approver"))).toMatch(/Re-award/);
  });
});
