// negotiation.listView.parent.test.js — RFQ-first grouping on POST /negotiation/list-view.
//
// THE BUG (production, reported by users):
//   /dashboard/buyer/negotiation returned ONE ROW PER ROUND. RFQ 512 has 138
//   negotiation rounds, so it rendered 138 rows and users read them as 138
//   different RFQs. Production carries 886 rounds over 124 distinct RFQs
//   (median 2 rounds, max 138) — grouping collapses 45 pages to 7.
//
// THE FIX: `groupBy: 'parent' | 'round'` on the SAME endpoint, defaulting to
// 'parent'. One pipeline serves both grains, so the two can never drift into
// disagreeing status vocabularies the way the listing and the round-detail page
// once did. `groupBy: 'round'` is the historic shape, unchanged.
//
// WHAT THIS SUITE PINS DOWN:
//   1. One row per RFQ, with round_count and per-state counts.
//   2. The ROLL-UP status, which is action-first and DELIBERATELY NOT
//      NEG_STATE_ORDER:
//        awaiting_approval > open_with_vendors > ready_for_decision >
//        concluded > no_vendor_response > lapsed > cancelled
//      The round-level order puts no_vendor_response ABOVE concluded — right
//      for one round, wrong for an RFQ. Measured on production 2026-08-01: 15
//      of 124 RFQs would otherwise head their card "Closed — no vendor
//      response" while a later round of the same RFQ had concluded.
//   3. Status tabs partition the rows: tab_counts sum to the total, no row in
//      two tabs.
//   4. SCOPE. Grouping over an already-scoped set cannot widen scope. Cross-
//      tenant and cross-hotel isolation must hold at the PARENT grain exactly
//      as negotiation.listView.scope.test.js proves it at the round grain.
//      filters.rfqId / filters.parentKey are NARROWING FILTERS ON A SCOPED SET,
//      never lookup keys — an out-of-scope id yields an EMPTY PAGE, not a 403
//      and not somebody else's data. This module had a live cross-tenant leak.
//   5. ARC parents appear with parent_key 'ARC:<id>' and rfq_id NULL — which is
//      exactly why parentKey exists alongside rfqId.
//
// Fixtures follow negotiation.listView.scope.test.js: purpose-built users with
// an explicit tbl_user_role_scopes grant of the negotiation.read role, direct
// INSERT seeding, every assertion over real HTTP.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { makeRFQ } from "../factories/rfq.js";

const HC_A = IDS.hospitality.A;
const HC_B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const PROC = IDS.departments.proc;
const ENG = IDS.departments.eng;
const PROCESS = IDS.processes.A_P1;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

// Role 8 = Commercial Negotiator N1 — carries permission negotiation.read.
const ROLE_NEG_READ = 8;

// Purpose-built users (80941+ — clear of 80901-80905, 80921-80922, 80931-80932).
const U_A = 80941; // company-wide under hospitality A
const U_A1 = 80942; // hotel-scoped: (HC_A, A1) only
const U_B = 80943; // company-wide under hospitality B

const VENDOR = IDS.users.vendor_alpha;

const PFX = "NEGPARENT-";
const D = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
const PAST = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

let clientA, clientA1, clientB;
const rfq = {}; // key → { id, no, productId }
const rounds = {}; // key → [round ids]
let arcId, arcItemId;
const arcRoundIds = [];
const instanceIds = [];
let policyId = null;
let ownedPolicy = false;
const OWN_POLICY_ID = 979201;

async function makeScopedUser(userId, name, { company, hc, hotel = null }) {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 2, $4, now(), now())
     ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
    [userId, name, `negparent.${userId}@test.local`, company]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
    [userId, hc, hotel, hotel == null ? 0 : 1, IDS.users.superAdmin]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
     VALUES ($1, $2, $3, $4, NULL)`,
    [userId, ROLE_NEG_READ, hc, hotel]
  );
}

async function seedRfq(key, { hc, hotel, dept, title }) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.superAdmin,
    hospitality: hc,
    hotel,
    department: dept,
    process: PROCESS,
    title: `${PFX}${title}`,
  });
  const product = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, product_variant_id, variant, comment, spec_file, qap_file)
     VALUES ($1, $2, 0, $3, '0', '0') RETURNING id`,
    [Number(rfq_id), VARIANT_ID, `${key} line`]
  );
  rfq[key] = { id: Number(rfq_id), no: Number(rfq_no), productId: Number(product.id) };
  rounds[key] = [];
  return rfq[key];
}

// One round on an RFQ. `withQuote` inserts a vendor response so the state CASE
// can tell "nobody replied" from "replies are waiting for a decision".
async function addRound(key, { status, endDate, withQuote = false, createdAgoDays = 1 }) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, rfq_product_id, round_number, status,
        end_date, vendor_ids, created_by, created_at)
     VALUES ($1, 'RFQ', $1, $2, $3, $4, $5, $6::int[], $7, $8)
     RETURNING id`,
    [
      rfq[key].id,
      rfq[key].productId,
      rounds[key].length + 1,
      status,
      endDate,
      [VENDOR],
      IDS.users.superAdmin,
      PAST(createdAgoDays),
    ]
  );
  const roundId = Number(row.id);
  rounds[key].push(roundId);
  if (withQuote) {
    await db.none(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at, created_at)
       VALUES ($1, $2, $3, 900, now(), now())`,
      [roundId, VENDOR, rfq[key].productId]
    );
  }
  return roundId;
}

describe("Negotiation list-view — RFQ-first parent grouping", () => {
  beforeAll(async () => {
    await makeScopedUser(U_A, "NegParent A User", { company: IDS.companies.A, hc: HC_A });
    await makeScopedUser(U_A1, "NegParent A1 User", { company: IDS.companies.A, hc: HC_A, hotel: A1 });
    await makeScopedUser(U_B, "NegParent B User", { company: IDS.companies.B, hc: HC_B });

    // ── MULTI: three rounds in three DIFFERENT states ────────────────────────
    // cancelled + no_vendor_response + ready_for_decision → ready_for_decision.
    await seedRfq("MULTI", { hc: HC_A, hotel: A1, dept: PROC, title: "Multi Round" });
    await addRound("MULTI", { status: "CANCELLED", endDate: PAST(2), createdAgoDays: 5 });
    await addRound("MULTI", { status: "ENDED", endDate: PAST(1), createdAgoDays: 4 });
    await addRound("MULTI", { status: "ENDED", endDate: PAST(1), withQuote: true, createdAgoDays: 3 });

    // ── CONCLUDED: {no_vendor_response, concluded} → concluded ───────────────
    // The 15-production-RFQ case. Under NEG_STATE_ORDER this would read
    // "Closed — no vendor response" despite a later round having concluded.
    await seedRfq("CONCLUDED", { hc: HC_A, hotel: A1, dept: PROC, title: "Concluded Later" });
    await addRound("CONCLUDED", { status: "ENDED", endDate: PAST(2), createdAgoDays: 6 });
    await addRound("CONCLUDED", { status: "COMPLETED", endDate: PAST(1), withQuote: true, createdAgoDays: 5 });

    // ── READY: {concluded, ready_for_decision} → ready_for_decision ──────────
    // Action beats history: something still needs a human.
    await seedRfq("READY", { hc: HC_A, hotel: A1, dept: PROC, title: "Ready Beats Concluded" });
    await addRound("READY", { status: "COMPLETED", endDate: PAST(3), withQuote: true, createdAgoDays: 7 });
    await addRound("READY", { status: "ENDED", endDate: PAST(1), withQuote: true, createdAgoDays: 2 });

    // ── OPEN: an open window outranks everything closed ─────────────────────
    await seedRfq("OPEN", { hc: HC_A, hotel: A1, dept: PROC, title: "Open With Vendors" });
    await addRound("OPEN", { status: "COMPLETED", endDate: PAST(3), withQuote: true, createdAgoDays: 4 });
    await addRound("OPEN", { status: "ACTIVE", endDate: D(7), createdAgoDays: 1 });

    // ── Cross-hotel (A2) and cross-tenant (B) parents ───────────────────────
    await seedRfq("A2", { hc: HC_A, hotel: A2, dept: ENG, title: "Other Hotel" });
    await addRound("A2", { status: "ENDED", endDate: PAST(1), withQuote: true });

    await seedRfq("FOREIGN", { hc: HC_B, hotel: B1, dept: PROC, title: "Other Company" });
    await addRound("FOREIGN", { status: "ENDED", endDate: PAST(1), withQuote: true });

    // ── ARC parent with two rounds ──────────────────────────────────────────
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $8, 'open')
       RETURNING id`,
      [`${PFX}ARC-4410`, `${PFX}Arc Parent`, CATEGORY, HC_A, A1, PROC, PROCESS, IDS.users.superAdmin]
    );
    arcId = Number(arc.id);
    const arcItem = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 10, 'kg') RETURNING id`,
      [arcId, VARIANT_ID]
    );
    arcItemId = Number(arcItem.id);
    for (const [n, status] of [[1, "ENDED"], [2, "ACTIVE"]]) {
      const r = await db.one(
        `INSERT INTO tbl_negotiation_rounds
           (source_type, source_id, arc_item_id, rfq_id, round_number, status,
            end_date, vendor_ids, created_by)
         VALUES ('ARC', $1, $2, NULL, $3, $4, $5, $6::int[], $7)
         RETURNING id`,
        [arcId, arcItemId, n, status, status === "ACTIVE" ? D(5) : PAST(1), [VENDOR], IDS.users.superAdmin]
      );
      arcRoundIds.push(Number(r.id));
    }

    // ── "Pending for me" — the LEGACY approval-instance shape ───────────────
    // 69 of 884 production NEGOTIATION instances key entity_id on an
    // rfq_product id and carry the real round id in metadata. The old
    // getPendingNegotiationRfqIds joined nr.id = i.entity_id and dropped every
    // one of them — including all the currently-PENDING ones, which is why the
    // toggle was permanently empty. PENDING_LEGACY reproduces that shape.
    // REMOVED_APPROVER covers the second defect: no removed_at check.
    const existingPolicy = await db.oneOrNone(`SELECT id FROM tbl_approval_policies ORDER BY id LIMIT 1`);
    if (existingPolicy) {
      policyId = Number(existingPolicy.id);
    } else {
      await db.none(
        `INSERT INTO tbl_approval_policies
           (id, entity_type, hospitality_company_id, hotel_id, department_id,
            is_active, created_by, process_id, is_master, is_department_scoped, version)
         VALUES ($1, 'NEGOTIATION', $2, $3, NULL, true, $4, $5, false, false, 1)`,
        [OWN_POLICY_ID, HC_A, A1, IDS.users.superAdmin, PROCESS]
      );
      policyId = OWN_POLICY_ID;
      ownedPolicy = true;
    }

    // `endDate` defaults to the FUTURE. It used to be PAST(1), which made this
    // fixture accidentally identical to the stale shape below — a round whose
    // vendor window has closed but whose approval instance was never
    // cancelled. Approving such a round would publish it to vendors who can no
    // longer answer, so the flag now excludes them. These two fixtures guard
    // the metadata-shape resolution and the removed-approver rule, both of
    // which are orthogonal to the deadline.
    const seedPendingApproval = async (key, { removed, endDate = D(5) }) => {
      await seedRfq(key, { hc: HC_A, hotel: A1, dept: PROC, title: key });
      const roundId = await addRound(key, {
        status: "ENDED", endDate, withQuote: true, createdAgoDays: 2,
      });
      const inst = await db.one(
        `INSERT INTO tbl_approval_instances
           (entity_type, entity_id, approval_policy_id, status, current_step,
            initiated_by, hospitality_company_id, hotel_id, department_id, metadata)
         VALUES ('NEGOTIATION', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7::jsonb)
         RETURNING id`,
        [
          rfq[key].productId, // LEGACY: an rfq_product id, not a round id
          policyId,
          IDS.users.superAdmin,
          HC_A, A1, PROC,
          JSON.stringify({ round_id: roundId, rfq_id: rfq[key].id }),
        ]
      );
      instanceIds.push(Number(inst.id));
      const step = await db.one(
        `INSERT INTO tbl_approval_instance_steps
           (approval_instance_id, step_order, decision_rule, status)
         VALUES ($1, 1, 'ALL', 'PENDING') RETURNING id`,
        [Number(inst.id)]
      );
      await db.none(
        `INSERT INTO tbl_approval_step_approvers
           (approval_instance_step_id, approver_user_id, status, removed_at)
         VALUES ($1, $2, 'PENDING', $3)`,
        [Number(step.id), U_A, removed ? new Date().toISOString() : null]
      );
    };
    await seedPendingApproval("PENDING_LEGACY", { removed: false });
    await seedPendingApproval("REMOVED_APPROVER", { removed: true });
    // The stale shape: PENDING approval on a round whose window closed. Six of
    // these leaked into production in March 2026 when the deadline cron ended
    // the round without cancelling its instance.
    await seedPendingApproval("STALE_APPROVAL", { removed: false, endDate: PAST(1) });

    clientA = await httpClient(U_A);
    clientA1 = await httpClient(U_A1);
    clientB = await httpClient(U_B);
  });

  afterAll(async () => {
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    if (ownedPolicy) await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [OWN_POLICY_ID]);
    const allRounds = [...Object.values(rounds).flat(), ...arcRoundIds].filter(Boolean);
    if (allRounds.length) {
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [allRounds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [allRounds]);
    }
    if (arcItemId) await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [arcItemId]);
    if (arcId) {
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    }
    const rfqIds = Object.values(rfq).map((r) => r.id);
    if (rfqIds.length) {
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
    }
    const users = [U_A, U_A1, U_B];
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [users]);
  });

  const listView = (client, body = {}) =>
    client.post("/api/v1/negotiation/list-view").send({ limit: 200, ...body });

  const keysOf = (res) => res.body.data.rows.map((r) => String(r.parent_key));
  const rowFor = (res, key) =>
    res.body.data.rows.find((r) => String(r.parent_key) === `RFQ:${rfq[key].id}`);

  // ── 1. One row per RFQ ────────────────────────────────────────────────────
  test("an RFQ with 3 rounds in 3 states collapses to exactly ONE row", async () => {
    const res = await listView(clientA);
    expect(res.status).toBe(200);
    expect(res.body.data.group_by).toBe("parent");

    const mine = keysOf(res).filter((k) => k === `RFQ:${rfq.MULTI.id}`);
    expect(mine).toHaveLength(1);

    const row = rowFor(res, "MULTI");
    expect(Number(row.round_count)).toBe(3);
    expect(Number(row.rfq_id)).toBe(rfq.MULTI.id);
    expect(row.source_type).toBe("RFQ");
    expect(row.state_counts).toEqual({
      awaiting_approval: 0,
      open_with_vendors: 0,
      ready_for_decision: 1,
      no_vendor_response: 1,
      concluded: 0,
      lapsed: 0,
      cancelled: 1,
    });
    // Only the product actually negotiated, and the invited vendor.
    expect(Number(row.product_count)).toBe(1);
    expect(Number(row.vendor_count)).toBe(1);
    expect(row.vendors.map((v) => Number(v.id))).toContain(VENDOR);
    expect(row.first_round_at).toBeTruthy();
    expect(row.last_activity_at).toBeTruthy();
    expect(new Date(row.last_activity_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row.first_round_at).getTime()
    );
  });

  // ── 2. The roll-up ladder ─────────────────────────────────────────────────
  test("roll-up {cancelled, no_vendor_response, ready_for_decision} → ready_for_decision", async () => {
    const res = await listView(clientA);
    expect(rowFor(res, "MULTI").neg_status).toBe("ready_for_decision");
  });

  test("roll-up {no_vendor_response, concluded} → concluded (NOT the round-level order)", async () => {
    const res = await listView(clientA);
    const row = rowFor(res, "CONCLUDED");
    expect(row.neg_status).toBe("concluded");
    // Both states really are present — the roll-up is choosing, not guessing.
    expect(row.state_counts.no_vendor_response).toBe(1);
    expect(row.state_counts.concluded).toBe(1);
  });

  test("roll-up {concluded, ready_for_decision} → ready_for_decision (action beats history)", async () => {
    const res = await listView(clientA);
    const row = rowFor(res, "READY");
    expect(row.neg_status).toBe("ready_for_decision");
    expect(Number(row.ready_for_decision_count)).toBe(1);
  });

  test("roll-up {concluded, open_with_vendors} → open_with_vendors, and next_deadline is set", async () => {
    const res = await listView(clientA);
    const row = rowFor(res, "OPEN");
    expect(row.neg_status).toBe("open_with_vendors");
    expect(Number(row.open_with_vendors_count)).toBe(1);
    // The one still-future window close.
    expect(row.next_deadline).toBeTruthy();
    expect(new Date(row.next_deadline).getTime()).toBeGreaterThan(Date.now());
  });

  // ── 3. Tabs partition the rows ────────────────────────────────────────────
  test("tab_counts sum to the total — no row in two tabs, none missing", async () => {
    const res = await listView(clientA);
    const { tab_counts, total, rows } = res.body.data;
    const STATES = [
      "awaiting_approval", "open_with_vendors", "ready_for_decision",
      "no_vendor_response", "concluded", "lapsed", "cancelled",
    ];
    const sum = STATES.reduce((n, k) => n + Number(tab_counts[k] || 0), 0);
    expect(sum).toBe(tab_counts.all);
    expect(tab_counts.all).toBe(total);
    expect(total).toBe(rows.length);

    // And every returned row's status is one of the seven.
    for (const r of rows) expect(STATES).toContain(r.neg_status);
  });

  test("filtering to a status tab returns exactly that tab's count", async () => {
    const all = await listView(clientA);
    const want = Number(all.body.data.tab_counts.ready_for_decision);
    const tabbed = await listView(clientA, { tab: "ready_for_decision" });
    expect(tabbed.body.data.total).toBe(want);
    for (const r of tabbed.body.data.rows) expect(r.neg_status).toBe("ready_for_decision");
    expect(keysOf(tabbed)).toContain(`RFQ:${rfq.MULTI.id}`);
    expect(keysOf(tabbed)).not.toContain(`RFQ:${rfq.CONCLUDED.id}`);
  });

  // ── 4. SCOPE at the parent grain ──────────────────────────────────────────
  test("cross-TENANT: company B's parent never appears for a company A user", async () => {
    const a = await listView(clientA);
    expect(keysOf(a)).not.toContain(`RFQ:${rfq.FOREIGN.id}`);

    // The row genuinely exists — B sees it.
    const b = await listView(clientB);
    expect(keysOf(b)).toContain(`RFQ:${rfq.FOREIGN.id}`);
    expect(keysOf(b)).not.toContain(`RFQ:${rfq.MULTI.id}`);
  });

  test("cross-HOTEL: an A1-scoped user never sees the A2 parent of their own company", async () => {
    const res = await listView(clientA1);
    expect(keysOf(res)).toContain(`RFQ:${rfq.MULTI.id}`);
    expect(keysOf(res)).not.toContain(`RFQ:${rfq.A2.id}`);
    expect(keysOf(res)).not.toContain(`RFQ:${rfq.FOREIGN.id}`);
    for (const r of res.body.data.rows) expect(Number(r.hotel_id)).toBe(A1);

    // Derived surfaces inherit the same scope.
    const buIds = (res.body.data.facets.buId || []).map((x) => String(x.key));
    expect(new Set(buIds)).toEqual(new Set([String(A1)]));
    expect(res.body.data.tab_counts.all).toBe(res.body.data.rows.length);
  });

  // ── 5. Narrowing filters, never lookup keys ───────────────────────────────
  test("filters.rfqId narrows to one parent (and still works verbatim)", async () => {
    const res = await listView(clientA, { filters: { rfqId: [String(rfq.MULTI.id)] } });
    expect(res.status).toBe(200);
    expect(keysOf(res)).toEqual([`RFQ:${rfq.MULTI.id}`]);
    expect(res.body.data.total).toBe(1);
  });

  test("filters.parentKey narrows to one parent", async () => {
    const res = await listView(clientA, { filters: { parentKey: [`RFQ:${rfq.CONCLUDED.id}`] } });
    expect(res.status).toBe(200);
    expect(keysOf(res)).toEqual([`RFQ:${rfq.CONCLUDED.id}`]);
    expect(res.body.data.total).toBe(1);
  });

  test("an OUT-OF-SCOPE rfqId / parentKey yields an EMPTY PAGE — not a 403, not data", async () => {
    for (const body of [
      { filters: { rfqId: [String(rfq.FOREIGN.id)] } },
      { filters: { parentKey: [`RFQ:${rfq.FOREIGN.id}`] } },
      { filters: { rfqId: [String(rfq.A2.id)] } },
    ]) {
      const res = await listView(clientA1, body);
      expect(res.status).toBe(200);
      expect(res.body.data.rows).toHaveLength(0);
      expect(res.body.data.total).toBe(0);
    }
  });

  test("filters.rfqId can never select an ARC parent — that is what parentKey is for", async () => {
    // ARC rows carry rfq_id = NULL, so no rfqId value can match one.
    const byRfqId = await listView(clientA, { filters: { rfqId: [String(arcId)] }, source: "ARC" });
    expect(byRfqId.status).toBe(200);
    expect(byRfqId.body.data.total).toBe(0);

    const byParentKey = await listView(clientA, { filters: { parentKey: [`ARC:${arcId}`] } });
    expect(byParentKey.status).toBe(200);
    expect(keysOf(byParentKey)).toEqual([`ARC:${arcId}`]);
  });

  // ── 6. The ARC parent ─────────────────────────────────────────────────────
  test("an ARC parent appears with parent_key 'ARC:<id>', rfq_id NULL and its rounds grouped", async () => {
    const res = await listView(clientA);
    expect(res.status).toBe(200);
    const row = res.body.data.rows.find((r) => String(r.parent_key) === `ARC:${arcId}`);
    expect(row).toBeDefined();
    expect(row.source_type).toBe("ARC");
    expect(row.rfq_id).toBeNull();
    expect(Number(row.arc_id)).toBe(arcId);
    expect(row.arc_number).toBe(`${PFX}ARC-4410`);
    expect(Number(row.round_count)).toBe(2);
    // ENDED with no quotes + ACTIVE in-window → open_with_vendors wins.
    expect(row.neg_status).toBe("open_with_vendors");
    expect(res.body.data.source_counts.all).toBe(
      res.body.data.source_counts.RFQ + res.body.data.source_counts.ARC
    );
  });

  // ── 7. groupBy:'round' is the historic shape, unchanged ───────────────────
  test("groupBy:'round' returns one row per ROUND with the historic column set", async () => {
    const res = await listView(clientA, { groupBy: "round" });
    expect(res.status).toBe(200);
    expect(res.body.data.group_by).toBe("round");

    const mine = res.body.data.rows.filter((r) => Number(r.rfq_id) === rfq.MULTI.id);
    expect(mine).toHaveLength(3);
    expect(mine.map((r) => Number(r.round_id)).sort()).toEqual([...rounds.MULTI].sort());

    // The exact key set the round grain has always returned: the model's SELECT
    // list plus the four fields the controller stamps. No parent-only field
    // (parent_key, round_count, state_counts, saved_value, …) may leak in.
    const HISTORIC_KEYS = [
      "round_id", "round_number", "stored_round_number", "round_created_at",
      "total_rounds", "rounds_on_parent", "rounds_on_products",
      "rfq_id", "rfq_no", "title", "is_tender",
      "hotel_id", "hotel_name", "department_id", "department_title",
      "round_status", "end_date", "approved_at", "published_at", "closed_at",
      "invited_count", "neg_status", "has_approved_quote", "quotes_received",
      "item_names", "vendors", "source_type", "arc_id", "arc_number",
      "_bucket", "_isMyAction", "action_required", "action_label",
    ].sort();
    expect(Object.keys(mine[0]).sort()).toEqual(HISTORIC_KEYS);

    // Per-round states, not a roll-up.
    expect(mine.map((r) => r.neg_status).sort()).toEqual(
      ["cancelled", "no_vendor_response", "ready_for_decision"].sort()
    );
  });

  test("groupBy:'round' keeps its own scope — no widening via the grain switch", async () => {
    const res = await listView(clientA1, { groupBy: "round" });
    expect(res.status).toBe(200);
    const rfqIds = res.body.data.rows.map((r) => Number(r.rfq_id));
    expect(rfqIds).not.toContain(rfq.A2.id);
    expect(rfqIds).not.toContain(rfq.FOREIGN.id);
  });

  // ── 8. Sorts ──────────────────────────────────────────────────────────────
  test("sort='rounds' orders parents by round_count descending", async () => {
    const res = await listView(clientA, { sort: "rounds" });
    expect(res.status).toBe(200);
    const counts = res.body.data.rows.map((r) => Number(r.round_count));
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const keys = keysOf(res);
    // MULTI (3 rounds) must precede READY (2) and A2 (1).
    expect(keys.indexOf(`RFQ:${rfq.MULTI.id}`)).toBeLessThan(keys.indexOf(`RFQ:${rfq.READY.id}`));
    expect(keys.indexOf(`RFQ:${rfq.READY.id}`)).toBeLessThan(keys.indexOf(`RFQ:${rfq.A2.id}`));
  });

  test("sort='status' uses the PARENT order — an action row outranks a concluded one", async () => {
    const res = await listView(clientA, { sort: "status" });
    expect(res.status).toBe(200);
    const keys = keysOf(res);
    // OPEN (open_with_vendors, rung 1) before CONCLUDED (concluded, rung 3).
    expect(keys.indexOf(`RFQ:${rfq.OPEN.id}`)).toBeLessThan(keys.indexOf(`RFQ:${rfq.CONCLUDED.id}`));
    // READY (ready_for_decision, rung 2) also before CONCLUDED — under the
    // round-level NEG_STATE_ORDER concluded sorts before no_vendor_response,
    // which is the ordering this constant deliberately does not inherit.
    expect(keys.indexOf(`RFQ:${rfq.READY.id}`)).toBeLessThan(keys.indexOf(`RFQ:${rfq.CONCLUDED.id}`));
  });

  // ── 9. Search runs BEFORE the badges ──────────────────────────────────────
  test("search narrows the rows AND the tab badges together", async () => {
    const res = await listView(clientA, { search: `#${rfq.MULTI.no}` });
    expect(res.status).toBe(200);
    expect(keysOf(res)).toEqual([`RFQ:${rfq.MULTI.id}`]);
    // The badges describe what is on screen, not an unsearched total.
    expect(res.body.data.tab_counts.all).toBe(1);
    expect(res.body.data.tab_counts.ready_for_decision).toBe(1);
    expect(res.body.data.tab_counts.concluded).toBe(0);
    // Facets too.
    expect((res.body.data.facets.rfqId || []).map((x) => String(x.key))).toEqual([
      String(rfq.MULTI.id),
    ]);
  });

  // ── 10. "Pending for me" at the parent grain ──────────────────────────────
  test("a LEGACY-shaped approval instance still marks its parent as needing my action", async () => {
    const res = await listView(clientA);
    expect(res.status).toBe(200);
    const row = res.body.data.rows.find(
      (r) => String(r.parent_key) === `RFQ:${rfq.PENDING_LEGACY.id}`
    );
    expect(row).toBeDefined();
    // The instance keys entity_id on an rfq_product id with the round id in
    // metadata — the shape the old query dropped, leaving this toggle at 0.
    expect(row.action_required).toBe(true);
    expect(row.action_label).toBe("Approval needed");

    const forMe = await listView(clientA, { tab: "for_me" });
    expect(forMe.status).toBe(200);
    expect(forMe.body.data.rows.map((r) => String(r.parent_key)))
      .toContain(`RFQ:${rfq.PENDING_LEGACY.id}`);
    expect(forMe.body.data.tab_counts.for_me).toBeGreaterThan(0);
  });

  test("a REMOVED approver does not keep a parent pending", async () => {
    const res = await listView(clientA);
    const row = res.body.data.rows.find(
      (r) => String(r.parent_key) === `RFQ:${rfq.REMOVED_APPROVER.id}`
    );
    expect(row).toBeDefined();
    expect(row.action_required).toBe(false);

    const forMe = await listView(clientA, { tab: "for_me" });
    expect(forMe.body.data.rows.map((r) => String(r.parent_key)))
      .not.toContain(`RFQ:${rfq.REMOVED_APPROVER.id}`);
  });

  test("a PENDING approval on a round whose window has closed does NOT need my action", async () => {
    // The approve page filters `end_date > now`, so without the same condition
    // here the row renders "Approval needed" and then lands the approver on
    // "No rounds awaiting your approval". Six production instances did exactly
    // that for five months.
    const res = await listView(clientA);
    const row = res.body.data.rows.find(
      (r) => String(r.parent_key) === `RFQ:${rfq.STALE_APPROVAL.id}`
    );
    expect(row).toBeDefined();
    expect(row.action_required).toBe(false);
    expect(row.action_label).toBeNull();

    const forMe = await listView(clientA, { tab: "for_me" });
    expect(forMe.body.data.rows.map((r) => String(r.parent_key)))
      .not.toContain(`RFQ:${rfq.STALE_APPROVAL.id}`);
  });

  test("the deadline rule applies at ROUND grain too, not just parent", async () => {
    // The round grain is what drives action_required on the rounds table, and
    // therefore where a row routes — to the approve page or the read-only round
    // page. Parent-grain coverage alone would leave the headline fix untested
    // on the exact path the UI uses.
    const res = await listView(clientA, { groupBy: "round", limit: 200 });
    expect(res.status).toBe(200);

    const rows = res.body.data.rows || [];
    const staleRoundIds = new Set(rounds.STALE_APPROVAL.map(Number));
    const stale = rows.filter((r) => staleRoundIds.has(Number(r.round_id)));

    expect(stale.length).toBeGreaterThan(0);
    for (const r of stale) {
      expect(r.action_required).toBe(false);
      expect(r.action_label).toBeNull();
    }

    // …while the open-window round on the same fixture family still is flagged.
    const liveRoundIds = new Set(rounds.PENDING_LEGACY.map(Number));
    const live = rows.filter((r) => liveRoundIds.has(Number(r.round_id)));
    expect(live.length).toBeGreaterThan(0);
    for (const r of live) expect(r.action_required).toBe(true);
  });

  test("needs_attention and closed partition the set", async () => {
    const res = await listView(clientA);
    const c = res.body.data.tab_counts;

    expect(c.needs_attention).toEqual(expect.any(Number));
    expect(c.closed).toEqual(expect.any(Number));
    expect(c.needs_attention + c.closed).toBe(c.all);
    // The groups are exactly the action states and their complement.
    expect(c.needs_attention).toBe(c.awaiting_approval + c.open_with_vendors + c.ready_for_decision);
    expect(c.closed).toBe(c.concluded + c.no_vendor_response + c.lapsed + c.cancelled);
  });

  test("the seven per-state counts still sum to all", async () => {
    const c = (await listView(clientA)).body.data.tab_counts;
    const seven = ["awaiting_approval", "open_with_vendors", "ready_for_decision",
                   "concluded", "no_vendor_response", "lapsed", "cancelled"];
    expect(seven.reduce((n, k) => n + Number(c[k] || 0), 0)).toBe(c.all);
  });

  test("selecting a group returns exactly its rows", async () => {
    const c = (await listView(clientA)).body.data.tab_counts;
    const res = await listView(clientA, { tab: "needs_attention", limit: 100 });

    expect(res.body.data.total).toBe(c.needs_attention);
    for (const r of res.body.data.rows) {
      expect(["awaiting_approval", "open_with_vendors", "ready_for_decision"]).toContain(r.neg_status);
    }
  });

  test("a group tab composes with the status facet", async () => {
    const res = await listView(clientA, {
      tab: "closed", filters: { status: ["cancelled"] }, limit: 100,
    });
    for (const r of res.body.data.rows) expect(r.neg_status).toBe("cancelled");
  });

  test("needsMyApproval composes with a status tab rather than replacing it", async () => {
    const res = await listView(clientA, { tab: "ready_for_decision", needsMyApproval: true });
    expect(res.status).toBe(200);
    for (const r of res.body.data.rows) {
      expect(r.neg_status).toBe("ready_for_decision");
      expect(r.action_required).toBe(true);
    }
    expect(res.body.data.rows.map((r) => String(r.parent_key)))
      .toContain(`RFQ:${rfq.PENDING_LEGACY.id}`);
  });

  test("search still cannot reach outside the RBAC row set", async () => {
    const res = await listView(clientA, { search: `#${rfq.FOREIGN.no}` });
    expect(res.status).toBe(200);
    expect(keysOf(res)).not.toContain(`RFQ:${rfq.FOREIGN.id}`);
    expect(res.body.data.total).toBe(0);
  });
});
