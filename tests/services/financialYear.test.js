// Pure-function unit tests for the backend Indian Financial Year helper —
// backs the ARC contract-serial format `ARC-<FY>-<seq>` (Sr 26).
//
// No DB, no fixtures, no controllers. Mirrors frontend/utils/financialYear.test.js
// for the pure fyLabel/fyStartYear math, PLUS the IST-wall-clock derivation that
// the backend version adds on top (via app/helper/arcTime.js).
//
// TZ=UTC reproduction: run `TZ=UTC npm test -- financialYear` to prove the FY
// is computed from IST wall-clock, not the server process timezone — mirrors
// the pattern in tests/services/arc_v2/arc.submissionWindow.tz.test.js.
// process.env.TZ = 'UTC' below is belt-and-suspenders; the launch env var is
// authoritative for Node's Date/Intl timezone data.
process.env.TZ = 'UTC';

import { describe, it, expect } from "@jest/globals";
import {
  fyLabel,
  financialYearOf,
  currentFinancialYearIst,
} from "../../app/helper/financialYear.js";

describe("financialYear helper (backend, IST wall-clock)", () => {
  describe("fyLabel", () => {
    it("labels 2026 as 2026-27", () => {
      expect(fyLabel(2026)).toBe("2026-27");
    });
    it("zero-pads the two-digit year portion", () => {
      expect(fyLabel(2009)).toBe("2009-10");
    });
    it("wraps century correctly (2099 → 2099-00, mod-100 sanity)", () => {
      expect(fyLabel(2099)).toBe("2099-00");
    });
  });

  describe("financialYearOf — explicit dates, Apr–Dec → current-year FY", () => {
    it("15-Jun-2026 (naive IST wall-clock string) → 2026-27", () => {
      expect(financialYearOf("2026-06-15 12:00:00")).toBe("2026-27");
    });
    it("1-Apr exactly (start of FY) → new FY", () => {
      expect(financialYearOf("2026-04-01 00:00:00")).toBe("2026-27");
    });
    it("31-Dec (end of calendar year, still same FY)", () => {
      expect(financialYearOf("2026-12-31 23:00:00")).toBe("2026-27");
    });
  });

  describe("financialYearOf — explicit dates, Jan–Mar → previous-year FY", () => {
    it("15-Jan-2027 → 2026-27 (previous FY)", () => {
      expect(financialYearOf("2027-01-15 12:00:00")).toBe("2026-27");
    });
    it("28-Feb → previous FY", () => {
      expect(financialYearOf("2027-02-28 10:00:00")).toBe("2026-27");
    });
  });

  describe("FY boundary — 31-Mar 23:59 IST vs 1-Apr 00:00/00:01 IST", () => {
    it("31-Mar-2027 23:59:00 (naive IST) → 2026-27 (still old FY)", () => {
      expect(financialYearOf("2027-03-31 23:59:00")).toBe("2026-27");
    });
    it("01-Apr-2027 00:00:00 (naive IST) → 2027-28 (new FY, exact midnight)", () => {
      expect(financialYearOf("2027-04-01 00:00:00")).toBe("2027-28");
    });
    it("01-Apr-2027 00:01:00 (naive IST) → 2027-28 (one minute into new FY)", () => {
      expect(financialYearOf("2027-04-01 00:01:00")).toBe("2027-28");
    });
  });

  // ── TZ=UTC reproduction (the prod scenario) ───────────────────────────────
  //
  // IST = UTC+5:30, so IST always crosses the 31-Mar/1-Apr midnight boundary
  // BEFORE UTC does for the same real instant: at the moment IST reads
  // 00:30 on 1-Apr, UTC (which lags behind) still reads 31-Mar ~19:00 the
  // previous day (see spec.md OQ#5's own example: "an ARC created at 00:30
  // IST on 1-Apr is still 31-Mar in UTC"). A buggy implementation deriving
  // the FY from bare `new Date().getUTCMonth()` (or any server-local Date
  // math under a TZ=UTC process) would misclassify this instant as March →
  // wrong (previous) FY, one day late on the rollover. financialYearOf must
  // route through arcMomentIst/nowIst (Asia/Kolkata) regardless of process TZ.
  describe("TZ=UTC boundary reproduction", () => {
    it("a real instant that is 00:30 IST on 1-Apr (still 18:31 UTC on 31-Mar) → NEW FY", () => {
      // 2027-03-31T19:00:00Z == 2027-04-01T00:30:00+05:30 (IST).
      const instant = new Date("2027-03-31T19:00:00Z");
      expect(financialYearOf(instant)).toBe("2027-28");
    });
    it("zoned ISO string (explicit Z offset) for the same instant → NEW FY", () => {
      expect(financialYearOf("2027-03-31T19:00:00Z")).toBe("2027-28");
    });
    it("a real instant that is 23:59 IST on 31-Mar (18:29 UTC same day) → OLD FY", () => {
      // 2027-03-31T18:29:00Z == 2027-03-31T23:59:00+05:30 (IST).
      const instant = new Date("2027-03-31T18:29:00Z");
      expect(financialYearOf(instant)).toBe("2026-27");
    });
    it("an instant safely inside the new FY under a UTC process → NEW FY", () => {
      // 2027-04-02T00:00:00Z == 2027-04-02T05:30:00+05:30 (IST) — unambiguous.
      const instant = new Date("2027-04-02T00:00:00Z");
      expect(financialYearOf(instant)).toBe("2027-28");
    });
  });

  describe("currentFinancialYearIst", () => {
    it("matches financialYearOf() called with no args", () => {
      expect(currentFinancialYearIst()).toBe(financialYearOf());
    });
    it("has the canonical YYYY-YY shape", () => {
      expect(currentFinancialYearIst()).toMatch(/^\d{4}-\d{2}$/);
    });
  });

  describe("financialYearOf — invalid input", () => {
    it("throws on an unparseable date", () => {
      expect(() => financialYearOf("not-a-date")).toThrow();
    });
  });
});
