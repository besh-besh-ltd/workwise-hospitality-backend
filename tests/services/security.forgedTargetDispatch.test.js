// SECURITY: an approval instance acts only on its own company's target.
//
// Until c3a51cd6 closed POST /general/hospitality/approval/submit, any caller
// could open an instance of ANY engine type in their own company naming
// another company's target in entity_id/metadata: an RFQ to publish, a round
// to activate or cancel, an ARC to float, an MR to release, a PO to approve.
// Their own approver could then decide it through the generic action route,
// or a policy/membership change could complete it (propagation), and the
// post-approval or rejection handler acted on the other company.
//
// The fix is one check, before any handler runs, on every path that runs one
// (approvalTargetOwner.instanceTargetCompany): the target must resolve to the
// instance's own company. Pinned here, for EVERY registered engine type, with
// company A's instance forged on company B's target:
//   - approve and reject through the generic action route answer like a
//     missing instance (404, same body), record nothing, and write nothing to B;
//   - propagation completing it runs no handler and writes nothing to B;
//   - nobody is notified;
//   - the same target under its own company's instance resolves to B, so the
//     check does not refuse legitimate instances.
// And the pre-deploy gate (sec1-predeploy-checks.sql, check 6) is the same
// resolution: it lists exactly the forged PENDING rows, and its operator block
// cancels exactly those the way the app does.
//
// Real HTTP + Postgres.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { makeRFQ } from "../factories/rfq.js";
import { REGISTERED_APPROVAL_TYPES } from "../../app/services/approvalActionService.js";
import {
  advanceInstanceToNextStep,
  handleAutoCompletedInstances,
} from "../../app/services/approvalPropagationService.js";
import {
  instanceTargetCompany,
  TARGET_COMPANY_CTES,
} from "../../app/services/approvalTargetOwner.js";

const HC_A = IDS.hospitality.A;
const HC_B = IDS.hospitality.B;
const HOTEL_A = IDS.hotels.A1;
const HOTEL_B = IDS.hotels.B1;
const DEPT = IDS.departments.proc;
const APPROVER_A = IDS.users.a1_proc_buyer;  // company A's approver on every forged instance
const B_ADMIN = IDS.users.companyB_admin;     // creates company B's entities
const ALPHA = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const POLICY_ID = 64993;                      // inactive: never matched by a resolver

const SQL_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/releases/2026-10-inventory/sec1-predeploy-checks.sql"
);
const NOT_FOUND = { status: 2, message: "Approval instance not found" };
const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString().replace("T", " ").slice(0, 19);

// ---- company B's world: one actionable target per engine type ---------------

const B = {};
const made = { rfq: [], product: [], round: [], te: [], teRound: [], po: [], mr: [], arc: [], contract: [], amendment: [] };
const instanceIds = [];
let savedUsers = [];

async function arcB(status, label) {
  const row = await db.one(
    `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id,
                          department_id, status, created_by, eligibility_type,
                          submission_start_at, submission_end_at, contract_start_at, contract_end_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open',
             NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day', NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days')
     RETURNING id`,
    [`ARC-FORGED-${label}-${Date.now()}`, `Forged target ${label}`, CATEGORY, HC_B, HOTEL_B, DEPT, status, B_ADMIN]
  );
  made.arc.push(Number(row.id));
  return Number(row.id);
}

async function seedCompanyB() {
  const rfq = async (opts) => {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: B_ADMIN, hospitality: HC_B, hotel: HOTEL_B, process: IDS.processes.B_P1, ...opts,
    });
    made.rfq.push(Number(rfq_id));
    return Number(rfq_id);
  };
  // RFQ / TENDER: awaiting their publish approval (status 3), not published.
  B.rfq = await rfq({ status: 3 });
  B.tender = await rfq({ status: 3, is_tender: 1 });
  // The RFQ the negotiation, quote, tech-eval and PO targets hang off.
  B.work = await rfq({ status: 1, is_published: 1, bid_end_date: future(-2) });
  B.product = Number((await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, qap, variant)
     VALUES ($1, '', '0', '', '', 1, '0', 0) RETURNING id`, [B.work])).id);
  made.product.push(B.product);
  B.round = Number((await db.one(
    `INSERT INTO tbl_negotiation_rounds (rfq_id, source_type, source_id, rfq_product_id, round_number, status,
                                         end_date, vendor_ids, vendor_approvals, created_by)
     VALUES ($1, 'RFQ', $1, $2, 1, 'PENDING_APPROVAL', (now() AT TIME ZONE 'UTC') + interval '2 days',
             ARRAY[$3]::int[], $4::jsonb, $5) RETURNING id`,
    [B.work, B.product, ALPHA, JSON.stringify([{ vendor_id: ALPHA, status: "PENDING" }]), B_ADMIN])).id);
  made.round.push(B.round);
  B.te = Number((await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, minimum_passing_score)
     VALUES ($1, $2, 50) RETURNING id`, [B.work, B.product])).id);
  made.te.push(B.te);
  B.teRound = Number((await db.one(
    `INSERT INTO tbl_tech_evaluation_rounds (tbl_rfq_product_tech_evaluation_id, round_number, status, created_by, submitted_at)
     VALUES ($1, 1, 'SUBMITTED', $2, NOW()) RETURNING id`, [B.te, B_ADMIN])).id);
  made.teRound.push(B.teRound);
  B.po = Number((await db.one(
    `INSERT INTO tbl_rfq_purchase_order (rfq_id, company_id, po_number, status, rfq_product_id, quantity,
                                         unit_price, finalized_vendor_id, total_value)
     VALUES ($1, $2, $3, 'pending_approval', ARRAY[$4]::int[], 1, 100, $5, 100) RETURNING id`,
    [B.work, IDS.companies.B, `PO-FORGED-${Date.now()}`, B.product, ALPHA])).id);
  made.po.push(B.po);
  // B's PO is on hold: an OPEN send-back on B's own approval of it. Cancelling
  // a PO's approval closes its hold, so a forged PO instance must not reach it.
  const poApproval = await insertInstance("PO", { entityId: B.po, metadata: { po_id: B.po, rfq_id: B.work } },
    { company: HC_B, hotel: HOTEL_B, withStep: false });
  B.poHold = Number((await db.one(
    `INSERT INTO tbl_po_send_backs (purchase_order_id, rfq_id, approval_instance_id, step_order, route,
                                    reason_category, comment, requested_by, status)
     VALUES ($1, $2, $3, 1, 'COMMERCIAL', 'RENEGOTIATE', 'B holds its own PO', $4, 'OPEN') RETURNING id`,
    [B.po, B.work, poApproval.id, B_ADMIN])).id);
  B.mr = Number((await db.one(
    `INSERT INTO tbl_material_requisition (mr_number, title, hospitality_company_id, hotel_id, department_id,
                                           raised_by, status)
     VALUES ($1, 'Forged target MR', $2, $3, $4, $5, 'pending_approval') RETURNING id`,
    [`MR-FORGED-${Date.now()}`, HC_B, HOTEL_B, DEPT, B_ADMIN])).id);
  made.mr.push(B.mr);
  B.arcTech = await arcB("tech_eval_in_progress", "TECH");
  B.arcCommittee = await arcB("committee_review", "COMMITTEE");
  B.arcPublish = await arcB("pending_publish_approval", "PUBLISH");
  B.arcAmendment = await arcB("contract_active", "AMENDMENT");
  B.contract = Number((await db.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [B.arcAmendment, ALPHA])).id);
  made.contract.push(B.contract);
  B.amendment = Number((await db.one(
    `INSERT INTO tbl_arc_amendment (arc_contract_id, amendment_type, amendment_from, reason, requested_by, status)
     VALUES ($1, 'price', CURRENT_DATE, 'forged target', $2, 'requested') RETURNING id`,
    [B.contract, ALPHA])).id);
  made.amendment.push(B.amendment);
  B.arcNeg = await arcB("comm_eval_in_progress", "NEG");
  B.arcRound = Number((await db.one(
    `INSERT INTO tbl_negotiation_rounds (rfq_id, source_type, source_id, round_number, status, end_date,
                                         vendor_ids, vendor_approvals, created_by)
     VALUES (NULL, 'ARC', $1, 1, 'PENDING_APPROVAL', (now() AT TIME ZONE 'UTC') + interval '2 days',
             ARRAY[$2]::int[], $3::jsonb, $4) RETURNING id`,
    [B.arcNeg, ALPHA, JSON.stringify([{ vendor_id: ALPHA, status: "PENDING" }]), B_ADMIN])).id);
  made.round.push(B.arcRound);
}

/** Every row of company B's world, and the notification count. Any write shows. */
async function worldB() {
  const rows = async (sql, params) => (await db.any(sql, params)).map((r) => r.j);
  const allIds = Object.values(B).filter((v) => typeof v === "number");
  return {
    rfq: await rows(`SELECT to_jsonb(x) AS j FROM tbl_rfq x WHERE id = ANY($1::int[]) ORDER BY id`, [made.rfq]),
    products: await rows(`SELECT to_jsonb(x) AS j FROM tbl_rfq_products x WHERE rfq_id = ANY($1::int[]) ORDER BY id`, [made.rfq]),
    rounds: await rows(
      `SELECT to_jsonb(x) AS j FROM tbl_negotiation_rounds x
        WHERE id = ANY($1::int[]) OR rfq_id = ANY($2::int[]) OR (source_type = 'ARC' AND source_id = ANY($3::int[]))
        ORDER BY id`, [made.round, made.rfq, made.arc]),
    finalization: await rows(`SELECT to_jsonb(x) AS j FROM tbl_quote_finalization x WHERE rfq_id = ANY($1::int[]) ORDER BY id`, [made.rfq]),
    pos: await rows(`SELECT to_jsonb(x) AS j FROM tbl_rfq_purchase_order x WHERE rfq_id = ANY($1::int[]) OR id = ANY($2::int[]) ORDER BY id`, [made.rfq, made.po]),
    poHolds: await rows(`SELECT to_jsonb(x) AS j FROM tbl_po_send_backs x WHERE purchase_order_id = ANY($1::int[]) ORDER BY id`, [made.po]),
    techEvals: await rows(`SELECT to_jsonb(x) AS j FROM tbl_rfq_product_tech_evaluation x WHERE rfq_id = ANY($1::int[]) ORDER BY id`, [made.rfq]),
    techRounds: await rows(`SELECT to_jsonb(x) AS j FROM tbl_tech_evaluation_rounds x WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[]) ORDER BY id`, [made.te]),
    mr: await rows(`SELECT to_jsonb(x) AS j FROM tbl_material_requisition x WHERE id = ANY($1::int[]) ORDER BY id`, [made.mr]),
    arcs: await rows(`SELECT to_jsonb(x) AS j FROM tbl_arc x WHERE id = ANY($1::int[]) ORDER BY id`, [made.arc]),
    arcEvents: await rows(`SELECT to_jsonb(x) AS j FROM tbl_arc_event_log x WHERE arc_id = ANY($1::bigint[]) ORDER BY id`, [made.arc]),
    contracts: await rows(`SELECT to_jsonb(x) AS j FROM tbl_arc_contract x WHERE arc_id = ANY($1::bigint[]) ORDER BY id`, [made.arc]),
    amendments: await rows(`SELECT to_jsonb(x) AS j FROM tbl_arc_amendment x WHERE id = ANY($1::int[]) ORDER BY id`, [made.amendment]),
    lifecycle: await rows(`SELECT to_jsonb(x) AS j FROM tbl_lifecycle_history x WHERE entity_id = ANY($1::int[]) ORDER BY id`, [allIds]),
    notifications: Number((await db.one(`SELECT count(*) AS n FROM tbl_notifications`)).n),
  };
}

// ---- the table: one forgery per registered type --------------------------------

/** entity_id + metadata a company-A instance would carry to act on B's target. */
const FORGERIES = {
  RFQ:               () => ({ entityId: B.rfq, metadata: { rfq_id: B.rfq } }),
  TENDER:            () => ({ entityId: B.tender, metadata: { rfq_id: B.tender } }),
  TECHNICAL:         () => ({ entityId: B.teRound, metadata: { rfq_id: B.work, rfq_product_id: B.product, tech_evaluation_id: B.te } }),
  PO:                () => ({ entityId: B.po, metadata: { po_id: B.po, rfq_id: B.work } }),
  ARC_TECH:          () => ({ entityId: B.arcTech, metadata: { arc_id: B.arcTech } }),
  ARC_COMMITTEE:     () => ({ entityId: B.arcCommittee, metadata: { arc_id: B.arcCommittee } }),
  ARC_PUBLISH:       () => ({ entityId: B.arcPublish, metadata: { arc_id: B.arcPublish } }),
  ARC_AMENDMENT:     () => ({ entityId: B.amendment, metadata: { arc_id: B.arcAmendment, amendment_id: B.amendment } }),
  MR:                () => ({ entityId: B.mr, metadata: { mr_id: B.mr } }),
  NEGOTIATION:       () => ({ entityId: B.round, metadata: { round_id: B.round, rfq_id: B.work, rfq_product_id: B.product } }),
  ARC_NEGOTIATION:   () => ({ entityId: B.arcRound, metadata: { round_id: B.arcRound, arc_id: B.arcNeg } }),
  NEGOTIATION_QUOTE: () => ({ entityId: B.product, metadata: { rfq_id: String(B.work), rfq_product_id: B.product } }),
};
// Variants of a type whose handler reads metadata rather than entity_id.
const VARIANTS = {
  "ARC_NEGOTIATION (entity_id names no round, metadata names B's)": {
    type: "ARC_NEGOTIATION",
    forgery: () => ({ entityId: B.arcRound + 1_000_000, metadata: { round_id: B.arcRound, arc_id: B.arcNeg } }),
  },
};
const CASES = [
  ...Object.keys(FORGERIES).map((type) => [type, { type, forgery: FORGERIES[type] }]),
  ...Object.entries(VARIANTS),
];

async function insertInstance(type, { entityId, metadata }, { company = HC_A, hotel = HOTEL_A, withStep = true } = {}) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances (entity_type, entity_id, approval_policy_id, status, current_step,
                                         initiated_by, hospitality_company_id, hotel_id, department_id, metadata)
     VALUES ($1, $2, $3, 'PENDING', 1, $4, $5, $6, NULL, $7::jsonb) RETURNING *`,
    [type, entityId, POLICY_ID, APPROVER_A, company, hotel, JSON.stringify(metadata)]
  );
  instanceIds.push(Number(inst.id));
  if (withStep) {
    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`, [inst.id]);
    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING')`, [step.id, APPROVER_A]);
  }
  return inst;
}

const decide = async (instanceId, action) => (await httpClient(APPROVER_A))
  .post("/api/v1/general/hospitality/approval/action")
  .send({ approval_instance_id: instanceId, action, comment: "forged" });

/** What a policy or membership change does: the last step completes, then the dispatch. */
async function completeByPropagation(instanceId) {
  const adv = await db.tx(async (t) => {
    await t.none(`UPDATE tbl_approval_instance_steps SET status = 'APPROVED', completed_at = NOW()
                   WHERE approval_instance_id = $1`, [instanceId]);
    return advanceInstanceToNextStep(instanceId, t);
  });
  if (adv.instanceCompleted) {
    await handleAutoCompletedInstances([instanceId], APPROVER_A, "approver membership change");
  }
  return adv;
}

const instanceRow = async (id) => db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id]);
const actionCount = async (id) => Number((await db.one(
  `SELECT count(*) AS n FROM tbl_approval_actions WHERE approval_instance_id = $1`, [id])).n);

beforeAll(async () => {
  savedUsers = await db.any(`SELECT id, user_type, status FROM tbl_users WHERE id = ANY($1::int[])`, [[APPROVER_A, B_ADMIN]]);
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [[APPROVER_A, B_ADMIN]]);
  await db.none(
    `INSERT INTO tbl_approval_policies (id, entity_type, hospitality_company_id, hotel_id, department_id,
                                        is_active, created_by, process_id, is_master, is_department_scoped, version)
     VALUES ($1, 'RFQ', $2, $3, NULL, false, $4, NULL, false, false, 1)
     ON CONFLICT (id) DO NOTHING`, [POLICY_ID, HC_A, HOTEL_A, APPROVER_A]);
  await seedCompanyB();
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_po_send_backs WHERE purchase_order_id = ANY($1::int[])`, [made.po]);
  if (instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                     (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE (metadata->>'approval_instance_id') = ANY($1::text[])`,
      [instanceIds.map(String)]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
  }
  await db.none(`DELETE FROM tbl_arc_amendment WHERE id = ANY($1::int[])`, [made.amendment]);
  await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[])`, [made.arc]);
  await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [made.arc]);
  await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [made.arc]);
  await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [made.round]);
  await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [made.arc]);
  await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::int[])`, [made.mr]);
  await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [made.po]);
  await db.none(`DELETE FROM tbl_tech_evaluation_rounds WHERE id = ANY($1::int[])`, [made.teRound]);
  await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE id = ANY($1::int[])`, [made.te]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [made.product]);
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [made.rfq]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [made.rfq]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
  for (const u of savedUsers) {
    await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [u.id, u.user_type, u.status]);
  }
});

describe("a forged instance acts on nobody else's target, for every registered type", () => {
  it("the table covers every type the dispatcher has a handler for", () => {
    expect(Object.keys(FORGERIES).sort()).toEqual([...REGISTERED_APPROVAL_TYPES].sort());
  });

  describe.each(CASES)("%s", (label, { type, forgery }) => {
    it("approve and reject through the action route answer like a missing instance and write nothing", async () => {
      const missing = await decide(2_000_000_000, "APPROVE");
      for (const action of ["APPROVE", "REJECT"]) {
        const forged = await insertInstance(type, forgery());
        const before = await worldB();
        const res = await decide(forged.id, action);
        expect({ action, world: await worldB() }).toEqual({ action, world: before });
        expect({ action, status: res.status, body: res.body }).toEqual({ action, status: 404, body: missing.body });
        expect(res.body).toEqual(NOT_FOUND);
        expect((await instanceRow(forged.id)).status).toBe("PENDING");
        expect(await actionCount(forged.id)).toBe(0);
      }
    });

    it("propagation completing it runs no handler and writes nothing", async () => {
      const forged = await insertInstance(type, forgery());
      const before = await worldB();
      await completeByPropagation(forged.id);
      expect(await worldB()).toEqual(before);
    });

    it("cancelling it through the app cancels it and writes nothing to the target (a PO's hold stays open)", async () => {
      const forged = await insertInstance(type, forgery());
      const before = await worldB();
      const res = await (await httpClient(APPROVER_A))
        .post("/api/v1/general/hospitality/approval/cancel")
        .send({ instance_id: forged.id, reason: "forged" });
      expect(await worldB()).toEqual(before);
      expect(res.status).toBe(200);
      expect((await instanceRow(forged.id)).status).toBe("CANCELLED");
    });

    it("the same target under its own company's instance resolves to that company", async () => {
      const f = forgery();
      const forged = await insertInstance(type, f, { withStep: false });
      const ownership = await instanceTargetCompany(db, { ...forged, hospitality_company_id: HC_B });
      // A variant naming no real target resolves to nobody.
      expect(ownership).toBe(type === label ? HC_B : null);
    });
  });
});

describe("pre-deploy gate (check 6) and its operator block", () => {
  const sqlText = () => fs.readFileSync(SQL_FILE, "utf8");
  const squash = (s) => s.replace(/\s+/g, " ").trim();
  const gateSql = () => {
    const s = sqlText();
    return s.slice(s.indexOf("-- 6. GATE"), s.indexOf("-- 7. FORENSIC"));
  };
  const operatorBlock = (ids, actor) => {
    const s = sqlText();
    const block = s.slice(s.indexOf("-- BEGIN;"), s.indexOf("-- COMMIT;") + "-- COMMIT;".length);
    return block.split("\n").map((l) => l.replace(/^-- ?/, "")).join("\n")
      .replace("/* reviewed ids from check 6 */", ids.join(", "))
      .replace("/* operator user id */", String(actor));
  };

  it("resolves targets with the app's own SQL, verbatim", () => {
    expect(squash(gateSql())).toContain(squash(TARGET_COMPANY_CTES));
  });

  it("lists every forged PENDING instance and no legitimate one; the block cancels exactly those, like the app", async () => {
    const forged = [];
    const legit = [];
    for (const [, { type, forgery }] of CASES) {
      forged.push(Number((await insertInstance(type, forgery())).id));
    }
    // Company B's own instances on the same targets (one per type, the base forgeries).
    for (const type of Object.keys(FORGERIES)) {
      legit.push(Number((await insertInstance(type, FORGERIES[type](), { company: HC_B, hotel: HOTEL_B })).id));
    }
    const listed = (await db.any(gateSql())).map((r) => Number(r.id));
    expect(forged.filter((id) => !listed.includes(id))).toEqual([]);
    expect(legit.filter((id) => listed.includes(id))).toEqual([]);

    // The row-count check: a reviewed id that is no longer PENDING (concluded
    // between the review and the run) aborts the whole block.
    const concluded = Number((await insertInstance("RFQ", FORGERIES.RFQ())).id);
    await db.none(`UPDATE tbl_approval_instances SET status = 'APPROVED', completed_at = NOW() WHERE id = $1`, [concluded]);
    await expect(db.tx((t) => t.none(operatorBlock([...forged, concluded], APPROVER_A)
      .replace("BEGIN;", "").replace("COMMIT;", "")))).rejects.toThrow(/SEC1 cancel/);
    expect(new Set((await db.any(
      `SELECT status FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [forged])).map((r) => r.status)))
      .toEqual(new Set(["PENDING"]));

    // Every forged row, the PO's included: B's hold on its PO is B's approval's
    // and stays open (the world check below), as the app's cancel leaves it.
    const holdBefore = await worldB();
    const cancelled = forged;
    await db.tx((t) => t.none(operatorBlock(cancelled, APPROVER_A).replace("BEGIN;", "").replace("COMMIT;", "")));
    expect(await worldB()).toEqual(holdBefore);
    const after = await db.any(
      `SELECT ai.id, ai.status, ai.completed_at IS NOT NULL AS done,
              (SELECT array_agg(DISTINCT s.status) FROM tbl_approval_instance_steps s WHERE s.approval_instance_id = ai.id) AS steps,
              (SELECT array_agg(a.action || '|' || a.comment || '|' || a.approver_user_id)
                 FROM tbl_approval_actions a WHERE a.approval_instance_id = ai.id) AS actions
         FROM tbl_approval_instances ai WHERE ai.id = ANY($1::int[]) ORDER BY ai.id`, [[...forged, ...legit]]);
    for (const row of after) {
      const id = Number(row.id);
      if (cancelled.includes(id)) {
        expect(row).toMatchObject({
          status: "CANCELLED", done: true, steps: ["CANCELLED"],
          actions: [`CANCELLED|[CANCELLED] SEC1: target belongs to another company or does not exist|${APPROVER_A}`],
        });
      } else {
        expect({ id, status: row.status, actions: row.actions }).toEqual({ id, status: "PENDING", actions: null });
      }
    }
    // Cancelled: the gate no longer lists them.
    const relisted = (await db.any(gateSql())).map((r) => Number(r.id));
    expect(cancelled.filter((id) => relisted.includes(id))).toEqual([]);
  });
});
