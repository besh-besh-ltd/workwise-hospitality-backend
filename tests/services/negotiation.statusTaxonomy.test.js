// negotiation.statusTaxonomy.test.js — the seven-state negotiation taxonomy.
//
// The raw `tbl_negotiation_rounds.status` column collapses distinct situations
// into the same word, and the two surfaces that render it used to disagree:
//
//   • EXPIRED is written ONLY by the approval-deadline cron. All 171 in
//     production have zero approvals, zero publishes and zero vendor quotes —
//     they never reached a vendor. Labelling them the same as CANCELLED (88,
//     of which 29 were published and 14 collected quotes) hid that entirely.
//   • ENDED covers three unrelated situations: nobody replied (177), replies
//     are waiting for a decision (92), and the decision was already taken
//     downstream (353).
//   • The listing derived a status and the detail page read the raw column, so
//     a row labelled "Cancelled" opened a page headed "Expired".
//   • The listing's round denominator was COUNT(*) over the RFQ while
//     round_number is allocated per product — "Round 4 of 138" on RFQ 512.
//
// Everything below is asserted over real HTTP against the two endpoints a
// buyer actually uses, never against helper internals.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const HC_A = IDS.hospitality.A;
const HOTEL_A = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;

// Role 8 = Commercial Negotiator — carries negotiation.{read,create,update,approve}.
const ROLE_NEG_FULL = 8;

// Distinct from every other suite's policy id (64960 / 64970 are taken).
const POLICY_ID = 64980;

const stamp = (daysFromNow) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString().replace("T", " ").slice(0, 19);

let client;
let negScopeId;
let rfqId;
const RP = {}; // product key → tbl_rfq_products.id
const R = {}; // round key → tbl_negotiation_rounds.id
const createdInstanceIds = [];
const createdStepIds = [];

async function addProduct(key, variantId) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, qap, variant)
     VALUES ($1, '', '0', '', '', $2, '0', $2)
     RETURNING id`,
    [rfqId, variantId]
  );
  RP[key] = Number(row.id);
  return RP[key];
}

async function addRound(key, { productKey, roundNumber, status, endDate, closedAt = null }) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, rfq_product_id, round_number, status,
        end_date, closed_at, vendor_ids, created_by)
     VALUES ($1, 'RFQ', $1, $2, $3, $4, $5, $6, ARRAY[$7]::int[], $8)
     RETURNING id`,
    [rfqId, RP[productKey], roundNumber, status, endDate, closedAt, VENDOR, BUYER]
  );
  R[key] = Number(row.id);
  return R[key];
}

/** A single round covering several products via the `products` JSONB shape. */
async function addMultiProductRound(key, productKeys, { roundNumber, status, endDate }) {
  const products = productKeys.map((k) => ({ rfq_product_id: RP[k], vendor_targets: [] }));
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, rfq_product_id, round_number, status,
        end_date, products, vendor_ids, created_by)
     VALUES ($1, 'RFQ', $1, NULL, $2, $3, $4, $5::jsonb, ARRAY[$6]::int[], $7)
     RETURNING id`,
    [rfqId, roundNumber, status, endDate, JSON.stringify(products), VENDOR, BUYER]
  );
  R[key] = Number(row.id);
  return R[key];
}

async function addVendorResponse(roundKey, productKey, price = 900) {
  await db.none(
    `INSERT INTO tbl_negotiation_round_quotes
       (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at)
     VALUES ($1, $2, $3, $4, 1000, now())`,
    [R[roundKey], VENDOR, RP[productKey], price]
  );
}

/**
 * An APPROVED NEGOTIATION_QUOTE for (product, vendor) — the downstream event
 * that means "quotes from this round were selected and approved".
 */
async function approveQuoteDownstream(productKey) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        initiated_by, hospitality_company_id, hotel_id, department_id, metadata)
     VALUES ('NEGOTIATION_QUOTE', $1, $2, 'APPROVED', 1, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [
      RP[productKey],
      POLICY_ID,
      BUYER,
      HC_A,
      HOTEL_A,
      DEPT,
      JSON.stringify({ rfq_id: String(rfqId), rfq_product_id: RP[productKey], vendor_id: VENDOR }),
    ]
  );
  createdInstanceIds.push(Number(inst.id));
  return Number(inst.id);
}

/**
 * A PENDING NEGOTIATION approval instance in the LEGACY shape: entity_id is
 * the rfq_product_id, and the real round id lives in metadata.round_id. All 6
 * PENDING instances in production look exactly like this, which is why the
 * "Pending for me" count was permanently 0.
 */
async function addLegacyPendingApproval(roundKey, productKey, approverUserId) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        initiated_by, hospitality_company_id, hotel_id, department_id, metadata)
     VALUES ('NEGOTIATION', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [
      RP[productKey],
      POLICY_ID,
      BUYER,
      HC_A,
      HOTEL_A,
      DEPT,
      JSON.stringify({ rfq_id: String(rfqId), rfq_product_id: RP[productKey], round_id: R[roundKey] }),
    ]
  );
  const instanceId = Number(inst.id);
  createdInstanceIds.push(instanceId);

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ALL', 'PENDING') RETURNING id`,
    [instanceId]
  );
  createdStepIds.push(Number(step.id));

  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [Number(step.id), approverUserId]
  );
  return instanceId;
}

describe("Negotiation status taxonomy", () => {
  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);

    const scope = await db.one(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, NULL) RETURNING id`,
      [BUYER, ROLE_NEG_FULL, HC_A, HOTEL_A]
    );
    negScopeId = Number(scope.id);
    client = await httpClient(BUYER);

    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'NEGOTIATION', $2, $3, NULL, true, $4, NULL, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [POLICY_ID, HC_A, HOTEL_A, BUYER]
    );

    // Quotes must already be visible, otherwise the detail endpoint redacts.
    const { rfq_id } = await makeRFQ(db, {
      createdBy: BUYER,
      hospitality: HC_A,
      hotel: HOTEL_A,
      department: DEPT,
      bid_end_date: stamp(-3),
    });
    rfqId = Number(rfq_id);

    // ── One product per state, so each state is observable in isolation ─────
    await addProduct("awaiting", 1);
    await addProduct("open", 2);
    await addProduct("ready", 3);
    await addProduct("silent", 4);
    await addProduct("concluded", 5);
    await addProduct("lapsed", 1);
    await addProduct("cancelled", 2);

    // DRAFT / PENDING_APPROVAL → "Awaiting approval"
    await addRound("awaiting", { productKey: "awaiting", roundNumber: 1, status: "PENDING_APPROVAL", endDate: stamp(4) });

    // ACTIVE with the window still open → "Open with vendors"
    await addRound("open", { productKey: "open", roundNumber: 1, status: "ACTIVE", endDate: stamp(4) });

    // ENDED + responses + no approved quote → "Ready for your decision"
    await addRound("ready", { productKey: "ready", roundNumber: 1, status: "ENDED", endDate: stamp(-1) });
    await addVendorResponse("ready", "ready");

    // ENDED + zero responses → "Closed — no vendor response"
    await addRound("silent", { productKey: "silent", roundNumber: 1, status: "ENDED", endDate: stamp(-1) });

    // ENDED + responses + an APPROVED NEGOTIATION_QUOTE for the same vendor
    // → "Concluded"
    await addRound("concluded", { productKey: "concluded", roundNumber: 1, status: "ENDED", endDate: stamp(-2), closedAt: stamp(-2) });
    await addVendorResponse("concluded", "concluded");
    await approveQuoteDownstream("concluded");

    // EXPIRED → "Lapsed — never approved"
    await addRound("lapsed", { productKey: "lapsed", roundNumber: 1, status: "EXPIRED", endDate: stamp(-5) });

    // CANCELLED → "Cancelled"
    await addRound("cancelled", { productKey: "cancelled", roundNumber: 1, status: "CANCELLED", endDate: stamp(-5) });

    // ── Position fixture ────────────────────────────────────────────────────
    // Rounds 8, 9, 10 on the RFQ, but rounds 1, 2, 3 on their own product —
    // exactly the legacy shape. Their STORED numbers restart at 1, so the
    // seven rounds above and these three between them store `1` eight times.
    await addProduct("seq", 3);
    await addRound("seq1", { productKey: "seq", roundNumber: 1, status: "ENDED", endDate: stamp(-9) });
    await addRound("seq2", { productKey: "seq", roundNumber: 2, status: "ENDED", endDate: stamp(-8) });
    await addRound("seq3", { productKey: "seq", roundNumber: 3, status: "ENDED", endDate: stamp(-7) });

    // ── One round covering TWO products ─────────────────────────────────────
    // One round, one position — that is the whole point of the definition.
    await addProduct("multiA", 4);
    await addProduct("multiB", 5);
    await addMultiProductRound("multi", ["multiA", "multiB"], {
      roundNumber: 1,
      status: "ENDED",
      endDate: stamp(-6),
    });

    // Legacy-shaped PENDING approval waiting on this very buyer.
    await addLegacyPendingApproval("awaiting", "awaiting", BUYER);
  });

  afterAll(async () => {
    if (createdStepIds.length) {
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id = ANY($1::int[])`, [createdStepIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = ANY($1::int[])`, [createdStepIds]);
    }
    if (createdInstanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [createdInstanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    if (negScopeId) await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [negScopeId]);

    const roundIds = Object.values(R);
    if (roundIds.length) {
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [roundIds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
    }
    const productIds = Object.values(RP);
    if (productIds.length) {
      await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [productIds]);
    }
    if (rfqId) await db.none(`DELETE FROM tbl_rfq WHERE id = $1`, [rfqId]);
  });

  // ── helpers ──────────────────────────────────────────────────────────────
  // groupBy defaults to 'parent' (one row per RFQ/ARC). This suite is about
  // per-ROUND state derivation and position, so it pins the round grain.
  const listRows = async () => {
    const res = await client
      .post("/api/v1/negotiation/list-view")
      .send({ tab: "all", limit: 100, groupBy: "round" });
    expect(res.status).toBe(200);
    return res.body.data.rows;
  };

  const rowFor = (rows, roundKey) => rows.find((r) => Number(r.round_id) === R[roundKey]);

  const detailFor = async (roundKey) => {
    const res = await client.get(`/api/v1/negotiation/rounds/${R[roundKey]}/detail`);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  // ── 1. every state derives correctly ─────────────────────────────────────
  describe("state derivation on the listing", () => {
    it("labels each seeded round with its own state", async () => {
      const rows = await listRows();

      expect(rowFor(rows, "awaiting").neg_status).toBe("awaiting_approval");
      expect(rowFor(rows, "open").neg_status).toBe("open_with_vendors");
      expect(rowFor(rows, "ready").neg_status).toBe("ready_for_decision");
      expect(rowFor(rows, "silent").neg_status).toBe("no_vendor_response");
      expect(rowFor(rows, "concluded").neg_status).toBe("concluded");
      expect(rowFor(rows, "cancelled").neg_status).toBe("cancelled");
    });

    it("separates EXPIRED from CANCELLED — a lapsed round never reached a vendor", async () => {
      const rows = await listRows();

      // The single most consequential split: 171 production rounds were being
      // shown as if someone had deliberately cancelled them.
      expect(rowFor(rows, "lapsed").neg_status).toBe("lapsed");
      expect(rowFor(rows, "cancelled").neg_status).toBe("cancelled");
      expect(rowFor(rows, "lapsed").neg_status).not.toBe(rowFor(rows, "cancelled").neg_status);
    });

    it("splits ENDED three ways on responses and downstream approval", async () => {
      const rows = await listRows();

      // Same raw status on all three rows.
      expect(rowFor(rows, "ready").round_status).toBe("ENDED");
      expect(rowFor(rows, "silent").round_status).toBe("ENDED");
      expect(rowFor(rows, "concluded").round_status).toBe("ENDED");

      // Three different answers to "what do I do about this?"
      expect(rowFor(rows, "ready").neg_status).toBe("ready_for_decision");
      expect(rowFor(rows, "silent").neg_status).toBe("no_vendor_response");
      expect(rowFor(rows, "concluded").neg_status).toBe("concluded");
    });

    it("only marks a round concluded when the APPROVED quote is from a vendor that quoted in it", async () => {
      const rows = await listRows();
      // `ready` and `concluded` differ only in the downstream approval.
      expect(rowFor(rows, "ready").has_approved_quote).toBe(false);
      expect(rowFor(rows, "concluded").has_approved_quote).toBe(true);
    });
  });

  // ── 2. listing and detail agree ──────────────────────────────────────────
  describe("listing and detail agree", () => {
    it.each([
      ["awaiting", "awaiting_approval"],
      ["open", "open_with_vendors"],
      ["ready", "ready_for_decision"],
      ["silent", "no_vendor_response"],
      ["concluded", "concluded"],
      ["lapsed", "lapsed"],
      ["cancelled", "cancelled"],
    ])("%s renders the same state on both surfaces", async (key, expected) => {
      const rows = await listRows();
      const detail = await detailFor(key);

      expect(rowFor(rows, key).neg_status).toBe(expected);
      expect(detail.round.state).toBe(expected);
    });

    it("gives the detail payload a label and an explanation for the state", async () => {
      const detail = await detailFor("lapsed");
      expect(detail.round.state_label).toBe("Lapsed — never approved");
      expect(detail.round.state_description).toMatch(/never reached vendors/i);
    });
  });

  // ── 3. RFQ-wide round position ───────────────────────────────────────────
  //
  // Product definition: "round_number means the number of the current round in
  // the whole RFQ, not product-wise. If this RFQ had 3 rounds for 3 different
  // products, then a round for a brand-new product 4 should get round 4."
  //
  // The STORED column does not obey that — the legacy allocator restarted at 1
  // for every product, so this fixture stores `1` on eight different rounds.
  // The displayed number is therefore computed at read time.
  describe("round position", () => {
    it("numbers rounds across the whole RFQ, not per product", async () => {
      const rows = await listRows();
      const ours = rows.filter((r) => Number(r.rfq_id) === rfqId);

      // Every round of this RFQ, in creation order, numbered 1..N with no gaps
      // and no repeats — even though most of them are STORED as 1.
      const byPosition = [...ours].sort((a, b) => Number(a.round_number) - Number(b.round_number));
      expect(byPosition.map((r) => Number(r.round_number))).toEqual(
        byPosition.map((_, i) => i + 1)
      );
      expect(new Set(ours.map((r) => Number(r.round_number))).size).toBe(ours.length);

      // The eight single-product rounds really are all stored as 1.
      expect(ours.filter((r) => Number(r.stored_round_number) === 1).length).toBeGreaterThan(1);
    });

    it("gives a brand-new product the next RFQ-wide position, not 1", async () => {
      const rows = await listRows();
      // `cancelled` is the seventh round created on this RFQ and the FIRST on
      // its product. Per-product numbering calls it round 1; the definition
      // calls it round 7.
      expect(Number(rowFor(rows, "cancelled").stored_round_number)).toBe(1);
      expect(Number(rowFor(rows, "cancelled").round_number)).toBe(7);
    });

    it("counts every round on the RFQ as the denominator", async () => {
      const rows = await listRows();
      const ours = rows.filter((r) => Number(r.rfq_id) === rfqId);
      for (const r of ours) {
        expect(Number(r.total_rounds)).toBe(ours.length);
        expect(Number(r.rounds_on_parent)).toBe(ours.length);
      }
    });

    it("never renders a numerator larger than its denominator", async () => {
      const rows = await listRows();
      for (const r of rows) {
        expect(Number(r.round_number)).toBeGreaterThanOrEqual(1);
        expect(Number(r.round_number)).toBeLessThanOrEqual(Number(r.total_rounds));
      }
    });

    it("gives a multi-product round ONE position, not one per product", async () => {
      const rows = await listRows();
      const multiRows = rows.filter((r) => Number(r.round_id) === R.multi);
      expect(multiRows).toHaveLength(1);

      const multi = multiRows[0];
      // It is the eleventh round created on this RFQ and covers two products.
      expect(Number(multi.round_number)).toBe(11);
      // Nothing else on the RFQ shares that position.
      expect(rows.filter((r) => Number(r.rfq_id) === rfqId && Number(r.round_number) === 11)).toHaveLength(1);

      const detail = await detailFor("multi");
      expect(Number(detail.round.round_number)).toBe(11);
      expect(detail.round.mode).toBe("MULTI_ITEM");
    });

    it("still reports how many rounds touched the same items, as context", async () => {
      const rows = await listRows();
      // Three rounds on the `seq` product, out of ten on the RFQ.
      expect(Number(rowFor(rows, "seq2").rounds_on_products)).toBe(3);
      expect(Number(rowFor(rows, "seq2").rounds_on_parent)).toBeGreaterThan(3);
    });

    it("agrees with the detail payload on both numbers", async () => {
      const rows = await listRows();
      for (const key of ["seq1", "seq2", "seq3", "cancelled", "lapsed"]) {
        const detail = await detailFor(key);
        expect(Number(detail.round.round_number)).toBe(Number(rowFor(rows, key).round_number));
        expect(Number(detail.round.rounds_on_parent)).toBe(Number(rowFor(rows, key).total_rounds));
      }
    });
  });

  // ── 4. "Pending for me" actually fires ───────────────────────────────────
  describe("pending-for-me over legacy approval instances", () => {
    it("finds a PENDING instance whose entity_id is an rfq_product_id", async () => {
      const rows = await listRows();
      const row = rowFor(rows, "awaiting");
      // The instance stores entity_id = rfq_product_id and the round id in
      // metadata.round_id. Matching entity_id against round ids found nothing,
      // which is why the count sat at 0 in production.
      expect(row.action_required).toBe(true);
      expect(row.action_label).toBe("Approval needed");
    });

    it("counts it in tab_counts.for_me", async () => {
      const res = await client
        .post("/api/v1/negotiation/list-view")
        .send({ tab: "all", limit: 100, groupBy: "round" });
      expect(res.body.data.tab_counts.for_me).toBeGreaterThanOrEqual(1);
    });

    it("surfaces the same instance on the detail page's approval card", async () => {
      const detail = await detailFor("awaiting");
      expect(detail.approval.status).toBe("PENDING");
      expect(detail.approval.is_pending_for_me).toBe(true);
      // pending_with is a list of PEOPLE, not a string.
      expect(Array.isArray(detail.approval.pending_with)).toBe(true);
      expect(detail.approval.pending_with.length).toBeGreaterThan(0);
      expect(detail.approval.pending_with[0]).toHaveProperty("name");
    });
  });

  // ── 5. next-round gating ─────────────────────────────────────────────────
  describe("can_create_next_round", () => {
    it("is open on a lapsed round — a new round is the recovery from one", async () => {
      const detail = await detailFor("lapsed");
      expect(detail.actions.can_create_next_round).toBe(true);
    });

    it("is open on a cancelled round", async () => {
      const detail = await detailFor("cancelled");
      expect(detail.actions.can_create_next_round).toBe(true);
    });

    it("is open on an ended round awaiting a decision", async () => {
      const detail = await detailFor("ready");
      expect(detail.actions.can_create_next_round).toBe(true);
    });

    it("is closed while the round is still with vendors", async () => {
      const detail = await detailFor("open");
      expect(detail.actions.can_create_next_round).toBe(false);
    });

    it("is closed while the round is still awaiting internal approval", async () => {
      const detail = await detailFor("awaiting");
      expect(detail.actions.can_create_next_round).toBe(false);
      // can_approve is true here BECAUSE the caller is this instance's pending
      // approver, not merely because they hold negotiation.approve — the gate
      // is now viewer-relative. Anchored on is_pending_for_me so this passes
      // for the right reason.
      expect(detail.approval.is_pending_for_me).toBe(true);
      expect(detail.actions.can_approve).toBe(true);
    });
  });

  // ── 6. round history ─────────────────────────────────────────────────────
  describe("round history", () => {
    it("lists every round on the same product, each scoped to itself", async () => {
      const detail = await detailFor("seq2");
      // Rounds 8, 9 and 10 OF THE RFQ — the history numbers a row exactly as
      // the page you land on will number it, so following the link never shows
      // a different number than the row you clicked.
      expect(detail.history.map((h) => h.round_number)).toEqual([8, 9, 10]);
      // …while their stored values restart at 1 for this product.
      expect(detail.history.map((h) => h.stored_round_number)).toEqual([1, 2, 3]);
      expect(detail.history.find((h) => h.round_id === R.seq2).is_current).toBe(true);
      expect(detail.history.every((h) => h.state_label)).toBe(true);
    });

    it("does not leak rounds from other products into the history", async () => {
      const detail = await detailFor("ready");
      expect(detail.history).toHaveLength(1);
      expect(Number(detail.history[0].round_id)).toBe(R.ready);
    });
  });
});
