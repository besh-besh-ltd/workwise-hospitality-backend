// Wave-1 step-3.6 tests: clarification window — vendor raises Q, buyer
// resolves, one-at-a-time enforcement, privacy on listing.
//
// Per testing convention (tests/CONVENTIONS.md), every test calls the
// production controller `rfqController.{raiseClarification,resolveClarification,
// listClarifications,getActiveClarification}` directly with a mocked req/res.
// Setup data (RFQ rows) is committed via `db` and tracked for afterEach cleanup.

import {
  describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import rfqController from "../../app/controllers/rfq/rfqController.js";
import { makeRFQ } from "../factories/rfq.js";

// Express req/res mock factory (matches production controller's expected shape).
function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
  };
  return {
    req: {
      user: opts.user || null,
      params: opts.params || {},
      body: opts.body || {},
      files: opts.files || [],
    },
    res,
    next: jest.fn(),
    calls,
  };
}

// Unique rfq_no range for this suite to avoid collisions with other suites
// that share the factory's module-level counter (jest.config.js maxWorkers=1).
// Same shape used by rfq.publish.email.test.js and rfq.quoteCompare.test.js.
const nextClarificationRfqNo = () =>
  8500000 + Math.floor(Math.random() * 100000);

// Tracks rows inserted by tests for targeted cleanup after each test.
const inserted = { rfqIds: [] };

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  // Cascade-delete every clarification + message + file row tied to RFQs we
  // inserted; then delete the RFQs themselves.
  if (!inserted.rfqIds.length) return;
  await db.none(
    `DELETE FROM tbl_rfq_clarification_message_files
     WHERE message_id IN (
       SELECT m.id FROM tbl_rfq_clarification_messages m
       JOIN tbl_rfq_clarifications c ON c.id = m.clarification_id
       WHERE c.rfq_id = ANY($1::int[])
     )`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_clarification_messages
     WHERE clarification_id IN (SELECT id FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_clarification_files
     WHERE clarification_id IN (SELECT id FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ---- Setup helpers ---------------------------------------------------------

/**
 * Build a Published RFQ inside a 7-day clarification window. Status=1,
 * is_published=1, publish_date=2h ago, vendor_clarification_date=2 days from
 * now, bid_end_date=5 days from now.
 */
async function makePublishedRfqInClarificationWindow(opts = {}) {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
  const twoDaysHence = new Date(Date.now() + 2 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: twoHoursAgo,
    vendor_clarification_date: twoDaysHence,
    bid_end_date: fiveDaysHence,
    rfq_no: nextClarificationRfqNo(),
    ...opts,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

// ---- Tests -----------------------------------------------------------------

describe("raiseClarification", () => {
  it("happy path: vendor raises a clarification on a published RFQ in the clarification window", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    const { req, res, calls } = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "Spec query", question: "What size?" },
    });
    await rfqController.raiseClarification(req, res);

    expect(calls.status).toBe(200);
    expect(calls.body.status).toBe(1);
    expect(calls.body.data.status).toBe("OPEN");
    expect(calls.body.data.raised_by_vendor_id).toBe(IDS.users.vendor_alpha);
    expect(calls.body.data.subject).toBe("Spec query");

    // Persisted row check (committed by the controller's tx).
    const row = await db.one(
      `SELECT raised_by, status, subject FROM tbl_rfq_clarifications WHERE rfq_id=$1`,
      [rfq_id]
    );
    expect(row.raised_by).toBe(IDS.users.vendor_alpha);
    expect(row.status).toBe("OPEN");

    // Initial message persisted as VENDOR.
    const msg = await db.one(
      `SELECT sender_type, sender_id, message FROM tbl_rfq_clarification_messages
       WHERE clarification_id=$1`,
      [calls.body.data.id]
    );
    expect(msg.sender_type).toBe("VENDOR");
    expect(msg.sender_id).toBe(IDS.users.vendor_alpha);
    expect(msg.message).toBe("What size?");
  });

  it("rejects raise BEFORE the publish date when the RFQ is not yet published", async () => {
    // RFQ has tender_publish_date in the future and is_published=0 (status 4).
    const futurePublish = new Date(Date.now() + 1 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const farFutureClarif = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 4,
      is_published: 0,
      tender_publish_date: futurePublish,
      vendor_clarification_date: farFutureClarif,
    });
    inserted.rfqIds.push(rfq_id);

    const { req, res, calls } = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "Too early", question: "..." },
    });
    await rfqController.raiseClarification(req, res);
    expect(calls.status).toBe(400);
    expect(calls.body.message).toMatch(/has not started/i);
  });

  it("rejects raise AFTER the clarification end date", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const oneDayAgo = new Date(Date.now() - 1 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 1,
      is_published: 1,
      tender_publish_date: twoDaysAgo,
      vendor_clarification_date: oneDayAgo, // already past
      bid_end_date: fiveDaysHence,
    });
    inserted.rfqIds.push(rfq_id);

    const { req, res, calls } = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "Too late", question: "..." },
    });
    await rfqController.raiseClarification(req, res);
    expect(calls.status).toBe(400);
    expect(calls.body.message).toMatch(/period has ended/i);
  });

  it("returns 400 when the RFQ does not exist", async () => {
    const { req, res, calls } = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id: 99999999, subject: "Ghost", question: "?" },
    });
    await rfqController.raiseClarification(req, res);
    expect(calls.status).toBe(400);
    expect(calls.body.message).toMatch(/not found/i);
  });

  it("ONE-AT-A-TIME — Vendor B's raise is rejected while Vendor A's is OPEN", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();

    // A raises first.
    const a = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "A's question", question: "from A" },
    });
    await rfqController.raiseClarification(a.req, a.res);
    expect(a.calls.status).toBe(200);

    // B tries — should be rejected.
    const b = mockExpress({
      user: { id: IDS.users.vendor_beta, company_id: IDS.companies.vendorBeta },
      body: { rfq_id, subject: "B's question", question: "from B" },
    });
    await rfqController.raiseClarification(b.req, b.res);
    expect(b.calls.status).toBe(400);
    expect(b.calls.body.message).toMatch(/already open/i);
    // The error message must NOT leak A's identity (privacy).
    expect(b.calls.body.message).not.toMatch(/alpha/i);
    expect(b.calls.body.message).not.toMatch(/vendor_alpha/i);
  });

  it("ONE-AT-A-TIME — after A's clarification is RESOLVED, B can raise", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();

    // A raises.
    const a = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "A1", question: "from A" },
    });
    await rfqController.raiseClarification(a.req, a.res);
    const claraId = a.calls.body.data.id;

    // Buyer (creator) resolves.
    const r = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { clarification_id: claraId, response: "Here is your answer" },
    });
    await rfqController.resolveClarification(r.req, r.res);
    expect(r.calls.status).toBe(200);

    // B can now raise.
    const b = mockExpress({
      user: { id: IDS.users.vendor_beta, company_id: IDS.companies.vendorBeta },
      body: { rfq_id, subject: "B1", question: "from B" },
    });
    await rfqController.raiseClarification(b.req, b.res);
    expect(b.calls.status).toBe(200);
    expect(b.calls.body.data.status).toBe("OPEN");
  });
});

describe("resolveClarification", () => {
  it("happy path: buyer (creator) closes with a response — status flips OPEN → CLOSED", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    const a = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "Q", question: "?" },
    });
    await rfqController.raiseClarification(a.req, a.res);
    const claraId = a.calls.body.data.id;

    const r = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { clarification_id: claraId, response: "the answer" },
    });
    await rfqController.resolveClarification(r.req, r.res);

    expect(r.calls.status).toBe(200);
    expect(r.calls.body.data.status).toBe("CLOSED");
    expect(r.calls.body.data.closed_by).toBe(IDS.users.a1_proc_buyer);

    const persisted = await db.one(
      `SELECT status, response, responded_by FROM tbl_rfq_clarifications WHERE id=$1`,
      [claraId]
    );
    expect(persisted.status).toBe("CLOSED");
    expect(persisted.response).toBe("the answer");
    expect(persisted.responded_by).toBe(IDS.users.a1_proc_buyer);
  });

  it("F-CLAR-002 — REJECTS close without a response body (buyer must answer or explicitly dismiss)", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    const a = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "Q", question: "?" },
    });
    await rfqController.raiseClarification(a.req, a.res);
    const claraId = a.calls.body.data.id;

    const r = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { clarification_id: claraId /* no response */ },
    });
    await rfqController.resolveClarification(r.req, r.res);
    // POST-FIX: closing a clarification without supplying a response (or an
    // explicit dismissal flag) is a 400. The vendor's question must not be
    // silently nuked. Today the controller accepts the close + leaves
    // response NULL + sends no notification.
    expect(r.calls.status).toBe(400);
    expect(r.calls.body.message).toMatch(/response.*required|missing.*response|answer.*required/i);
    const persisted = await db.one(
      `SELECT status, response FROM tbl_rfq_clarifications WHERE id=$1`,
      [claraId]
    );
    expect(persisted.status).toBe("OPEN"); // unchanged
  });

  it("rejects close by NON-creator (403)", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    const a = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "Q", question: "?" },
    });
    await rfqController.raiseClarification(a.req, a.res);
    const claraId = a.calls.body.data.id;

    const r = mockExpress({
      user: { id: IDS.users.a1_eng_buyer }, // different user
      body: { clarification_id: claraId, response: "the answer" },
    });
    await rfqController.resolveClarification(r.req, r.res);
    expect(r.calls.status).toBe(403);
    const persisted = await db.one(
      `SELECT status FROM tbl_rfq_clarifications WHERE id=$1`,
      [claraId]
    );
    expect(persisted.status).toBe("OPEN");
  });

  it("rejects close of an already-CLOSED clarification (idempotency)", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    const a = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "Q", question: "?" },
    });
    await rfqController.raiseClarification(a.req, a.res);
    const claraId = a.calls.body.data.id;

    // First close — succeeds.
    await rfqController.resolveClarification(
      mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: { clarification_id: claraId, response: "first" },
      }).req,
      mockExpress({}).res
    );

    // Second close — rejected.
    const r2 = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { clarification_id: claraId, response: "second" },
    });
    await rfqController.resolveClarification(r2.req, r2.res);
    expect(r2.calls.status).toBe(400);
    expect(r2.calls.body.message).toMatch(/already been closed/i);
  });

  it("returns 400 when clarification_id does not exist", async () => {
    const r = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { clarification_id: 99999999, response: "?" },
    });
    await rfqController.resolveClarification(r.req, r.res);
    expect(r.calls.status).toBe(400);
    expect(r.calls.body.message).toMatch(/not found/i);
  });
});

describe("listClarifications — privacy", () => {
  it("buyer (creator) sees ALL clarifications", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    // A raises and resolves.
    const aRaise = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "from A", question: "?" },
    });
    await rfqController.raiseClarification(aRaise.req, aRaise.res);
    const aId = aRaise.calls.body.data.id;
    await rfqController.resolveClarification(
      mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: { clarification_id: aId, response: "answered A" },
      }).req,
      mockExpress({}).res
    );
    // B raises (currently open).
    const bRaise = mockExpress({
      user: { id: IDS.users.vendor_beta, company_id: IDS.companies.vendorBeta },
      body: { rfq_id, subject: "from B", question: "??" },
    });
    await rfqController.raiseClarification(bRaise.req, bRaise.res);

    // Buyer lists.
    const list = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1 /* not 3/4 → buyer-side */ },
      params: { rfq_id: String(rfq_id) },
    });
    await rfqController.listClarifications(list.req, list.res);
    expect(list.calls.status).toBe(200);
    expect(list.calls.body.data.is_buyer).toBe(true);
    expect(list.calls.body.data.clarifications.length).toBe(2);
    // Vendor names must be replaced with codes (tender privacy).
    for (const c of list.calls.body.data.clarifications) {
      expect(c.raised_by_vendor_code).toMatch(/^VEN-/);
      expect(c.raised_by_vendor_name).toBeUndefined();
    }
  });

  it("Vendor A sees ONLY their own clarifications (not B's)", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    // A raises, resolves, B raises (only B is currently open).
    const aRaise = mockExpress({
      user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
      body: { rfq_id, subject: "from A", question: "?" },
    });
    await rfqController.raiseClarification(aRaise.req, aRaise.res);
    const aId = aRaise.calls.body.data.id;
    await rfqController.resolveClarification(
      mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: { clarification_id: aId, response: "answered" },
      }).req,
      mockExpress({}).res
    );
    const bRaise = mockExpress({
      user: { id: IDS.users.vendor_beta, company_id: IDS.companies.vendorBeta },
      body: { rfq_id, subject: "from B", question: "??" },
    });
    await rfqController.raiseClarification(bRaise.req, bRaise.res);

    // A lists — should see only their own (the resolved one).
    const list = mockExpress({
      user: { id: IDS.users.vendor_alpha, user_type: 3 /* vendor */ },
      params: { rfq_id: String(rfq_id) },
    });
    await rfqController.listClarifications(list.req, list.res);
    expect(list.calls.status).toBe(200);
    expect(list.calls.body.data.is_buyer).toBe(false);
    const ids = list.calls.body.data.clarifications.map((c) => c.raised_by_vendor_id);
    expect(ids).toEqual([IDS.users.vendor_alpha]);
    expect(ids).not.toContain(IDS.users.vendor_beta);
    // has_open is true (B's is open) but A doesn't get the body of it.
    expect(list.calls.body.data.has_open).toBe(true);
    expect(list.calls.body.data.is_own_clarification).toBe(false);
    expect(list.calls.body.data.open_clarification).toBeNull();
  });

  it("Vendor B (the one currently with an OPEN clarification) sees only their own + flagged as own_open", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    const bRaise = mockExpress({
      user: { id: IDS.users.vendor_beta, company_id: IDS.companies.vendorBeta },
      body: { rfq_id, subject: "from B", question: "??" },
    });
    await rfqController.raiseClarification(bRaise.req, bRaise.res);

    const list = mockExpress({
      user: { id: IDS.users.vendor_beta, user_type: 3 },
      params: { rfq_id: String(rfq_id) },
    });
    await rfqController.listClarifications(list.req, list.res);
    expect(list.calls.body.data.is_own_clarification).toBe(true);
    expect(list.calls.body.data.open_clarification).not.toBeNull();
    expect(list.calls.body.data.clarifications.length).toBe(1);
    expect(list.calls.body.data.clarifications[0].raised_by_vendor_id).toBe(IDS.users.vendor_beta);
  });
});

describe("getActiveClarification — quote-block signal", () => {
  it("returns has_open=false when no clarification is OPEN", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    const list = mockExpress({
      user: { id: IDS.users.vendor_alpha, user_type: 3 },
      params: { rfq_id: String(rfq_id) },
    });
    await rfqController.listClarifications(list.req, list.res);
    expect(list.calls.body.data.has_open).toBe(false);
  });

  it("returns has_open=true once any vendor raises a clarification (quote-block signal)", async () => {
    const rfq_id = await makePublishedRfqInClarificationWindow();
    await rfqController.raiseClarification(
      mockExpress({
        user: { id: IDS.users.vendor_alpha, company_id: IDS.companies.vendorAlpha },
        body: { rfq_id, subject: "X", question: "Y" },
      }).req,
      mockExpress({}).res
    );

    // Any other vendor (or even unauthenticated) sees has_open=true.
    const list = mockExpress({
      user: { id: IDS.users.vendor_beta, user_type: 3 },
      params: { rfq_id: String(rfq_id) },
    });
    await rfqController.listClarifications(list.req, list.res);
    expect(list.calls.body.data.has_open).toBe(true);
  });
});
