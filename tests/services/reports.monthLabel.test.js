// Report 1.1 month labels must not depend on the server's timezone.
// ---------------------------------------------------------------------------
// month_start is a Postgres DATE, which node-pg materialises as LOCAL midnight.
// The label used to read it back with UTC getters, so on a server east of UTC
// (a laptop in IST) 1 Apr became "Mar-26" — every month one behind its figure.
// Prod runs in UTC and was right only by accident.

import { describe, it, expect, afterEach } from "@jest/globals";
import { monthLabel } from "../../app/services/reports/definitions/spendSummary.js";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("spend summary monthLabel", () => {
  for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"]) {
    it(`labels a DATE the way node-pg builds it (local midnight) correctly in ${tz}`, () => {
      process.env.TZ = tz;
      expect(monthLabel(new Date(2026, 3, 1))).toBe("Apr-26");
      expect(monthLabel(new Date(2027, 0, 1))).toBe("Jan-27");
    });
  }

  it("labels a date string without going through any timezone", () => {
    process.env.TZ = "Asia/Kolkata";
    expect(monthLabel("2026-04-01")).toBe("Apr-26");
    expect(monthLabel("2026-12-01T00:00:00")).toBe("Dec-26");
  });

  it("returns an empty label for missing or invalid values", () => {
    expect(monthLabel(null)).toBe("");
    expect(monthLabel(undefined)).toBe("");
    expect(monthLabel("not a date")).toBe("");
  });
});
