// Wave-style integration test for the Technical Approver dashboard widgets.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  makeApprovalInstanceWithApprover,
  cleanupApprovalInstances,
} from "../helpers/dashboardSeed.js";

const inserted = { rfqIds: [] };
const seeded = {};

beforeAll(async () => {
  await db.tx(async (t) => {
    // Three pending TECHNICAL approvals on a1_proc_techApp, with
    // staggered created_at ages so oldest-first ordering is testable.
    const r1 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Tech-approval RFQ 10d old",
    });
    const inst10d = await makeApprovalInstanceWithApprover(t, {
      entity_type: "TECHNICAL",
      entity_id: r1.rfq_id,
      approver_user_id: IDS.users.a1_proc_techApp,
      policy_id: IDS.policies.A1_P1_TECHNICAL,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
      created_ago_hours: 24 * 10, // 10 days old → goes to top of "oldest"
    });

    const r2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Tech-approval RFQ 3d old",
    });
    const inst3d = await makeApprovalInstanceWithApprover(t, {
      entity_type: "TECHNICAL",
      entity_id: r2.rfq_id,
      approver_user_id: IDS.users.a1_proc_techApp,
      policy_id: IDS.policies.A1_P1_TECHNICAL,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
      created_ago_hours: 24 * 3,
    });

    const r3 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Tech-approval RFQ fresh",
    });
    const instFresh = await makeApprovalInstanceWithApprover(t, {
      entity_type: "TECHNICAL",
      entity_id: r3.rfq_id,
      approver_user_id: IDS.users.a1_proc_techApp,
      policy_id: IDS.policies.A1_P1_TECHNICAL,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
      created_ago_hours: 1, // an hour ago
    });

    // Completed approvals — feed the throughput widget. Two cleared
    // approvals in the last 30 days: one took 12 hours, another took 36.
    // Their average is 24 hours; the prior-period bucket stays empty.
    const r4 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Completed approval 12h",
    });
    await makeApprovalInstanceWithApprover(t, {
      entity_type: "TECHNICAL",
      entity_id: r4.rfq_id,
      approver_user_id: IDS.users.a1_proc_techApp,
      policy_id: IDS.policies.A1_P1_TECHNICAL,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
      instance_status: "APPROVED",
      approver_status: "APPROVED",
      created_ago_hours: 12 + 2,  // created 14h ago
      acted_ago_hours: 2,         // approved 2h ago → turnaround = 12h
    });
    const r5 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Completed approval 36h",
    });
    await makeApprovalInstanceWithApprover(t, {
      entity_type: "TECHNICAL",
      entity_id: r5.rfq_id,
      approver_user_id: IDS.users.a1_proc_techApp,
      policy_id: IDS.policies.A1_P1_TECHNICAL,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
      instance_status: "APPROVED",
      approver_status: "APPROVED",
      created_ago_hours: 36 + 5,  // created 41h ago
      acted_ago_hours: 5,         // approved 5h ago → turnaround = 36h
    });

    // Pending approval but for ANOTHER user — must NOT appear in techApp's queue.
    const r6 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1, is_published: 1,
      title: "Pending on someone else",
    });
    await makeApprovalInstanceWithApprover(t, {
      entity_type: "TECHNICAL",
      entity_id: r6.rfq_id,
      approver_user_id: IDS.users.a1_proc_commApp, // different user!
      policy_id: IDS.policies.A1_P1_TECHNICAL,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
      created_ago_hours: 2,
    });

    // PENDING approval at Hotel A2 — must NOT appear when filtering to A1.
    const r7 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A2,
      status: 1, is_published: 1,
      title: "Pending in A2",
    });
    await makeApprovalInstanceWithApprover(t, {
      entity_type: "TECHNICAL",
      entity_id: r7.rfq_id,
      approver_user_id: IDS.users.a1_proc_techApp,
      policy_id: IDS.policies.A1_P1_TECHNICAL,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A2,
      initiated_by: IDS.users.a1_proc_buyer,
      created_ago_hours: 6,
    });

    seeded.inst10d = inst10d.instance_id;
    seeded.inst3d = inst3d.instance_id;
    seeded.instFresh = instFresh.instance_id;
    seeded.r4 = r4.rfq_id;
    seeded.r5 = r5.rfq_id;
    seeded.r6 = r6.rfq_id;
    seeded.r7 = r7.rfq_id;
    inserted.rfqIds = [
      r1.rfq_id, r2.rfq_id, r3.rfq_id, r4.rfq_id, r5.rfq_id, r6.rfq_id, r7.rfq_id,
    ];
  });
});

afterAll(async () => {
  await cleanupApprovalInstances(db, "TECHNICAL", inserted.rfqIds);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

describe("Buyer Dashboard — Technical Approver widgets (real data)", () => {
  /* ────────── /my-tech-approvals-pending ───────── */

  it("returns the 3 PENDING TECHNICAL approvals where techApp is the current approver", async () => {
    const client = await httpClient(IDS.users.a1_proc_techApp);
    const res = await client
      .get("/api/v1/dashboard-v2/my-tech-approvals-pending")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.count).toBe(3);

    const instanceIds = res.body.data.items.map((i) => i.id).sort();
    expect(instanceIds).toEqual(
      [seeded.inst10d, seeded.inst3d, seeded.instFresh].sort()
    );
  });

  /* ────────── /tech-approval-oldest-pending ───────── */

  it("returns oldest-first with accurate age_days", async () => {
    const client = await httpClient(IDS.users.a1_proc_techApp);
    const res = await client
      .get("/api/v1/dashboard-v2/tech-approval-oldest-pending")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(3);

    // ASC by created_at → oldest first.
    expect(res.body.data.items[0].id).toBe(seeded.inst10d);
    expect(res.body.data.items[0].age_days).toBe(10);

    expect(res.body.data.items[1].id).toBe(seeded.inst3d);
    expect(res.body.data.items[1].age_days).toBe(3);

    expect(res.body.data.items[2].id).toBe(seeded.instFresh);
    expect(res.body.data.items[2].age_days).toBe(0); // <1d → floors to 0
  });

  /* ────────── /tech-approval-throughput ───────── */

  it("computes accurate avg-hours from completed approvals", async () => {
    const client = await httpClient(IDS.users.a1_proc_techApp);
    const res = await client
      .get("/api/v1/dashboard-v2/tech-approval-throughput")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.unit).toBe("hrs");
    expect(Array.isArray(res.body.data.sparkline)).toBe(true);

    // Seeded turnarounds: 12h + 36h → avg 24h. Allow small drift from
    // INSERT timing.
    expect(res.body.data.current_period_avg_hours).toBeGreaterThan(23.9);
    expect(res.body.data.current_period_avg_hours).toBeLessThan(24.1);

    // No data in the prior 30-day bucket.
    expect(res.body.data.prior_period_avg_hours).toBeNull();
    expect(res.body.data.delta_pct).toBeNull();
  });

  /* ────────── Scope isolation ───────── */

  it("does not include approvals where techApp isn't the current approver", async () => {
    const client = await httpClient(IDS.users.a1_proc_techApp);
    const res = await client
      .get("/api/v1/dashboard-v2/my-tech-approvals-pending")
      .query({ hotel_ids: String(IDS.hotels.A1) });
    const instanceIds = res.body.data.items.map((i) => i.id);
    // r6's instance is on commApp — should not surface.
    expect(instanceIds.every((id) => [seeded.inst10d, seeded.inst3d, seeded.instFresh].includes(id))).toBe(true);
  });

  it("respects BU scope — A1 filter excludes A2 approvals", async () => {
    const client = await httpClient(IDS.users.a1_proc_techApp);
    const res = await client
      .get("/api/v1/dashboard-v2/my-tech-approvals-pending")
      .query({ hotel_ids: String(IDS.hotels.A1) });
    // r7's approval is at A2 — should NOT be in count.
    expect(res.body.data.count).toBe(3);
  });
});
