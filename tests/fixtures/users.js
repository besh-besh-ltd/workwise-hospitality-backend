// User fixtures + their RBAC scopes + dept assignments + hospitality mappings.
//
// Coverage:
//   - One user per role × scope combination needed by the audit (super admin,
//     company admin, hotel/dept-scoped buyer, evaluator, approvers, multi-hotel,
//     dual-role, cross-company, inactive, mid-flight approver).
//   - One user per fixture vendor (5), tied via tbl_company.id.
//
// Role IDs come from the staging-seeded tbl_roles (see ROLE_IDS below).

import { IDS } from "./ids.js";

// Static role IDs from staging reference data (tbl_roles 1..21).
export const ROLE_IDS = Object.freeze({
  CEO: 1,
  TENDER_CREATOR: 2,
  PURCHASE_INPUT_PROVIDER: 3,
  TENDER_APPROVER: 4,
  PROXY_APPROVER: 5,
  TECH_EVAL: 6,
  TECH_APPROVER: 7,
  COMM_NEGO_N1: 8,
  COMM_NEGO_N2: 9,
  COMM_APPROVER: 12,
  FINAL_AWARDING_P1: 13,
  RFQ_OBSERVER: 17,
  PO_REGENERATOR: 21,
});

// All buyer-side users: id, name, email, mobile, status, parent_company.
// status=1 active, 0 inactive. user_type left NULL (intentionally — see plan: not used).
const BUYERS = [
  { id: IDS.users.superAdmin,        name: "Super Admin",                 email: "super.admin@test.local",    company: null },
  { id: IDS.users.companyA_admin,    name: "Company A Admin",             email: "admin.a@test.local",         company: IDS.companies.A },
  { id: IDS.users.companyB_admin,    name: "Company B Admin",             email: "admin.b@test.local",         company: IDS.companies.B },
  { id: IDS.users.a1_proc_buyer,     name: "A1 Proc Buyer",               email: "a1.proc.buyer@test.local",   company: IDS.companies.A },
  { id: IDS.users.a1_proc_techEval,  name: "A1 Proc Tech Evaluator",      email: "a1.proc.techeval@test.local",company: IDS.companies.A },
  { id: IDS.users.a1_proc_techApp,   name: "A1 Proc Tech Approver",       email: "a1.proc.techapp@test.local", company: IDS.companies.A },
  { id: IDS.users.a1_proc_commEval,  name: "A1 Proc Commercial Negotiator", email: "a1.proc.commeval@test.local", company: IDS.companies.A },
  { id: IDS.users.a1_proc_commApp,   name: "A1 Proc Commercial Approver", email: "a1.proc.commapp@test.local", company: IDS.companies.A },
  { id: IDS.users.a1_proc_poApp,     name: "A1 Proc PO Approver",         email: "a1.proc.poapp@test.local",   company: IDS.companies.A },
  { id: IDS.users.a1_proc_finance,   name: "A1 Proc Finance Approver",    email: "a1.proc.finance@test.local", company: IDS.companies.A },
  { id: IDS.users.a1_eng_buyer,      name: "A1 Eng Buyer",                email: "a1.eng.buyer@test.local",    company: IDS.companies.A },
  { id: IDS.users.multiHotel,        name: "Multi-Hotel User",            email: "multi.hotel@test.local",     company: IDS.companies.A },
  { id: IDS.users.dualRole,          name: "Dual-Role User",              email: "dual.role@test.local",       company: IDS.companies.A },
  { id: IDS.users.crossCompany,      name: "Cross-Company User",          email: "cross.company@test.local",   company: IDS.companies.A },
  { id: IDS.users.inactive,          name: "Inactive User",               email: "inactive@test.local",        company: IDS.companies.A, status: 0 },
  { id: IDS.users.midFlightApprover, name: "Mid-Flight Approver",         email: "midflight@test.local",       company: IDS.companies.A },
];

const VENDORS = [
  { id: IDS.users.vendor_alpha,   name: "Alpha Vendor Contact",   email: "alpha@vendor.test",   company: IDS.companies.vendorAlpha },
  { id: IDS.users.vendor_beta,    name: "Beta Vendor Contact",    email: "beta@vendor.test",    company: IDS.companies.vendorBeta },
  { id: IDS.users.vendor_gamma,   name: "Gamma Vendor Contact",   email: "gamma@vendor.test",   company: IDS.companies.vendorGamma },
  { id: IDS.users.vendor_delta,   name: "Delta Vendor Contact",   email: "delta@vendor.test",   company: IDS.companies.vendorDelta },
  { id: IDS.users.vendor_epsilon, name: "Epsilon Vendor Contact", email: "epsilon@vendor.test", company: IDS.companies.vendorEpsilon },
];

// Hospitality user mappings (tbl_hospitality_user_mappings).
// mapping_type = 0 (company-level, hotel_id MUST be NULL) or 1 (hotel-level, hotel_id NOT NULL).
// uq constraint: (user_id, mapping_type, hospitality_company_id, hospitality_hotel_id).
const MAPPINGS = [
  // Company-level admins
  { user: IDS.users.companyA_admin, type: 0, hospitality: IDS.hospitality.A, hotel: null },
  { user: IDS.users.companyB_admin, type: 0, hospitality: IDS.hospitality.B, hotel: null },

  // Hotel A-1 procurement crew — all mapped to hotel A1
  { user: IDS.users.a1_proc_buyer,    type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },
  { user: IDS.users.a1_proc_techEval, type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },
  { user: IDS.users.a1_proc_techApp,  type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },
  { user: IDS.users.a1_proc_commEval, type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },
  { user: IDS.users.a1_proc_commApp,  type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },
  { user: IDS.users.a1_proc_poApp,    type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },
  { user: IDS.users.a1_proc_finance,  type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },

  // Hotel A-1 engineering buyer
  { user: IDS.users.a1_eng_buyer, type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },

  // Multi-hotel: A-1 + A-2
  { user: IDS.users.multiHotel, type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },
  { user: IDS.users.multiHotel, type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2 },

  // Dual-role: A-1 (buyer role assigned) + A-2 (evaluator role assigned)
  { user: IDS.users.dualRole, type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },
  { user: IDS.users.dualRole, type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2 },

  // Cross-company: mapped to both A and B
  { user: IDS.users.crossCompany, type: 0, hospitality: IDS.hospitality.A, hotel: null },
  { user: IDS.users.crossCompany, type: 0, hospitality: IDS.hospitality.B, hotel: null },

  // Inactive — still has mapping; tests must filter by user.status
  { user: IDS.users.inactive, type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },

  // Mid-flight approver — A1 procurement
  { user: IDS.users.midFlightApprover, type: 1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1 },
];

// User role scopes (tbl_user_role_scopes). FK-less in schema; we still keep
// IDs coherent so tests can assert "user X has role R in scope (company C, hotel H, dept D)".
// company_id here references tbl_hospitality_companies.id (per the can() middleware behaviour).
const ROLE_SCOPES = [
  // Super admin: CEO across both hospitality companies, all hotels, all depts (NULL).
  { user: IDS.users.superAdmin, role: ROLE_IDS.CEO, hospitality: IDS.hospitality.A, hotel: null, dept: null },
  { user: IDS.users.superAdmin, role: ROLE_IDS.CEO, hospitality: IDS.hospitality.B, hotel: null, dept: null },

  // Company admins: CEO at their respective company, all hotels.
  { user: IDS.users.companyA_admin, role: ROLE_IDS.CEO, hospitality: IDS.hospitality.A, hotel: null, dept: null },
  { user: IDS.users.companyB_admin, role: ROLE_IDS.CEO, hospitality: IDS.hospitality.B, hotel: null, dept: null },

  // A-1 procurement chain
  { user: IDS.users.a1_proc_buyer,    role: ROLE_IDS.TENDER_CREATOR,    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_techEval, role: ROLE_IDS.TECH_EVAL,         hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_techApp,  role: ROLE_IDS.TECH_APPROVER,     hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_commEval, role: ROLE_IDS.COMM_NEGO_N1,      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_commApp,  role: ROLE_IDS.COMM_APPROVER,     hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_poApp,    role: ROLE_IDS.FINAL_AWARDING_P1, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_finance,  role: ROLE_IDS.TENDER_APPROVER,   hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
  // ── Named-approver grants ────────────────────────────────────────────────
  // USER-source policy steps are now permission-gated exactly like ROLE-source
  // ones: a user named on a step whose resource they hold no read+approve for
  // has that step DROPPED at instance creation. These three users are named as
  // approvers by fixture policies but were only ever given the role for their
  // *other* duty, so their steps silently vanished under the gate.
  //
  // Granting the role their assignment implies is the same repair applied to
  // production (prod_04_clear_unqualified_user_approvers.sql). It does not
  // change WHO resolves for any policy — only whether they survive the gate.
  //
  // Deliberately NOT granted: a1_proc_finance at hotel A3. A3_P1_RFQ is the
  // "business unit whose policy can approve nobody" fixture, and
  // F-DUPLICATE-001 depends on it resolving to nobody.
  { user: IDS.users.a1_proc_commApp,  role: ROLE_IDS.TENDER_APPROVER,    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },  // A1_P2_RFQ step 1 → rfq.read+approve
  { user: IDS.users.a1_proc_techEval, role: ROLE_IDS.TECH_APPROVER,      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },  // A1_P2_TECHNICAL step 1 → te.read+approve
  //
  // NOT granted: awarding.* to a1_proc_finance, even though A1_P1_PO step 3
  // names them. They are modelled as a pure Tender Approver — rfq.read/approve
  // and boq.read, nothing downstream — and rfq.publishLapse.test.js depends on
  // exactly that to prove a reader is redirected away from a stage they cannot
  // see. Giving them awarding.read would make the PO stage visible and destroy
  // that premise. So A1_P1_PO step 3 legitimately fails the gate and is
  // dropped; steps 1 (a1_proc_poApp, FINAL_AWARDING_P1) and the rest carry the
  // policy, which is the shape the gate is supposed to produce for a step
  // naming someone who cannot act.

  // A-1 engineering buyer
  { user: IDS.users.a1_eng_buyer, role: ROLE_IDS.TENDER_CREATOR, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.eng },

  // Multi-hotel: TENDER_CREATOR in A-1 procurement AND A-2 procurement
  { user: IDS.users.multiHotel, role: ROLE_IDS.TENDER_CREATOR, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
  { user: IDS.users.multiHotel, role: ROLE_IDS.TENDER_CREATOR, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2, dept: IDS.departments.proc },

  // Dual-role: TENDER_CREATOR in A-1, TECH_EVAL in A-2 (different role at different hotel)
  { user: IDS.users.dualRole, role: ROLE_IDS.TENDER_CREATOR, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
  { user: IDS.users.dualRole, role: ROLE_IDS.TECH_EVAL,      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2, dept: IDS.departments.proc },

  // Cross-company: TENDER_CREATOR in A AND in B
  { user: IDS.users.crossCompany, role: ROLE_IDS.TENDER_CREATOR, hospitality: IDS.hospitality.A, hotel: null, dept: null },
  { user: IDS.users.crossCompany, role: ROLE_IDS.TENDER_CREATOR, hospitality: IDS.hospitality.B, hotel: null, dept: null },

  // Inactive: would-be approver, but status=0 should exclude them.
  { user: IDS.users.inactive, role: ROLE_IDS.TECH_APPROVER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },

  // Mid-flight: assigned a role that puts them on a PENDING approval.
  { user: IDS.users.midFlightApprover, role: ROLE_IDS.TECH_APPROVER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, dept: IDS.departments.proc },
];

// User-to-department mappings (tbl_user_department). One per user that has
// any role-scope with a non-null department, plus the multi-dept cases.
const USER_DEPTS = [
  { user: IDS.users.a1_proc_buyer,    dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_techEval, dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_techApp,  dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_commEval, dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_commApp,  dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_poApp,    dept: IDS.departments.proc },
  { user: IDS.users.a1_proc_finance,  dept: IDS.departments.proc },
  { user: IDS.users.a1_eng_buyer,     dept: IDS.departments.eng },
  { user: IDS.users.multiHotel,       dept: IDS.departments.proc },
  { user: IDS.users.dualRole,         dept: IDS.departments.proc },
  { user: IDS.users.midFlightApprover, dept: IDS.departments.proc },
  { user: IDS.users.inactive,         dept: IDS.departments.proc },
];

export async function seedUsers(t) {
  // Insert buyer-side users.
  for (const u of BUYERS) {
    await t.none(
      `INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name, u.email, u.status ?? 1, u.company]
    );
  }

  // Insert vendor users (each tied to a vendor parent company in tbl_company).
  for (const v of VENDORS) {
    await t.none(
      `INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [v.id, v.name, v.email, v.company]
    );
  }

  // Hospitality user mappings.
  for (const m of MAPPINGS) {
    await t.none(
      `INSERT INTO tbl_hospitality_user_mappings
         (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
      [m.user, m.hospitality, m.hotel, m.type, IDS.users.superAdmin]
    );
  }

  // Role scopes.
  for (const s of ROLE_SCOPES) {
    await t.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [s.user, s.role, s.hospitality, s.hotel, s.dept]
    );
  }

  // User-department assignments.
  for (const ud of USER_DEPTS) {
    await t.none(
      `INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $2)`,
      [ud.user, ud.dept]
    );
  }
}
