// The signal for "a buyer scored this clause" must stay `buyer_id`.
// ----------------------------------------------------------------------------
// Nothing in the schema records that a technical clause has been assessed.
// buyer_id on tbl_rfq_product_tech_evaluation_vendors_response is written only
// by the buyer-scoring endpoint, so it IS that record.
//
// For a long time the code inferred it instead, by comparing the row's two
// timestamps: `score_timestamp <> timestamp`. Both take the same value when the
// row is created, but the vendor re-submit path runs `SET vendor_response = $1,
// timestamp = NOW()` and never touches score_timestamp — so any duplicate
// vendor submission moved the two apart and permanently marked the clause
// "scored" at buyer_marks, which defaults to 0.
//
// On RFQ 536405 that recorded a 0% technical FAILURE against a vendor no buyer
// had ever seen, put them in an approved round, triggered the auto-replacement
// engine, and froze the RFQ in the technical stage. Across production the
// inference disagreed with buyer_id on 234 of 2,105 answer rows: 35 vendor
// entries failed without assessment (9 of them real, priced bidders) and 17
// passed the same way.
//
// The inference is easy to reintroduce — it reads like a reasonable proxy, and
// it appeared in five places across two repos. This guard is here so the next
// person who reaches for it fails a test instead of a client's RFQ.

import { describe, it, expect } from "@jest/globals";
import fs from "fs";
import path from "path";

const BACKEND_ROOT = path.resolve(process.cwd(), "app");
const FRONTEND_ROOT = path.resolve(process.cwd(), "..", "frontend");

// Matches a comparison between score_timestamp and a response timestamp in
// either SQL or JS, in either order, however the columns are qualified or
// quoted. Deliberately loose: a guard that only catches the exact old spelling
// is a guard that catches nothing.
const TIMESTAMP_INFERENCE = new RegExp(
  [
    // SQL / JS: score_timestamp <op> ...timestamp
    String.raw`score_timestamp[\s\S]{0,80}?(!==?|<>|===)[\s\S]{0,40}?["'\`]?timestamp`,
    // ...and the mirrored spelling, e.g. response_timestamp !== score_timestamp
    String.raw`["'\`]?timestamp["'\`]?[\s\S]{0,40}?(!==?|<>|===)[\s\S]{0,80}?score_timestamp`,
  ].join("|"),
  "i"
);

// Prose about the defect is allowed everywhere — including in the file that
// documents it. Only executable code is scanned.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function sourceFiles(root, exts = [".js"]) {
  const out = [];
  const skip = new Set(["node_modules", ".next", ".git", "coverage", "dist", "build", "public", "tests", "__tests__"]);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.includes(path.extname(e.name)) && !e.name.includes(".test.")) out.push(full);
    }
  };
  walk(root);
  return out;
}

function offendingFiles(root) {
  return sourceFiles(root)
    .filter((f) => TIMESTAMP_INFERENCE.test(stripComments(fs.readFileSync(f, "utf8"))))
    .map((f) => path.relative(root, f));
}

describe("the guard itself", () => {
  // A guard that cannot fail is not a guard. Prove the pattern bites on each
  // spelling that actually shipped, before trusting it on the tree.
  it("catches the SQL spelling that shipped in rfqModel", () => {
    expect(
      TIMESTAMP_INFERENCE.test(
        `BOOL_AND(vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp) AS is_fully_evaluated`
      )
    ).toBe(true);
  });

  it("catches the JS spelling that shipped in poDashboardModel", () => {
    // The shipped form aliased the response timestamp to resp_ts. The pattern
    // still bites, because score_timestamp appears on both sides of a
    // comparison. It errs toward false positives on purpose — a maintainer
    // stopped by this guard can move a genuine null-check onto its own line;
    // a maintainer NOT stopped by it ships another 536405.
    expect(
      TIMESTAMP_INFERENCE.test(
        `const scored = cr.score_timestamp != null && new Date(cr.score_timestamp).getTime() !== new Date(cr.resp_ts).getTime();`
      )
    ).toBe(true);
    expect(
      TIMESTAMP_INFERENCE.test(
        `const scored = resp.score_timestamp !== resp.timestamp;`
      )
    ).toBe(true);
  });

  it("catches the frontend spelling that shipped in ClauseProductItem", () => {
    expect(
      TIMESTAMP_INFERENCE.test(`return resp.response_timestamp !== resp.score_timestamp;`)
    ).toBe(true);
  });

  it("does not fire on the correct signal", () => {
    expect(TIMESTAMP_INFERENCE.test(`BOOL_AND(vr.buyer_id IS NOT NULL) AS is_fully_evaluated`)).toBe(false);
    expect(TIMESTAMP_INFERENCE.test(`const scored = cr.buyer_id != null;`)).toBe(false);
    // Selecting or writing the column is fine — only comparing the two is not.
    expect(TIMESTAMP_INFERENCE.test(`SET buyer_id = $1, buyer_marks = $2, score_timestamp = NOW()`)).toBe(false);
    expect(TIMESTAMP_INFERENCE.test(`vr.score_timestamp,\n vr."timestamp" AS resp_ts`)).toBe(false);
  });
});

describe("no production code infers a score from timestamp drift", () => {
  it("holds across the backend", () => {
    expect(offendingFiles(BACKEND_ROOT)).toEqual([]);
  });

  it("holds across the frontend, when it is checked out alongside", () => {
    if (!fs.existsSync(FRONTEND_ROOT)) {
      // CI runs the two repos separately; the frontend has its own copy of this
      // guard. Nothing to assert here.
      return;
    }
    const roots = ["components", "hooks", "utils", "pages", "services"]
      .map((d) => path.join(FRONTEND_ROOT, d))
      .filter((d) => fs.existsSync(d));
    const offenders = roots.flatMap((r) =>
      sourceFiles(r, [".js", ".jsx"])
        .filter((f) => TIMESTAMP_INFERENCE.test(stripComments(fs.readFileSync(f, "utf8"))))
        .map((f) => path.relative(FRONTEND_ROOT, f))
    );
    expect(offenders).toEqual([]);
  });
});
