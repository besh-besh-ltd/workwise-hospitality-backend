// `NOT IN (SELECT ...)` is banned in application SQL.
// ----------------------------------------------------------------------------
// In SQL, `x NOT IN (… NULL …)` evaluates to NULL — not TRUE. A NULL anywhere
// in the subquery's result therefore makes the whole predicate un-satisfiable,
// and in a WHERE clause that silently removes EVERY row. No error, no warning,
// no log line: the query just starts returning nothing.
//
// This has now cost us a production incident. `getMatchingOpenRfqsForVendor`
// filtered already-finalized products with:
//
//     AND rp.id NOT IN (SELECT rfq_product_id FROM finalized_products)
//
// `tbl_purchase_order_product.rfq_product_id` is nullable, and 57 live rows
// (legacy/manually-raised PO lines) hold NULL. The feature — auto-joining a
// vendor to the open RFQs they qualify for after they pay — returned zero rows
// for every vendor on the platform. A buyer's RFQ never reached a vendor who
// had just subscribed to exactly its hotel and category, and the vendor
// reported never receiving it.
//
// Two properties made it expensive to find:
//
//  1. It was DORMANT. The NULL-bearing POs only entered the subquery once they
//     reached a finalizing status. A bulk data script flipped 62 status-less
//     POs to 'completed' on 2026-10-06 06:58:48 and armed it mid-afternoon,
//     five hours before the vendor subscribed. No deploy correlated with the
//     breakage, so nothing pointed at a release.
//  2. The failure mode is an EMPTY RESULT, which every caller treats as "the
//     vendor qualifies for nothing" — a legitimate answer. The frontend's
//     `if (rfqs.length > 0)` simply never fired.
//
// `NOT EXISTS` is NULL-safe and the same cost or cheaper (Postgres plans both
// as an anti-join, and NOT EXISTS avoids the hash-anti-join NULL bailout). So
// there is no case where `NOT IN (SELECT ...)` is the right tool here, and the
// rule is mechanical enough to enforce rather than remember.
//
// Scope note: this bans only the SUBQUERY form. `NOT IN ($1, $2)` against a
// value list built in JS is fine and is used widely — those values come from
// code, not from a nullable column.

import { describe, it, expect } from "@jest/globals";
import fs from "fs";
import path from "path";

const ROOTS = ["app", "scripts"].map((d) => path.resolve(process.cwd(), d));

/**
 * `NOT IN` followed by an opening paren and then a SELECT, tolerating any
 * whitespace/newlines/comments between them — which is how it appears in the
 * multi-line template literals this codebase writes SQL in. Deliberately
 * loose: a guard that only catches one spelling catches nothing.
 */
const NOT_IN_SUBQUERY = /NOT\s+IN\s*\(\s*(?:--[^\n]*\n\s*)*SELECT\b/i;

function collect(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collect(full, acc);
    } else if (/\.(js|mjs|cjs|sql)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("NOT IN (SELECT ...) is banned — it returns NULL, not TRUE, on a NULL row", () => {
  it("appears nowhere in app/ or scripts/", () => {
    const offenders = [];

    for (const root of ROOTS) {
      if (!fs.existsSync(root)) continue;
      for (const file of collect(root)) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          // Join a small window so a `NOT IN (` that wraps onto the next line
          // is still matched.
          const window = lines.slice(i, i + 3).join("\n");
          if (NOT_IN_SUBQUERY.test(window)) {
            offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}`);
          }
        });
      }
    }

    // Dedupe overlapping windows reporting the same statement.
    const unique = [...new Set(offenders.map((o) => o.split(":")[0]))].sort();

    expect(unique).toEqual([]);
  });

  it("the regex actually catches the shapes we care about (guard the guard)", () => {
    // A guard whose pattern silently stops matching is worse than no guard, so
    // pin it against the real production spelling and its likely variants.
    const mustMatch = [
      "AND rp.id NOT IN (SELECT rfq_product_id FROM finalized_products)",
      "AND rp.id NOT IN (\n  SELECT rfq_product_id FROM finalized_products\n)",
      "where x not in (select y from z)",
      "AND a NOT IN(SELECT b FROM c)",
    ];
    for (const sql of mustMatch) {
      const lines = sql.split("\n");
      const matched = lines.some((_, i) => NOT_IN_SUBQUERY.test(lines.slice(i, i + 3).join("\n")));
      expect(matched).toBe(true);
    }

    // And must NOT fire on the legitimate value-list form.
    const mustNotMatch = [
      "AND user_id NOT IN ($1, $2, $3)",
      "AND status NOT IN ('draft', 'cancelled')",
      "WHERE id NOT IN (${placeholders})",
      "AND sheet_id NOT IN (1,2,3)",
    ];
    for (const sql of mustNotMatch) {
      expect(NOT_IN_SUBQUERY.test(sql)).toBe(false);
    }
  });
});
