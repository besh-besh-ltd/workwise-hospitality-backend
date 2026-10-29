/**
 * GET /rbac/roles exposes which workflow stages each role can approve
 * (holds BOTH read and approve on the stage's resource) and which stages the
 * role's people perform. The admin workflow screen uses these to disable
 * roles that could never act on a stage.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { PERFORMER_ROLE_TITLES } from "../../app/util/roleStageCapabilities.js";

const BUYER_A = IDS.users.a1_proc_buyer;
let originalType;
let customRoleId;
let roles;

const byTitle = (t) => roles.find((r) => r.title === t && r.created_by === null);

beforeAll(async () => {
  ({ user_type: originalType } = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [BUYER_A]));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [BUYER_A]);
  const row = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by)
     VALUES ('Capabilities probe custom role', 'test', $1) RETURNING id`, [BUYER_A]);
  customRoleId = Number(row.id);
  const res = await (await httpClient(BUYER_A)).get("/api/v1/rbac/roles");
  expect(res.status).toBe(200);
  roles = res.body.data;
});

afterAll(async () => {
  await db.none("DELETE FROM tbl_roles WHERE id = $1", [customRoleId]);
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [BUYER_A, originalType]);
  await closeDb();
});

describe("role stage capabilities on GET /rbac/roles", () => {
  it("RFQ Approver can approve RFQ but not TECHNICAL", () => {
    const r = byTitle("RFQ Approver");
    expect(r.approvable_entity_types).toContain("RFQ");
    expect(r.approvable_entity_types).not.toContain("TECHNICAL");
  });

  it("RFQ Creator approves nothing and performs RFQ", () => {
    const r = byTitle("RFQ Creator");
    expect(r.approvable_entity_types).toEqual([]);
    expect(r.performs_entity_types).toEqual(["RFQ"]);
  });

  it("ARC Commercial Evaluator can approve unit and group ARC negotiation", () => {
    const r = byTitle("ARC Commercial Evaluator");
    expect(r.approvable_entity_types).toEqual(
      expect.arrayContaining(["ARC_NEGOTIATION", "ARC_GROUP_NEGOTIATION"]));
  });

  it("never lists INDENT and has no duplicates", () => {
    for (const r of roles) {
      expect(r.approvable_entity_types).not.toContain("INDENT");
      expect(new Set(r.approvable_entity_types).size).toBe(r.approvable_entity_types.length);
    }
  });

  it("custom roles perform nothing", () => {
    const r = roles.find((x) => Number(x.id) === customRoleId);
    expect(r.performs_entity_types).toEqual([]);
    expect(r.approvable_entity_types).toEqual([]);
  });

  it("every PERFORMER_ROLE_TITLES key exists as a system role (rename guard)", () => {
    for (const [title, types] of Object.entries(PERFORMER_ROLE_TITLES)) {
      const r = byTitle(title);
      expect(r).toBeDefined();
      expect(r.performs_entity_types).toEqual(types);
    }
  });
});
