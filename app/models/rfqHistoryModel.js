import db, { pgp } from '../config/dbConn.js';

/**
 * RFQ change-history model — backed by tbl_rfq_change_history.
 *
 * Each call to PUT /rfq/update generates one edit_session_id and inserts
 * one row per changed field. Sessions group those rows for the UI.
 *
 * See scripts/wh69_rfq_change_history.sql for the table definition.
 */

const HISTORY_COLUMNS = new pgp.helpers.ColumnSet(
  [
    'rfq_id',
    'edit_session_id',
    'entity_type',
    'entity_id',
    'entity_label',
    'field_name',
    'change_type',
    { name: 'old_value', mod: ':json' },
    { name: 'new_value', mod: ':json' },
    'is_material',
    'changed_by'
  ],
  { table: 'tbl_rfq_change_history' }
);

const rfqHistoryModel = {
  /**
   * Bulk-insert change rows for a single edit session.
   *
   * @param {number} rfqId
   * @param {string} editSessionId  - uuid v4
   * @param {number} userId         - tbl_users.id of the editor
   * @param {Array<Object>} changes - each: { entity_type, entity_id, entity_label,
   *                                          field_name, change_type, old_value,
   *                                          new_value, is_material }
   * @param {Object} txContext      - optional pg-promise tx
   */
  recordChanges: async (rfqId, editSessionId, userId, changes, txContext = null) => {
    if (!Array.isArray(changes) || changes.length === 0) return [];

    const dbContext = txContext || db;

    const rows = changes.map((c) => ({
      rfq_id: rfqId,
      edit_session_id: editSessionId,
      entity_type: c.entity_type,
      entity_id: c.entity_id ?? null,
      entity_label: c.entity_label ?? null,
      field_name: c.field_name ?? null,
      change_type: c.change_type,
      old_value: c.old_value ?? null,
      new_value: c.new_value ?? null,
      is_material: !!c.is_material,
      changed_by: userId
    }));

    const query = pgp.helpers.insert(rows, HISTORY_COLUMNS) + ' RETURNING *';
    return dbContext.any(query);
  },

  /**
   * Edit history for an RFQ, grouped by edit session, newest first.
   * Each session embeds the editor's name/email and the list of field changes.
   */
  getEditSessionsForRfq: async (rfqId, txContext = null) => {
    const dbContext = txContext || db;

    return dbContext.any(
      `
      SELECT
        h.edit_session_id,
        MIN(h.changed_at)            AS changed_at,
        BOOL_OR(h.is_material)       AS material,
        h.changed_by,
        u.name                       AS changed_by_name,
        u.email                      AS changed_by_email,
        json_agg(
          json_build_object(
            'id',           h.id,
            'entity_type',  h.entity_type,
            'entity_id',    h.entity_id,
            'entity_label', h.entity_label,
            'field_name',   h.field_name,
            'change_type',  h.change_type,
            'old_value',    h.old_value,
            'new_value',    h.new_value,
            'is_material',  h.is_material
          )
          ORDER BY h.id
        )                            AS changes
      FROM tbl_rfq_change_history h
      LEFT JOIN tbl_users u ON u.id = h.changed_by
      WHERE h.rfq_id = $1
      GROUP BY h.edit_session_id, h.changed_by, u.name, u.email
      ORDER BY MIN(h.changed_at) DESC
      `,
      [rfqId]
    );
  },

  /**
   * Returns the most recent change for each field of an RFQ, keyed by
   *   "${entity_type}:${entity_id ?? ''}:${field_name ?? ''}"
   * Powers the "Previously: X" indicator on the edit page.
   */
  getPreviousValues: async (rfqId, txContext = null) => {
    const dbContext = txContext || db;

    const rows = await dbContext.any(
      `
      SELECT DISTINCT ON (h.entity_type, h.entity_id, h.field_name)
        h.entity_type,
        h.entity_id,
        h.field_name,
        h.old_value,
        h.new_value,
        h.change_type,
        h.changed_at,
        h.changed_by,
        u.name AS changed_by_name
      FROM tbl_rfq_change_history h
      LEFT JOIN tbl_users u ON u.id = h.changed_by
      WHERE h.rfq_id = $1
        AND h.field_name IS NOT NULL
      ORDER BY h.entity_type, h.entity_id, h.field_name, h.changed_at DESC
      `,
      [rfqId]
    );

    const map = {};
    for (const r of rows) {
      const key = `${r.entity_type}:${r.entity_id ?? ''}:${r.field_name ?? ''}`;
      map[key] = {
        old_value: r.old_value,
        change_type: r.change_type,
        changed_at: r.changed_at,
        changed_by: r.changed_by,
        changed_by_name: r.changed_by_name
      };
    }
    return map;
  }
};

export default rfqHistoryModel;
