/**
 * An employee code can belong to only one live account.
 *
 * Production held five codes shared by two live rows each. Nothing refused
 * them: the create screen checked email and mobile but not the code, the edit
 * screen checked nothing, and the database had no constraint. One of them was
 * an administrator creating a new starter on a departed employee's code two
 * days before this was written.
 *
 * "Live" is the population login searches — not deleted, not user_type 1 — and
 * it includes DEACTIVATED accounts on purpose. Deactivation is reversible; if a
 * deactivated account gave up its code, reactivating it could collide with
 * whoever took the code meanwhile.
 *
 * Isolation: commit + cleanup over real HTTP + Postgres (ids 97501-97599).
 */
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import userModel from "../../app/models/userModel.js";
import {
  EMPLOYEE_CODE_INDEX,
  employeeCodeIndexDef,
  dropEmployeeCodeIndex,
  restoreEmployeeCodeIndex,
} from "../helpers/employeeCodeIndex.js";

const ADMIN = IDS.users.companyA_admin;
const ADMIN_B = IDS.users.companyB_admin;
const ID_MIN = 97501;
const ID_MAX = 97599;
const MIGRATION = path.resolve("migrations/20261016100000_unique_employee_code.sql");

async function seedAccount({ id, code, status = 1, name = `Holder ${id}`, company = IDS.companies.A, is_deleted = 0, user_type = 2 }) {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, is_deleted, user_type, company_id, employee_code, password, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
    [id, name, `uniq-${id}@example.com`, status, is_deleted, user_type, company, code, bcrypt.hashSync("Pw-1", 4)]
  );
  return { id, code, name };
}

const newAccount = (employee_code) => ({
  name: "Code Probe",
  email: `code-probe-${Math.random().toString(36).slice(2, 10)}@example.com`,
  mobile: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`,
  password: "Str0ng!Pass1",
  employee_code,
});

const create = async (body, admin = ADMIN) =>
  (await httpClient(admin)).post("/api/v1/users/create-buyer-company-user").send(body);
const edit = async (user_id, body, admin = ADMIN) =>
  (await httpClient(admin))
    .put("/api/v1/users/update-user-detail")
    .send({ user_id, confirmed_approval_impact: true, ...body });

const codeOf = async (id) => (await db.one("SELECT employee_code FROM tbl_users WHERE id = $1", [id])).employee_code;
const statusOf = async (id) => (await db.one("SELECT status FROM tbl_users WHERE id = $1", [id])).status;
const createdWith = (email) => db.oneOrNone("SELECT id, employee_code FROM tbl_users WHERE email = $1", [email]);

const expectTaken = (res, message) => {
  expect(res.status).toBe(409);
  expect(res.body).toEqual({ status: 0, code: "EMPLOYEE_CODE_TAKEN", field: "employee_code", message });
  // No `errors` object: the frontend's axios interceptor toasts every key of
  // one, and the screen already says the message once, under the field.
  expect(res.body.errors).toBeUndefined();
};

let restoreTypes;

beforeAll(async () => {
  restoreTypes = await db.any("SELECT id, user_type FROM tbl_users WHERE id = ANY($1)", [[ADMIN, ADMIN_B]]);
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = ANY($1)", [[ADMIN, ADMIN_B]]);
});

afterEach(async () => {
  await db.none("DELETE FROM tbl_users WHERE id BETWEEN $1 AND $2", [ID_MIN, ID_MAX]);
  await db.none("DELETE FROM tbl_user_department WHERE user_id IN (SELECT id FROM tbl_users WHERE email LIKE 'code-probe-%@example.com')");
  await db.none("DELETE FROM tbl_users WHERE email LIKE 'code-probe-%@example.com'");
});

afterAll(async () => {
  for (const r of restoreTypes) await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [r.id, r.user_type]);
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name = 'tbl_users'");
  await db.none("DELETE FROM tbl_activity_events");
  await closeDb();
});

describe("creating an account", () => {
  it("refuses a code an active colleague holds, and names them", async () => {
    await seedAccount({ id: 97501, code: "EC-0001", name: "Asha Rao" });
    const body = newAccount("EC-0001");
    expectTaken(await create(body), "Employee code EC-0001 is already used by Asha Rao.");
    expect(await createdWith(body.email)).toBeNull();
  });

  it("refuses a code a deactivated colleague holds, and says how to free it", async () => {
    await seedAccount({ id: 97502, code: "EC-0002", name: "Ravi", status: 0 });
    const body = newAccount("EC-0002");
    expectTaken(
      await create(body),
      "Employee code EC-0002 is already used by Ravi, whose account is deactivated. " +
        "Reactivate that account, or change its employee code first."
    );
    expect(await createdWith(body.email)).toBeNull();
  });

  it("refuses a code held in another company without saying who holds it", async () => {
    await seedAccount({ id: 97503, code: "EC-0003", name: "Someone Elsewhere", company: IDS.companies.B });
    const res = await create(newAccount("EC-0003"));
    expectTaken(res, "Employee code EC-0003 is already in use.");
    expect(JSON.stringify(res.body)).not.toContain("Someone Elsewhere");
  });

  it("is not fooled by case or surrounding spaces", async () => {
    await seedAccount({ id: 97504, code: "EC-0004", name: "Asha Rao" });
    const body = newAccount("  ec-0004 ");
    expectTaken(await create(body), "Employee code ec-0004 is already used by Asha Rao.");
    expect(await createdWith(body.email)).toBeNull();
  });

  it("allows a code that only a deleted account held", async () => {
    await seedAccount({ id: 97505, code: "EC-0005", is_deleted: 1 });
    const body = newAccount("EC-0005");
    expect((await create(body)).status).toBeLessThan(300);
    expect((await createdWith(body.email)).employee_code).toBe("EC-0005");
  });

  it("stores the code trimmed, and a blank code as no code", async () => {
    const trimmed = newAccount("  EC-0006  ");
    expect((await create(trimmed)).status).toBeLessThan(300);
    expect((await createdWith(trimmed.email)).employee_code).toBe("EC-0006");

    const blank = newAccount("   ");
    expect((await create(blank)).status).toBeLessThan(300);
    expect((await createdWith(blank.email)).employee_code).toBeNull();
  });

  it("lets two accounts be created without codes", async () => {
    const a = newAccount(null);
    const b = newAccount("");
    expect((await create(a)).status).toBeLessThan(300);
    expect((await create(b)).status).toBeLessThan(300);
  });

  it("lets exactly one of two simultaneous creates have the code", async () => {
    const [r1, r2] = await Promise.all([create(newAccount("EC-0008")), create(newAccount("EC-0008"))]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(409);
    const holders = await db.any("SELECT id FROM tbl_users WHERE employee_code = 'EC-0008'");
    expect(holders).toHaveLength(1);
  });

  // The window between the check and the INSERT: the check saw nobody, then the
  // database refused. Still the same answer, not a 500.
  it("answers a database refusal the same way as the check would", async () => {
    await seedAccount({ id: 97509, code: "EC-0009", name: "Asha Rao" });
    const spy = jest.spyOn(userModel, "findLiveEmployeeCodeHolders").mockResolvedValueOnce([]);
    try {
      const body = newAccount("EC-0009");
      expectTaken(await create(body), "Employee code EC-0009 is already used by Asha Rao.");
      expect(await createdWith(body.email)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("editing an account", () => {
  it("refuses a code somebody else holds and leaves the account's own code alone", async () => {
    await seedAccount({ id: 97511, code: "EC-0011", name: "Asha Rao" });
    const target = await seedAccount({ id: 97512, code: "EC-0012" });
    expectTaken(await edit(target.id, { employee_code: "EC-0011" }), "Employee code EC-0011 is already used by Asha Rao.");
    expect(await codeOf(target.id)).toBe("EC-0012");
  });

  it("saves other changes without re-checking an unchanged code", async () => {
    const target = await seedAccount({ id: 97513, code: "EC-0013" });
    const res = await edit(target.id, { employee_code: "EC-0013", name: "Renamed" });
    expect(res.status).toBe(200);
  });

  it("lets an account change the case of its own code", async () => {
    const target = await seedAccount({ id: 97514, code: "ec-0014" });
    expect((await edit(target.id, { employee_code: "EC-0014" })).status).toBe(200);
    expect(await codeOf(target.id)).toBe("EC-0014");
  });

  it("moves an account to a free code, stored trimmed", async () => {
    const target = await seedAccount({ id: 97515, code: "EC-0015" });
    expect((await edit(target.id, { employee_code: " EC-0115 " })).status).toBe(200);
    expect(await codeOf(target.id)).toBe("EC-0115");
  });

  it("clears a code", async () => {
    const target = await seedAccount({ id: 97516, code: "EC-0016" });
    expect((await edit(target.id, { employee_code: "" })).status).toBe(200);
    expect(await codeOf(target.id)).toBeNull();
  });

  it("frees a code for somebody else once its holder moves off it", async () => {
    const holder = await seedAccount({ id: 97517, code: "EC-0017" });
    expect((await edit(holder.id, { employee_code: "EC-0017-OLD" })).status).toBe(200);
    expect((await create(newAccount("EC-0017"))).status).toBeLessThan(300);
  });

  it("answers a database refusal the same way as the check would", async () => {
    await seedAccount({ id: 97518, code: "EC-0018", name: "Asha Rao" });
    const target = await seedAccount({ id: 97519, code: "EC-0019" });
    const spy = jest.spyOn(userModel, "findLiveEmployeeCodeHolders").mockResolvedValueOnce([]);
    try {
      expectTaken(await edit(target.id, { employee_code: "EC-0018" }), "Employee code EC-0018 is already used by Asha Rao.");
      expect(await codeOf(target.id)).toBe("EC-0019");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("reactivating an account", () => {
  it("always succeeds for an account that still holds its code — nobody else could take it", async () => {
    const target = await seedAccount({ id: 97521, code: "EC-0021", status: 0 });
    expect((await edit(target.id, { status: 1 })).status).toBe(200);
    expect(await statusOf(target.id)).toBe(1);
  });

  describe("an account left over from before the index, whose code another account now holds", () => {
    let indexDef;
    beforeAll(async () => {
      indexDef = await dropEmployeeCodeIndex();
    });
    afterAll(async () => {
      await db.none("DELETE FROM tbl_users WHERE id BETWEEN $1 AND $2", [ID_MIN, ID_MAX]);
      await restoreEmployeeCodeIndex(indexDef);
    });

    it("is refused, so two active accounts never share a code", async () => {
      await seedAccount({ id: 97522, code: "EC-0022", name: "Ravi Menon" });
      const old = await seedAccount({ id: 97523, code: "EC-0022", status: 0 });
      expectTaken(await edit(old.id, { status: 1 }), "Employee code EC-0022 is already used by Ravi Menon.");
      expect(await statusOf(old.id)).toBe(0);
    });

    it("succeeds once the old account is given a different code in the same save", async () => {
      await seedAccount({ id: 97524, code: "EC-0024" });
      const old = await seedAccount({ id: 97525, code: "EC-0024", status: 0 });
      expect((await edit(old.id, { status: 1, employee_code: "EC-0024-B" })).status).toBe(200);
      expect(await statusOf(old.id)).toBe(1);
    });
  });
});

describe("the database", () => {
  it("has the unique index, defined the way the application compares codes", async () => {
    const def = await employeeCodeIndexDef();
    expect(def).toMatch(/CREATE UNIQUE INDEX uq_users_employee_code_live/);
    expect(def).toMatch(/upper\(btrim\(\(employee_code\)::text\)\)/);
    expect(def).toMatch(/is_deleted = 0/);
    expect(def).toMatch(/user_type <> 1/);
  });

  // Scripts and bulk loads write with SQL and never pass through the API.
  it("refuses a duplicate written straight to the table, whatever its case", async () => {
    await seedAccount({ id: 97531, code: "EC-0031" });
    await expect(seedAccount({ id: 97532, code: " ec-0031" })).rejects.toMatchObject({
      code: "23505",
      constraint: EMPLOYEE_CODE_INDEX,
    });
  });

  it("refuses a duplicate whose holder is deactivated", async () => {
    await seedAccount({ id: 97533, code: "EC-0033", status: 0 });
    await expect(seedAccount({ id: 97534, code: "EC-0033" })).rejects.toMatchObject({ code: "23505" });
  });

  it("ignores deleted accounts, user_type 1 and blank codes", async () => {
    await seedAccount({ id: 97535, code: "EC-0035", is_deleted: 1 });
    await seedAccount({ id: 97536, code: "EC-0035" });
    await seedAccount({ id: 97537, code: "EC-0037", user_type: 1 });
    await seedAccount({ id: 97538, code: "EC-0037" });
    await seedAccount({ id: 97539, code: "" });
    await seedAccount({ id: 97540, code: "  " });
  });
});

describe("the migration", () => {
  // On its own connection: a failure inside the file's BEGIN leaves that
  // session in an aborted transaction, which must not go back to the pool.
  const runMigration = () =>
    db.task(async (t) => {
      try {
        await t.none(fs.readFileSync(MIGRATION, "utf8"));
      } catch (err) {
        await t.none("ROLLBACK");
        throw err;
      }
    });
  let indexDef;
  beforeEach(async () => {
    indexDef = await dropEmployeeCodeIndex();
  });
  afterEach(async () => {
    await db.none("DELETE FROM tbl_users WHERE id BETWEEN $1 AND $2", [ID_MIN, ID_MAX]);
    await restoreEmployeeCodeIndex(indexDef);
  });

  it("refuses to run while a duplicate remains, naming it, and adds nothing", async () => {
    await seedAccount({ id: 97541, code: "EC-0041" });
    await seedAccount({ id: 97542, code: "ec-0041 ", status: 0 });
    await expect(runMigration()).rejects.toThrow(/EC-0041.*97541.*97542/);
    expect(await employeeCodeIndexDef()).toBeNull();
  });

  it("adds the index on clean data, and is safe to run twice", async () => {
    await runMigration();
    expect(await employeeCodeIndexDef()).not.toBeNull();
    await runMigration();
    expect(await employeeCodeIndexDef()).not.toBeNull();
  });
});
