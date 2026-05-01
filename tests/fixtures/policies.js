// Approval-policy fixtures (tbl_approval_policies + tbl_approval_policy_steps).
//
// Coverage:
//   - Per-(process × hotel × entity) policies for the in-scope entity types
//     (RFQ, TECHNICAL, NEGOTIATION, NEGOTIATION_QUOTE, PO). ARC deliberately
//     omitted.
//   - **Master policies** (`department_id IS NULL`) — matches production
//     pattern where 112/122 policies are master. The active policy resolver
//     `findBestMatchingPolicyTx` filters on `department_id IS NULL`, so
//     dept-scoped policies wouldn't be resolved by `createApprovalInstance`
//     anyway. Dept-specific behaviour is layered elsewhere (per-step approver
//     resolution against `tbl_user_role_scopes.department_id`).
//   - P1 chain at A1 covers ALL entities. P2 chain at A1 covers ALL entities
//     with DIFFERENT approvers, so an A1/P2 RFQ resolves the P2 chain
//     end-to-end without crossover.
//   - A1 engineering RFQ uses ANY rule (vs ALL elsewhere).
//   - A2/P1 RFQ has zero steps → exercises auto-skip.
//   - A3/P1 RFQ uses the same approver at multiple levels → dedup test.
//   - A3/P1 PO is intentionally NOT defined → exercises "no PO policy" path.
//   - B1 has its own policies under B_P1.
//
// `decision_rule` ∈ {ANY, ALL}. `approver_source_type` ∈ {USER, ROLE, DEPARTMENT}.

import { IDS } from "./ids.js";
import { ROLE_IDS } from "./users.js";

// Each entry is one policy with its ordered steps.
//   policy: { id, entity, hospitality, hotel, dept, process, master, deptScoped, createdBy }
//   steps:  [{ order, rule, sourceType, sourceId }]
const POLICIES = [
  // ===== P1 / Hotel A-1 / Procurement — full chain =====
  {
    id: IDS.policies.A1_P1_RFQ,
    entity: "RFQ",
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P1,
    master: false,
    deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [
      { order: 1, rule: "ALL", sourceType: "ROLE", sourceId: ROLE_IDS.TECH_APPROVER },
      { order: 2, rule: "ALL", sourceType: "USER", sourceId: IDS.users.a1_proc_finance },
    ],
  },
  {
    id: IDS.policies.A1_P1_TECHNICAL,
    entity: "TECHNICAL",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P1,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "ROLE", sourceId: ROLE_IDS.TECH_APPROVER }],
  },
  {
    id: IDS.policies.A1_P1_NEGOTIATION,
    entity: "NEGOTIATION",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P1,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "ROLE", sourceId: ROLE_IDS.COMM_APPROVER }],
  },
  {
    id: IDS.policies.A1_P1_NEGOTIATION_QUOTE,
    entity: "NEGOTIATION_QUOTE",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P1,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "USER", sourceId: IDS.users.a1_proc_commApp }],
  },
  {
    id: IDS.policies.A1_P1_PO,
    entity: "PO",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P1,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [
      { order: 1, rule: "ALL", sourceType: "USER", sourceId: IDS.users.a1_proc_poApp },
      { order: 2, rule: "ALL", sourceType: "ROLE", sourceId: ROLE_IDS.COMM_APPROVER },
      { order: 3, rule: "ALL", sourceType: "USER", sourceId: IDS.users.a1_proc_finance },
    ],
  },

  // (A1eng_P1_RFQ removed — it would collide on uq_approval_policy_scope_process
  //  with A1_P1_RFQ now that all fixture policies are master-scope.
  //  ANY-rule coverage is provided by A1_P1_NEGOTIATION + A1_P2_RFQ instead.)

  // ===== P1 / Hotel A-2 / Procurement — RFQ policy with zero steps (auto-skip) =====
  {
    id: IDS.policies.A2_P1_RFQ,
    entity: "RFQ",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P1,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [], // intentionally empty
  },

  // ===== P1 / Hotel A-3 / Procurement — same approver at 3 levels (dedup test) =====
  {
    id: IDS.policies.A3_P1_RFQ,
    entity: "RFQ",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A3, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P1,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [
      { order: 1, rule: "ALL", sourceType: "USER", sourceId: IDS.users.a1_proc_finance },
      { order: 2, rule: "ALL", sourceType: "USER", sourceId: IDS.users.a1_proc_finance },
      { order: 3, rule: "ALL", sourceType: "USER", sourceId: IDS.users.a1_proc_finance },
    ],
  },
  // A3.P1.PO INTENTIONALLY OMITTED — exercises "BU has no PO policy" code path.

  // ===== P2 / Hotel A-1 / Procurement — distinct chain from P1 =====
  {
    id: IDS.policies.A1_P2_RFQ,
    entity: "RFQ",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P2,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "USER", sourceId: IDS.users.a1_proc_commApp }],
  },
  {
    id: IDS.policies.A1_P2_TECHNICAL,
    entity: "TECHNICAL",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P2,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "USER", sourceId: IDS.users.a1_proc_techEval }],
  },
  {
    id: IDS.policies.A1_P2_NEGOTIATION,
    entity: "NEGOTIATION",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P2,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "USER", sourceId: IDS.users.a1_proc_commEval }],
  },
  {
    id: IDS.policies.A1_P2_NEGOTIATION_QUOTE,
    entity: "NEGOTIATION_QUOTE",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P2,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "USER", sourceId: IDS.users.a1_proc_commEval }],
  },
  {
    id: IDS.policies.A1_P2_PO,
    entity: "PO",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P2,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "USER", sourceId: IDS.users.a1_proc_poApp }],
  },

  // ===== P2 / Hotel A-2 / Procurement — distinct from both P1/A2 and P2/A1 =====
  {
    id: IDS.policies.A2_P2_RFQ,
    entity: "RFQ",
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.A_P2,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyA_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "ROLE", sourceId: ROLE_IDS.TENDER_APPROVER }],
  },

  // ===== B1 — separate process from any A-side =====
  {
    id: IDS.policies.B1_P1_RFQ,
    entity: "RFQ",
    hospitality: IDS.hospitality.B, hotel: IDS.hotels.B1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.B_P1,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyB_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "USER", sourceId: IDS.users.companyB_admin }],
  },
  {
    id: IDS.policies.B1_P1_PO,
    entity: "PO",
    hospitality: IDS.hospitality.B, hotel: IDS.hotels.B1, dept: null, /* master policy — resolver filters department_id IS NULL */
    process: IDS.processes.B_P1,
    master: false, deptScoped: false,
    createdBy: IDS.users.companyB_admin,
    steps: [{ order: 1, rule: "ANY", sourceType: "USER", sourceId: IDS.users.companyB_admin }],
  },
];

export async function seedPolicies(t) {
  for (const p of POLICIES) {
    await t.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, 1)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.entity, p.hospitality, p.hotel, p.dept, p.createdBy, p.process, p.master, p.deptScoped]
    );
    for (const s of p.steps) {
      await t.none(
        `INSERT INTO tbl_approval_policy_steps
           (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [p.id, s.order, s.rule, s.sourceType, s.sourceId]
      );
    }
  }
}
