/**
 * Client role terminology (2026-10-19): the system roles carry the client's
 * vocabulary, 'Proxy Approver' is gone, and re-applying the migrations is a
 * no-op. Titles are read live from tbl_roles by every screen, so the DB state
 * and GET /rbac/roles are what the user sees.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const BUYER_A = IDS.users.a1_proc_buyer;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let originalType;

const NEW = {
  "RFQ Creator": "Creates and edits RFQs",
  "RFQ Approver": "Approves RFQs before they are published to vendors",
  "Commercial Evaluator":
    "Evaluates quotes, runs negotiation rounds, approves colleagues' rounds and co-signs the final vendor",
  "Commercial Approver": "Approves the final vendor and price before the PO",
  "ARC Technical Evaluator": "Evaluates the technical responses on Annual Rate Contracts.",
  "ARC Commercial Evaluator":
    "Runs commercial evaluation and negotiation rounds on Annual Rate Contracts and approves colleagues' rounds",
  "ARC Commercial Approver": "Manager sign-off on ARC negotiation rounds where a workflow names this role",
};
const GONE = [
  "Tender Approver",
  "Commercial Negotiator N1",
  "ARC Tech Evaluator",
  "ARC Negotiation Approver",
  "Proxy Approver",
];

const systemRoles = () =>
  db.any(`SELECT id, title, description, created_by FROM tbl_roles WHERE created_by IS NULL ORDER BY id`);
const permissionRows = () =>
  db.any(`SELECT role_id, permission_id FROM tbl_role_permissions ORDER BY id`);

beforeAll(async () => {
  const r = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [BUYER_A]);
  originalType = r.user_type;
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [BUYER_A]);
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [BUYER_A, originalType]);
  await closeDb();
});

describe("client role terminology", () => {
  it("system roles carry the new titles and descriptions", async () => {
    const roles = await systemRoles();
    for (const [title, description] of Object.entries(NEW)) {
      const matches = roles.filter((r) => r.title === title);
      expect(matches).toHaveLength(1);
      expect(matches[0].description).toBe(description);
    }
  });

  it("no system role keeps a retired title", async () => {
    const titles = (await systemRoles()).map((r) => r.title);
    GONE.forEach((t) => expect(titles).not.toContain(t));
  });

  it("GET /rbac/roles shows 'RFQ Approver' and not 'Proxy Approver'", async () => {
    const res = await (await httpClient(BUYER_A)).get("/api/v1/rbac/roles");
    expect(res.status).toBe(200);
    const titles = (res.body.data || []).map((r) => r.title);
    expect(titles).toContain("RFQ Approver");
    expect(titles).not.toContain("Proxy Approver");
    expect(titles).not.toContain("Tender Approver");
  });

  it("the retired role leaves no permission grants behind", async () => {
    const orphans = await db.one(
      `SELECT count(*)::int AS n FROM tbl_role_permissions rp
        WHERE NOT EXISTS (SELECT 1 FROM tbl_roles r WHERE r.id = rp.role_id)`
    );
    expect(orphans.n).toBe(0);
  });

  it("re-applying both migrations changes nothing", async () => {
    const rolesBefore = await systemRoles();
    const permsBefore = await permissionRows();
    for (const f of [
      "20261019100000_client_role_terminology.sql",
      "20261019100100_retire_proxy_approver.sql",
    ]) {
      await db.none(fs.readFileSync(path.join(__dirname, "../../migrations", f), "utf8"));
    }
    expect(await systemRoles()).toEqual(rolesBefore);
    expect(await permissionRows()).toEqual(permsBefore);
  });
});
