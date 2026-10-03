// resolveUserScope reuses the already-authenticated req.user row
// (portal perf plan 2026-10, item 1.1).
//
// Every /dashboard-v2 widget resolves the caller's scope, and resolveUserScope
// used to re-SELECT id/user_type/company_id from tbl_users although the auth
// middleware had just loaded that whole row into req.user — one wasted round
// trip per widget, ~30 per dashboard load.
//
// What must hold:
//   - same scope whether or not the row is handed over;
//   - a row whose id does NOT match user_id is ignored (falls back to the
//     authoritative lookup), so a mismatched hand-off can never widen scope;
//   - the HTTP path no longer issues the tbl_users lookup.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import appDb, { pgp } from "../../app/config/dbConn.js";
import dashboardModel from "../../app/models/dashboardModel.js";

afterAll(async () => {
  await closeDb();
});

afterEach(() => jest.restoreAllMocks());

const USERS = [
  IDS.users.companyA_admin,
  IDS.users.a1_proc_buyer,
  IDS.users.multiHotel,
  IDS.users.crossCompany,
  IDS.users.a1_eng_buyer,
];

async function userRow(id) {
  return db.one(`SELECT * FROM tbl_users WHERE id = $1`, [id]);
}

describe("resolveUserScope with a known user row", () => {
  it.each(USERS)("user %i: identical scope with and without the row", async (id) => {
    const row = await userRow(id);
    for (const selected of [[], [IDS.hotels.A1], [IDS.hotels.A2, IDS.hotels.B1]]) {
      const without = await dashboardModel.resolveUserScope(id, selected);
      const withRow = await dashboardModel.resolveUserScope(id, selected, row);
      expect(withRow).toEqual(without);
    }
  });

  it("ignores a row that belongs to someone else", async () => {
    const narrow = IDS.users.a1_proc_buyer;
    const wideRow = await userRow(IDS.users.companyA_admin);
    const expected = await dashboardModel.resolveUserScope(narrow, []);
    const handedWrongRow = await dashboardModel.resolveUserScope(narrow, [], wideRow);
    expect(handedWrongRow).toEqual(expected);
  });

  it("ignores a row missing the fields it would need", async () => {
    const id = IDS.users.multiHotel;
    const expected = await dashboardModel.resolveUserScope(id, []);
    expect(await dashboardModel.resolveUserScope(id, [], { id })).toEqual(expected);
  });

  it("skips the tbl_users round trip when the row is supplied", async () => {
    const row = await userRow(IDS.users.multiHotel);
    const seen = [];
    const original = appDb.oneOrNone.bind(appDb);
    jest.spyOn(appDb, "oneOrNone").mockImplementation((sql, params) => {
      seen.push(pgp.as.format(sql, params));
      return original(sql, params);
    });
    await dashboardModel.resolveUserScope(row.id, [], row);
    expect(seen.some((s) => /FROM tbl_users WHERE id/i.test(s))).toBe(false);
  });
});

describe("dashboard HTTP path", () => {
  it("serves the widget without re-reading the caller's tbl_users row", async () => {
    const client = await httpClient(IDS.users.multiHotel);
    const seen = [];
    const original = appDb.oneOrNone.bind(appDb);
    jest.spyOn(appDb, "oneOrNone").mockImplementation((sql, params) => {
      seen.push(pgp.as.format(sql, params));
      return original(sql, params);
    });
    const res = await client.get("/api/v1/dashboard-v2/smart-insights").query({ start_date: "2020-01-01", end_date: "2999-01-01" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(seen.some((s) => /SELECT id, user_type, company_id FROM tbl_users/i.test(s))).toBe(false);
  });
});
