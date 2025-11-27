import db from '../config/dbConn.js';
import { sendApprovalNotification, sendPONotificationToVendor } from '../controllers/po/purchaseOrderEmails.js';
import { APPROVAL_DECISIONS, PO_STATUSES } from '../util/constants.js';

import { PutObjectCommand } from "@aws-sdk/client-s3";
import s3Client from "../config/s3config.js";
import fs from "fs";

const generalModel = {
  // 25-05-2025 Mukul jatav
  // insertMany: used to insert multiple records into a table, Prevents SQL injection for values using positional placeholders, Suitable for low-to-medium data volume, problem is still we useing use input table_name good we create alist of while list tables for such models
  // Example usage:
  //  const tableName = "tbl_product_variant_vendor_make";
  //  const data = [dor_map_id: 101, make_name: "Jindal"},
  //   { variant_vendor_map_id: 102, make_name: "SAIL"}
  // ];
  insertMany: async (tableName, data) => {
    return new Promise(async (resolve, reject) => {
      if (!tableName || !data || !Array.isArray(data) || data.length === 0) {
        return reject(
          new Error('Table name and non-empty data array are required.')
        );
      }

      const columns = Object.keys(data[0]);
      const columnList = columns.map((col) => `"${col}"`).join(', ');
      const values = [];
      const valuePlaceholders = data
        .map((row) => {
          const placeholders = columns
            .map((col) => {
              values.push(row[col]);
              return `$${values.length}`;
            })
            .join(', ');
          return `(${placeholders})`;
        })
        .join(', ');

      const query = `INSERT INTO ${tableName} (${columnList}) VALUES ${valuePlaceholders} RETURNING *;`;
      db.any(query, values).then(resolve).catch(reject);
    });
  },

  // 25-05-2025 mukul jatav
  //Fetches a list of unique, non-null values from a specified column of a given table, ordered ascendingly.
  // return response like [{id:1, value:"abc"}]
  getUniqueColumnValues: (tableName, columnName) => {
    return new Promise(async (resolve, reject) => {
      if (!tableName || !columnName) {
        return reject(new Error('Table name and column name are required.'));
      }

      // Validate inputs (basic sanity check to avoid SQL injection)
      const validTableName = /^[a-zA-Z0-9_]+$/.test(tableName);
      const validColumnName = /^[a-zA-Z0-9_]+$/.test(columnName);

      if (!validTableName || !validColumnName) {
        return reject(new Error('Invalid table or column name.'));
      }

      const query = `
      SELECT DISTINCT ON ("${columnName}") 
      id AS "id", 
      "${columnName}" AS "value"
      FROM "${tableName}"
      WHERE "${columnName}" IS NOT NULL
      ORDER BY "${columnName}" ASC;
    `;

      try {
        const result = await db.any(query);
        resolve(result);
      } catch (error) {
        console.error(
          `Error fetching unique values for ${tableName}.${columnName}:`,
          error
        );
        reject(error);
      }
    });
  },

  /**  26-05-2025 Mukul Jatav
 deleteManyByIds: Deletes multiple records from a table based on an array of IDs. 
 Suitable for batch deletions without changing existing core delete logic. 
 Prevents SQL injection for values using positional placeholders.
 Example usage: await rfqModel.deleteManyByIds("tbl_product_variant_vendor_make", [1, 2, 3]);
 
 NOTE:: 2 similar model already exit in rfq model, not using them as they just relete simgle product and changes them require lots of testing and this feature has to be shipped ASAP
 */
  deleteManyByIds: (tableName, idArray) => {
    return new Promise(async (resolve, reject) => {
      if (
        !tableName ||
        !idArray ||
        !Array.isArray(idArray) ||
        idArray.length === 0
      ) {
        return reject(
          new Error('Table name and non-empty id array are required.')
        );
      }

      // Validate inputs (basic sanity check)
      const validTableName = /^[a-zA-Z0-9_]+$/.test(tableName);
      if (!validTableName) {
        return reject(new Error('Invalid table name.'));
      }

      // Prepare placeholders for IDs
      const placeholders = idArray
        .map((_, index) => `$${index + 1}`)
        .join(', ');
      const query = `DELETE FROM "${tableName}" WHERE id IN (${placeholders}) RETURNING *;`;

      try {
        const result = await db.any(query, idArray);
        resolve(result); // Returns deleted rows
      } catch (error) {
        console.error(`Error deleting from ${tableName}:`, error);
        reject(error);
      }
    });
  },


  /**
  created_by 13-08-2025 Mukul Jatav
 updateMany: batch update rows by a key (default "id") using a single SQL statement with CASE expressions.
 - Prevents SQL injection for values via positional placeholders
 - Validates inputs; throws descriptive errors
 - Returns all updated rows
NOTE: Consider maintaining a whitelist of allowed table names elsewhere (same as insertMany).

Example usage:
const rows = [ { id: 8, type: 'credit', value: 10, days: 2, comment: null } ];
await generalModel.updateMany('tbl_quote_payment_terms', rows); 
*/
    updateMany: async (tableName, rows, key = 'id') => {
    if (!tableName) throw new Error('Table name is required.');
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('Non-empty array of rows is required.');
    }

    // Ensure all rows have the key and same columns
    const allKeysPresent = rows.every(r => Object.prototype.hasOwnProperty.call(r, key));
    if (!allKeysPresent) {
      throw new Error(`Every row must include the primary key "${key}".`);
    }

    // Build set of columns to update (exclude the key)
    const columns = Object.keys(rows[0]).filter(c => c !== key);
    if (columns.length === 0) {
      throw new Error('No updatable columns found (only key present).');
    }

    // Optional: ensure all rows have the same column set
    for (const r of rows) {
      const cols = Object.keys(r).filter(c => c !== key);
      if (cols.length !== columns.length || !columns.every(c => cols.includes(c))) {
        throw new Error('All rows must have the same set of columns to update.');
      }
    }

    // Build CASE expressions for each column
    // "col" = CASE "key" WHEN $1 THEN $2 WHEN $3 THEN $4 ... ELSE "col" END
    const values = [];
    const setClauses = columns.map(col => {
      const whens = rows.map(r => {
        values.push(r[key]);      // WHEN <id>
        values.push(r[col]);      // THEN <value>
        const a = values.length - 1;
        const b = values.length;
        return `WHEN $${a} THEN $${b}`;
      }).join(' ');

      return `"${col}" = CASE "${key}" ${whens} ELSE "${col}" END`;
    }).join(', ');

    // WHERE "key" IN (...)
    const idPlaceholders = rows.map(r => {
      values.push(r[key]);
      return `$${values.length}`;
    }).join(', ');

    const query = `
      UPDATE ${tableName}
      SET ${setClauses}
      WHERE "${key}" IN (${idPlaceholders})
      RETURNING *;
    `;

    try {
      const updated = await db.any(query, values);
      return updated;
    } catch (err) {
      // Log with context; rethrow a clean error
      console.error(`updateMany failed for ${tableName}:`, {
        message: err?.message,
        code: err?.code,
        detail: err?.detail
      });
      throw new Error('Failed to batch update records. Please try again or check server logs.');
    }
  },

  getStates: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_location_states ORDER BY state_name ASC`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getCountryStates: async (country_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_location_states WHERE country_id = $1 ORDER BY state_name ASC`,
        [country_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getCities: async (state_id) => {
    let q = `SELECT tlc.*, tls.country_id FROM tbl_location_cities tlc JOIN tbl_location_states tls ON tlc.state_id = tls.id ORDER BY city_name ASC`;
    let value = [];
    if (state_id) {
      q = `SELECT tlc.*, tls.country_id 
     FROM tbl_location_cities tlc
     JOIN tbl_location_states tls 
     ON tlc.state_id = tls.id 
     WHERE tlc.state_id = $1 
     ORDER BY city_name ASC`;
      value = [state_id];
    }

    return new Promise(function (resolve, reject) {
      db.any(q, value)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.log(err);
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getCountries: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_location_country ORDER BY country_name ASC`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getCountryCode: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_country_code ORDER BY phone_code ASC`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  doesHierarchyExist: async (type, companyId, firstUser) => {
    try {
      const raw = await db.any(`
        SELECT id
        FROM tbl_approval_hierarchy
        WHERE company_id = $1
          AND hierarchy_type = $2
          AND approval_level = 1
          AND (user_id = $3 OR $3 IS NULL)
        ORDER BY hierarchy_type, approval_level
      `, [companyId, type, firstUser?.user_id]);

      return raw && raw.length > 0;
    } catch (error) {
      throw error;
    }
  },
  deleteFromTable: async (tableName, columnName, value) => {
    //general function to delete a record from any table
    return new Promise((resolve, reject) => {
      // Validate inputs
      if (!tableName || !columnName) {
        return reject(new Error('Invalid table or column name'));
      }
      if (value === undefined || value === null) {
        return reject(new Error('Value to delete is required'));
      }

      const query = `DELETE FROM ${tableName} WHERE ${columnName} = $1`;

      db.result(query, [value])
        .then((result) => {
          if (result.rowCount > 0) {
            resolve({
              message: 'Delete successful',
              rowCount: result.rowCount
            });
          } else {
            resolve({ message: 'No rows deleted', rowCount: result.rowCount });
          }
        })
        .catch((err) => {
          console.error('Error executing query', err);
          reject(new Error('Database error'));
        });
    });
  },

  /**
   * Extract filters from request data (query or body)
   *
   * @param {Object} req - Express request object
   * @param {Array<string>} keys - Keys to extract from req.query or req.body
   * @returns {Object} filter object with all keys set to value or null
   */
  generateFilters: (data, keys = []) => {
    const filters = {};

    keys.forEach((key) => {
      let value = data[key];

      if (value === undefined || value === null || (Array.isArray(value) && value.length <= 0)) {
        filters[key] = null;
        return;
      }

      // Try to parse JSON (e.g., arrays like ["a", "b"])
      try {
        const parsed = JSON.parse(value);
        if (
          typeof parsed === 'string' ||
          typeof parsed === 'number' ||
          typeof parsed === 'object' ||
          Array.isArray(parsed)
        ) {
          filters[key] = parsed;
          return;
        }
      } catch (e) {
        // Not valid JSON, continue
      }

      // If it's a number string like "42", convert to number
      if (!isNaN(value) && value.trim() !== '') {
        filters[key] = Number(value);
      } else {
        // Otherwise, treat it as a string
        filters[key] = value;
      }
    });

    return filters;
  },

  /**
   * Generate SQL WHERE conditions from a filters object
   *
   * @param {Object} filters - Object with keys and their filter values
   * @returns {string} SQL conditions string (e.g. "category = 'electronics' AND price IN (100, 200)")
   */
  generateSQLConditions: (filters = {}, joinQuery = false) => {
    const conditions = {};

    Object.entries(filters).forEach(([key, value]) => {
      if (value === null || value === undefined) return;

      if (typeof value === 'string' || typeof value === 'number') {
        // Escape single quotes in strings
        const escapedValue =
          typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : value;
        conditions[key] = `${key} = ${escapedValue}`;
      } else if (Array.isArray(value)) {
        const validArray = value.filter(
          (v) => typeof v === 'string' || typeof v === 'number'
        );

        if (validArray.length > 0) {
          const inValues = validArray
            .map((v) =>
              typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v
            )
            .join(', ');
          conditions[key] = `${key} IN (${inValues})`;
        }
      }
    });

    return joinQuery ? Object.values(conditions).join(' AND ') : conditions;
  },

  // Hierarchy Model Functions
  getHierarchies: async (type, companyId) => {
    try {
      const raw = await db.any(`
        SELECT
          TAH.hierarchy_type,
          TAH.hierarchy_id,
          TAH.company_id,
          user_id AS id,
          U.name,
          U.email,
          TAH.approval_level AS level,
          TAH.bypass_cap,
          TAH.is_active AS active,
          EXISTS (
              SELECT 1
              FROM tbl_hierarchy_default_mapping THDM
              WHERE THDM.company_id = $1
              AND THDM.hierarchy_type = TAH.hierarchy_type
              AND THDM.hierarchy_id = TAH.hierarchy_id
          ) AS is_default,
          COALESCE(
            (
              SELECT JSON_AGG(
                  JSON_BUILD_OBJECT(
                      'id', THPM.id,
                      'project_id', THPM.project_id,
                      'hierarchy_id', THPM.hierarchy_id,
                      'hierarchy_type', THPM.hierarchy_type
                  )
              )
              FROM tbl_hierarchy_project_mapping THPM
              WHERE THPM.hierarchy_id = TAH.hierarchy_id AND THPM.hierarchy_type = TAH.hierarchy_type
            ),
            '[]'::json
          ) AS mapped_project_ids,
          TAH.created_at
        FROM tbl_approval_hierarchy TAH
        JOIN tbl_users U ON TAH.user_id = U.id
        WHERE TAH.company_id = $1
        ${type ? ' AND hierarchy_type = $2' : ''}
        ORDER BY hierarchy_id, approval_level
      `, [companyId, type]);

      const grouped = raw.reduce((acc, row) => {
        const { hierarchy_type, company_id, hierarchy_id, mapped_project_ids, is_default, ...rest } = row;

        const accKey = `${hierarchy_type}_${hierarchy_id}`

        if (!acc[accKey]) {
          acc[accKey] = {
            hierarchy_type,
            company_id,
            hierarchy_id,
            mapped_project_ids,
            is_default,
            approvers: [],
          };
        }

        acc[accKey].approvers.push(rest);

        return acc;
      }, {});

      return Object.values(grouped);
    } catch (error) {
      throw error;
    }
  },
  getUserHierarchies: async (type, companyId, userId, projectId, currentUserOnly) => {
    try {
      // Initialize an array for query parameters
      const params = [companyId];
      let paramIndex = 2; // Start index for dynamic parameters

      // Build the WHERE clause dynamically
      let whereClauses = ['TAH.company_id = $1'];

      // 1. Filter by hierarchy_type
      if (type) {
        whereClauses.push(`TAH.hierarchy_type = $${paramIndex++}`);
        params.push(type);
      }

      // 2. Filter by currentUserOnly (requires joining TAH to itself or using a subquery)
      let currentUserOnlyJoin = '';
      if (currentUserOnly) {
        // Use a subquery/EXISTS to check if the current user is part of the hierarchy
        whereClauses.push(`EXISTS (
            SELECT 1
            FROM tbl_approval_hierarchy TAH2
            WHERE TAH2.hierarchy_id = TAH.hierarchy_id
              AND TAH2.hierarchy_type = TAH.hierarchy_type
              AND TAH2.company_id = $1
              AND TAH2.user_id = $${paramIndex++}
          )`);
        params.push(userId);
      }
      
      // Determine the parameter index for the current user's ID in the main SELECT (used for is_current_user)
      const userIdParamIndex = paramIndex++; 
      params.push(userId); // Add userId to parameters for the CASE statement

      const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      const raw = await db.any(
        `
        SELECT
          TAH.hierarchy_type,
          TAH.hierarchy_id,
          TAH.company_id,
          TAH.user_id AS id,
          CASE WHEN TAH.user_id = $${userIdParamIndex} THEN TRUE ELSE FALSE END AS is_current_user,
          U.name,
          U.email,
          TAH.approval_level AS level,
          TAH.bypass_cap,
          TAH.is_active AS active,
          -- New is_default logic: Check project mapping first, then global default
          CASE
            WHEN $${paramIndex} IS NOT NULL AND THPM_main.project_id IS NOT NULL THEN TRUE
            WHEN EXISTS (
                SELECT 1
                FROM tbl_hierarchy_default_mapping THDM
                WHERE THDM.company_id = $1
                AND THDM.hierarchy_type = TAH.hierarchy_type
                AND THDM.hierarchy_id = TAH.hierarchy_id
            ) THEN TRUE
            ELSE FALSE
          END AS is_default,
          COALESCE(
            (
              SELECT JSON_AGG(
                  JSON_BUILD_OBJECT(
                      'id', THPM.id,
                      'project_id', THPM.project_id,
                      'hierarchy_id', THPM.hierarchy_id,
                      'hierarchy_type', THPM.hierarchy_type
                  )
              )
              FROM tbl_hierarchy_project_mapping THPM
              WHERE THPM.hierarchy_id = TAH.hierarchy_id AND THPM.hierarchy_type = TAH.hierarchy_type
            ),
            '[]'::json
          ) AS mapped_project_ids,
          TAH.created_at
        FROM tbl_approval_hierarchy TAH
        JOIN tbl_users U ON TAH.user_id = U.id
        -- Main join for project-specific default check
        LEFT JOIN tbl_hierarchy_project_mapping THPM_main 
          ON THPM_main.hierarchy_id = TAH.hierarchy_id
          AND THPM_main.hierarchy_type = TAH.hierarchy_type
          AND THPM_main.company_id = $1
          AND THPM_main.project_id = $${paramIndex}
        ${whereClause}
        ORDER BY hierarchy_id, approval_level
        `,
        [...params, projectId] // Append projectId to the end for the main JOIN/CASE statement
      );
      
      // Since projectId is used in the main SELECT and JOIN, we append it to the params array last
      // and update paramIndex to point to its position.
      const projectIdParamIndex = paramIndex; 
      params.push(projectId);


      const grouped = raw.reduce((acc, row) => {
        const { hierarchy_type, company_id, hierarchy_id, mapped_project_ids, is_default, ...rest } = row;

        // Use a consistent key for grouping
        const accKey = `${hierarchy_type}_${hierarchy_id}`;

        if (!acc[accKey]) {
          acc[accKey] = {
            hierarchy_type,
            company_id,
            hierarchy_id,
            // mapped_project_ids is duplicated on every row, so we can pick it up once.
            mapped_project_ids, 
            is_default,
            approvers: [],
          };
        }

        acc[accKey].approvers.push(rest);

        return acc;
      }, {});

      return Object.values(grouped);
    } catch (error) {
      throw error;
    }
  },
  createHierarchy: async (type, approvers, companyId, createdBy) => {
    try {
      const lastHierarchy = await db.oneOrNone(
        `SELECT hierarchy_id 
        FROM tbl_approval_hierarchy WHERE company_id = $1
        ORDER BY hierarchy_id DESC
        LIMIT 1`,
        [companyId]
      );

      const hierarchyExist = await generalModel.doesHierarchyExist(type, companyId)

      const nextHierarchyId = lastHierarchy?.hierarchy_id ? parseInt(lastHierarchy.hierarchy_id) + 1 : 1

      let baseData = {
        hierarchy_type: type,
        company_id: companyId,
        created_at: new Date(),
        hierarchy_id: nextHierarchyId
      };
      const insertableData = approvers.map(approver => ({...baseData, ...approver}));

      await generalModel.insertMany('tbl_approval_hierarchy', insertableData);

      if(!hierarchyExist) {
        await db.none(
          `INSERT INTO tbl_hierarchy_default_mapping
          (hierarchy_id, hierarchy_type, company_id, created_by)
          VALUES($1, $2, $3, $4)`,
          [nextHierarchyId, type, companyId, createdBy]
        )
      }
      return true;
    } catch (error) {
      throw error;
    }
  },
  updateHierarchy: async (type, approvers, removableApprovers = [], companyId, hierarchyId) => {
    try {
      const updatePromises = approvers.map(async (approver) => {
        const exists = await db.oneOrNone(
          `SELECT id FROM tbl_approval_hierarchy
          WHERE hierarchy_id = $1 AND company_id = $2 AND user_id = $3 AND hierarchy_type = $4`,
          [hierarchyId, companyId, approver.user_id, type]
        );

        if (exists) {
          // UPDATE existing record
          return db.none(
            `UPDATE tbl_approval_hierarchy
            SET approval_level = $1,
                bypass_cap = $2,
                is_active = $3
            WHERE id = $4`,
            [approver.approval_level, approver.bypass_cap, approver.is_active ?? true, exists.id]
          );
        } else {
          // INSERT new record
          return db.none(
            `INSERT INTO tbl_approval_hierarchy (company_id, user_id, approval_level, bypass_cap, hierarchy_type, is_active, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              companyId,
              approver.user_id,
              approver.approval_level,
              approver.bypass_cap,
              type,
              approver.is_active ?? true,
              new Date()
            ]
          );
        }
      });

      // Filter out removableApprovers already included in approvers
      const approverUserIds = approvers.map(a => a.user_id);
      const finalRemovals = removableApprovers
        .filter((id) => !approverUserIds.includes(id))
        .map(Number)
        .filter(Boolean);

      let deleteQuery = Promise.resolve();
      if (finalRemovals.length > 0) {
        deleteQuery = db.none(
          `DELETE FROM tbl_approval_hierarchy
          WHERE company_id = $1 AND hierarchy_type = $2 AND user_id IN ($3:csv)`,
          [companyId, type, finalRemovals]
        );
      }

      await Promise.all([...updatePromises, deleteQuery]);
      return true;
    } catch (error) {
      throw error;
    }
  },
  mapHierarchyToProject: async (hierarchy_id, hierarchy_type, project_id, company_id, mapped_by) => {
    return db.tx(async t => {
      let result = [];

      if(project_id && Array.isArray(project_id)) {
        await t.none(
          `DELETE FROM tbl_hierarchy_project_mapping
          WHERE company_id = $1 AND hierarchy_id = $2 AND hierarchy_type = $3`,
          [company_id, hierarchy_id, hierarchy_type]
        )
        for(let project of project_id) {
    
          const r = await t.one(
            `INSERT INTO tbl_hierarchy_project_mapping
            (company_id, hierarchy_id, hierarchy_type, project_id, mapped_by)
            VALUES ($1, $2, $3, $4, $5)
            
            RETURNING *`,
            [company_id, hierarchy_id, hierarchy_type, project, mapped_by]
          )
    
          result.push(r);
        }
      }

      return result;
    })
  },
  setDefaultHierarchy: async (hierarchy_id, hierarchy_type, company_id, mapped_by) => {
    return db.tx(async t => {
      const exists = await t.oneOrNone(
        `SELECT id FROM tbl_hierarchy_default_mapping
          WHERE hierarchy_type = $1 AND company_id = $2
          LIMIT 1`,
          [hierarchy_type, company_id]
      );

      if(exists) {
        await t.none(
          `UPDATE tbl_hierarchy_default_mapping
            SET hierarchy_id = $2,
            created_by = $3
            WHERE id = $1`,
            [exists.id, hierarchy_id, mapped_by]
        )
      } else {
        await t.none(
          `INSERT INTO tbl_hierarchy_default_mapping
            (hierarchy_id, company_id, hierarchy_type, created_by)
            VALUES ($1, $2, $3, $4)`,
            [hierarchy_id, company_id, hierarchy_type, mapped_by]
        )
      }

      return true;
    })
  },
  getHierarchyTypes: async () => {
    return await db.any(
      `SELECT
        enumlabel AS value,
        INITCAP(REPLACE(enumlabel, '_', ' ')) AS label
        
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'hierarchy_type'
      ORDER BY pg_enum.enumsortorder;
      `
    );
  },
  initiateApproval: async (
    type, // 'po'
    entityId,
    companyId,
    initiatedBy,
    selected_hierarchy,
    meta = {},
    errors = {},
    t
  ) => {
    // 0. Cancel any pending approvals for same entity
    const existingTrx = await t.oneOrNone(
      `SELECT *
      FROM tbl_approval_hierarchy_transactions
      WHERE hierarchy_type = $1
        AND company_id = $2
        AND status IN ('pending', 'approved', 'rejected')
        AND meta ->> 'rfq_id' = $3
        AND meta ->> 'po_id' = $4`,
      [
        type,
        companyId,
        String(meta.rfq_id),           // meta.rfq_id must be passed as string
        String(entityId)
      ]
    );

    if (existingTrx) {
      if (existingTrx.status === 'approved') {
        throw new Error(errors.exist ?? 'An already approved request exists for this entity.');
      } else {
        // cancel old pending transaction and any ongoing PO for current rfqProductId
        // await t.none(
        //   `UPDATE tbl_approval_hierarchy_transactions
        //   SET status = 'cancelled', final_decision_by = $3, current_approver_id = NULL, updated_at = NOW()
        //   WHERE id = $1`,
        //   [existingTrx.id, APPROVAL_DECISIONS.CANCELLED, initiatedBy]
        // );

        // await t.none(
        //   `INSERT INTO tbl_approval_hierarchy_history
        //   (approval_transaction_id, approved_by, action, created_at)
        //   VALUES ($1, $2, $3, NOW())`,
        //   [existingTrx.id, initiatedBy, APPROVAL_DECISIONS.CANCELLED]
        // );

        // FOR NEW: Delete old transactions for ongoing PO approval hierarchy
        // await t.none(
        //   `DELETE FROM tbl_approval_hierarchy_transactions WHERE id = $1`,
        //   [existingTrx.id]
        // )
      }
    }

    // 1. Initiator's hierarchy
    let initiatorHierarchy = null;

    const projectId = (meta && meta.project_id) ? meta.project_id : null;
    const doesCompanyHaveHierarchy = await t.oneOrNone(
      `SELECT id
      FROM tbl_approval_hierarchy
      WHERE company_id = $1
      LIMIT 1`,
      [companyId]
    )

    if(selected_hierarchy) {
      initiatorHierarchy = await t.oneOrNone(
        `SELECT TAH.*
        FROM tbl_approval_hierarchy TAH
        
        WHERE TAH.company_id = $1
          AND TAH.user_id = $2
          AND TAH.hierarchy_type = $3
          AND TAH.hierarchy_id = $4
        LIMIT 1`,
        [companyId, initiatedBy, type, selected_hierarchy]
      );

      if (!initiatorHierarchy) {
        throw new Error('User is not part of the PO selected approval hierarchy');
      }
    } else {
      if (projectId) {
        // 1) Get hierarchy ids mapped to this company + project
        const mappedRows = await t.any(
          `SELECT hierarchy_id
          FROM tbl_hierarchy_project_mapping
          WHERE company_id = $1 AND project_id = $2 AND hierarchy_type = $3`,
          [companyId, projectId, type]
        );
  
        const mappedHierarchyIds = mappedRows && mappedRows.length
          ? [...new Set(mappedRows.map(r => parseInt(r.hierarchy_id)).filter(Boolean))]
          : [];
  
        if (mappedHierarchyIds.length) {
          // There are mappings - restrict to these hierarchy ids
          initiatorHierarchy = await t.oneOrNone(
            `SELECT TAH.*,
            CASE WHEN THDM.id IS NOT NULL THEN TRUE ELSE FALSE END AS is_default
            FROM tbl_approval_hierarchy TAH
            LEFT JOIN tbl_hierarchy_default_mapping THDM ON TAH.hierarchy_id = THDM.hierarchy_id 
              AND THDM.hierarchy_type = $3 
              AND THDM.company_id = $1
            
            WHERE TAH.company_id = $1
              AND TAH.user_id = $2
              AND TAH.hierarchy_type = $3
              AND is_active = true
              AND TAH.hierarchy_id = ANY($4)
            ORDER BY created_at DESC
            LIMIT 1`,
            [companyId, initiatedBy, type, mappedHierarchyIds]
          );
  
          // If mappings exist but user is not present in any mapped hierarchy -> throw error
          if (!initiatorHierarchy) {
            throw new Error('User is not part of the selected project approval hierarchy');
          }
        } else {
          // No mappings found for this project — fall back to company-wide behavior
          initiatorHierarchy = await t.oneOrNone(
            `SELECT TAH.*,
            CASE WHEN THDM.id IS NOT NULL THEN TRUE ELSE FALSE END AS is_default
            FROM tbl_approval_hierarchy TAH
            LEFT JOIN tbl_hierarchy_default_mapping THDM ON TAH.hierarchy_id = THDM.hierarchy_id 
              AND THDM.hierarchy_type = $3 
              AND THDM.company_id = $1
  
            WHERE TAH.company_id = $1
              AND TAH.user_id = $2
              AND TAH.hierarchy_type = $3
              AND TAH.is_active = true
              AND THDM.id IS NOT NULL
            ORDER BY TAH.created_at DESC
            LIMIT 1`,
            [companyId, initiatedBy, type]
          );
  
          if (!initiatorHierarchy) {
            throw new Error('User is not part of the company\'s default approval hierarchy');
          }
        }
      } else if(!projectId && doesCompanyHaveHierarchy) {
        // No project specified — original behavior
        initiatorHierarchy = await t.oneOrNone(
          `SELECT TAH.*,
          CASE WHEN THDM.id IS NOT NULL THEN TRUE ELSE FALSE END AS is_default
          FROM tbl_approval_hierarchy TAH
          LEFT JOIN tbl_hierarchy_default_mapping THDM ON TAH.hierarchy_id = THDM.hierarchy_id 
            AND THDM.hierarchy_type = $3 
            AND THDM.company_id = $1
  
          WHERE TAH.company_id = $1
            AND TAH.user_id = $2
            AND TAH.hierarchy_type = $3
            AND TAH.is_active = true
            AND THDM.id IS NOT NULL
          ORDER BY TAH.created_at DESC
          LIMIT 1`,
          [companyId, initiatedBy, type]
        );
  
        if (!initiatorHierarchy) {
          throw new Error('User is not part of the company\'s approval hierarchy');
        }
      }
    }

    // If there's no hierarchy at all (company has no hierarchies) -> auto-approve (your existing flow)
    if (!initiatorHierarchy) {
      let transaction = null;

      if(existingTrx) {
        transaction = await t.one(
          `UPDATE tbl_approval_hierarchy_transactions 
          SET current_approver_id = NULL, final_decision_by = $1, status = $2
          WHERE id = $3 RETURNING *`,
          [initiatedBy, APPROVAL_DECISIONS.APPROVED, existingTrx.id]
        );
      } else {
        transaction = await t.one(
          `INSERT INTO tbl_approval_hierarchy_transactions 
          (hierarchy_type, target_entity_id, company_id, initiated_by, current_approver_id, final_decision_by, meta, status)
          VALUES ($1, $2, $3, $4, NULL, $4, $5, $6) RETURNING *`,
          [type, entityId, companyId, initiatedBy, meta, APPROVAL_DECISIONS.APPROVED]
        );
      }
      await t.none(
        `INSERT INTO tbl_approval_hierarchy_history
        (approval_transaction_id, approved_by, action, created_at)
        VALUES ($1, $2, $3, NOW())`,
        [transaction.id, initiatedBy, APPROVAL_DECISIONS.APPROVED]
      );
      return {
        approval_required: false,
        current_approver_id: null
      };
    }

    const totalValue = Number(meta?.total_value ?? 0);
    const bypassCap = initiatorHierarchy.bypass_cap;

    // Find next approver (above the initiator)
    const nextApprover = await t.oneOrNone(
      `SELECT user_id FROM tbl_approval_hierarchy
      WHERE company_id = $1 AND hierarchy_type = $2 AND is_active = true
        AND approval_level > $3 AND hierarchy_id = $4
      ORDER BY approval_level
      LIMIT 1`,
      [companyId, type, initiatorHierarchy.approval_level, initiatorHierarchy.hierarchy_id]
    );

    // 2. Auto-approve case: bypass cap OR if there exist no higher approver
    if ((totalValue <= bypassCap) || !nextApprover) {
      let transaction = null;
      if(existingTrx) {
        transaction = await t.one(
          `UPDATE tbl_approval_hierarchy_transactions 
          SET current_approver_id = NULL, final_decision_by = $1, status = $2, hierarchy_id = $3
          WHERE id = $4 RETURNING *`,
          [initiatedBy, APPROVAL_DECISIONS.APPROVED, initiatorHierarchy.hierarchy_id, existingTrx.id]
        );
      } else {
        transaction = await t.one(
          `INSERT INTO tbl_approval_hierarchy_transactions 
          (hierarchy_type, target_entity_id, company_id, initiated_by, current_approver_id, final_decision_by, meta, status, hierarchy_id)
          VALUES ($1, $2, $3, $4, NULL, $4, $5, $6, $7) RETURNING *`,
          [type, entityId, companyId, initiatedBy, meta, APPROVAL_DECISIONS.APPROVED, initiatorHierarchy.hierarchy_id]
        );
      }
      await t.none(
        `INSERT INTO tbl_approval_hierarchy_history
        (approval_transaction_id, approved_by, action, created_at)
        VALUES ($1, $2, $3, NOW())`,
        [transaction.id, initiatedBy, APPROVAL_DECISIONS.APPROVED]
      );
      return {
        approval_required: false,
        current_approver_id: null
      };
    }

    // 4. Start approval chain
    if(existingTrx) {
      await t.one(
        `UPDATE tbl_approval_hierarchy_transactions 
        SET current_approver_id = $1, final_decision_by = NULL, status = $2, hierarchy_id = $3
        WHERE id = $4 RETURNING *`,
        [nextApprover.user_id, APPROVAL_DECISIONS.PENDING, initiatorHierarchy.hierarchy_id, existingTrx.id]
      );
    } else {
      await t.none(
        `INSERT INTO tbl_approval_hierarchy_transactions
        (hierarchy_type, target_entity_id, company_id, initiated_by, current_approver_id, meta, status, hierarchy_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [type, entityId, companyId, initiatedBy, nextApprover.user_id, meta, APPROVAL_DECISIONS.PENDING, initiatorHierarchy.hierarchy_id]
      );
    }

    return {
      approval_required: true,
      current_approver_id: nextApprover.user_id
    };
  },
  approveRequest: async ({
    transactionId,
    approvedBy,
    decision, // 'approved' or 'rejected'
    remarks = '',
    t,
  }) => {
    let returnValue = null;

    const trx = await t.one(
      `SELECT * FROM tbl_approval_hierarchy_transactions WHERE id = $1`,
      [transactionId]
    );

    if (trx.status !== 'pending') {
      throw new Error('This approval request has already been resolved.');
    }

    if (trx.current_approver_id !== approvedBy) {
      throw new Error('You are not authorized to act on this request.');
    }

    const { company_id, hierarchy_type } = trx;

    // REJECTION FLOW
    if (decision === 'rejected') {
      await t.none(
        `UPDATE tbl_approval_hierarchy_transactions
        SET status = $3, final_decision_by = $1, current_approver_id = NULL, updated_at = NOW()
        WHERE id = $2`,
        [approvedBy, transactionId, APPROVAL_DECISIONS.REJECTED]
      );
      returnValue = {
        is_rejected: true
      }
    } else {
      // Find next approver
      const currentLevel = await t.oneOrNone(
        `SELECT approval_level, bypass_cap FROM tbl_approval_hierarchy
        WHERE company_id = $1 AND hierarchy_type = $2 AND user_id = $3 AND hierarchy_id = $4`,
        [company_id, hierarchy_type, approvedBy, trx.hierarchy_id]
      );

      const nextApprover = await t.oneOrNone(
        `SELECT user_id FROM tbl_approval_hierarchy
        WHERE company_id = $1 AND hierarchy_type = $2 AND is_active = true
          AND approval_level > $3 AND hierarchy_id = $4
        ORDER BY approval_level
        LIMIT 1`,
        [company_id, hierarchy_type, currentLevel?.approval_level ?? 999, trx.hierarchy_id]
      );

      const totalValue = Number(trx?.meta?.total_value ?? 0);
      const bypassCap = currentLevel.bypass_cap;

      if ((totalValue <= bypassCap) || !nextApprover) {
        // This is the highest approver OR has enough cap → final approval
        await t.none(
          `UPDATE tbl_approval_hierarchy_transactions
          SET status = $3, final_decision_by = $1, current_approver_id = NULL, updated_at = NOW()
          WHERE id = $2`,
          [approvedBy, transactionId, APPROVAL_DECISIONS.APPROVED]
        );

        returnValue = {
          approval_required: false,
          current_approver_id: null
        };
      } else {
        // Forward to next approver
        await t.none(
          `UPDATE tbl_approval_hierarchy_transactions
          SET current_approver_id = $1, updated_at = NOW()
          WHERE id = $2`,
          [nextApprover.user_id, transactionId]
        );

        returnValue = {
          approval_required: true,
          current_approver_id: nextApprover.user_id
        };
      }
    }

    // Insert history log
    await t.none(
      `INSERT INTO tbl_approval_hierarchy_history
      (approval_transaction_id, approved_by, action, remarks, created_at)
      VALUES ($1, $2, $3, $4, NOW())`,
      [transactionId, approvedBy, decision === 'approved' ? APPROVAL_DECISIONS.APPROVED : APPROVAL_DECISIONS.REJECTED, remarks]
    );

    return returnValue;
  },
};


// Reusable components
export const markPOStatusChange = async (po_id, t, reject = false, user) => {
  try {
    const purchaseOrder = await t.one(
      `UPDATE tbl_rfq_purchase_order
       SET status = $2,
           updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [po_id, reject ? PO_STATUSES.REJECTED : PO_STATUSES.APPROVED]
    );

    // ⏳ Trigger email notifications to vendors and all the team members (Not yet)!
    if(!reject) {
      await sendPONotificationToVendor(purchaseOrder, user);
    }

    return true;
  } catch (error) {
    console.error('Failed to mark PO status chnged:', error);
    throw error;
  }
};

export const uploadToS3 = async (filePath, fileName) => {
  try {
    console.log(':file_folder: Starting upload process...');
    // Check file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    console.log(':white_check_mark: File found, reading file...');
    const fileBuffer = fs.readFileSync(filePath);
    const uploadParams = {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: `purchase-order/${fileName}`,
      Body: fileBuffer,
      ContentType: "application/pdf",
    };
    console.log(':rocket: Uploading to S3...');
    console.log('Bucket:', process.env.AWS_S3_BUCKET);
    console.log('Key:', `purchase-order/${fileName}`);
    const command = new PutObjectCommand(uploadParams);
    const response = await s3Client.send(command);
    console.log(":white_check_mark: Upload success. ETag:", response.ETag);
    const url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/purchase-order/${fileName}`;
    return {
      ok: true,
      url: url,
      etag: response.ETag
    };
  } catch (err) {
    console.error(":x: Upload error details:");
    console.error("Error name:", err.name);
    console.error("Error message:", err.message);
    console.error("Error code:", err.code);
    if (err.$metadata) {
      console.error("Request ID:", err.$metadata.requestId);
      console.error("HTTP Status:", err.$metadata.httpStatusCode);
    }
    return {
      ok: false,
      error: err.message
    };
  }
};

export default generalModel;
