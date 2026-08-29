/**
 * HN-2 — deleting an accidentally created business unit or company.
 *
 * Ashlesha's report was that there was no way to remove a mis-created Head
 * Office. There was no delete at any layer — not a button, not a service, not
 * an endpoint — so a typo stayed in the estate forever.
 *
 * The reason it needs care rather than a DELETE statement is that **Postgres
 * will not stop you**. Two tables reference a hotel with no foreign key at all:
 *
 *   tbl_user_role_scopes.hotel_id                     who may do what, where
 *   tbl_vendor_hotel_category_subscription            4,064 rows in production,
 *     keyed (item_type='hotel', item_id)              keyed polymorphically
 *
 * The second is the table that decides which vendors can be solicited for a
 * unit. Orphaning it does not fail loudly — it quietly stops vendors appearing
 * on that unit's RFQs, which is the exact shape of an incident this codebase
 * has already had. So these tests are mostly about the cases the database
 * cannot catch.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN = IDS.users.companyA_admin;
const COMPANY = IDS.hospitality.A;
const base = `/api/v1/hospitality/company/${COMPANY}`;

let restoreAdminType;
const madeHotels = [];
const grants = [];

const makeHotel = async (name = "Scratch unit") => {
  const row = await db.one(
    `INSERT INTO tbl_hospitality_company_hotels (hospitality_company_id, name, is_deleted)
     VALUES ($1, $2, 0) RETURNING id`,
    [COMPANY, name]
  );
  madeHotels.push(Number(row.id));
  return Number(row.id);
};

const refKeys = (body) => (body?.data?.references || []).map((r) => r.key);

beforeAll(async () => {
  ({ user_type: restoreAdminType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]
  ));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
});

afterEach(async () => {
  await revokeRoleScopes(db, grants.splice(0));
  for (const id of madeHotels.splice(0)) {
    await db.none(
      "DELETE FROM tbl_vendor_hotel_category_subscription WHERE item_type = 'hotel' AND item_id = $1",
      [id]
    );
    await db.none("DELETE FROM tbl_hospitality_company_hotels WHERE id = $1", [id]);
  }
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreAdminType]);
  await db.none(
    `DELETE FROM tbl_audit_row_changes WHERE table_name IN
       ('tbl_hospitality_company_hotels','tbl_hospitality_companies','tbl_user_role_scopes','tbl_users')`
  );
  await closeDb();
});

describe("removing a business unit nothing refers to", () => {
  it("says it can be deleted outright", async () => {
    const hotelId = await makeHotel("Typo unit");
    const client = await httpClient(ADMIN);

    const res = await client.get(`${base}/hotels/${hotelId}/delete-preflight`);
    expect(res.status).toBe(200);
    expect(res.body.data.can_hard_delete).toBe(true);
    expect(res.body.data.references).toEqual([]);
  });

  it("actually deletes it", async () => {
    const hotelId = await makeHotel("Typo unit");
    const client = await httpClient(ADMIN);

    expect((await client.delete(`${base}/hotels/${hotelId}`)).status).toBe(200);
    const row = await db.oneOrNone(
      "SELECT id FROM tbl_hospitality_company_hotels WHERE id = $1", [hotelId]
    );
    expect(row).toBeNull();
  });
});

describe("the references Postgres would not have caught", () => {
  it("refuses when a role assignment is scoped to the unit", async () => {
    // tbl_user_role_scopes.hotel_id carries no foreign key, so the DELETE
    // would succeed and leave rows pointing at a unit that no longer exists.
    const hotelId = await makeHotel();
    grants.push(
      await grantRoleScope(db, {
        userId: IDS.users.a1_proc_buyer, roleId: 2, companyId: COMPANY, hotelId,
      })
    );
    const client = await httpClient(ADMIN);

    const preflight = await client.get(`${base}/hotels/${hotelId}/delete-preflight`);
    expect(preflight.body.data.can_hard_delete).toBe(false);
    expect(refKeys(preflight.body)).toContain("role_scopes");

    const res = await client.delete(`${base}/hotels/${hotelId}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UNIT_IN_USE");

    const row = await db.one(
      "SELECT id FROM tbl_hospitality_company_hotels WHERE id = $1", [hotelId]
    );
    expect(row).toBeDefined();
  });

  it("refuses when vendors are subscribed to the unit", async () => {
    // The one that would hurt most and appears in no earlier inventory: this
    // table decides which vendors can be solicited for a unit, it is keyed
    // polymorphically, and it has no foreign key either.
    const hotelId = await makeHotel();
    await db.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription
              (vendor_id, item_type, item_id, status, fee_amount, start_date, end_date)
       VALUES ($1, 'hotel', $2, 'active', 0, now(), now() + interval '1 year')`,
      [IDS.users.vendor_alpha, hotelId]
    );
    const client = await httpClient(ADMIN);

    const preflight = await client.get(`${base}/hotels/${hotelId}/delete-preflight`);
    expect(preflight.body.data.can_hard_delete).toBe(false);
    expect(refKeys(preflight.body)).toContain("vendor_subscriptions");

    expect((await client.delete(`${base}/hotels/${hotelId}`)).status).toBe(409);
  });

  it("counts everything, not just the first thing it finds", async () => {
    // "3 RFQs" and "3 RFQs, 40 people and 900 vendor subscriptions" are
    // different decisions. Stopping at the first hit gives the admin the first.
    const hotelId = await makeHotel();
    grants.push(
      await grantRoleScope(db, {
        userId: IDS.users.a1_proc_buyer, roleId: 2, companyId: COMPANY, hotelId,
      })
    );
    await db.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription
              (vendor_id, item_type, item_id, status, fee_amount, start_date, end_date)
       VALUES ($1, 'hotel', $2, 'active', 0, now(), now() + interval '1 year')`,
      [IDS.users.vendor_alpha, hotelId]
    );
    const client = await httpClient(ADMIN);

    const keys = refKeys((await client.get(`${base}/hotels/${hotelId}/delete-preflight`)).body);
    expect(keys).toContain("role_scopes");
    expect(keys).toContain("vendor_subscriptions");
  });

  it("returns the reference list with the refusal, not just the word no", async () => {
    // "No" without "because of these 40 things" leaves the admin nowhere.
    const hotelId = await makeHotel();
    grants.push(
      await grantRoleScope(db, {
        userId: IDS.users.a1_proc_buyer, roleId: 2, companyId: COMPANY, hotelId,
      })
    );
    const client = await httpClient(ADMIN);

    const res = await client.delete(`${base}/hotels/${hotelId}`);
    expect(res.body.data.references.length).toBeGreaterThan(0);
    expect(res.body.data.references[0]).toHaveProperty("label");
    expect(res.body.data.references[0]).toHaveProperty("count");
  });
});

describe("archiving instead", () => {
  it("hides a unit that cannot be deleted, without touching what refers to it", async () => {
    const hotelId = await makeHotel();
    const scopeId = await grantRoleScope(db, {
      userId: IDS.users.a1_proc_buyer, roleId: 2, companyId: COMPANY, hotelId,
    });
    grants.push(scopeId);
    const client = await httpClient(ADMIN);

    expect((await client.delete(`${base}/hotels/${hotelId}?archive=true`)).status).toBe(200);

    const hotel = await db.one(
      "SELECT is_deleted FROM tbl_hospitality_company_hotels WHERE id = $1", [hotelId]
    );
    expect(Number(hotel.is_deleted)).toBe(1);
    // The whole point of archiving over deleting: the work survives.
    const scope = await db.oneOrNone(
      "SELECT id FROM tbl_user_role_scopes WHERE id = $1", [scopeId]
    );
    expect(scope).not.toBeNull();
  });

  it("can be undone", async () => {
    const hotelId = await makeHotel();
    const client = await httpClient(ADMIN);
    await client.delete(`${base}/hotels/${hotelId}?archive=true`);

    expect((await client.post(`${base}/hotels/${hotelId}/restore`)).status).toBe(200);
    const hotel = await db.one(
      "SELECT is_deleted FROM tbl_hospitality_company_hotels WHERE id = $1", [hotelId]
    );
    expect(Number(hotel.is_deleted)).toBe(0);
  });
});

describe("who may do it", () => {
  it("is not something an ordinary buyer can do", async () => {
    const hotelId = await makeHotel();
    const client = await httpClient(IDS.users.a1_proc_buyer);
    expect((await client.delete(`${base}/hotels/${hotelId}`)).status).toBe(403);
  });

  it("does not let another company's admin delete a unit", async () => {
    const hotelId = await makeHotel();
    const restore = await db.one(
      "SELECT user_type FROM tbl_users WHERE id = $1", [IDS.users.companyB_admin]
    );
    await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [IDS.users.companyB_admin]);
    try {
      const client = await httpClient(IDS.users.companyB_admin);
      // 404, not 403 — an admin of another tenant should not learn it exists.
      expect((await client.delete(`${base}/hotels/${hotelId}`)).status).toBe(404);
      const row = await db.one(
        "SELECT id FROM tbl_hospitality_company_hotels WHERE id = $1", [hotelId]
      );
      expect(row).toBeDefined();
    } finally {
      await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1",
        [IDS.users.companyB_admin, restore.user_type]);
    }
  });
});

describe("removing a company", () => {
  it("refuses while it still has business units", async () => {
    const client = await httpClient(ADMIN);
    const preflight = await client.get(`${base}/delete-preflight`);
    expect(preflight.status).toBe(200);
    expect(preflight.body.data.can_hard_delete).toBe(false);
    expect(refKeys(preflight.body)).toContain("business_units");

    const res = await client.delete(base);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("COMPANY_IN_USE");
  });
});
