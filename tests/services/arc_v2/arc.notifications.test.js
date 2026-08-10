// ARC Notification Service — behavioural integration tests.
//
// Asserts observable DB state (tbl_notifications) and email side-effects
// produced by notifyArcEvent. All tests use a REAL seeded ARC + REAL Postgres.
// nodemailer is stubbed by jestEnv.js so sendMail resolves without SMTP.
//
// Pattern copies arc.publish.vendors.test.js:
//   - assert tbl_notifications by additional_data->>'arc_id' + recipient_user_id
//   - use seedArcEvalPerms for role seeding
//   - clean up in afterAll
//
// Channel assertion strategy (ESM constraint):
//   ESM module namespaces are read-only and cannot be patched via jest.spyOn.
//   jest.unstable_mockModule with a full-stub factory is used to intercept
//   sendMail. The factory must be registered BEFORE the service is imported.
//   We provide minimal stubs for the functions the service actually uses from
//   common.js (sendMail + logError); the mock is registered before any imports
//   of the service, matching the Jest ESM hoisting requirement.
//
// Test groups:
//   1. Recipient scoping — VENDOR_TECH_SUBMITTED → tech evaluators ONLY
//   2. Self-notify suppression — actor never receives their own notification
//   3. Channel split — light events (no email); important events (email sent)
//   4. Correct audience — CONTRACT_AWAITING_ACCEPTANCE + COMM_EVAL_SENT_BACK
//   5. Edge cases — no recipients → 0 rows, no throw; unknown eventType safe no-op;
//                   user in two audiences gets exactly ONE row

import {
  describe, test, expect, beforeAll, afterAll, beforeEach, jest,
} from "@jest/globals";

// ── Email interception ────────────────────────────────────────────────────────
// Track sendMail calls via a mutable shared tracker. jest.unstable_mockModule
// must be called BEFORE any import that transitively imports common.js.
// We provide stubs only for the two named exports the service uses; all other
// exports from common.js are not needed by the service's import path.
const mailCalls = [];

jest.unstable_mockModule("../../../app/helper/common.js", () => ({
  sendMail: async (opts) => {
    mailCalls.push(opts);
    return { messageId: "<test-mock-mail>" };
  },
  logError: (..._args) => { /* swallow */ },
  // The notificationService.js also imports logError from common.js;
  // we provide it here so the mock is complete for all consumers that
  // load common.js AFTER this mock is registered.
  //
  // Other named exports (acl, noAcl, consoleLogData, …) are not used by
  // the service modules under test; omitting them is fine.
}));

// ── Import service and helpers AFTER mock is registered ──────────────────────
const { notifyArcEvent } = await import("../../../app/services/arcNotificationService.js");
const { ARC_EVENT_TYPES } = await import("../../../app/services/arcEventLogService.js");

import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

// ─── Fixture constants ────────────────────────────────────────────────────────

const BUYER     = IDS.users.a1_proc_buyer;    // ARC creator / actor in most tests
const TECH_EVAL = IDS.users.a1_proc_techEval; // Technical evaluator ONLY (arc-tech perms)
const COMM_EVAL = IDS.users.a1_proc_commEval; // Commercial evaluator ONLY (arc-comm perms)
const HOTEL     = IDS.hotels.A1;
const DEPT      = IDS.departments.proc;
const HC        = IDS.hospitality.A;
const CATEGORY  = TEST_CATEGORIES.beverages;
const PROC      = IDS.processes.A_P1;

// ─── Per-module eval perm seeding ────────────────────────────────────────────
// seedArcEvalPerms from the shared helper assigns BOTH arc-tech AND arc-comm
// perms to BOTH users (same role), which makes each user appear in both
// TECH_EVALUATORS and COMM_EVALUATORS audiences. Instead, seed SEPARATE roles
// so TECH_EVAL holds only arc-tech perms and COMM_EVAL holds only arc-comm.
//
// IDs chosen to not collide with arcEvalPerms.js (95100-95120) or other suites.
const NOTIF_TECH_ROLE_ID  = 95200;
const NOTIF_COMM_ROLE_ID  = 95201;
const NOTIF_PERMS = {
  tech_read:     { id: 95210, resource: "arc-tech", action: "read" },
  tech_evaluate: { id: 95211, resource: "arc-tech", action: "evaluate" },
  comm_read:     { id: 95212, resource: "arc-comm", action: "read" },
  comm_evaluate: { id: 95213, resource: "arc-comm", action: "evaluate" },
};
const NOTIF_SCOPE_TECH = 95220;  // scope row for TECH_EVAL
const NOTIF_SCOPE_COMM = 95221;  // scope row for COMM_EVAL

async function seedNotifEvalPerms() {
  // Permissions
  for (const p of Object.values(NOTIF_PERMS)) {
    await db.none(
      `INSERT INTO tbl_permissions (id, resource, action, ordering)
       VALUES ($1, $2, $3, 0) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.resource, p.action]
    );
  }
  // Roles
  await db.none(
    `INSERT INTO tbl_roles (id, title, description, created_by)
     VALUES ($1, 'Notif Tech Eval', 'arc-tech only, notification test', NULL)
     ON CONFLICT (id) DO NOTHING`, [NOTIF_TECH_ROLE_ID]
  );
  await db.none(
    `INSERT INTO tbl_roles (id, title, description, created_by)
     VALUES ($1, 'Notif Comm Eval', 'arc-comm only, notification test', NULL)
     ON CONFLICT (id) DO NOTHING`, [NOTIF_COMM_ROLE_ID]
  );
  // Assign perms to roles (tech role gets arc-tech only; comm role gets arc-comm only)
  const techPerms = [NOTIF_PERMS.tech_read, NOTIF_PERMS.tech_evaluate];
  const commPerms = [NOTIF_PERMS.comm_read, NOTIF_PERMS.comm_evaluate];
  for (const p of techPerms) {
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, $2 WHERE NOT EXISTS
         (SELECT 1 FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2)`,
      [NOTIF_TECH_ROLE_ID, p.id]
    );
  }
  for (const p of commPerms) {
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, $2 WHERE NOT EXISTS
         (SELECT 1 FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2)`,
      [NOTIF_COMM_ROLE_ID, p.id]
    );
  }
  // Scope tech role to TECH_EVAL user; comm role to COMM_EVAL user
  await db.none(
    `INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
     VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
    [NOTIF_SCOPE_TECH, TECH_EVAL, NOTIF_TECH_ROLE_ID, HC, HOTEL]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
     VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
    [NOTIF_SCOPE_COMM, COMM_EVAL, NOTIF_COMM_ROLE_ID, HC, HOTEL]
  );
}

async function cleanupNotifEvalPerms() {
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE id IN ($1, $2)`, [NOTIF_SCOPE_TECH, NOTIF_SCOPE_COMM]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id IN ($1, $2)`, [NOTIF_TECH_ROLE_ID, NOTIF_COMM_ROLE_ID]);
  await db.none(`DELETE FROM tbl_roles WHERE id IN ($1, $2)`, [NOTIF_TECH_ROLE_ID, NOTIF_COMM_ROLE_ID]);
  await db.none(`DELETE FROM tbl_permissions WHERE id IN ($1, $2, $3, $4)`, [
    NOTIF_PERMS.tech_read.id, NOTIF_PERMS.tech_evaluate.id,
    NOTIF_PERMS.comm_read.id, NOTIF_PERMS.comm_evaluate.id,
  ]);
}

// ─── Shared ARC (draft; no lifecycle transitions needed) ──────────────────────
let sharedArcId;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Fetch notification rows for the shared ARC filtered by event type. */
async function getNotifRows({ arcId = null, type = null } = {}) {
  const id = arcId ?? sharedArcId;
  let query = `SELECT recipient_user_id, type, category, title, additional_data
                 FROM tbl_notifications
                WHERE additional_data->>'arc_id' = $1`;
  const args = [String(id)];
  if (type) {
    const normalized = type.toUpperCase().replace(/-/g, "_");
    query += ` AND type = $2`;
    args.push(normalized);
  }
  return db.any(query, args);
}

/** Delete all notifications for the given arc id. */
async function cleanNotifs(arcId) {
  await db.none(
    `DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`,
    [String(arcId ?? sharedArcId)]
  );
}

/** Create a minimal ARC draft directly via SQL. Returns the inserted arc id. */
async function insertDraftArc() {
  const row = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
        process_id, status, created_by,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at,
        eligibility_type, escalation_clause_json, sub_category_ids)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, 'draft', $8,
        NOW() + INTERVAL '1 day', NOW() + INTERVAL '7 days',
        NOW() + INTERVAL '14 days', NOW() + INTERVAL '200 days',
        'open', '{}'::jsonb, '[]'::jsonb)
     RETURNING id`,
    [
      `TEST-NOTIF-${Date.now()}`,
      "Notifications Test ARC",
      CATEGORY,
      HC,
      HOTEL,
      DEPT,
      PROC,
      BUYER,
    ]
  );
  return row.id;
}

/** Insert a fake tbl_arc_contract row so AWARDED_VENDORS resolves. */
async function insertAwardedVendor(arcId, vendorId) {
  await db.none(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status)
     VALUES ($1, $2, 'awaiting_acceptance')
     ON CONFLICT (arc_id, vendor_id) DO UPDATE SET status = 'awaiting_acceptance'`,
    [arcId, vendorId]
  );
}

/** Delete all tbl_arc_contract rows for an ARC. */
async function deleteContracts(arcId) {
  await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
}

/** Insert a tbl_arc_invitation row so INVITED_VENDORS resolves. */
async function insertInvitation(arcId, vendorId) {
  await db.none(
    `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
     VALUES ($1, $2, 'invited')
     ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
    [arcId, vendorId]
  );
}

async function deleteInvitations(arcId) {
  await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
}

// ─── Global setup / teardown ──────────────────────────────────────────────────

beforeAll(async () => {
  // Ensure buyer and vendor users have the right user_type.
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
  await db.none(
    `UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
    [[IDS.users.vendor_alpha, IDS.users.vendor_beta]]
  );

  // Seed SEPARATE eval perm roles so TECH_EVAL appears ONLY in TECH_EVALUATORS
  // audience and COMM_EVAL appears ONLY in COMM_EVALUATORS audience.
  // (The shared seedArcEvalPerms helper grants both arc-tech + arc-comm to the
  // same role, so both users would appear in both audiences — not useful here.)
  await seedNotifEvalPerms();

  // Category → department mapping (needed for ARC creation).
  await db.none(
    `INSERT INTO tbl_category_department (category_id, department_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [CATEGORY, DEPT]
  );

  sharedArcId = await insertDraftArc();
});

afterAll(async () => {
  if (sharedArcId) {
    await cleanNotifs(sharedArcId);
    await deleteContracts(sharedArcId);
    await deleteInvitations(sharedArcId);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [sharedArcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [sharedArcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [sharedArcId]);
  }
  await cleanupNotifEvalPerms();
  await db.none(
    `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
    [CATEGORY, DEPT]
  );
});

// ─── 1. Recipient scoping ─────────────────────────────────────────────────────

describe("1 — Recipient scoping: VENDOR_TECH_SUBMITTED → tech evaluators ONLY", () => {
  beforeEach(async () => {
    await cleanNotifs(sharedArcId);
    mailCalls.length = 0;
  });

  test("tech evaluator receives a tbl_notifications row (category=ARC, type=VENDOR_TECH_SUBMITTED)", async () => {
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.VENDOR_TECH_SUBMITTED,
      actorId:   IDS.users.vendor_alpha, // vendor is the actor
      payload:   {},
    });

    const rows = await getNotifRows({ type: "VENDOR_TECH_SUBMITTED" });
    const recipientIds = rows.map((r) => Number(r.recipient_user_id));

    expect(recipientIds).toContain(Number(TECH_EVAL));
    for (const row of rows) {
      // Lowercase since the inbox filter groups by category: emitters wrote
      // 'ARC', 'po', 'PO' and 'CALL_OFF', and a filter listing the same module
      // twice under different casings is worse than no filter at all.
      expect(row.category).toBe("arc");
      expect(row.type).toBe("VENDOR_TECH_SUBMITTED");
    }
  });

  test("creator does NOT receive a VENDOR_TECH_SUBMITTED notification", async () => {
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.VENDOR_TECH_SUBMITTED,
      actorId:   IDS.users.vendor_alpha,
      payload:   {},
    });

    const rows = await getNotifRows({ type: "VENDOR_TECH_SUBMITTED" });
    const recipientIds = rows.map((r) => Number(r.recipient_user_id));

    expect(recipientIds).not.toContain(Number(BUYER));
  });

  test("commercial-only user does NOT receive VENDOR_TECH_SUBMITTED", async () => {
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.VENDOR_TECH_SUBMITTED,
      actorId:   IDS.users.vendor_alpha,
      payload:   {},
    });

    const rows = await getNotifRows({ type: "VENDOR_TECH_SUBMITTED" });
    const recipientIds = rows.map((r) => Number(r.recipient_user_id));

    // COMM_EVAL holds arc-comm perms only — must NOT appear in the tech-eval notification.
    expect(recipientIds).not.toContain(Number(COMM_EVAL));
  });

  test("VENDOR_TECH_SUBMITTED is IN-APP only — no email sent", async () => {
    mailCalls.length = 0;
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.VENDOR_TECH_SUBMITTED,
      actorId:   IDS.users.vendor_alpha,
      payload:   {},
    });

    expect(mailCalls).toHaveLength(0);
  });
});

// ─── 2. Self-notify suppression ───────────────────────────────────────────────

describe("2 — Self-notify suppression: actor never gets their own notification", () => {
  beforeEach(async () => {
    await cleanNotifs(sharedArcId);
    mailCalls.length = 0;
  });

  test("when actorId is the creator, creator does NOT receive VENDOR_SUBMITTED notification", async () => {
    // VENDOR_SUBMITTED → creator + comm evaluators (IN-APP).
    // Actor = BUYER (the creator) → BUYER must be suppressed from recipients.
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.VENDOR_SUBMITTED,
      actorId:   BUYER,
      payload:   {},
    });

    const rows = await getNotifRows({ type: "VENDOR_SUBMITTED" });
    const recipientIds = rows.map((r) => Number(r.recipient_user_id));

    expect(recipientIds).not.toContain(Number(BUYER));
  });

  test("when actor is the only recipient, zero rows are created and no error thrown", async () => {
    // Pass recipientsOverride = [BUYER] with actorId = BUYER.
    // Sole recipient = actor → all filtered → zero dispatch.
    await expect(
      notifyArcEvent({
        arcId:              sharedArcId,
        eventType:          ARC_EVENT_TYPES.VENDOR_SUBMITTED,
        actorId:            BUYER,
        payload:            {},
        recipientsOverride: [BUYER],
      })
    ).resolves.toBeUndefined();

    const rows = await getNotifRows({ type: "VENDOR_SUBMITTED" });
    expect(rows).toHaveLength(0);
  });

  test("when actorId equals the tech evaluator, that evaluator is excluded from VENDOR_TECH_SUBMITTED", async () => {
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.VENDOR_TECH_SUBMITTED,
      actorId:   TECH_EVAL, // the tech evaluator IS the actor
      payload:   {},
    });

    const rows = await getNotifRows({ type: "VENDOR_TECH_SUBMITTED" });
    const recipientIds = rows.map((r) => Number(r.recipient_user_id));

    expect(recipientIds).not.toContain(Number(TECH_EVAL));
  });
});

// ─── 3. Channel split ─────────────────────────────────────────────────────────

describe("3 — Channel split: light events = in-app only; important events = in-app + email", () => {
  beforeEach(async () => {
    await cleanNotifs(sharedArcId);
    mailCalls.length = 0;
  });

  // ── Light events (in-app row created, NO email)

  test("VENDOR_SUBMITTED (light) creates a tbl_notifications row", async () => {
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.VENDOR_SUBMITTED,
      actorId:   IDS.users.vendor_alpha,
      payload:   {},
    });

    const rows = await getNotifRows({ type: "VENDOR_SUBMITTED" });
    expect(rows.length).toBeGreaterThan(0);
  });

  test("VENDOR_SUBMITTED (light) does NOT trigger sendMail", async () => {
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.VENDOR_SUBMITTED,
      actorId:   IDS.users.vendor_alpha,
      payload:   {},
    });

    expect(mailCalls).toHaveLength(0);
  });

  test("CONTRACT_GENERATED (light) creates a tbl_notifications row but sends NO email", async () => {
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.CONTRACT_GENERATED,
      actorId:   COMM_EVAL, // actor = comm eval; recipient = creator (BUYER)
      payload:   {},
    });

    const rows = await getNotifRows({ type: "CONTRACT_GENERATED" });
    expect(rows.length).toBeGreaterThan(0);
    expect(mailCalls).toHaveLength(0);
  });

  // ── Very important events (in-app row + email sent)

  test("CONTRACT_AWAITING_ACCEPTANCE (important) creates a tbl_notifications row", async () => {
    await insertAwardedVendor(sharedArcId, IDS.users.vendor_alpha);
    try {
      await notifyArcEvent({
        arcId:     sharedArcId,
        eventType: ARC_EVENT_TYPES.CONTRACT_AWAITING_ACCEPTANCE,
        actorId:   BUYER,
        payload:   {},
      });

      const rows = await getNotifRows({ type: "CONTRACT_AWAITING_ACCEPTANCE" });
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await deleteContracts(sharedArcId);
      await cleanNotifs(sharedArcId);
    }
  });

  test("CONTRACT_AWAITING_ACCEPTANCE (important) triggers sendMail", async () => {
    await insertAwardedVendor(sharedArcId, IDS.users.vendor_alpha);
    try {
      mailCalls.length = 0;
      await notifyArcEvent({
        arcId:     sharedArcId,
        eventType: ARC_EVENT_TYPES.CONTRACT_AWAITING_ACCEPTANCE,
        actorId:   BUYER,
        payload:   {},
      });

      expect(mailCalls.length).toBeGreaterThan(0);
    } finally {
      await deleteContracts(sharedArcId);
      await cleanNotifs(sharedArcId);
    }
  });

  test("CONTRACT_SIGNED (important) creates an in-app row AND triggers sendMail", async () => {
    mailCalls.length = 0;
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.CONTRACT_SIGNED,
      actorId:   IDS.users.vendor_alpha,
      payload:   { vendorId: IDS.users.vendor_alpha },
    });

    const rows = await getNotifRows({ type: "CONTRACT_SIGNED" });
    expect(rows.length).toBeGreaterThan(0);
    // Email goes to creator + comm evaluators (emailAudiences for this event).
    expect(mailCalls.length).toBeGreaterThan(0);
  });
});

// ─── 4. Correct audience for additional events ─────────────────────────────────

describe("4 — Correct audience per event", () => {
  beforeEach(async () => {
    await cleanNotifs(sharedArcId);
    mailCalls.length = 0;
  });

  test("CONTRACT_AWAITING_ACCEPTANCE notifies awarded vendor; creator (actor) is excluded", async () => {
    await insertAwardedVendor(sharedArcId, IDS.users.vendor_alpha);
    try {
      await notifyArcEvent({
        arcId:     sharedArcId,
        eventType: ARC_EVENT_TYPES.CONTRACT_AWAITING_ACCEPTANCE,
        actorId:   BUYER,
        payload:   {},
      });

      const rows = await getNotifRows({ type: "CONTRACT_AWAITING_ACCEPTANCE" });
      const recipientIds = rows.map((r) => Number(r.recipient_user_id));

      expect(recipientIds).toContain(Number(IDS.users.vendor_alpha));
      // BUYER is actor (suppressed) and not in AWARDED_VENDORS audience.
      expect(recipientIds).not.toContain(Number(BUYER));
    } finally {
      await deleteContracts(sharedArcId);
      await cleanNotifs(sharedArcId);
    }
  });

  test("COMM_EVAL_SENT_BACK notifies commercial evaluators (BOTH — in-app + email)", async () => {
    mailCalls.length = 0;
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.COMM_EVAL_SENT_BACK,
      actorId:   BUYER,
      payload:   { reason: "Please re-check pricing" },
    });

    const rows = await getNotifRows({ type: "COMM_EVAL_SENT_BACK" });
    const recipientIds = rows.map((r) => Number(r.recipient_user_id));

    expect(recipientIds).toContain(Number(COMM_EVAL));
    // Creator is actor AND not in comm-evaluators audience.
    expect(recipientIds).not.toContain(Number(BUYER));
    expect(mailCalls.length).toBeGreaterThan(0);
  });

  test("VENDOR_WITHDREW notifies creator (BOTH), not the vendor themselves", async () => {
    mailCalls.length = 0;
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.VENDOR_WITHDREW,
      actorId:   IDS.users.vendor_alpha, // vendor is actor
      payload:   {},
    });

    const rows = await getNotifRows({ type: "VENDOR_WITHDREW" });
    const recipientIds = rows.map((r) => Number(r.recipient_user_id));

    expect(recipientIds).toContain(Number(BUYER));
    expect(recipientIds).not.toContain(Number(IDS.users.vendor_alpha)); // actor
    expect(mailCalls.length).toBeGreaterThan(0);
  });

  test("TECH_EVAL_APPROVED: all three audiences get in-app; email goes to comm + creator only (not tech eval)", async () => {
    mailCalls.length = 0;
    await notifyArcEvent({
      arcId:     sharedArcId,
      eventType: ARC_EVENT_TYPES.TECH_EVAL_APPROVED,
      actorId:   IDS.users.vendor_alpha, // third-party actor, not in any audience
      payload:   {},
    });

    const rows = await getNotifRows({ type: "TECH_EVAL_APPROVED" });
    const recipientIds = rows.map((r) => Number(r.recipient_user_id));

    // All three audience groups get in-app rows.
    expect(recipientIds).toContain(Number(COMM_EVAL));
    expect(recipientIds).toContain(Number(TECH_EVAL));
    expect(recipientIds).toContain(Number(BUYER)); // creator

    // cfg.email = true, so sendMail is called for email-eligible audiences.
    expect(mailCalls.length).toBeGreaterThan(0);

    // Verify tech evaluator's email is NOT in the mail calls
    // (emailAudiences restricts email to COMM_EVALUATORS + CREATOR).
    const techUser = await db.oneOrNone(
      `SELECT email FROM tbl_users WHERE id = $1`,
      [TECH_EVAL]
    );
    if (techUser?.email) {
      const calledEmails = mailCalls.map(
        (c) => (c.to || "").toLowerCase().trim()
      );
      expect(calledEmails).not.toContain(techUser.email.toLowerCase().trim());
    }
  });
});

// ─── 5. Edge cases ─────────────────────────────────────────────────────────────

describe("5 — Edge cases", () => {
  beforeEach(async () => {
    await cleanNotifs(sharedArcId);
    mailCalls.length = 0;
  });

  test("unknown/unconfigured eventType is a safe no-op — zero rows, no throw", async () => {
    await expect(
      notifyArcEvent({
        arcId:     sharedArcId,
        eventType: "totally_unknown_event_type_xyz",
        actorId:   BUYER,
        payload:   {},
      })
    ).resolves.toBeUndefined();

    const rows = await getNotifRows();
    expect(rows).toHaveLength(0);
    expect(mailCalls).toHaveLength(0);
  });

  test("event with no resolvable recipients creates ZERO rows and does NOT throw", async () => {
    // TERMINATED falls back to INVITED_VENDORS when no contracts exist.
    // Use a fresh ARC with neither contracts nor invitations → zero recipients.
    const emptyArcId = await insertDraftArc();
    try {
      await expect(
        notifyArcEvent({
          arcId:     emptyArcId,
          eventType: ARC_EVENT_TYPES.TERMINATED,
          actorId:   BUYER,
          payload:   {},
        })
      ).resolves.toBeUndefined();

      const rows = await db.any(
        `SELECT id FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`,
        [String(emptyArcId)]
      );
      expect(rows).toHaveLength(0);
    } finally {
      await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`, [String(emptyArcId)]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [emptyArcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [emptyArcId]);
    }
  });

  test("non-existent arcId returns early — zero rows, no throw", async () => {
    const nonExistentId = 999999999;
    await expect(
      notifyArcEvent({
        arcId:     nonExistentId,
        eventType: ARC_EVENT_TYPES.VENDOR_SUBMITTED,
        actorId:   BUYER,
        payload:   {},
      })
    ).resolves.toBeUndefined();

    const rows = await db.any(
      `SELECT id FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`,
      [String(nonExistentId)]
    );
    expect(rows).toHaveLength(0);
  });

  test("user appearing in two audience slots gets exactly ONE in-app row (dedup)", async () => {
    // Pass COMM_EVAL three times via recipientsOverride; dedupeUsers must collapse to 1.
    await notifyArcEvent({
      arcId:              sharedArcId,
      eventType:          ARC_EVENT_TYPES.VENDOR_SUBMITTED,
      actorId:            IDS.users.vendor_alpha,
      payload:            {},
      recipientsOverride: [COMM_EVAL, COMM_EVAL, COMM_EVAL],
    });

    const rows = await getNotifRows({ type: "VENDOR_SUBMITTED" });
    const commEvalRows = rows.filter(
      (r) => Number(r.recipient_user_id) === Number(COMM_EVAL)
    );
    expect(commEvalRows).toHaveLength(1);
  });

  test("recipientsOverride = [] (empty array) creates ZERO rows without throwing", async () => {
    await expect(
      notifyArcEvent({
        arcId:              sharedArcId,
        eventType:          ARC_EVENT_TYPES.VENDOR_SUBMITTED,
        actorId:            BUYER,
        payload:            {},
        recipientsOverride: [],
      })
    ).resolves.toBeUndefined();

    const rows = await getNotifRows({ type: "VENDOR_SUBMITTED" });
    expect(rows).toHaveLength(0);
  });

  test("EVENT_VENDOR with a non-existent vendorId creates ZERO rows — does not throw", async () => {
    await expect(
      notifyArcEvent({
        arcId:     sharedArcId,
        eventType: ARC_EVENT_TYPES.CONTRACT_OTP_REQUESTED,
        actorId:   BUYER,
        payload:   { vendorId: 999999888 }, // non-existent user
      })
    ).resolves.toBeUndefined();

    const rows = await getNotifRows({ type: "CONTRACT_OTP_REQUESTED" });
    expect(rows).toHaveLength(0);
  });

  test("TERMINATED ARC with no contracts falls back to invited vendors", async () => {
    // No contracts on sharedArcId; add one invitation → service falls back.
    await insertInvitation(sharedArcId, IDS.users.vendor_alpha);
    try {
      await notifyArcEvent({
        arcId:     sharedArcId,
        eventType: ARC_EVENT_TYPES.TERMINATED,
        actorId:   BUYER,
        payload:   {},
      });

      const rows = await getNotifRows({ type: "TERMINATED" });
      const recipientIds = rows.map((r) => Number(r.recipient_user_id));

      // The invited vendor (fallback from AWARDED_VENDORS) should be notified.
      expect(recipientIds).toContain(Number(IDS.users.vendor_alpha));
    } finally {
      await deleteInvitations(sharedArcId);
      await cleanNotifs(sharedArcId);
    }
  });
});
