// ARC v2 — list/KPI tenant-scope resolution must not trust the client (H7).
//
// resolveHospitalityCompanyId previously honored a client-supplied company
// (query param / X-Hospitality-Company header) ahead of the user's own
// mappings — letting a buyer read another tenant's ARC list/KPIs. The buyer
// fixture (a1_proc_buyer) is mapped ONLY to Hospitality A.
//
// Product-level: real Express app + Postgres.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";

describe("ARC v2 — list/KPI scope is derived from the user, not the client (H7)", () => {
  const BUYER = IDS.users.a1_proc_buyer; // mapped to Hospitality A only
  const HC_B = IDS.hospitality.B;
  let client;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);
  });

  test("H7 — a spoofed hospitality_company_id the user doesn't belong to is refused", async () => {
    const res = await client.get(`/api/v1/arc-v2/kpis?hospitality_company_id=${HC_B}`);
    expect(res.status).not.toBe(200); // must NOT serve Company B's KPIs
  });

  test("H7 — a spoofed company on the LIST endpoint is refused too", async () => {
    const res = await client.get(`/api/v1/arc-v2?hospitality_company_id=${HC_B}&statusGroup=all`);
    expect(res.status).not.toBe(200);
  });

  test("control — with no company param the user's own scope resolves and succeeds", async () => {
    const res = await client.get(`/api/v1/arc-v2/kpis`);
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toBeDefined();
  });
});
