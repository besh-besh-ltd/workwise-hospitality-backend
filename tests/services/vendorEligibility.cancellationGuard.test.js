// Every subscription-eligibility gate must consult cancellation.
// ----------------------------------------------------------------------------
// A vendor's relationship with one hotel or category is a history of rows, not
// one row. Asking `status IN ('active','expired')` of any single row makes a
// vendor eligible forever on the strength of their oldest lapsed term, no
// matter how recently they cancelled.
//
// That predicate had been copied into fourteen places across models and
// controllers. Ten of them were eligibility gates, and all ten were wrong the
// same way — which is why vendor 220 (Fluidos) kept receiving Orchid Pune RFQs
// three months after cancelling 23 properties in one modification, while the
// Manali RFQ they were reported as "not seeing" was correctly withheld.
//
// The fix is one shared fragment, notSupersededByCancellation(alias). This
// guard is here because the next gate will be written by copying a nearby
// query, and a copy that drops the fragment reintroduces the bug silently: the
// query still runs, still returns vendors, and simply returns a few too many.
//
// EXEMPTIONS are listed explicitly below with the reason each one is correct.
// Adding a file to that list is a deliberate act a reviewer can see.

import { describe, it, expect } from "@jest/globals";
import fs from "fs";
import path from "path";
import { notSupersededByCancellation, subscriptionInForce } from "../../app/models/subscriptionEligibility.js";

const APP_ROOT = path.resolve(process.cwd(), "app");

// The predicate, however it is spaced or quoted.
const LAPSED_OK = /status\s+IN\s*\(\s*'active'\s*,\s*'expired'\s*\)/i;

// Sites that read active-or-expired for a purpose that is NOT eligibility.
const EXEMPT = new Map([
  [
    "models/subscriptionEligibility.js",
    "the shared definition itself — it documents and emits the rule",
  ],
  [
    "models/hospitalityModel.js#getSubscriptionsNeedingRenewal",
    "the renewal prompt WANTS lapsed rows so the vendor can renew; it already " +
      "excludes cancelled by omitting that status, and a superseding " +
      "cancellation means there is nothing left to renew",
  ],
  [
    "models/userModel.js#vendor category display",
    "renders the vendor's own category list with a display_status; cancelled " +
      "rows are deliberately not shown, and this decides nothing",
  ],
]);

function sourceFiles(root) {
  const out = [];
  const skip = new Set(["node_modules", ".git", "coverage", "dist", "build", "tests"]);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js") && !e.name.includes(".test.")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Every occurrence of the lapsed-ok predicate, with whether the same statement
 * also applies the cancellation guard. "Same statement" is approximated as the
 * six lines following the predicate, which is where an AND-ed condition lands.
 */
function predicateSites() {
  const sites = [];
  for (const file of sourceFiles(APP_ROOT)) {
    const rel = path.relative(APP_ROOT, file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!LAPSED_OK.test(line)) return;
      const window = lines.slice(i, i + 6).join("\n");
      sites.push({
        file: rel,
        line: i + 1,
        guarded: window.includes("notSupersededByCancellation"),
      });
    });
  }
  return sites;
}

describe("the guard itself", () => {
  it("recognises the predicate in every spelling that ships", () => {
    expect(LAPSED_OK.test(`AND s.status IN ('active', 'expired')`)).toBe(true);
    expect(LAPSED_OK.test(`AND vhcs.status IN ('active','expired')`)).toBe(true);
    expect(LAPSED_OK.test(`WHERE vendor_id = $1 AND item_type = 'hotel' AND status IN ('active', 'expired')`)).toBe(true);
  });

  it("does not fire on unrelated status tests", () => {
    expect(LAPSED_OK.test(`AND s.status = 'active'`)).toBe(false);
    expect(LAPSED_OK.test(`AND po.status IN ('approved', 'sent')`)).toBe(false);
  });

  it("finds the sites at all, so an empty sweep cannot pass vacuously", () => {
    expect(predicateSites().length).toBeGreaterThanOrEqual(10);
  });
});

describe("the shared fragment", () => {
  it("orders by (end_date, id) so the newest row for an item decides", () => {
    const sql = notSupersededByCancellation("s");
    expect(sql).toMatch(/_sup_cancel\.status\s*=\s*'cancelled'/);
    expect(sql).toMatch(/\(_sup_cancel\.end_date, _sup_cancel\.id\) > \(s\.end_date, s\.id\)/);
    // Scoped to one item, or it would suppress unrelated hotels.
    expect(sql).toMatch(/_sup_cancel\.item_type\s*=\s*s\.item_type/);
    expect(sql).toMatch(/_sup_cancel\.item_id\s*=\s*s\.item_id/);
    expect(sql).toMatch(/_sup_cancel\.vendor_id\s*=\s*s\.vendor_id/);
  });

  it("refuses an alias that is not a plain identifier", () => {
    expect(() => notSupersededByCancellation("s; DROP TABLE x")).toThrow(/invalid SQL alias/);
    expect(() => notSupersededByCancellation("")).toThrow(/invalid SQL alias/);
    expect(() => notSupersededByCancellation(undefined)).toThrow(/invalid SQL alias/);
  });

  it("offers both conditions together for new callers", () => {
    const sql = subscriptionInForce("vhcs");
    expect(sql).toMatch(LAPSED_OK);
    expect(sql).toContain("_sup_cancel");
  });
});

describe("no eligibility gate ignores cancellation", () => {
  it("holds across app/", () => {
    const unguarded = predicateSites()
      .filter((s) => !s.guarded)
      .filter((s) => ![...EXEMPT.keys()].some((k) => k.split("#")[0] === s.file))
      .map((s) => `${s.file}:${s.line}`);
    expect(unguarded).toEqual([]);
  });

  it("keeps the exemption list honest — every exempt file still exists", () => {
    for (const key of EXEMPT.keys()) {
      const file = key.split("#")[0];
      expect(fs.existsSync(path.join(APP_ROOT, file))).toBe(true);
    }
  });
});
