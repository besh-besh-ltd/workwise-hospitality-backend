// Group ARC — which approval workflow governs a rate contract.
//
// A group rate contract is approved by one group committee (PRD §9), through
// its OWN workflow that the company admin sets up once: policy entity types
// ARC_GROUP (publish + default) and optional ARC_GROUP_TECH / _NEGOTIATION /
// _COMMITTEE / _AMENDMENT overrides, usually company-wide (hotel_id NULL).
//
// The two families never mix: a group ARC must not fall back to a single
// hotel's ARC workflow, and a single-hotel ARC must never pick up the group
// one. Approval INSTANCES keep their existing types (ARC_PUBLISH, ARC_TECH, …);
// only the policy lookup changes.

import { db, withTx } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { resolveArcPolicyFor } from "../../../app/helper/arc_v2/arcPolicy.js";

const HC_A = IDS.hospitality.A;
const A3 = IDS.hotels.A3;
const BUYER = IDS.users.a1_proc_buyer;

const singleArc = { is_group: false, hospitality_company_id: HC_A, hotel_id: A3, department_id: IDS.departments.proc, process_id: null };
const groupArc = { ...singleArc, is_group: true };

async function insertPolicy(t, { entityType, hotelId }) {
  const row = await t.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by,
        process_id, is_master, is_department_scoped, version)
     VALUES ($1, $2, $3, NULL, true, $4, NULL, true, false, 1)
     RETURNING id`,
    [entityType, HC_A, hotelId, BUYER]
  );
  return Number(row.id);
}

describe("resolveArcPolicyFor — group and single ARC workflows stay separate", () => {
  test("a single-hotel ARC resolves its stage policy, falling back to the base ARC policy", async () => {
    await withTx(async (t) => {
      const base = await insertPolicy(t, { entityType: "ARC", hotelId: A3 });
      expect(Number((await resolveArcPolicyFor(singleArc, "ARC", t)).id)).toBe(base);
      expect(Number((await resolveArcPolicyFor(singleArc, "ARC_TECH", t)).id)).toBe(base);
      const tech = await insertPolicy(t, { entityType: "ARC_TECH", hotelId: A3 });
      expect(Number((await resolveArcPolicyFor(singleArc, "ARC_TECH", t)).id)).toBe(tech);
    });
  });

  test("a group ARC never falls back to a single hotel's ARC workflow", async () => {
    await withTx(async (t) => {
      await insertPolicy(t, { entityType: "ARC", hotelId: A3 });
      await insertPolicy(t, { entityType: "ARC_COMMITTEE", hotelId: A3 });
      expect(await resolveArcPolicyFor(groupArc, "ARC", t)).toBeNull();
      expect(await resolveArcPolicyFor(groupArc, "ARC_COMMITTEE", t)).toBeNull();
    });
  });

  test("a group ARC resolves the company-wide group workflow for every stage", async () => {
    await withTx(async (t) => {
      const groupBase = await insertPolicy(t, { entityType: "ARC_GROUP", hotelId: null });
      for (const stage of ["ARC", "ARC_TECH", "ARC_NEGOTIATION", "ARC_COMMITTEE", "ARC_AMENDMENT"]) {
        expect(Number((await resolveArcPolicyFor(groupArc, stage, t)).id)).toBe(groupBase);
      }
    });
  });

  test("a group stage override wins over the group base workflow", async () => {
    await withTx(async (t) => {
      await insertPolicy(t, { entityType: "ARC_GROUP", hotelId: null });
      const committee = await insertPolicy(t, { entityType: "ARC_GROUP_COMMITTEE", hotelId: null });
      expect(Number((await resolveArcPolicyFor(groupArc, "ARC_COMMITTEE", t)).id)).toBe(committee);
    });
  });

  test("a single-hotel ARC never picks up the group workflow", async () => {
    await withTx(async (t) => {
      await insertPolicy(t, { entityType: "ARC_GROUP", hotelId: null });
      expect(await resolveArcPolicyFor(singleArc, "ARC", t)).toBeNull();
    });
  });

  test("an unknown stage is refused rather than silently matched", async () => {
    await withTx(async (t) => {
      await expect(resolveArcPolicyFor(groupArc, "RFQ", t)).rejects.toThrow(/stage/i);
    });
  });
});

describe("POST /general/hospitality/approval/policies — group workflow types", () => {
  const ADMIN = IDS.users.a1_proc_buyer;
  const created = [];
  let userTypeBefore;
  let client;

  beforeAll(async () => {
    userTypeBefore = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [ADMIN])).user_type;
    await db.none(`UPDATE tbl_users SET user_type = 7, status = 1 WHERE id = $1`, [ADMIN]);
    client = await httpClient(ADMIN);
  });

  afterAll(async () => {
    if (created.length) {
      await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [created]);
      await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [created]);
    }
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [ADMIN, userTypeBefore]);
  });

  test.each(["ARC_GROUP", "ARC_GROUP_TECH", "ARC_GROUP_NEGOTIATION", "ARC_GROUP_COMMITTEE", "ARC_GROUP_AMENDMENT"])(
    "the admin can save a company-wide %s workflow stage",
    async (entityType) => {
      const res = await client.post("/api/v1/general/hospitality/approval/policies").send({
        entity_type: entityType,
        hospitality_company_id: HC_A,
        hotel_id: null,
        department_id: null,
        process_id: IDS.processes.A_P1, // must be coerced away — ARC workflows are process-free
        is_master: true,
        is_active: true,
        steps: [],
      });
      expect([200, 201]).toContain(res.status);
      const policy = res.body?.data;
      expect(policy?.id).toBeTruthy();
      created.push(Number(policy.id));
      expect(policy.hotel_id).toBeNull();
      expect(policy.process_id).toBeNull();
    }
  );
});
