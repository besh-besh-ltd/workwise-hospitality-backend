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

test("gate 4 accepts a 100%-similarity rename (the adoption commit)", () => {
  const r = run({
    headFiles: ["20260101000000_old.up.sql", "20260101000000_old.down.sql"],
    baseFiles: ["20260101000000_old.sql", "20260101000000_old.down.sql"],
    changes: [
      { status: "R", similarity: 100, from: "20260101000000_old.sql", file: "20260101000000_old.up.sql" },
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
