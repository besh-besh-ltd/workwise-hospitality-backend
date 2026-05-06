// Phase 9 — cross-stage process_id chain test.
//
// What this locks in: a tender on process P1 has EVERY stage of its
// approval lifecycle (TENDER, TECHNICAL, NEGOTIATION, NEGOTIATION_QUOTE,
// ARC) resolved against P1's policies — never bleeding to a sibling
// process P2 that lives at the same scope. This is the contract that
// makes "process_id is the discriminator" actually true at runtime.
//
// Why this matters: every post-approval handler that spawns a next-
// stage instance reads process_id off the parent RFQ row and passes
// it to createApprovalInstance. The engine then resolves the policy
// via (entity_type, process_id) under company+hotel+dept precedence.
// If a future refactor drops `process_id: rfqData.process_id` from
// any single spawn site, the engine would either fall back to a
// process-agnostic policy (legacy RFQ semantics) or throw
// TENDER_POLICY_NOT_CONFIGURED — both wrong outcomes for a tender
// chain. This test covers BOTH halves of that contract:
//
//   Part A — engine resolution: for each tender-chain entity type,
//            createApprovalInstance with process_id=P1 picks P1's
//            policy and never P2's, even when both exist at the
//            same scope.
//
//   Part B — source-level guardrail: every createApprovalInstance
//            call site in the tender lifecycle controllers passes
//            `process_id` in its arguments. A regex scan catches
//            future regressions where someone forgets the field.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

const PROCESS_P1 = 70300;
const PROCESS_P2 = 70301;

// Matrix of [entity_type, P1 policy id, P2 policy id, P1 approver, P2 approver].
const STAGES = [
  { entity: 'TENDER',            p1Id: 60300, p2Id: 60310, p1Appr: IDS.users.a1_proc_techApp,  p2Appr: IDS.users.a1_proc_finance },
  { entity: 'TECHNICAL',         p1Id: 60301, p2Id: 60311, p1Appr: IDS.users.a1_proc_techEval, p2Appr: IDS.users.a1_proc_commApp },
  { entity: 'NEGOTIATION',       p1Id: 60302, p2Id: 60312, p1Appr: IDS.users.a1_proc_commEval, p2Appr: IDS.users.a1_proc_finance },
  { entity: 'NEGOTIATION_QUOTE', p1Id: 60303, p2Id: 60313, p1Appr: IDS.users.a1_proc_commApp,  p2Appr: IDS.users.a1_proc_techApp },
  { entity: 'ARC',               p1Id: 60304, p2Id: 60314, p1Appr: IDS.users.a1_proc_finance,  p2Appr: IDS.users.a1_proc_commEval },
];

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_approval_processes
       (id, company_id, name, description, is_active, created_by, process_type)
     VALUES
       ($1, $3, 'Tender Process P1 — cross-chain test', '', true, $4, 'TENDER'),
       ($2, $3, 'Tender Process P2 — cross-chain test', '', true, $4, 'TENDER')
     ON CONFLICT (id) DO NOTHING`,
    [PROCESS_P1, PROCESS_P2, IDS.companies.A, IDS.users.companyA_admin]
  );

  for (const s of STAGES) {
    for (const [policyId, processId, approver] of [
      [s.p1Id, PROCESS_P1, s.p1Appr],
      [s.p2Id, PROCESS_P2, s.p2Appr],
    ]) {
      await db.none(
        `INSERT INTO tbl_approval_policies
           (id, entity_type, hospitality_company_id, hotel_id, department_id,
            is_active, created_by, process_id, is_master, is_department_scoped,
            version, company_id, is_global)
         VALUES ($1, $2, $3, $4, NULL, true, $5, $6, false, false, 1, $7, 0)
         ON CONFLICT (id) DO NOTHING`,
        [policyId, s.entity, IDS.hospitality.A, IDS.hotels.A1,
         IDS.users.companyA_admin, processId, IDS.companies.A]
      );
      await db.none(
        `INSERT INTO tbl_approval_policy_steps
           (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1, 1, 'ANY', 'USER', $2)
         ON CONFLICT DO NOTHING`,
        [policyId, approver]
      );
    }
  }
});

afterAll(async () => {
  const allPolicyIds = STAGES.flatMap((s) => [s.p1Id, s.p2Id]);
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [allPolicyIds]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [allPolicyIds]);
  await db.none(`DELETE FROM tbl_approval_processes WHERE id = ANY($1::int[])`, [[PROCESS_P1, PROCESS_P2]]);
  await closeDb();
});

let entityIdSeed = 199500000;
const nextEntityId = () => ++entityIdSeed;

const cleanupInstance = async (instance) => {
  if (!instance?.id) return;
  await db.none(
    `DELETE FROM tbl_approval_step_approvers
      WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1)`,
    [instance.id]
  );
  await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = $1`, [instance.id]);
  await db.none(`DELETE FROM tbl_approval_instances WHERE id = $1`, [instance.id]);
};

describe("Cross-stage process_id chain — Part A: engine resolution per entity_type", () => {
  for (const stage of STAGES) {
    it(`${stage.entity} with process_id=P1 resolves P1's policy and approver, never P2's`, async () => {
      const entityId = nextEntityId();
      const res = await createApprovalInstance({
        entity_type: stage.entity,
        entity_id: entityId,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        process_id: PROCESS_P1,
        initiated_by: IDS.users.a1_proc_buyer,
        metadata: { test: 'process_id_chain' },
      });
      expect(res.instance.approval_policy_id).toBe(stage.p1Id);
      expect(res.instance.approval_policy_id).not.toBe(stage.p2Id);

      // Approver list resolves to the P1 user only.
      const approvers = await db.any(
        `SELECT sa.approver_user_id
           FROM tbl_approval_step_approvers sa
           JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
          WHERE s.approval_instance_id = $1`,
        [res.instance.id]
      );
      const approverIds = approvers.map((r) => r.approver_user_id);
      expect(approverIds).toContain(stage.p1Appr);
      expect(approverIds).not.toContain(stage.p2Appr);

      await cleanupInstance(res.instance);
    });
  }

  it("flipping the chain to P2 resolves P2's policies for every stage (the discriminator works both ways)", async () => {
    for (const stage of STAGES) {
      const entityId = nextEntityId();
      const res = await createApprovalInstance({
        entity_type: stage.entity,
        entity_id: entityId,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        process_id: PROCESS_P2,
        initiated_by: IDS.users.a1_proc_buyer,
        metadata: { test: 'flipped_to_p2' },
      });
      expect(res.instance.approval_policy_id).toBe(stage.p2Id);
      await cleanupInstance(res.instance);
    }
  });
});

describe("Cross-stage process_id chain — Part B: every spawn site in the source carries process_id", () => {
  // Files that own a tender-chain createApprovalInstance call site.
  // If a future contributor adds a new spawn elsewhere, add the file
  // here so this guardrail covers it.
  const SOURCE_FILES = [
    'app/controllers/rfq/rfqController.js',
    'app/controllers/negotiation/negotiationController.js',
    'app/controllers/general/negotiationQuotePostApproval.js',
  ];

  // Per-call-site exception: legacy startApprovalForArc at line ~4511
  // is dead code (never invoked after Phase 2 moved ARC to per-cell at
  // finalize). Keep this allowlist tight.
  const ALLOWED_DEAD_SITES = new Set([
    'startApprovalForArc',
  ]);

  it.each(SOURCE_FILES)("%s — every createApprovalInstance call has process_id in its arg block", (relPath) => {
    const fullPath = path.join(process.cwd(), relPath);
    expect(fs.existsSync(fullPath)).toBe(true);
    const source = fs.readFileSync(fullPath, 'utf8');

    // Find every `createApprovalInstance({` call. For each, scan the next
    // ~30 lines (the arg block) and confirm `process_id` appears as a
    // key. Loose match — we accept either `process_id: rfq.process_id`
    // or `process_id: rfqData.process_id` etc.
    const lines = source.split('\n');
    const offenders = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('createApprovalInstance({')) continue;

      // Walk forward to the matching close-brace. Bounded at 60 lines
      // (every existing call fits in fewer than 30).
      let depth = 0;
      let argBlockEnd = -1;
      for (let j = i; j < Math.min(i + 60, lines.length); j++) {
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) { argBlockEnd = j; break; }
          }
        }
        if (argBlockEnd !== -1) break;
      }
      if (argBlockEnd === -1) {
        offenders.push({ line: i + 1, reason: 'unbalanced braces in arg block' });
        continue;
      }
      const argBlock = lines.slice(i, argBlockEnd + 1).join('\n');
      const hasProcessId = /\bprocess_id\s*:/.test(argBlock);

      if (!hasProcessId) {
        // Skip dead-code call sites by walking backward to find the
        // enclosing function name.
        let enclosingFn = null;
        for (let k = i - 1; k >= Math.max(0, i - 80); k--) {
          const m = lines[k].match(/(?:const|function|async\s+function|async)\s+(\w+)\s*=\s*async\s*\(/) ||
                    lines[k].match(/(?:const|function)\s+(\w+)\s*=\s*async\s*\(/) ||
                    lines[k].match(/^\s*(\w+):\s*async\s*\(/);
          if (m) { enclosingFn = m[1]; break; }
        }
        if (enclosingFn && ALLOWED_DEAD_SITES.has(enclosingFn)) continue;
        offenders.push({ line: i + 1, fn: enclosingFn, snippet: argBlock.slice(0, 200) });
      }
    }
    if (offenders.length > 0) {
      console.error(`process_id missing from ${offenders.length} createApprovalInstance call site(s) in ${relPath}:`,
        offenders);
    }
    expect(offenders).toEqual([]);
  });
});
