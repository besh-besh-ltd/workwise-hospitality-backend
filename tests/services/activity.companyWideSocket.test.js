/**
 * A company-wide event reaches each watching administrator once.
 *
 * Socket rooms are per hospitality company, and an administrator's socket
 * joins every room under their buyer company. Emitting a company-wide event
 * room by room therefore delivered it once per hospitality company — eight
 * times to Phileein's admin on the restored production copy — and each frame
 * makes the Activity page refetch. One emit addressed to all the rooms is
 * de-duplicated per socket by socket.io itself.
 *
 * This runs a real socket.io server (the app's own SocketConfig) and plants a
 * socket in the rooms the way `activity:subscribe` would, then counts what the
 * engine is actually asked to write to it.
 *
 * Isolation: Pattern B (commit + cleanup) — capture writes on its own
 * connection after the response.
 */
import http from "http";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { SocketConfig, getIo, emitToCompanies } from "../../app/util/socket.js";

const ADMIN = 80062; // company A administrator, no mapping (like prod user 150)
const BUYER_A = IDS.companies.A;
const SECOND_HOSPITALITY = 10091; // a second hospitality company under buyer A

let server;
let frames;

const plantSocket = (rooms) => {
  const nsp = getIo().of("/");
  const id = "activity-probe-socket";
  frames = [];
  nsp.sockets.set(id, {
    id,
    client: { writeToEngine: (packets) => frames.push(...packets) },
  });
  nsp.adapter.addAll(id, new Set(rooms));
  return () => {
    nsp.adapter.delAll(id);
    nsp.sockets.delete(id);
  };
};

const activityFrames = () => frames.filter((f) => String(f).includes("activity:new"));

beforeAll(async () => {
  server = http.createServer();
  SocketConfig(server);

  await db.none(`DELETE FROM tbl_activity_events WHERE actor_user_id = $1`, [ADMIN]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id IN (SELECT id FROM tbl_roles WHERE created_by = $1)`, [ADMIN]);
  await db.none(`DELETE FROM tbl_roles WHERE created_by = $1`, [ADMIN]);
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [ADMIN]);
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Socket Admin A', 'socket.admin.a@capture.test', 1, 7, $2, now(), now())`,
    [ADMIN, BUYER_A]
  );
  await db.none(`DELETE FROM tbl_hospitality_companies WHERE id = $1`, [SECOND_HOSPITALITY]);
  await db.none(
    `INSERT INTO tbl_hospitality_companies (id, name, buyer_company_id, is_deleted)
     VALUES ($1, 'Company A Second Entity', $2, 0)`,
    [SECOND_HOSPITALITY, BUYER_A]
  );
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_activity_events WHERE actor_user_id = $1`, [ADMIN]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id IN (SELECT id FROM tbl_roles WHERE created_by = $1)`, [ADMIN]);
  await db.none(`DELETE FROM tbl_roles WHERE created_by = $1`, [ADMIN]);
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [ADMIN]);
  await db.none(`DELETE FROM tbl_hospitality_companies WHERE id = $1`, [SECOND_HOSPITALITY]);
  await new Promise((resolve) => getIo().close(() => resolve()));
  await closeDb();
});

describe("company-wide activity over the socket", () => {
  it("emitToCompanies delivers one frame to a socket that is in every room", () => {
    const remove = plantSocket(["company:1", "company:2", "company:3"]);
    try {
      emitToCompanies([1, 2, 3], "activity:new", { id: 1 });
      expect(activityFrames()).toHaveLength(1);
    } finally {
      remove();
    }
  });

  it("a company-wide admin event reaches an admin watching every entity once", async () => {
    const rooms = (
      await db.any(
        `SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1 AND is_deleted = 0`,
        [BUYER_A]
      )
    ).map((r) => `company:${r.id}`);
    // Pinned: with one room this would pass for the wrong reason.
    expect(rooms.length).toBeGreaterThanOrEqual(2);

    const remove = plantSocket(rooms);
    try {
      const perm = await db.one(
        `SELECT id FROM tbl_permissions WHERE resource::text = 'rfq' AND action::text = 'read' LIMIT 1`
      );
      const client = await httpClient(ADMIN);
      const res = await client.post("/api/v1/rbac/roles")
        .send({ title: "Socket Probe Role", description: "probe", permission_ids: [perm.id] });
      expect(res.status).toBe(201);

      const deadline = Date.now() + 5000;
      while (activityFrames().length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 400));
      expect(activityFrames()).toHaveLength(1);
    } finally {
      remove();
    }
  });
});
