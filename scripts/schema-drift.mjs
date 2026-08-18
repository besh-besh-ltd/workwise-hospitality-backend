#!/usr/bin/env node
/**
 * Compares two live databases column by column.
 *
 * Written because the two we have do not match: 20 columns and one whole table
 * exist only on staging, none of them owned by any migration file, and 11 more
 * columns differ in type or nullability — including tbl_quote_items' money
 * columns, which are float4 on staging and numeric(15,2) on production. Quote
 * totals therefore round differently in the two environments.
 *
 * That figure was 9 in the first draft of the audit, and THIS SCRIPT is what
 * corrected it. The hand-written query behind the draft rendered a column's type
 * as `data_type || coalesce('(' || character_maximum_length || ')', '')`, which
 * never reads numeric_precision — so unconstrained `numeric` and `numeric(15,2)`
 * both rendered as the bare string `numeric` and compared equal, hiding
 * tbl_purchase_order_product.unit_price and .total_price. COLUMNS_SQL below
 * renders precision and scale for numeric/decimal, which is the whole argument
 * for this existing as a script rather than as a query someone retypes each time.
 *
 * Not part of CI: this needs RDS credentials, and CI deliberately has none.
 * Run it before and after a re-baseline, and whenever staging behaves oddly.
 *
 *   node scripts/schema-drift.mjs --left hospitality_stage --right hospitality_main
 */
import pg from "pg";
import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { buildConnection } from "./lib/migrationConfig.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.HOST && existsSync(join(ROOT, ".env"))) dotenv.config({ path: join(ROOT, ".env") });

// Precision/scale only mean something for numeric/decimal (e.g. numeric(15,2)); for
// every other type — integer included — information_schema still fills in
// numeric_precision (32 for integer, 64 for bigint), which would render as a
// meaningless "integer(32,0)" on every row and drown the real drift in noise.
// Length likewise only applies to character types. Applied identically to both
// sides, so it cannot hide or invent drift — it only changes what gets printed.
const COLUMNS_SQL = `
  SELECT table_name, column_name,
         data_type
           || CASE WHEN data_type IN ('character varying', 'character', 'varchar', 'char')
                   THEN coalesce('(' || character_maximum_length || ')', '')
                   ELSE '' END
           || CASE WHEN data_type IN ('numeric', 'decimal')
                   THEN coalesce('(' || numeric_precision || ',' || coalesce(numeric_scale, 0) || ')', '')
                   ELSE '' END
           AS type,
         is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name NOT LIKE '%backup%'
     AND table_name NOT LIKE '%\\_bkp'
   ORDER BY table_name, column_name`;

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function snapshot(database) {
  const client = new pg.Client({ ...buildConnection(), database });
  await client.connect();
  try {
    const { rows } = await client.query(COLUMNS_SQL);
    return new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, `${r.type} null=${r.is_nullable}`]));
  } finally {
    await client.end();
  }
}

const leftName = flag("left", "hospitality_stage");
const rightName = flag("right", "hospitality_main");

const [left, right] = await Promise.all([snapshot(leftName), snapshot(rightName)]);

const onlyLeft = [...left.keys()].filter((k) => !right.has(k));
const onlyRight = [...right.keys()].filter((k) => !left.has(k));
const differing = [...left.keys()].filter((k) => right.has(k) && right.get(k) !== left.get(k));

console.log(`Schema drift: ${leftName} (left) vs ${rightName} (right)`);
console.log(`  columns: ${left.size} left, ${right.size} right\n`);

const section = (title, items, render) => {
  console.log(`${title}: ${items.length}`);
  for (const item of items) console.log(`  ${render(item)}`);
  console.log("");
};

section(`Only in ${leftName}`, onlyLeft, (k) => `${k}  ${left.get(k)}`);
section(`Only in ${rightName}`, onlyRight, (k) => `${k}  ${right.get(k)}`);
section("Type or nullability differs", differing, (k) => `${k}\n    left : ${left.get(k)}\n    right: ${right.get(k)}`);

const total = onlyLeft.length + onlyRight.length + differing.length;
if (total > 0) {
  console.error(`DRIFT: ${total} difference(s). No migration owns these — see the spec's inventory.`);
  process.exit(1);
}
console.log("OK: no drift.");
