// Stable IDs for test fixtures. Tests import { IDS } from "tests/fixtures/ids.js"
// and reference fixtures by readable names instead of magic numbers.
//
// Convention:
//   - Reference data (from staging) keeps its real IDs (1001-9999 not used by us).
//   - Fixture-authored rows use 5-digit IDs starting at 10001 to avoid collision.
//   - Each table's range is contiguous and documented.

export const IDS = Object.freeze({
  // ---- tbl_company (parent identity rows) — range 90001..90099 ----
  companies: {
    A:        90001, // Buyer parent — Company A (operates 3 hotels)
    B:        90002, // Buyer parent — Company B (operates 2 hotels, group-linked to A)
    vendorAlpha: 90011, // Vendor parent — Alpha Vendor Pvt Ltd
    vendorBeta:  90012, // Vendor parent — Beta Vendor Pvt Ltd
    vendorGamma: 90013, // Vendor parent — Gamma Vendor Pvt Ltd (lapsed subscription)
    vendorDelta: 90014, // Vendor parent — Delta Vendor Pvt Ltd (cancelled)
    vendorEpsilon: 90015, // Vendor parent — Epsilon Vendor Pvt Ltd (admin-mapped, payment pending)
  },

  // ---- tbl_hospitality_companies — range 10001..10099 ----
  hospitality: {
    A: 10001, // Hospitality entity under Company A
    B: 10002, // Hospitality entity under Company B
  },

  // ---- tbl_hospitality_company_hotels (Business Units) — range 10101..10199 ----
  hotels: {
    A1: 10101, // Hotel A-1 under Hospitality A
    A2: 10102, // Hotel A-2 under Hospitality A
    A3: 10103, // Hotel A-3 (deliberately under-configured for "no PO policy" test)
    B1: 10104, // Hotel B-1 under Hospitality B
    B2: 10105, // Hotel B-2 under Hospitality B
  },

  // ---- tbl_department — global, not per-hotel. 4 canonical depts ----
  // The schema has only (id, title, access_type) — no hospitality_company / hotel
  // scoping on the dept itself. Hotel/dept binding lives in user_role_scopes.
  departments: {
    proc: 10201, // Procurement
    eng:  10202, // Engineering
    fb:   10203, // F&B
    hk:   10204, // Housekeeping
  },

  // ---- tbl_users — range 80001..80099 (buyers/admins), 80101..80199 (vendor users) ----
  users: {
    superAdmin:        80001, // System admin, no scope
    companyA_admin:    80002, // Company-level scope, Company A
    companyB_admin:    80003, // Company-level scope, Company B

    // Hotel A-1 / Procurement-dept users (cover full RFQ chain)
    a1_proc_buyer:     80011, // RFQ creator
    a1_proc_techEval:  80012, // Technical Evaluator
    a1_proc_techApp:   80013, // Technical Approver
    a1_proc_commEval:  80014, // Commercial Evaluator/Negotiator
    a1_proc_commApp:   80015, // Commercial Approver
    a1_proc_poApp:     80016, // PO Approver
    a1_proc_finance:   80017, // Finance Approver

    // Hotel A-1 / Engineering-dept user (different dept under same hotel)
    a1_eng_buyer:      80021,

    // Multi-hotel user: assigned to A-1 and A-2 simultaneously
    multiHotel:        80031,

    // Dual-role user: buyer in A-1, evaluator in A-2
    dualRole:          80032,

    // Cross-company: mapped to both Company A and Company B
    crossCompany:      80033,

    // Inactive (status=0)
    inactive:          80041,

    // Mid-flight: this user is an approver on a PENDING approval instance.
    // Removing them mid-flight exercises the propagation/auto-complete path.
    midFlightApprover: 80042,

    // Vendor users (one per vendor, with varied subscription state)
    vendor_alpha:      80101, // active subscription
    vendor_beta:       80102, // active multi-category
    vendor_gamma:      80103, // lapsed-was-active
    vendor_delta:      80104, // cancelled
    vendor_epsilon:    80105, // never-subscribed (admin-mapped)
  },

  // ---- tbl_approval_processes — range 70001..70099 ----
  // Two processes per buyer-side parent company. P1 = mainline, P2 = alt
  // (covers cross-process policy routing tests).
  processes: {
    A_P1: 70001, // Company A — Standard Procurement
    A_P2: 70002, // Company A — Daily Bazaar
    B_P1: 70003, // Company B — Standard Procurement
  },

  // ---- tbl_approval_policies — range 60001..60099 ----
  // Keyed by (process, hotel, entityType). Step IDs follow.
  policies: {
    // P1 / A1 / Procurement — full chain
    A1_P1_RFQ:               60001,
    A1_P1_TECHNICAL:         60002,
    A1_P1_NEGOTIATION:       60003,
    A1_P1_NEGOTIATION_QUOTE: 60004,
    A1_P1_PO:                60005,

    // P1 / A1 / Engineering — simpler (1-step ANY) RFQ
    A1eng_P1_RFQ:            60011,

    // P1 / A2 — zero-approver RFQ (auto-skip test)
    A2_P1_RFQ:               60021,

    // P1 / A3 — same approver at multiple levels (dedup test)
    A3_P1_RFQ:               60031,
    A3_P1_PO:                60032, // deliberately MISSING for "no PO approver" test → not seeded

    // P2 / A1 / Procurement — different chain than P1 (cross-process routing)
    A1_P2_RFQ:               60041,
    A1_P2_TECHNICAL:         60042,
    A1_P2_NEGOTIATION:       60043,
    A1_P2_NEGOTIATION_QUOTE: 60044,
    A1_P2_PO:                60045,

    // P2 / A2 — distinct from both P1/A2 and P2/A1 (multi-axis isolation)
    A2_P2_RFQ:               60051,

    // B1 — separate process_id from any A-side
    B1_P1_RFQ:               60061,
    B1_P1_PO:                60062,
  },

  // ---- tbl_product / tbl_product_variant — use a small slice from staging.
  // Set in seed_fixtures via SELECT-and-cap to keep deterministic. ----
  // (Captured at runtime; no static IDs here.)

  // ---- tbl_buyer_private_vendors_mapping ----
  // Inserted programmatically; no static IDs needed.
});

export default IDS;
