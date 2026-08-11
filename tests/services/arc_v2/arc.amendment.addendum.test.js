// ARC amendment ADDENDUM re-signing — end-to-end HTTP flow.
//
// Proves the sign-to-activate gate added on top of the amendment flow:
//   1. Approval no longer binds effects — it generates an addendum and parks
//      the amendment in 'awaiting_signature'. A call-off priced in that gap
//      window must use the OLD rate.
//   2. The vendor signs the addendum (OTP). Only then do effects bind: the
//      amendment goes live, the new rate applies, the addendum is 'signed'
//      with its own hash, and the ORIGINAL contract document is untouched.
//   3. Term extensions move tbl_arc.contract_end_at only after signature.
//   4. Decline voids the amendment + addendum; the contract is unchanged.
//   5. Ownership: only the contracted vendor may sign/decline (403 otherwise).
//   6. Idempotency: signing a signed/voided addendum is 409.
//   7. Edit-then-approve (buyer counter-offer) is what the addendum binds.
//   8. The buyer active-summary exposes addendums[].

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { resolveCurrentPrice } from "../../../app/services/arcPricingResolver.js";
import { ensureArcApprovable } from "../../helpers/arcApproverPerms.js";

const HC        = IDS.hospitality.A;
const HOTEL     = IDS.hotels.A1;
const DEPT      = IDS.departments.proc;
const PROC      = IDS.processes.A_P1;
const BUYER     = IDS.users.a1_proc_buyer;     // not on the amendment policy
const APPROVER  = IDS.users.a1_proc_techApp;   // single-step approver
const VENDOR    = IDS.users.vendor_alpha;
const VENDOR2   = IDS.users.vendor_beta;
const CATEGORY  = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;
const POLICY_ID  = 64902; // outside the fixtures' 60001..60099 range

const dIso = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const getAmendment = (id) => db.one(`SELECT * FROM tbl_arc_amendment WHERE id = $1`, [id]);
const getAddendumByAmendment = (amId) =>
  db.oneOrNone(`SELECT * FROM tbl_arc_amendment_document WHERE arc_amendment_id = $1`, [amId]);

// Approve a freshly-requested amendment through the single-step engine.
async function approve(approverClient, amendmentId, edit = null) {
  const body = { decision: "approve" };
  if (edit) body.edit = edit;
  return approverClient.post(`/api/v1/arc-v2/amendments/${amendmentId}/review`).send(body);
}

// Sign an addendum end-to-end via the OTP machinery.
async function signAddendum(vendorClient, addendumId) {
  const otp = await vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${addendumId}/otp/request`).send({});
  if (otp.status !== 200) return otp;
  return vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${addendumId}/otp/verify`)
    .send({ code: otp.body.data.dev_code });
}

describe("ARC amendment addendum re-signing", () => {
  let vendorClient, vendor2Client, approverClient, buyerClient;
  let arcId, contractId, line1Id, line2Id;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id IN ($1, $2)`, [VENDOR, VENDOR2]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id IN ($1, $2)`, [BUYER, APPROVER]);

    vendorClient   = await httpClient(VENDOR);
    vendor2Client  = await httpClient(VENDOR2);
    approverClient = await httpClient(APPROVER);
    buyerClient    = await httpClient(BUYER);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ('ARC-TEST-ADDM-1', 'Addendum flow ARC', $1, $2, $3, $4, $5,
               'contract_active',
               NOW() - INTERVAL '40 days', NOW() - INTERVAL '30 days',
               NOW() - INTERVAL '20 days', (NOW() + INTERVAL '180 days')::date,
               $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    const item1 = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 500, 'litre') RETURNING *`, [arcId, VARIANT_ID]);
    const item2 = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 200, 'kg') RETURNING *`, [arcId, VARIANT_ID + 1]);
    // Original contract carries a signed-document hash — we assert it is NEVER
    // mutated by addendum signing.
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, document_hash, document_s3_url, signed_by_vendor_at)
       VALUES ($1, $2, 'active', 'ORIG-HASH-XYZ', 'https://s3/orig.pdf', NOW() - INTERVAL '10 days') RETURNING *`,
      [arcId, VENDOR]);
    contractId = contract.id;
    line1Id = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 100, 5, 500) RETURNING id`, [contractId, item1.id])).id;
    line2Id = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 50, 5, 200) RETURNING id`, [contractId, item2.id])).id;

    // Single-step ARC_AMENDMENT policy: APPROVER alone reaches terminal APPROVED.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_AMENDMENT', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [POLICY_ID, APPROVER]
    );
    // USER-source steps are permission-gated at instance creation: APPROVER is
    // the only user named on this policy's step, so only APPROVER needs
    // read+approve on 'arc' — BUYER deliberately is not on the policy.
    await ensureArcApprovable(db, APPROVER, HC);
  });

  afterAll(async () => {
    const instanceIds = (await db.any(
      `SELECT approval_instance_id AS id FROM tbl_arc_amendment
        WHERE arc_contract_id = $1 AND approval_instance_id IS NOT NULL`, [contractId]
    )).map((r) => r.id);
    // Addendum docs + their OTP rows cascade from the amendment delete, but be
    // explicit so a failed run leaves no orphans.
    await db.none(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_amendment_document
                    WHERE arc_amendment_id IN (SELECT id FROM tbl_arc_amendment WHERE arc_contract_id = $1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_amendment_edit_history
                    WHERE arc_amendment_id IN (SELECT id FROM tbl_arc_amendment WHERE arc_contract_id = $1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_amendment WHERE arc_contract_id = $1`, [contractId]);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  });

  // Shared ids across the price sign-flow tests.
  let priceAmdId, priceAddendumId;

  test("approval parks in awaiting_signature + creates addendum; gap-window prices at OLD rate", async () => {
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(0), amendment_to: dIso(60),
      reason: "Cost inflation pass-through",
      payload: { arc_contract_line_id: line1Id, new_rate: 200 },
    });
    expect(req.status).toBe(200);
    priceAmdId = req.body.data.amendment.id;

    const rev = await approve(approverClient, priceAmdId);
    expect(rev.status).toBe(200);
    expect(rev.body.data.amendment.status).toBe("awaiting_signature");

    const doc = await getAddendumByAmendment(priceAmdId);
    expect(doc).toBeTruthy();
    expect(doc.status).toBe("awaiting_signature");
    expect(doc.document_hash).toBeTruthy(); // content-hash fallback under test env
    priceAddendumId = doc.id;

    // Gap window: effects are NOT bound yet → resolver returns the old rate.
    const priced = await resolveCurrentPrice(line1Id, new Date());
    expect(Number(priced.unit_rate)).toBe(100);
    expect(priced.applied_amendment_id).toBeNull();

    // The vendor-facing reads must surface the addendum id on the amendment row
    // (the FE sign CTAs depend on it). Both contract-detail and My Amendments.
    const detail = await vendorClient.get(`/api/v1/arc-v2/vendor/contracts/${contractId}`);
    const fromDetail = detail.body.data.amendments.find((a) => a.id === priceAmdId);
    expect(Number(fromDetail.addendum_id)).toBe(Number(priceAddendumId));
    expect(fromDetail.addendum_status).toBe("awaiting_signature");
    const list = await vendorClient.get(`/api/v1/arc-v2/vendor/amendments`);
    const fromList = list.body.data.amendments.find((a) => a.id === priceAmdId);
    expect(Number(fromList.addendum_id)).toBe(Number(priceAddendumId));
  });

  test("vendor signs the addendum (OTP) → amendment live, new rate applies, original contract untouched", async () => {
    const before = await db.one(`SELECT document_hash FROM tbl_arc_contract WHERE id = $1`, [contractId]);

    const signed = await signAddendum(vendorClient, priceAddendumId);
    expect(signed.status).toBe(200);

    const am = await getAmendment(priceAmdId);
    expect(am.status).toBe("live");

    const doc = await db.one(`SELECT * FROM tbl_arc_amendment_document WHERE id = $1`, [priceAddendumId]);
    expect(doc.status).toBe("signed");
    expect(doc.signed_by_vendor_at).not.toBeNull();
    expect(Number(doc.signed_by)).toBe(VENDOR);
    expect(doc.document_hash).toBeTruthy();

    // New rate now applies within the window.
    const priced = await resolveCurrentPrice(line1Id, new Date());
    expect(Number(priced.unit_rate)).toBe(200);
    expect(Number(priced.applied_amendment_id)).toBe(Number(priceAmdId));

    // The consumption view must surface the EFFECTIVE rate (200) while keeping
    // the committed baseline (100) — so a live amendment is visible on the
    // contract, not just on the amendment record.
    const summary = await buyerClient.get(`/api/v1/arc-v2/${arcId}/active-summary`);
    const cons = summary.body.data.contracts
      .flatMap((c) => c.consumption || [])
      .find((ln) => Number(ln.arc_contract_line_id) === Number(line1Id));
    expect(Number(cons.unit_rate)).toBe(100);            // committed baseline preserved
    expect(Number(cons.effective_unit_rate)).toBe(200);  // amended effective rate surfaced
    expect(Number(cons.amendment_id)).toBe(Number(priceAmdId));

    // The vendor contract-detail lines must surface it too (separate query).
    const vdetail = await vendorClient.get(`/api/v1/arc-v2/vendor/contracts/${contractId}`);
    const vline = vdetail.body.data.lines.find((l) => Number(l.id) === Number(line1Id));
    expect(Number(vline.unit_rate)).toBe(100);
    expect(Number(vline.effective_unit_rate)).toBe(200);

    // The ORIGINAL contract document hash is unchanged.
    const after = await db.one(`SELECT document_hash FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    expect(after.document_hash).toBe(before.document_hash);
    expect(after.document_hash).toBe("ORIG-HASH-XYZ");

    // addendum_signed event logged.
    const ev = await db.oneOrNone(
      `SELECT 1 FROM tbl_arc_event_log
        WHERE arc_id = $1 AND event_type = 'addendum_signed'
          AND (payload->>'amendment_id')::bigint = $2`, [arcId, priceAmdId]);
    expect(ev).toBeTruthy();
  });

  test("idempotency: requesting OTP on an already-signed addendum is 409", async () => {
    const res = await vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${priceAddendumId}/otp/request`).send({});
    expect(res.status).toBe(409);
  });

  test("term extension moves contract_end_at ONLY after signature", async () => {
    const newEnd = dIso(240);
    const before = await db.one(`SELECT contract_end_at::date::text AS d FROM tbl_arc WHERE id = $1`, [arcId]);

    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "term",
      amendment_from: newEnd, reason: "Extend to FY close",
    });
    expect(req.status).toBe(200);
    const termId = req.body.data.amendment.id;

    const rev = await approve(approverClient, termId);
    expect(rev.status).toBe(200);
    expect(rev.body.data.amendment.status).toBe("awaiting_signature");
    // Unchanged until signature.
    const mid = await db.one(`SELECT contract_end_at::date::text AS d FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(mid.d).toBe(before.d);

    const doc = await getAddendumByAmendment(termId);
    const signed = await signAddendum(vendorClient, doc.id);
    expect(signed.status).toBe(200);

    expect((await getAmendment(termId)).status).toBe("live");
    const after = await db.one(`SELECT contract_end_at::date::text AS d FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(after.d).toBe(newEnd);
  });

  // Shared ids for the decline + cross-vendor tests.
  let declineAmdId, declineAddendumId;

  test("approved amendment can be declined by the vendor → amendment + addendum voided, contract unchanged", async () => {
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "qty",
      amendment_from: dIso(0), amendment_to: dIso(60),
      reason: "Seasonal uplift", payload: { arc_contract_line_id: line2Id, new_qty: 999 },
    });
    expect(req.status).toBe(200);
    declineAmdId = req.body.data.amendment.id;
    const rev = await approve(approverClient, declineAmdId);
    expect(rev.status).toBe(200);
    declineAddendumId = (await getAddendumByAmendment(declineAmdId)).id;

    const res = await vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${declineAddendumId}/decline`)
      .send({ reason: "Changed our mind" });
    expect(res.status).toBe(200);

    expect((await getAmendment(declineAmdId)).status).toBe("voided");
    expect((await db.one(`SELECT status FROM tbl_arc_amendment_document WHERE id = $1`, [declineAddendumId])).status).toBe("voided");

    // line2 unchanged: resolver returns the original committed qty + rate.
    const priced = await resolveCurrentPrice(line2Id, new Date());
    expect(Number(priced.committed_qty_effective)).toBe(200);
    expect(priced.applied_amendment_id).toBeNull();
  });

  test("a different vendor cannot sign or decline this vendor's addendum (403)", async () => {
    // Re-create a fresh awaiting-signature addendum on line2 (now free after the
    // decline above) to attack.
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "qty",
      amendment_from: dIso(0), amendment_to: dIso(60),
      reason: "Retry uplift", payload: { arc_contract_line_id: line2Id, new_qty: 777 },
    });
    expect(req.status).toBe(200);
    const amId = req.body.data.amendment.id;
    await approve(approverClient, amId);
    const addId = (await getAddendumByAmendment(amId)).id;

    const otp = await vendor2Client.post(`/api/v1/arc-v2/vendor/addendums/${addId}/otp/request`).send({});
    expect(otp.status).toBe(403);
    const dec = await vendor2Client.post(`/api/v1/arc-v2/vendor/addendums/${addId}/decline`).send({ reason: "x" });
    expect(dec.status).toBe(403);
  });

  test("edit-then-approve counter-offer is what the addendum binds", async () => {
    // line2 still has an in-flight qty amendment from the previous test — void it
    // first by declining, then raise a price counter-offer on the freed line.
    const pending = await db.one(
      `SELECT id FROM tbl_arc_amendment
        WHERE arc_contract_id = $1 AND status = 'awaiting_signature'
          AND (payload->>'arc_contract_line_id')::bigint = $2
        ORDER BY id DESC LIMIT 1`, [contractId, line2Id]);
    const pendDoc = await getAddendumByAmendment(pending.id);
    await vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${pendDoc.id}/decline`).send({ reason: "clear" });

    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(0), amendment_to: dIso(60),
      reason: "Vendor asks 300", payload: { arc_contract_line_id: line2Id, new_rate: 300 },
    });
    expect(req.status).toBe(200);
    const amId = req.body.data.amendment.id;

    // Buyer counter-offers 350.
    const rev = await approve(approverClient, amId, { new_rate: 350 });
    expect(rev.status).toBe(200);
    expect(rev.body.data.amendment.status).toBe("awaiting_signature");

    const doc = await getAddendumByAmendment(amId);
    const signed = await signAddendum(vendorClient, doc.id);
    expect(signed.status).toBe(200);

    // The bound rate is the COUNTER (350), not the vendor's original (300).
    const priced = await resolveCurrentPrice(line2Id, new Date());
    expect(Number(priced.unit_rate)).toBe(350);
    const am = await getAmendment(amId);
    expect(Number(am.payload.new_rate)).toBe(350);
  });

  test("buyer active-summary exposes addendums[]", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}/active-summary`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.addendums)).toBe(true);
    expect(res.body.data.addendums.length).toBeGreaterThan(0);
    const signedOne = res.body.data.addendums.find((a) => a.arc_amendment_id === priceAmdId);
    expect(signedOne).toBeTruthy();
    expect(signedOne.status).toBe("signed");
  });
});
