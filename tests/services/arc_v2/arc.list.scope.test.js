// ARC v2 — list/KPI tenant-scope resolution must not trust the client (H7).
//
// resolveHospitalityCompanyScope derives scope from the user's OWN company
// mappings and IGNORES any client-supplied company (query param /
// X-Hospitality-Company header). A buyer mapped to Hospitality A can therefore
// never read another tenant's ARC list/KPIs — a spoofed company is silently
// ignored, not honored. (Previously the resolver collapsed to a single company
// and could hide a multi-company user's own data; now it shows every company
// the user belongs to, narrowed in-page by the Business Unit facet.)
//
// Product-level: real Express app + Postgres. Asserts the observable security
// property (spoofing has no effect on what the user sees), not a specific
// HTTP status.

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

  test("H7 — a spoofed company on KPIs is ignored (cannot read Company B)", async () => {
    const spoofed = await client.get(`/api/v1/arc-v2/kpis?hospitality_company_id=${HC_B}`);
    const own = await client.get(`/api/v1/arc-v2/kpis`);
    expect(own.status).toBe(200);
    expect(spoofed.status).toBe(200);
    // The client-supplied company had no effect — scope stays the user's own.
    expect(spoofed.body.data.counts).toEqual(own.body.data.counts);
  });

  test("H7 — a spoofed company on the LIST endpoint is ignored too", async () => {
    const spoofed = await client.get(`/api/v1/arc-v2?hospitality_company_id=${HC_B}&statusGroup=all`);
    const own = await client.get(`/api/v1/arc-v2?statusGroup=all`);
    expect(own.status).toBe(200);
    expect(spoofed.status).toBe(200);
    expect(spoofed.body.data.total).toBe(own.body.data.total);
  });

  test("control — the user's own scope resolves and succeeds", async () => {
    const res = await client.get(`/api/v1/arc-v2/kpis`);
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toBeDefined();
  });
});
