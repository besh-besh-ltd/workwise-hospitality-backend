// Seeds the ARC publish approval policy the create flow needs so publishing an
// ARC stops 400-ing "No approval policy configured…". Idempotent — safe to re-run.
//
//   node scripts/seed_arc_publish_policy.js [hotelId] [approverUserId]
//   node scripts/seed_arc_publish_policy.js 30 412
//
// Defaults target Burj Al Arab (hotel 30, hospitality company 13) with Vineet II
// (user 412) as the sole ANY approver — a REAL approval gate (412 ≠ the creator).
//
// ── Root cause ───────────────────────────────────────────────────────────────
// arcController.publish() resolves the policy via findBestMatchingPolicyTx
// (generalModel.js) with the ARC's process_id. The ARC create flow inserts
// process_id = NULL by design (audit H5). The matcher reduces to
// `process_id IS NULL` when the ARC's process is NULL, so it can ONLY match
// process-NULL policies. Every existing ARC policy for hospitality company 13
// (ids 172/194/196) carries a NON-NULL process_id, so the matcher finds nothing
// → hard 400. This script seeds the ONE missing process-NULL ARC policy for
// (company 13, hotel 30), which fixes the match without touching the H5 design.
//
// Safe for production: a single INSERT pair (policy + step) guarded by a
// find-or-skip check. It never UPDATEs or DELETEs an existing policy, and never
// widens tenant exposure beyond (hospitality company 13, hotel 30).

import db from '../app/config/dbConn.js';

// Fixed tenant scope for the default Burj Al Arab seed. We do NOT trust a
// CLI-passed company id — the hotel→company mapping is the source of truth.
const HOSPITALITY_COMPANY_ID = 13; // Workwise Hotels (owns Burj Al Arab / hotel 30)
const LEGACY_COMPANY_ID = 90;      // parent buyer company_id (mirrors existing rows)
const CREATED_BY = 426;            // KUS404 (Kushal Shah) — the ARC creator/operator

async function main() {
  const hotelId = Number(process.argv[2] || 30);
  const approverUserId = Number(process.argv[3] || 412); // Vineet II

  if (!hotelId || !approverUserId) {
    console.error('Usage: node scripts/seed_arc_publish_policy.js [hotelId=30] [approverUserId=412]');
    process.exit(1);
  }

  console.log(`Seeding ARC publish policy → hotel ${hotelId}, approver user ${approverUserId}`);

  await db.tx(async (t) => {
    // 1. Verify hotel → hospitality company mapping (never trust a passed company).
    const hotel = await t.oneOrNone(
      `SELECT id, hospitality_company_id, name
         FROM tbl_hospitality_company_hotels
        WHERE id = $1`,
      [hotelId]
    );
    if (!hotel) {
      throw new Error(`No hotel with id ${hotelId}`);
    }
    if (Number(hotel.hospitality_company_id) !== HOSPITALITY_COMPANY_ID) {
      throw new Error(
        `Hotel ${hotelId} belongs to hospitality company ${hotel.hospitality_company_id}, ` +
        `not ${HOSPITALITY_COMPANY_ID}. Refusing to seed a policy outside the expected scope.`
      );
    }
    console.log(`  hotel: #${hotel.id} ${hotel.name || ''} → hospitality company ${hotel.hospitality_company_id}`);

    // 2. Verify the approver is a real, active user.
    const approver = await t.oneOrNone(
      `SELECT id, name, email, status FROM tbl_users WHERE id = $1`,
      [approverUserId]
    );
    if (!approver) {
      throw new Error(`No user with id ${approverUserId}`);
    }
    if (Number(approver.status) !== 1) {
      throw new Error(`Approver #${approverUserId} (${approver.name}) is not active (status ${approver.status}).`);
    }
    if (Number(approver.id) === CREATED_BY) {
      throw new Error(`Approver #${approverUserId} is the ARC creator — that would be self-approval. Pick a real approver.`);
    }
    console.log(`  approver: #${approver.id} ${approver.name} <${approver.email}> (status ${approver.status})`);

    // 2b. ENFORCE that this approver actually RESOLVES — otherwise the engine's
    //     resolveApprovers() skips the step and createApprovalInstance silently
    //     AUTO-APPROVES (creator-only), defeating the gate. Mirror the engine's
    //     two USER-step conditions: (a) hospitality access to (company, hotel),
    //     and (b) a role scope covering this hotel for ALL departments (dept
    //     NULL) — ARCs at this hotel can use any department, so a dept-NULL
    //     scope is required to guarantee the gate holds for every ARC.
    const hasAccess = await t.oneOrNone(
      `SELECT 1 FROM tbl_hospitality_user_mappings
        WHERE user_id = $1 AND hospitality_company_id = $2
          AND ( (mapping_type = 1 AND hospitality_hotel_id = $3)
                OR (mapping_type = 0 AND hospitality_hotel_id IS NULL) )
        LIMIT 1`,
      [approverUserId, HOSPITALITY_COMPANY_ID, hotelId]
    );
    if (!hasAccess) {
      throw new Error(
        `Approver #${approverUserId} has no hospitality mapping covering (company ${HOSPITALITY_COMPANY_ID}, hotel ${hotelId}). ` +
        `The engine would skip this step and auto-approve — refusing to seed a non-gating policy.`
      );
    }
    const hasAllDeptScope = await t.oneOrNone(
      `SELECT 1 FROM tbl_user_role_scopes
        WHERE user_id = $1 AND company_id = $2
          AND (hotel_id IS NULL OR hotel_id = $3)
          AND department_id IS NULL
        LIMIT 1`,
      [approverUserId, HOSPITALITY_COMPANY_ID, hotelId]
    );
    if (!hasAllDeptScope) {
      throw new Error(
        `Approver #${approverUserId} lacks an all-departments role scope (department_id IS NULL) for ` +
        `(company ${HOSPITALITY_COMPANY_ID}, hotel ${hotelId}). Without it the engine may skip the step for some ` +
        `ARC departments and silently auto-approve. Grant the approver a dept-NULL role scope, then re-run.`
      );
    }
    console.log(`  ✓ approver resolves: hospitality access + all-department role scope present (real gate guaranteed).`);

    // 3. Idempotency guard — a process-NULL ARC policy for (company 13, hotel 30,
    //    department NULL) already covers this scope. Skip + log; do NOT duplicate.
    const existing = await t.oneOrNone(
      `SELECT id FROM tbl_approval_policies
        WHERE entity_type = 'ARC'
          AND hospitality_company_id = $1
          AND hotel_id = $2
          AND department_id IS NULL
          AND process_id IS NULL
          AND is_active = true
        LIMIT 1`,
      [HOSPITALITY_COMPANY_ID, hotelId]
    );
    if (existing) {
      console.log(`  = ARC publish policy already exists (#${existing.id}) for (company ${HOSPITALITY_COMPANY_ID}, hotel ${hotelId}, dept NULL, process NULL). Skipping — nothing inserted.`);
      return;
    }

    // 4. Insert the policy.
    const policy = await t.one(
      `INSERT INTO tbl_approval_policies
         (entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped,
          version, company_id, is_global)
       VALUES ('ARC', $1, $2, NULL, true, $3, NULL, false, false, 1, $4, 0)
       RETURNING id`,
      [HOSPITALITY_COMPANY_ID, hotelId, CREATED_BY, LEGACY_COMPANY_ID]
    );
    console.log(`  + inserted policy #${policy.id} (entity_type=ARC, company=${HOSPITALITY_COMPANY_ID}, hotel=${hotelId}, dept=NULL, process=NULL)`);

    // 5. Insert the single approval step.
    const step = await t.one(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, approval_type, decision_rule,
          approver_source_type, approver_source_id)
       VALUES ($1, 1, 'STANDARD', 'ANY', 'USER', $2)
       RETURNING id`,
      [policy.id, approverUserId]
    );
    console.log(`  + inserted step #${step.id} (step_order=1, STANDARD, ANY, USER → ${approverUserId})`);

    console.log(`Done. Policy #${policy.id} with step #${step.id} now matches ARC publish for (company ${HOSPITALITY_COMPANY_ID}, hotel ${hotelId}, process NULL).`);
  });

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
