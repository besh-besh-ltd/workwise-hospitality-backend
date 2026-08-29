/**
 * "While I am away, X covers my approvals" (T1).
 *
 * The platform already ships a system role literally titled "Proxy Approver" —
 * five permissions, zero holders, zero policy steps referencing it, and no
 * delegation semantics anywhere in the code. A name promising cover the system
 * does not provide.
 *
 * The design decision worth testing is *where* cover is applied: at approver
 * resolution, which happens as an approval instance is created. That is what
 * makes it forward-only by construction rather than by a rule somebody has to
 * remember — an approval that already exists keeps the approvers it was created
 * with, and moving one of those is reassignment, a different action.
 *
 * The rest is the three ways cover could quietly move authority somewhere the
 * role model would not have put it, each refused.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { resolveApprovers } from "../../app/models/generalModel.js";

const AWAY = IDS.users.a1_proc_poApp;
const COVER = IDS.users.a1_proc_commApp;
const OUTSIDER = IDS.users.companyB_admin;
const ADMIN = IDS.users.companyA_admin;
const URL = "/api/v1/general/hospitality/approval/delegations";

const made = [];
let restoreAdminType;
let restoreOutsiderType;

const hours = (n) => new Date(Date.now() + n * 3600_000).toISOString();

const arrange = async ({
  delegator = AWAY,
  delegate = COVER,
  startsAt = hours(-1),
  endsAt = hours(48),
} = {}) => {
  const row = await db.one(
    `INSERT INTO tbl_approval_delegations
            (delegator_user_id, delegate_user_id, starts_at, ends_at, reason, created_by)
     VALUES ($1, $2, $3, $4, 'On leave', $5) RETURNING id`,
    [delegator, delegate, startsAt, endsAt, ADMIN]
  );
  made.push(Number(row.id));
  return Number(row.id);
};

// A USER-source step naming the person who is away. resolveApprovers is the
// single point cover is applied at, so this is the honest way to test it.
const stepFor = (userId) => ({
  approver_source_type: "USER",
  approver_source_id: userId,
});

const resolveFor = (userId) =>
  resolveApprovers(stepFor(userId), IDS.hospitality.A, IDS.hotels.A1);

beforeAll(async () => {
  ({ user_type: restoreAdminType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]
  ));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
  // Company B's administrator is a real administrator, so the cross-tenant
  // test below turns on the scoping rather than on the role gate — otherwise
  // it would pass on a 403 and prove nothing about tenancy.
  ({ user_type: restoreOutsiderType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1", [OUTSIDER]
  ));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [OUTSIDER]);
});

afterEach(async () => {
  if (made.length) {
    await db.none("DELETE FROM tbl_approval_delegations WHERE id = ANY($1::int[])", [made]);
    made.length = 0;
  }
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreAdminType]);
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [OUTSIDER, restoreOutsiderType]);
  await db.none("UPDATE tbl_users SET status = 1 WHERE id = $1", [COVER]);
  await closeDb();
});

describe("who gets asked while someone is away", () => {
  it("asks the person who is away when nobody is covering", async () => {
    expect(await resolveFor(AWAY)).toContain(AWAY);
  });

  it("asks the person covering instead, not as well", async () => {
    // Substitution, not addition. "I am away" means the approval should go to
    // the other person; adding them would leave an ALL step waiting on
    // somebody who is on a beach.
    await arrange();
    const resolved = await resolveFor(AWAY);
    expect(resolved).toContain(COVER);
    expect(resolved).not.toContain(AWAY);
  });

  it("stops covering the moment the window closes", async () => {
    await arrange({ startsAt: hours(-48), endsAt: hours(-1) });
    expect(await resolveFor(AWAY)).toContain(AWAY);
  });

  it("does not start covering before the window opens", async () => {
    await arrange({ startsAt: hours(24), endsAt: hours(48) });
    expect(await resolveFor(AWAY)).toContain(AWAY);
  });

  it("stops covering when the arrangement is ended early", async () => {
    const id = await arrange();
    await db.none("UPDATE tbl_approval_delegations SET revoked_at = now() WHERE id = $1", [id]);
    expect(await resolveFor(AWAY)).toContain(AWAY);
  });
});

describe("what cover refuses to do", () => {
  it("does not follow a chain", async () => {
    // A to B, B to C. Following it would land an approval on somebody who has
    // no idea it is theirs.
    await arrange({ delegator: AWAY, delegate: COVER });
    await arrange({ delegator: COVER, delegate: IDS.users.a1_proc_finance });

    const resolved = await resolveFor(AWAY);
    expect(resolved).toContain(COVER);
    expect(resolved).not.toContain(IDS.users.a1_proc_finance);
  });

  it("does not reach outside the company", async () => {
    // Otherwise cover is a way to hand another company's approvals to your own
    // staff, and vice versa.
    await arrange({ delegator: AWAY, delegate: OUTSIDER });
    const resolved = await resolveFor(AWAY);
    expect(resolved).toContain(AWAY);
    expect(resolved).not.toContain(OUTSIDER);
  });

  it("does not empty a step when the person covering is switched off", async () => {
    // A step resolving to nobody makes the whole instance throw
    // APPROVAL_POLICY_RESOLVES_TO_NOBODY, so a stale delegation would stop a
    // purchase order being raised at all.
    await arrange();
    await db.none("UPDATE tbl_users SET status = 0 WHERE id = $1", [COVER]);
    try {
      const resolved = await resolveFor(AWAY);
      expect(resolved).toContain(AWAY);
      expect(resolved).not.toContain(COVER);
    } finally {
      await db.none("UPDATE tbl_users SET status = 1 WHERE id = $1", [COVER]);
    }
  });
});

describe("arranging it", () => {
  it("lets somebody arrange their own", async () => {
    const client = await httpClient(AWAY);
    const res = await client.post(URL).send({
      delegate_user_id: COVER,
      starts_at: hours(1),
      ends_at: hours(72),
      reason: "Annual leave",
    });
    expect(res.status).toBe(200);
    made.push(Number(res.body.data.id));
  });

  it("stops somebody arranging cover for another person", async () => {
    // Otherwise anybody could route a colleague's approvals to themselves.
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post(URL).send({
      delegator_user_id: AWAY,
      delegate_user_id: COVER,
      starts_at: hours(1),
      ends_at: hours(72),
    });
    expect(res.status).toBe(403);
  });

  it("lets an administrator arrange it for somebody who left suddenly", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.post(URL).send({
      delegator_user_id: AWAY,
      delegate_user_id: COVER,
      starts_at: hours(1),
      ends_at: hours(72),
    });
    expect(res.status).toBe(200);
    made.push(Number(res.body.data.id));
  });

  it("refuses a second, overlapping arrangement", async () => {
    // Two overlapping windows would make "who is covering" ambiguous at the
    // moment an approval is resolved, and the resolver must never have to pick.
    await arrange({ startsAt: hours(1), endsAt: hours(72) });
    const client = await httpClient(ADMIN);
    const res = await client.post(URL).send({
      delegator_user_id: AWAY,
      delegate_user_id: IDS.users.a1_proc_finance,
      starts_at: hours(48),
      ends_at: hours(96),
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OVERLAPPING_DELEGATION");
  });

  it("allows a second arrangement that does not overlap", async () => {
    await arrange({ startsAt: hours(1), endsAt: hours(24) });
    const client = await httpClient(ADMIN);
    const res = await client.post(URL).send({
      delegator_user_id: AWAY,
      delegate_user_id: IDS.users.a1_proc_finance,
      starts_at: hours(25),
      ends_at: hours(48),
    });
    expect(res.status).toBe(200);
    made.push(Number(res.body.data.id));
  });

  it("refuses a window that has already ended", async () => {
    // Cover is applied when an approval is created, so a window entirely in
    // the past could only ever be a fiction in the record.
    const client = await httpClient(ADMIN);
    const res = await client.post(URL).send({
      delegator_user_id: AWAY,
      delegate_user_id: COVER,
      starts_at: hours(-72),
      ends_at: hours(-24),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WINDOW_IN_THE_PAST");
  });

  it("refuses somebody covering for themselves", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.post(URL).send({
      delegator_user_id: AWAY,
      delegate_user_id: AWAY,
      starts_at: hours(1),
      ends_at: hours(72),
    });
    expect(res.status).toBe(400);
  });
});

describe("ending it", () => {
  it("keeps the record rather than deleting it", async () => {
    // "Who was covering on the 14th" has to stay answerable after somebody
    // comes back sooner than planned.
    const id = await arrange();
    const client = await httpClient(ADMIN);
    expect((await client.delete(`${URL}/${id}`)).status).toBe(200);

    const row = await db.one(
      "SELECT revoked_at, revoked_by FROM tbl_approval_delegations WHERE id = $1", [id]
    );
    expect(row.revoked_at).not.toBeNull();
    expect(Number(row.revoked_by)).toBe(ADMIN);
  });

  it("does not let another company's admin end it", async () => {
    // 404 rather than 403: an administrator of another tenant should not be
    // able to learn that this arrangement exists at all.
    const id = await arrange();
    const client = await httpClient(OUTSIDER);
    expect((await client.delete(`${URL}/${id}`)).status).toBe(404);
  });

  it("does not let a colleague end somebody else's", async () => {
    const id = await arrange();
    const client = await httpClient(IDS.users.a1_proc_buyer);
    expect((await client.delete(`${URL}/${id}`)).status).toBe(403);
  });
});
