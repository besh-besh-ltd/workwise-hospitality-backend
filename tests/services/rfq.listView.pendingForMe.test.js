// "Pending for me" contract — the tab is STRICTLY the caller's own pending work.
// ---------------------------------------------------------------------------
// Two proven leaks this locks shut:
//
//   1. computeLifecycleStages ignores tbl_rfq.status in 11 of its 15 CASE
//      branches, so a CLOSED RFQ keeps reporting COMMERCIAL_EVALUATION and
//      flags every commercial evaluator as pending on it. The row renders a
//      grey "Closed" pill AND increments the pending count. 292 of 743
//      production rows; 69 of the reporting user's 149.
//
//   2. AWAITING_QUOTES was mapped to quote-compare even though the server
//      blanks every quote and returns 423 until the deadline
//      (quoteVisibility.js:41-94; quoteCompareViewModel.js:782 says in code
//      "Nothing is actionable or evaluatable before the deadline").
//
// It also locks in the new grouping: every pending row reports a pending_kind
// of approval | evaluation | response, with the reasons that produced it.
//
// NOTE ON FIXTURES: role 8 (Commercial Negotiator N1) carries
// quote-compare.read + .create but NO rfq.read, so a user holding only role 8
// is filtered out of the listing entirely by getAllBuyerRfq's read gate and
// would never appear in any assertion. Every evaluation test therefore layers
// role 8 on top of an rfq.read-bearing fixture user — exactly as production
// does (the reporting user holds role 8 plus roles 17/18).
//
// Pattern B (commit + cleanup).
//   npm test -- --testPathPatterns "rfq.listView.pendingForMe"

import {
  describe, it, expect, afterAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { insertVendorQuote } from "../helpers/dashboardSeed.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";

afterAll(async () => {
  await closeDb();
});

const ROLE_COMM_NEGO_N1 = 8;

const EVALUATOR = IDS.users.a1_proc_buyer;   // rfq.read via TENDER_CREATOR
const OUTSIDER = IDS.users.a1_eng_buyer;     // rfq.read, but no quote-compare

const inserted = { rfqIds: [], scopeIds: [], quoteIds: [], clarIds: [], msgIds: [], roundIds: [] };

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  await revokeRoleScopes(db, inserted.scopeIds);
  if (inserted.msgIds.length) {
    await db.none(`DELETE FROM tbl_query_message_reads WHERE message_id = ANY($1::int[])`, [inserted.msgIds]);
    await db.none(`DELETE FROM tbl_query_messages WHERE id = ANY($1::int[])`, [inserted.msgIds]);
  }
  if (inserted.clarIds.length) {
    await db.none(`DELETE FROM tbl_rfq_clarifications WHERE id = ANY($1::int[])`, [inserted.clarIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.roundIds.length) {
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [inserted.roundIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

async function addProduct(rfq_id) {
  await db.none(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)`,
    [rfq_id]
  );
}

// Published, bid window CLOSED, one non-regret quote, no technical evaluation
// configured -> computeLifecycleStages' no-TE branch
// (`hte IS NULL AND bid_ended AND he IS NOT NULL`) yields COMMERCIAL_EVALUATION.
// That branch never reads rd.status, which is exactly the leak under test.
async function makeCommercialEvaluationRfq({ status = 1 } = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: EVALUATOR,
    status,
    is_published: 1,
    is_tender: 0,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
    bid_end_date: "2026-01-01 10:00:00", // naive IST wall-clock, in the past
  });
  inserted.rfqIds.push(rfq_id);
  await addProduct(rfq_id);
  const qid = await insertVendorQuote(db, { rfq_id, vendor_user_id: IDS.users.superAdmin });
  inserted.quoteIds.push(qid);
  return rfq_id;
}

// Published, bid window still OPEN, no technical evaluation -> AWAITING_QUOTES.
async function makeAwaitingQuotesRfq({ createdBy = EVALUATOR } = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy,
    status: 1,
    is_published: 1,
    is_tender: 0,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
    bid_end_date: "2099-01-01 10:00:00",
  });
  inserted.rfqIds.push(rfq_id);
  await addProduct(rfq_id);
  return rfq_id;
}

async function grantCommercialEvaluator(userId, processId = null) {
  const id = await grantRoleScope(db, {
    userId,
    roleId: ROLE_COMM_NEGO_N1,
    companyId: IDS.hospitality.A,
    hotelId: IDS.hotels.A1,
    departmentId: IDS.departments.proc,
    processId,
  });
  inserted.scopeIds.push(id);
  return id;
}

async function listView(userId, body = {}) {
  const client = await httpClient(userId);
  const res = await client.post("/api/v1/rfq/list-view").send({ tab: "all", limit: 100, ...body });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data;
}

const rowFor = (data, rfq_id) =>
  (data.rows || []).find((r) => Number(r.id) === Number(rfq_id));

// ===========================================================================

describe("POST /rfq/list-view — terminal-status RFQs are never pending", () => {
  it("a CLOSED (status 2) RFQ still reporting COMMERCIAL_EVALUATION is not pending for a commercial evaluator", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    const rfq_id = await makeCommercialEvaluationRfq({ status: 2 });

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row).toBeDefined();
    expect(row.status_key).toBe("CLOSED");
    expect(row.bucket).toBe("closed");
    expect(row.is_pending_for_me).toBe(false);
    expect(row.action_holders).toBeNull();
  });

  it("a WITHDRAWN (status 5) RFQ is not pending", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    const rfq_id = await makeCommercialEvaluationRfq({ status: 5 });

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row).toBeDefined();
    expect(row.is_pending_for_me).toBe(false);
  });

  // The guard lives in TWO places — getActionHoldersForRFQs and
  // getPendingPersonal — because the response sources never pass through the
  // former. closeRFQ does not clear tbl_rfq_clarifications, and the RFQ_STUCK_*
  // branches of computeLifecycleStages never read rd.status, so without the
  // second guard a closed RFQ keeps reporting personal work forever.
  it("a CLOSED RFQ with an OPEN clarification is not pending for its creator", async () => {
    const rfq_id = await makeAwaitingQuotesRfq();
    await db.none(`UPDATE tbl_rfq SET status = 2 WHERE id = $1`, [rfq_id]);
    const c = await db.one(
      `INSERT INTO tbl_rfq_clarifications
         (rfq_id, raised_by, vendor_company_id, subject, question, status)
       VALUES ($1, $2, NULL, 'Spec query', 'Which finish?', 'OPEN')
       RETURNING id`,
      [rfq_id, IDS.users.superAdmin]
    );
    inserted.clarIds.push(c.id);

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row).toBeDefined();
    expect(row.status_key).toBe("CLOSED");
    expect(row.is_pending_for_me).toBe(false);
    expect(row.pending_reasons).toEqual([]);
  });

  it("a CLOSED RFQ with an unread vendor query is not pending for its receiver", async () => {
    const rfq_id = await makeAwaitingQuotesRfq();
    await db.none(`UPDATE tbl_rfq SET status = 2 WHERE id = $1`, [rfq_id]);
    const m = await db.one(
      `INSERT INTO tbl_query_messages (rfq_id, sender_id, receiver_id, sender_type, message_text)
       VALUES ($1, $2, $3, 3, 'Still waiting')
       RETURNING id`,
      [rfq_id, IDS.users.superAdmin, EVALUATOR]
    );
    inserted.msgIds.push(m.id);

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row.is_pending_for_me).toBe(false);
    expect(row.pending_reasons).toEqual([]);
  });

  it("a WITHDRAWN RFQ with an OPEN clarification is not pending either", async () => {
    const rfq_id = await makeAwaitingQuotesRfq();
    await db.none(`UPDATE tbl_rfq SET status = 5 WHERE id = $1`, [rfq_id]);
    const c = await db.one(
      `INSERT INTO tbl_rfq_clarifications
         (rfq_id, raised_by, vendor_company_id, subject, question, status)
       VALUES ($1, $2, NULL, 'Spec query', 'Which finish?', 'OPEN')
       RETURNING id`,
      [rfq_id, IDS.users.superAdmin]
    );
    inserted.clarIds.push(c.id);

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row.is_pending_for_me).toBe(false);
  });

  it("a closed RFQ does not inflate tab_counts.pending", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    const before = (await listView(EVALUATOR)).tab_counts.pending;

    await makeCommercialEvaluationRfq({ status: 2 });

    const after = (await listView(EVALUATOR)).tab_counts.pending;
    expect(after).toBe(before);
  });
});

describe("POST /rfq/list-view — bid-open RFQs are never pending", () => {
  it("AWAITING_QUOTES is not pending for a commercial evaluator", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    const rfq_id = await makeAwaitingQuotesRfq();

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row).toBeDefined();
    expect(row.status_key).toBe("AWAITING_QUOTES");
    expect(row.is_pending_for_me).toBe(false);
    expect(row.action_holders).toBeNull();
  });

  it("a live COMMERCIAL_EVALUATION RFQ IS still pending for an in-scope evaluator (control)", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    const rfq_id = await makeCommercialEvaluationRfq({ status: 1 });

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row).toBeDefined();
    expect(row.status_key).toBe("COMMERCIAL_EVALUATION");
    expect(row.is_pending_for_me).toBe(true);
  });

  it("a live COMMERCIAL_EVALUATION RFQ is NOT pending for a user without quote-compare (control)", async () => {
    const rfq_id = await makeCommercialEvaluationRfq({ status: 1 });

    const row = rowFor(await listView(OUTSIDER), rfq_id);

    if (row) expect(row.is_pending_for_me).toBe(false);
  });
});

describe("POST /rfq/list-view — evaluation membership respects the RFQ's own scope", () => {
  it("an evaluator scoped to a DIFFERENT process is not pending", async () => {
    // The RFQ is created under A_P1; the grant is confined to A_P2.
    await grantCommercialEvaluator(EVALUATOR, IDS.processes.A_P2);
    const rfq_id = await makeCommercialEvaluationRfq({ status: 1 });

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row).toBeDefined();
    expect(row.is_pending_for_me).toBe(false);
  });

  it("an evaluator scoped to the RFQ's own process IS pending", async () => {
    await grantCommercialEvaluator(EVALUATOR, IDS.processes.A_P1);
    const rfq_id = await makeCommercialEvaluationRfq({ status: 1 });

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row.is_pending_for_me).toBe(true);
  });

  it("a process-agnostic (NULL process_id) evaluator scope still matches", async () => {
    await grantCommercialEvaluator(EVALUATOR); // processId omitted -> NULL
    const rfq_id = await makeCommercialEvaluationRfq({ status: 1 });

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row.is_pending_for_me).toBe(true);
  });

  it("action_holders carry kind 'evaluation' for a permission stage", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    const rfq_id = await makeCommercialEvaluationRfq({ status: 1 });

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row.action_holders.type).toBe("permission");
    expect(row.action_holders.kind).toBe("evaluation");
  });
});

describe("POST /rfq/list-view — personal 'needs your response' work", () => {
  it("an OPEN clarification makes the RFQ pending for the creator only", async () => {
    const rfq_id = await makeAwaitingQuotesRfq(); // creator = EVALUATOR
    const c = await db.one(
      `INSERT INTO tbl_rfq_clarifications
         (rfq_id, raised_by, vendor_company_id, subject, question, status)
       VALUES ($1, $2, NULL, 'Spec query', 'Which finish?', 'OPEN')
       RETURNING id`,
      [rfq_id, IDS.users.superAdmin]
    );
    inserted.clarIds.push(c.id);

    const mine = rowFor(await listView(EVALUATOR), rfq_id);
    expect(mine.is_pending_for_me).toBe(true);
    expect(mine.pending_kind).toBe("response");
    expect(mine.pending_reasons.map((r) => r.code)).toContain("CLARIFICATION_OPEN");

    const theirs = rowFor(await listView(OUTSIDER), rfq_id);
    if (theirs) expect(theirs.is_pending_for_me).toBe(false);
  });

  it("an unread vendor query makes the RFQ pending for the addressed receiver only", async () => {
    const rfq_id = await makeAwaitingQuotesRfq({ createdBy: OUTSIDER });
    const m = await db.one(
      `INSERT INTO tbl_query_messages (rfq_id, sender_id, receiver_id, sender_type, message_text)
       VALUES ($1, $2, $3, 3, 'When is delivery?')
       RETURNING id`,
      [rfq_id, IDS.users.superAdmin, EVALUATOR]
    );
    inserted.msgIds.push(m.id);

    // Addressed to EVALUATOR, who did NOT create this RFQ — proving the rule is
    // receiver-scoped rather than creator-scoped.
    const row = rowFor(await listView(EVALUATOR), rfq_id);
    expect(row.is_pending_for_me).toBe(true);
    expect(row.pending_kind).toBe("response");
    expect(row.pending_reasons.map((r) => r.code)).toContain("UNREAD_VENDOR_QUERIES");

    // The creator is NOT the addressee, so this is not their task.
    const creatorRow = rowFor(await listView(OUTSIDER), rfq_id);
    if (creatorRow) {
      expect(creatorRow.pending_reasons.map((r) => r.code)).not.toContain("UNREAD_VENDOR_QUERIES");
    }
  });

  it("a READ vendor query does not make the RFQ pending", async () => {
    const rfq_id = await makeAwaitingQuotesRfq();
    const m = await db.one(
      `INSERT INTO tbl_query_messages (rfq_id, sender_id, receiver_id, sender_type, message_text)
       VALUES ($1, $2, $3, 3, 'When is delivery?')
       RETURNING id`,
      [rfq_id, IDS.users.superAdmin, EVALUATOR]
    );
    inserted.msgIds.push(m.id);
    await db.none(
      `INSERT INTO tbl_query_message_reads (message_id, user_id) VALUES ($1, $2)`,
      [m.id, EVALUATOR]
    );

    const row = rowFor(await listView(EVALUATOR), rfq_id);
    expect(row.is_pending_for_me).toBe(false);
  });

  it("a buyer-sent (non-vendor) message never counts", async () => {
    const rfq_id = await makeAwaitingQuotesRfq();
    const m = await db.one(
      `INSERT INTO tbl_query_messages (rfq_id, sender_id, receiver_id, sender_type, message_text)
       VALUES ($1, $2, $3, 2, 'Reminder sent')
       RETURNING id`,
      [rfq_id, IDS.users.superAdmin, EVALUATOR]
    );
    inserted.msgIds.push(m.id);

    const row = rowFor(await listView(EVALUATOR), rfq_id);
    expect(row.is_pending_for_me).toBe(false);
  });
});

describe("POST /rfq/list-view — pending grouping contract", () => {
  it("an evaluation row reports pending_kind 'evaluation' with a matching reason", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    const rfq_id = await makeCommercialEvaluationRfq({ status: 1 });

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row.pending_kind).toBe("evaluation");
    expect(Array.isArray(row.pending_reasons)).toBe(true);
    expect(row.pending_reasons.some((r) => r.kind === "evaluation")).toBe(true);
  });

  it("a non-pending row reports pending_kind null and an empty reasons array", async () => {
    const rfq_id = await makeAwaitingQuotesRfq();

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row.pending_kind).toBeNull();
    expect(row.pending_reasons).toEqual([]);
    expect(row.is_pending_for_me).toBe(false);
  });

  it("response outranks evaluation when a row qualifies as both", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    const rfq_id = await makeCommercialEvaluationRfq({ status: 1 });
    const m = await db.one(
      `INSERT INTO tbl_query_messages (rfq_id, sender_id, receiver_id, sender_type, message_text)
       VALUES ($1, $2, $3, 3, 'Still waiting')
       RETURNING id`,
      [rfq_id, IDS.users.superAdmin, EVALUATOR]
    );
    inserted.msgIds.push(m.id);

    const row = rowFor(await listView(EVALUATOR), rfq_id);

    expect(row.pending_kind).toBe("response");
    // The evaluation claim is not lost — it rides along as a secondary reason.
    const kinds = row.pending_reasons.map((r) => r.kind);
    expect(kinds).toContain("response");
    expect(kinds).toContain("evaluation");
  });

  it("tab_counts.pending_breakdown sums to tab_counts.pending", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    await makeCommercialEvaluationRfq({ status: 1 });

    const { tab_counts } = await listView(EVALUATOR);
    const b = tab_counts.pending_breakdown;

    expect(b).toBeDefined();
    expect(b.approval + b.evaluation + b.response).toBe(tab_counts.pending);
  });

  it("the pending tab returns exactly the flagged rows, approvals first", async () => {
    await grantCommercialEvaluator(EVALUATOR);
    await makeCommercialEvaluationRfq({ status: 1 });

    const data = await listView(EVALUATOR, { tab: "pending" });

    expect(data.total).toBe(data.tab_counts.pending);
    expect(data.rows.every((r) => r.is_pending_for_me === true)).toBe(true);

    const order = { approval: 0, response: 1, evaluation: 2 };
    const seen = data.rows.map((r) => order[r.pending_kind]);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// Source 4: a negotiation round still ACTIVE past its end date.
//
// tbl_negotiation_rounds.end_date is a NAIVE column holding UTC — the opposite
// convention to tbl_rfq.bid_end_date, which holds naive IST. Comparing it
// against `CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'` measures it against a
// wall clock 5h30m ahead, so the flag fired on rounds up to 5.5 hours BEFORE
// they ended. Confirmed in production on RFQ 536312 / round 950: end_date
// 11:30 UTC, flag firing since 06:00 UTC, sweeper correctly refusing to close.
//
// The predicate must stay identical to the sweeper's in cronManager.js
// (runNegotiationRoundClosureSweep). When the two disagree this flag fires on
// rounds the sweeper will not close, so the row cannot clear itself.
// ---------------------------------------------------------------------------

/** Naive-UTC 'YYYY-MM-DD HH:MM:SS', offset from now — the column's own format. */
const utcNaive = (hoursFromNow) =>
  new Date(Date.now() + hoursFromNow * 3600 * 1000)
    .toISOString().slice(0, 19).replace("T", " ");

async function addRound(rfq_id, { status, endDate }) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, round_number, status, end_date, created_by)
     VALUES ($1, 'RFQ', $1, 1, $2, $3, $4)
     RETURNING id`,
    [rfq_id, status, endDate, EVALUATOR]
  );
  inserted.roundIds.push(Number(row.id));
  return Number(row.id);
}

describe("POST /rfq/list-view — an ACTIVE negotiation round past its end date", () => {
  it("a round still 2 hours from its deadline is NOT pending", async () => {
    // Inside the old 5h30m false-positive window: the IST predicate called
    // this ended, the sweeper (correctly) did not.
    const rfq_id = await makeAwaitingQuotesRfq();
    await addRound(rfq_id, { status: "ACTIVE", endDate: utcNaive(2) });

    const row = rowFor(await listView(EVALUATOR), rfq_id);
    if (row) {
      expect(row.pending_reasons.map((r) => r.code)).not.toContain("NEGOTIATION_ROUND_EXPIRED");
    }
  });

  it("a round past its deadline and still ACTIVE IS pending for the creator", async () => {
    const rfq_id = await makeAwaitingQuotesRfq();
    await addRound(rfq_id, { status: "ACTIVE", endDate: utcNaive(-2) });

    const row = rowFor(await listView(EVALUATOR), rfq_id);
    expect(row.is_pending_for_me).toBe(true);
    expect(row.pending_kind).toBe("response");
    expect(row.pending_reasons.map((r) => r.code)).toContain("NEGOTIATION_ROUND_EXPIRED");
  });

  it("a round the sweeper already closed is not pending", async () => {
    const rfq_id = await makeAwaitingQuotesRfq();
    await addRound(rfq_id, { status: "ENDED", endDate: utcNaive(-2) });

    const row = rowFor(await listView(EVALUATOR), rfq_id);
    if (row) {
      expect(row.pending_reasons.map((r) => r.code)).not.toContain("NEGOTIATION_ROUND_EXPIRED");
    }
  });

  it("an expired round on someone else's RFQ is not pending for a non-creator", async () => {
    const rfq_id = await makeAwaitingQuotesRfq({ createdBy: OUTSIDER });
    await addRound(rfq_id, { status: "ACTIVE", endDate: utcNaive(-2) });

    const row = rowFor(await listView(EVALUATOR), rfq_id);
    if (row) {
      expect(row.pending_reasons.map((r) => r.code)).not.toContain("NEGOTIATION_ROUND_EXPIRED");
    }
  });
});
