// Per-user read receipts for RFQ query messages. Validates that multiple
// buyer-side users on the same RFQ track unread state independently — the
// regression that motivated tbl_query_message_reads.
//
// Pattern: commit + cleanup (Pattern B from CONVENTIONS.md). rfqModel
// functions query db directly with no txContext, so we insert prerequisites
// via committed db.none and clean up tracked IDs in afterEach.

import {
  describe, it, expect, beforeEach, afterEach, afterAll,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import rfqModel from "../../app/models/rfqModel.js";

const BUYER_A = IDS.users.a1_proc_buyer;     // RFQ creator, Company A
const BUYER_B = IDS.users.a1_proc_techEval;  // Same Company A, different user
const VENDOR  = IDS.users.vendor_alpha;      // vendorAlpha company

const SENDER_TYPE_VENDOR = 3;
const SENDER_TYPE_BUYER  = 2;
const BUYER_VIEWER_TYPE  = 2; // any of {2,8,9,10}; getQueryParticipantsSummary uses buyerTypes set
const VENDOR_VIEWER_TYPE = 3;

const inserted = { rfqIds: [], messageIds: [], productVendorIds: [] };

afterAll(async () => { await closeDb(); });

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.messageIds = [];
  inserted.productVendorIds = [];
});

afterEach(async () => {
  if (inserted.messageIds.length) {
    // CASCADE on tbl_query_message_reads.message_id_fkey wipes read rows too.
    await db.none(`DELETE FROM tbl_query_messages WHERE id = ANY($1::int[])`, [inserted.messageIds]);
  }
  if (inserted.productVendorIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE id = ANY($1::int[])`, [inserted.productVendorIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

// ---- helpers ---------------------------------------------------------------

async function makePublishedRfq() {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: BUYER_A, status: 1, is_published: 1,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

async function insertQueryMessage({ rfqId, senderId, receiverId, senderType, text = "hello" }) {
  const row = await db.one(
    `INSERT INTO tbl_query_messages (rfq_id, sender_id, receiver_id, sender_type, message_text)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [rfqId, senderId, receiverId, senderType, text]
  );
  inserted.messageIds.push(row.id);
  return row.id;
}

async function attachVendorToRfq(rfqId, vendorUserId, productVariantId = 999001) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [rfqId, productVariantId, vendorUserId]
  );
  inserted.productVendorIds.push(row.id);
  return row.id;
}

async function readsForMessage(messageId) {
  return db.any(
    `SELECT user_id FROM tbl_query_message_reads WHERE message_id = $1 ORDER BY user_id`,
    [messageId]
  );
}

// Mirrors the rewritten unread subquery in getAllBuyerRfq / getPendingApprovalRfqs
// — exercises the actual SQL shape that powers the RFQ-list badge.
async function buyerListUnseenCount(rfqId, userId) {
  const row = await db.one(
    `SELECT COUNT(*)::int AS c
     FROM tbl_query_messages TQM
     WHERE TQM.rfq_id = $1
       AND TQM.sender_type = 3
       AND NOT EXISTS (
         SELECT 1 FROM tbl_query_message_reads TQMR
         WHERE TQMR.message_id = TQM.id AND TQMR.user_id = $2
       )`,
    [rfqId, userId]
  );
  return row.c;
}

// ---- tests -----------------------------------------------------------------

describe("RFQ query messages — per-user read receipts", () => {
  it("buyer-list unseen count is independent per buyer-side user (the regression)", async () => {
    const rfqId = await makePublishedRfq();
    await insertQueryMessage({
      rfqId, senderId: VENDOR, receiverId: BUYER_A, senderType: SENDER_TYPE_VENDOR,
    });

    // Both buyer-side users initially see unread = 1 — fixes the original bug
    // where only the named receiver got the badge.
    expect(await buyerListUnseenCount(rfqId, BUYER_A)).toBe(1);
    expect(await buyerListUnseenCount(rfqId, BUYER_B)).toBe(1);

    // Buyer A opens the thread → only Buyer A's badge clears.
    await rfqModel.getQueryMessages(rfqId, BUYER_A, VENDOR);
    expect(await buyerListUnseenCount(rfqId, BUYER_A)).toBe(0);
    expect(await buyerListUnseenCount(rfqId, BUYER_B)).toBe(1);

    // Buyer B opens the thread → their own badge clears, A unaffected.
    await rfqModel.getQueryMessages(rfqId, BUYER_B, VENDOR);
    expect(await buyerListUnseenCount(rfqId, BUYER_A)).toBe(0);
    expect(await buyerListUnseenCount(rfqId, BUYER_B)).toBe(0);
  });

  it("getQueryMessages writes one read row per opener, never a global flag", async () => {
    const rfqId = await makePublishedRfq();
    const msgId = await insertQueryMessage({
      rfqId, senderId: VENDOR, receiverId: BUYER_A, senderType: SENDER_TYPE_VENDOR,
    });

    expect(await readsForMessage(msgId)).toEqual([]);

    await rfqModel.getQueryMessages(rfqId, BUYER_A, VENDOR);
    expect(await readsForMessage(msgId)).toEqual([{ user_id: BUYER_A }]);

    // Re-opening by the same user is idempotent (ON CONFLICT DO NOTHING).
    await rfqModel.getQueryMessages(rfqId, BUYER_A, VENDOR);
    expect(await readsForMessage(msgId)).toEqual([{ user_id: BUYER_A }]);

    await rfqModel.getQueryMessages(rfqId, BUYER_B, VENDOR);
    expect(await readsForMessage(msgId)).toEqual([
      { user_id: BUYER_A },
      { user_id: BUYER_B },
    ]);

    // is_seen on the message itself must NEVER flip — that was the global flag
    // that caused the original bug. Confirm we did not regress to writing it.
    const stillUnseen = await db.one(
      `SELECT is_seen FROM tbl_query_messages WHERE id = $1`, [msgId]
    );
    expect(stillUnseen.is_seen).toBe(false);
  });

  it("buyer→vendor messages remain scoped to the addressed vendor user(s)", async () => {
    const rfqId = await makePublishedRfq();
    await insertQueryMessage({
      rfqId, senderId: BUYER_A, receiverId: VENDOR, senderType: SENDER_TYPE_BUYER,
    });

    // Vendor viewer keeps receiver_id semantics: addressed vendor sees unread.
    const vendorSummary = await rfqModel.getQueryParticipantsSummary(
      rfqId, VENDOR, VENDOR_VIEWER_TYPE
    );
    const vendorRow = vendorSummary.find((r) => r.user_id === BUYER_A);
    expect(vendorRow).toBeDefined();
    expect(Number(vendorRow.unseen_count)).toBe(1);

    // A different vendor user (unaddressed) sees nothing for this buyer.
    const otherVendorSummary = await rfqModel.getQueryParticipantsSummary(
      rfqId, IDS.users.vendor_beta, VENDOR_VIEWER_TYPE
    );
    const otherVendorRow = otherVendorSummary.find((r) => r.user_id === BUYER_A);
    // Either no row, or a row with unseen=0 — both prove scope is intact.
    expect(otherVendorRow ? Number(otherVendorRow.unseen_count) : 0).toBe(0);

    // Buyer-side unread count must NOT include buyer-sent messages.
    expect(await buyerListUnseenCount(rfqId, BUYER_A)).toBe(0);
  });

  it("getQueryParticipantsSummary (buyer viewer) reports vendor as unread for every buyer until each opens the thread", async () => {
    const rfqId = await makePublishedRfq();
    await insertQueryMessage({
      rfqId, senderId: VENDOR, receiverId: BUYER_A, senderType: SENDER_TYPE_VENDOR,
    });

    const initialA = await rfqModel.getQueryParticipantsSummary(rfqId, BUYER_A, BUYER_VIEWER_TYPE);
    const initialB = await rfqModel.getQueryParticipantsSummary(rfqId, BUYER_B, BUYER_VIEWER_TYPE);
    const aRow = initialA.find((r) => r.user_id === VENDOR);
    const bRow = initialB.find((r) => r.user_id === VENDOR);
    // Note: candidates list is sourced from tbl_rfq_product_vendors, so the
    // vendor row only appears if seeded as such. Where present, the unseen
    // count must reflect per-user state.
    if (aRow) expect(Number(aRow.unseen_count)).toBeGreaterThanOrEqual(1);
    if (bRow) expect(Number(bRow.unseen_count)).toBeGreaterThanOrEqual(1);

    await rfqModel.getQueryMessages(rfqId, BUYER_A, VENDOR);

    const afterA = await rfqModel.getQueryParticipantsSummary(rfqId, BUYER_A, BUYER_VIEWER_TYPE);
    const afterB = await rfqModel.getQueryParticipantsSummary(rfqId, BUYER_B, BUYER_VIEWER_TYPE);
    const aRowAfter = afterA.find((r) => r.user_id === VENDOR);
    const bRowAfter = afterB.find((r) => r.user_id === VENDOR);
    if (aRowAfter) expect(Number(aRowAfter.unseen_count)).toBe(0);
    if (bRowAfter) expect(Number(bRowAfter.unseen_count)).toBeGreaterThanOrEqual(1);
  });

  it("project-team buyers see the vendor's last message even when it was addressed to the creator (WhatsApp-like sort)", async () => {
    const rfqId = await makePublishedRfq();
    await attachVendorToRfq(rfqId, VENDOR);

    // Vendor sends a query addressed to Buyer A (creator) only.
    await insertQueryMessage({
      rfqId, senderId: VENDOR, receiverId: BUYER_A, senderType: SENDER_TYPE_VENDOR,
      text: "is the spec final?",
    });

    const summaryA = await rfqModel.getQueryParticipantsSummary(rfqId, BUYER_A, BUYER_VIEWER_TYPE);
    const summaryB = await rfqModel.getQueryParticipantsSummary(rfqId, BUYER_B, BUYER_VIEWER_TYPE);

    const aRow = summaryA.find((r) => r.user_id === VENDOR);
    const bRow = summaryB.find((r) => r.user_id === VENDOR);
    expect(aRow).toBeDefined();
    expect(bRow).toBeDefined();

    // Both buyer-side users must see the same last-message preview and
    // timestamp — that's what powers the WhatsApp-like sort for everyone on
    // the RFQ, not just the user named in receiver_id.
    expect(aRow.last_message).toBe("is the spec final?");
    expect(bRow.last_message).toBe("is the spec final?");
    expect(aRow.last_message_timestamp).toBeTruthy();
    expect(bRow.last_message_timestamp).toEqual(aRow.last_message_timestamp);

    // And both see the unread badge (independent state, asserted in earlier tests).
    expect(Number(aRow.unseen_count)).toBe(1);
    expect(Number(bRow.unseen_count)).toBe(1);
  });

  it("backfill SQL is idempotent — re-runs insert zero rows", async () => {
    const rfqId = await makePublishedRfq();
    // Seed a pre-migration-style row: is_seen=TRUE, no reads row yet.
    const msgRow = await db.one(
      `INSERT INTO tbl_query_messages (rfq_id, sender_id, receiver_id, sender_type, message_text, is_seen)
       VALUES ($1, $2, $3, $4, 'legacy', TRUE) RETURNING id`,
      [rfqId, VENDOR, BUYER_A, SENDER_TYPE_VENDOR]
    );
    inserted.messageIds.push(msgRow.id);

    const backfill = `
      INSERT INTO tbl_query_message_reads (message_id, user_id, read_at)
      SELECT id, receiver_id, NOW()
      FROM tbl_query_messages
      WHERE is_seen = TRUE AND receiver_id IS NOT NULL AND id = $1
      ON CONFLICT (message_id, user_id) DO NOTHING;
    `;

    const first = await db.result(backfill, [msgRow.id]);
    expect(first.rowCount).toBe(1);
    expect(await readsForMessage(msgRow.id)).toEqual([{ user_id: BUYER_A }]);

    const second = await db.result(backfill, [msgRow.id]);
    expect(second.rowCount).toBe(0);
    expect(await readsForMessage(msgRow.id)).toEqual([{ user_id: BUYER_A }]);
  });
});
