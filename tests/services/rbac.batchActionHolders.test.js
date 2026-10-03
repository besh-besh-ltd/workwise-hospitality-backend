// Batched permission fan-out (portal perf plan 2026-10, item 1.1).
//
// getActionHoldersForRFQs resolves "who can act on this row" per unique
// hotel x department x process x resource combination. It used to issue one
// rbacModel.getUsersWithModuleActionsForHotels query per combination — on prod
// 48 combinations = 48 statements = 2,362 ms for one listing page. It now
// sends every combination in ONE statement via getUsersWithModuleActionsBatch.
//
// This suite proves the batched resolver is a drop-in replacement:
//   1. for every spec shape (hotel, dept or none, process or none, every
//      resource the listing asks about), the batch returns exactly the users
//      the single-spec query returns — the single-spec function is untouched
//      production code, so it serves as the oracle;
//   2. getActionHoldersForRFQs issues ONE permission statement per call
//      regardless of how many combinations the page holds, and none through
//      the single-spec function.
//
// The single-spec query orders by name only, so equal names come back in
// arbitrary order; the batch adds `u.id` as a tie-break. Comparison is
// therefore on (name, id) order.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { seedPerfWorld } from "../helpers/perfParityWorld.js";
import rbacModel from "../../app/models/rbacModel.js";
import rfqModel from "../../app/models/rfqModel.js";

let world;

beforeAll(async () => {
  world = await seedPerfWorld(db);
}, 180000);

afterAll(async () => {
  if (world) await world.cleanup();
  await closeDb();
});

afterEach(() => jest.restoreAllMocks());

const byNameId = (a, b) => (a.name || "").localeCompare(b.name || "") || a.id - b.id;
const norm = (users) => users.map((u) => ({ id: u.id, name: u.name, email: u.email })).sort(byNameId);

const RESOURCES = [
  { resource: "te", actions: ["read", "create"] },
  { resource: "quote-compare", actions: ["read", "create"] },
  { resource: "awarding", actions: ["read", "create"] },
  { resource: "rfq", actions: ["read"] },
];

function allSpecs() {
  const hotels = [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3, IDS.hotels.B1, IDS.hotels.B2];
  const depts = [null, IDS.departments.proc, IDS.departments.eng, IDS.departments.fb];
  const procs = [null, IDS.processes.A_P1, IDS.processes.A_P2, IDS.processes.B_P1];
  const specs = [];
  for (const h of hotels) for (const d of depts) for (const p of procs) for (const r of RESOURCES) {
    specs.push({ key: `${h}|${d}|${p}|${r.resource}`, hotelIds: [h], departmentId: d, processId: p, ...r });
  }
  // multi-hotel spec (the batch must honour every hotel in the array)
  specs.push({ key: "multi", hotelIds: [IDS.hotels.A1, IDS.hotels.B1], departmentId: null, processId: null, resource: "rfq", actions: ["read"] });
  return specs;
}

describe("getUsersWithModuleActionsBatch is equivalent to the single-spec resolver", () => {
  it("returns the same users for every hotel x dept x process x resource spec", async () => {
    const specs = allSpecs();
    const batched = await rbacModel.getUsersWithModuleActionsBatch(specs);
    let nonEmpty = 0;
    const distinctAnswers = new Set();
    for (const s of specs) {
      const single = await rbacModel.getUsersWithModuleActionsForHotels(s.hotelIds, s.resource, s.actions, s.departmentId, s.processId);
      const got = batched.get(s.key) || [];
      try {
        expect(norm(got)).toEqual(norm(single));
        // the batch's own order is (name, id)
        expect(got.map((u) => u.id)).toEqual(norm(got).map((u) => u.id));
      } catch (e) {
        e.message = `spec ${s.key}\n${e.message}`;
        throw e;
      }
      if (single.length) nonEmpty++;
      distinctAnswers.add(JSON.stringify(norm(single).map((u) => u.id)));
    }
    expect(nonEmpty).toBeGreaterThan(20);
    // the process-, department- and hotel-scoped users must make answers
    // differ between specs, or this would only prove "both return everyone"
    expect(distinctAnswers.size).toBeGreaterThan(8);
  });

  it("ignores unusable specs exactly like the single-spec early return", async () => {
    const out = await rbacModel.getUsersWithModuleActionsBatch([
      { key: "noHotels", hotelIds: [], resource: "rfq", actions: ["read"] },
      { key: "noResource", hotelIds: [IDS.hotels.A1], resource: null, actions: ["read"] },
      { key: "noActions", hotelIds: [IDS.hotels.A1], resource: "rfq", actions: [] },
    ]);
    expect(out.size).toBe(0);
    expect(await rbacModel.getUsersWithModuleActionsBatch([])).toEqual(new Map());
  });
});

describe("getActionHoldersForRFQs issues one permission statement per call", () => {
  it("resolves every permission-stage row through a single batched call", async () => {
    const rows = await db.any(
      `SELECT id, status, is_tender, hotel_id, department_id, process_id FROM tbl_rfq WHERE id = ANY($1) ORDER BY id`,
      [world.rfqIds]
    );
    const lifecycle = await rfqModel.computeLifecycleStages(rows.map((r) => r.id));
    const permissionStages = new Set(["TECHNICAL_EVALUATING", "TECHNICAL_REJECTED", "COMMERCIAL_EVALUATION", "AWAITING_PO", "PO_VENDOR_REJECTED"]);
    const permRows = rows.filter((r) => ![2, 5].includes(Number(r.status)) && permissionStages.has(lifecycle[r.id]));
    const combos = new Set(permRows.map((r) => `${r.hotel_id}|${r.process_id}`));
    expect(combos.size).toBeGreaterThan(1); // otherwise batching proves nothing

    const single = jest.spyOn(rbacModel, "getUsersWithModuleActionsForHotels");
    const batch = jest.spyOn(rbacModel, "getUsersWithModuleActionsBatch");
    const result = await rfqModel.getActionHoldersForRFQs(rows, lifecycle);

    expect(single).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
    // every permission-stage row got an answer from the batch, with the same
    // users the single-spec resolver would have produced for that row
    for (const r of permRows) {
      const entry = result[r.id];
      expect(entry && entry.type).toBe("permission");
    }
    jest.restoreAllMocks();
    const STAGE = {
      TECHNICAL_EVALUATING: ["te", true], TECHNICAL_REJECTED: ["te", true],
      COMMERCIAL_EVALUATION: ["quote-compare", false], AWAITING_PO: ["awarding", false], PO_VENDOR_REJECTED: ["awarding", false],
    };
    for (const r of permRows) {
      const [resource, useDept] = STAGE[lifecycle[r.id]];
      const expected = await rbacModel.getUsersWithModuleActionsForHotels(
        [r.hotel_id], resource, ["read", "create"], useDept && r.department_id ? r.department_id : null, r.process_id
      );
      expect(norm(result[r.id].users)).toEqual(norm(expected));
    }
  });
});
