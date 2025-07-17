import db from '../config/dbConn.js';

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
  doesHierarchyExist: async (type, companyId) => {
    try {
      const raw = await db.any(`
        SELECT id
        FROM tbl_approval_hierarchy
        WHERE company_id = $1
        AND hierarchy_type = $2
        ORDER BY hierarchy_type, approval_level ASC
      `, [companyId, type]);

      return raw && raw.length > 0;
    } catch (error) {
      throw error;
    }
  },
  getHierarchies: async (type, companyId) => {
    try {
      const raw = await db.any(`
        SELECT
          hierarchy_type,
          company_id,
          user_id,
          approval_level,
          bypass_cap,
          is_active,
          created_at
        FROM tbl_approval_hierarchy
        WHERE company_id = $1
        ${type ? ' AND hierarchy_type = $2' : ''}
        ORDER BY hierarchy_type, approval_level ASC
      `, [companyId, type]);

      const grouped = raw.reduce((acc, row) => {
        const { hierarchy_type, company_id, ...rest } = row;

        if (!acc[hierarchy_type]) {
          acc[hierarchy_type] = {
            hierarchy_type,
            company_id,
            approvers: [],
          };
        }

        // Only include if active
        if (rest.is_active) {
          acc[hierarchy_type].approvers.push(rest);
        }

        return acc;
      }, {});

      return Object.values(grouped);
    } catch (error) {
      throw error;
    }
  },
  createHierarchy: async (type, approvers, companyId) => {
    try {
      let baseData = {
        hierarchy_type: type,
        company_id: companyId,
        created_at: new Date(),
      };
      const insertableData = approvers.map(approver => ({...baseData, ...approver}));

      await generalModel.insertMany('tbl_approval_hierarchy', insertableData);
      return true;
    } catch (error) {
      throw error;
    }
  },
  updateHierarchy: async (type, approvers, removableApprovers = [], companyId) => {
    try {
      const updatePromises = approvers.map(async (approver) => {
        const exists = await db.oneOrNone(
          `SELECT id FROM tbl_approval_hierarchy
          WHERE company_id = $1 AND user_id = $2 AND hierarchy_type = $3`,
          [companyId, approver.user_id, type]
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
  }
};

export default generalModel;
