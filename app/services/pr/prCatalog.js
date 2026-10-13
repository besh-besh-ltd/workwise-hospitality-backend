// Purchase Requisitions — catalog guards (spec §8 guided buying, §9 map/convert).
//
//   isUsableVariant / variantCategoryId / describeVariants
//       The RFQ "usable" predicate (rfqModel.searchProduct) and the category a
//       catalog line is filed under. A PR line may only reference a variant the
//       RFQ wizard would accept, so conversion can never produce an RFQ line
//       the wizard rejects.
//   contractCoverage
//       Variants with a live rate contract for (hotel × department). Those must
//       go through MR, not PR. The SQL is mrModel.contractedVariantPredicateSql —
//       the very predicate behind the MR item picker — so "blocked on PR" and
//       "offered by MR" can never disagree.
//
// Used at save (create/update), and again at submit / map / convert by later
// tasks: the catalog can change between draft and use.

import db from '../../config/dbConn.js';
import { contractedVariantPredicateSql } from '../../models/mr/mrModel.js';

// Aliases: pv = tbl_product_variant, p = tbl_product. Copied from
// rfqModel.searchProduct (matched_variants) — keep the two in step.
export const USABLE_VARIANT_SQL =
  'p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND pv.is_approve = 1';

// The category a product is filed under for PR purposes: its lowest category id
// that exists in tbl_category. `productIdExpr` is a SQL expression.
export const FIRST_CATEGORY_SQL = (productIdExpr) => `(
  SELECT _fc_pc.category_id
    FROM tbl_product_categories _fc_pc
    JOIN tbl_category _fc_cat ON _fc_cat.id = _fc_pc.category_id
   WHERE _fc_pc.product_id = ${productIdExpr}
   ORDER BY _fc_pc.category_id
   LIMIT 1)`;

const toIds = (ids) => [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/**
 * One round trip for many variants.
 * @returns {Promise<Map<number, {usable: boolean, category_id: number|null, name: string|null}>>}
 *   Variants that do not exist are absent from the map.
 */
export async function describeVariants(variantIds, t = db) {
  const ids = toIds(variantIds);
  const out = new Map();
  if (!ids.length) return out;
  const rows = await t.any(
    `SELECT pv.id,
            pv.name,
            COALESCE((${USABLE_VARIANT_SQL}), false) AS usable,
            ${FIRST_CATEGORY_SQL('pv.product_id')} AS category_id
       FROM tbl_product_variant pv
       LEFT JOIN tbl_product p ON p.id = pv.product_id
      WHERE pv.id = ANY($1::int[])`,
    [ids]
  );
  for (const r of rows) {
    out.set(Number(r.id), {
      usable: r.usable === true,
      category_id: r.category_id == null ? null : Number(r.category_id),
      name: r.name,
    });
  }
  return out;
}

export async function isUsableVariant(variantId, t = db) {
  const info = (await describeVariants([variantId], t)).get(Number(variantId));
  return info?.usable === true;
}

/** The variant's product's first category id (by id asc), or null. */
export async function variantCategoryId(variantId, t = db) {
  const info = (await describeVariants([variantId], t)).get(Number(variantId));
  return info?.category_id ?? null;
}

/**
 * Variants (of `variantIds`) that are on a live rate contract for the cell.
 * When several contracts cover one variant, the lowest contract id is reported.
 * @returns {Promise<Map<number, {arc_contract_id: number, arc_number: string}>>}
 */
export async function contractCoverage({ hotelId, departmentId, variantIds }, t = db) {
  const ids = toIds(variantIds);
  const out = new Map();
  if (!ids.length || !hotelId || !departmentId) return out;
  const contracted = contractedVariantPredicateSql('$1', '$2');
  const rows = await t.any(
    `SELECT DISTINCT ON (ai.product_variant_id)
            ai.product_variant_id, c.id AS arc_contract_id, a.arc_number
       FROM ${contracted.from}
      WHERE ${contracted.where}
        AND ai.product_variant_id = ANY($3::int[])
      ORDER BY ai.product_variant_id, c.id`,
    [Number(hotelId), Number(departmentId), ids]
  );
  for (const r of rows) {
    out.set(Number(r.product_variant_id), { arc_contract_id: Number(r.arc_contract_id), arc_number: r.arc_number });
  }
  return out;
}

export default { USABLE_VARIANT_SQL, FIRST_CATEGORY_SQL, describeVariants, isUsableVariant, variantCategoryId, contractCoverage };
