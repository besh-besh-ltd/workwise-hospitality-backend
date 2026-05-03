// Hospitality network fixtures: tbl_company (parent identity rows for buyers
// and vendors), tbl_hospitality_companies (operational hospitality entities
// under which BUs live), tbl_hospitality_company_hotels (Business Units),
// tbl_department (global, 4 canonical departments).

import { IDS } from "./ids.js";

const HOTELS = [
  { id: IDS.hotels.A1, hospitality: IDS.hospitality.A, name: "Hotel A-1" },
  { id: IDS.hotels.A2, hospitality: IDS.hospitality.A, name: "Hotel A-2" },
  { id: IDS.hotels.A3, hospitality: IDS.hospitality.A, name: "Hotel A-3 (under-configured for missing-PO-policy test)" },
  { id: IDS.hotels.B1, hospitality: IDS.hospitality.B, name: "Hotel B-1" },
  { id: IDS.hotels.B2, hospitality: IDS.hospitality.B, name: "Hotel B-2" },
];

const DEPARTMENTS = [
  { id: IDS.departments.proc, title: "Procurement",   access_type: "INDIVIDUAL" },
  { id: IDS.departments.eng,  title: "Engineering",   access_type: "INDIVIDUAL" },
  { id: IDS.departments.fb,   title: "F&B",           access_type: "INDIVIDUAL" },
  { id: IDS.departments.hk,   title: "Housekeeping",  access_type: "INDIVIDUAL" },
];

export async function seedNetwork(t) {
  // Parent company identity rows. tbl_company holds top-level identity for
  // both buyer entities and vendors. `is_hospitality=1` marks any company
  // (buyer OR vendor) that participates in the hospitality module — the
  // gate that `modifySubscription`, `extendSubscription`, etc. check at the
  // top of every WH-74 endpoint. We seed all vendor companies as
  // hospitality vendors because Wave-2 tests exercise vendor-facing
  // hospitality flows; non-hospitality vendors are out of scope here.
  await t.none(
    `INSERT INTO tbl_company (id, company_name, is_hospitality, "createdAt")
     VALUES
       ($1, 'Company A — Hospitality Group',  1, now()),
       ($2, 'Company B — Hospitality Group',  1, now()),
       ($3, 'Alpha Vendor Pvt Ltd',           1, now()),
       ($4, 'Beta Vendor Pvt Ltd',            1, now()),
       ($5, 'Gamma Vendor Pvt Ltd',           1, now()),
       ($6, 'Delta Vendor Pvt Ltd',           1, now()),
       ($7, 'Epsilon Vendor Pvt Ltd',         1, now())
     ON CONFLICT (id) DO NOTHING`,
    [
      IDS.companies.A,
      IDS.companies.B,
      IDS.companies.vendorAlpha,
      IDS.companies.vendorBeta,
      IDS.companies.vendorGamma,
      IDS.companies.vendorDelta,
      IDS.companies.vendorEpsilon,
    ]
  );

  // Hospitality companies — buyer-side operational entities.
  // buyer_company_id FK -> tbl_company.id.
  await t.none(
    `INSERT INTO tbl_hospitality_companies (id, buyer_company_id, name)
     VALUES ($1, $2, 'Hospitality A'), ($3, $4, 'Hospitality B')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.hospitality.A, IDS.companies.A, IDS.hospitality.B, IDS.companies.B]
  );

  // Business units (hotels).
  for (const h of HOTELS) {
    await t.none(
      `INSERT INTO tbl_hospitality_company_hotels (id, hospitality_company_id, name)
       VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [h.id, h.hospitality, h.name]
    );
  }

  // Departments are GLOBAL — not per-hotel. The hotel/dept binding lives in
  // tbl_user_role_scopes (which has both hotel_id and department_id columns).
  for (const d of DEPARTMENTS) {
    await t.none(
      `INSERT INTO tbl_department (id, title, access_type)
       VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [d.id, d.title, d.access_type]
    );
  }
}
