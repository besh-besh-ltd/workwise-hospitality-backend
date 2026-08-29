import db from '../config/dbConn.js';

/**
 * What would happen if this business unit or company were deleted.
 *
 * The rule (D-4): hard-delete only when nothing at all refers to it;
 * otherwise refuse, say precisely what is in the way, and offer to archive
 * instead. `is_deleted` already exists on both tables and every read query
 * already filters on it, so archiving is a real option rather than a
 * consolation.
 *
 * The database cannot be trusted to enforce this on its own, and that is the
 * whole reason this file exists. Two tables reference a hotel with **no
 * foreign key at all**, so a DELETE succeeds and silently orphans them:
 *
 *   tbl_user_role_scopes.hotel_id                 — who may do what, where
 *   tbl_vendor_hotel_category_subscription        — 4,064 rows keyed
 *     (item_type='hotel', item_id)                  polymorphically
 *
 * The second is the one that would hurt most and appears in no earlier
 * inventory of this: it is the table that decides which vendors can be
 * solicited for a unit. Orphaning it does not fail loudly — it quietly stops
 * vendors appearing on that unit's RFQs, which is exactly the shape of an
 * incident this codebase has already had.
 *
 * Three kinds of reference, because they mean different things to the person
 * deciding:
 *
 *   blocks    real work lives here (RFQs, contracts, requisitions, approvals)
 *   destroys  a DELETE would cascade this away without asking
 *   orphans   a DELETE would leave rows pointing at nothing
 */

const kinds = { BLOCKS: 'blocks', DESTROYS: 'destroys', ORPHANS: 'orphans' };

/** Each entry: what to count, and what it would mean. */
const HOTEL_REFERENCES = [
  { key: 'rfqs', label: 'RFQs', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_rfq WHERE hotel_id = $1' },
  { key: 'rate_contracts', label: 'Rate contracts', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_arc WHERE hotel_id = $1' },
  { key: 'material_requisitions', label: 'Material requisitions', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_material_requisition WHERE hotel_id = $1' },
  { key: 'approval_instances', label: 'Approvals raised here', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_approval_instances WHERE hotel_id = $1' },
  { key: 'approval_policies', label: 'Approval workflows', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_approval_policies WHERE hotel_id = $1' },

  { key: 'user_mappings', label: 'People mapped to this unit', kind: kinds.DESTROYS,
    sql: 'SELECT count(*)::int FROM tbl_hospitality_user_mappings WHERE hospitality_hotel_id = $1' },
  { key: 'project_mappings', label: 'Projects mapped to this unit', kind: kinds.DESTROYS,
    sql: 'SELECT count(*)::int FROM tbl_hospitality_project_mappings WHERE hospitality_hotel_id = $1' },
  { key: 'documents', label: 'Uploaded documents', kind: kinds.DESTROYS,
    sql: 'SELECT count(*)::int FROM tbl_hospitality_hotel_documents WHERE hospitality_hotel_id = $1' },
  { key: 'rfq_unit_mappings', label: 'RFQ unit mappings', kind: kinds.DESTROYS,
    sql: 'SELECT count(*)::int FROM tbl_rfq_hotel_mappings WHERE hotel_id = $1' },

  // No foreign key on either of these. The database will not stop the delete.
  { key: 'role_scopes', label: 'Role assignments scoped to this unit', kind: kinds.ORPHANS,
    sql: 'SELECT count(*)::int FROM tbl_user_role_scopes WHERE hotel_id = $1' },
  { key: 'vendor_subscriptions', label: 'Vendor subscriptions covering this unit', kind: kinds.ORPHANS,
    sql: `SELECT count(*)::int FROM tbl_vendor_hotel_category_subscription
           WHERE item_type = 'hotel' AND item_id = $1` },
];

const COMPANY_REFERENCES = [
  { key: 'business_units', label: 'Business units', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_hospitality_company_hotels WHERE hospitality_company_id = $1 AND COALESCE(is_deleted, 0) = 0' },
  { key: 'rfqs', label: 'RFQs', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_rfq WHERE hospitality_company_id = $1' },
  { key: 'rate_contracts', label: 'Rate contracts', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_arc WHERE hospitality_company_id = $1' },
  { key: 'material_requisitions', label: 'Material requisitions', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_material_requisition WHERE hospitality_company_id = $1' },
  { key: 'approval_instances', label: 'Approvals raised here', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_approval_instances WHERE hospitality_company_id = $1' },
  { key: 'approval_policies', label: 'Approval workflows', kind: kinds.BLOCKS,
    sql: 'SELECT count(*)::int FROM tbl_approval_policies WHERE hospitality_company_id = $1' },

  { key: 'user_mappings', label: 'People mapped to this company', kind: kinds.DESTROYS,
    sql: 'SELECT count(*)::int FROM tbl_hospitality_user_mappings WHERE hospitality_company_id = $1' },
  { key: 'project_mappings', label: 'Projects mapped to this company', kind: kinds.DESTROYS,
    sql: 'SELECT count(*)::int FROM tbl_hospitality_project_mappings WHERE hospitality_company_id = $1' },
  { key: 'documents', label: 'Uploaded documents', kind: kinds.DESTROYS,
    sql: 'SELECT count(*)::int FROM tbl_hospitality_company_documents WHERE hospitality_company_id = $1' },

  { key: 'role_scopes', label: 'Role assignments scoped to this company', kind: kinds.ORPHANS,
    sql: 'SELECT count(*)::int FROM tbl_user_role_scopes WHERE company_id = $1' },
];

async function countReferences(definitions, id) {
  const references = [];
  for (const def of definitions) {
    const row = await db.one(def.sql, [id]);
    const count = Number(Object.values(row)[0]) || 0;
    if (count > 0) references.push({ key: def.key, label: def.label, kind: def.kind, count });
  }
  return references;
}

/**
 * Counted every time rather than cached or short-circuited on the first hit.
 *
 * An admin deciding whether to archive needs the whole picture — "3 RFQs" and
 * "3 RFQs, 40 people and 900 vendor subscriptions" are different decisions —
 * and stopping at the first non-zero count would give them the first one.
 */
export async function previewHotelDeletion(hotelId) {
  const references = await countReferences(HOTEL_REFERENCES, hotelId);
  return {
    can_hard_delete: references.length === 0,
    references,
    total: references.reduce((sum, r) => sum + r.count, 0),
  };
}

export async function previewCompanyDeletion(companyId) {
  const references = await countReferences(COMPANY_REFERENCES, companyId);
  return {
    can_hard_delete: references.length === 0,
    references,
    total: references.reduce((sum, r) => sum + r.count, 0),
  };
}

/**
 * Hard delete, re-checked inside the transaction.
 *
 * The pre-flight an admin saw is a moment old by the time they click, and
 * anybody could have raised an RFQ against the unit in between. Re-running it
 * here is what makes the answer true rather than recent.
 */
export async function hardDeleteHotel(hotelId) {
  return db.tx(async (t) => {
    for (const def of HOTEL_REFERENCES) {
      const row = await t.one(def.sql, [hotelId]);
      if (Number(Object.values(row)[0]) > 0) {
        const err = new Error('This business unit is in use');
        err.code = 'UNIT_IN_USE';
        throw err;
      }
    }
    const result = await t.result(
      'DELETE FROM tbl_hospitality_company_hotels WHERE id = $1', [hotelId]
    );
    return result.rowCount;
  });
}

export async function hardDeleteCompany(companyId) {
  return db.tx(async (t) => {
    for (const def of COMPANY_REFERENCES) {
      const row = await t.one(def.sql, [companyId]);
      if (Number(Object.values(row)[0]) > 0) {
        const err = new Error('This company is in use');
        err.code = 'COMPANY_IN_USE';
        throw err;
      }
    }
    const result = await t.result(
      'DELETE FROM tbl_hospitality_companies WHERE id = $1', [companyId]
    );
    return result.rowCount;
  });
}

/**
 * Archive: the answer for a unit that cannot be deleted but should not be used.
 *
 * `is_deleted` is already on both tables and already filtered on by every read
 * query, so this hides the unit from every list without touching a single row
 * of the work that referenced it. Reversible, which a delete is not.
 */
export async function archiveHotel(hotelId, archived = true) {
  const result = await db.result(
    'UPDATE tbl_hospitality_company_hotels SET is_deleted = $2 WHERE id = $1',
    [hotelId, archived ? 1 : 0]
  );
  return result.rowCount;
}

export async function archiveCompany(companyId, archived = true) {
  const result = await db.result(
    'UPDATE tbl_hospitality_companies SET is_deleted = $2 WHERE id = $1',
    [companyId, archived ? 1 : 0]
  );
  return result.rowCount;
}
