import db from '../config/dbConn.js';
import { sendApprovalNotification, sendPONotificationToVendor } from '../controllers/po/purchaseOrderEmails.js';
import { APPROVAL_DECISIONS, PO_STATUSES } from '../util/constants.js';
import { sendApprovalStepNotification } from '../helper/sendEmailFunctions/approvalEmails.js';

// Maps entity_type to the permission resource used in tbl_permissions
const ENTITY_APPROVE_RESOURCE_MAP = {
  'RFQ': 'rfq',
  'TENDER': 'tender',
  'TECHNICAL': 'te',
  'NEGOTIATION': 'negotiation',
  'NEGOTIATION_QUOTE': 'quote-compare',
  'PO': 'awarding',
  'ARC': 'arc',
};

import { PutObjectCommand } from "@aws-sdk/client-s3";
import s3Client from "../config/s3config.js";
import fs from "fs";
import { logger } from '../util/logger.js';

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
            `INSERT INTO tbl_approval_hierarchy (company_id, user_id, approval_level, bypass_cap, hierarchy_type, is_active, hierarchy_id, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              companyId,
              approver.user_id,
              approver.approval_level,
              approver.bypass_cap,
              type,
              approver.is_active ?? true,
              hierarchyId,
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
  deleteHierarchy: async (hierarchyId, companyId, type) => {
    const exists = await db.any(
      `SELECT id FROM tbl_approval_hierarchy
      WHERE hierarchy_id = $1 AND company_id = $2 AND hierarchy_type = $3`,
      [hierarchyId, companyId, type]
    );

    if (exists.length == 0) throw new Error("Hierarchy does not exist!");

    await db.none(
      `DELETE FROM tbl_approval_hierarchy
      WHERE hierarchy_id = $1 AND company_id = $2 AND hierarchy_type = $3`,
      [hierarchyId, companyId, type]
    );

    return true
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


// --- Hospitality Approval Engine: Robust & Scalable Implementation ---

/**
 * APPROVAL ENGINE DESIGN:
 *
 * Policy Hierarchy (deepest match wins):
 *   1. Company + Hotel + Department (most specific)
 *   2. Company + Hotel
 *   3. Company only (least specific)
 *
 * Tables:
 *   - tbl_approval_policies: Policy definitions with scope (hospitality_company_id, hotel_id, department_id)
 *   - tbl_approval_policy_steps: Steps within a policy (order, decision_rule, approver source)
 *   - tbl_approval_instances: Runtime instances of approvals
 *   - tbl_approval_instance_steps: Runtime steps for an instance
 *   - tbl_approval_step_approvers: Approvers assigned to each step
 *   - tbl_approval_actions: Audit log of all actions taken
 *
 * Scope Validation:
 *   - Company/Hotel access: tbl_hospitality_user_mappings
 *   - Department membership: tbl_user_department
 */

// ============= HELPER FUNCTIONS =============

/**
 * Check if a user has access to a specific hospitality company/hotel scope
 * Uses tbl_hospitality_user_mappings for company/hotel validation
 */
async function userHasHospitalityAccess(userId, hospitalityCompanyId, hotelId = null, t = db) {
  if (hotelId) {
    // Check for hotel-level access or company-level access (which covers all hotels)
    // Using EXISTS to safely handle users with both hotel-level and company-level mappings
    const row = await t.one(`
      SELECT EXISTS (
        SELECT 1 FROM tbl_hospitality_user_mappings
        WHERE user_id = $1
          AND hospitality_company_id = $2
          AND (
            (mapping_type = 1 AND hospitality_hotel_id = $3)
            OR (mapping_type = 0 AND hospitality_hotel_id IS NULL)
          )
      ) AS has_access
    `, [userId, hospitalityCompanyId, hotelId]);
    return row.has_access;
  } else {
    // Check for company-level access
    // Using EXISTS to safely handle multiple mappings
    const row = await t.one(`
      SELECT EXISTS (
        SELECT 1 FROM tbl_hospitality_user_mappings
        WHERE user_id = $1
          AND hospitality_company_id = $2
      ) AS has_access
    `, [userId, hospitalityCompanyId]);
    return row.has_access;
  }
}

/**
 * Check if a user belongs to a specific department
 * Uses tbl_user_department for department membership validation
 */
async function userBelongsToDepartment(userId, departmentId, t = db) {
  if (!departmentId) return true; // No department restriction
  const row = await t.oneOrNone(`
    SELECT 1 FROM tbl_user_department
    WHERE user_id = $1 AND department_id = $2
  `, [userId, departmentId]);
  return Boolean(row);
}

/**
 * Check if user belongs to the target department OR any department with access_type = 'ALL'.
 * Used for INDIVIDUAL dept sub-graphs so that admin/ALL-access dept users are included.
 */
async function userBelongsToDepartmentOrAllAccess(userId, departmentId, t = db) {
  if (!departmentId) return true;
  const row = await t.oneOrNone(`
    SELECT 1 FROM tbl_user_department ud
    WHERE ud.user_id = $1
      AND (
        ud.department_id = $2
        OR ud.department_id IN (SELECT id FROM tbl_department WHERE access_type = 'ALL')
      )
  `, [userId, departmentId]);
  return Boolean(row);
}

/**
 * Full scope validation: company/hotel + department
 */
async function userHasFullScopeAccess(userId, hospitalityCompanyId, hotelId = null, departmentId = null, t = db) {
  const hasHospitalityAccess = await userHasHospitalityAccess(userId, hospitalityCompanyId, hotelId, t);
  if (!hasHospitalityAccess) return false;

  const belongsToDept = await userBelongsToDepartment(userId, departmentId, t);
  return belongsToDept;
}
// ============= APPROVAL PROCESSES =============

/**
 * Create a new approval process (universal business domain)
 * Processes are defined at parent company level and apply to all entity types
 * @param {Object} params - Process parameters
 * @param {number} params.company_id - Parent Company ID (required)
 * @param {string} params.name - Process name (e.g., 'Renovation', 'Day-to-Day')
 * @param {string|null} params.description - Process description
 * @param {number} params.created_by - User ID who created the process
 * @param {boolean} params.is_active - Whether process is active
 */
export async function createApprovalProcess({
  company_id,
  name,
  description = null,
  created_by,
  is_active = true,
  process_type: process_type_param = 'RFQ'
}) {
  if (!company_id || !name || !created_by) {
    throw new Error('company_id, name, and created_by are required');
  }

  // Validate company exists
  const companyExists = await db.oneOrNone(
    `SELECT id FROM tbl_company WHERE id = $1`,
    [company_id]
  );

  if (!companyExists) {
    throw new Error(`Company with ID ${company_id} does not exist`);
  }

  // Check for duplicate process name in company
  const existing = await db.oneOrNone(
    `SELECT id FROM tbl_approval_processes
     WHERE company_id = $1 AND name = $2`,
    [company_id, name]
  );

  if (existing) {
    throw new Error(`Process with name "${name}" already exists for this company`);
  }

  const process_type = process_type_param || 'RFQ';
  return db.one(
    `INSERT INTO tbl_approval_processes
     (company_id, name, description, created_by, is_active, process_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [company_id, name, description, created_by, is_active, process_type]
  );
}

/**
 * Get approval processes with optional filtering
 * @param {Object} params - Filter parameters
 * @param {number|null} params.company_id - Filter by parent company
 * @param {boolean} params.include_inactive - Include inactive processes
 * @param {string|null} params.process_type - Filter by process_type ('RFQ', 'TENDER', 'ARC'); e.g. 'RFQ' for wizard (Tender/ARC excluded)
 */
export async function getApprovalProcesses({
  company_id,
  include_inactive = false,
  process_type = null
}) {
  const conditions = [];
  const vals = [];
  let paramIdx = 1;

  if (company_id) {
    conditions.push(`p.company_id = $${paramIdx++}`);
    vals.push(company_id);
  }

  if (!include_inactive) {
    conditions.push('p.is_active = true');
  }

  if (process_type) {
    conditions.push(`p.process_type = $${paramIdx++}`);
    vals.push(process_type);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.any(`
    SELECT
      p.*,
      u.name as created_by_name,
      c.company_name
    FROM tbl_approval_processes p
    LEFT JOIN tbl_users u ON p.created_by = u.id
    LEFT JOIN tbl_company c ON p.company_id = c.id
    ${whereClause}
    ORDER BY p.name ASC
  `, vals);
}

/**
 * Update an approval process
 * @param {number} id - Process ID
 * @param {Object} patch - Fields to update
 */
export async function updateApprovalProcess(id, patch) {
  if (!id) throw new Error('Process ID is required');

  const allowedFields = ['name', 'description', 'is_active', 'process_type'];
  const sets = [];
  const vals = [];
  let idx = 1;

  for (const key of allowedFields) {
    if (patch.hasOwnProperty(key)) {
      sets.push(`${key} = $${idx++}`);
      vals.push(patch[key]);
    }
  }

  if (sets.length === 0) {
    throw new Error('No valid fields to update');
  }

  // If updating name, check for duplicates
  if (patch.name) {
    const process = await db.oneOrNone(
      `SELECT company_id FROM tbl_approval_processes WHERE id = $1`,
      [id]
    );

    if (process) {
      const duplicate = await db.oneOrNone(
        `SELECT id FROM tbl_approval_processes
         WHERE company_id = $1 AND name = $2 AND id != $3`,
        [process.company_id, patch.name, id]
      );

      if (duplicate) {
        throw new Error(`Process with name "${patch.name}" already exists for this company`);
      }
    }
  }

  vals.push(id);
  return db.oneOrNone(
    `UPDATE tbl_approval_processes SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
    vals
  );
}

/**
 * Soft delete a process (mark as inactive)
 * Validates that no active policies or pending approvals reference it
 * @param {number} id - Process ID
 */
export async function deleteApprovalProcess(id) {
  if (!id) throw new Error('Process ID is required');

  // Check if there are active policies using this process
  const activePolicies = await db.oneOrNone(`
    SELECT COUNT(*) as count
    FROM tbl_approval_policies
    WHERE process_id = $1 AND is_active = true
  `, [id]);

  if (activePolicies && parseInt(activePolicies.count) > 0) {
    throw new Error(`Cannot delete process: ${activePolicies.count} active policies are using it`);
  }

  // Check if there are pending instances using this process
  const pendingInstances = await db.oneOrNone(`
    SELECT COUNT(*) as count
    FROM tbl_approval_instances
    WHERE process_id = $1 AND status = 'PENDING'
  `, [id]);

  if (pendingInstances && parseInt(pendingInstances.count) > 0) {
    throw new Error(`Cannot delete process: ${pendingInstances.count} pending approvals exist`);
  }

  return db.none(
    'UPDATE tbl_approval_processes SET is_active = false, updated_at = NOW() WHERE id = $1',
    [id]
  );
}

// ============= APPROVAL POLICIES =============

/**
 * Create a new approval policy
 * @param {Object} params - Policy parameters
 * @param {string} params.entity_type - Type of entity (e.g., 'RFQ', 'PO', 'INDENT')
 * @param {number} params.hospitality_company_id - Hospitality Company ID (required)
 * @param {number|null} params.hotel_id - Hotel ID (optional, for hotel-specific policies)
 * @param {number|null} params.department_id - Department ID (optional, for dept-specific policies)
 * @param {number|null} params.process_id - Process ID (optional, for process-specific policies)
 * @param {number} params.created_by - User ID who created the policy
 * @param {boolean} params.is_active - Whether policy is active
 */
export async function createApprovalPolicy({
  entity_type,
  hospitality_company_id,
  hotel_id = null,
  department_id = null,
  process_id = null,
  created_by,
  is_active = true,
  is_master = false,
  is_department_scoped = true
}) {
  if (!entity_type || !hospitality_company_id || !created_by) {
    throw new Error('entity_type, hospitality_company_id, and created_by are required');
  }

  // If process_id provided, validate it belongs to the parent company
  if (process_id) {
    const hospCompany = await db.oneOrNone(
      `SELECT buyer_company_id AS company_id FROM tbl_hospitality_companies WHERE id = $1`,
      [hospitality_company_id]
    );

    if (!hospCompany) {
      throw new Error(`Hospitality company with ID ${hospitality_company_id} does not exist`);
    }

    const process = await db.oneOrNone(
      `SELECT id FROM tbl_approval_processes
       WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [process_id, hospCompany.company_id]
    );

    if (!process) {
      throw new Error('Process does not belong to this company or is inactive');
    }
  }

  // Check for duplicate policy with same scope (including process_id)
  const existing = await db.oneOrNone(
    `SELECT id FROM tbl_approval_policies
     WHERE entity_type = $1
       AND hospitality_company_id = $2
       AND COALESCE(hotel_id, 0) = COALESCE($3, 0)
       AND COALESCE(department_id, 0) = COALESCE($4, 0)
       AND COALESCE(process_id, 0) = COALESCE($5, 0)
       AND is_active = true`,
    [entity_type, hospitality_company_id, hotel_id, department_id, process_id]
  );

  if (existing) {
    throw new Error(`An active policy already exists for this scope. Policy ID: ${existing.id}`);
  }

  return db.one(
    `INSERT INTO tbl_approval_policies
     (entity_type, hospitality_company_id, hotel_id, department_id, process_id, created_by, is_active, is_master, is_department_scoped)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [entity_type, hospitality_company_id, hotel_id, department_id, process_id, created_by, is_active, is_master, is_department_scoped]
  );
}

/**
 * Update an existing approval policy
 */
export async function updateApprovalPolicy(id, patch) {
  if (!id) throw new Error('Policy ID is required');

  const allowedFields = ['entity_type', 'hospitality_company_id', 'hotel_id', 'department_id', 'process_id', 'is_active', 'is_master', 'is_department_scoped'];
  const sets = [];
  const vals = [];
  let idx = 1;

  // If process_id is being updated, validate it
  if (patch.hasOwnProperty('process_id') && patch.process_id !== null) {
    const policy = await db.oneOrNone(
      `SELECT hospitality_company_id FROM tbl_approval_policies WHERE id = $1`,
      [id]
    );

    if (policy) {
      const hospCompany = await db.oneOrNone(
        `SELECT buyer_company_id AS company_id FROM tbl_hospitality_companies WHERE id = $1`,
        [policy.hospitality_company_id]
      );

      if (hospCompany) {
        const process = await db.oneOrNone(
          `SELECT id FROM tbl_approval_processes
           WHERE id = $1 AND company_id = $2 AND is_active = true`,
          [patch.process_id, hospCompany.company_id]
        );

        if (!process) {
          throw new Error('Process does not belong to this company or is inactive');
        }
      }
    }
  }

  for (const key of allowedFields) {
    if (patch.hasOwnProperty(key)) {
      sets.push(`${key} = $${idx++}`);
      vals.push(patch[key]);
    }
  }

  if (sets.length === 0) {
    throw new Error('No valid fields to update');
  }

  vals.push(id);
  return db.oneOrNone(
    `UPDATE tbl_approval_policies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
    vals
  );
}

/**
 * Get approval policies with optional filtering
 * Returns policies ordered by specificity (most specific first)
 */
export async function getApprovalPolicies({ hospitality_company_id, hotel_id, department_id, entity_type, process_id, include_inactive = false }) {
  const conditions = ['TRUE'];
  const vals = [];
  let paramIdx = 1;

  if (hospitality_company_id) {
    conditions.push(`p.hospitality_company_id = $${paramIdx++}`);
    vals.push(hospitality_company_id);
  }
  if (hotel_id !== undefined) {
    conditions.push(`(p.hotel_id IS NULL OR p.hotel_id = $${paramIdx++})`);
    vals.push(hotel_id);
  }
  if (department_id !== undefined) {
    conditions.push(`(p.department_id IS NULL OR p.department_id = $${paramIdx++})`);
    vals.push(department_id);
  }
  if (entity_type) {
    conditions.push(`p.entity_type = $${paramIdx++}`);
    vals.push(entity_type);
  }
  if (process_id !== undefined) {
    conditions.push(`(p.process_id IS NULL OR p.process_id = $${paramIdx++})`);
    vals.push(process_id);
  }
  if (!include_inactive) {
    conditions.push('p.is_active = true');
  }

  // Order by specificity: process-specific policies rank higher than generic
  // Within each level, dept > hotel > company
  const query = `
    SELECT p.*,
           hc.name as company_name,
           hh.name as hotel_name,
           d.title as department_name,
           proc.name as process_name,
           CASE
             -- Process-specific policies (higher priority)
             WHEN p.process_id IS NOT NULL AND p.department_id IS NOT NULL AND p.hotel_id IS NOT NULL THEN 8
             WHEN p.process_id IS NOT NULL AND p.department_id IS NULL AND p.hotel_id IS NOT NULL THEN 7
             WHEN p.process_id IS NOT NULL AND p.department_id IS NULL AND p.hotel_id IS NULL THEN 6
             -- Generic policies (fallback, lower priority)
             WHEN p.process_id IS NULL AND p.department_id IS NOT NULL AND p.hotel_id IS NOT NULL THEN 5
             WHEN p.process_id IS NULL AND p.department_id IS NULL AND p.hotel_id IS NOT NULL THEN 4
             WHEN p.process_id IS NULL AND p.department_id IS NULL AND p.hotel_id IS NULL THEN 3
             ELSE 0
           END as specificity_score,
           u.name as created_by_name
    FROM tbl_approval_policies p
    LEFT JOIN tbl_hospitality_companies hc ON p.hospitality_company_id = hc.id
    LEFT JOIN tbl_hospitality_company_hotels hh ON p.hotel_id = hh.id
    LEFT JOIN tbl_department d ON p.department_id = d.id
    LEFT JOIN tbl_approval_processes proc ON p.process_id = proc.id
    LEFT JOIN tbl_users u ON p.created_by = u.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY specificity_score DESC, p.created_at DESC
  `;
  return db.any(query, vals);
}

/**
 * Find the best matching policy for a given scope (deepest match wins)
 * Process-specific policies always rank higher than generic policies
 * @param {Object} params - Scope parameters
 * @param {string} params.entity_type - Entity type (RFQ, PO, etc.)
 * @param {number} params.hospitality_company_id - Hospitality company ID
 * @param {number|null} params.hotel_id - Hotel ID (optional)
 * @param {number|null} params.department_id - Department ID (optional)
 * @param {number|null} params.process_id - Process ID (optional)
 * @returns {Object|null} The most specific matching policy or null
 */
export async function findBestMatchingPolicy({ entity_type, hospitality_company_id, hotel_id = null, department_id = null, process_id = null }) {
  if (!entity_type || !hospitality_company_id) {
    throw new Error('entity_type and hospitality_company_id are required');
  }

  // Master policy lookup: only find policies with department_id IS NULL (master policies)
  // Simplified 4-level specificity (department dimension removed)
  const policies = await db.any(`
    SELECT p.*,
           CASE
             WHEN p.process_id IS NOT NULL AND p.hotel_id IS NOT NULL THEN 4
             WHEN p.process_id IS NOT NULL AND p.hotel_id IS NULL THEN 3
             WHEN p.process_id IS NULL AND p.hotel_id IS NOT NULL THEN 2
             WHEN p.process_id IS NULL AND p.hotel_id IS NULL THEN 1
             ELSE 0
           END as specificity_score
    FROM tbl_approval_policies p
    WHERE p.entity_type = $1
      AND p.hospitality_company_id = $2
      AND p.is_active = true
      AND p.department_id IS NULL
      AND (p.process_id = $4 OR p.process_id IS NULL)
      AND (p.hotel_id = $3 OR p.hotel_id IS NULL)
    ORDER BY specificity_score DESC, p.created_at DESC
    LIMIT 1
  `, [entity_type, hospitality_company_id, hotel_id, process_id]);

  return policies.length > 0 ? policies[0] : null;
}

/**
 * Get all policies matching filters with their steps in a single batch query.
 * Used by ?include=steps to avoid N+1 per-policy step fetches.
 */
export async function getApprovalPoliciesWithSteps(filters) {
  const policies = await getApprovalPolicies(filters);
  if (!policies.length) return [];

  const policyIds = policies.map(p => p.id);
  const steps = await db.any(`
    SELECT s.*,
           CASE
             WHEN s.approver_source_type = 'USER' THEN (SELECT name FROM tbl_users WHERE id = s.approver_source_id)
             WHEN s.approver_source_type = 'ROLE' THEN (SELECT title FROM tbl_roles WHERE id = s.approver_source_id)
             WHEN s.approver_source_type = 'DEPARTMENT' THEN (SELECT title FROM tbl_department WHERE id = s.approver_source_id)
             ELSE NULL
           END as approver_source_name
    FROM tbl_approval_policy_steps s
    WHERE s.approval_policy_id = ANY($1::int[])
    ORDER BY s.approval_policy_id, s.step_order ASC
  `, [policyIds]);

  const stepsByPolicy = {};
  for (const step of steps) {
    if (!stepsByPolicy[step.approval_policy_id]) {
      stepsByPolicy[step.approval_policy_id] = [];
    }
    stepsByPolicy[step.approval_policy_id].push(step);
  }

  return policies.map(p => ({ ...p, steps: stepsByPolicy[p.id] || [] }));
}

/**
 * Get a policy with all its steps
 */
export async function getApprovalPolicyWithSteps(id) {
  const policy = await db.oneOrNone(`
    SELECT p.*,
           hc.name as company_name,
           hh.name as hotel_name,
           d.title as department_name,
           u.name as created_by_name
    FROM tbl_approval_policies p
    LEFT JOIN tbl_hospitality_companies hc ON p.hospitality_company_id = hc.id
    LEFT JOIN tbl_hospitality_company_hotels hh ON p.hotel_id = hh.id
    LEFT JOIN tbl_department d ON p.department_id = d.id
    LEFT JOIN tbl_users u ON p.created_by = u.id
    WHERE p.id = $1
  `, [id]);

  if (!policy) throw new Error('Policy not found');

  const steps = await db.any(`
    SELECT s.*,
           CASE
             WHEN s.approver_source_type = 'USER' THEN (SELECT name FROM tbl_users WHERE id = s.approver_source_id)
             WHEN s.approver_source_type = 'ROLE' THEN (SELECT title FROM tbl_roles WHERE id = s.approver_source_id)
             WHEN s.approver_source_type = 'DEPARTMENT' THEN (SELECT title FROM tbl_department WHERE id = s.approver_source_id)
             ELSE NULL
           END as approver_source_name
    FROM tbl_approval_policy_steps s
    WHERE approval_policy_id = $1
    ORDER BY step_order ASC
  `, [id]);

  return { ...policy, steps };
}

/**
 * Soft delete a policy (mark as inactive)
 */
export async function deleteApprovalPolicy(id) {
  // Check if there are pending instances using this policy
  const pendingInstances = await db.oneOrNone(`
    SELECT COUNT(*) as count
    FROM tbl_approval_instances
    WHERE approval_policy_id = $1 AND status = 'PENDING'
  `, [id]);

  if (pendingInstances && parseInt(pendingInstances.count) > 0) {
    throw new Error(`Cannot delete policy: ${pendingInstances.count} pending approval(s) exist`);
  }

  return db.none('UPDATE tbl_approval_policies SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
}

// ============= POLICY STEPS =============

/**
 * Insert steps for a policy (transactional)
 */
export async function insertPolicySteps(steps, approval_policy_id) {
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    throw new Error('At least one step is required');
  }

  return db.tx(async t => {
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Validate step
      if (!step.approver_source_type || !step.approver_source_id) {
        throw new Error(`Step ${i + 1}: approver_source_type and approver_source_id are required`);
      }
      if (!['USER', 'ROLE', 'DEPARTMENT'].includes(step.approver_source_type)) {
        throw new Error(`Step ${i + 1}: Invalid approver_source_type. Must be USER, ROLE, or DEPARTMENT`);
      }
      if (!['ALL', 'ANY'].includes(step.decision_rule || 'ANY')) {
        throw new Error(`Step ${i + 1}: Invalid decision_rule. Must be ALL or ANY`);
      }

      const r = await t.one(`
        INSERT INTO tbl_approval_policy_steps
        (approval_policy_id, step_order, approval_type, decision_rule, approver_source_type, approver_source_id)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          approval_policy_id,
          step.step_order || (i + 1),
          step.approval_type || 'STANDARD',
          step.decision_rule || 'ANY',
          step.approver_source_type,
          step.approver_source_id
        ]
      );
      results.push(r);
    }
    return results;
  });
}

/**
 * Delete all steps for a policy
 */
export async function deletePolicySteps(approval_policy_id) {
  return db.none('DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1', [approval_policy_id]);
}

// ============= APPROVAL INSTANCES =============

/**
 * Resolve approver user IDs based on source type
 * Uses tbl_hospitality_user_mappings for company/hotel scoping
 * Uses tbl_user_department for department membership
 * @param {Object} step - Policy step with approver_source_type and approver_source_id
 * @param {number} hospitality_company_id - Hospitality Company ID for scoping
 * @param {number|null} hotel_id - Hotel ID for scoping (optional)
 * @param {number|null} department_id - Department ID for filtering (optional)
 * @returns {Array<number>} Array of user IDs
 */
async function resolveApprovers(step, hospitality_company_id, hotel_id = null, department_id = null, departmentAccessType = null, t = db, initiatedBy = null) {
  const userIds = [];

  if (step.approver_source_type === 'USER') {
    // For USER type: check if user belongs to the department based on access type
    if (departmentAccessType === 'INDIVIDUAL' && department_id) {
      // INDIVIDUAL: user must belong to the specific department OR any ALL-access department
      const hasCompanyAccess = await userHasHospitalityAccess(step.approver_source_id, hospitality_company_id, hotel_id, t);
      const belongsToDeptOrAll = await userBelongsToDepartmentOrAllAccess(step.approver_source_id, department_id, t);
      if (hasCompanyAccess && belongsToDeptOrAll) {
        const user = await t.oneOrNone('SELECT id FROM tbl_users WHERE id = $1 AND status = 1', [step.approver_source_id]);
        if (user) userIds.push(user.id);
      }
    } else {
      // ALL or no department: just validate company/hotel access (no department filter)
      const hasAccess = await userHasHospitalityAccess(step.approver_source_id, hospitality_company_id, hotel_id, t);
      if (hasAccess) {
        const user = await t.oneOrNone('SELECT id FROM tbl_users WHERE id = $1 AND status = 1', [step.approver_source_id]);
        if (user) userIds.push(user.id);
      }
    }
  } else if (step.approver_source_type === 'ROLE') {
    if (departmentAccessType === 'INDIVIDUAL' && department_id) {
      // INDIVIDUAL: users with this role who belong to the specific department OR any ALL-access department
      const users = await t.any(`
        SELECT DISTINCT u.id
        FROM tbl_users u
        JOIN tbl_user_role_scopes urs ON u.id = urs.user_id AND urs.role_id = $1
          AND urs.company_id = $2
          AND (urs.hotel_id IS NULL OR urs.hotel_id = $3)
        JOIN tbl_hospitality_user_mappings hum ON u.id = hum.user_id
        JOIN tbl_user_department ud ON u.id = ud.user_id
          AND (ud.department_id = $5 OR ud.department_id IN (SELECT id FROM tbl_department WHERE access_type = 'ALL'))
        WHERE u.status = 1
          AND hum.hospitality_company_id = $2
          AND (
            ($3::int IS NULL AND hum.mapping_type = 0)
            OR (hum.hospitality_hotel_id = $3)
            OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL)
          )
      `, [step.approver_source_id, hospitality_company_id, hotel_id, hotel_id, department_id]);
      userIds.push(...users.map(u => u.id));
    } else {
      // ALL or no department: get ALL users with this role in company/hotel (no department filter)
      const users = await t.any(`
        SELECT DISTINCT u.id
        FROM tbl_users u
        JOIN tbl_user_role_scopes urs ON u.id = urs.user_id AND urs.role_id = $1
          AND urs.company_id = $2
          AND (urs.hotel_id IS NULL OR urs.hotel_id = $3)
        JOIN tbl_hospitality_user_mappings hum ON u.id = hum.user_id
        WHERE u.status = 1
          AND hum.hospitality_company_id = $2
          AND (
            ($3::int IS NULL AND hum.mapping_type = 0)
            OR (hum.hospitality_hotel_id = $3)
            OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL)
          )
      `, [step.approver_source_id, hospitality_company_id, hotel_id, hotel_id]);
      userIds.push(...users.map(u => u.id));
    }
  } else if (step.approver_source_type === 'DEPARTMENT') {
    // DEPARTMENT type: always resolve to users in the specified department (unchanged)
    const users = await t.any(`
      SELECT DISTINCT u.id
      FROM tbl_users u
      JOIN tbl_user_department ud ON u.id = ud.user_id AND ud.department_id = $1
      JOIN tbl_hospitality_user_mappings hum ON u.id = hum.user_id
      WHERE u.status = 1
        AND hum.hospitality_company_id = $2
        AND (
          ($3::int IS NULL AND hum.mapping_type = 0)
          OR (hum.hospitality_hotel_id = $3)
          OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL)
        )
    `, [step.approver_source_id, hospitality_company_id, hotel_id]);
    userIds.push(...users.map(u => u.id));
  }

  // Remove duplicates and filter out the creator (maker-checker pattern)
  let finalApprovers = [...new Set(userIds)];
  if (initiatedBy) {
    finalApprovers = finalApprovers.filter(id => id !== initiatedBy);
  }
  return finalApprovers;
}

/**
 * Check if a user is the final approver in an approval policy
 * A user is considered the final approver if they are in the last step of the policy
 * @param {number} userId - User ID to check
 * @param {Object} policy - Approval policy object
 * @param {Array} policySteps - Array of policy steps ordered by step_order
 * @param {number} hospitality_company_id - Hospitality Company ID
 * @param {number|null} hotel_id - Hotel ID (optional)
 * @param {number|null} department_id - Department ID (optional)
 * @param {Object} t - Transaction context
 * @returns {Promise<boolean>} - True if user is final approver
 */
async function isUserFinalApprover(userId, policy, policySteps, hospitality_company_id, hotel_id, department_id, departmentAccessType, t, entity_type = null) {
  if (!policySteps || policySteps.length === 0) {
    return false;
  }

  // Filter to only steps with approve permission (same logic as createApprovalInstance)
  let approverSteps = policySteps;
  if (entity_type) {
    approverSteps = [];
    for (const step of policySteps) {
      if (step.approver_source_type === 'ROLE') {
        const hasApprovePermission = await t.oneOrNone(`
          SELECT 1 FROM tbl_role_permissions rp
          JOIN tbl_permissions p ON rp.permission_id = p.id
          WHERE rp.role_id = $1 AND p.resource = $2 AND p.action = 'approve'
        `, [step.approver_source_id, ENTITY_APPROVE_RESOURCE_MAP[entity_type] || entity_type.toLowerCase()]);
        if (!hasApprovePermission) continue;
      }
      approverSteps.push(step);
    }
  }

  if (approverSteps.length === 0) {
    return false;
  }

  const lastStep = approverSteps[approverSteps.length - 1];

  const finalStepApprovers = await resolveApprovers(
    lastStep,
    hospitality_company_id,
    hotel_id,
    department_id,
    departmentAccessType,
    t,
    null
  );

  const approverIds = Array.isArray(finalStepApprovers) ? finalStepApprovers : [];
  return approverIds.includes(userId);
}

/**
 * Create an approval instance for an entity
 * Automatically finds the best matching policy if approval_policy_id is not provided
 *
 * @param {Object} params
 * @param {string} params.entity_type - Type of entity (e.g., 'RFQ', 'PO')
 * @param {number} params.entity_id - ID of the entity being approved
 * @param {number} params.hospitality_company_id - Hospitality Company ID
 * @param {number|null} params.hotel_id - Hotel ID (optional)
 * @param {number|null} params.department_id - Department ID (optional)
 * @param {number|null} params.process_id - Process ID (optional, for process-specific policies)
 * @param {number|null} params.approval_policy_id - Specific policy to use (optional, auto-detected if not provided)
 * @param {number} params.initiated_by - User ID who initiated the approval
 * @param {Object} params.metadata - Additional metadata to store with the instance
 */
export async function createApprovalInstance({
  entity_type,
  entity_id,
  hospitality_company_id,
  hotel_id = null,
  department_id = null,
  process_id = null,
  approval_policy_id = null,
  initiated_by,
  metadata = {},
  txContext = null  // Optional transaction context for participating in outer transaction
}) {
  if (!entity_type || !entity_id || !hospitality_company_id || !initiated_by) {
    throw new Error('entity_type, entity_id, hospitality_company_id, and initiated_by are required');
  }

  // If a transaction context is provided, use it; otherwise create a new transaction
  const executor = async (t) => {
    // 1. Check for existing pending/approved instance for this entity
    const existingInstance = await t.oneOrNone(`
      SELECT id, status FROM tbl_approval_instances
      WHERE entity_type = $1 AND entity_id = $2 AND status IN ('PENDING', 'APPROVED')
      ORDER BY created_at DESC LIMIT 1
    `, [entity_type, entity_id]);

    if (existingInstance) {
      if (existingInstance.status === 'APPROVED') {
        throw new Error('This entity has already been approved');
      }
      throw new Error(`A pending approval instance already exists. Instance ID: ${existingInstance.id}`);
    }

    // 2. Find the best matching policy
    let policy;
    if (approval_policy_id) {
      policy = await t.oneOrNone(`
        SELECT * FROM tbl_approval_policies WHERE id = $1 AND is_active = true
      `, [approval_policy_id]);
      if (!policy) {
        throw new Error('Specified policy not found or is inactive');
      }
      // Validate policy scope matches the request
      if (policy.hospitality_company_id !== hospitality_company_id) {
        throw new Error('Policy company does not match request company');
      }
    } else {
      policy = await findBestMatchingPolicyTx({ entity_type, hospitality_company_id, hotel_id, department_id, process_id }, t);
      if (!policy) {
        throw new Error(`No approval policy found for ${entity_type} in this scope`);
      }
    }

    // 3. Get policy steps
    const policySteps = await t.any(`
      SELECT * FROM tbl_approval_policy_steps
      WHERE approval_policy_id = $1
      ORDER BY step_order ASC
    `, [policy.id]);

    if (policySteps.length === 0) {
      throw new Error('Policy has no approval steps configured');
    }

    // 4. Resolve approvers before writing instance data so approval creation
    // never leaves a half-built pending instance behind.
    const resolvedSteps = [];
    let stepNumber = 0; // Track sequential step numbering

    // Use the policy's is_department_scoped flag to determine department filtering.
    // When false, all company/hotel users with the role should be approvers.
    // The original department_id is still stored in the instance row for audit.
    const isDeptScoped = policy.is_department_scoped === true;
    const resolveDeptId = isDeptScoped ? department_id : null;

    // Look up department access type for department-aware approver resolution
    let departmentAccessType = null;
    if (resolveDeptId) {
      const deptRow = await t.oneOrNone('SELECT access_type FROM tbl_department WHERE id = $1', [resolveDeptId]);
      departmentAccessType = deptRow?.access_type || 'INDIVIDUAL';
    }

    for (const policyStep of policySteps) {
      // For ROLE-based steps, skip if the role lacks approve permission for this entity type
      if (policyStep.approver_source_type === 'ROLE') {
        const hasApprovePermission = await t.oneOrNone(`
          SELECT 1 FROM tbl_role_permissions rp
          JOIN tbl_permissions p ON rp.permission_id = p.id
          WHERE rp.role_id = $1 AND p.resource = $2 AND p.action = 'approve'
          LIMIT 1
        `, [policyStep.approver_source_id, ENTITY_APPROVE_RESOURCE_MAP[entity_type] || entity_type.toLowerCase()]);
        if (!hasApprovePermission) continue;
      }

      // Resolve approvers for this step with department access type awareness
      const approverUserIds = await resolveApprovers(policyStep, hospitality_company_id, hotel_id, resolveDeptId, departmentAccessType, t, initiated_by);

      // Skip step if no approvers remain after excluding creator
      if (approverUserIds.length === 0) {
        continue;
      }

      stepNumber++; // Increment sequential step number

      resolvedSteps.push({
        policyStep,
        approverUserIds,
        stepOrder: stepNumber
      });
    }

    // 5. Create the approval instance only after all approvers are known
    const instance = await t.one(`
      INSERT INTO tbl_approval_instances
      (entity_type, entity_id, approval_policy_id, status, current_step, initiated_by, hospitality_company_id, hotel_id, department_id, process_id, metadata)
      VALUES ($1, $2, $3, 'PENDING', 1, $4, $5, $6, $7, $8, $9) RETURNING *
    `, [entity_type, entity_id, policy.id, initiated_by, hospitality_company_id, hotel_id, department_id, process_id, JSON.stringify(metadata)]);

    // 6. Handle case where all steps were skipped (creator was only approver for all steps)
    if (resolvedSteps.length === 0) {
      await t.none(`
        UPDATE tbl_approval_instances
        SET status = 'APPROVED', current_step = 0, completed_at = NOW()
        WHERE id = $1
      `, [instance.id]);

      return {
        instance: { ...instance, status: 'APPROVED', current_step: 0 },
        policy: { id: policy.id, entity_type: policy.entity_type },
        steps: [],
        totalSteps: 0,
        autoApproved: true
      };
    }

    // 7. Create instance steps and approvers
    const instanceSteps = [];

    for (const resolvedStep of resolvedSteps) {
      const { policyStep, approverUserIds, stepOrder } = resolvedStep;

      const instanceStep = await t.one(`
        INSERT INTO tbl_approval_instance_steps
        (approval_instance_id, step_order, decision_rule, status, policy_step_id)
        VALUES ($1, $2, $3, 'PENDING', $4) RETURNING *
      `, [instance.id, stepOrder, policyStep.decision_rule, policyStep.id]);

      // Insert approvers for this step
      for (const userId of approverUserIds) {
        await t.none(`
          INSERT INTO tbl_approval_step_approvers
          (approval_instance_step_id, approver_user_id, status)
          VALUES ($1, $2, 'PENDING')
        `, [instanceStep.id, userId]);
      }

      instanceSteps.push({ ...instanceStep, approverCount: approverUserIds.length });
    }

    // Send notification to step 1 approvers (fire-and-forget)
    try {
      const firstStep = instanceSteps[0];
      if (firstStep) {
        const step1Approvers = await t.any(`
          SELECT sa.approver_user_id as user_id, u.name as user_name, u.email as user_email
          FROM tbl_approval_step_approvers sa
          JOIN tbl_users u ON sa.approver_user_id = u.id
          WHERE sa.approval_instance_step_id = $1 AND sa.status = 'PENDING'
        `, [firstStep.id]);

        const initiator = await t.oneOrNone('SELECT name FROM tbl_users WHERE id = $1', [initiated_by]);

        sendApprovalStepNotification({
          entityType: entity_type,
          entityId: entity_id,
          entityIdentifier: metadata?.rfq_number || metadata?.po_number || `ID-${entity_id}`,
          stepOrder: 1,
          totalSteps: instanceSteps.length,
          initiatorName: initiator?.name || 'Unknown',
          approvers: step1Approvers,
          extraContext: { rfq_id: metadata?.rfq_id || entity_id }
        });
      }
    } catch (emailError) {
      console.error('Error sending approval step notification:', emailError);
    }

    return {
      instance,
      policy: { id: policy.id, entity_type: policy.entity_type },
      steps: instanceSteps,
      totalSteps: instanceSteps.length
    };
  };

  // If transaction context provided, use it; otherwise create new transaction
  if (txContext) {
    return typeof txContext.tx === 'function'
      ? txContext.tx(executor)
      : executor(txContext);
  }
  return db.tx(executor);
}

// Transaction-safe version of findBestMatchingPolicy
async function findBestMatchingPolicyTx({ entity_type, hospitality_company_id, hotel_id, department_id, process_id = null }, t) {
  const policies = await t.any(`
    SELECT p.*,
           CASE
             WHEN p.process_id IS NOT NULL AND p.hotel_id IS NOT NULL THEN 4
             WHEN p.process_id IS NOT NULL AND p.hotel_id IS NULL THEN 3
             WHEN p.process_id IS NULL AND p.hotel_id IS NOT NULL THEN 2
             WHEN p.process_id IS NULL AND p.hotel_id IS NULL THEN 1
             ELSE 0
           END as specificity_score
    FROM tbl_approval_policies p
    WHERE p.entity_type = $1
      AND p.hospitality_company_id = $2
      AND p.is_active = true
      AND p.department_id IS NULL
      AND (p.process_id = $4 OR p.process_id IS NULL)
      AND (p.hotel_id = $3 OR p.hotel_id IS NULL)
    ORDER BY specificity_score DESC, p.created_at DESC
    LIMIT 1
  `, [entity_type, hospitality_company_id, hotel_id, process_id]);

  return policies.length > 0 ? policies[0] : null;
}

// Export helper function to check if user is final approver
export async function checkIfUserIsFinalApprover(userId, entity_type, hospitality_company_id, hotel_id, department_id, txContext = null) {
  const t = txContext || db;

  // Find the best matching master policy
  const policy = await findBestMatchingPolicyTx({ entity_type, hospitality_company_id, hotel_id, department_id }, t);

  if (!policy) {
    return false;
  }

  // Get policy steps
  const policySteps = await t.any(`
    SELECT * FROM tbl_approval_policy_steps
    WHERE approval_policy_id = $1
    ORDER BY step_order ASC
  `, [policy.id]);

  if (policySteps.length === 0) {
    return false;
  }

  // Use the policy's is_department_scoped flag to determine department filtering
  const isDeptScoped = policy.is_department_scoped === true;
  const resolveDeptId = isDeptScoped ? department_id : null;

  // Look up department access type
  let departmentAccessType = null;
  if (resolveDeptId) {
    const deptRow = await t.oneOrNone('SELECT access_type FROM tbl_department WHERE id = $1', [resolveDeptId]);
    departmentAccessType = deptRow?.access_type || 'INDIVIDUAL';
  }

  // Check if user is final approver with department access type awareness
  return await isUserFinalApprover(userId, policy, policySteps, hospitality_company_id, hotel_id, resolveDeptId, departmentAccessType, t, entity_type);
}

/**
 * Get department sub-graph preview for a master policy
 * Shows how the master policy maps to each department based on access type
 */
export async function getDepartmentSubGraphPreview(policyId, hospitality_company_id, hotel_id) {
  // Get the policy with steps
  const policy = await db.oneOrNone('SELECT * FROM tbl_approval_policies WHERE id = $1 AND is_active = true', [policyId]);
  if (!policy) throw new Error('Policy not found or inactive');

  const steps = await db.any(`
    SELECT s.*,
           CASE
             WHEN s.approver_source_type = 'USER' THEN (SELECT name FROM tbl_users WHERE id = s.approver_source_id)
             WHEN s.approver_source_type = 'ROLE' THEN (SELECT title FROM tbl_roles WHERE id = s.approver_source_id)
             WHEN s.approver_source_type = 'DEPARTMENT' THEN (SELECT title FROM tbl_department WHERE id = s.approver_source_id)
             ELSE NULL
           END as approver_source_name
    FROM tbl_approval_policy_steps s
    WHERE approval_policy_id = $1
    ORDER BY step_order ASC
  `, [policyId]);

  // Get departments scoped to the company/hotel (only departments that have at least one user mapped to this company/hotel)
  const effectiveCompanyId = hospitality_company_id || policy.hospitality_company_id;
  const effectiveHotelId = hotel_id || policy.hotel_id;

  const departments = await db.any(`
    SELECT DISTINCT d.id, d.title, d.access_type
    FROM tbl_department d
    JOIN tbl_user_department ud ON d.id = ud.department_id
    JOIN tbl_hospitality_user_mappings hum ON ud.user_id = hum.user_id
    WHERE hum.hospitality_company_id = $1
      AND ($2::int IS NULL OR hum.mapping_type = 0 OR hum.hospitality_hotel_id = $2)
    ORDER BY d.access_type DESC, d.title ASC
  `, [effectiveCompanyId, effectiveHotelId || null]);

  // Split departments: ALL-access depts are shown as an info banner, not as separate cards.
  // Their users are automatically included in each INDIVIDUAL dept card via resolveApprovers.
  const allAccessDepts = departments.filter(d => (d.access_type || '').toUpperCase() === 'ALL');
  const individualDepts = departments.filter(d => (d.access_type || '').toUpperCase() !== 'ALL');

  const subgraphs = [];

  for (const dept of individualDepts) {
    const deptSteps = [];
    for (const step of steps) {
      // For ROLE-based steps, skip if the role lacks approve permission for this entity type
      if (step.approver_source_type === 'ROLE') {
        const hasApprovePermission = await db.oneOrNone(`
          SELECT 1 FROM tbl_role_permissions rp
          JOIN tbl_permissions p ON rp.permission_id = p.id
          WHERE rp.role_id = $1 AND p.resource = $2 AND p.action = 'approve'
        `, [step.approver_source_id, ENTITY_APPROVE_RESOURCE_MAP[policy.entity_type] || policy.entity_type.toLowerCase()]);
        if (!hasApprovePermission) continue;
      }

      const approvers = await resolveApprovers(
        step,
        hospitality_company_id || policy.hospitality_company_id,
        hotel_id || policy.hotel_id,
        dept.id,
        dept.access_type,
        db,
        null
      );

      // Get approver details with their department
      let approverDetails = [];
      if (approvers.length > 0) {
        approverDetails = await db.any(`
          SELECT u.id, u.name, u.email,
            (SELECT d.title FROM tbl_user_department ud
             JOIN tbl_department d ON d.id = ud.department_id
             WHERE ud.user_id = u.id ORDER BY ud.id DESC LIMIT 1
            ) AS department_name
          FROM tbl_users u WHERE u.id IN ($1:csv) AND u.status = 1
        `, [approvers]);
      }

      deptSteps.push({
        step_order: step.step_order,
        approver_source_type: step.approver_source_type,
        approver_source_name: step.approver_source_name,
        decision_rule: step.decision_rule,
        approvers: approverDetails,
        approver_count: approverDetails.length,
        will_skip: approverDetails.length === 0
      });
    }

    subgraphs.push({
      department: { id: dept.id, title: dept.title, access_type: dept.access_type },
      steps: deptSteps,
      active_steps: deptSteps.filter(s => !s.will_skip).length,
      will_auto_approve: deptSteps.every(s => s.will_skip)
    });
  }

  return {
    master_policy: { ...policy, steps },
    department_subgraphs: subgraphs,
    all_access_departments: allAccessDepts.map(d => ({ id: d.id, title: d.title }))
  };
}

/**
 * Get detailed approval instance information
 * Includes policy info, all steps, approvers, and action history
 */
export async function getApprovalInstanceDetails(instance_id, user_id = null) {
  const instance = await db.oneOrNone(`
    SELECT
      i.*,
      p.entity_type as policy_entity_type,
      p.hospitality_company_id as policy_company_id,
      p.hotel_id as policy_hotel_id,
      p.department_id as policy_department_id,
      hc.name as company_name,
      hh.name as hotel_name,
      d.title as department_name,
      initiator.name as initiated_by_name,
      initiator.email as initiated_by_email,
      initiator.designation as initiated_by_designation
    FROM tbl_approval_instances i
    JOIN tbl_approval_policies p ON i.approval_policy_id = p.id
    LEFT JOIN tbl_hospitality_companies hc ON i.hospitality_company_id = hc.id
    LEFT JOIN tbl_hospitality_company_hotels hh ON i.hotel_id = hh.id
    LEFT JOIN tbl_department d ON i.department_id = d.id
    LEFT JOIN tbl_users initiator ON i.initiated_by = initiator.id
    WHERE i.id = $1
  `, [instance_id]);

  if (!instance) throw new Error('Approval instance not found');

  // Get all steps with approvers
  const steps = await db.any(`
    SELECT s.*, ps.approval_type, ps.approver_source_type, ps.approver_source_id
    FROM tbl_approval_instance_steps s
    LEFT JOIN tbl_approval_policy_steps ps ON s.policy_step_id = ps.id
    WHERE s.approval_instance_id = $1
    ORDER BY s.step_order ASC
  `, [instance_id]);

  let canUserApprove = false;
  let userCurrentStep = null;

  for (const step of steps) {
    // Get approvers for this step
    const approvers = await db.any(`
      SELECT
        sa.*,
        u.name as user_name,
        u.email as user_email,
        u.designation as user_designation,
        (
          SELECT d.title
          FROM tbl_user_department ud
          JOIN tbl_department d ON d.id = ud.department_id
          WHERE ud.user_id = u.id
          ORDER BY ud.id DESC
          LIMIT 1
        ) AS user_department
      FROM tbl_approval_step_approvers sa
      JOIN tbl_users u ON sa.approver_user_id = u.id
      WHERE sa.approval_instance_step_id = $1
    `, [step.id]);

    step.approvers = approvers.map(ap => ({
      user_id: ap.approver_user_id,
      user_name: ap.user_name,
      user_email: ap.user_email,
      user_designation: ap.user_designation,
      user_department: ap.user_department,
      employee_code: ap.employee_code,
      status: ap.status,
      acted_at: ap.acted_at,
      comment: ap.comment
    }));

    // Check if current user can approve at this step
    if (user_id && step.step_order === instance.current_step && instance.status === 'PENDING') {
      const userApprover = approvers.find(ap => ap.approver_user_id === user_id && ap.status === 'PENDING');
      if (userApprover) {
        canUserApprove = true;
        userCurrentStep = step.id;
      }
    }
  }

  // Get action history
  const actionHistory = await db.any(`
    SELECT
      a.id, a.approval_instance_id, a.approval_instance_step_id,
      a.approver_user_id, a.action, a.comment,
      a.created_at AT TIME ZONE 'UTC' AS created_at,
      u.name as actor_name,
      u.email as actor_email
    FROM tbl_approval_actions a
    JOIN tbl_users u ON a.approver_user_id = u.id
    WHERE a.approval_instance_id = $1
    ORDER BY a.created_at ASC
  `, [instance_id]);

  return {
    id: instance.id,
    entity_type: instance.entity_type,
    entity_id: instance.entity_id,
    status: instance.status,
    current_step: instance.current_step,
    total_steps: steps.length,
    initiated_by: {
      user_id: instance.initiated_by,
      name: instance.initiated_by_name,
      email: instance.initiated_by_email,
      designation: instance.initiated_by_designation,
      department: instance.department_name
    },
    policy: {
      id: instance.approval_policy_id,
      hospitality_company_id: instance.policy_company_id,
      hotel_id: instance.policy_hotel_id,
      department_id: instance.policy_department_id
    },
    scope: {
      hospitality_company_id: instance.hospitality_company_id,
      company_name: instance.company_name,
      hotel_id: instance.hotel_id,
      hotel_name: instance.hotel_name,
      department_id: instance.department_id,
      department_name: instance.department_name
    },
    metadata: instance.metadata,
    created_at: instance.created_at,
    completed_at: instance.completed_at,
    can_user_approve: canUserApprove,
    user_approval_step_id: userCurrentStep,
    steps: steps.map(step => ({
      id: step.id,
      step_order: step.step_order,
      decision_rule: step.decision_rule,
      status: step.status,
      approval_type: step.approval_type,
      completed_at: step.completed_at,
      approvers: step.approvers
    })),
    action_history: actionHistory.map(a => ({
      action: a.action,
      actor: { user_id: a.approver_user_id, name: a.actor_name, email: a.actor_email },
      comment: a.comment,
      created_at: a.created_at
    }))
  };
}

/**
 * Get approval instances for an entity
 */
export async function getApprovalInstancesByEntity(entity_type, entity_id, txContext = null) {
  const t = txContext || db;
  return t.any(`
    SELECT
      i.*,
      p.entity_type as policy_entity_type,
      hc.name as company_name,
      hh.name as hotel_name,
      initiator.name as initiated_by_name
    FROM tbl_approval_instances i
    JOIN tbl_approval_policies p ON i.approval_policy_id = p.id
    LEFT JOIN tbl_hospitality_companies hc ON i.hospitality_company_id = hc.id
    LEFT JOIN tbl_hospitality_company_hotels hh ON i.hotel_id = hh.id
    LEFT JOIN tbl_users initiator ON i.initiated_by = initiator.id
    WHERE i.entity_type = $1 AND i.entity_id = $2
    ORDER BY i.created_at DESC
  `, [entity_type, entity_id]);
}

/**
 * Get all unique users involved in an approval workflow (approvers from all steps + initiator)
 * Useful for sending informational notifications to everyone in the approval hierarchy
 */
export async function getApprovalWorkflowUsers(entity_type, entity_id, txContext = null) {
  const dbContext = txContext || db;
  return dbContext.any(`
    SELECT DISTINCT u.id AS user_id, u.name, u.email
    FROM tbl_approval_instances ai
    JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
    JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id
    JOIN tbl_users u ON asa.approver_user_id = u.id
    WHERE ai.entity_type = $1 AND ai.entity_id = $2
      AND u.email IS NOT NULL AND u.email LIKE '%@%'
    UNION
    SELECT u.id AS user_id, u.name, u.email
    FROM tbl_approval_instances ai
    JOIN tbl_users u ON ai.initiated_by = u.id
    WHERE ai.entity_type = $1 AND ai.entity_id = $2
      AND u.email IS NOT NULL AND u.email LIKE '%@%'
  `, [entity_type, entity_id]);
}

// ============= APPROVAL ACTIONS =============

/**
 * Submit an approval action (APPROVE or REJECT)
 * Validates user permission and handles step progression
 */
export async function submitApprovalAction({
  approval_instance_id,
  approval_instance_step_id,
  approver_user_id,
  action,
  comment = null
}) {
  if (!approval_instance_id || !approver_user_id || !action) {
    throw new Error('approval_instance_id, approver_user_id, and action are required');
  }

  if (!['APPROVE', 'REJECT'].includes(action.toUpperCase())) {
    throw new Error('Action must be APPROVE or REJECT');
  }

  const normalizedAction = action.toUpperCase();

  const result = await db.tx(async t => {
    // 1. Get instance with FOR UPDATE lock to prevent race conditions
    const instance = await t.oneOrNone(`
      SELECT * FROM tbl_approval_instances
      WHERE id = $1
      FOR UPDATE
    `, [approval_instance_id]);

    if (!instance) throw new Error('Approval instance not found');
    if (instance.status !== 'PENDING') {
      return {
        status: instance.status,
        instance_status: instance.status,
        message: `Instance already ${instance.status.toLowerCase()}, no action taken`,
        already_completed: true
      };
    }

    // 2. Get the current step
    const currentStep = await t.oneOrNone(`
      SELECT * FROM tbl_approval_instance_steps
      WHERE approval_instance_id = $1 AND step_order = $2
      FOR UPDATE
    `, [approval_instance_id, instance.current_step]);

    if (!currentStep) throw new Error('Current approval step not found');

    // If step_id was provided, validate it matches the current step
    if (approval_instance_step_id && approval_instance_step_id !== currentStep.id) {
      throw new Error('Provided step is not the current pending step');
    }

    const stepId = approval_instance_step_id || currentStep.id;

    // 3. Validate user is an approver for this step and is PENDING
    const approverRecord = await t.oneOrNone(`
      SELECT * FROM tbl_approval_step_approvers
      WHERE approval_instance_step_id = $1 AND approver_user_id = $2
      FOR UPDATE
    `, [stepId, approver_user_id]);

    if (!approverRecord) {
      throw new Error('User is not an approver for this step');
    }
    if (approverRecord.status !== 'PENDING') {
      throw new Error(`User has already acted on this step with status: ${approverRecord.status}`);
    }

    // 4. Validate user belongs to the policy scope
    // Check hospitality access; skip department check for commercial entity types
    const hasHospAccess = await userHasHospitalityAccess(approver_user_id, instance.hospitality_company_id, instance.hotel_id, t);
    if (!hasHospAccess) {
      throw new Error('User does not belong to the approval policy scope');
    }
    const policy = await t.oneOrNone(
      'SELECT is_department_scoped FROM tbl_approval_policies WHERE id = $1',
      [instance.approval_policy_id]
    );
    const isDeptScopedEntity = policy?.is_department_scoped === true;
    if (isDeptScopedEntity && instance.department_id) {
      const deptRow = await t.oneOrNone('SELECT access_type FROM tbl_department WHERE id = $1', [instance.department_id]);
      const deptAccessType = deptRow?.access_type || 'INDIVIDUAL';
      if (deptAccessType === 'INDIVIDUAL') {
        // For INDIVIDUAL: user must belong to the target dept OR any ALL-access dept
        const belongsToDeptOrAll = await userBelongsToDepartmentOrAllAccess(approver_user_id, instance.department_id, t);
        if (!belongsToDeptOrAll) {
          throw new Error('User does not belong to the approval policy scope');
        }
      }
      // For ALL access_type: skip department check — approver was validly resolved at instance creation
    }
    // For commercial entity types (NEGOTIATION, NEGOTIATION_QUOTE, PO, ARC): skip dept check entirely

    // 5. Record the action in audit log
    await t.none(`
      INSERT INTO tbl_approval_actions
      (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
      VALUES ($1, $2, $3, $4, $5)
    `, [approval_instance_id, stepId, approver_user_id, normalizedAction, comment]);

    // 6. Update approver status
    await t.none(`
      UPDATE tbl_approval_step_approvers
      SET status = $1, acted_at = NOW(), comment = $2
      WHERE approval_instance_step_id = $3 AND approver_user_id = $4
    `, [normalizedAction === 'APPROVE' ? 'APPROVED' : 'REJECTED', comment, stepId, approver_user_id]);

    // 7. Handle REJECT - immediately reject the entire instance
    if (normalizedAction === 'REJECT') {
      await t.none(`
        UPDATE tbl_approval_instance_steps
        SET status = 'REJECTED', completed_at = NOW()
        WHERE id = $1
      `, [stepId]);

      await t.none(`
        UPDATE tbl_approval_instances
        SET status = 'REJECTED', completed_at = NOW()
        WHERE id = $1
      `, [approval_instance_id]);

      // Record lifecycle event for rejection
      try {
        await recordLifecycleEvent({
          entity_type: instance.entity_type,
          entity_id: instance.entity_id,
          stage: 'APPROVED', // Stage before rejection
          action: 'REJECT',
          performed_by: approver_user_id,
          metadata: {
            approval_instance_id: approval_instance_id,
            step_order: currentStep.step_order
          },
          remarks: comment,
          txContext: t
        });
      } catch (lifecycleError) {
        // Log but don't fail the transaction
        console.error('Error recording lifecycle event:', lifecycleError);
      }

      return {
        status: 'REJECTED',
        instance_status: 'REJECTED',
        message: 'Approval request has been rejected'
      };
    }

    // 8. Handle APPROVE - check decision rule
    const allApprovers = await t.any(`
      SELECT status FROM tbl_approval_step_approvers
      WHERE approval_instance_step_id = $1
    `, [stepId]);

    const allApproved = allApprovers.every(a => a.status === 'APPROVED');
    const anyApproved = allApprovers.some(a => a.status === 'APPROVED');

    const stepComplete =
      (currentStep.decision_rule === 'ALL' && allApproved) ||
      (currentStep.decision_rule === 'ANY' && anyApproved);

    if (!stepComplete) {
      // Step not yet complete, waiting for more approvals
      return {
        status: 'APPROVED',
        instance_status: 'PENDING',
        step_status: 'PENDING',
        message: `Approval recorded. Waiting for ${currentStep.decision_rule === 'ALL' ? 'all' : 'other'} approvers.`
      };
    }

    // 9. Step is complete - mark it and check for next step
    await t.none(`
      UPDATE tbl_approval_instance_steps
      SET status = 'APPROVED', completed_at = NOW()
      WHERE id = $1
    `, [stepId]);

    // Get all steps to find next
    const allSteps = await t.any(`
      SELECT * FROM tbl_approval_instance_steps
      WHERE approval_instance_id = $1
      ORDER BY step_order ASC
    `, [approval_instance_id]);

    const nextStep = allSteps.find(s => s.step_order === currentStep.step_order + 1);

    if (nextStep) {
      // Move to next step
      await t.none(`
        UPDATE tbl_approval_instances
        SET current_step = $1
        WHERE id = $2
      `, [nextStep.step_order, approval_instance_id]);

      return {
        status: 'APPROVED',
        instance_status: 'PENDING',
        step_status: 'APPROVED',
        next_step: nextStep.step_order,
        next_step_id: nextStep.id,
        message: `Step ${currentStep.step_order} approved. Moving to step ${nextStep.step_order}.`
      };
    } else {
      // This was the last step - approve the entire instance
      await t.none(`
        UPDATE tbl_approval_instances
        SET status = 'APPROVED', completed_at = NOW()
        WHERE id = $1
      `, [approval_instance_id]);

      // Record lifecycle event for final approval
      try {
        await recordLifecycleEvent({
          entity_type: instance.entity_type,
          entity_id: instance.entity_id,
          stage: 'APPROVED',
          action: 'APPROVE',
          performed_by: approver_user_id,
          metadata: {
            approval_instance_id: approval_instance_id,
            step_order: currentStep.step_order
          },
          remarks: comment,
          txContext: t
        });
      } catch (lifecycleError) {
        // Log but don't fail the transaction
        console.error('Error recording lifecycle event:', lifecycleError);
      }

      return {
        status: 'APPROVED',
        instance_status: 'APPROVED',
        step_status: 'APPROVED',
        message: 'All steps completed. Approval request has been fully approved.'
      };
    }
  });

  // After transaction committed — send email for step progression
  if (result.instance_status === 'PENDING' && result.next_step_id) {
    try {
      const instance = await db.oneOrNone(
        'SELECT entity_type, entity_id, metadata, initiated_by FROM tbl_approval_instances WHERE id = $1',
        [approval_instance_id]
      );
      if (instance) {
        const approvers = await db.any(`
          SELECT sa.approver_user_id as user_id, u.name as user_name, u.email as user_email
          FROM tbl_approval_step_approvers sa
          JOIN tbl_users u ON sa.approver_user_id = u.id
          WHERE sa.approval_instance_step_id = $1 AND sa.status = 'PENDING'
        `, [result.next_step_id]);

        const initiator = await db.oneOrNone('SELECT name FROM tbl_users WHERE id = $1', [instance.initiated_by]);

        const totalSteps = await db.one(
          'SELECT COUNT(*) as count FROM tbl_approval_instance_steps WHERE approval_instance_id = $1',
          [approval_instance_id]
        );

        const metadata = typeof instance.metadata === 'string' ? JSON.parse(instance.metadata) : instance.metadata;

        sendApprovalStepNotification({
          entityType: instance.entity_type,
          entityId: instance.entity_id,
          entityIdentifier: metadata?.rfq_number || metadata?.po_number || `ID-${instance.entity_id}`,
          stepOrder: result.next_step,
          totalSteps: parseInt(totalSteps.count),
          initiatorName: initiator?.name || 'Unknown',
          approvers,
          extraContext: { rfq_id: metadata?.rfq_id || instance.entity_id }
        });
      }
    } catch (emailError) {
      console.error('Error sending next step approval notification:', emailError);
    }
  }

  return result;
}

/**
 * Cancel a pending approval instance
 */
export async function cancelApprovalInstance(instance_id, cancelled_by, reason = null) {
  return db.tx(async t => {
    const instance = await t.oneOrNone(`
      SELECT * FROM tbl_approval_instances
      WHERE id = $1
      FOR UPDATE
    `, [instance_id]);

    if (!instance) throw new Error('Approval instance not found');
    if (instance.status !== 'PENDING') {
      throw new Error(`Cannot cancel instance with status: ${instance.status}`);
    }

    // Update instance
    await t.none(`
      UPDATE tbl_approval_instances
      SET status = 'CANCELLED', completed_at = NOW()
      WHERE id = $1
    `, [instance_id]);

    // Update all pending steps
    await t.none(`
      UPDATE tbl_approval_instance_steps
      SET status = 'CANCELLED', completed_at = NOW()
      WHERE approval_instance_id = $1 AND status = 'PENDING'
    `, [instance_id]);

    // Log the cancellation as a REJECT action (database constraint only allows APPROVE/REJECT)
    // The actual cancellation reason is captured in the comment field
    await t.none(`
      INSERT INTO tbl_approval_actions
      (approval_instance_id, approver_user_id, action, comment)
      VALUES ($1, $2, 'REJECT', $3)
    `, [instance_id, cancelled_by, reason ? `[CANCELLED] ${reason}` : '[CANCELLED]']);

    return { status: 'CANCELLED', message: 'Approval instance cancelled' };
  });
}

/**
 * Get pending approvals for a user
 * Only returns instances where user has hospitality access
 */
export async function getPendingApprovalsForUser(user_id, { hospitality_company_id, hotel_id, entity_type } = {}) {
  const conditions = [
    'i.status = \'PENDING\'',
    'sa.approver_user_id = $1',
    'sa.status = \'PENDING\'',
    's.step_order = i.current_step'
  ];
  const params = [user_id];
  let paramIdx = 2;

  if (hospitality_company_id) {
    conditions.push(`i.hospitality_company_id = $${paramIdx++}`);
    params.push(hospitality_company_id);
  }
  if (hotel_id) {
    conditions.push(`(i.hotel_id IS NULL OR i.hotel_id = $${paramIdx++})`);
    params.push(hotel_id);
  }
  if (entity_type) {
    conditions.push(`i.entity_type = $${paramIdx++}`);
    params.push(entity_type);
  }

  return db.any(`
    SELECT
      i.id as instance_id,
      i.entity_type,
      i.entity_id,
      i.current_step,
      i.created_at,
      i.metadata,
      s.id as step_id,
      s.decision_rule,
      p.hospitality_company_id,
      p.hotel_id as policy_hotel_id,
      hc.name as company_name,
      hh.name as hotel_name,
      initiator.name as initiated_by_name
    FROM tbl_approval_instances i
    JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
    JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
    JOIN tbl_approval_policies p ON i.approval_policy_id = p.id
    LEFT JOIN tbl_hospitality_companies hc ON i.hospitality_company_id = hc.id
    LEFT JOIN tbl_hospitality_company_hotels hh ON i.hotel_id = hh.id
    LEFT JOIN tbl_users initiator ON i.initiated_by = initiator.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY i.created_at ASC
  `, params);
}

/**
 * Given a user_id, entity types (module_keys), and rfq_ids,
 * returns the subset of rfq_ids where the user is a current pending approver.
 * All entity types store rfq_id in metadata->>'rfq_id'.
 */
export async function getRfqIdsWithPendingApprovals(user_id, entityTypes, rfqIds) {
  if (!user_id || !entityTypes || entityTypes.length === 0 || !rfqIds || rfqIds.length === 0) {
    return [];
  }

  const intRfqIds = rfqIds.map(id => parseInt(id));

  const rows = await db.any(`
    SELECT DISTINCT (i.metadata->>'rfq_id')::INTEGER AS rfq_id
    FROM tbl_approval_instances i
    JOIN tbl_approval_instance_steps s
      ON s.approval_instance_id = i.id
    JOIN tbl_approval_step_approvers sa
      ON sa.approval_instance_step_id = s.id
    WHERE i.status = 'PENDING'
      AND s.status = 'PENDING'
      AND sa.approver_user_id = $1
      AND sa.status = 'PENDING'
      AND s.step_order = i.current_step
      AND i.entity_type IN ($2:csv)
      AND i.metadata->>'rfq_id' IS NOT NULL
      AND (i.metadata->>'rfq_id')::INTEGER IN ($3:csv)
  `, [user_id, entityTypes, intRfqIds]);

  return rows.map(r => parseInt(r.rfq_id));
}

/**
 * Get counts of pending approvals grouped by entity_type for a user.
 * Lightweight query for navigation badge polling — no metadata/name JOINs.
 */
export async function getPendingApprovalCountsByEntityType(user_id, { hospitality_company_id, hotel_id } = {}) {
  const conditions = [
    'i.status = \'PENDING\'',
    'sa.approver_user_id = $1',
    'sa.status = \'PENDING\'',
    's.step_order = i.current_step',
    'i.created_at >= NOW() - INTERVAL \'7 days\''
  ];
  const params = [user_id];
  let paramIdx = 2;

  if (hospitality_company_id) {
    conditions.push(`i.hospitality_company_id = $${paramIdx++}`);
    params.push(hospitality_company_id);
  }
  if (hotel_id) {
    conditions.push(`(i.hotel_id IS NULL OR i.hotel_id = $${paramIdx++})`);
    params.push(hotel_id);
  }

  const query = `
    SELECT i.entity_type, COUNT(*)::INTEGER as count
    FROM tbl_approval_instances i
    JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
    JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
    WHERE ${conditions.join(' AND ')}
    GROUP BY i.entity_type
  `;

  return db.any(query, params);
}

// --- Hospitality Approval Engine: End ---

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

export const uploadToS3 = async (filePath, s3Key) => {
  try {
    console.log('='.repeat(60));
    console.log('[S3-UPLOAD] Starting upload process...');
    console.log('[S3-UPLOAD] File path:', filePath);
    console.log('[S3-UPLOAD] S3 key:', s3Key);

    // Check file exists
    if (!fs.existsSync(filePath)) {
      console.error('[S3-UPLOAD] ERROR: File not found:', filePath);
      throw new Error(`File not found: ${filePath}`);
    }

    const fileStats = fs.statSync(filePath);
    console.log('[S3-UPLOAD] File found, size:', fileStats.size, 'bytes');

    const fileBuffer = fs.readFileSync(filePath);
    console.log('[S3-UPLOAD] File read into buffer, length:', fileBuffer.length);

    // Use s3Key as-is if it contains a path, otherwise prepend purchase-order for backward compatibility
    const finalKey = s3Key.includes('/') ? s3Key : `purchase-order/${s3Key}`;

    const uploadParams = {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: finalKey,
      Body: fileBuffer,
      ContentType: "application/pdf",
    };

    console.log('[S3-UPLOAD] Upload params:');
    console.log('[S3-UPLOAD] - Bucket:', process.env.AWS_S3_BUCKET);
    console.log('[S3-UPLOAD] - Key:', finalKey);
    console.log('[S3-UPLOAD] - ContentType:', uploadParams.ContentType);

    const command = new PutObjectCommand(uploadParams);
    console.log('[S3-UPLOAD] Sending upload command...');

    const response = await s3Client.send(command);
    console.log('[S3-UPLOAD] Upload success!');
    console.log('[S3-UPLOAD] Response ETag:', response.ETag);

    const url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${finalKey}`;
    console.log('[S3-UPLOAD] Document URL:', url);
    console.log('='.repeat(60));

    return {
      ok: true,
      url: url,
      etag: response.ETag
    };
  } catch (err) {
    console.log('='.repeat(60));
    console.error('[S3-UPLOAD] Upload FAILED!');
    console.error('[S3-UPLOAD] Error name:', err.name);
    console.error('[S3-UPLOAD] Error message:', err.message);
    console.error('[S3-UPLOAD] Error code:', err.code);
    if (err.$metadata) {
      console.error('[S3-UPLOAD] Request ID:', err.$metadata.requestId);
      console.error('[S3-UPLOAD] HTTP Status:', err.$metadata.httpStatusCode);
    }
    console.error('[S3-UPLOAD] Full error:', err);
    console.log('='.repeat(60));
    return {
      ok: false,
      error: err.message
    };
  }
};

// ============= LIFECYCLE TRACKING =============

/**
 * Record a lifecycle event for any entity type (RFQ, TENDER, NEGOTIATION, PO, INDENT)
 * @param {string} entity_type - Type of entity ('RFQ', 'TENDER', 'NEGOTIATION', 'PO', 'INDENT')
 * @param {number} entity_id - ID of the entity
 * @param {string} stage - Stage in lifecycle (e.g., 'CREATED', 'SUBMITTED', 'APPROVED', 'PUBLISHED')
 * @param {string} action - Action performed (e.g., 'SUBMIT', 'APPROVE', 'REJECT', 'PUBLISH')
 * @param {number} performed_by - User ID who performed the action
 * @param {Object} metadata - Additional metadata (optional, defaults to {})
 * @param {string} remarks - Remarks/notes (optional)
 * @param {Object} txContext - Optional transaction context for atomicity
 * @returns {Promise<Object>} Created lifecycle history record
 */
export async function recordLifecycleEvent({
  entity_type,
  entity_id,
  stage,
  action,
  performed_by,
  metadata = {},
  remarks = null,
  txContext = null
}) {
  if (!entity_type || !entity_id || !stage || !action || !performed_by) {
    throw new Error('entity_type, entity_id, stage, action, and performed_by are required');
  }

  // Validate entity_type is in enum
  const validTypes = ['RFQ', 'TENDER', 'NEGOTIATION', 'PO', 'INDENT', 'TECHNICAL', 'ARC'];
  if (!validTypes.includes(entity_type)) {
    throw new Error(`Invalid entity_type. Must be one of: ${validTypes.join(', ')}`);
  }

  const dbContext = txContext || db;

  return dbContext.one(
    `INSERT INTO tbl_lifecycle_history
      (entity_id, entity_type, stage, action, performed_by, metadata, remarks)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [entity_id, entity_type, stage, action, performed_by, JSON.stringify(metadata), remarks]
  );
}

/**
 * Get lifecycle history for an entity
 * @param {string} entity_type - Type of entity
 * @param {number} entity_id - ID of the entity
 * @param {Object} txContext - Optional transaction context
 * @returns {Promise<Array>} Array of lifecycle history records
 */
export async function getLifecycleHistory(entity_type, entity_id, txContext = null) {
  const dbContext = txContext || db;

  return dbContext.any(
    `SELECT 
      lh.*,
      u.name as performed_by_name,
      u.email as performed_by_email
     FROM tbl_lifecycle_history lh
     LEFT JOIN tbl_users u ON u.id = lh.performed_by
     WHERE lh.entity_type = $1 AND lh.entity_id = $2
     ORDER BY lh.created_at ASC`,
    [entity_type, entity_id]
  );
}

/**
 * Get approval instance by ID
 * @param {number} instance_id - Approval instance ID
 * @param {string} entity_type - Optional entity type filter
 * @param {Object} txContext - Optional transaction context
 * @returns {Promise<Object>} Approval instance record
 */
export async function getApprovalInstanceById(instance_id, entity_type = null, txContext = null) {
  const dbContext = txContext || db;
  
  let query = `
    SELECT id, entity_type, entity_id, metadata, status, approval_policy_id, 
           hospitality_company_id, hotel_id, initiated_by, created_at, completed_at
    FROM tbl_approval_instances
    WHERE id = $1
  `;
  const params = [instance_id];
  
  if (entity_type) {
    query += ` AND entity_type = $2`;
    params.push(entity_type);
  }
  
  return dbContext.oneOrNone(query, params);
}

/**
 * Reset state when ARC is sent back to a previous stage
 *
 * Stage-based behavior:
 * - QUOTES_RECEIVED, TECHNICAL, PUBLISHED, etc. (early stages):
 *   Cancel ALL rounds + finalization + approvals - complete reset
 *
 * - NEGOTIATION, QUOTE_FINALIZED, etc. (mid stages):
 *   Keep rounds intact, just cancel finalization + approvals so user can create new round
 *
 * @param {number} rfq_id - RFQ ID
 * @param {number} rfq_product_id - RFQ Product ID
 * @param {number} user_id - User performing the reset
 * @param {string} reason - Reason for reset
 * @param {string} target_stage - Target stage being sent back to
 * @param {Object} txContext - Optional transaction context
 */
export async function resetQuoteFinalizationForSendback(rfq_id, rfq_product_id, user_id, reason = null, target_stage = null, txContext = null) {
  const dbContext = txContext || db;

  const normalizedStage = (target_stage || '').toUpperCase();

  // Early stages = complete reset (cancel all rounds)
  const earlyStages = ['QUOTES_RECEIVED', 'TECHNICAL_EVALUATION', 'TECHNICAL', 'PUBLISHED', 'TENDER_SUBMITTED'];
  const isEarlyStage = earlyStages.includes(normalizedStage);

  // Mid stages = keep rounds, just reset finalization (allow new round creation)
  // NEGOTIATION, QUOTE_FINALIZED, NEGOTIATION_QUOTE, etc.

  return dbContext.tx(async t => {
    let cancelledInstances = 0;
    let removedFinalizations = 0;
    let cancelledRounds = 0;

    // 1. Always cancel NEGOTIATION_QUOTE approval instances (pending or approved)
    const quoteInstances = await t.any(`
      SELECT id, status FROM tbl_approval_instances
      WHERE entity_type = 'NEGOTIATION_QUOTE'
        AND entity_id = $1
        AND status IN ('PENDING', 'APPROVED')
    `, [rfq_product_id]);

    for (const instance of quoteInstances) {
      if (instance.status === 'PENDING') {
        await cancelApprovalInstance(instance.id, user_id, reason || 'Reset due to ARC sendback');
      } else {
        // For APPROVED, just mark as CANCELLED directly
        await t.none(`
          UPDATE tbl_approval_instances
          SET status = 'CANCELLED', completed_at = NOW()
          WHERE id = $1
        `, [instance.id]);
      }
      cancelledInstances++;
    }

    // 2. Always remove quote finalization entries
    // rfq_product_id is tbl_rfq_products.id, but tbl_quote_finalization stores the actual product_variant_id
    const rfqProduct = await t.oneOrNone(`
      SELECT product_variant_id, variant FROM tbl_rfq_products WHERE id = $1
    `, [rfq_product_id]);

    const finalizations = rfqProduct ? await t.any(`
      SELECT * FROM tbl_quote_finalization
      WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3
    `, [rfq_id, rfqProduct.product_variant_id, rfqProduct.variant]) : [];

    for (const f of finalizations) {
      await t.none(`
        INSERT INTO tbl_quote_finalization_history
        (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, timestamp, variant, changed_by, changed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      `, [f.rfq_id, f.rfq_no, f.quote_id, f.product_variant_id, f.vendor_id, f.created_by, f.timestamp, f.variant, user_id]);

      await t.none(`DELETE FROM tbl_quote_finalization WHERE id = $1`, [f.id]);
      removedFinalizations++;
    }

    // 3. Cancel NEGOTIATION approval instances
    const negInstances = await t.any(`
      SELECT id, status FROM tbl_approval_instances
      WHERE entity_type = 'NEGOTIATION'
        AND entity_id = $1
        AND status IN ('PENDING', 'APPROVED')
    `, [rfq_product_id]);

    for (const instance of negInstances) {
      if (instance.status === 'PENDING') {
        await cancelApprovalInstance(instance.id, user_id, reason || 'Reset due to ARC sendback');
      } else {
        await t.none(`
          UPDATE tbl_approval_instances
          SET status = 'CANCELLED', completed_at = NOW()
          WHERE id = $1
        `, [instance.id]);
      }
      cancelledInstances++;
    }

    // 4. Handle rounds based on target stage
    if (isEarlyStage) {
      // Early stage: Cancel ALL rounds (complete reset to before negotiation)
      const result = await t.result(`
        UPDATE tbl_negotiation_rounds
        SET status = 'CANCELLED', closed_at = NOW()
        WHERE rfq_id = $1 AND rfq_product_id = $2 AND status != 'CANCELLED'
      `, [rfq_id, rfq_product_id]);
      cancelledRounds = result.rowCount;
    } else {
      // Mid stage (NEGOTIATION, QUOTE_FINALIZED, etc.): Keep rounds intact
      // Just make sure any ACTIVE rounds are marked as COMPLETED so new ones can be created
      const result = await t.result(`
        UPDATE tbl_negotiation_rounds
        SET status = 'COMPLETED', closed_at = COALESCE(closed_at, NOW())
        WHERE rfq_id = $1 AND rfq_product_id = $2 AND status = 'ACTIVE'
      `, [rfq_id, rfq_product_id]);
      // Don't count these as "cancelled" - they're completed
    }

    // 5. Reset Tech Evaluation when sending back to TECH_EVAL/TECHNICAL stages
    // IMPORTANT: Don't delete data - just reset is_verified=false to allow re-evaluation
    // This preserves history while allowing another chance
    let resetTechEval = 0;
    if (normalizedStage === 'TECHNICAL' || normalizedStage === 'TECH_EVAL' || normalizedStage === 'TECHNICAL_EVALUATION') {
      // Get tech evaluation for this product
      const techEval = await t.oneOrNone(`
        SELECT te.id
        FROM tbl_rfq_product_tech_evaluation te
        JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
        WHERE te.rfq_id = $1 AND rp.id = $2
      `, [rfq_id, rfq_product_id]);

      if (techEval) {
        // Reset is_verified=false to allow re-evaluation (preserve the old status for history)
        const resetVendors = await t.result(`
          UPDATE tbl_rfq_product_tech_evaluation_cleared_vendors
          SET is_verified = false
          WHERE tbl_rfq_product_tech_evaluation_id = $1
        `, [techEval.id]);
        resetTechEval = resetVendors.rowCount;

        // Reset tech eval rounds so evaluator can resubmit
        // Also collect round IDs to cancel their TECHNICAL approval instances
        const activeRounds = await t.any(`
          SELECT id, status FROM tbl_tech_evaluation_rounds
          WHERE tbl_rfq_product_tech_evaluation_id = $1 AND status IN ('PENDING', 'SUBMITTED')
        `, [techEval.id]);

        for (const round of activeRounds) {
          await t.none(`
            UPDATE tbl_tech_evaluation_rounds SET status = 'CANCELLED', completed_at = NOW()
            WHERE id = $1
          `, [round.id]);

          // Cancel TECHNICAL approval instances (entity_id = round.id for TECHNICAL type)
          const techInstances = await t.any(`
            SELECT id, status FROM tbl_approval_instances
            WHERE entity_type = 'TECHNICAL'
              AND entity_id = $1
              AND status IN ('PENDING', 'APPROVED')
          `, [round.id]);

          for (const instance of techInstances) {
            if (instance.status === 'PENDING') {
              await cancelApprovalInstance(instance.id, user_id, reason || 'Reset due to ARC sendback to TECH_EVAL');
            } else {
              await t.none(`
                UPDATE tbl_approval_instances
                SET status = 'CANCELLED', completed_at = NOW()
                WHERE id = $1
              `, [instance.id]);
            }
            cancelledInstances++;
          }
        }
      }
    }

    // 6. Reset RFQ/Tender status for very early stages
    let rfqStatusReset = null;
    if (normalizedStage === 'TENDER_SUBMITTED' || normalizedStage === 'SUBMITTED') {
      // Send back to submitted = before approval, reset to PENDING_APPROVAL (3)
      await t.none(`
        UPDATE tbl_rfq SET status = 3, is_published = 0 WHERE id = $1
      `, [rfq_id]);

      // Cancel any RFQ/TENDER approval instances
      const rfqApprovalInstances = await t.any(`
        SELECT id, status FROM tbl_approval_instances
        WHERE entity_type IN ('RFQ', 'TENDER')
          AND entity_id = $1
          AND status IN ('PENDING', 'APPROVED')
      `, [rfq_id]);

      for (const instance of rfqApprovalInstances) {
        if (instance.status === 'PENDING') {
          await cancelApprovalInstance(instance.id, user_id, reason || 'Reset due to ARC sendback to SUBMITTED');
        } else {
          await t.none(`
            UPDATE tbl_approval_instances
            SET status = 'CANCELLED', completed_at = NOW()
            WHERE id = $1
          `, [instance.id]);
        }
        cancelledInstances++;
      }
      rfqStatusReset = 'PENDING_APPROVAL';
    } else if (normalizedStage === 'PUBLISHED') {
      // Send back to published = re-open the tender for bidding
      await t.none(`
        UPDATE tbl_rfq SET status = 1, is_published = 1 WHERE id = $1
      `, [rfq_id]);
      rfqStatusReset = 'OPEN';
    }

    return {
      cancelled_instances: cancelledInstances,
      removed_finalizations: removedFinalizations,
      cancelled_rounds: cancelledRounds,
      reset_tech_eval: resetTechEval,
      target_stage: normalizedStage,
      is_early_stage: isEarlyStage,
      rfq_status_reset: rfqStatusReset
    };
  });
}

export default generalModel;
