/**
 * getApprovalInstanceDetailsBatch ≡ getApprovalInstanceDetails, per instance.
 *
 * The batched reader exists so pages that render many instances (the RFQ
 * lifecycle) stop paying 1 + 1 + steps + 1 round trips per instance. It is
 * shared with ARC through generalModel, so it must not lose anything the single
 * reader returns — above all REMOVED / tombstoned approvers, which every
 * approval panel renders with their removal reason.
 *
 * The one intended difference is ORDER of approvers within a step: the single
 * reader's approver query has no ORDER BY, so its order is whatever plan the
 * planner picks (hash join vs index nested loop, and it moves when a row is
 * UPDATEd). The batch pins insertion order (approver row id). Approvers are
 * therefore compared as a set here; everything else must be identical.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  getApprovalInstanceDetails,
  getApprovalInstanceDetailsBatch,
} from "../../app/models/generalModel.js";
import { seedRichRfq, cleanupRichRfq } from "../helpers/perfRichRfq.js";
import { countQueries } from "../helpers/queryCounter.js";

const BUYER = IDS.users.a1_proc_buyer;

const canonical = (d) => ({
  ...d,
  steps: d.steps.map((s) => ({
    ...s,
    approvers: [...s.approvers].sort(
      (a, b) => a.user_id - b.user_id || String(a.status).localeCompare(String(b.status))
    ),
  })),
});

describe("getApprovalInstanceDetailsBatch", () => {
  let made;

  beforeAll(async () => {
    made = await seedRichRfq({ buyer: BUYER });
  });

  afterAll(async () => {
    await cleanupRichRfq(made);
  });

  it.each([
    ["the requesting buyer (a current-step approver on one instance)", BUYER],
    ["a user who approves nothing", IDS.users.a1_eng_buyer],
    ["no user", null],
  ])("returns what the single-instance reader returns, for %s", async (_label, userId) => {
    const batch = await getApprovalInstanceDetailsBatch(made.instanceIds, userId);
    expect([...batch.keys()].sort()).toEqual([...made.instanceIds].map(Number).sort());
    for (const id of made.instanceIds) {
      const single = await getApprovalInstanceDetails(id, userId);
      expect(canonical(batch.get(Number(id)))).toEqual(canonical(single));
    }
  });

  it("keeps REMOVED tombstones with their removal reason and timestamp", async () => {
    const batch = await getApprovalInstanceDetailsBatch(made.instanceIds, BUYER);
    const tombstones = [...batch.values()]
      .flatMap((d) => d.steps.flatMap((s) => s.approvers))
      .filter((a) => a.status === "REMOVED");
    expect(tombstones.length).toBe(3);
    for (const t of tombstones) {
      expect(t.removed_at).toBeTruthy();
      expect(t.removal_reason).toEqual(expect.any(String));
    }
  });

  it("grants can_user_approve only on the instance whose CURRENT step names the user", async () => {
    const batch = await getApprovalInstanceDetailsBatch(made.instanceIds, BUYER);
    const approvable = [...batch.values()].filter((d) => d.can_user_approve);
    expect(approvable).toHaveLength(1);
    expect(approvable[0].entity_type).toBe("NEGOTIATION_QUOTE");
    expect(approvable[0].status).toBe("PENDING");
    const current = approvable[0].steps.find((s) => s.step_order === approvable[0].current_step);
    expect(approvable[0].user_approval_step_id).toBe(current.id);
  });

  it("omits ids that do not exist instead of failing the batch", async () => {
    const batch = await getApprovalInstanceDetailsBatch([made.instanceIds[0], 2147480000], BUYER);
    expect([...batch.keys()]).toEqual([Number(made.instanceIds[0])]);
  });

  it("costs 4 statements in 2 serial round trips for any number of instances", async () => {
    const { count, depth } = await countQueries(() =>
      getApprovalInstanceDetailsBatch(made.instanceIds, BUYER)
    );
    expect(made.instanceIds.length).toBe(6);
    expect(count).toBe(4);
    expect(depth).toBe(2);
  });
});
