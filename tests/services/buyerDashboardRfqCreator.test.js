// Wave-style integration test for the RFQ Creator dashboard widgets.
//
// Strategy: seed a deterministic dashboard state for a known fixture user
// (a1_proc_buyer), hit the real HTTP endpoints, and assert on EXACT counts
// and EXACT inserted rfq_ids — no fuzzy expectations. If anything in the
// SQL drifts, these tests will scream.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  inviteVendors,
  insertVendorQuote,
} from "../helpers/dashboardSeed.js";

// IDs we insert during this suite — drop them in afterAll so subsequent
// suites see the original fixture state.
const inserted = { rfqIds: [] };

// `tbl_rfq.bid_end_date` is `text` holding a naive IST wall-clock string (see
// app/helper/quoteVisibility.js), and dashboardModel resolves the bid-window
// boundary against IST "today". Seeds must therefore be built from the IST
// calendar, not from `new Date().toISOString()` — a UTC-derived date lands one
// day short between 18:30 and 24:00 UTC (00:00–05:30 IST), which flipped the
// `days_overdue` assertion below from 3 to 4 for 5.5 hours every night.
const istDate = (offsetDays) =>
  moment.tz("Asia/Kolkata").add(offsetDays, "days").format("YYYY-MM-DD");

// Pre-loaded summary of what we seeded so individual tests can assert
// on the exact rfq IDs we expect each widget to return.
const seeded = {};

beforeAll(async () => {
  // Sanity cleanup: any earlier suite in the same Jest worker that left
  // behind RFQs for a1_proc_buyer in hospitality A would poison the exact-
  // count assertions below (e.g. expect(count).toBe(3)). Wipe anything
  // matching the test's signature before seeding. Scoped narrowly so we
  // never touch reference fixtures.
  await db.none(
    `DELETE FROM tbl_rfq_hotel_mappings
     WHERE rfq_id IN (
       SELECT id FROM tbl_rfq
       WHERE created_by IN ($1, $2)
         AND hospitality_company_id = $3
     )`,
    [IDS.users.a1_proc_buyer, IDS.users.a1_eng_buyer, IDS.hospitality.A]
  );
  await db.none(
    `DELETE FROM tbl_rfq_product_vendors
     WHERE rfq_id IN (
       SELECT id FROM tbl_rfq
       WHERE created_by IN ($1, $2)
         AND hospitality_company_id = $3
     )`,
    [IDS.users.a1_proc_buyer, IDS.users.a1_eng_buyer, IDS.hospitality.A]
  );
  await db.none(
    `DELETE FROM tbl_rfq_products
     WHERE rfq_id IN (
       SELECT id FROM tbl_rfq
       WHERE created_by IN ($1, $2)
         AND hospitality_company_id = $3
     )`,
    [IDS.users.a1_proc_buyer, IDS.users.a1_eng_buyer, IDS.hospitality.A]
  );
  await db.none(
    `UPDATE tbl_rfq SET copied_from_rfq_id = NULL
     WHERE copied_from_rfq_id IN (
       SELECT id FROM tbl_rfq
       WHERE created_by IN ($1, $2)
         AND hospitality_company_id = $3
     )`,
    [IDS.users.a1_proc_buyer, IDS.users.a1_eng_buyer, IDS.hospitality.A]
  );
  await db.none(
    `DELETE FROM tbl_rfq
     WHERE created_by IN ($1, $2)
       AND hospitality_company_id = $3`,
    [IDS.users.a1_proc_buyer, IDS.users.a1_eng_buyer, IDS.hospitality.A]
  );

  await db.tx(async (t) => {
    // ── My Drafts: 3 drafts for a1_proc_buyer in Hotel A1 ─────────────
    const draftA = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 0,
      is_published: 0,
      title: "Draft RFQ Alpha",
    });
    const draftB = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 0,
      is_published: 0,
      title: "Draft RFQ Bravo",
    });
    const draftC = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 0,
      is_published: 0,
      title: "Draft RFQ Charlie",
    });

    // Prod-shaped draft: a saved RFQ is the (status 1, is_published 0) pair
    // (rfqModel.saveMagicSearchInDraft). status 0 above is legacy-only.
    const draftD = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 0,
      title: "Draft RFQ Delta",
    });

    // More drafts than the widget lists (20): the count must stay true.
    const engDrafts = [];
    for (let n = 0; n < 24; n++) {
      const d = await makeRfqVisibleToDashboard(t, {
        createdBy: IDS.users.a1_eng_buyer,
        hospitality: IDS.hospitality.A,
        hotel: IDS.hotels.A1,
        status: 1,
        is_published: 0,
        title: `Eng Draft ${n}`,
      });
      engDrafts.push(d.rfq_id);
    }

    // Withdrawn RFQ — should NOT count as a draft (status=5).
    const withdrawn = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 5,
      is_published: 0,
      title: "Withdrawn RFQ",
    });

    // Draft by ANOTHER user (a1_eng_buyer) — must NOT appear for a1_proc_buyer.
    const otherDraft = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_eng_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 0,
      is_published: 0,
      title: "Eng Buyer Draft",
    });

    // Draft for the same user but in Hotel A2 — must NOT appear when
    // filtering to Hotel A1.
    const draftA2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A2,
      status: 0,
      is_published: 0,
      title: "Draft in A2",
    });

    // ── My Active RFQs: 4 live in A1 ──────────────────────────────────
    // 1. awaiting_vendor_quotes — published, no quotes
    const liveAwaiting = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "Awaiting Quotes",
    });
    // 2. quote_compare — has a quote, no negotiation
    const liveQc = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "Quote Compare",
    });
    await insertVendorQuote(t, {
      rfq_id: liveQc.rfq_id,
      vendor_user_id: IDS.users.vendor_alpha,
    });

    // 3. negotiation — has active negotiation round
    const liveNeg = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "In Negotiation",
    });
    await t.none(
      `INSERT INTO tbl_negotiation_rounds (rfq_id, round_number, status, created_by, end_date)
       VALUES ($1, 1, 'ACTIVE', $2, (now() AT TIME ZONE 'UTC') + INTERVAL '3 days')`,
      [liveNeg.rfq_id, IDS.users.a1_proc_buyer]
    );

    // 4. awaiting publish approval — prod shape: startApprovalForRFQ parks
    //    the RFQ at status 4 (unpublished) with a PENDING RFQ approval. It is
    //    NOT a draft.
    const liveAppr = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 4,
      is_published: 0,
      title: "Awaiting Approval",
    });
    await t.none(
      `INSERT INTO tbl_approval_instances
        (entity_type, entity_id, approval_policy_id, status, current_step,
         initiated_by, hospitality_company_id, hotel_id)
       VALUES ('RFQ', $1, $2, 'PENDING', 1, $3, $4, $5)`,
      [
        liveAppr.rfq_id,
        IDS.policies.A1_P1_RFQ,
        IDS.users.a1_proc_buyer,
        IDS.hospitality.A,
        IDS.hotels.A1,
      ]
    );

    // Live RFQ by another user — must NOT count
    const liveOther = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_eng_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "Other User Live",
    });

    // ── No-response RFQs: 2 silent-vendor RFQs (both with future bid_end_date) ─
    const futureDate = istDate(7);

    const noRespAll = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "No Response - All Silent",
      bid_end_date: futureDate,
    });
    await inviteVendors(t, {
      rfq_id: noRespAll.rfq_id,
      vendor_ids: [IDS.users.vendor_alpha, IDS.users.vendor_beta],
    });

    // RFQ with 3 invited vendors, 1 response, 2 silent
    const noRespPartial = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "No Response - Partial",
      bid_end_date: futureDate,
    });
    await inviteVendors(t, {
      rfq_id: noRespPartial.rfq_id,
      vendor_ids: [
        IDS.users.vendor_alpha,
        IDS.users.vendor_beta,
        IDS.users.vendor_gamma,
      ],
    });
    await insertVendorQuote(t, {
      rfq_id: noRespPartial.rfq_id,
      vendor_user_id: IDS.users.vendor_alpha,
    });

    // RFQ with all vendors responded — must NOT appear in the no-response widget
    const noRespNone = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "No Response - All Replied",
      bid_end_date: futureDate,
    });
    await inviteVendors(t, {
      rfq_id: noRespNone.rfq_id,
      vendor_ids: [IDS.users.vendor_alpha, IDS.users.vendor_beta],
    });
    await insertVendorQuote(t, {
      rfq_id: noRespNone.rfq_id,
      vendor_user_id: IDS.users.vendor_alpha,
    });
    await insertVendorQuote(t, {
      rfq_id: noRespNone.rfq_id,
      vendor_user_id: IDS.users.vendor_beta,
    });

    // ── Bid-closed + no quotes: urgent attention widget ────────────────
    const pastDate = istDate(-3); // 3 IST days ago

    // No quotes, bid_end_date passed → SHOULD appear in urgent attention.
    const bidClosed = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Bid closed — no quotes",
      bid_end_date: pastDate,
    });

    // Has quotes + bid closed → should NOT appear (quotes came in).
    const bidClosedWithQuote = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Bid closed — has quote",
      bid_end_date: pastDate,
    });
    await insertVendorQuote(t, {
      rfq_id: bidClosedWithQuote.rfq_id,
      vendor_user_id: IDS.users.vendor_alpha,
    });

    // No quotes + bid still in future → should NOT appear in urgent attention
    // (still in "vendors yet to quote" widget).
    const futureNoQuotes = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Future bid, no quotes",
      bid_end_date: futureDate,
    });

    // Only a regret came in → nobody offered a price → SHOULD appear.
    const bidClosedRegret = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Bid closed — regret only",
      bid_end_date: istDate(-2),
    });
    const regretQuote = await insertVendorQuote(t, {
      rfq_id: bidClosedRegret.rfq_id,
      vendor_user_id: IDS.users.vendor_beta,
    });
    await t.none(`UPDATE tbl_quotes SET is_regret = 1 WHERE id = $1`, [regretQuote]);

    // Closed (status 2) with no quotes — already dealt with → must NOT appear
    // anywhere in the creator widgets.
    const closedNoQuote = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 2, is_published: 1,
      title: "Closed — no quotes",
      bid_end_date: pastDate,
    });

    // Open bid, the only invited vendor REGRETTED — a regret is a response,
    // so this RFQ has no silent vendor.
    const noRespRegret = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "No Response - Regretted",
      bid_end_date: futureDate,
    });
    await inviteVendors(t, { rfq_id: noRespRegret.rfq_id, vendor_ids: [IDS.users.vendor_gamma] });
    const regretQuote2 = await insertVendorQuote(t, {
      rfq_id: noRespRegret.rfq_id,
      vendor_user_id: IDS.users.vendor_gamma,
    });
    await t.none(`UPDATE tbl_quotes SET is_regret = 1 WHERE id = $1`, [regretQuote2]);

    // Stash IDs for assertions + teardown.
    seeded.drafts = [draftA.rfq_id, draftB.rfq_id, draftC.rfq_id, draftD.rfq_id];
    seeded.engDrafts = engDrafts;
    seeded.bidClosedRegret = bidClosedRegret.rfq_id;
    seeded.closedNoQuote = closedNoQuote.rfq_id;
    seeded.noRespRegret = noRespRegret.rfq_id;
    seeded.bidClosed = bidClosed.rfq_id;
    seeded.bidClosedWithQuote = bidClosedWithQuote.rfq_id;
    seeded.futureNoQuotes = futureNoQuotes.rfq_id;
    seeded.draftWithdrawn = withdrawn.rfq_id;
    seeded.draftOther = otherDraft.rfq_id;
    seeded.draftA2 = draftA2.rfq_id;
    seeded.activeAwaiting = liveAwaiting.rfq_id;
    seeded.activeQc = liveQc.rfq_id;
    seeded.activeNeg = liveNeg.rfq_id;
    seeded.activeAppr = liveAppr.rfq_id;
    seeded.activeOther = liveOther.rfq_id;
    seeded.noRespAll = noRespAll.rfq_id;
    seeded.noRespPartial = noRespPartial.rfq_id;
    seeded.noRespNone = noRespNone.rfq_id;

    inserted.rfqIds = [
      ...seeded.drafts,
      seeded.draftWithdrawn,
      seeded.draftOther,
      seeded.draftA2,
      seeded.activeAwaiting,
      seeded.activeQc,
      seeded.activeNeg,
      seeded.activeAppr,
      seeded.activeOther,
      seeded.noRespAll,
      seeded.noRespPartial,
      seeded.noRespNone,
      seeded.bidClosed,
      seeded.bidClosedWithQuote,
      seeded.futureNoQuotes,
      seeded.bidClosedRegret,
      seeded.closedNoQuote,
      seeded.noRespRegret,
      ...seeded.engDrafts,
    ];
  });
});

afterAll(async () => {
  // Clean up everything we inserted before closing the connection.
  if (seeded.activeNeg) {
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [seeded.activeNeg]);
  }
  if (seeded.activeAppr) {
    await db.none(
      `DELETE FROM tbl_approval_instances WHERE entity_id = $1 AND entity_type = 'RFQ'`,
      [seeded.activeAppr]
    );
  }
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

describe("Buyer Dashboard — RFQ Creator widgets (real data)", () => {
  /* ─────────────────────── /my-drafts ─────────────────────── */

  describe("GET /dashboard-v2/my-drafts", () => {
    it("returns exactly the 4 drafts created by the user in the selected hotel", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-drafts")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.count).toBe(4);
      expect(res.body.data.items).toHaveLength(4);

      const returnedIds = res.body.data.items.map((i) => i.id).sort();
      expect(returnedIds).toEqual([...seeded.drafts].sort());

      // Withdrawn / other-user / wrong-hotel drafts must NOT be present.
      expect(returnedIds).not.toContain(seeded.draftWithdrawn);
      expect(returnedIds).not.toContain(seeded.draftOther);
      expect(returnedIds).not.toContain(seeded.draftA2);
      // Awaiting publish approval (status 4) is somebody's to-do, not a draft.
      expect(returnedIds).not.toContain(seeded.activeAppr);
      expect(res.body.data.oldest_created_at).toBeTruthy();

      // Each item carries title + product_count fields (FE depends on them).
      for (const item of res.body.data.items) {
        expect(item).toHaveProperty("title");
        expect(item).toHaveProperty("product_count");
        expect(typeof item.product_count).toBe("number");
      }
    });

    it("widens to both hotels when both are selected", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-drafts")
        .query({ hotel_ids: `${IDS.hotels.A1},${IDS.hotels.A2}` });

      // a1_proc_buyer's user scope only covers A1, so A2 is filtered out
      // by resolveUserScope. Count stays 4.
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(4);
    });

    it("reports the TRUE count when there are more drafts than the list shows", async () => {
      const client = await httpClient(IDS.users.a1_eng_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-drafts")
        .query({ hotel_ids: String(IDS.hotels.A1) });
      expect(res.status).toBe(200);
      // 24 seeded + the "Eng Buyer Draft" = 25; the list is capped at 20.
      expect(res.body.data.count).toBe(25);
      expect(res.body.data.items).toHaveLength(20);
    });
  });

  /* ─────────────────────── /my-active-rfqs ────────────────────── */

  describe("GET /dashboard-v2/my-active-rfqs", () => {
    it("stages my active RFQs with the SAME lifecycle keys as the RFQ listing", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-active-rfqs")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);

      // rfqModel.computeLifecycleStages, for this user's non-draft,
      // non-closed RFQs in A1:
      //   AWAITING_QUOTES        bid open: liveAwaiting, liveQc (its quote is
      //                          still sealed), noRespAll, noRespPartial,
      //                          noRespNone, futureNoQuotes, noRespRegret  (7)
      //   NEGOTIATION_ONGOING    liveNeg (ACTIVE round, window open)       (1)
      //   RFQ_APPROVAL           liveAppr (status 4, publish approval)     (1)
      //   RFQ_STUCK_COMMERCIAL   bidClosed, bidClosedRegret (no real quote)(2)
      //   COMMERCIAL_EVALUATION  bidClosedWithQuote                        (1)
      // closedNoQuote (status 2) and every draft are not active.
      const byStage = {};
      for (const st of res.body.data.stages) byStage[st.stage] = st;

      expect(byStage.AWAITING_QUOTES.count).toBe(7);
      expect(byStage.NEGOTIATION_ONGOING.count).toBe(1);
      expect(byStage.RFQ_APPROVAL.count).toBe(1);
      expect(byStage.RFQ_STUCK_COMMERCIAL.count).toBe(2);
      expect(byStage.COMMERCIAL_EVALUATION.count).toBe(1);
      expect(res.body.data.total).toBe(12);
      expect(byStage.NEGOTIATION_ONGOING.label).toBe("Negotiation");

      for (const st of res.body.data.stages) {
        expect(typeof st.oldest_age_days).toBe("number");
        expect(st.oldest_age_days).toBeGreaterThanOrEqual(0);
      }
    });

    it("does not include another user's live RFQs", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-active-rfqs")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      // liveOther was created by a1_eng_buyer. Its rfq_id should not
      // contribute to a1_proc_buyer's count.
      expect(res.body.data.total).toBe(12);
    });

    it("an ENDED negotiation round does not keep an RFQ 'in negotiation'", async () => {
      await db.none(`UPDATE tbl_negotiation_rounds SET status = 'ENDED' WHERE rfq_id = $1`, [seeded.activeNeg]);
      try {
        const client = await httpClient(IDS.users.a1_proc_buyer);
        const res = await client
          .get("/api/v1/dashboard-v2/my-active-rfqs")
          .query({ hotel_ids: String(IDS.hotels.A1) });
        const stages = res.body.data.stages.map((st) => st.stage);
        expect(stages).not.toContain("NEGOTIATION_ONGOING");
        expect(res.body.data.total).toBe(12);
      } finally {
        await db.none(`UPDATE tbl_negotiation_rounds SET status = 'ACTIVE' WHERE rfq_id = $1`, [seeded.activeNeg]);
      }
    });
  });

  /* ─────────────────────── /my-no-response-rfqs ───────────────── */

  describe("GET /dashboard-v2/my-no-response-rfqs", () => {
    it("returns RFQs with silent vendors and exact silent-vendor counts", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-no-response-rfqs")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.count).toBe(2); // noRespAll + noRespPartial
      expect(res.body.data.silent_vendor_count).toBe(4); // 2 + 2

      const byId = {};
      for (const item of res.body.data.items) byId[item.id] = item;

      expect(byId[seeded.noRespAll]).toBeDefined();
      expect(byId[seeded.noRespAll].silent_vendor_count).toBe(2);
      expect(byId[seeded.noRespAll].total_vendor_count).toBe(2);

      expect(byId[seeded.noRespPartial]).toBeDefined();
      expect(byId[seeded.noRespPartial].silent_vendor_count).toBe(2);
      expect(byId[seeded.noRespPartial].total_vendor_count).toBe(3);

      // noRespNone has 0 silent — must not appear.
      expect(byId[seeded.noRespNone]).toBeUndefined();

      // Bid-closed RFQs must NOT surface here — they belong in the
      // urgent-attention widget.
      expect(byId[seeded.bidClosed]).toBeUndefined();
      expect(byId[seeded.bidClosedWithQuote]).toBeUndefined();
    });

    it("a vendor that regretted has responded — the RFQ is not listed", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-no-response-rfqs")
        .query({ hotel_ids: String(IDS.hotels.A1) });
      const ids = res.body.data.items.map((i) => i.id);
      expect(ids).not.toContain(seeded.noRespRegret);
    });

    it("orders by silent_vendor_count DESC when bid dates tie", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-no-response-rfqs")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      // Both seeded entries have silent_vendor_count = 2. Both bid_end_dates
      // are 7 days from now (default in makeRFQ) so order is stable but we
      // don't assert exact ordering here — just that the structure is valid.
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(2);
      const counts = res.body.data.items.map((i) => i.silent_vendor_count);
      // Descending — each subsequent item has count <= previous.
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
      }
    });
  });

  /* ───────── /my-rfqs-bid-closed-no-quotes ───────── */

  describe("GET /dashboard-v2/my-rfqs-bid-closed-no-quotes", () => {
    it("returns the open RFQs whose bid closed without a single real quote", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-rfqs-bid-closed-no-quotes")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      // bidClosed (nothing came in) + bidClosedRegret (only a regret).
      expect(res.body.data.count).toBe(2);

      const [first, second] = res.body.data.items;
      expect(first.id).toBe(seeded.bidClosed); // oldest deadline first
      expect(first.days_overdue).toBe(3);
      expect(second.id).toBe(seeded.bidClosedRegret);
      expect(second.regret_count).toBe(1);

      // bidClosedWithQuote (has quote) and futureNoQuotes (future date) must
      // not appear.
      const ids = res.body.data.items.map((i) => i.id);
      expect(ids).not.toContain(seeded.bidClosedWithQuote);
      expect(ids).not.toContain(seeded.futureNoQuotes);
      // A closed RFQ (status 2) was already dealt with.
      expect(ids).not.toContain(seeded.closedNoQuote);
    });
  });

  /* ─────────────────── Cross-cutting: scope isolation ─────────── */

  describe("Scope isolation", () => {
    it("Hotel B user sees zero RFQ Creator widgets for our seeded data", async () => {
      const client = await httpClient(IDS.users.companyB_admin);

      const [drafts, active, noResp] = await Promise.all([
        client.get("/api/v1/dashboard-v2/my-drafts").query({ hotel_ids: String(IDS.hotels.B1) }),
        client.get("/api/v1/dashboard-v2/my-active-rfqs").query({ hotel_ids: String(IDS.hotels.B1) }),
        client.get("/api/v1/dashboard-v2/my-no-response-rfqs").query({ hotel_ids: String(IDS.hotels.B1) }),
      ]);

      expect(drafts.status).toBe(200);
      expect(drafts.body.data.count).toBe(0);

      expect(active.status).toBe(200);
      expect(active.body.data.total).toBe(0);

      expect(noResp.status).toBe(200);
      expect(noResp.body.data.count).toBe(0);
    });
  });
});
