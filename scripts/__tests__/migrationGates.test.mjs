import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../lib/migrationGates.mjs";

const BASE = ["20260101000000_old.up.sql", "20260101000000_old.down.sql"];

function run(overrides = {}) {
  return evaluate({
    headFiles: BASE,
    baseFiles: BASE,
    changes: [],
    contents: {},
    ...overrides,
  });
}

const gates = (result) => result.failures.map((f) => f.gate).sort();

test("a clean no-op passes every gate", () => {
  assert.deepEqual(run().failures, []);
});

test("gate 1 rejects a filename that is not a valid migration", () => {
  const r = run({ headFiles: [...BASE, "2026_05_26_legacy.sql"] });
  assert.deepEqual(gates(r), ["naming"]);
  assert.match(r.failures[0].message, /2026_05_26_legacy\.sql/);
});

test("gate 1 rejects a bare NAME.sql with no direction suffix", () => {
  assert.deepEqual(gates(run({ headFiles: [...BASE, "20260202000000_x.sql"] })), ["naming"]);
});

test("gate 2 rejects a new migration older than one already on the base branch", () => {
  const r = run({
    headFiles: [...BASE, "20251231000000_backdated.up.sql", "20251231000000_backdated.down.sql"],
    changes: [
      { status: "A", file: "20251231000000_backdated.up.sql" },
      { status: "A", file: "20251231000000_backdated.down.sql" },
    ],
    contents: { "20251231000000_backdated.up.sql": "SELECT 1;" },
  });
  assert.deepEqual(gates(r), ["ordering"]);
  assert.match(r.failures[0].message, /20260101000000/);
});

test("gate 2 accepts a new migration newer than everything on the base branch", () => {
  const r = run({
    headFiles: [...BASE, "20260202000000_new.up.sql", "20260202000000_new.down.sql"],
    changes: [
      { status: "A", file: "20260202000000_new.up.sql" },
      { status: "A", file: "20260202000000_new.down.sql" },
    ],
    contents: { "20260202000000_new.up.sql": "SELECT 1;" },
  });
  assert.deepEqual(r.failures, []);
});

test("gate 3 rejects a new up migration with no down and no irreversible marker", () => {
  const r = run({
    headFiles: [...BASE, "20260202000000_new.up.sql"],
    changes: [{ status: "A", file: "20260202000000_new.up.sql" }],
    contents: { "20260202000000_new.up.sql": "ALTER TABLE t ADD COLUMN c int;" },
  });
  assert.deepEqual(gates(r), ["reversibility"]);
});

test("gate 3 accepts a missing down when the up declares itself irreversible", () => {
  const r = run({
    headFiles: [...BASE, "20260202000000_backfill.up.sql"],
    changes: [{ status: "A", file: "20260202000000_backfill.up.sql" }],
    contents: {
      "20260202000000_backfill.up.sql": "-- irreversible: destroys the pre-split values\nUPDATE t SET c = 1;",
    },
  });
  assert.deepEqual(r.failures, []);
});

test("gate 4 rejects modifying a migration that is already on the base branch", () => {
  const r = run({ changes: [{ status: "M", file: "20260101000000_old.up.sql" }] });
  assert.deepEqual(gates(r), ["immutability"]);
  assert.match(r.failures[0].message, /already merged/i);
});

test("gate 4 rejects deleting a migration that is already on the base branch", () => {
  assert.deepEqual(gates(run({ changes: [{ status: "D", file: "20260101000000_old.up.sql" }] })), [
    "immutability",
  ]);
});

// Regression: a 100%-similarity `git mv` of an ALREADY-MERGED migration that was
// already in the .up.sql convention used to pass every gate. The ledger then keeps
// the old name while migrations/ yields the new one, and checkOrder compares them
// positionally — freezing every subsequent migrate:up on staging and production.
// CI cannot catch it once the migration is merged past the baseline: the replay
// applies it fresh under the new name and goes green.
test("gate 4 rejects renaming a merged .up.sql/.down.sql pair (deploy-freezing checkOrder conflict)", () => {
  const r = run({
    // Renamed as a pair, which is how it would really happen — renaming only one
    // half would additionally orphan the other, and that is a different gate.
    headFiles: ["20260101000000_renamed.up.sql", "20260101000000_renamed.down.sql"],
    baseFiles: BASE,
    changes: [
      {
        status: "R",
        similarity: 100,
        from: "20260101000000_old.up.sql",
        file: "20260101000000_renamed.up.sql",
      },
      {
        status: "R",
        similarity: 100,
        from: "20260101000000_old.down.sql",
        file: "20260101000000_renamed.down.sql",
      },
    ],
  });
  // Both halves flagged: the .down.sql source is in the new convention too.
  assert.deepEqual(gates(r), ["immutability", "immutability"]);
  assert.deepEqual(
    r.failures.map((f) => f.file),
    ["20260101000000_renamed.up.sql", "20260101000000_renamed.down.sql"]
  );
  const message = r.failures[0].message;
  assert.match(message, /already merged/i);
  // The message must name the consequence AND the remedy, not just the rule.
  assert.match(message, /Not run migration .* is preceding already run migration/);
  assert.match(message, /Rename it back/i);
  assert.match(message, /write a NEW migration/i);
});

// The other half of the same rule, and the one that must NOT regress: the
// adoption commit renamed 55 files, and every one of those SOURCES was a legacy
// bare NAME.sql — none was already .up.sql. That is exactly the discriminator
// gate 4 uses, so this shape has to keep passing.
test("gate 4 still accepts the adoption shape: legacy NAME.sql -> NAME.up.sql", () => {
  const r = run({
    headFiles: ["20260101000000_old.up.sql", "20260101000000_old.down.sql"],
    baseFiles: ["20260101000000_old.sql", "20260101000000_old.down.sql"],
    changes: [
      { status: "R", similarity: 100, from: "20260101000000_old.sql", file: "20260101000000_old.up.sql" },
    ],
  });
  assert.deepEqual(r.failures, []);
});

// A rename whose source is in the new convention but is NOT on the base branch is
// this branch's own work being tidied before review — nothing has recorded it in
// any ledger, so there is nothing to conflict with.
test("gate 4 allows renaming an unmerged .up.sql this branch itself added", () => {
  const r = run({
    headFiles: [...BASE, "20260202000000_final.up.sql", "20260202000000_final.down.sql"],
    changes: [
      {
        status: "R",
        similarity: 100,
        from: "20260202000000_draft.up.sql",
        file: "20260202000000_final.up.sql",
      },
    ],
  });
  assert.deepEqual(r.failures, []);
});

test("gate 4 rejects a rename that also changed the content", () => {
  const r = run({
    changes: [
      { status: "R", similarity: 87, from: "20260101000000_old.sql", file: "20260101000000_old.up.sql" },
    ],
  });
  assert.deepEqual(gates(r), ["immutability"]);
});

test("gate 4 coerces similarity string '100' to pass (regression: cross-file type discipline)", () => {
  // similarity arrives as a string from git-status parsing. A genuine 100%-similarity
  // rename must not fail due to string vs. number comparison, which would incorrectly
  // report "content-changing rename" for a pure rename.
  const r = run({
    headFiles: ["20260101000000_old.up.sql", "20260101000000_old.down.sql"],
    baseFiles: ["20260101000000_old.sql", "20260101000000_old.down.sql"],
    changes: [
      { status: "R", similarity: "100", from: "20260101000000_old.sql", file: "20260101000000_old.up.sql" },
    ],
  });
  assert.deepEqual(r.failures, []);
});

test("gate 4 coerces similarity string '87' to fail (regression: cross-file type discipline)", () => {
  const r = run({
    changes: [
      { status: "R", similarity: "87", from: "20260101000000_old.sql", file: "20260101000000_old.up.sql" },
    ],
  });
  assert.deepEqual(gates(r), ["immutability"]);
});

// Regression: an orphan .down.sql used to pass all five gates and then take out
// every migrate:up/down with node-pg-migrate's own
// "Found .down.sql without matching .up.sql" — a deploy failure for something a
// static gate can see at review time.
test("gate 3 rejects a .down.sql with no matching .up.sql", () => {
  const r = run({
    headFiles: [...BASE, "20260202000000_orphan.down.sql"],
    changes: [{ status: "A", file: "20260202000000_orphan.down.sql" }],
    contents: { "20260202000000_orphan.down.sql": "DROP TABLE t;" },
  });
  assert.deepEqual(gates(r), ["reversibility"]);
  assert.match(r.failures[0].message, /20260202000000_orphan\.up\.sql/);
  assert.match(r.failures[0].message, /Found \.down\.sql without matching \.up\.sql/);
});

// The orphan check looks at the whole HEAD tree, not just the diff — the runner
// does not care which commit unpaired the directory.
test("gate 3 rejects an orphan .down.sql even when this branch did not add it", () => {
  const r = run({
    headFiles: [...BASE, "20260202000000_orphan.down.sql"],
    baseFiles: [...BASE, "20260202000000_orphan.down.sql"],
  });
  assert.deepEqual(gates(r), ["reversibility"]);
});

// An up with no down is a DIFFERENT rule (gate 3b: allowed with an
// `-- irreversible:` marker). The orphan check must not fire on it.
test("gate 3's orphan check does not fire on an up migration with no down", () => {
  const r = run({
    headFiles: [...BASE, "20260202000000_backfill.up.sql"],
    changes: [{ status: "A", file: "20260202000000_backfill.up.sql" }],
    contents: { "20260202000000_backfill.up.sql": "-- irreversible: one-way backfill\nUPDATE t SET c = 1;" },
  });
  assert.deepEqual(r.failures, []);
});

test("gate 5 rejects statement-level BEGIN/COMMIT in a new migration", () => {
  const r = run({
    headFiles: [...BASE, "20260202000000_new.up.sql", "20260202000000_new.down.sql"],
    changes: [{ status: "A", file: "20260202000000_new.up.sql" }],
    contents: { "20260202000000_new.up.sql": "BEGIN;\nALTER TABLE t ADD COLUMN c int;\nCOMMIT;" },
  });
  assert.deepEqual(gates(r), ["transaction", "transaction"]);
});

test("gate 5 allows BEGIN inside a PL/pgSQL DO block", () => {
  const r = run({
    headFiles: [...BASE, "20260202000000_new.up.sql", "20260202000000_new.down.sql"],
    changes: [{ status: "A", file: "20260202000000_new.up.sql" }],
    contents: {
      "20260202000000_new.up.sql": "DO $$\nBEGIN\n  RAISE NOTICE 'hi';\nEND\n$$;",
    },
  });
  assert.deepEqual(r.failures, []);
});
