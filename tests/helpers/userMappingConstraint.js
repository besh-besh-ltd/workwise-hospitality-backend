// The unique key on tbl_hospitality_user_mappings
// (migrations/20261024120000_user_mapping_nulls_not_distinct.sql makes it
// NULLS NOT DISTINCT, so a company-level grant can no longer be stored twice).
//
// Tests that replay production's legacy state — the same company granted to
// one user two or three times, as existed before that migration — have to lift
// the key for their block. They capture the definition first and put back
// exactly that, so a suite can never leave the database weaker than it found
// it. Delete the replayed duplicates BEFORE restoring: the key cannot be
// re-added over them.
import { db } from "../setup/db.js";

export const USER_MAPPING_UNIQUE = "uq_hospitality_user_mapping";

export async function userMappingUniqueDef() {
  const row = await db.oneOrNone(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'public.tbl_hospitality_user_mappings'::regclass
        AND conname = $1`,
    [USER_MAPPING_UNIQUE]
  );
  return row?.def ?? null;
}

/** Drops the key if present; returns its definition for restoreUserMappingUnique. */
export async function dropUserMappingUnique() {
  const def = await userMappingUniqueDef();
  if (def) {
    await db.none(
      `ALTER TABLE public.tbl_hospitality_user_mappings DROP CONSTRAINT ${USER_MAPPING_UNIQUE}`
    );
  }
  return def;
}

export async function restoreUserMappingUnique(def) {
  if (def && !(await userMappingUniqueDef())) {
    await db.none(
      `ALTER TABLE public.tbl_hospitality_user_mappings ADD CONSTRAINT ${USER_MAPPING_UNIQUE} ${def}`
    );
  }
}
