// End-to-end verification of the negotiation round conflict guard.
//
// Drives the REAL server process over real HTTP (default :8099) against a real
// Postgres — full middleware chain, not supertest. Reproduces the state that
// blocked RFQ #536326: a round stuck in PENDING_APPROVAL because one of three
// ALL-rule approvers never acted.
//
// Usage:  node scripts/e2e_negotiation_conflict_verify.mjs
// Env:    E2E_BASE (default http://localhost:8099), DATABASE_NAME

import JWT from "jsonwebtoken";
import Cryptr from "cryptr";
import pgPromise from "pg-promise";
import Config from "../app/config/app.config.js";
import { IDS } from "../tests/fixtures/ids.js";

const BASE = process.env.E2E_BASE || "http://localhost:8099";
const DB_NAME = process.env.DATABASE_NAME || "hospitality_test_e2eguard";
const UA = "e2e-neg-agent";

const pgp = pgPromise();
const db = pgp({
  host: "localhost", port: 5432, database: DB_NAME,
  user: process.env.DATABASE_USERNAME || "apple",
});
const cryptr = new Cryptr(Config.cryptR.secret);

const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

async function token(userId) {
  await db.none(`UPDATE tbl_users SET user_agent=$1 WHERE id=$2`, [UA, userId]);
  const u = await db.one(`SELECT id,name FROM tbl_users WHERE id=$1`, [userId]);
  const now = Math.round(Date.now() / 1000);
  return JWT.sign({
    iss: "Des Technico", sub: cryptr.encrypt(String(u.id)), name: u.name,
    session: "", user: true, ag: cryptr.encrypt(UA), iat: now, exp: now + 3600,
  }, Config.jwt.secret);
}

async function api(method, path, { userId, body } = {}) {
  const headers = { "Content-Type": "application/json", "User-Agent": UA };
  if (userId) headers.Authorization = `Bearer ${await token(userId)}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

const expect200 = (res, label) => record(label, res.status === 200, `HTTP ${res.status}`);

const naive = (ms) => new Date(Date.now() + ms).toISOString().replace("T", " ").slice(0, 19);

/**
 * The negotiation routes sit behind `acl([2, 8])`, which reads
 * tbl_users.user_type. The shared fixtures deliberately leave it NULL, so
 * every request 403s before the controller is even reached — and a security
 * assertion written against that would pass vacuously. Set it the way
 * production does: 2 = Buyer.
 */
async function ensureBuyerUserType() {
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[]) AND user_type IS DISTINCT FROM 2`,
    [[BUYER, IDS.users.a1_proc_commApp]]);
}

async function seedRfq() {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq (rfq_no, comment, company_name, response_email, contact_name,
        contact_number, bid_end_date, location, is_published, created_by, updated_by,
        status, hospitality_company_id, hotel_id, process_id, title, publish_attempts)
     VALUES ((SELECT COALESCE(MAX(rfq_no),500000)+1 FROM tbl_rfq),'','E2E Co','e2e@x.com',
        'E2E','9999999999',$1,'Mumbai',1,$2,$2,1,$3,$4,$5,'E2E conflict guard',0)
     RETURNING id, rfq_no`,
    [naive(-86400_000), BUYER, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1]
  );
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap,
        product_variant_id, variant) VALUES ($1,'','','','','',1,0) RETURNING id`,
    [rfq.id]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1,1,$2,0)`, [rfq.id, VENDOR]
  );
  return { rfq, rp };
}

const createRound = (rfq, rp, target, endIso) =>
  api("POST", "/api/v1/negotiation/rounds", {
    userId: BUYER,
    body: {
      rfq_id: rfq.id, rfq_product_id: rp.id,
      end_date: endIso || new Date(Date.now() + 2 * 86400_000).toISOString(),
      vendor_targets: [{ vendor_id: VENDOR, fields: [{ name: "base_price", target }] }],
    },
  });

const roundsOf = (rfqId) =>
  db.any(`SELECT id,status,end_date FROM tbl_negotiation_rounds WHERE rfq_id=$1 ORDER BY id`, [rfqId]);

async function main() {
  console.log(`\nE2E negotiation conflict guard — ${BASE} / ${DB_NAME}\n`);

  // ── 1. THE REPORTED BLOCK ───────────────────────────────────────────────
  console.log("1. Round stuck awaiting approval (RFQ #536326 shape)");
  await ensureBuyerUserType();
  const { rfq, rp } = await seedRfq();
  {
    const first = await createRound(rfq, rp, 64000);
    record("round 1 is created", first.status === 200, `HTTP ${first.status}`);
    const [r] = await roundsOf(rfq.id);
    record("it sits in PENDING_APPROVAL", r?.status === "PENDING_APPROVAL", `status = ${r?.status}`);

    const second = await createRound(rfq, rp, 60000);
    record("an overlapping round is refused", second.status === 400, `HTTP ${second.status}`);
    record("it is NOT described as 'active'",
      !/active negotiation round/i.test(second.body?.message || ""),
      `message = ${second.body?.message}`);
    record("it says the round is awaiting approval",
      /awaiting internal approval/i.test(second.body?.message || ""), "");
    record("it says the vendor has not seen it",
      /has not reached the vendor/i.test(second.body?.message || ""), "");
    record("it carries a machine-readable code",
      second.body?.code === "ROUND_AWAITING_APPROVAL", `code = ${second.body?.code}`);
  }

  // ── 2. PAST-DEADLINE PENDING NO LONGER BLOCKS ───────────────────────────
  console.log("\n2. The same round, past its deadline (one-shot closer missed it)");
  {
    const [r] = await roundsOf(rfq.id);
    await db.none(
      `UPDATE tbl_negotiation_rounds SET end_date=(now() AT TIME ZONE 'UTC') - interval '3 hours' WHERE id=$1`,
      [r.id]);

    const approve = await api("POST", `/api/v1/negotiation/rounds/${r.id}/approve`, { userId: IDS.users.a1_proc_commApp, body: {} });
    record("a past-deadline round can no longer be approved into life",
      approve.status === 400 && /deadline has already passed/i.test(approve.body?.message || ""),
      `HTTP ${approve.status} — ${approve.body?.message}`);

    const third = await createRound(rfq, rp, 60000);
    record("a replacement round is now allowed", third.status === 200, `HTTP ${third.status}`);
    record("both rounds exist", (await roundsOf(rfq.id)).length === 2, "");
  }

  // ── 3. THE SWEEPER ──────────────────────────────────────────────────────
  console.log("\n3. Closure sweeper (backstop for the in-memory one-shot job)");
  {
    const rounds = await roundsOf(rfq.id);
    const stale = rounds[0];
    const { runNegotiationRoundClosureSweep } = await import("../app/helper/cronManager.js");
    const outcome = await runNegotiationRoundClosureSweep();
    const after = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [stale.id]);
    record("it closes the overdue round", after.status === "EXPIRED",
      `status = ${after.status}, swept = ${outcome?.swept}`);
    record("EXPIRED, not ENDED — nobody approved it in time", after.status === "EXPIRED", "");
  }

  // ── 4. A LIVE ROUND STILL BLOCKS ────────────────────────────────────────
  console.log("\n4. A genuinely live round must still block");
  {
    const { rfq: rfq2, rp: rp2 } = await seedRfq();
    const first = await createRound(rfq2, rp2, 64000);
    record("round 1 created", first.status === 200, `HTTP ${first.status}`);
    const [r] = await roundsOf(rfq2.id);
    const approve = await api("POST", `/api/v1/negotiation/rounds/${r.id}/approve`, { userId: IDS.users.a1_proc_commApp, body: {} });
    record("it is approved to ACTIVE", approve.status === 200, `HTTP ${approve.status}`);

    const second = await createRound(rfq2, rp2, 60000);
    record("the overlapping round is refused", second.status === 400, `HTTP ${second.status}`);
    record("described as LIVE, with an IST deadline",
      second.body?.code === "ROUND_ACTIVE" && /IST/.test(second.body?.message || ""),
      `message = ${second.body?.message}`);
  }

  // ── 5. end_date NORMALISATION ───────────────────────────────────────────
  console.log("\n5. end_date is stored as UTC whatever offset the client sends");
  {
    const { rfq: rfq3, rp: rp3 } = await seedRfq();
    // An IST-offset string. Postgres would otherwise keep the literal digits
    // and the app would read 18:00 as UTC = 23:30 IST — 5h30m too late.
    const target = new Date(Date.now() + 3 * 86400_000);
    const istString = target.toISOString().replace("Z", "+00:00");
    const shifted = new Date(target.getTime() + 5.5 * 3600_000)
      .toISOString().replace("Z", "").replace("T", " ").slice(0, 19) + "+05:30";

    const res = await createRound(rfq3, rp3, 5000, shifted);
    record("round created with a +05:30 deadline", res.status === 200, `HTTP ${res.status} sent=${shifted}`);
    const [r] = await roundsOf(rfq3.id);
    const stored = new Date(String(r.end_date).replace(" ", "T") + "Z").getTime();
    const drift = Math.abs(stored - target.getTime()) / 60000;
    record("stored value equals the intended instant (no 5h30m drift)", drift < 2,
      `stored=${r.end_date}Z intended=${istString} drift=${drift.toFixed(1)} min`);
  }

  // ── 6. WITHDRAW: the creator's way out ──────────────────────────────────
  console.log("\n6. Creator withdraws a stuck round");
  {
    const { rfq: rfq4, rp: rp4 } = await seedRfq();
    expect200(await createRound(rfq4, rp4, 9000), "round 1 created");
    const [r] = await roundsOf(rfq4.id);

    const blocked = await createRound(rfq4, rp4, 8000);
    record("blocked while it waits for approval", blocked.status === 400, `HTTP ${blocked.status}`);

    const byOther = await api("POST", `/api/v1/negotiation/rounds/${r.id}/withdraw`, {
      userId: IDS.users.a1_proc_commApp, body: { remarks: "not mine to withdraw" },
    });
    record("a non-creator cannot withdraw it",
      byOther.status === 403 && /only the buyer who created/i.test(byOther.body?.message || ""),
      `HTTP ${byOther.status} — ${byOther.body?.message}`);

    const noReason = await api("POST", `/api/v1/negotiation/rounds/${r.id}/withdraw`, {
      userId: BUYER, body: { remarks: "  " },
    });
    record("a reason is required", noReason.status === 400, `HTTP ${noReason.status}`);

    const ok = await api("POST", `/api/v1/negotiation/rounds/${r.id}/withdraw`, {
      userId: BUYER, body: { remarks: "approver on leave" },
    });
    record("the creator can withdraw it", ok.status === 200, `HTTP ${ok.status} — ${ok.body?.message}`);

    const after = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [r.id]);
    record("the round is CANCELLED", after.status === "CANCELLED", `status = ${after.status}`);

    const instance = await db.oneOrNone(
      `SELECT status FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id=$1`, [r.id]);
    record("its approval request is cancelled too",
      !instance || instance.status === "CANCELLED", `instance = ${instance?.status ?? "none"}`);

    const unblocked = await createRound(rfq4, rp4, 8000);
    record("the buyer is unblocked", unblocked.status === 200, `HTTP ${unblocked.status}`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${"=".repeat(60)}\nE2E RESULT: ${passed}/${results.length} passed`);
  results.filter((r) => !r.pass).forEach((r) => console.log(`  FAILED: ${r.name} :: ${r.detail}`));
  console.log("=".repeat(60));
  await pgp.end();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await pgp.end(); process.exit(1); });
