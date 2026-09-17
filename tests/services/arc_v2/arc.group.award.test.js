// Group ARC — awarding by hotel, and the contract that follows.
//
// The committee awards each item hotel by hotel: one vendor for every hotel,
// or split ("alpha supplies A1 and A2, beta supplies A3"). A vendor can win
// only the hotels it was invited for. A hotel may stay unawarded when no
// invited vendor serves it. Each winning vendor then gets ONE contract whose
// lines carry a per-hotel ledger, and the contract document carries a page
// (annexure) for every hotel it covers, with that hotel's legal identity.
//
// Scenario — Company A, Beverages, lead A1, covering A1 (400) + A2 (350) + A3 (250):
//   alpha invited for A1 + A2 (rate 90)      beta invited for A3 (rate 95)
//
// Product-level: seeded at the commercial stage (submission closed, no
// technical clauses), then driven over HTTP.

import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { markAsVendors, restoreUserTypes, deleteArcs } from "../../helpers/arcGroupSeed.js";
import { seedGroupArcPolicy, cleanupGroupArcPolicies } from "../../helpers/arcGroupPolicy.js";
import { generateContractsForArc, loadContractDocContext, loadContractAnnexures, renderContractDocumentHtml }
  from "../../../app/controllers/arc_v2/arcContractController.js";
import arcContractModel from "../../../app/models/arc_v2/arcContractModel.js";

const { A1, A2, A3, B1 } = IDS.hotels;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const BUYER = IDS.users.companyA_admin;
const ALPHA = IDS.users.vendor_alpha;
const BETA = IDS.users.vendor_beta;
const E = "/api/v1/arc-v2/evaluation";

describe("Group ARC — award by hotel and per-hotel contracts", () => {
  let arcId, itemId, lineAlpha, lineBeta;
  let buyer;
  let typesBefore;
  const policyIds = [];

  const alloc = (vendorId, hotelId, qty) => ({
    awarded_vendor_id: vendorId,
    hotel_id: hotelId,
    allocated_qty: qty,
    awarded_quote_line_id: vendorId === ALPHA ? lineAlpha : lineBeta,
    l_rank: vendorId === ALPHA ? "L1" : "L2",
    awarded_quote_snapshot: { rate: vendorId === ALPHA ? 90 : 95, gst_pct: 5 },
  });
  const save = (allocations) => buyer.post(`${E}/${arcId}/comm-eval/allocation`).send({ item_id: itemId, allocations });

  beforeAll(async () => {
    typesBefore = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    typesBefore.push(...(await markAsVendors([ALPHA, BETA])));
    await seedArcEvalPerms(db, [BUYER]);
    buyer = await httpClient(BUYER);

    arcId = Number((await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
          status, eligibility_type, is_group,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          payment_terms_expected, delivery_expected, created_by)
       VALUES ('ARC-GROUP-AWARD-' || floor(random() * 1e9)::text, 'Group award', $1, $2, $3, $4,
               'submission_closed', 'open', true,
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '365 days',
               'Net 30', 'Within 7 days', $5)
       RETURNING id`,
      [TEST_CATEGORIES.beverages, HC_A, A1, PROC, BUYER]
    )).id);
    await db.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id) SELECT $1, h FROM unnest($2::int[]) h`, [arcId, [A1, A2, A3]]);
    itemId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, 1, 1000, 'pcs') RETURNING id`,
      [arcId]
    )).id);
    await db.none(
      `INSERT INTO tbl_arc_item_hotel_qty (arc_item_id, hotel_id, indicative_qty) VALUES ($1, $2, 400), ($1, $3, 350), ($1, $4, 250)`,
      [itemId, A1, A2, A3]
    );
    for (const [vendorId, hotels] of [[ALPHA, [A1, A2]], [BETA, [A3]]]) {
      const inv = await db.one(
        `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, 'submitted') RETURNING id`,
        [arcId, vendorId]
      );
      await db.none(`INSERT INTO tbl_arc_invitation_hotel (arc_invitation_id, hotel_id) SELECT $1, h FROM unnest($2::int[]) h`, [inv.id, hotels]);
    }
    const quoteLine = async (vendorId, rate) => {
      const q = await db.one(`INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING id`, [arcId, vendorId]);
      return Number((await db.one(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct) VALUES ($1, $2, $3, 5) RETURNING id`,
        [q.id, itemId, rate]
      )).id);
    };
    lineAlpha = await quoteLine(ALPHA, 90);
    lineBeta = await quoteLine(BETA, 95);
  });

  afterAll(async () => {
    await cleanupGroupArcPolicies(policyIds);
    await db.none(`DELETE FROM tbl_arc_contract_clarification WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    await deleteArcs([arcId]);
    await cleanupArcEvalPerms(db, [BUYER]);
    await restoreUserTypes(typesBefore);
  });

  describe("saving an allocation", () => {
    test.each([
      ["a vendor for a hotel it was not invited for", () => [alloc(BETA, A1, 400)], /not invited/i],
      ["a hotel the contract does not cover", () => [alloc(ALPHA, B1, 400)], /not covered/i],
      ["a hotel's quantities that do not add up", () => [alloc(ALPHA, A1, 300)], /A1|10101/],
    ])("rejects %s", async (_label, build, message) => {
      const res = await save(build());
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
    });

    test("stores one award per vendor with its per-hotel split", async () => {
      const res = await save([alloc(ALPHA, A1, 400), alloc(ALPHA, A2, 350), alloc(BETA, A3, 250)]);
      expect(res.status).toBe(200);
      const awards = await db.any(
        `SELECT a.awarded_vendor_id AS vendor_id, a.allocated_qty::float AS qty,
                array_agg(h.hotel_id || ':' || h.allocated_qty::float ORDER BY h.hotel_id) AS split
           FROM tbl_arc_comm_evaluation_award a
           JOIN tbl_arc_comm_evaluation c ON c.id = a.arc_comm_evaluation_id
           JOIN tbl_arc_comm_evaluation_award_hotel h ON h.arc_comm_evaluation_award_id = a.id
          WHERE c.arc_id = $1
          GROUP BY a.id ORDER BY a.awarded_vendor_id`,
        [arcId]
      );
      expect(awards).toEqual([
        { vendor_id: ALPHA, qty: 750, split: [`${A1}:400`, `${A2}:350`] },
        { vendor_id: BETA, qty: 250, split: [`${A3}:250`] },
      ]);
    });

    test("the commercial read carries hotels, the per-hotel quantities and each award's split", async () => {
      const res = await buyer.get(`${E}/${arcId}/comm-eval`);
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.arc.is_group).toBe(true);
      expect(d.hotels.map((h) => h.hotel_id)).toEqual([A1, A2, A3]);
      expect(d.item_hotel_qtys[String(itemId)]).toEqual([
        { hotel_id: A1, indicative_qty: 400 }, { hotel_id: A2, indicative_qty: 350 }, { hotel_id: A3, indicative_qty: 250 },
      ]);
      expect(d.invitation_hotels).toEqual({ [ALPHA]: [A1, A2], [BETA]: [A3] });
      const alphaAward = d.awards.find((a) => Number(a.awarded_vendor_id) === ALPHA);
      expect(alphaAward.hotels).toEqual([{ hotel_id: A1, allocated_qty: 400 }, { hotel_id: A2, allocated_qty: 350 }]);
    });
  });

  describe("finalizing", () => {
    test("an item awarded at no hotel cannot be finalized", async () => {
      expect((await save([])).status).toBe(200);
      const res = await buyer.post(`${E}/${arcId}/comm-eval/finalize`).send({});
      expect(res.status).toBe(400);
    });

    test("a hotel may stay unawarded; finalize names it and the contract covers the awarded hotels", async () => {
      policyIds.push(await seedGroupArcPolicy({
        companyId: HC_A, approver: BUYER, createdBy: BUYER, entityType: "ARC_GROUP_COMMITTEE",
      }));
      expect((await save([alloc(ALPHA, A1, 400), alloc(ALPHA, A2, 350)])).status).toBe(200);
      const res = await buyer.post(`${E}/${arcId}/comm-eval/finalize`).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.unawarded).toEqual([{ item_id: itemId, hotel_id: A3 }]);

      const contracts = await db.any(`SELECT id, vendor_id FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
      expect(contracts.map((c) => Number(c.vendor_id))).toEqual([ALPHA]);
      const ledger = await db.any(
        `SELECT l.committed_qty::float AS line_qty, h.hotel_id, h.committed_qty::float AS hotel_qty, h.consumed_qty::float AS used
           FROM tbl_arc_contract_line l
           JOIN tbl_arc_contract_line_hotel h ON h.arc_contract_line_id = l.id
          WHERE l.arc_contract_id = $1 ORDER BY h.hotel_id`,
        [contracts[0].id]
      );
      expect(ledger).toEqual([
        { line_qty: 750, hotel_id: A1, hotel_qty: 400, used: 0 },
        { line_qty: 750, hotel_id: A2, hotel_qty: 350, used: 0 },
      ]);
    });

    test("regenerating contracts keeps what each hotel has already consumed", async () => {
      const contract = await db.one(`SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, ALPHA]);
      await db.none(
        `UPDATE tbl_arc_contract_line_hotel SET consumed_qty = 50
          WHERE hotel_id = $1 AND arc_contract_line_id IN (SELECT id FROM tbl_arc_contract_line WHERE arc_contract_id = $2)`,
        [A1, contract.id]
      );
      await db.tx((t) => generateContractsForArc(arcId, { txContext: t, generatedBy: BUYER }));
      const row = await db.one(
        `SELECT h.committed_qty::float AS committed, h.consumed_qty::float AS used
           FROM tbl_arc_contract_line_hotel h
           JOIN tbl_arc_contract_line l ON l.id = h.arc_contract_line_id
          WHERE l.arc_contract_id = $1 AND h.hotel_id = $2`,
        [contract.id, A1]
      );
      expect(row).toEqual({ committed: 400, used: 50 });
    });
  });

  describe("the contract document", () => {
    test("has an annexure per covered hotel with its legal identity and quantities", async () => {
      const contract = await db.one(`SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, ALPHA]);
      const annexures = await loadContractAnnexures(arcId, contract.id);
      expect(annexures.map((a) => a.hotel_id)).toEqual([A1, A2]);
      expect(annexures[0]).toHaveProperty("gst");
      expect(annexures[0].lines).toEqual([expect.objectContaining({ arc_item_id: itemId, committed_qty: 400 })]);

      const hotels = await db.any(`SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[]) ORDER BY id`, [[A1, A2]]);
      const ctx = await loadContractDocContext(arcId);
      expect(ctx.is_group).toBe(true);
      const html = renderContractDocumentHtml(ctx, { name: "Alpha" }, await arcContractModel.listLines(contract.id), { annexures });
      expect(html).toMatch(/Annexure A/);
      for (const h of hotels) expect(html).toContain(h.name);
    });
  });

  describe("disputes on a group award", () => {
    test("a vendor cannot dispute the committed quantity; price disputes still go through", async () => {
      const contract = await db.one(`SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, ALPHA]);
      const line = await db.one(`SELECT id FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contract.id]);
      const vendor = await httpClient(ALPHA);
      const qty = await vendor.post(`/api/v1/arc-v2/vendor/contracts/${contract.id}/clarification`).send({
        items: [{ arc_contract_line_id: line.id, field: "committed_qty", comment: "Too much" }],
      });
      expect(qty.status).toBe(400);
      expect(qty.body.message).toMatch(/per-hotel quantities/i);
      const price = await vendor.post(`/api/v1/arc-v2/vendor/contracts/${contract.id}/clarification`).send({
        items: [{ arc_contract_line_id: line.id, field: "base_price", comment: "Freight moved" }],
      });
      expect(price.status).toBe(200);
    });

    test("the buyer cannot revise a committed quantity on a group award", async () => {
      const contract = await db.one(`SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, ALPHA]);
      const clar = await db.one(
        `INSERT INTO tbl_arc_contract_clarification
           (arc_id, arc_contract_id, arc_item_id, vendor_id, field, round, vendor_comment, status, raised_by)
         VALUES ($1, $2, $3, $4, 'committed_qty', 99, 'legacy dispute', 'open', $4) RETURNING id`,
        [arcId, contract.id, itemId, ALPHA]
      );
      const res = await buyer.post(`${E}/${arcId}/comm-eval/clarification/${clar.id}/revise`).send({ value: 500, response: "ok" });
      expect(res.status).toBe(409);
    });
  });
});
