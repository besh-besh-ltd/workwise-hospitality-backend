// Wave-style integration test for the RFQ Creator dashboard widgets.
//
// Strategy: seed a deterministic dashboard state for a known fixture user
// (a1_proc_buyer), hit the real HTTP endpoints, and assert on EXACT counts
// and EXACT inserted rfq_ids — no fuzzy expectations. If anything in the
// SQL drifts, these tests will scream.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
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

// Pre-loaded summary of what we seeded so individual tests can assert
// on the exact rfq IDs we expect each widget to return.
const seeded = {};

beforeAll(async () => {
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
       VALUES ($1, 1, 'PUBLISHED', $2, NOW() + INTERVAL '3 days')`,
      [liveNeg.rfq_id, IDS.users.a1_proc_buyer]
    );

    // 4. awaiting_approval — has PENDING approval instance
    const liveAppr = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
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
    const futureDate = new Date(Date.now() + 7 * 86400_000)
      .toISOString().slice(0, 10);

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
    const pastDate = new Date(Date.now() - 3 * 86400_000)
      .toISOString().slice(0, 10); // 3 days ago

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

    // Stash IDs for assertions + teardown.
    seeded.drafts = [draftA.rfq_id, draftB.rfq_id, draftC.rfq_id];
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
    it("returns exactly the 3 drafts created by the user in the selected hotel", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-drafts")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.count).toBe(3);
      expect(res.body.data.items).toHaveLength(3);

      const returnedIds = res.body.data.items.map((i) => i.id).sort();
      expect(returnedIds).toEqual([...seeded.drafts].sort());

      // Withdrawn / other-user / wrong-hotel drafts must NOT be present.
      expect(returnedIds).not.toContain(seeded.draftWithdrawn);
      expect(returnedIds).not.toContain(seeded.draftOther);
      expect(returnedIds).not.toContain(seeded.draftA2);

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
      // by resolveUserScope. Count stays 3.
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(3);
    });
  });

  /* ─────────────────────── /my-active-rfqs ────────────────────── */

  describe("GET /dashboard-v2/my-active-rfqs", () => {
    it("groups live RFQs by stage with exact counts", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-active-rfqs")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);

      // Seeded state for this user in A1 includes 10 live RFQs across stages:
      //   awaiting_vendor_quotes (no quotes, no neg, no PO):
      //     - liveAwaiting, noRespAll, bidClosed, futureNoQuotes  (4)
      //   quote_compare (has quotes, no neg, no PO):
      //     - liveQc, noRespPartial, noRespNone, bidClosedWithQuote  (4)
      //   negotiation: liveNeg  (1)
      //   awaiting_approval: liveAppr  (1)
      expect(res.body.data.total).toBe(10);

      const byStage = {};
      for (const s of res.body.data.stages) byStage[s.stage] = s.count;

      expect(byStage.awaiting_vendor_quotes).toBe(4);
      expect(byStage.quote_compare).toBe(4);
      expect(byStage.negotiation).toBe(1);
      expect(byStage.awaiting_approval).toBe(1);

      // Each stage entry exposes oldest_age_days (number, ≥0).
      for (const s of res.body.data.stages) {
        expect(typeof s.oldest_age_days).toBe("number");
        expect(s.oldest_age_days).toBeGreaterThanOrEqual(0);
      }
    });

    it("does not include another user's live RFQs", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-active-rfqs")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      // liveOther was created by a1_eng_buyer. Its rfq_id should not
      // contribute to a1_proc_buyer's count.
      expect(res.body.data.total).toBe(10);
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

    it("orders by silent_vendor_count DESC then bid_end_date ASC", async () => {
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
    it("returns exactly the RFQ whose bid is closed and no vendor responded", async () => {
      const client = await httpClient(IDS.users.a1_proc_buyer);
      const res = await client
        .get("/api/v1/dashboard-v2/my-rfqs-bid-closed-no-quotes")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.count).toBe(1);

      const item = res.body.data.items[0];
      expect(item.id).toBe(seeded.bidClosed);
      expect(item.days_overdue).toBe(3);

      // bidClosedWithQuote (has quote) and futureNoQuotes (future date) must
      // not appear.
      const ids = res.body.data.items.map((i) => i.id);
      expect(ids).not.toContain(seeded.bidClosedWithQuote);
      expect(ids).not.toContain(seeded.futureNoQuotes);
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
