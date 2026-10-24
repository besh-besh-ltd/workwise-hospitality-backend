// Inventory scope, numbering, settings and the error envelope (Task A2).
// ----------------------------------------------------------------------------
// Inventory checks the company and hotel axes only (spec §6.1): a role-scope
// row with hotel_id NULL covers every hotel of its company, and department /
// process columns neither narrow nor widen it. Tenancy always comes from the
// user plus the hotel row, never from the request.
//
// Every test runs inside withTx (always rolled back), so the role grants made
// here never leak to other suites.

import { describe, it, expect, afterAll } from "@jest/globals";
import { withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope } from "../helpers/roleScope.js";
import {
  hotelIdsWithPermission,
  assertHotelPermission,
  companyIdForHotel,
} from "../../app/services/inventory/scope.js";
import { nextDocNumber } from "../../app/services/inventory/docNumber.js";
import { getEffectiveSettings } from "../../app/services/inventory/settings.js";
import { InventoryError, sendInventoryError } from "../../app/services/inventory/errors.js";
import { PoAccessError, PoWritePermissionError } from "../../app/models/purchaseOrderModel.js";
import { AuthorizationError } from "../../app/services/authorizationService.js";

// Mapped to company A (hotel A1) and holding only Tech Approver there: no grn
// or inventory permission anywhere until a test grants one.
const USER = IDS.users.a1_proc_techApp;
const A = IDS.hospitality.A;

afterAll(async () => {
  await closeDb();
});

async function storekeeperRoleId(t) {
  const row = await t.one(`SELECT id FROM tbl_roles WHERE title = 'Storekeeper' AND created_by IS NULL`);
  return Number(row.id);
}

async function liveHotelsOf(t, companyId) {
  const rows = await t.any(
    `SELECT id FROM tbl_hospitality_company_hotels
      WHERE hospitality_company_id = $1 AND COALESCE(is_deleted, 0) = 0 ORDER BY id`,
    [companyId]
  );
  return rows.map((r) => Number(r.id));
}

/** Runs fn in a SAVEPOINT and returns what it threw (or fails the test). */
async function thrownBy(t, fn) {
  try {
    await t.tx((sp) => fn(sp));
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("inventory scope", () => {
  it("null-hotel scope expands to all company hotels", async () => {
    await withTx(async (t) => {
      await grantRoleScope(t, { userId: USER, roleId: await storekeeperRoleId(t), companyId: A, hotelId: null });

      const hotels = await hotelIdsWithPermission(t, USER, "inventory", "create");
      expect(hotels).toEqual(await liveHotelsOf(t, A));
      expect(hotels).toEqual(expect.arrayContaining([IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3]));
      expect(hotels).not.toContain(IDS.hotels.B1);

      // A hotel the user was never mapped to individually is still covered.
      await expect(
        assertHotelPermission(t, { id: USER }, { resource: "inventory", action: "create", hotelId: IDS.hotels.A3 })
      ).resolves.toEqual({ companyId: A });

      // A deleted hotel drops out of the expansion.
      await t.none(`UPDATE tbl_hospitality_company_hotels SET is_deleted = 1 WHERE id = $1`, [IDS.hotels.A3]);
      expect(await hotelIdsWithPermission(t, USER, "inventory", "create")).not.toContain(IDS.hotels.A3);
    });
  });

  it("process-scoped row still grants inventory on its hotel", async () => {
    await withTx(async (t) => {
      await grantRoleScope(t, {
        userId: USER,
        roleId: await storekeeperRoleId(t),
        companyId: A,
        hotelId: IDS.hotels.A2,
        departmentId: IDS.departments.eng,
        processId: IDS.processes.A_P1,
      });

      expect(await hotelIdsWithPermission(t, USER, "inventory", "create")).toEqual([IDS.hotels.A2]);
      expect(await hotelIdsWithPermission(t, USER, "grn", ["read", "create"])).toEqual([IDS.hotels.A2]);
      await expect(
        assertHotelPermission(t, { id: USER }, { resource: "grn", action: "create", hotelId: IDS.hotels.A2 })
      ).resolves.toEqual({ companyId: A });
    });
  });

  it("other-company hotel is NOT_FOUND", async () => {
    await withTx(async (t) => {
      await grantRoleScope(t, { userId: USER, roleId: await storekeeperRoleId(t), companyId: A, hotelId: null });

      const foreign = await thrownBy(t, (sp) =>
        assertHotelPermission(sp, { id: USER }, { resource: "inventory", action: "read", hotelId: IDS.hotels.B1 })
      );
      expect(foreign).toBeInstanceOf(InventoryError);
      expect(foreign).toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });

      const missing = await thrownBy(t, (sp) =>
        assertHotelPermission(sp, { id: USER }, { resource: "inventory", action: "read", hotelId: 99999999 })
      );
      expect(missing.code).toBe("NOT_FOUND");

      // Vendors and site-rep token users never see buyer hotels.
      const vendor = await thrownBy(t, (sp) =>
        assertHotelPermission(sp, { id: IDS.users.vendor_alpha, user_type: 3 }, {
          resource: "inventory", action: "read", hotelId: IDS.hotels.A1,
        })
      );
      expect(vendor.code).toBe("NOT_FOUND");
      const token = await thrownBy(t, (sp) =>
        assertHotelPermission(sp, { id: -1, is_token_user: true }, {
          resource: "grn", action: "create", hotelId: IDS.hotels.A1,
        })
      );
      expect(token.code).toBe("NOT_FOUND");

      // A super admin reaches any hotel.
      await expect(
        assertHotelPermission(t, { id: IDS.users.superAdmin, user_type: 8 }, {
          resource: "inventory", action: "admin", hotelId: IDS.hotels.B1,
        })
      ).resolves.toEqual({ companyId: IDS.hospitality.B });
    });
  });

  it("missing permission is FORBIDDEN", async () => {
    await withTx(async (t) => {
      // Mapped to company A but holding no inventory permission at all.
      const none = await thrownBy(t, (sp) =>
        assertHotelPermission(sp, { id: USER }, { resource: "inventory", action: "create", hotelId: IDS.hotels.A1 })
      );
      expect(none).toBeInstanceOf(InventoryError);
      expect(none).toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
      expect(await hotelIdsWithPermission(t, USER, "inventory", "create")).toEqual([]);

      // Storekeeper at A1 only: no approve anywhere, nothing at A2.
      await grantRoleScope(t, { userId: USER, roleId: await storekeeperRoleId(t), companyId: A, hotelId: IDS.hotels.A1 });
      const approve = await thrownBy(t, (sp) =>
        assertHotelPermission(sp, { id: USER }, { resource: "inventory", action: "approve", hotelId: IDS.hotels.A1 })
      );
      expect(approve.code).toBe("FORBIDDEN");
      const otherHotel = await thrownBy(t, (sp) =>
        assertHotelPermission(sp, { id: USER }, { resource: "inventory", action: "create", hotelId: IDS.hotels.A2 })
      );
      expect(otherHotel.code).toBe("FORBIDDEN");
      await expect(
        assertHotelPermission(t, { id: USER }, { resource: "inventory", action: "create", hotelId: IDS.hotels.A1 })
      ).resolves.toEqual({ companyId: A });
    });
  });

  it("companyIdForHotel reads the hotel row", async () => {
    await withTx(async (t) => {
      expect(await companyIdForHotel(t, IDS.hotels.B2)).toBe(IDS.hospitality.B);
      expect(await companyIdForHotel(t, 99999999)).toBeNull();
    });
  });
});

describe("document numbers", () => {
  it("nextDocNumber increments per hotel+type+FY and formats GRN/<code>/2026-27/00001", async () => {
    await withTx(async (t) => {
      const A1 = IDS.hotels.A1;
      const A2 = IDS.hotels.A2;
      // Committed sequences from other suites must not shift the count.
      await t.none(`DELETE FROM tbl_inv_doc_sequence WHERE hotel_id = ANY($1::int[])`, [[A1, A2]]);
      const next = (hotelId, docType, date = "2026-10-24") => nextDocNumber(t, { hotelId, docType, date });

      expect(await next(A1, "GRN")).toBe(`GRN/${A1}/2026-27/00001`);
      expect(await next(A1, "GRN")).toBe(`GRN/${A1}/2026-27/00002`);
      expect(await next(A1, "OUT")).toBe(`OUT/${A1}/2026-27/00001`);
      expect(await next(A2, "GRN")).toBe(`GRN/${A2}/2026-27/00001`);
      // 1 Apr 2027 starts FY 2027-28; 31 Mar 2027 is still 2026-27.
      expect(await next(A1, "GRN", "2027-04-01")).toBe(`GRN/${A1}/2027-28/00001`);
      expect(await next(A1, "GRN", "2027-03-31")).toBe(`GRN/${A1}/2026-27/00003`);

      // A hotel doc_code replaces the hotel id.
      await t.none(
        `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, doc_code) VALUES ($1, $2, 'MUM1')`,
        [A1, A]
      );
      expect(await next(A1, "GRN")).toBe("GRN/MUM1/2026-27/00004");

      const row = await t.one(
        `SELECT hospitality_company_id, last_no FROM tbl_inv_doc_sequence
          WHERE hotel_id = $1 AND doc_type = 'GRN' AND fy = '2026-27'`,
        [A1]
      );
      expect(row).toEqual({ hospitality_company_id: A, last_no: 4 });

      const badType = await thrownBy(t, (sp) => nextDocNumber(sp, { hotelId: A1, docType: "PO", date: "2026-10-24" }));
      expect(badType.code).toBe("VALIDATION");
      const badHotel = await thrownBy(t, (sp) => nextDocNumber(sp, { hotelId: 99999999, docType: "GRN" }));
      expect(badHotel.code).toBe("NOT_FOUND");
    });
  });
});

describe("settings", () => {
  it("missing rows fall back to the defaults; the hotel overrides GST", async () => {
    await withTx(async (t) => {
      await t.none(`DELETE FROM tbl_inv_hotel_settings WHERE hotel_id = $1`, [IDS.hotels.A2]);
      await t.none(`DELETE FROM tbl_inv_company_settings WHERE hospitality_company_id = $1`, [A]);

      expect(await getEffectiveSettings(t, { companyId: A, hotelId: IDS.hotels.A2 })).toEqual({
        overReceiptTolerancePct: 0,
        allowNegativeStock: false,
        includeGstInCost: false,
        adjustmentAutoApproveLimit: 0,
        countFreeze: false,
        docCode: String(IDS.hotels.A2),
        stockStartedAt: null,
      });

      await t.none(
        `INSERT INTO tbl_inv_company_settings
           (hospitality_company_id, over_receipt_tolerance_pct, allow_negative_stock,
            include_gst_in_cost, adjustment_auto_approve_limit, count_freeze)
         VALUES ($1, 5, true, true, 2500.5, true)`,
        [A]
      );
      await t.none(
        `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, doc_code, include_gst_in_cost, stock_started_at)
         VALUES ($1, $2, 'GOA', false, '2026-10-01T04:30:00Z')`,
        [IDS.hotels.A2, A]
      );

      expect(await getEffectiveSettings(t, { companyId: A, hotelId: IDS.hotels.A2 })).toEqual({
        overReceiptTolerancePct: 5,
        allowNegativeStock: true,
        includeGstInCost: false,
        adjustmentAutoApproveLimit: 2500.5,
        countFreeze: true,
        docCode: "GOA",
        stockStartedAt: "2026-10-01T04:30:00.000Z",
      });
      // Another hotel of the same company inherits the company GST setting.
      expect(await getEffectiveSettings(t, { companyId: A, hotelId: IDS.hotels.A1 })).toMatchObject({
        includeGstInCost: true,
        docCode: String(IDS.hotels.A1),
      });
    });
  });
});

describe("error envelope", () => {
  function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (body) => {
      res.body = body;
      return res;
    };
    return res;
  }

  it("sendInventoryError answers with the code, details and HTTP status", () => {
    const res = fakeRes();
    sendInventoryError(res, new InventoryError("NEGATIVE_STOCK", "Not enough stock", { available: 1, requested: 2 }, 409));
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      status: 0,
      message: "Not enough stock",
      code: "NEGATIVE_STOCK",
      details: { available: 1, requested: 2 },
    });

    // Not-found keeps the house status 2 (backend CLAUDE.md), like PoAccessError.
    const notFound = fakeRes();
    sendInventoryError(notFound, new InventoryError("NOT_FOUND", "Not found"));
    expect(notFound.statusCode).toBe(404);
    expect(notFound.body).toEqual({ status: 2, message: "Not found", code: "NOT_FOUND", details: {} });

    const forbidden = fakeRes();
    sendInventoryError(forbidden, new InventoryError("FORBIDDEN", "No permission", { hotelId: 1 }));
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).toMatchObject({ status: 0, code: "FORBIDDEN", details: { hotelId: 1 } });
  });

  // The B-wave controllers reuse assertPoAccess / assertPoInitiateAccess and
  // the house scope checks, so their refusals answer the way PO routes do.
  it("a PO outside the caller's scope is a plain 404", () => {
    const res = fakeRes();
    sendInventoryError(res, new PoAccessError());
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ status: 2, message: "Not found" });
  });

  it("a PO the caller can see but not initiate is a 403 with its code", () => {
    const res = fakeRes();
    sendInventoryError(res, new PoWritePermissionError());
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      status: 0,
      message: "You do not have permission to initiate this purchase order.",
      code: "PO_WRITE_PERMISSION_REQUIRED",
    });
  });

  it("an authorization refusal keeps its own status and code", () => {
    const res = fakeRes();
    sendInventoryError(res, new AuthorizationError("Not in your scope", { process_id: 7 }));
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ status: 0, message: "Not in your scope", code: "PROCESS_NOT_IN_USER_SCOPE" });
  });

  it("anything else is a 500 without internals", () => {
    const res = fakeRes();
    sendInventoryError(res, new Error("relation tbl_secret does not exist"));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ status: 3, message: "Something went wrong" });
  });
});
