// Approval-process fixtures (tbl_approval_processes).
//
// company_id here references tbl_company.id (the parent identity row), not
// tbl_hospitality_companies.id. This is a real schema quirk worth knowing for
// every test that resolves processes.
//
// Two processes for Company A (P1 mainline + P2 alt) so we can exercise
// cross-process policy routing. One process for Company B.

import { IDS } from "./ids.js";

const PROCESSES = [
  {
    id: IDS.processes.A_P1,
    company: IDS.companies.A,
    name: "Standard Procurement",
    description: "Mainline procurement process — full chain",
    process_type: "RFQ",
    is_active: true,
    created_by: IDS.users.companyA_admin,
  },
  {
    id: IDS.processes.A_P2,
    company: IDS.companies.A,
    name: "Daily Bazaar",
    description: "Fast-track procurement — distinct chain from P1",
    process_type: "RFQ",
    is_active: true,
    created_by: IDS.users.companyA_admin,
  },
  {
    id: IDS.processes.B_P1,
    company: IDS.companies.B,
    name: "Standard Procurement",
    description: "Company B's mainline process",
    process_type: "RFQ",
    is_active: true,
    created_by: IDS.users.companyB_admin,
  },
];

export async function seedProcesses(t) {
  for (const p of PROCESSES) {
    await t.none(
      `INSERT INTO tbl_approval_processes
         (id, company_id, name, description, is_active, created_by, process_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.company, p.name, p.description, p.is_active, p.created_by, p.process_type]
    );
  }
}
