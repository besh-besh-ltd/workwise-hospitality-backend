/**
 * One definition of "is this vendor's subscription to this item still in force?"
 *
 * A vendor's relationship with one item — a hotel, a category, a subcategory —
 * is a HISTORY, not a single row: an original term lapses, a renewal is bought,
 * a subscription is cancelled, a new one is taken. tbl_vendor_hotel_category_
 * subscription keeps every one of those rows, distinguished by end_date (its
 * unique constraint is on vendor_id + item_type + item_id + end_date).
 *
 * Eligibility used to be decided per row: `status IN ('active','expired')`
 * anywhere in that history made the vendor eligible forever. Cancellation was
 * simply never consulted, so a vendor who cancelled kept receiving RFQs for as
 * long as ANY older lapsed row survived.
 *
 * Found on RFQ 536445 (The Orchid Manali). Vendor 220 (Fluidos) cancelled 23
 * Orchid properties in one self-service modification on 2026-05-30, keeping a
 * single unit. Three months later they were still being invited to Orchid Pune
 * RFQs — because Pune retained an older `expired` row from their first term —
 * while Manali, which had no such row, correctly went dark. Same vendor, same
 * category, two units, two different answers, and no way for the buyer to tell
 * why. Production held 12 such vendor/item pairs across 4 vendors.
 *
 * The rule: within one (vendor_id, item_type, item_id), the CURRENT row is the
 * latest by (end_date, id). Eligibility is that row's status. Expressed as a
 * row-local exclusion so it drops into every existing query unchanged:
 *
 *   a row is superseded if a `cancelled` row for the same item sorts after it.
 *
 * A cancellation therefore ends eligibility, while a cancellation FOLLOWED by a
 * fresh term does not — the newer row sorts last and wins. Cancelling sets
 * end_date to the cancellation date, so a live term (ending at the financial
 * year boundary) always sorts after an earlier cancellation; production has
 * zero rows where a cancellation outlasts an active term.
 *
 * This is deliberately NOT a database view: the eligibility predicate has to
 * work on a database that has not had a migration applied yet.
 */

/**
 * SQL fragment excluding subscription rows that a later cancellation supersedes.
 * Combine with the caller's own `status IN ('active','expired')` test.
 *
 * @param {string} alias - the table alias the caller gave
 *   tbl_vendor_hotel_category_subscription in the surrounding query.
 * @returns {string} a `NOT EXISTS (...)` fragment, safe to AND into a WHERE or
 *   a JOIN condition.
 */
export function notSupersededByCancellation(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(alias || ''))) {
    throw new Error(`notSupersededByCancellation: invalid SQL alias "${alias}"`);
  }
  return `NOT EXISTS (
          SELECT 1
          FROM tbl_vendor_hotel_category_subscription _sup_cancel
          WHERE _sup_cancel.vendor_id = ${alias}.vendor_id
            AND _sup_cancel.item_type = ${alias}.item_type
            AND _sup_cancel.item_id   = ${alias}.item_id
            AND _sup_cancel.status    = 'cancelled'
            AND (_sup_cancel.end_date, _sup_cancel.id) > (${alias}.end_date, ${alias}.id)
        )`;
}

/**
 * The full "subscription is in force" test, for callers writing a new query.
 * Equivalent to the two conditions every eligibility gate needs together.
 *
 * @param {string} alias
 * @returns {string}
 */
export function subscriptionInForce(alias) {
  return `${alias}.status IN ('active', 'expired') AND ${notSupersededByCancellation(alias)}`;
}

export default { notSupersededByCancellation, subscriptionInForce };
