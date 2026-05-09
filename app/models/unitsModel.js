import db from "../config/dbConn.js";

const unitsModel = {
  /**
   * List units visible to a user — global defaults (created_by IS NULL)
   * plus that user's own custom rows. Defaults sort first, then customs;
   * each group is alphabetised by name.
   */
  listForUser: (userId) => {
    return db.any(
      `SELECT id, name, created_by IS NULL AS is_default
         FROM tbl_units
        WHERE created_by IS NULL OR created_by = $1
        ORDER BY (created_by IS NOT NULL), LOWER(name)`,
      [userId]
    );
  },

  /**
   * Insert a custom unit owned by the given user. Throws PG error 23505
   * if the (LOWER(name), created_by) pair already exists; the controller
   * catches that and returns 409 with the existing row.
   */
  insertForUser: (userId, name) => {
    return db.one(
      `INSERT INTO tbl_units (name, created_by)
       VALUES ($1, $2)
       RETURNING id, name, false AS is_default`,
      [name, userId]
    );
  },

  /**
   * Find a (default or user-owned) unit by its case-insensitive name.
   * Used to surface the duplicate row when an INSERT trips the unique index.
   */
  findByName: (userId, name) => {
    return db.oneOrNone(
      `SELECT id, name, created_by IS NULL AS is_default
         FROM tbl_units
        WHERE LOWER(name) = LOWER($1)
          AND (created_by IS NULL OR created_by = $2)
        LIMIT 1`,
      [name, userId]
    );
  },

  /**
   * Delete one of the user's own custom units. Returns the row id on
   * success, or null if no row matched (either it doesn't exist or it's
   * a global default the user doesn't own).
   */
  deleteOwn: (userId, id) => {
    return db.oneOrNone(
      `DELETE FROM tbl_units
        WHERE id = $1 AND created_by = $2
        RETURNING id`,
      [id, userId]
    );
  },
};

export default unitsModel;
