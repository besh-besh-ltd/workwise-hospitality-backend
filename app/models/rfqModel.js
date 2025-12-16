import db, { pgp } from '../config/dbConn.js';
import Config from '../config/app.config.js';
import generalModel from './generalModel.js';
import userModel from './userModel.js';
import cmsModel from './cmsModel.js';
import { logError, PERSISTENCE_STATUSES } from '../helper/common.js';
import { notifyBuyerOnPersistenceViaEmail } from '../controllers/rfq/rfqController.js';
import { PO_STATUSES } from '../util/constants.js';


const generateReminderTokenValue = () => {
  const timestamp = Date.now().toString();
  const randomSegment = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
  return parseInt((timestamp + randomSegment).slice(0, 16), 10);
};

const rfqModel = {
  insert: async (table_name, data, db_con = db) => {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const d_keys = keys.join(', ');
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    const query = `INSERT INTO ${table_name} (${d_keys})
      VALUES (${placeholders})
      RETURNING *;`;

    return new Promise(function (resolve, reject) {
      db_con
        .query(query, values)
        .then(function (result) {
          resolve(result);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  insertIntoQuoteActivity: async (data, db_con = db) => {
    // We expect: data = { rfq_id, current_status, created_by }
    const { rfq_id, current_status, created_by } = data;

    const query = `
   INSERT INTO tbl_quote_activity (rfq_id, current_status, prev_status, created_by)
SELECT
  $1::int,
  $2,
  last_status.current_status,
  $3
FROM (
  SELECT current_status
  FROM tbl_quote_activity
  WHERE rfq_id = $1::int
  ORDER BY created_at DESC
  LIMIT 1
) AS last_status
WHERE last_status.current_status IS DISTINCT FROM $2
UNION ALL
SELECT $1::int, $2, NULL, $3
WHERE NOT EXISTS (
  SELECT 1
  FROM tbl_quote_activity
  WHERE rfq_id = $1::int
);

  `;

    const values = [rfq_id, current_status, created_by];

    return new Promise((resolve, reject) => {
      db_con
        .query(query, values)
        .then((result) => resolve(result))
        .catch((err) => reject(new Error(err)));
    });
  },

  getProductsByRfqId: async (rfqId, db_con = db) => {
    try {
      if (!rfqId) throw new Error('RFQ ID is required!');
      let q = `
        SELECT pv.name,
              (SELECT JSON_AGG(JSON_BUILD_OBJECT(
                      'title', rps.title,
                      'value', rps.value
                                ))
                FROM tbl_rfq_products_specs rps
                WHERE rps.rfq_id = rfq.id
                  AND rps.product_variant_id = rp.product_variant_id
                  AND rps.variant = rp.variant) AS spec,
              (SELECT JSON_AGG(JSON_BUILD_OBJECT(
                      'user_id', u.id,
                      'name', u.name,
                      'email', u.email,
                      'mobile', u.mobile,
                      'organization_name', COALESCE(c.company_name, u.organization_name, u.name, u.email, u.mobile)
                                ))
                FROM tbl_rfq_product_vendors rpv
                        JOIN tbl_users u ON rpv.user_id = u.id
                        JOIN tbl_company c ON u.company_id = c.id
                WHERE rpv.rfq_id = rfq.id
                  AND rpv.product_variant_id = rp.product_variant_id
                  AND rpv.variant = rp.variant) AS vendors

        FROM tbl_rfq rfq
                JOIN tbl_rfq_products rp ON rp.rfq_id = rfq.id
                JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id

        WHERE rfq.id = $1;
      `;

      return await db_con.any(q, [rfqId]);
    } catch (error) {
      throw error;
    }
  },

  getVariantsCountForRFQ: async (rfqId) => {
    if (!rfqId) return [];

    try {
      let q = `
      SELECT product_variant_id, MAX(variant) AS max_variant
        FROM tbl_rfq_products
        WHERE rfq_id = $1
        GROUP BY product_variant_id;
      `;

      const res = await db.any(q, [rfqId]);
      console.log('[getVariantsCountForRFQ] res => ', res);

      return res;
    } catch (error) {
      throw error;
    }
  },

  checkRFQCompletion: async (rfq_id, selectedSheets) => {
    try {
      let totalQ = `
      SELECT DISTINCT product_variant_id, variant
      FROM tbl_rfq_products rp
          WHERE rp.rfq_id = $1
          ${(selectedSheets && Array.isArray(selectedSheets) && selectedSheets.length > 0) ? `AND rp.sheet_id IN (${selectedSheets.join(",")})` : ''};
      `;

      let qualifiedQ = `
        SELECT s.product_variant_id, s.variant
          FROM tbl_rfq_products_specs s
          WHERE s.rfq_id = $1
            ${(selectedSheets && Array.isArray(selectedSheets) && selectedSheets.length > 0) ? `AND s.sheet_id IN (${selectedSheets.join(",")})` : ''}
            AND s.title IN ('Quantity', 'Unit')
            AND TRIM(s.value) != ''
            AND TRIM(s.value) != 'NA'
            AND (
              (s.title = 'Quantity' AND
              TRIM(s.value) ~ '^[0-9]+(\.[0-9]+)?$' AND  -- Regex to check it's all digits
              CAST(TRIM(s.value) AS FLOAT) > 0)
                  OR
              (s.title = 'Unit' AND LENGTH(TRIM(s.value)) >= 2)
              )
          GROUP BY s.product_variant_id, s.variant
          HAVING COUNT(DISTINCT s.title) = 2;
      `;

      const totalRes = await db.any(totalQ, [rfq_id]);
      const qualifiedRes = await db.any(qualifiedQ, [rfq_id]);

      return (totalRes ?? []).length === (qualifiedRes ?? []).length;
    } catch (error) {
      throw error;
    }
  },

  getSheetsForDraftRfq: async (rfq_id, is_processed, sheet_id) => {
    try {
      const condition = `rfq_id = ${rfq_id} ${
        is_processed && is_processed == 'true' ? 'AND is_processed' : ''
      } ${
        sheet_id && !isNaN(parseInt(sheet_id)) ? ` AND id = ${sheet_id}` : ``
      } ORDER BY id`;
      return await rfqModel.checkIfExists('tbl_rfq_draft_sheets', condition);
    } catch (error) {
      throw error;
    }
  },

  getDraftRfqSheetWise: async (rfq_id, sheet_id) => {
    try {
      let q = `
        SELECT 
          rfq.response_email,
          rfq.contact_name,
          rfq.contact_number,
          rfq.company_name,

          jsonb_agg(
            jsonb_build_object(
              'product_id', pv.id,
              'name', COALESCE(pv.name, 'Unnamed Product'),
              'variant', rp.variant,
              'spec', (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'title', s.title,
                    'value', s.value
                  )
                )
                FROM tbl_rfq_products_specs s
                WHERE s.product_variant_id = rp.product_variant_id
                  AND s.variant = rp.variant
                  AND s.rfq_id = rfq.id
              ),
              'vendors', (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', tu.id,
                    'vendor_name', tu.name,
                    'email', tu.email,
                    'mobile', tu.mobile,
                    'company_name', COALESCE(tc.company_name, tu.organization_name),
                    'address', tlc.address,
                    'is_private', tc.is_private,
                    'turnover', tc.turnover,
                    'nature_of_business', tc.nature_of_business,
                    'city_name', lc.city_name,
                    'state_name', ls.state_name,
                    'country_name', lcn.country_name
                  )
                )
                FROM tbl_rfq_product_vendors rpv
                JOIN tbl_users tu ON tu.id = rpv.user_id
                LEFT JOIN tbl_company tc ON tc.user_id = tu.id
                LEFT JOIN tbl_company_location tlc ON tlc.company_id = tu.company_id
                LEFT JOIN tbl_location_cities lc ON lc.id = tlc.city_id
                LEFT JOIN tbl_location_states ls ON ls.id = tlc.state_id
                LEFT JOIN tbl_location_country lcn ON lcn.id = tlc.country_id
                WHERE rpv.product_variant_id = rp.product_variant_id
                  AND rpv.variant = rp.variant
                  AND rpv.rfq_id = rfq.id
              ),
              'comment', COALESCE(rp.comment, ''),
              'defaultSelectedVAB', '',
              'TDS_flies', (
                SELECT json_agg(RPF.file_url)
                FROM tbl_rfq_product_files RPF
                WHERE RPF.rfq_product_id = rp.id AND RPF.file_type = 'TDS'
              ),
              'QAP_files', (
                SELECT json_agg(RPF.file_url)
                FROM tbl_rfq_product_files RPF
                WHERE RPF.rfq_product_id = rp.id AND RPF.file_type = 'QAP'
              ),
              'SPEC_files', (
                SELECT json_agg(RPF.file_url)
                FROM tbl_rfq_product_files RPF
                WHERE RPF.rfq_product_id = rp.id AND RPF.file_type = 'SPEC'
              ),
              'datasheet_file', (
                SELECT json_agg(RPF.file_url)
                FROM tbl_rfq_product_files RPF
                WHERE RPF.rfq_product_id = rp.id AND RPF.file_type = 'TDS'
              ),
              'spec_file', (
                SELECT json_agg(RPF.file_url)
                FROM tbl_rfq_product_files RPF
                WHERE RPF.rfq_product_id = rp.id AND RPF.file_type = 'SPEC'
              ),
              'qap_file', (
                SELECT json_agg(RPF.file_url)
                FROM tbl_rfq_product_files RPF
                WHERE RPF.rfq_product_id = rp.id AND RPF.file_type = 'QAP'
              ),
              'sheet_name', COALESCE(rds.sheet_name, '')
            )
          ) AS products

        FROM tbl_rfq rfq
        JOIN tbl_rfq_draft_sheets rds ON rds.rfq_id = rfq.id
        JOIN tbl_rfq_products rp ON rp.rfq_id = rfq.id AND rp.sheet_id = rds.id
        JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id

        WHERE rfq.id = $1 AND rds.id = $2 AND rds.is_processed

        GROUP BY rfq.response_email, rfq.contact_name, rfq.contact_number, rfq.company_name;
      `;

      try {
        const result = await db.many(q, [rfq_id, sheet_id]);
        return result;
      } catch (error) {
        // If no data found, db.many throws an error, but we want to return an empty array
        if (error.code === 0) {
          return [];
        }
        throw error;
      }
    } catch (error) {
      throw error;
    }
  },

  persistAIJobInDB: async (
    user_id,
    file_name,
    raw_file_url,
    signature,
    type,
    db_con = db
  ) => {
    try {
      let persistenceData = {
        user_id,
        file_name,
        raw_file_url,
        signature,
        type
      };

      const res = await rfqModel.insert(
        'tbl_rfq_persistent_jobs',
        persistenceData,
        db_con
      );
      return res;
    } catch (error) {
      console.log(error);
      throw error;
    }
  },

  updatePersistenceJobStatus: async (
    persistenceId,
    status = PERSISTENCE_STATUSES.PROCESSING,
    persisted_rfq_id = null,
    errors = null,
    jsonUrl
  ) => {
    try {
      const persistenceQuery = `id = ${persistenceId}`;
      let persistence = await rfqModel.checkIfExists(
        'tbl_rfq_persistent_jobs',
        persistenceQuery
      );

      if (!persistence || persistence.length <= 0) {
        throw new Error('Persistence does not exist!');
      }

      persistence = persistence[0];

      let user = await userModel.getUserById(persistence.user_id);

      if (!user || user.length <= 0) {
        throw new Error('User does not exist for this persistence!');
      }

      user = user[0];

      let q = `
        UPDATE tbl_rfq_persistent_jobs
        SET status = $2, persisted_rfq_id = $3, errors = $4::jsonb, download_url = $5
        ${
          status == PERSISTENCE_STATUSES.COMPLETED ||
          status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED
            ? ', completed_at = NOW()'
            : ''
        }

        WHERE id = $1
      `;

      const formatttedError =
        errors &&
        (typeof errors == 'string' ||
          Array.isArray(errors) ||
          typeof errors == 'object')
          ? JSON.stringify(errors)
          : null;

      const updatedPersistence = await db.any(q, [
        persistenceId,
        status,
        persisted_rfq_id,
        formatttedError,
        jsonUrl
      ]);

      // Notify buyer about the persistence completion, Whatsapp integration pending!!
      notifyBuyerOnPersistenceViaEmail(
        user,
        persistence.status,
        status,
        persisted_rfq_id,
        errors,
        persistence,
        jsonUrl
      );

      return updatedPersistence;
    } catch (error) {
      throw error;
    }
  },

  saveMagicSearchInDraft: async (
    data,
    nextRFQNumber,
    createdBy,
    processedUrl,
    rfqId,
    sheetId
  ) => {
    try {
      return await db.tx(async (t) => {
        let sheetToProcess = null;

        let q = `
         SELECT id, sheet_name FROM tbl_rfq_draft_sheets
        `;
        let sheetValues = [];

        if (sheetId && !isNaN(parseInt(sheetId))) {
          q += 'WHERE id = $1';
          sheetValues.push(sheetId);
        } else if (rfqId) {
          q += 'WHERE rfq_id = $1 AND NOT is_processed ORDER BY id';
          sheetValues.push(rfqId);
        } else {
          sheetToProcess = {
            sheet_name: data?.sheetNameList?.[0]
          };
        }

        if (sheetId || rfqId) {
          let sheetData = await t.one(q, sheetValues);
          if (sheetData && !sheetData.is_processed) {
            sheetToProcess = sheetData;
          } else {
            throw Error('RFQ Draft Sheet not found or is already processed!');
          }
        }

        // Insert into tbl_rfq
        let rfqQuery = ``;
        let rfqQueryValues = [];

        if (rfqId && !isNaN(parseInt(rfqId))) {
          rfqQuery = `SELECT id FROM tbl_rfq WHERE id = $1 AND is_published = 0`;
          rfqQueryValues.push(rfqId);
        } else {
          rfqQuery = `
            INSERT INTO tbl_rfq (
              rfq_no, 
              comment, 
              location,
              company_name, 
              response_email, 
              contact_name, 
              contact_number, 
              is_published, 
              status,
              reverse_auction,
              is_tender,
              created_by, 
              updated_by, 
              bid_end_date,
              timestamp,
              rfq_added_from,
              processed_url
            )
            VALUES (
              $1, 
              $2, 
              $3, 
              $4, 
              $5,
              $6,
              $7,
              $8,
              $9,
              $10,
              $11,
              $12,
              $13,
              $14,
              $15,
              $16,
              $17
            )
            RETURNING id
          `;

          const today = new Date();
          const nextMonth = new Date(today);
          nextMonth.setMonth(today.getMonth() + 1);

          const formattedDate = nextMonth.toISOString().split('T')[0];

          const rfqValues = [
            nextRFQNumber,
            '',
            '',
            data.company_name,
            data.response_email,
            data.contact_name,
            data.contact_number,
            0,
            1,
            0,
            data.is_tender !== undefined ? data.is_tender : 0,
            createdBy,
            createdBy,
            formattedDate,
            new Date().toISOString(),
            'magic',
            processedUrl
          ];

          rfqQueryValues.push(...rfqValues);
        }

        const rfqResult = await t.one(rfqQuery, rfqQueryValues);

        if (!rfqResult)
          throw Error('RFQ does not exist or is no longer in draft!');

        const { id: rfq_id } = rfqResult;

        const sheetDetails = data?.availableSheets ?? data?.sheetNameList ?? [];

        // Inserting every sheets
        if (!sheetId && !rfqId)
          for (const sheet of sheetDetails) {
            let parameters = {
              rfq_id,
              is_processed: false
            };
            if (typeof sheet == 'object' && 'download_url' in sheet) {
              parameters.sheet_name = sheet.sheet_name;
              parameters.processed_url = sheet.download_url;
            } else {
              parameters.sheet_name = sheet;
              parameters.processed_url = processedUrl;
            }
            const sheetInsertionResult = await rfqModel.insert(
              'tbl_rfq_draft_sheets',
              parameters,
              t
            );
          }

        // Map all the terms to this rfq, defaults to all the terms map
        if (!sheetId)
          for (const term of data.termList) {
            if (!term || !term.id) continue;
            const dataToInsert = {
              rfq_id,
              terms_id: term.id
            };

            await rfqModel.insert('tbl_rfq_terms_map', dataToInsert, t);
          }

        // Insert into tbl_rfq_products and get back their IDs
        let parameter = `rfq_id = ${rfq_id} AND sheet_name = '${sheetToProcess.sheet_name}'`;
        let sheet = await rfqModel.checkIfExists(
          'tbl_rfq_draft_sheets',
          parameter,
          t
        );

        if (sheet) sheet = sheet[0];
        else throw new Error('Sheet to be processed does not exist!');

        for (const product of data.products) {
          const productQuery = `
            INSERT INTO tbl_rfq_products (
              rfq_id, 
              product_variant_id, 
              variant, 
              comment, 
              datasheet, 
              spec_file, 
              qap_file, 
              qap, 
              sheet_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
          `;

          const productValues = [
            rfq_id,
            product.product_id,
            product.variant,
            product.comment,
            0, // datasheet - using 0 as a default value to avoid null constraint
            '', // spec_file - this field will be removed from database
            '', // qap_file - this field will be removed from database
            '', // qap - using empty string as default
            sheet.id
          ];

          const productInsertionResult = await t.one(
            productQuery,
            productValues
          );

          // Insert into tbl_rfq_products_specs
          for (const spec of product.spec || []) {
            if (spec.title == 'Quantity')
              spec.value = parseInt(spec.value) ?? 0;

            await t.none(
              `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, variant, title, value, sheet_id)
              VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                rfq_id,
                product.product_id,
                product.variant,
                spec.title,
                spec.value,
                sheet.id
              ]
            );
          }

          // 4. Insert into tbl_rfq_product_vendors
          for (const vendor of product.vendors || []) {
            // Skip vendors without user_id
            if (!vendor.user_id && !vendor.id) continue;

            // Use id as user_id if user_id is not available
            const userId = vendor.user_id || vendor.id;

            // Get vendor company name
            const vendorCompany = await t.oneOrNone(
              `SELECT c.company_name 
               FROM tbl_users u
               LEFT JOIN tbl_company c ON u.company_id = c.id
               WHERE u.id = $1`,
              [userId]
            );
            const vendorName = vendorCompany?.company_name || null;

            const vendorInsertionResult = await t.none(
              `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, variant, user_id, sheet_id, vendor_name)
              VALUES ($1, $2, $3, $4, $5, $6)`,
              [rfq_id, product.product_id, product.variant, userId, sheet.id, vendorName]
            );
          }
        }

        const updatableData = {
          is_processed: true,
          processed_at: new Date().toISOString(),
          validation_errors: JSON.stringify(data?.validationErrors ?? [])
        };
        await rfqModel.update(
          'tbl_rfq_draft_sheets',
          updatableData,
          sheet.id,
          t
        );

        return rfq_id;
      });
    } catch (error) {
      console.error('Transaction failed. All operations rolled back.', error);
      throw error;
    }
  },

  saveEstimatesInDB: async (data, createdBy) => {
    try {
      return db.tx(async (t) => {
        let estimatesQuery = ``;
        let estimateQueryValues = [];

        estimatesQuery = `
          INSERT INTO tbl_quote_estimates (
            user_id
          )
          VALUES (
            $1
          )
          RETURNING id
        `;

        const estimatesValues = [createdBy];

        estimateQueryValues.push(...estimatesValues);

        const estimateResult = await t.one(estimatesQuery, estimateQueryValues);

        return await db.tx(async (t) => {
          for (const product of data.products) {
            const estimatesItemQuery = `
              INSERT INTO tbl_quote_estimates_item (
                quote_estimates_id,
                product_variant_id,
                lowest_price,
                average_price,
                highest_price
              )
              VALUES (
                $1, 
                $2, 
                $3, 
                $4, 
                $5
              )
              RETURNING id
            `;

            const estimatesItemValues = [
              estimateResult.id,
              product.product_id,
              product.quotes?.lowest_price ?? null,
              product.quotes?.average_price ?? null,
              product.quotes?.highest_price ?? null
            ];

            await t.one(estimatesItemQuery, estimatesItemValues);
          }

          return estimateResult.id;
        });
      });
    } catch (error) {
      console.error('Transaction failed. All operations rolled back.', error);
      throw error;
    }
  },

  insertReturnId: async (table_name, data) => {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const d_keys = keys.join(', ');
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    const query = `INSERT INTO ${table_name} (${d_keys})
      VALUES (${placeholders})
      RETURNING id;`;
    return new Promise(function (resolve, reject) {
      db.query(query, values)
        .then(function (result) {
          resolve(result);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getVendorsForRfq: async (rfq_id, user_name = '') => {
    const query = `
          SELECT DISTINCT TRPV.user_id AS user_id
          FROM tbl_rfq_product_vendors TRPV
          LEFT JOIN tbl_users TU
          ON TRPV.user_id = TU.id
          WHERE rfq_id = $1
          ${
            user_name
              ? `AND (
            to_tsvector('english', TU.name) @@ plainto_tsquery('english', $2) OR
            (char_length($2) = 1 AND similarity(TU.name, $2) > 0) OR
            (char_length($2) > 1 AND similarity(TU.name, $2) > 0.1)
    )`
              : ''
          }
      `;
    const params = user_name ? [rfq_id, user_name] : [rfq_id];
    return new Promise((resolve, reject) => {
      db.query(query, params)
        .then((data) => resolve(data))
        .catch((err) => reject(new Error(err)));
    });
  },

  fetchVendorTypes: async () => {
    try {
      const query = `
            SELECT json_agg(DISTINCT jsonb_build_object(
                'label', trimmed_value,
                'value', lower(replace(trimmed_value, ' ', '_')))
            ) AS nature_of_business_options
            FROM (
                SELECT DISTINCT INITCAP(TRIM(unnested_value)) AS trimmed_value
                FROM (
                    SELECT UNNEST(STRING_TO_ARRAY(nature_of_business, ',')) AS unnested_value
                    FROM tbl_company
                    WHERE nature_of_business IS NOT NULL AND nature_of_business != ''
                ) AS unnested
                WHERE TRIM(unnested_value) <> ''
            ) AS cleaned_values;
        `;
      return await db.query(query);
    } catch (error) {
      throw error;
    }
  },

  getBuyerForRfq: async (rfq_id) => {
    const query = `
          SELECT created_by AS user_id
          FROM tbl_rfq
          WHERE id = $1
      `;
    return new Promise((resolve, reject) => {
      db.query(query, [rfq_id])
        .then((data) => resolve(data))
        .catch((err) => reject(new Error(err)));
    });
  },

  getRfqDetailsById: async (rfq_id) => {
    const query = `
      SELECT *
      FROM tbl_rfq
      WHERE id = $1
    `;
    return new Promise((resolve, reject) => {
      db.query(query, [rfq_id])
        .then((data) => resolve(data[0]))
        .catch((err) =>
          reject(new Error(`Error fetching RFQ details: ${err.message}`))
        );
    });
  },

  getLastRfQNumber: async () => {
    const query = `SELECT rfq_no FROM tbl_rfq ORDER BY id DESC LIMIT 1`;
    return new Promise(function (resolve, reject) {
      db.query(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  insertArray: async (dataArray, keys, table_name, db_con = db) => {
    const insertQuery =
      pgp.helpers.insert(dataArray, keys, table_name) + ' RETURNING *';

    return new Promise(function (resolve, reject) {
      db_con
        .manyOrNone(insertQuery)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  delete: async (table, conditions, db_con = db) => {
    const conditionClauses = [];
    const conditionValues = [];
    let index = 1;

    for (const [key, value] of Object.entries(conditions)) {
      if (key === 'user_ids' && (value?.length ?? []) > 0) {
        conditionClauses.push(
          `user_id IN (${value.map(() => `$${index++}`).join(', ')})`
        );
        conditionValues.push(...value);
      } else if (key === '-user_ids' && (value?.length ?? []) > 0) {
        conditionClauses.push(
          `user_id NOT IN (${value.map(() => `$${index++}`).join(', ')})`
        );
        conditionValues.push(...value);
      } else if (!Array.isArray(value) && typeof value != 'object') {
        conditionClauses.push(`${key} = $${index++}`);
        conditionValues.push(value);
      }
    }

    const conditionString = conditionClauses.join(' AND ');
    const query = `DELETE FROM ${table} WHERE ${conditionString} RETURNING *`;

    try {
      const result = await db_con.query(query, conditionValues);
      return result; // Number of rows deleted
    } catch (error) {
      console.error(`Error deleting from ${table}:`, error);
      throw error;
    }
  },

  deleteWithReturnIds: async (
    table,
    conditions,
    includeMeta,
    excludeMeta,
    db_con = db
  ) => {
    const conditionKeys = Object.keys(conditions);
    const conditionString = conditionKeys
      .map((key, index) => `${key} = $${index + 1}`)
      .join(' AND ');
    const conditionValues = conditionKeys.map((key) => conditions[key]);

    let includeCondition = ``;
    if (
      includeMeta &&
      includeMeta.values &&
      includeMeta.values.filter(Boolean).length > 0
    ) {
      includeCondition += ` AND ${
        includeMeta.key
      } IN (${includeMeta.values.join(',')})`;
    }

    const excludeCondition = ``;
    if (
      excludeMeta &&
      excludeMeta.values &&
      excludeMeta.values.filter(Boolean).length > 0
    ) {
      excludeCondition += ` AND ${
        excludeMeta.key
      } NOT IN (${excludeMeta.values.join(',')})`;
    }

    // Query to fetch IDs before deletion
    const idQuery = `SELECT id FROM ${table} WHERE ${conditionString} ${includeCondition} ${excludeCondition}`;
    const deleteQuery = `DELETE FROM ${table} WHERE ${conditionString} ${includeCondition} ${excludeCondition}`;

    return new Promise((resolve, reject) => {
      db_con
        .query(idQuery, conditionValues)
        .then(async (idResult) => {
          const ids = idResult.map((row) => row.id);
          return db_con
            .query(deleteQuery, conditionValues)
            .then(() => resolve(ids));
        })
        .catch((error) => {
          console.error(`Error deleting from ${table}:`, error);
          reject(error);
        });
    });
  },

  // Separate function to delete from tbl_rfq_product_files based on rfq_product_id list
  deleteProductFilesByIds: async (rfqProductIds) => {
    if (rfqProductIds.length === 0) return Promise.resolve(0); // If no IDs, return immediately

    const query = `
        DELETE FROM tbl_rfq_product_files
        WHERE rfq_product_id = ANY($1::int[])
    `;

    return new Promise((resolve, reject) => {
      db.query(query, [rfqProductIds])
        .then((result) => {
          resolve(result.length); // Return count of deleted rows
        })
        .catch((error) => {
          reject(error);
        });
    });
  },

  findAll: async (table, conditions) => {
    try {
      let query = `SELECT * FROM ${table}`;

      if (conditions && Object.keys(conditions).length > 0) {
        const whereConditions = [];
        const values = [];

        Object.entries(conditions).forEach(([key, value], index) => {
          whereConditions.push(`${key} = $${index + 1}`);
          values.push(value);
        });

        query += ` WHERE ${whereConditions.join(' AND ')}`;
      }

      return await db.query(query, Object.values(conditions || {}));
    } catch (error) {
      console.error(`Error finding all from ${table}:`, error);
      throw error;
    }
  },
  findOne: async (table, conditions) => {
    try {
      let query = `SELECT * FROM ${table}`;

      if (conditions && Object.keys(conditions).length > 0) {
        const whereConditions = [];
        const values = [];

        Object.entries(conditions).forEach(([key, value], index) => {
          whereConditions.push(`${key} = $${index + 1}`);
          values.push(value);
        });

        query += ` WHERE ${whereConditions.join(' AND ')} LIMIT 1`;
      }

      const results = await db.query(query, Object.values(conditions || {}));
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      console.error(`Error finding one from ${table}:`, error);
      throw error;
    }
  },

  getAll: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT RFQ.*,
            ARRAY(
                SELECT json_build_object('id', RFQ_P.id, 'product_id', RFQ_P.product_id,
                    'product_specs', (
                        SELECT json_agg(json_build_object('title', RFQ_P_SPEC.title, 'value', RFQ_P_SPEC.value, 'id', RFQ_P_SPEC.id, 'product_id', RFQ_P_SPEC.product_id, 'rfq_id', RFQ_P_SPEC.rfq_id))
                        FROM tbl_rfq_products_specs RFQ_P_SPEC
                        WHERE RFQ_P.product_id = RFQ_P_SPEC.product_id AND RFQ_P.rfq_id = RFQ_P_SPEC.rfq_id
                    ),
                    'product_details', (
                      SELECT json_agg(json_build_object('id', T_P.id,'name', T_P.name, 'description', T_P.description, 'manufacturer', T_P.manufacturer, 'availability', T_P.availability, 'description', T_P.description ))
                      FROM tbl_product T_P
                      WHERE RFQ_P.product_id = T_P.id
                    ),
                    'vendor_details', (
                      SELECT json_agg(json_build_object('id', RFQ_P_V.id, 'user_id', RFQ_P_V.user_id,
                      'user_details', (
                        SELECT json_build_object(
                            'user_id', U.id,
                            'name', U.name,
                            'email', U.email
                        )
                        FROM tbl_users U
                        WHERE RFQ_P_V.user_id = U.id
                    )
                      ))
                      FROM tbl_rfq_product_vendors RFQ_P_V
                      WHERE RFQ_P.product_id = RFQ_P_V.product_id AND RFQ_P.rfq_id = RFQ_P_V.rfq_id
                  )
                )
                FROM tbl_rfq_products RFQ_P
                WHERE RFQ.id = RFQ_P.rfq_id
            ) AS "products"

            FROM tbl_rfq RFQ
            WHERE RFQ.is_published = 1
            ORDER BY RFQ.id DESC
            LIMIT ${limit} OFFSET $1;`,
        [offset]
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
  getRfqCount: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`select * from tbl_rfq WHERE RFQ.is_published = 1`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  update: async (table_name, data, primary_key, db_con = db) => {
    const setClause = Object.keys(data)
      .map((key, index) => `${key} = $${index + 1}`)
      .join(', ');
    const values = Object.values(data);
    const updateQuery = `
      UPDATE ${table_name}
      SET ${setClause}
      WHERE id = ${primary_key}
      RETURNING *`;

    return new Promise(function (resolve, reject) {
      db_con
        .query(updateQuery, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateWhere: async (table_name, data, where_clause, db_con = db) => {
    const setClause = Object.keys(data)
      .map((key, index) => `${key} = $${index + 1}`)
      .join(', ');
    const values = Object.values(data);
    const updateQuery = `
      UPDATE ${table_name}
      SET ${setClause}
      WHERE ${where_clause}
      RETURNING *`;

    return new Promise(function (resolve, reject) {
      db_con
        .query(updateQuery, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getTechEvaluationRecordsByProductId: async (productId) => {
    const fetchQuery = `
      SELECT id
      FROM tbl_rfq_product_tech_evaluation
      WHERE tbl_rfq_product_id = $1`;

    return new Promise((resolve, reject) => {
      db.query(fetchQuery, [productId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getTechEvaluationRecordsByProductId: async (productId) => {
    const fetchQuery = `
      SELECT id
      FROM tbl_rfq_product_tech_evaluation
      WHERE tbl_rfq_product_id = $1`;

    return new Promise((resolve, reject) => {
      db.query(fetchQuery, [productId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  checkAllProductsFinalized: async (rfq_id, user_id) => {
    // This function checks if all products in an RFQ are finalized
    // Returns true if all products are finalized, false otherwise
    const query = `
      SELECT COUNT(*) AS total_products,
             SUM(CASE
                  WHEN EXISTS (
                    SELECT 1 FROM tbl_quote_finalization TQF
                    WHERE TQF.rfq_id = RP.rfq_id
                    AND TQF.product_variant_id = RP.product_variant_id
                    AND TQF.variant = RP.variant
                  ) THEN 1
                  ELSE 0
                END) AS finalized_products
      FROM tbl_rfq_products RP
      JOIN tbl_rfq_product_vendors RPV ON RP.rfq_id = RPV.rfq_id
                                      AND RP.product_variant_id = RPV.product_variant_id
                                      AND RP.variant = RPV.variant
      WHERE RP.rfq_id = $1 AND RPV.user_id = $2
    `;

    return new Promise((resolve, reject) => {
      db.query(query, [rfq_id, user_id])
        .then((data) => {
          if (data.length > 0) {
            const { total_products, finalized_products } = data[0];
            // If all products are finalized or there are no products, return true
            resolve(
              parseInt(total_products) > 0 &&
                parseInt(total_products) === parseInt(finalized_products)
            );
          } else {
            resolve(false);
          }
        })
        .catch((err) => {
          console.error('Error checking if all products are finalized:', err);
          reject(new Error(err));
        });
    });
  },

  updateWithTimestamp: async (table_name, data, primary_key) => {
    const setClause = Object.keys(data)
      .map((key, index) => `${key} = $${index + 1}`)
      .join(', ');
    const values = Object.values(data);
    const updateQuery = `
      UPDATE ${table_name}
      SET ${setClause}
      , timestamp = CURRENT_TIMESTAMP
      WHERE id = ${primary_key}
      RETURNING *`;

    // console.log("here 1: ", updateQuery, values)

    return new Promise(function (resolve, reject) {
      db.query(updateQuery, values)
        .then(function (data) {
          // console.log("here 2: ", data)
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getAllTerms: async () => {
    return new Promise(function (resolve, reject) {
      db.query(`SELECT * FROM tbl_rfq_terms`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getAvailableUnits: async () => {
    return new Promise(function (resolve, reject) {
      db.query(`SELECT * FROM tbl_rfq_units`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getAllRfqBuyer: async (limit, offset, user_id, month, year) => {
    const query = `SELECT RFQ.id,RFQ.rfq_no,RFQ.is_published,RFQ.created_by,RFQ.status,RFQ.timestamp,
      ARRAY(
      SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id
    ) AS "quotations",

    ARRAY(
      SELECT json_build_object('id', TQF.id,'rfq_id', TQF.rfq_id,'rfq_no', TQF.rfq_no, 'timestamp', TQF.timestamp, 'created_by', TQF.created_by ) FROM tbl_quote_finalization TQF WHERE TQF.rfq_id = RFQ.id AND TQF.created_by = '${user_id}'
    ) AS "finilize"
    FROM tbl_rfq RFQ
    WHERE RFQ.is_published = 1 AND created_by =  '${user_id}' AND EXTRACT(MONTH FROM timestamp) = '$1' AND EXTRACT(YEAR FROM timestamp) = '$2' ORDER BY id DESC LIMIT $3 OFFSET $4 `;
    return new Promise(function (resolve, reject) {
      db.query(query, [month, year, limit, offset])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getAllRfqBuyerExport: async (user_id, month, year) => {
    const query = `SELECT RFQ.id,RFQ.rfq_no,RFQ.is_published,RFQ.created_by,RFQ.status,RFQ.timestamp,
      ARRAY(
      SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id
    ) AS "quotations",

    ARRAY(
      SELECT json_build_object('id', TQF.id,'rfq_id', TQF.rfq_id,'rfq_no', TQF.rfq_no, 'timestamp', TQF.timestamp, 'created_by', TQF.created_by ) FROM tbl_quote_finalization TQF WHERE TQF.rfq_id = RFQ.id AND TQF.created_by = '${user_id}'
    ) AS "finilize"
    FROM tbl_rfq RFQ
    WHERE RFQ.is_published = 1 AND created_by =  '${user_id}' AND EXTRACT(MONTH FROM timestamp) = '$1' AND EXTRACT(YEAR FROM timestamp) = '$2' ORDER BY id DESC  `;
    return new Promise(function (resolve, reject) {
      db.query(query, [month, year])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getRfqByUser: async (limit, offset, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT
          RFQ.id,
          RFQ.rfq_no,
          RFQ.company_name,
          RFQ.response_email,
          RFQ.is_published,
          RFQ.status,
          RFQ.bid_end_date,
          RFQ.timestamp,
          RFQ.rfq_type,
          RFQ.reverse_auction,

          (
              SELECT COUNT(*)
              FROM tbl_query_messages TQM
              WHERE TQM.receiver_id = $3
                AND TQM.rfq_id = RFQ.id
                AND TQM.is_seen = false
            ) AS unseen_query_count,
            ARRAY(
                SELECT json_build_object('id', RFQ_P.id, 'product_id', RFQ_P.product_variant_id,
                    'product_categories', (
                        SELECT json_agg(json_build_object('category_id',TPC.category_id,'category_name',TC.title))
                        FROM tbl_product_categories TPC
                        LEFT JOIN tbl_category TC ON TC.id = TPC.category_id
                        WHERE TPC.product_id = RFQ_P.id
                    ),
                    'product_specs', (
                        SELECT json_agg(json_build_object('title', RFQ_P_SPEC.title, 'value', RFQ_P_SPEC.value, 'id', RFQ_P_SPEC.id, 'product_id', RFQ_P_SPEC.product_variant_id, 'rfq_id', RFQ_P_SPEC.rfq_id))
                        FROM tbl_rfq_products_specs RFQ_P_SPEC
                        WHERE RFQ_P.product_variant_id = RFQ_P_SPEC.product_variant_id AND RFQ_P.rfq_id = RFQ_P_SPEC.rfq_id
                    ),
                    'product_details', (
                        SELECT json_agg(json_build_object('id', T_V.id,'name', T_V.name, 'description', T_P.description ))
                        FROM tbl_product_variant T_V
                        JOIN tbl_product T_P ON T_P.id = T_V.product_id
                        WHERE RFQ_P.product_variant_id = T_V.id
                    ),
                    'vendor_details', (
                        SELECT json_agg(json_build_object('id', RFQ_P_V.id, 'user_id', RFQ_P_V.user_id,
                            'user_details', (
                                SELECT json_build_object(
                                    'user_id', U.id,
                                    'name', U.name,
                                    'email', U.email
                                )
                                FROM tbl_users U
                                WHERE RFQ_P_V.user_id = U.id
                            )
                        ))
                        FROM tbl_rfq_product_vendors RFQ_P_V
                        WHERE RFQ_P.product_variant_id = RFQ_P_V.product_variant_id AND RFQ_P.rfq_id = RFQ_P_V.rfq_id
                        AND RFQ_P_V.user_id = ${user_id} 
                    )
                )
                FROM tbl_rfq_products RFQ_P
                JOIN tbl_rfq_product_vendors trpv ON trpv.rfq_id = RFQ.id AND trpv.user_id = ${user_id} AND trpv.product_variant_id = RFQ_P.product_variant_id
                WHERE RFQ.id = RFQ_P.rfq_id AND trpv.rfq_id = RFQ.id AND trpv.user_id = ${user_id} AND trpv.product_variant_id = RFQ_P.product_variant_id
            ) AS "products" ,
          CASE
              WHEN EXISTS (
                  SELECT 1 FROM tbl_quotes TQ
                  WHERE TQ.rfq_id = RFQ.id
                    AND TQ.rfq_no = RFQ.rfq_no
                    AND TQ.created_by = $3
              )
                  THEN
                  CASE
                      WHEN (
                              SELECT TQ.is_regret
                              FROM tbl_quotes TQ
                              WHERE TQ.rfq_id = RFQ.id
                                AND TQ.rfq_no = RFQ.rfq_no
                                AND TQ.created_by = $3
                              LIMIT 1
                          ) = 1 THEN 'rejected'
                      ELSE 'sent'
                      END
              ELSE 'pending'
        END AS quote_status
        FROM tbl_rfq RFQ
        WHERE EXISTS (
                  SELECT 1
            FROM tbl_rfq_product_vendors RFQ_P_V
            WHERE RFQ.id = RFQ_P_V.rfq_id
            AND RFQ_P_V.user_id = $3
        ) AND RFQ.is_published = 1
        ORDER BY RFQ.timestamp DESC
      LIMIT $2 OFFSET $1;`,
        [offset, limit, user_id]
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

  getRfqDraftById: async (id, oldestSheet) => {
    const q = `SELECT
      RFQ.id AS rfq_id,
      RFQ.rfq_no,

      -- Encapsulate RFQ fields in rfqFormData
      json_build_object(
          'is_published', RFQ.is_published,
          'comment', RFQ.comment,
          'response_email', RFQ.response_email,
          'contact_name', RFQ.contact_name,
          'contact_number', RFQ.contact_number,
          'company_name', RFQ.company_name,
          'bid_end_date', RFQ.bid_end_date,
          'rfq_type', RFQ.rfq_type,
          'reverse_auction', RFQ.reverse_auction,
          'ra_start_date', RFQ.ra_start_date,
          'ra_end_date', RFQ.ra_end_date,
          'project_id', RFQ.project_id,
          'location', RFQ.location,
          'rfq_added_from', RFQ.rfq_added_from,

          -- Selected Terms
          'terms', (
              SELECT COALESCE(json_agg(
                  json_build_object(
                      'id', RFQ_TM.terms_id,
                      'term_content', RFQ_T.term_content,
                      'name', RFQ_T.term_content
                  )
              ), '[]'::json)
              FROM tbl_rfq_terms_map RFQ_TM
              JOIN tbl_rfq_terms RFQ_T ON RFQ_T.id = RFQ_TM.terms_id
              WHERE RFQ_TM.rfq_id = RFQ.id
          ),

          -- Term and condition files
          'term_and_condition_files', (
              SELECT COALESCE(json_agg(RF.file_url), '[]'::json)
              FROM tbl_rfq_files RF
              WHERE RF.rfq_id = RFQ.id AND RF.file_type = 'term_and_condition'
          )
      ) AS rfq_form_data,

      -- Products
      ARRAY(
          SELECT json_build_object(
              'id', RFQ_P.id,
              'product_id', RFQ_P.product_variant_id,
              'predefined_tds_file', RFQ_P.datasheet_file,
              'predefined_qap_file', RFQ_P.qap_file,
              'name', TV.name,
              'product_name', T_P.name,
              'variant', RFQ_P.variant,
              'vendor_count', (
              SELECT COUNT(*)
              FROM tbl_rfq_product_vendors trpv
              WHERE trpv.rfq_id = RFQ_P.rfq_id
              AND trpv.product_variant_id = RFQ_P.product_variant_id
              AND trpv.variant = RFQ_P.variant
              ),
              'spec', (
                  SELECT json_agg(json_build_object(
                      'title', RFQ_P_SPEC.title,
                      'value', RFQ_P_SPEC.value
                  ))
                  FROM tbl_rfq_products_specs RFQ_P_SPEC
                  WHERE RFQ_P.product_variant_id = RFQ_P_SPEC.product_variant_id 
                    AND RFQ_P.rfq_id = RFQ_P_SPEC.rfq_id 
                    AND RFQ_P.variant = RFQ_P_SPEC.variant
              ),
              'comment', RFQ_P.comment,
              'datasheet', (RFQ_P.datasheet::TEXT),
              'datasheet_file', (
                  SELECT COALESCE(json_agg(RPF.file_url), '[]'::json)
                  FROM tbl_rfq_product_files RPF
                  WHERE RPF.rfq_product_id = RFQ_P.id AND RPF.file_type = 'TDS'
              ),
              'spec_file', (
                  SELECT COALESCE(json_agg(RPF.file_url), '[]'::json)
                  FROM tbl_rfq_product_files RPF
                  WHERE RPF.rfq_product_id = RFQ_P.id AND RPF.file_type = 'SPEC'
              ),
              'qap', (RFQ_P.qap::TEXT),
              'qap_file', (
                  SELECT COALESCE(json_agg(RPF.file_url), '[]'::json)
                  FROM tbl_rfq_product_files RPF
                  WHERE RPF.rfq_product_id = RFQ_P.id AND RPF.file_type = 'QAP'
              ),
              'user_selected_predefined_tds', (RFQ_P.datasheet = '1'),
              'user_selected_predefined_qap', (RFQ_P.qap = '1'),
              'sheet_id', RFQ_P.sheet_id
          )
          FROM tbl_rfq_products RFQ_P
          LEFT JOIN tbl_product_variant TV ON RFQ_P.product_variant_id = TV.id
          LEFT JOIN tbl_product T_P ON T_P.id = TV.product_id
          WHERE RFQ.id = RFQ_P.rfq_id
          ${oldestSheet && oldestSheet.id ? ` AND RFQ_P.sheet_id = $2` : ``}
          ORDER BY RFQ_P.id
      ) AS rfq_products
    FROM tbl_rfq RFQ
    WHERE RFQ.id = $1
    ORDER BY RFQ.id DESC
    LIMIT 1;
    `;
    try {
      const values = [id];
      if (oldestSheet && oldestSheet.id) values.push(oldestSheet.id);

      const result = await db.many(q, values);
      return result;
    } catch (error) {
      throw error;
    }
  },


  getDraftProductVendors: async (draftId, rfqProductId, buyerId, filters) => {
    try {
      // get company_id for this buyer
      const buyer = await db.oneOrNone(
        'SELECT company_id FROM tbl_users WHERE id = $1',
        [buyerId]
      );
      if (!buyer || !buyer.company_id)
        throw new Error('Buyer not found or no company associated');
      const companyId = buyer.company_id;

      let {
        vendor_approved_by,
        state,
        city,
        country,
        turnOver,
        vendor_type,
        prev_worked_with,
        vendor_name,
        vendor_info,
        productMakes,
        subscription_type,
      } = filters;

      const isAnyFilterActive =
        Object.keys(filters).filter((key) => !!filters[key]).length > 0;

      let turnoverCondition = '';

      turnOver = {
        from: parseInt(turnOver?.from ?? 0),
        to: parseInt(turnOver?.to ?? 0)
      };

      if (turnOver && (turnOver.from > 0 || turnOver.to > 0)) {
        turnoverCondition = `AND tc.turnover IS NOT NULL AND TRIM(tc.turnover) != '' AND (`;

        const turnoverField = `NULLIF(TRIM(tc.turnover), '')::bigint`;

        if (turnOver.from > 0 && turnOver.to > 0) {
          turnoverCondition += `${turnoverField} BETWEEN ${turnOver.from} AND ${turnOver.to}`;
        } else if (turnOver.from > 0) {
          turnoverCondition += `${turnoverField} >= ${turnOver.from}`;
        } else if (turnOver.to > 0) {
          turnoverCondition += `${turnoverField} <= ${turnOver.to}`;
        }

        turnoverCondition += ')';
      }

      let dynamicJoin = '';
      let dynamicWhere = '';

      // JOINS
      if (
        vendor_approved_by ||
        (Array.isArray(vendor_approved_by) && vendor_approved_by?.length > 0)
      ) {
        dynamicJoin += `
          JOIN tbl_vendorapprove_product_mapping vum 
            ON vum.variant_vendor_mapping_id = pvvm.id
        `;
      }

      // if (city) {
      //   dynamicJoin += `
      //     LEFT JOIN tbl_location_cities lc ON tu.city = lc.id
      //   `;
      // }

      // if (state) {
      //   dynamicJoin += `
      //     LEFT JOIN tbl_location_states ls ON tu.state = ls.id
      //   `;
      // }

      // if (country) {
      //   dynamicJoin += `
      //     LEFT JOIN tbl_location_country lcn ON tu.country IS NOT NULL AND tu.country = lcn.id::text
      //   `;
      // }

      dynamicJoin += `
        LEFT JOIN (
          SELECT
            tus.user_id,
            MAX(tus.end_date) AS max_end_date,
            MAX(
              CASE
                WHEN tsp.plan_name ILIKE '%Enterprise%'
                  AND tus.status = 1
                  AND CURRENT_DATE BETWEEN tus.start_date AND tus.end_date
                  THEN 2
                WHEN tsp.plan_name ILIKE '%Premium%'
                  AND tus.status = 1
                  AND CURRENT_DATE BETWEEN tus.start_date AND tus.end_date
                  THEN 1
                ELSE 0
              END
            ) AS is_premium
          FROM tbl_user_subscriptions tus
          LEFT JOIN tbl_subscription_plans tsp ON tsp.id = tus.plan_id
          GROUP BY tus.user_id
        ) sub_info ON sub_info.user_id = tu.id
      `;

      if (prev_worked_with === 'prev_finalized') {
        dynamicJoin += `
          LEFT JOIN tbl_quote_finalization qf 
            ON qf.vendor_id = tu.id AND qf.created_by = ${buyerId}
        `;
      }

      if (prev_worked_with === 'rfq_sent') {
        dynamicJoin += `
          LEFT JOIN (
            SELECT DISTINCT rpv.user_id
            FROM tbl_rfq_product_vendors rpv
            JOIN tbl_rfq rfq ON rfq.id = rpv.rfq_id
            WHERE rfq.created_by = ${buyerId} AND rfq.is_published = 1
          ) rfqv ON rfqv.user_id = tu.id
        `;
      }

      // WHERE CLAUSES
      if (city && Array.isArray(city) && city.length > 0) {
        dynamicWhere += ` AND tcl.city_id::int IN (${city.join(',')})`;
      } else if (typeof city == 'string' || typeof city == 'number') {
        dynamicWhere += ` AND tcl.city_id = '${city}'`;
      }

      if (state && Array.isArray(state) && state.length > 0) {
        dynamicWhere += ` AND tcl.state_id::int IN (${state.join(',')})`;
      } else if (typeof state == 'string' || typeof state == 'number') {
        dynamicWhere += ` AND tcl.state_id = '${state}'`;
      }

      if (country && Array.isArray(country) && country.length > 0) {
        dynamicWhere += ` AND COALESCE(tcl.country_id, '1')::int IN (${country.join(
          ','
        )})`;
      } else if (typeof country == 'string' || typeof country == 'number') {
        dynamicWhere += ` AND COALESCE(tcl.country_id, '1') = '${country}'`;
      }

      if (turnoverCondition) {
        dynamicWhere += ` ${turnoverCondition}`;
      }

      if (vendor_type && Array.isArray(vendor_type) && vendor_type.length > 0) {
        dynamicWhere += `
          AND EXISTS (
            SELECT 1
            FROM unnest(string_to_array(LOWER(tc.nature_of_business), ',')) AS nb
            WHERE TRIM(nb) IN (${vendor_type
              .map((type) => `'${type.toLowerCase()}'`)
              .join(',')})
          )
        `;
      } else if (
        typeof vendor_type == 'string' ||
        typeof vendor_type == 'number'
      ) {
        dynamicWhere += `
          AND EXISTS (
            SELECT 1
            FROM unnest(string_to_array(LOWER(tc.nature_of_business), ',')) AS nb
            WHERE TRIM(nb) IN ('${vendor_type}')
          )
        `;
      }

      if (subscription_type) {
        dynamicWhere += ` ${subscription_type == 'premium' ? 'AND is_premium = 1' : subscription_type == 'enterprise' ? 'AND is_premium = 2' : 'AND is_premium = 0'}`
      }

      if (
        vendor_approved_by &&
        Array.isArray(vendor_approved_by) &&
        vendor_approved_by.length > 0
      ) {
        dynamicWhere += ` AND vum.vendor_approve_id IN (${vendor_approved_by.join(
          ','
        )})`;
      } else if (
        typeof vendor_approved_by == 'string' ||
        typeof vendor_approved_by == 'number'
      ) {
        dynamicWhere += ` AND vum.vendor_approve_id IN ('${vendor_approved_by}')`;
      }

      if (vendor_info === 'is_private') {
        dynamicWhere += ` AND tc.is_private = 1 AND bvm.vendor_id IS NOT NULL`;
      } else if (vendor_info === 'is_public') {
        dynamicWhere += ` AND tc.is_private = 0 AND bvm.vendor_id IS NOT NULL`;
      } else if (vendor_info === 'both') {
        dynamicWhere += ` AND bvm.vendor_id IS NOT NULL`;
      }

      if (prev_worked_with === 'prev_finalized') {
        dynamicWhere += ` AND qf.id IS NOT NULL`;
      } else if (prev_worked_with === 'rfq_sent') {
        dynamicWhere += ` AND rfqv.user_id IS NOT NULL`;
      }

      if (
        productMakes &&
        Array.isArray(productMakes) &&
        productMakes.length > 0
      ) {
        dynamicWhere += `
          AND EXISTS (
            SELECT 1
            FROM tbl_product_variant_vendor_make pvmm
            WHERE pvmm.variant_vendor_map_id = pvvm.id
            AND LOWER(pvmm.make_name) IN (${productMakes.map(pm => `'${pm.toLowerCase()}'`).join(', ')})
          )
        `;
      } else if (
        typeof productMakes == 'string' ||
        typeof productMakes == 'number'
      ) {
        dynamicWhere += `
          AND EXISTS (
            SELECT 1
            FROM tbl_product_variant_vendor_make pvmm
            WHERE pvmm.variant_vendor_map_id = pvvm.id
            AND LOWER(pvmm.make_name) = '${String(productMakes).toLowerCase()}'
          )
        `;
      }

      if (vendor_name?.trim()) {
        dynamicWhere += `
          AND (
            to_tsvector('english', COALESCE(tc.company_name, tu.organization_name)) @@ plainto_tsquery('english', $3)
            OR (char_length($3) = 1 AND similarity(COALESCE(tc.company_name, tu.organization_name), $3) > 0)
            OR (char_length($3) > 1 AND similarity(COALESCE(tc.company_name, tu.organization_name), $3) > 0.1)
          )
        `;
      }

      let q = `
        SELECT 
          DISTINCT ON (tu.name, tu.id) tu.id AS user_id, 
          tu.name, 
          COALESCE(sub_info.is_premium, 0) AS is_premium,
          ${
            vendor_name
              ? 'similarity(COALESCE(tc.company_name, tu.organization_name), $3) AS similarity_score,'
              : ''
          } 
          JSON_BUILD_OBJECT(
            'id', tu.id,
            'name', tu.name,
            'company_name', COALESCE(tc.company_name, tu.organization_name, tu.name),
            'email', tu.email,
            'address', tcl.address,
            'mobile', tu.mobile
          ) AS user_details
  
          FROM tbl_rfq_products trp
          JOIN tbl_rfq_product_vendors trpv 
            ON trpv.rfq_id = trp.rfq_id 
              AND trpv.product_variant_id = trp.product_variant_id 
              AND trpv.variant = trp.variant
          JOIN tbl_product_variant tpv ON tpv.id = trp.product_variant_id
          JOIN tbl_users tu ON trpv.user_id = tu.id
          LEFT JOIN tbl_company_location tcl ON tu.company_id = tcl.company_id
          LEFT JOIN tbl_buyer_private_vendors_mapping bvm 
              ON tu.id = bvm.vendor_id AND bvm.company_id = ${companyId}
          JOIN tbl_product_variant_vendor_mapping pvvm ON pvvm.product_variant_id = tpv.id AND pvvm.vendor_id = tu.id AND pvvm.status = TRUE AND pvvm.is_approved = TRUE
          JOIN tbl_company tc ON tu.company_id = tc.id

          ${dynamicJoin}
  
          WHERE trp.rfq_id = $1
              AND trp.id = $2
              ${dynamicWhere}
            
          ORDER BY tu.name
        `;

      console.log("GET DRAFT VENDORS:", q);

      return db.any(q, [draftId, rfqProductId, vendor_name]);
    } catch (error) {
      console.log('ERROR -> ', error);
      throw error;
    }
  },

  getNextVariant: async (rfq_id, product_id) => {
    const query = `
          SELECT COALESCE(MAX(variant), -1) AS max_variant
          FROM tbl_rfq_products
          WHERE rfq_id = $1 AND product_variant_id = $2
      `;
    const values = [rfq_id, product_id];

    return new Promise(function (resolve, reject) {
      db.query(query, values)
        .then(function (result) {
          const max_variant = parseInt(result[0].max_variant);
          resolve(max_variant + 1);
        })
        .catch(function (err) {
          const error = new Error(err);
          reject(error);
        });
    });
  },

  getRfqById: async (id, user_id, user_type, includeVendors = false) => {
    // First, let's directly check the auction dates in the database
    try {
      //  unused code written by
      // const dateCheckQuery = `
      //   SELECT id, reverse_auction, ra_start_date, ra_end_date
      //   FROM tbl_rfq
      //   WHERE id = $1
      // `;
      // const dateCheckResult = await db.query(dateCheckQuery, [id]);
    } catch (error) {
      console.error('Error checking auction dates:', error);
    }

    //query changes by mukul on 20-11-2024
    // type casting for TVA.id = NULLIF(RFQ_P.qap, '')::INTEGER

    //  query changed by mukul,
    let q = `SELECT
      RFQ.id,
      RFQ.rfq_no,
      RFQ.comment,
      RFQ.company_name,
      RFQ.response_email,
      RFQ.contact_name,
      RFQ.contact_number,
      RFQ.bid_end_date,
      RFQ.location,
      RFQ.is_published,
      RFQ.created_by,
      RFQ.updated_by,
      RFQ.timestamp,
      RFQ.status,
      RFQ.rfq_type,
      RFQ.reverse_auction,
      RFQ.ra_start_date, -- Select raw timestamp
      RFQ.ra_end_date,   -- Select raw timestamp
      RFQ.project_id,
        -- Add here
      (
        SELECT EXISTS (
          SELECT 1
          FROM tbl_quotes tq
          WHERE tq.rfq_id = RFQ.id
          LIMIT 1
        )
      ) AS is_quotes_present,

      (SELECT COUNT(*)
     FROM tbl_query_messages TQM
     WHERE TQM.receiver_id = ${user_id}
     AND TQM.rfq_id = RFQ.id
     AND TQM.is_seen = false
    ) AS "unseen_query_count",
    -- Fetching global_payment_term and global_comment from tbl_quotes
    (
      SELECT json_build_object(
        'is_regret', TQ.is_regret,
        'regret_reason', TQ.regret_reason,
        'global_payment_term', TQ.global_payment_term,
        'global_comment', TQ.global_comment,
        'gstin', TQ.gstin
      )
      FROM tbl_quotes TQ
      WHERE TQ.rfq_id = RFQ.id
        AND TQ.created_by = ${user_id}
      LIMIT 1
    ) AS "quote_details",

    (
      SELECT json_agg(json_build_object(
        'file_url', TQF.file_url
      ))
      FROM tbl_quotes_files TQF
      WHERE TQF.quote_id = (
        SELECT TQ.id
        FROM tbl_quotes TQ
        WHERE TQ.rfq_id = RFQ.id
          AND TQ.created_by = ${user_id}
        LIMIT 1
      )
        AND TQF.file_type = 'term_and_condition'
    ) AS "terms_and_conditions_files",
    
    ARRAY(
      SELECT json_build_object(
        'id', RFQ_TM.terms_id,
        'term_content', RFQ_T.term_content,
        'name', RFQ_T.term_content,
        'term_id', RFQ_TM.terms_id
      )
      FROM tbl_rfq_terms_map RFQ_TM
      JOIN tbl_rfq_terms RFQ_T ON RFQ_T.id = RFQ_TM.terms_id
      WHERE RFQ_TM.rfq_id = RFQ.id
    ) AS "terms",
    (
      SELECT json_agg(RF.file_url)
      FROM tbl_rfq_files RF
      WHERE RF.rfq_id = RFQ.id AND RF.file_type = 'term_and_condition'
    ) AS "TERM_files",
    ARRAY(
    SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret,

    -- payment term list 
    'payment_terms', COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', QPT.id,
            'type', QPT.type,
            'value', QPT.value,
            'days', QPT.days,
            'comment', QPT.comment
          )
          ORDER BY QPT.id
        )
        FROM tbl_quotes_payment_terms QPT
        WHERE QPT.quote_id = TQ.id
      ),
      '[]'::json
    ),

        'products', (
          SELECT json_agg(
            json_build_object(
              'product_id', TQI.product_variant_id,
              'variant', TQI.variant,
              'product_name', TQI.product_name,
              'unit_price', TQI.unit_price,
              'package_price', TQI.package_price,
              'tax', TQI.tax,
              'freight_price', TQI.freight_price,
              'total_price', TQI.total_price,
              'comment', TQI.comment,
              'delivery_period', TQI.delivery_period,
              'freight_mode', TQI.freight_mode,
              'package_mode', TQI.package_mode,
              'tax_mode', TQI.tax_mode,
              'previous_document_files', (
                    SELECT json_agg(json_build_object('file_type', QIF.file_type, 'file_url', QIF.file_url))
                    FROM tbl_quote_item_files QIF
                    WHERE QIF.quote_item_id = TQI.id
                ),
              'document_files', (
                    SELECT json_agg(json_build_object('file_type', QIF.file_type, 'file_url', QIF.file_url))
                    FROM tbl_quote_item_files QIF
                    WHERE QIF.quote_item_id = TQI.id
                )
          ))
          FROM tbl_quote_items TQI
          WHERE CAST(TQ.id AS INTEGER) = TQI.quote_id
        )
      ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id AND TQ.created_by = ${user_id}
    ) AS "quotations"
FROM tbl_rfq RFQ WHERE id=$1
ORDER BY RFQ.id DESC   
LIMIT 1;`;

    const productQuery = `
    SELECT
        RFQ_P.id,
        RFQ_P.product_variant_id AS product_id,
        _TPV.name,
        RFQ_P.variant,
        RFQ_P.comment,
        (
            SELECT json_agg(RPF.file_url)
            FROM tbl_rfq_product_files RPF
            WHERE RPF.rfq_product_id = RFQ_P.id
              AND RPF.file_type = 'QAP'
        ) AS qap_file,
        (
            SELECT json_agg(RPF.file_url)
            FROM tbl_rfq_product_files RPF
            WHERE RPF.rfq_product_id = RFQ_P.id
              AND RPF.file_type = 'SPEC'
        ) AS spec_file,
          'latest_target_price', (
            SELECT tptp.target_price
            FROM tbl_rfq_product_target_price tptp
            WHERE tptp.tbl_rfq_product_id = RFQ_P.id and vendor_id = ${user_id}
            ORDER BY tptp.created_at DESC
            LIMIT 1
            ),
        (
            SELECT json_agg(RPF.file_url)
            FROM tbl_rfq_product_files RPF
            WHERE RPF.rfq_product_id = RFQ_P.id
              AND RPF.file_type = 'TDS'
        ) AS datasheet_file,
        (
            SELECT json_agg(json_build_object('title', RFQ_P_SPEC.title,'value', RFQ_P_SPEC.value))
            FROM tbl_rfq_products_specs RFQ_P_SPEC
            WHERE RFQ_P.product_variant_id = RFQ_P_SPEC.product_variant_id
              AND RFQ_P.rfq_id = RFQ_P_SPEC.rfq_id
              AND RFQ_P.variant = RFQ_P_SPEC.variant
        ) AS product_specs,
        (
            SELECT json_agg(json_build_object('id', T_V.id, 'name', T_V.name, 'description', T_P.description))
            FROM tbl_product_variant T_V
            JOIN tbl_product T_P ON T_P.id = T_V.product_id
            WHERE RFQ_P.product_variant_id = T_V.id
        ) AS product_details,
        COALESCE(
          (
            SELECT
              CASE
                WHEN TQF.vendor_id = $2 THEN 'You are finalized'
                ELSE 'Another vendor is finalized'
              END
            FROM tbl_quote_finalization TQF
            WHERE TQF.rfq_id = RFQ_P.rfq_id
              AND TQF.product_variant_id = RFQ_P.product_variant_id
              AND TQF.variant = RFQ_P.variant
            LIMIT 1
          ),
          'No vendor finalized yet'
        ) AS finalization_status
        ${
          // Changes by Agnij 2025-05-05 [Modified to include user_type 2, 3, 8, 9, 10]
          user_type == 2 ||
          user_type == 8 ||
          user_type == 3 ||
          user_type == 9 ||
          user_type == 10
            ? `,(
                ${
                  user_type == 3
                    ? `
                -- Check if this product has technical evaluation enabled (has clauses)
                WITH tech_eval AS (
                    SELECT TE.id AS tech_eval_id
                    FROM tbl_rfq_product_tech_evaluation TE
                    JOIN tbl_rfq_product_tech_evaluation_clauses TEC ON TE.id = TEC.tbl_rfq_product_tech_evaluation_id
                    WHERE TE.rfq_id = RFQ_P.rfq_id AND TE.tbl_rfq_product_id = RFQ_P.id
                    LIMIT 1
                ),


                -- Check if current vendor is technically accepted for this product
                tech_accepted AS (
                    SELECT 1 AS is_accepted
                    FROM tbl_rfq_product_tech_evaluation_cleared_vendors TECV
                    JOIN tech_eval TE ON TECV.tbl_rfq_product_tech_evaluation_id = TE.tech_eval_id
                    WHERE TECV.vendor_id = ${user_id} AND TECV.status = 1
                    LIMIT 1
                )`
                    : ``
                }
                -- Changes by Agnij 2025-05-08 [Fixed lowest quotation selection to always pick the lowest price]
                SELECT json_build_object(
                    'quote_id', TQI.quote_id,
                    'total_price', TQI.total_price
                )
                FROM (
                    SELECT 
                        quote_id,
                        total_price,
                        ROW_NUMBER() OVER (PARTITION BY product_variant_id, variant ORDER BY total_price ASC) AS rn
                    FROM tbl_quote_items
                    WHERE product_variant_id = RFQ_P.product_variant_id
                    AND variant = RFQ_P.variant
                    AND rfq_id = RFQ_P.rfq_id
                    AND total_price > 0
                ) TQI
                WHERE TQI.rn = 1  -- Get only the lowest price for each product/variant
                AND RFQ.reverse_auction = 1
                ${
                  user_type == 3
                    ? `
                -- Apply technical evaluation filtering if enabled for this product
                AND (
                    -- If no technical evaluation exists for this product OR
                    -- vendor is technically accepted, OR
                    -- if reverse auction ends before/with RFQ end date
                    (SELECT COUNT(*) FROM tech_eval) = 0
                    OR (SELECT COUNT(*) FROM tech_accepted) > 0
                    OR (
                        -- Special case: For technically evaluated products where RA ends before RFQ end date
                        -- Show lowest quote only to technically accepted vendors
                        (SELECT COUNT(*) FROM tech_eval) > 0
                        AND RFQ.ra_end_date IS NOT NULL
                        AND RFQ.bid_end_date IS NOT NULL
                        AND CAST(RFQ.ra_end_date AS TIMESTAMP) <= CAST(RFQ.bid_end_date AS TIMESTAMP)
                        AND (
                            -- Check if vendor is technically accepted
                            (SELECT COUNT(*) FROM tech_accepted) > 0
                        )
                    )
                )`
                    : ``
                }
                -- Timing conditions for when lowest quote should be visible
                AND (
                    -- Show lowest quote if current time is within auction period
                  CURRENT_TIMESTAMP BETWEEN
                    CAST(RFQ.ra_start_date AS TIMESTAMP)
                    AND CAST(RFQ.ra_end_date AS TIMESTAMP) + interval '23 hours 59 minutes'
                    OR
                    -- If reverse auction starts after RFQ ends
                    (
                        RFQ.ra_start_date IS NOT NULL
                        AND RFQ.bid_end_date IS NOT NULL
                        AND CAST(RFQ.ra_start_date AS TIMESTAMP) >= CAST(RFQ.bid_end_date AS TIMESTAMP)
                    )
                    OR
                    -- Fallback to old logic if auction dates aren't set
                    (
                        (RFQ.ra_start_date IS NULL OR RFQ.ra_end_date IS NULL)
                        AND
                        (
                            (RFQ.bid_end_date IS NOT NULL AND RFQ.bid_end_date != ''
                            AND CAST(RFQ.bid_end_date AS TIMESTAMP) <= (CURRENT_TIMESTAMP + interval '1 days'))
                            OR
                            (RFQ.bid_end_date IS NULL OR RFQ.bid_end_date = ''
                            AND (CAST(RFQ.timestamp AS TIMESTAMP) + interval '1 days') <= CURRENT_TIMESTAMP)
                        )
                    )
                )
                ORDER BY TQI.total_price ASC  -- Get the lowest total_price
                LIMIT 1  -- Limit to the lowest price for that product and variant
            ) AS lowest_quotation,
            (
                WITH tech_eval AS (
                    SELECT TE.id AS tech_eval_id
                    FROM tbl_rfq_product_tech_evaluation TE
                    JOIN tbl_rfq_product_tech_evaluation_clauses TEC ON TE.id = TEC.tbl_rfq_product_tech_evaluation_id
                    WHERE TE.rfq_id = RFQ_P.rfq_id AND TE.tbl_rfq_product_id = RFQ_P.id
                    LIMIT 1
                )
                SELECT json_build_object(
                    'has_tech_eval', (SELECT COUNT(*) > 0 FROM tech_eval),
                    'is_accepted', (
                        SELECT COALESCE(
                            (SELECT status = 1
                              FROM tbl_rfq_product_tech_evaluation_cleared_vendors TECV
                              JOIN tech_eval TE ON TECV.tbl_rfq_product_tech_evaluation_id = TE.tech_eval_id
                              WHERE TECV.vendor_id = ${user_id}
                              LIMIT 1),
                            false
                        )
                    )
                )
            ) AS tech_evaluation_status
            `
            : ''
        }
        ${
          includeVendors
            ? `
          ,(
            SELECT json_agg(json_build_object('id', RFQ_P_V.id, 'user_id', RFQ_P_V.user_id, 'variant', RFQ_P_V.variant,
             'user_details', (
                  SELECT json_build_object(
                    'user_id', U.id,
                    'name', U.name,
                    'company_name', C.company_name,
                    'email', U.email,
                    'address', (
                      SELECT ARRAY_AGG(
                        json_build_object(
                          'address', TCL.address
                        )
                      )
                      FROM tbl_company_location TCL
                      WHERE TCL.company_id = U.company_id
                    ),
                    'mobile', U.mobile
                  )
                  FROM tbl_users U
                  JOIN tbl_company C ON U.company_id = C.id
                  WHERE RFQ_P_V.user_id = U.id
                )

              ))
            FROM tbl_rfq_product_vendors RFQ_P_V
            JOIN tbl_users U ON RFQ_P_V.user_id = U.id
            WHERE RFQ_P.product_variant_id = RFQ_P_V.product_variant_id 
              AND RFQ_P.rfq_id = RFQ_P_V.rfq_id 
              AND RFQ_P.variant = RFQ_P_V.variant
              AND U.status = 1
          ) AS vendor_details
          `
            : ''
        }
        ${
          user_type != 3
            ? `
        ,(
            SELECT COUNT(RFQ_P_V.id)
            FROM tbl_rfq_product_vendors RFQ_P_V
            JOIN tbl_users U ON RFQ_P_V.user_id = U.id
            WHERE RFQ_P.product_variant_id = RFQ_P_V.product_variant_id
              AND RFQ_P.rfq_id = RFQ_P_V.rfq_id
              AND RFQ_P.variant = RFQ_P_V.variant
              AND U.status = 1
        ) AS vendors_count
        `
            : ''
        }

    FROM
        tbl_rfq_products RFQ_P
        JOIN tbl_rfq RFQ ON RFQ.id = $1
        JOIN tbl_product_variant _TPV ON _TPV.id = RFQ_P.product_variant_id
        ${
          user_type != 2 && user_type != 8 && user_type != 9 && user_type != 10
            ? `JOIN tbl_rfq_product_vendors RPV 
            ON RPV.rfq_id = $1 
            AND RPV.product_variant_id = RFQ_P.product_variant_id 
            AND RPV.variant = RFQ_P.variant 
            AND RPV.user_id = $2`
            : ''
        }
    WHERE
        RFQ_P.rfq_id = $1
    ORDER BY
        RFQ_P.id;
  `;

    return new Promise(function (resolve, reject) {
      db.query(q, [id])
        .then(async function (data) {
          const products = await db.query(productQuery, [id, user_id]);
          if (data && products) {
            data[0].products = products;
          }
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  /**
   *
   * @last_changes - mukul 28-08-2025 without login senf 2 vendors details
   */
bulkSearchVendorsByCategory: async (
  category_id,
  approved_by_id = [],
  state = [],
  city = [],
  country = [],
  turnOver = null,
  vendorType = [],
  prevWorkedWith = null,
  vendor_name = '',
  myVendorType = null,
  productMakes = [],
  page = 1,
  limit = 20,
  user_id = null
) => {
  const offset = (page - 1) * limit;

  const turnoverCondition = turnOver && (turnOver.from > 0 || turnOver.to > 0)
    ? `AND tc.turnover IS NOT NULL AND TRIM(tc.turnover) != '' AND (
        ${turnOver.from > 0 && turnOver.to > 0
          ? `NULLIF(TRIM(tc.turnover), '')::bigint BETWEEN ${turnOver.from} AND ${turnOver.to}`
          : turnOver.from > 0
          ? `NULLIF(TRIM(tc.turnover), '')::bigint >= ${turnOver.from}`
          : `NULLIF(TRIM(tc.turnover), '')::bigint <= ${turnOver.to}`
        }
      )`
    : '';

  const myVendorCondition = myVendorType && user_id
    ? myVendorType.value === 'is_private'
      ? `AND EXISTS (
          SELECT 1 FROM tbl_buyer_private_vendors bpv
          WHERE bpv.vendor_id = tu.id AND bpv.buyer_id = ${user_id}
        )`
      : myVendorType.value === 'is_public'
      ? `AND NOT EXISTS (
          SELECT 1 FROM tbl_buyer_private_vendors bpv
          WHERE bpv.vendor_id = tu.id AND bpv.buyer_id = ${user_id}
        )`
      : ''
    : '';

  const prevWorkedCondition = prevWorkedWith && user_id
    ? prevWorkedWith === 'prev_finalized'
      ? `AND EXISTS (
          SELECT 1 FROM tbl_rfq_finalize_vendor rfv
          JOIN tbl_rfq r ON r.id = rfv.rfq_id
          WHERE rfv.vendor_id = tu.id AND r.user_id = ${user_id}
        )`
      : prevWorkedWith === 'rfq_sent'
      ? `AND EXISTS (
          SELECT 1 FROM tbl_rfq_product_vendors rpv
          JOIN tbl_rfq r ON r.id = rpv.rfq_id
          WHERE rpv.vendor_id = tu.id AND r.user_id = ${user_id}
        )`
      : ''
    : '';

  const vendorNameCondition = vendor_name
    ? `AND (
        LOWER(tu.name) LIKE LOWER('%${vendor_name.replace(/'/g, "''")}%')
        OR LOWER(COALESCE(tc.company_name, tu.organization_name)) LIKE LOWER('%${vendor_name.replace(/'/g, "''")}%')
      )`
    : '';

  const makeCondition = productMakes && productMakes.length > 0
    ? `AND EXISTS (
        SELECT 1 FROM tbl_product_variant_vendor_make pvvm
        WHERE pvvm.variant_vendor_map_id = pvm.id
        AND pvvm.make_id IN (${productMakes.map(m => m.id).join(',')})
      )`
    : '';

  const countQuery = `
    WITH vendor_data AS (
      SELECT DISTINCT tu.id
      FROM tbl_product_variant pvt
      JOIN tbl_product_variant_vendor_mapping pvm ON pvt.id = pvm.product_variant_id
      JOIN tbl_users tu ON tu.id = pvm.vendor_id AND tu.user_type IN (3,4)
      LEFT JOIN tbl_company tc ON tc.id = tu.company_id
      LEFT JOIN tbl_company_location tcl ON tc.id = tcl.company_id
      ${approved_by_id.length > 0 ? `
        JOIN tbl_vendorapprove_product_mapping vum ON vum.variant_vendor_mapping_id = pvm.id
      ` : ''}
      WHERE pvt.status = 1
        AND pvt.is_deleted = 0
        AND pvt.is_review = 0
        AND pvt.is_approve = 1
        AND pvm.status = TRUE
        AND pvm.is_approved = TRUE
        AND tu.is_deleted = 0
        AND tu.status = 1
        AND (tc.is_private = 0 OR tc.is_private IS NULL)
        AND pvt.product_id IN (
          SELECT product_id FROM tbl_product_categories WHERE category_id = ${category_id}
        )
        ${state.length > 0 ? `AND tcl.state_id::int IN (${state.map(s => s.id).join(',')})` : ''}
        ${city.length > 0 ? `AND tcl.city_id::int IN (${city.map(c => c.id).join(',')})` : ''}
        ${country.length > 0 ? `AND COALESCE(tcl.country_id, '1')::int IN (${country.map(c => c.id).join(',')})` : ''}
        ${turnoverCondition}
        ${vendorType.length > 0 ? `
          AND EXISTS (
            SELECT 1 FROM unnest(string_to_array(LOWER(tc.nature_of_business), ',')) AS nb
            WHERE TRIM(nb) IN (${vendorType.map(vt => `'${vt.value.toLowerCase().trim()}'`).join(', ')})
          )
        ` : ''}
        ${approved_by_id.length > 0 ? `
          AND vum.vendor_approve_id IN (${approved_by_id.map(vui => vui.id).join(',')})
        ` : ''}
        ${myVendorCondition}
        ${prevWorkedCondition}
        ${vendorNameCondition}
        ${makeCondition}
    )
    SELECT COUNT(*) AS total FROM vendor_data;
  `;

  const dataQuery = `
    WITH vendor_base AS (
      SELECT DISTINCT
        tu.id,
        tu.name AS vendor_name,
        tu.email,
        tu.mobile,
        COALESCE(tc.company_name, tu.organization_name, tu.name) AS organization_name,
        tc.profile AS about,
        tc.website,
        tc.company_name AS original_company_name,
        tc.turnover,
        tc.nature_of_business,
        tcl.address,
        tcl.postal_code,
        lc.id AS city_id,
        lc.city_name,
        ls.id AS state_id,
        ls.state_name,
        COALESCE(tcl.country_id, 1) AS country_id,
        lco.country_name
      FROM tbl_product_variant pvt
      JOIN tbl_product_variant_vendor_mapping pvm ON pvt.id = pvm.product_variant_id
      JOIN tbl_users tu ON tu.id = pvm.vendor_id AND tu.user_type IN (3,4)
      LEFT JOIN tbl_company tc ON tc.id = tu.company_id
      LEFT JOIN tbl_company_location tcl ON tc.id = tcl.company_id
      LEFT JOIN tbl_location_cities lc ON tcl.city_id = lc.id
      LEFT JOIN tbl_location_states ls ON tcl.state_id = ls.id
      LEFT JOIN tbl_location_country lco ON COALESCE(tcl.country_id, 1) = lco.id
      ${approved_by_id.length > 0 ? `
        JOIN tbl_vendorapprove_product_mapping vum ON vum.variant_vendor_mapping_id = pvm.id
      ` : ''}
      WHERE pvt.status = 1
        AND pvt.is_deleted = 0
        AND pvt.is_review = 0
        AND pvt.is_approve = 1
        AND pvm.status = TRUE
        AND pvm.is_approved = TRUE
        AND tu.is_deleted = 0
        AND tu.status = 1
        AND (tc.is_private = 0 OR tc.is_private IS NULL)
        AND pvt.product_id IN (
          SELECT product_id FROM tbl_product_categories WHERE category_id = ${category_id}
        )
        ${state.length > 0 ? `AND tcl.state_id::int IN (${state.map(s => s.id).join(',')})` : ''}
        ${city.length > 0 ? `AND tcl.city_id::int IN (${city.map(c => c.id).join(',')})` : ''}
        ${country.length > 0 ? `AND COALESCE(tcl.country_id, '1')::int IN (${country.map(c => c.id).join(',')})` : ''}
        ${turnoverCondition}
        ${vendorType.length > 0 ? `
          AND EXISTS (
            SELECT 1 FROM unnest(string_to_array(LOWER(tc.nature_of_business), ',')) AS nb
            WHERE TRIM(nb) IN (${vendorType.map(vt => `'${vt.value.toLowerCase().trim()}'`).join(', ')})
          )
        ` : ''}
        ${approved_by_id.length > 0 ? `
          AND vum.vendor_approve_id IN (${approved_by_id.map(vui => vui.id).join(',')})
        ` : ''}
        ${myVendorCondition}
        ${prevWorkedCondition}
        ${vendorNameCondition}
        ${makeCondition}
    )
    SELECT
      id,
      vendor_name,
      email,
      mobile,
      organization_name,
      about,
      website,
      original_company_name,
      turnover,
      nature_of_business,
      jsonb_agg(DISTINCT jsonb_build_object(
        'address', address,
        'postal_code', postal_code,
        'city_id', city_id,
        'city_name', city_name,
        'state_id', state_id,
        'state_name', state_name,
        'country_id', country_id,
        'country_name', country_name
      )) AS location
    FROM vendor_base
    GROUP BY
      id, vendor_name, email, mobile,
      organization_name, about, website,
      original_company_name, turnover, nature_of_business
    ORDER BY vendor_name ASC
    LIMIT ${limit} OFFSET ${offset};
  `;

  try {
    const [countResult, dataResult] = await Promise.all([
      db.query(countQuery),
      db.query(dataQuery)
    ]);

    return {
      total: parseInt(countResult[0]?.total || 0),
      data: dataResult || [],
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(parseInt(countResult[0]?.total || 0) / parseInt(limit))
    };
  } catch (err) {
    console.error('Error in bulkSearchVendorsByCategory:', err);
    throw err;
  }
},

  
  searchVendorWithoutLogin: async (
    search_key,
    category_id,
    approved_by_id,
    state,
    city,
    country,
    turnOver,
    vendorType,
    prevWorkedWith
  ) => {
    // query changes by mukul jatav 30-08-2024 - include city and state name in response, left join of tbl_location_states and tbl_location_cities
    // mukul jatav 28/apr/2024 - product migration changes - added product_variant_vendor_mapping and replaced tbl_product with tbl_product_variant

    let countQuery = `
   WITH vendor_data AS (
   SELECT DISTINCT tu.id
   FROM tbl_product_variant pvt
   JOIN tbl_product_variant_vendor_mapping pvm 
        ON pvt.id = pvm.product_variant_id
   JOIN tbl_users tu 
        ON tu.id = pvm.vendor_id AND tu.user_type IN (3,4)
   LEFT JOIN tbl_company tc 
        ON tc.id = tu.company_id AND tc.is_private = 0
   LEFT JOIN tbl_company_location tcl
        ON tcl.company_id = tc.id
   ${approved_by_id != '' ? `
   JOIN tbl_vendorapprove_product_mapping vum 
        ON vum.variant_vendor_mapping_id = pvm.id` : ``}

   WHERE pvt.status = 1 
     AND pvt.is_deleted = 0 
     AND pvt.is_review = 0 
     AND pvt.is_approve = 1
     AND pvm.status = TRUE 
     AND pvm.is_approved = TRUE
     AND tu.is_deleted = 0 
     AND tu.status = 1
     AND pvt.name = '${search_key}'
     AND tc.is_private = 0

   ${state != '' ? `AND tcl.state_id IN (${state.map(s => s.id).join(',')})` : ``}
   ${city != '' ? `AND tcl.city_id IN (${city.map(c => c.id).join(',')})` : ``}
   ${country != '' ? `AND tcl.country_id IN (${country.map(c => c.id).join(',')})` : ``}

   ${category_id != '' ?
     `AND pvt.product_id IN (
          SELECT product_id FROM tbl_product_categories 
          WHERE category_id = ${category_id}
      )`
   : ``}

   ${approved_by_id != '' ? `
     AND vum.vendor_approve_id IN (${approved_by_id.map(v => v.id).join(',')})
   ` : ``}
)
SELECT COUNT(*) AS total FROM vendor_data;

    `;
    let turnoverCondition = '';

    if (turnOver && (turnOver.from > 0 || turnOver.to > 0)) {
      turnoverCondition = `AND tc.turnover IS NOT NULL AND TRIM(tc.turnover) != '' AND (`;
      const turnoverField = `NULLIF(TRIM(tc.turnover), '')::bigint`;
      if (turnOver.from > 0 && turnOver.to > 0) {
        turnoverCondition += `${turnoverField} BETWEEN ${turnOver.from} AND ${turnOver.to}`;
      } else if (turnOver.from > 0) {
        turnoverCondition += `${turnoverField} >= ${turnOver.from}`;
      } else if (turnOver.to > 0) {
        turnoverCondition += `${turnoverField} <= ${turnOver.to}`;
      }
      turnoverCondition += ')';
    }

    let dataQuery = `WITH vendor_data AS (
   SELECT DISTINCT 
        tu.id,
        tu.name AS vendor_name,
        COALESCE(tc.company_name, tu.organization_name, tu.name) AS company_name,
        tcl.address,
        tc.profile AS about,
        tc.website,
        tc.company_name AS original_company_name,
        lc.city_name,
        ls.state_name

   FROM tbl_product_variant pvt
   JOIN tbl_product_variant_vendor_mapping pvm 
        ON pvt.id = pvm.product_variant_id
   JOIN tbl_users tu 
        ON tu.id = pvm.vendor_id 
       AND tu.user_type IN (3,4)
   LEFT JOIN tbl_company tc 
        ON tc.id = tu.company_id
   LEFT JOIN tbl_company_location tcl 
        ON tcl.company_id = tc.id
   LEFT JOIN tbl_location_cities lc 
        ON tcl.city_id = lc.id
   LEFT JOIN tbl_location_states ls 
        ON tcl.state_id = ls.id

   ${approved_by_id != '' ? `
   JOIN tbl_vendorapprove_product_mapping vum 
        ON vum.variant_vendor_mapping_id = pvm.id` : ``}

   WHERE pvt.status = 1 
     AND pvt.is_deleted = 0 
     AND pvt.is_review = 0 
     AND pvt.is_approve = 1
     AND pvm.status = TRUE 
     AND pvm.is_approved = TRUE
     AND tu.is_deleted = 0 
     AND tu.status = 1
     AND pvt.name = '${search_key}'
     AND tc.is_private = 0

   ${state != '' ? `AND tcl.state_id IN (${state.map(s => s.id).join(',')})` : ``}
   ${city != '' ? `AND tcl.city_id IN (${city.map(c => c.id).join(',')})` : ``}
   ${country != '' ? `AND tcl.country_id IN (${country.map(c => c.id).join(',')})` : ``}

   ${turnoverCondition}

   ${category_id != '' ?
     `AND pvt.product_id IN (
          SELECT product_id FROM tbl_product_categories 
          WHERE category_id = ${category_id}
      )`
   : ``}

   ${vendorType.length > 0 ? `
     AND EXISTS (
        SELECT 1
        FROM unnest(string_to_array(LOWER(tc.nature_of_business), ',')) AS nb
        WHERE TRIM(nb) IN (${vendorType
           .map(vt => `'${vt.value.toLowerCase().trim()}'`)
           .join(', ')})
     )
   ` : ``}

   ${approved_by_id != '' ? `
     AND vum.vendor_approve_id IN (${approved_by_id.map(v => v.id).join(',')})
   ` : ``}
)
SELECT * 
FROM vendor_data 
ORDER BY RANDOM() 
LIMIT 2;
`;

    try {
      const countResult = await db.query(countQuery);
      console.log('countQueery', countQuery);
      const totalCount = countResult[0].total;
      
      const dataResult = await db.query(dataQuery);
      console.log('dataQuwry', dataQuery);
      return {
        total: totalCount,
        vendor: dataResult.length > 0 ? dataResult : null
      };
    } catch (err) {
      console.error('Error in searchVendor:', err);
      throw new Error(err);
    }
  },
  getUserProducts: async (rfq_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select DISTINCT product_variant_id AS product_id, variant from tbl_rfq_product_vendors where rfq_id = $1 AND user_id=$2`,
        [rfq_id, user_id]
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
  getAllBuyerRfq: async (
    limit,
    offset,
    user_id,
    project_id,
    sort,
    reverse_auction,
    rfq_type,
    rfq_no
  ) => {
    return new Promise(function (resolve, reject) {
      let q = `
        SELECT
          RFQ.*,
          P.name AS project_name, -- Fetch project_name using project_id from tbl_projects
          (SELECT COUNT(*)
          FROM tbl_query_messages TQM
          WHERE TQM.receiver_id = ${user_id}
          AND TQM.rfq_id = RFQ.id
          AND TQM.is_seen = false
          ) AS "unseen_query_count",
          (
            SELECT
              CASE
                WHEN COUNT(*) = 0 THEN false
                ELSE
                  (
                    SELECT COUNT(*) 
                      FROM tbl_rfq_products _rpv 
                      WHERE _rpv.rfq_id = RFQ.id
                  ) = (
                    SELECT COUNT(*)
                      FROM tbl_quote_finalization tqf2
                      WHERE tqf2.rfq_id = RFQ.id
                  )
              END
            FROM tbl_quotes tq
            WHERE tq.rfq_id = RFQ.id
          ) AS is_finalized,
          ARRAY(
              SELECT json_build_object('id', TQ.id)
              FROM tbl_quotes TQ
              WHERE TQ.rfq_id = RFQ.id
          ) AS "quotes",
          ARRAY(
            SELECT json_build_object(
              'total_vendors', COUNT(DISTINCT TRPV.user_id),
              'quote_received',
              (
                SELECT COUNT(*) FROM (
                  SELECT
                    trpv.user_id
                  FROM
                    tbl_rfq_product_vendors trpv
                  LEFT JOIN tbl_quotes tq
                    ON trpv.rfq_id = tq.rfq_id AND trpv.user_id = tq.created_by
                  LEFT JOIN tbl_quote_items qi
                    ON trpv.product_variant_id = qi.product_variant_id 
                    AND trpv.variant = qi.variant
                    AND trpv.rfq_id = qi.rfq_id 
                    AND qi.quote_id = tq.id
                    AND (qi.unit_price > 0 OR (qi.comment IS NOT NULL AND qi.comment != '') OR (qi.delivery_period IS NOT NULL AND qi.delivery_period != '') OR EXISTS(SELECT 1 FROM tbl_quote_item_files qif WHERE qif.quote_item_id = qi.id))
                  WHERE
                    trpv.rfq_id = rfq.id
                  GROUP BY
                    trpv.user_id
                  HAVING
                    BOOL_OR(tq.is_regret = 1)
                    OR COUNT(DISTINCT trpv.id) = COUNT(DISTINCT qi.id)
                ) AS fully_quoted_vendors
              )
            )
            FROM tbl_rfq_product_vendors trpv
            WHERE trpv.rfq_id = rfq.id
            GROUP BY trpv.rfq_id
          ) AS "vendors",
          ARRAY(
              SELECT json_build_object(
                  'id', RFQ_P.id, 
                  'product_id', RFQ_P.product_variant_id,
                  'product_specs', (
                      SELECT json_agg(json_build_object(
                          'title', RFQ_P_SPEC.title, 
                          'value', RFQ_P_SPEC.value, 
                          'id', RFQ_P_SPEC.id, 
                          'product_id', RFQ_P_SPEC.product_variant_id, 
                          'rfq_id', RFQ_P_SPEC.rfq_id))
                      FROM tbl_rfq_products_specs RFQ_P_SPEC
                      WHERE RFQ_P.product_variant_id = RFQ_P_SPEC.product_variant_id 
                        AND RFQ_P.rfq_id = RFQ_P_SPEC.rfq_id 
                        AND RFQ_P.variant = RFQ_P_SPEC.variant
                  ),
                  'product_details', (
                      SELECT json_agg(json_build_object(
                          'id', T_P.id,
                          'name', T_P.name))
                      FROM tbl_product_variant T_P
                      WHERE RFQ_P.product_variant_id = T_P.id
                  ),
                  'vendor_details', (
                      SELECT json_agg(json_build_object(
                          'id', RFQ_P_V.id,
                          'user_id', RFQ_P_V.user_id,
                          'user_details', (
                              SELECT json_build_object(
                                  'user_id', U.id,
                                  'name', U.name,
                                  'email', U.email)
                              FROM tbl_users U
                              WHERE RFQ_P_V.user_id = U.id
                          )))
                      FROM tbl_rfq_product_vendors RFQ_P_V
                      WHERE RFQ_P.product_variant_id = RFQ_P_V.product_variant_id 
                        AND RFQ_P.rfq_id = RFQ_P_V.rfq_id 
                        AND RFQ_P.variant = RFQ_P_V.variant
                  )
              )
              FROM tbl_rfq_products RFQ_P
              WHERE RFQ.id = RFQ_P.rfq_id
          ) AS "products"
      FROM tbl_rfq RFQ
      LEFT JOIN tbl_projects P ON RFQ.project_id = P.id  -- Join on project_id to get project_name
      WHERE (RFQ.created_by = ${user_id} OR EXISTS (
      SELECT 1 FROM tbl_project_team PT WHERE PT.project_id = RFQ.project_id AND PT.user_id = ${user_id}
      )) AND RFQ.is_published = 1
      AND (RFQ.project_id = $1 OR $1 IS NULL)
      AND (RFQ.rfq_type = $2 OR $2 IS NULL)  -- Filter by rfq_type if provided
      AND (RFQ.reverse_auction = $3 OR $3 IS NULL)  -- Filter by reverse_auction if provided
      AND (RFQ.rfq_no::text LIKE '%$6%' OR $6 IS NULL) -- Filter by rfq_no if provided
      ORDER BY RFQ.timestamp ${sort ?? ''}
      LIMIT $5 OFFSET $4;`;

      db.any(q, [project_id, rfq_type, reverse_auction, offset, limit, rfq_no])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getBuyerRfqCount: async (
    user_id,
    project_id,
    rfq_type,
    reverse_auction,
    rfq_no
  ) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT COUNT(*) from tbl_rfq RFQ
        LEFT JOIN tbl_projects P ON RFQ.project_id = P.id  -- Join on project_id to get project_name
        WHERE (RFQ.created_by = ${user_id} OR EXISTS (
        SELECT 1 FROM tbl_project_team PT WHERE PT.project_id = RFQ.project_id AND PT.user_id = ${user_id}
        )) AND RFQ.is_published = 1
        AND (RFQ.project_id = $1 OR $1 IS NULL)
        AND (RFQ.rfq_type = $2 OR $2 IS NULL)  -- Filter by rfq_type if provided
        AND (RFQ.reverse_auction = $3 OR $3 IS NULL)  -- Filter by reverse_auction if provided
        AND (RFQ.rfq_no::text LIKE '%$4%' OR $4 IS NULL); -- Filter by rfq_no if provided
        `,
        [project_id, rfq_type, reverse_auction, rfq_no]
      )
        .then(function (data) {
          resolve(data[0].count);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendors: async (vendors, rfq_id = null) => {
    const placeholders = vendors.map((_, index) => `$${index + 1}`).join(', ');

    let query = `SELECT
      TU.id,
      TU.name,
      TU.email,
      TU.mobile,
      tcl.address,
      TU.organization_name,
      TC.company_name,
      ${rfq_id ? `COALESCE(MAX(TRPV.is_rfq_viewed), 0) AS is_rfq_viewed,` : ''}
      ARRAY(
        SELECT json_build_object('id', TPV.id, 'name', TPV.name)
        FROM tbl_product_variant_vendor_mapping PVVM
        JOIN tbl_product_variant TPV ON TPV.id = PVVM.product_variant_id
        WHERE PVVM.vendor_id = TU.id
      ) AS "products"
      FROM tbl_users TU
      JOIN tbl_company TC ON TU.company_id = TC.id
      JOIN tbl_company_location tcl ON TC.id = tcl.company_id
      ${
        rfq_id
          ? 'LEFT JOIN tbl_rfq_product_vendors TRPV ON TU.id = TRPV.user_id AND TRPV.rfq_id = ' +
            rfq_id
          : ''
      }
      WHERE TU.id IN (${placeholders})
      ${
        rfq_id
          ? 'GROUP BY TU.id, TU.name, TU.email, TU.mobile, tcl.address, TU.organization_name, TC.company_name'
          : ''
      }`;

    return new Promise(function (resolve, reject) {
      db.any(query, vendors)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendorsForProduct: async (
    productId,
    excludeArray = null,
    buyerId,
    searchTerm = null
  ) => {
    try {
      const buyer = await db.oneOrNone(
        'SELECT company_id FROM tbl_users WHERE id = $1',
        [buyerId]
      );
      if (!buyer || !buyer.company_id)
        throw new Error('Buyer not found or no company associated');
      const companyId = buyer.company_id;

      let q = `
      SELECT 
      DISTINCT
        U.id,
        U.name,
        U.email,
        U.mobile,
        CL.address,
        U.organization_name,
        C.company_name,
        ${
          searchTerm
            ? `similarity(COALESCE(C.company_name, U.organization_name), '${searchTerm}') AS similarity_score,`
            : ''
        }
        CASE
          WHEN bvm.vendor_id IS NOT NULL THEN 1
          ELSE 0
        END AS is_linked_with_buyer
  
        FROM tbl_product_variant_vendor_mapping PVVM
        JOIN tbl_product_variant PV ON PVVM.product_variant_id = PV.id
        JOIN tbl_users U ON PVVM.vendor_id = U.id
        JOIN tbl_company C ON C.id = U.company_id
        JOIN tbl_company_location CL ON C.id = CL.company_id
        LEFT JOIN tbl_buyer_private_vendors_mapping BVM ON U.id = BVM.vendor_id AND BVM.company_id = ${companyId}
  
        WHERE PVVM.product_variant_id = $1
        AND U.status = 1
        AND (PVVM.is_approved OR BVM.vendor_id IS NOT NULL)
        AND (C.is_private = 0 OR (C.is_private = 1 AND BVM.vendor_id IS NOT NULL))
        ${
          excludeArray && excludeArray.length > 0
            ? ` AND U.id NOT IN ($2:csv)`
            : ``
        }
        ${
          searchTerm
            ? `
          AND (
            to_tsvector('english', COALESCE(C.company_name, U.organization_name)) @@ plainto_tsquery('english', '${searchTerm}')
            OR (char_length('${searchTerm}') = 1 AND similarity(COALESCE(C.company_name, U.organization_name), '${searchTerm}') > 0)
            OR (char_length('${searchTerm}') > 1 AND similarity(COALESCE(C.company_name, U.organization_name), '${searchTerm}') > 0.1)
          )
        `
            : ''
        }

        ORDER BY ${
          searchTerm ? 'similarity_score DESC, ' : ''
        } is_linked_with_buyer DESC, C.company_name;
      `;

      const params = [productId];
      if (excludeArray && excludeArray.length > 0) {
        params.push(excludeArray);
      }

      return await db.any(q, params);
    } catch (error) {
      throw error;
    }
  },
 getVendorsByRfqProduct: async (rfq_product_id) => {
    try {
      let q = `
        SELECT 
          U.id,
          U.name,
          U.email,
          U.mobile,
          C.company_name,
          COALESCE(RPV.is_rfq_viewed, 0) AS is_rfq_viewed,
          (
            SELECT ARRAY_AGG(
              json_build_object(
                'address', CL.address,
                'country', CL.country_id,
                'state', CL.state_id,
                'city', CL.city_id,
                'postal_code', CL.postal_code
              )
            )
            FROM tbl_company_location CL
            WHERE CL.company_id = U.company_id
          ) AS addresses
        FROM tbl_rfq_products RP
        JOIN tbl_rfq_product_vendors RPV ON RP.rfq_id = RPV.rfq_id 
          AND RP.product_variant_id = RPV.product_variant_id 
          AND RP.variant = RPV.variant
        JOIN tbl_users U ON RPV.user_id = U.id
        JOIN tbl_company C ON U.company_id = C.id
        WHERE RP.id = $1
          AND U.status = 1
        GROUP BY U.id, U.name, U.email, U.mobile, C.company_name, RPV.is_rfq_viewed
        ORDER BY C.company_name
      `;

      return await db.any(q, [rfq_product_id]);
    } catch (error) {
      throw error;
    }
  },

  checkIfExists: async (table_name, parameter, db_con = db) => {
    const query = `SELECT * FROM ${table_name} WHERE ${parameter}`;

    return new Promise(function (resolve, reject) {
      db_con
        .any(query, [table_name])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getQuotesByRfqById: async (id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT TQA.*,
          ARRAY(
            SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,
                'vendor_details', (
                    SELECT json_agg(json_build_object('id', TU.id, 'name' , TU.name, 'email', TU.email,'mobile' , TU.mobile,'address' , TCL.address,'organization_name' , COALESCE(TCC.company_name, TU.organization_name, TU.name))) 
                    FROM tbl_users TU 
                    LEFT JOIN tbl_company TCC ON TCC.id = TU.company_id 
                    LEFT JOIN tbl_company_location TCL ON TCC.id = TCL.company_id
                    WHERE TU.id = TQ.created_by
                ),
                'products', (
                    SELECT json_agg(json_build_object('product_id', TQI.product_id,'product_name', TQI.product_name, 'unit_price', TQI.unit_price, 'package_price', TQI.package_price, 'tax', TQI.tax, 'freight_price', TQI.freight_price, 'total_price', TQI.total_price, 'comment', TQI.comment, 'delivery_period', TQI.delivery_period,
                    'rfq_details', (
                        SELECT json_agg(json_build_object('title' , TPS.title, 'value' , TPS.value)) FROM tbl_rfq_products_specs TPS WHERE TPS.product_id = TQI.product_id AND TPS.rfq_id = ${id}
                    )
                    )) FROM tbl_quote_items TQI WHERE CAST(TQ.id AS INTEGER) = TQI.quote_id
                )
            ) FROM tbl_quotes TQ WHERE TQ.rfq_id = ${id}
          ) AS "quotations"

          FROM tbl_quotes TQA WHERE rfq_id=${id}
          ORDER BY TQA.id DESC
          LIMIT 1;`
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
 getQuotesByRfqByIdByProduct: async (
    id,
    user_id,
    company_id,
    TA_Vendors,
    no_freight,
    rfq_product_id
  ) => {
    if(rfq_product_id) {
      rfq_product_id = rfq_product_id.split(",").map(Number);
    }

    return new Promise(function (resolve, reject) {
      const vendorCondition = `
        AND EXISTS (
            SELECT 1
            FROM tbl_rfq_product_tech_evaluation_cleared_vendors TECV
            JOIN tbl_rfq_product_tech_evaluation TEC ON TECV.tbl_rfq_product_tech_evaluation_id = TEC.id
            WHERE TEC.rfq_id = $1
                AND TEC.tbl_rfq_product_id = TRP.id
                AND TECV.vendor_id = TQ.created_by
                AND TECV.status = 1
        )`;

      const mainQuery = `SELECT TRP.product_variant_id, TRP.variant, TRP.rfq_id, TRP.id,
                      (
                        SELECT tptp.target_price 
                        FROM tbl_rfq_product_target_price tptp
                        WHERE tptp.tbl_rfq_product_id = TRP.id
                        ORDER BY tptp.created_at DESC
                        LIMIT 1
                    ) AS latest_target_price,
            (
                SELECT json_build_object(
                'unit_price', TQI1.unit_price,
                'package_price', TQI1.package_price,
                'tax', TQI1.tax,
                'freight_price', ${
                  no_freight === 'true' ? '0' : 'TQI1.freight_price'
                },
                'total_price', ${
                  no_freight === 'true'
                    ? 'ROUND((TQI1.unit_price * CAST(TQI1.quantity AS NUMERIC)) + ((TQI1.unit_price * CAST(TQI1.quantity AS NUMERIC)) * COALESCE(TQI1.package_price, 0) / 100) + (((TQI1.unit_price * CAST(TQI1.quantity AS NUMERIC)) + ((TQI1.unit_price * CAST(TQI1.quantity AS NUMERIC)) * COALESCE(TQI1.package_price, 0) / 100)) * COALESCE(TQI1.tax, 0) / 100))'
                    : 'TQI1.total_price'
                },
                'quantity', TQI1.quantity,
                'timestamp', TQF1.timestamp,
                'package_mode', TQI1.package_mode,
                'tax_mode', TQI1.tax_mode,
                'freight_mode', TQI1.freight_mode
                )
                FROM tbl_quote_items TQI1
                JOIN tbl_quote_finalization TQF1 ON TQI1.quote_id = TQF1.quote_id
                WHERE TQF1.created_by = $2
                AND TQI1.product_variant_id = TRP.product_variant_id
                AND TQF1.rfq_id != $1
                ORDER BY TQF1.timestamp DESC
                LIMIT 1
            ) AS "last_purchase_rate",
            (
              SELECT
                  json_build_object(
                    'unit_price', TQI.unit_price,
                    'package_price', TQI.package_price,
                    'tax', TQI.tax,
                    'freight_price', TQI.freight_price,
                    'freight_mode', TQI.freight_mode,
                    'package_mode', TQI.package_mode,
                    'tax_mode', TQI.tax_mode,
                    'total_price', TQI.total_price,
                    'quantity', TQI.quantity,
                    'product_name', TQI.product_name,
                    'rfq_no', TQI.rfq_no,
                    'timestamp', TQ.timestamp
                  )
              FROM tbl_rfq RFQ
                      JOIN tbl_quotes TQ ON RFQ.id = TQ.rfq_id
                      JOIN tbl_quote_items TQI ON TQ.id = TQI.quote_id
                      JOIN tbl_users U ON TQ.created_by = U.id
                      JOIN tbl_users BUYER ON BUYER.id = RFQ.created_by
              WHERE RFQ.created_by IN (SELECT id FROM tbl_users WHERE company_id = $3 AND user_type IN (2,8,10))
                AND TQI.product_variant_id = TRP.product_variant_id
                AND TQI.unit_price > 0
                AND RFQ.id != $1
              ORDER BY TQ.timestamp DESC
              LIMIT 1
          ) AS "last_quote_rate",
            ARRAY(
                SELECT json_build_object('name', PV.name,'description', TP.description) 
                FROM tbl_product_variant PV
                JOIN tbl_product TP ON TP.id = PV.product_id
                WHERE PV.id = TRP.product_variant_id 
            ) AS "product_details",
           ARRAY(
    SELECT json_build_object(
        'id', TU.id,
        'name', TU.name,
        'email', TU.email,
        'mobile', TU.mobile,
        -- 'address', TCL.address,
        'rfq_product_vendor_id', COALESCE(
          RPV_ALL.id,
          (
            SELECT rpv_fallback.id
            FROM tbl_rfq_product_vendors rpv_fallback
            WHERE rpv_fallback.rfq_id = TRP.rfq_id
              AND rpv_fallback.user_id = TU.id
              AND rpv_fallback.product_variant_id = TRP.product_variant_id
              AND COALESCE(rpv_fallback.variant, 0) = COALESCE(TRP.variant, 0)
            LIMIT 1
          )
        ),

        -- vendor-specific latest_target_price
        'latest_target_price', (
            SELECT tptp.target_price
            FROM tbl_rfq_product_target_price tptp
            WHERE tptp.tbl_rfq_product_id = TRP.id
              AND tptp.vendor_id = TU.id
            ORDER BY tptp.created_at DESC
            LIMIT 1
        ),

        -- added payment terms list
        'payment_terms',
            (
                SELECT COALESCE(
                    json_agg(
                        json_build_object(
                            'id', TQPT.id,
                            'type', TQPT.type,
                            'value', TQPT.value,
                            'days', TQPT.days,
                            'comment', TQPT.comment,
                            'timestamp', TQPT.timestamp,
                            'created_by', TQPT.created_by
                        )
                        ORDER BY TQPT.id
                    ),
                    '[]'::json
                )
                FROM tbl_quotes_payment_terms TQPT
                WHERE TQPT.quote_id = TQ.id
            ),

        'organization_name', COALESCE(TCC.company_name, TU.organization_name, TU.name),
        'global_payment_term', (
            SELECT json_agg(json_build_object('details', TQ_inner.global_payment_term,'comment', TQ_inner.global_comment))
            FROM tbl_quotes TQ_inner
            JOIN tbl_users TU_inner ON TU_inner.id = TQ_inner.created_by
            WHERE TQ_inner.rfq_id = TRP.rfq_id AND TQ_inner.created_by = TU.id
        ),
        'global_document_files', (
            SELECT json_agg(json_build_object('file_type', QF.file_type, 'file_url', QF.file_url))
            FROM tbl_quotes_files QF
            WHERE QF.quote_id = TQ.id
        ),
        'is_finalized', (CASE WHEN _TQF.id IS NOT NULL THEN TRUE ELSE FALSE END)
    )
    FROM tbl_quotes TQ
    JOIN tbl_users TU ON TU.id = TQ.created_by
    LEFT JOIN tbl_company TCC ON TCC.id = TU.company_id
    LEFT JOIN tbl_rfq_product_vendors RPV_ALL ON RPV_ALL.rfq_id = TRP.rfq_id 
        AND RPV_ALL.user_id = TU.id 
        AND RPV_ALL.product_variant_id = TRP.product_variant_id 
        AND COALESCE(RPV_ALL.variant, 0) = COALESCE(TRP.variant, 0)
    -- LEFT JOIN tbl_company_location TCL ON TCC.id = TCL.company_id
    LEFT JOIN tbl_quote_finalization _TQF 
        ON _TQF.rfq_id = $1 
       AND _TQF.vendor_id = TU.id 
       AND _TQF.product_variant_id = TRP.product_variant_id 
       AND _TQF.variant = TRP.variant 
    WHERE TQ.rfq_id = TRP.rfq_id
    ORDER BY TU.id ASC
) AS "all_vendors",

            ARRAY(
                SELECT json_build_object(
                    'id', TQ.id,
                    'timestamp', TQ.timestamp,
                    'status', TQ.status,
                    'created_by', TQ.created_by,
                    'is_regret', TQ.is_regret,
                    'regret_reason', TQ.regret_reason,
                    'global_payment_term', TQ.global_payment_term,
                    'global_comment', TQ.global_comment,

        'vendor_details', (
                        SELECT json_agg(json_build_object(
                            'id', TU.id,
                            'name', TU.name,
                            'email', TU.email,
                            'mobile', TU.mobile,
                            -- 'address', TCL.address,
                            'organization_name', COALESCE(TCC2.company_name, TU.organization_name, TU.name),
                            'rfq_product_vendor_id', COALESCE(
                              RPV.id,
                              (
                                SELECT rpv_fallback.id
                                FROM tbl_rfq_product_vendors rpv_fallback
                                WHERE rpv_fallback.rfq_id = TRP.rfq_id
                                  AND rpv_fallback.user_id = TU.id
                                  AND rpv_fallback.product_variant_id = TRP.product_variant_id
                                  AND COALESCE(rpv_fallback.variant, 0) = COALESCE(TRP.variant, 0)
                                LIMIT 1
                              )
                            ),
                            'is_finalized', (CASE WHEN _TQF.id IS NOT NULL THEN TRUE ELSE FALSE END),
                            'prev_worked', (SELECT 1
                                              FROM tbl_rfq_product_vendors rpv
                                              JOIN tbl_rfq rfq ON rfq.id = rpv.rfq_id
                                              WHERE rfq.id != $1 AND rfq.created_by = ${user_id} AND rfq.is_published = 1
                                                AND rpv.user_id = TU.id
                                              LIMIT 1
                                            )                            
                        ))
                        FROM tbl_users TU
                        LEFT JOIN tbl_company TCC2 ON TCC2.id = TU.company_id
                        -- LEFT JOIN tbl_company_location TCL ON TCC2.id = TCL.company_id
                        LEFT JOIN tbl_rfq_product_vendors RPV ON RPV.rfq_id = TRP.rfq_id 
                            AND RPV.user_id = TU.id 
                            AND RPV.product_variant_id = TRP.product_variant_id 
                            AND RPV.variant = TRP.variant
                        LEFT JOIN tbl_quote_finalization _TQF ON _TQF.rfq_id = $1 AND _TQF.vendor_id = TU.id AND _TQF.product_variant_id = TRP.product_variant_id AND _TQF.variant = TRP.variant
                        WHERE TU.id = TQ.created_by
                        ${TA_Vendors === 'TA' ? vendorCondition : ''}
                    ),
                    'quote_details', (
                        SELECT json_agg(json_build_object(
                            'product_id', TQI.product_variant_id,
                            'variant', TQI.variant,
                            'product_name', TQI.product_name,
                            'unit_price', TQI.unit_price,
                            'total_price', ${
                              no_freight === 'true'
                                ? 'ROUND((TQI.unit_price * CAST(TQI.quantity AS NUMERIC)) + ((TQI.unit_price * CAST(TQI.quantity AS NUMERIC)) * COALESCE(TQI.package_price, 0) / 100) + (((TQI.unit_price * CAST(TQI.quantity AS NUMERIC)) + ((TQI.unit_price * CAST(TQI.quantity AS NUMERIC)) * COALESCE(TQI.package_price, 0) / 100)) * COALESCE(TQI.tax, 0) / 100))'
                                : 'TQI.total_price'
                            },
                            'comment', TQI.comment,
                            'delivery_period', TQI.delivery_period,
                            'package_price', TQI.package_price,
                            'package_mode', TQI.package_mode,
                            'tax', TQI.tax,
                            'tax_mode', TQI.tax_mode,
                            'freight_price', ${
                              no_freight === 'true' ? '0' : 'TQI.freight_price'
                            },
                            'freight_mode', TQI.freight_mode,
                            'quantity', TQI.quantity,
                            'timestamp', TQ_inner.timestamp,
                            'document_files', (
                                SELECT json_agg(json_build_object('file_type', TF.file_type, 'file_url', TF.file_url))
                                FROM tbl_quote_item_files TF
                                WHERE TF.quote_item_id = TQI.id
                            ),
                            'rfq_details', (
                                SELECT json_agg(json_build_object('title', TPS.title, 'value', TPS.value))
                                FROM tbl_rfq_products_specs TPS 
                                WHERE TPS.product_variant_id = TQI.product_variant_id AND TPS.variant = TQI.variant AND TPS.rfq_id = TRP.rfq_id
                            )
                        ))
                        FROM tbl_quote_items TQI
                        JOIN tbl_quotes TQ_inner ON TQI.quote_id = TQ_inner.id
                        JOIN tbl_users TU_inner ON TU_inner.id = TQ_inner.created_by
                        WHERE TQI.quote_id = TQ.id AND TQI.product_variant_id = TRP.product_variant_id AND TQI.variant = TRP.variant
                        ${TA_Vendors === 'TA' ? vendorCondition : ''}
                    )
                )
                FROM tbl_quotes TQ
                JOIN tbl_users TU ON TU.id = TQ.created_by
                JOIN tbl_quote_items TQI ON TQI.quote_id = TQ.id 
                WHERE TQ.rfq_id = TRP.rfq_id AND 
                      TQI.product_variant_id = TRP.product_variant_id AND 
                      TQI.variant = TRP.variant 
                      ${TA_Vendors === 'TA' ? vendorCondition : ''}
                ORDER BY TQ.created_by ASC
            ) AS "quotations",
            ARRAY(
                SELECT json_build_object('title', TPS.title, 'value', TPS.value)
                FROM tbl_rfq_products_specs TPS
                WHERE TPS.product_variant_id = TRP.product_variant_id AND TPS.variant = TRP.variant AND TPS.rfq_id = TRP.rfq_id
            ) AS "product_specs"
            FROM tbl_rfq_products TRP WHERE TRP.rfq_id=$1
            ${rfq_product_id ? 'AND TRP.id = ANY($4)' : ''}`;

      db.query(mainQuery, [id, user_id, company_id, rfq_product_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getEstimatesData: async (persistent_id) => {
    try {
      const [persistentData, estimatesData] = await db.tx(async (t) => {
        let persistenceQuery = `
        SELECT * FROM tbl_rfq_persistent_jobs TQPJ
        WHERE TQPJ.id = $1 AND status IN ('completed', 'partially_completed');
        `;
        const persistentData = await t.one(persistenceQuery, [persistent_id]);

        let estimateQuery = `
         SELECT * FROM tbl_quote_estimates TQE
         WHERE TQE.id = $1
        `;

        const estimateData = await t.one(estimateQuery, [
          persistentData.persisted_rfq_id
        ]);

        let estimateItemsQuery = `
          SELECT TQEI.*, TPV.name AS product_name FROM tbl_quote_estimates_item TQEI
          JOIN tbl_product_variant TPV ON TQEI.product_variant_id = TPV.id
          WHERE TQEI.quote_estimates_id = $1
        `;

        const items = await t.any(estimateItemsQuery, [estimateData.id]);

        return [persistentData, { estimates: estimateData, items }];
      });

      return {
        persistent: persistentData,
        estimates: estimatesData
      };
    } catch (error) {
      throw error;
    }
  },

  getEstimateQuotes: async (product_variant_id) => {
    try {
      let q = `
        SELECT *
          FROM (
                  SELECT
                      MIN(unit_price) AS lowest_price,
                      ROUND(AVG(unit_price)::numeric, 2) AS average_price,
                      MAX(unit_price) AS highest_price
                  FROM tbl_quote_items
                  WHERE product_variant_id = $1
                  AND unit_price > 0
              ) t
          WHERE t.lowest_price IS NOT NULL
            OR t.average_price IS NOT NULL
            OR t.highest_price IS NOT NULL;
      `;

      const res = db.oneOrNone(q, [product_variant_id]);
      return res;
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  getQuotesByRfqById2: async (
    id,
    user_id,
    company_id,
    TA_Vendors,
    no_freight,
    rfq_product_id
  ) => {
    if(rfq_product_id) {
      rfq_product_id = rfq_product_id.split(",").map(Number);
    }

    return new Promise(function (resolve, reject) {
      const vendorCondition = `
      AND EXISTS (
        SELECT 1
        FROM tbl_quotes TQ
        JOIN tbl_rfq_product_tech_evaluation_cleared_vendors TECV ON TQ.created_by = TECV.vendor_id
        JOIN tbl_rfq_product_tech_evaluation TEC ON TECV.tbl_rfq_product_tech_evaluation_id = TEC.id
        WHERE TEC.rfq_id = $1
          AND TEC.tbl_rfq_product_id = TRF.id
          AND TQ.id = TQI.quote_id
          AND TECV.status = 1
      )`;

      let mainQuery = `SELECT TRF.*,
          ARRAY(
            SELECT json_build_object(
              'rfq_no', TR.rfq_no,
              'response_email', TR.response_email,
              'contact_name', TR.contact_name,
              'contact_number', TR.contact_number,
              'project_id', TR.project_id,
              'status', TR.status
            )
            FROM tbl_rfq TR
            WHERE TR.id = $1
          ) AS "rfq",
          ARRAY(
          SELECT json_build_object(
            'quote_id', TQFH.quote_id,
            'product_variant_id', TQFH.product_variant_id,
            'variant', TQFH.variant,
            'vendor_id', TQFH.vendor_id,
            'vendor_name', TU.organization_name,
            'changed_by', _TU.name,
            'finalized_at', TQFH.timestamp,
            'changed_at', TQFH.changed_at,
            'quote_info', json_build_object(
              'unit_price', TQI.unit_price,
              'package_price', TQI.package_price,
              'tax', TQI.tax,
              'freight_price', TQI.freight_price,
              'freight_mode', TQI.freight_mode,
              'package_mode', TQI.package_mode,
              'tax_mode', TQI.tax_mode,
              'total_price', TQI.total_price
            )
          )
          FROM tbl_quote_finalization_history TQFH
          JOIN tbl_quote_items TQI
            ON TQI.quote_id = TQFH.quote_id
            AND TQI.product_variant_id = TQFH.product_variant_id
            AND TQI.variant = TQFH.variant
          JOIN tbl_users TU
            ON TU.id = TQFH.vendor_id
          JOIN tbl_users _TU
            ON _TU.id = TQFH.changed_by
          WHERE TQFH.rfq_id = TRF.rfq_id 
            AND TQFH.product_variant_id = TRF.product_variant_id 
            AND TQFH.variant = TRF.variant
          ORDER BY TQFH.changed_at DESC
        ) AS "finalization_history",
        (
          SELECT json_build_object(
           'unit_price', TQI1.unit_price,
            'package_price', TQI1.package_price,
            'tax', TQI1.tax,
            'freight_price', TQI1.freight_price,
            'total_price', TQI1.total_price,
            'quantity', TQI1.quantity,
            'timestamp', TQF1.timestamp
          )
          FROM tbl_quote_items TQI1
          JOIN tbl_quote_finalization TQF1 ON TQI1.quote_id = TQF1.quote_id
          WHERE TQF1.created_by IN (SELECT id FROM tbl_users WHERE company_id = (SELECT company_id FROM tbl_users WHERE id = $2) AND user_type IN (2,8,10))
            AND TQI1.product_variant_id = TRF.product_variant_id
            AND TQF1.rfq_id != $1 -- different RFQ
          ORDER BY TQF1.timestamp DESC
          LIMIT 1
        ) AS "last_purchase_rate"
          ,
        (
          SELECT
              json_build_object(
                'unit_price', TQI.unit_price,
                'package_price', TQI.package_price,
                'tax', TQI.tax,
                'freight_price', TQI.freight_price,
                'freight_mode', TQI.freight_mode,
                'package_mode', TQI.package_mode,
                'tax_mode', TQI.tax_mode,
                'total_price', TQI.total_price,
                'quantity', TQI.quantity,
                'product_name', TQI.product_name,
                'rfq_no', TQI.rfq_no,
                'timestamp', TQ.timestamp
              )
              FROM tbl_rfq RFQ
              JOIN tbl_quotes TQ ON RFQ.id = TQ.rfq_id
              JOIN tbl_quote_items TQI ON TQ.id = TQI.quote_id
            WHERE RFQ.created_by IN (SELECT id FROM tbl_users WHERE company_id = $3 AND user_type IN (2,8,10))
            AND TQI.product_variant_id = TRF.product_variant_id
            AND TQI.unit_price > 0
            AND RFQ.id != $1
          ORDER BY TQ.timestamp DESC
          LIMIT 1
        ) AS "last_quote_rate",
          ARRAY(
            SELECT json_build_object(
              'product_name', TV.name,
              'rfq_details', (
                SELECT json_agg(
                  json_build_object(
                    'title', TPS.title,
                    'value', TPS.value
                  )
                )
                FROM tbl_rfq_products_specs TPS
                WHERE TPS.product_variant_id = TRF.product_variant_id
                  AND TPS.variant = TRF.variant
                  AND TPS.rfq_id = $1
              )
            )
            FROM tbl_product_variant TV
            JOIN tbl_product TP ON TP.id = TV.product_id
            WHERE TV.id = TRF.product_variant_id
          ) AS "product_details",
          ARRAY(
            SELECT json_build_object(
              'quote_item_id', TQI.id,
              'quote_id', TQI.quote_id,
              'unit_price', TQI.unit_price,
              'package_price', TQI.package_price,
              'package_mode', TQI.package_mode,
              'tax', TQI.tax,
              'tax_mode', TQI.tax_mode,
              'freight_price', ${
                no_freight === 'true' ? '0' : 'TQI.freight_price'
              },
              'freight_mode', TQI.freight_mode,
              'total_price', ${
                no_freight === 'true'
                  ? 'ROUND((TQI.unit_price * CAST(TQI.quantity AS NUMERIC)) + ((TQI.unit_price * CAST(TQI.quantity AS NUMERIC)) * COALESCE(TQI.package_price, 0) / 100) + (((TQI.unit_price * CAST(TQI.quantity AS NUMERIC)) + ((TQI.unit_price * CAST(TQI.quantity AS NUMERIC)) * COALESCE(TQI.package_price, 0) / 100)) * COALESCE(TQI.tax, 0) / 100))'
                  : 'TQI.total_price'
              },
              'comment', TQI.comment,
              'delivery_period', TQI.delivery_period,
              'quantity', TQI.quantity,
              'finalization', (
                SELECT json_build_object(
                  'id', TQF.id,
                  'product_id', TQF.product_variant_id,
                  'timestamp', TQF.timestamp,

                  'finilized_by', (
                      SELECT json_build_object(
                        'name', TU.name,
                        'email', TU.email,
                        'mobile', TU.mobile
                      )
                      FROM tbl_users TU
                      WHERE TU.id = TQF.created_by
                    ),

                  'winning_vendor', (
                    SELECT json_build_object(
                      'id', TUU.id,
                      'name', TUU.name,
                      'company_name', TC.company_name,
                      'email', TUU.email,
                      'mobile', TUU.mobile,
                      -- 'address', TCL.address,
                      'organization_name', TUU.organization_name
                    )
                    FROM tbl_users TUU
                    JOIN tbl_company TC ON TUU.company_id = TC.id
                    -- JOIN tbl_company_location TCL ON TC.id = TCL.company_id
                    WHERE TUU.id = TQF.vendor_id
                    LIMIT 1
                  )
                )
                FROM tbl_quote_finalization TQF
                WHERE TQF.quote_id = TQI.quote_id
                  AND TQF.product_variant_id = TQI.product_variant_id
                  AND TQF.variant = TQI.variant
              ),
              'quote_details', (
                SELECT json_build_object(
                  'status', TQ_INNER.status,
                  'created_by', TQ_INNER.created_by,
                  'is_regret', TQ_INNER.is_regret,
                  'regret_reason', TQ_INNER.regret_reason,
                  'timestamp', TQ_INNER.timestamp,
                  'latest_target_price', (
                    SELECT tptp.target_price
                    FROM tbl_rfq_product_target_price tptp
                    WHERE tptp.tbl_rfq_product_id = TRF.id 
                      AND tptp.vendor_id = TQ_INNER.created_by
                    ORDER BY tptp.created_at DESC
                    LIMIT 1
                  ),
                  'vendor_details', (
                    SELECT json_build_object(
                      'id', TU.id,
                      'name', TU.name,
                      'email', TU.email,
                      'mobile', TU.mobile,
                      -- 'address', TCL3.address,
                      'organization_name', COALESCE(TCC3.company_name, TU.organization_name, TU.name),
                      'rfq_product_vendor_id', (
                        SELECT rpv.id
                        FROM tbl_rfq_product_vendors rpv
                        WHERE rpv.rfq_id = $1
                          AND rpv.user_id = TU.id
                          AND rpv.product_variant_id = TQI.product_variant_id
                          AND COALESCE(rpv.variant, 0) = COALESCE(TQI.variant, 0)
                        LIMIT 1
                      ),
                      'prev_worked', (SELECT 1
                                        FROM tbl_rfq_product_vendors rpv
                                        JOIN tbl_rfq rfq ON rfq.id = rpv.rfq_id
                                        WHERE rfq.id != $1 AND rfq.created_by = $2 AND rfq.is_published = 1
                                          AND rpv.user_id = TU.id
                                        LIMIT 1
                                      )
                    )
                    FROM tbl_users TU
                    LEFT JOIN tbl_company TCC3 ON TCC3.id = TU.company_id
                    -- LEFT JOIN tbl_company_location TCL3 ON TCC3.id = TCL3.company_id
                    WHERE TU.id = TQ_INNER.created_by
                    LIMIT 1
                  )
                )
                FROM tbl_quotes TQ_INNER
                WHERE TQ_INNER.id = TQI.quote_id
                  AND TQ_INNER.rfq_id = $1
              ),
                'document_files', (
                SELECT json_agg(json_build_object('file_type', QIF.file_type, 'file_url', QIF.file_url))
                FROM tbl_quote_item_files QIF
                WHERE QIF.quote_item_id = TQI.id
              ),
              'global_document_files', (
                SELECT json_agg(json_build_object('file_type', TF.file_type, 'file_url', TF.file_url))
                FROM tbl_quotes_files TF
                WHERE TF.quote_id = TQI.quote_id
              ),
              'global_payment_term', TQ.global_payment_term,
              'global_comment', TQ.global_comment,
              
              -- payment term list
               'payment_terms',
               (
                 SELECT COALESCE(
                   json_agg(
                     json_build_object(
                       'id', TQPT.id,
                       'type', TQPT.type,
                       'value', TQPT.value,
                       'days', TQPT.days,
                       'comment', TQPT.comment,
                       'timestamp', TQPT.timestamp,
                       'created_by', TQPT.created_by
                     )
                     ORDER BY TQPT.id
                   ),
                   '[]'::json
                 )
                 FROM tbl_quotes_payment_terms TQPT
                 WHERE TQPT.quote_id = TQ.id
               ),
              'previous_quotes', (
                SELECT json_agg(json_build_object(
                    'id', TH.id,
                    'quote_item_id', TH.quote_item_id,
                    'rfq_id', TH.rfq_id,
                    'product_id', TH.product_variant_id,
                    'unit_price', TH.unit_price,
                    'package_price', TH.package_price,
                    'tax', TH.tax,
                    'freight_price', ${
                      no_freight === 'true' ? '0' : 'TH.freight_price'
                    },
                    'freight_mode', TH.freight_mode,
                    'package_mode', TH.package_mode,
                    'tax_mode', TH.tax_mode,
                    'total_price', ${
                      no_freight === 'true'
                        ? 'ROUND((TH.unit_price * CAST(TH.quantity AS NUMERIC)) + ((TH.unit_price * CAST(TH.quantity AS NUMERIC)) * COALESCE(TH.package_price, 0) / 100) + (((TH.unit_price * CAST(TH.quantity AS NUMERIC)) + ((TH.unit_price * CAST(TH.quantity AS NUMERIC)) * COALESCE(TH.package_price, 0) / 100)) * COALESCE(TH.tax, 0) / 100))'
                        : 'TH.total_price'
                    },
                    'comment', TH.comment,
                    'delivery_period', TH.delivery_period,
                    'quantity', TH.quantity,
                    'variant', TH.variant,
                    'timestamp', TH.timestamp
                ))
                FROM (
                  SELECT *
                  FROM tbl_quote_item_history TH
                  WHERE TH.quote_item_id = TQI.id
                  ORDER BY TH.timestamp DESC
                ) TH
              )
            )
            FROM tbl_quote_items TQI
            JOIN tbl_quotes TQ ON TQI.quote_id = TQ.id
            WHERE TQI.rfq_id = $1
              AND TQI.product_variant_id = TRF.product_variant_id
              AND TQI.variant = TRF.variant              
              ${TA_Vendors === 'TA' ? vendorCondition : ''}
          ) AS "quotations"
        FROM tbl_rfq_products TRF
        WHERE TRF.rfq_id = $1
        ${rfq_product_id ? `AND TRF.id = ANY($4)` : ''}
        ;`;

      db.query(mainQuery, [id, user_id, company_id, rfq_product_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  changeRFQStatus: async (id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `UPDATE tbl_rfq
        SET status = ${parseInt(2)}, updated_by = ${user_id}
        WHERE id=$1 RETURNING *`,
        [id]
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
  gerRFQVendors: async (id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT DISTINCT  user_id FROM "tbl_rfq_product_vendors" WHERE "rfq_id" = $1;`,
        [id]
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
  getRfqVendorListAlongWithSPOC: async (rfq_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT
          u.id AS user_id,
          u.name AS user_name,
          u.email AS user_email,
          u.mobile AS user_mobile,
          COALESCE(
              JSON_AGG(
                  JSONB_BUILD_OBJECT(
                      'spoc_id', s.id,
                      'spoc_name', s.name,
                      'spoc_email', s.email,
                      'spoc_mobile', s.mobile,
                      'spoc_role', s.role
                  )
              ) FILTER (WHERE s.id IS NOT NULL),
              '[]'
              ) AS spocs
              FROM tbl_users u
              INNER JOIN tbl_rfq_product_vendors v ON u.id = v.user_id
              LEFT JOIN tbl_users_spoc s ON u.id = s.user_id AND (s.is_deleted IS NULL OR s.is_deleted = 0)
              WHERE v.rfq_id = $1
              GROUP BY u.id, u.name, u.email, u.mobile;
              `,
        [rfq_id]
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
  quoteVendor: async (id) => {
    return new Promise(function (resolve, reject) {
      db.query(`SELECT created_by  FROM "tbl_quotes" WHERE "rfq_id" = $1`, [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendorProductsCount: async (rfq_id, vendor_id) => {
    try {
      const q = `
      SELECT
        rpv.product_variant_id,
        rpv.variant,
        pv.name,
        COUNT(rpv.id)
      FROM
        tbl_rfq_product_vendors rpv
      JOIN
        tbl_product_variant pv ON pv.id = rpv.product_variant_id
      JOIN  
        tbl_product p ON p.id = pv.product_id
      WHERE
        rpv.rfq_id = $1
        AND rpv.user_id = $2
      GROUP BY
        rpv.product_variant_id, rpv.variant, pv.name;
      `;

      return await db.query(q, [rfq_id, vendor_id]);
    } catch (e) {
      throw e;
    }
  },
  getVendorProductsQuoted: async (rfq_id, vendor_id) => {
    try {
      const q = `
        SELECT
          qi.product_variant_id,
          pv.name AS variant_name,
          p.name AS product_name,
          qi.unit_price,
          COUNT(qi.id)
        FROM
          tbl_quotes q
        JOIN
          tbl_quote_items qi ON q.id = qi.quote_id
        JOIN
          tbl_product_variant pv ON pv.id = qi.product_variant_id
        JOIN
          tbl_product p ON p.id = pv.product_id
        WHERE
          qi.rfq_id = $1
          AND q.created_by = $2
          AND (qi.unit_price > 0 OR (qi.comment IS NOT NULL AND qi.comment != '') OR (qi.delivery_period IS NOT NULL AND qi.delivery_period != '') OR EXISTS(SELECT 1 FROM tbl_quote_item_files qif WHERE qif.quote_item_id = qi.id))
        GROUP BY
          qi.product_variant_id, qi.variant, p.name, pv.name, qi.unit_price;
    `;

      return await db.query(q, [rfq_id, vendor_id]);
    } catch (e) {
      throw e;
    }
  },
  getRFQCreatedBy: async (id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT tbl_users.id, tbl_users.name,tbl_users.email,tbl_users.mobile,tbl_users.organization_name
        FROM tbl_rfq
        LEFT JOIN tbl_users ON tbl_rfq.created_by = tbl_users.id
        WHERE tbl_rfq.id = $1;`,
        [id]
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
  getRFQDetails: async (id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT RFQ.*
        FROM tbl_rfq RFQ
        WHERE RFQ.id = $1;`,
        [id]
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
  // function created by Imtiaj for getting RFQ activity 20/09/2024
  // 1. change by mukul 29-11-2024,
  // 2. valid date tghis model accept = new Date('2024-11-28').toISOString().slice(0, 10);  // Format, YYYY-MM-DD
  // This model filters reminders for a specific date if provided, or returns the full list if no date is specified.
  getRFQActivity: async (rfq_id, user_id, date = null) => {
    try {
      const query = `
        SELECT *
        FROM tbl_rfq_activity
        WHERE rfq_id = $1 AND user_id = $2
      ${date ? 'AND DATE(created_at) = $3' : ''};
      `;
      const params = [rfq_id, user_id, date];
      const result = await db.query(query, params);

      if (!result) {
        throw new Error(
          'Query did not return rows. Check your database or query logic.'
        );
      }

      return result; // Return the rows from the query
    } catch (error) {
      console.error('Error in getRFQActivity:', error);
      throw new Error(error);
    }
  },

  // function created by Imtiaj for updating RFQ activity 20/09/2024
  insertRFQActivity: async (rfq_id, user_id) => {
    try {
      //insert new rfq actiivity
      const insertQuery = `
        INSERT INTO tbl_rfq_activity (rfq_id, user_id)
        VALUES ($1, $2)
        RETURNING *;
      `;
      await db.query(insertQuery, [rfq_id, user_id]);
    } catch (error) {
      throw new Error(error);
    }
  },

  searchProduct: async (
    search_key,
    category_id,
    approved_by_id,
    locationFilters = {}
  ) => {
    // query change by mukul 28-08-2024
    // query change by mukul 08-09-2024, added one more filter for created by 1 or 111 to exclude product for them
    // Changes by Agnij: Modified to support slug-based search for better SEO and URL structure

    // Check if search_key looks like a slug (no spaces and either contains hyphens or is a single word)
    const isSlugSearch =
      search_key &&
      !search_key.includes(' ') &&
      (search_key.includes('-') || search_key.length > 0);

    let q = `
      SELECT DISTINCT p.id AS product_id,
                      p.name AS product_name,
                      CONCAT(pv.name, ' - ', p.name) AS unified_name,
                      pv.id AS variant_id,
                      pv.name AS variant_name,
                      p.description,
                      pv.slug AS slug,
                      c.title AS category_name,
                      c.id AS category_id,
                      c.parent_id AS parent_category_id,
                      img.new_image_name AS image_url,
                      similarity(CONCAT(pv.name, ' - ', p.name), $1) AS similarity_score,
                      ts_rank_cd(to_tsvector('english', CONCAT(pv.name, ' - ', p.name)), plainto_tsquery('english', $1)) AS rank
      FROM tbl_product_variant pv
      JOIN tbl_product_variant_vendor_mapping pvvm ON pvvm.product_variant_id = pv.id AND pvvm.status = TRUE AND pvvm.is_approved = TRUE
      JOIN tbl_users u ON u.id = pvvm.vendor_id
        ${
          locationFilters.country_id
            ? `AND u.country::int = ${locationFilters.country_id}`
            : ''
        }
        ${
          locationFilters.state_id
            ? `AND u.state::int = ${locationFilters.state_id}`
            : ''
        }
        ${
          locationFilters.city_id
            ? `AND u.city::int = ${locationFilters.city_id}`
            : ''
        }
      JOIN tbl_product p ON pv.product_id = p.id
      JOIN tbl_product_categories pc ON p.id = pc.product_id
      JOIN tbl_category c ON pc.category_id = c.id
      LEFT JOIN tbl_product_images img ON p.id = img.product_id
      ${
        approved_by_id
          ? `JOIN tbl_vendorapprove_product_mapping vum ON p.id = vum.product_id`
          : ``
      }
      WHERE p.status = 1
        AND p.is_deleted = 0
        AND p.is_review = 0
        AND p.is_approve = 1
        AND pv.is_approve = 1
        AND (
          pv.slug = $1
          OR to_tsvector('english', CONCAT(pv.name, ' - ', p.name)) @@ plainto_tsquery('english', $1)
          OR similarity(CONCAT(pv.name, ' - ', p.name), $1) > 0.1
        )
        ${category_id ? `AND c.id = $2` : ``}
        ${
          approved_by_id
            ? `AND (vum.vendor_approve_id = $3 OR vum.vendor_approve_id IS NULL)`
            : ``
        }
      ORDER BY rank DESC, similarity_score DESC, CONCAT(pv.name, ' - ', p.name) ASC ;
    `;

    console.log(' ===============================================  ');
    console.log(q);
    console.log(' ===============================================  ');

    // Assuming db.query can handle parameterized queries:
    return new Promise(function (resolve, reject) {
      db.query(
        q,
        [
          search_key,
          category_id,
          approved_by_id,
          locationFilters.country_id,
          locationFilters.state_id,
          locationFilters.city_id
        ].filter(Boolean)
      ) // Filters out any undefined or empty values
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  // Location lookup functions removed - using cmsModel.findStateByName, cmsModel.findCityByNameAndState, cmsModel.findCountryByName instead

  getCategoryList: async (search_key) => {
    //   let q = `
    //  SELECT DISTINCT c.id AS category_id,
    //                   c.title AS category_name,
    //                   c.parent_id AS parent_category_id,
    //                   pc.title AS parent_category_name, -- Join to get parent category title
    //                   similarity(c.title, $1) AS similarity_score,
    //                   ts_rank_cd(to_tsvector('english', c.title), plainto_tsquery('english', $1)) AS rank
    //   FROM tbl_category c
    //   LEFT JOIN tbl_category pc ON c.parent_id = pc.id -- Join to get parent category details
    //   WHERE c.status = 1
    //     AND c.is_deleted = 0
    //     AND (
    //       to_tsvector('english', c.title) @@ plainto_tsquery('english', $1)
    //       OR similarity(c.title, $1) > 0.1
    //     )
    //   ORDER BY rank DESC, similarity_score DESC, c.title ASC;`;

    const q = `
    SELECT DISTINCT c.id AS category_id,
                    c.title AS category_name,
                    c.parent_id AS parent_category_id,
                    pc.title AS parent_category_name,
                    similarity(c.title, $1) AS similarity_score,
                    ts_rank_cd(to_tsvector('english', c.title), plainto_tsquery('english', $1)) AS rank
    FROM tbl_category c
    LEFT JOIN tbl_category pc ON c.parent_id = pc.id
    INNER JOIN tbl_product_categories pcats ON c.id = pcats.category_id
    INNER JOIN tbl_product p ON pcats.product_id = p.id
    WHERE c.status = 1
      AND c.is_deleted = 0
      AND p.status = 1
      AND p.is_deleted = 0
      AND p.is_review = 0
      AND p.is_approve = 1
      AND p.created_by NOT IN (1, 111)
      -- Only apply search filtering when searchTerm is provided (not null or empty)
      AND (to_tsvector('english', c.title) @@ plainto_tsquery('english', $1)
          OR similarity(c.title, $1) > 0.1)
    ORDER BY rank DESC, similarity_score DESC, c.title ASC;
`;

    return new Promise(async function (resolve, reject) {
      try {
        const data = await db.query(q, [search_key]);
        resolve(data);
      } catch (err) {
        const error = new Error(err);
        reject(error);
      }
    });
  },
  getSubcategories: async (categoryIds) => {
    const q = `
WITH RECURSIVE category_tree AS (
    SELECT
        c.id,
        c.title,
        c.parent_id
    FROM tbl_category c
    WHERE c.id = $1
      AND EXISTS (  -- Ensure there are active products for this category
          SELECT 1
          FROM tbl_product p
          INNER JOIN tbl_product_categories pc ON p.id = pc.product_id
          WHERE pc.category_id = c.id
            AND p.status = 1
            AND p.is_deleted = 0
            AND p.is_review = 0
            AND p.is_approve = 1
            AND p.created_by NOT IN (1, 111)  -- Ensure product is linked to a valid vendor
      )
    UNION ALL
    -- Recursively find all child categories with active products and valid vendors
    SELECT
        c.id,
        c.title,
        c.parent_id
    FROM tbl_category c
    INNER JOIN category_tree ct ON c.parent_id = ct.id
    WHERE EXISTS (
        SELECT 1
        FROM tbl_product p
        INNER JOIN tbl_product_categories pc ON p.id = pc.product_id
        WHERE pc.category_id = c.id
          AND p.status = 1
          AND p.is_deleted = 0
          AND p.is_review = 0
          AND p.is_approve = 1
          AND p.created_by NOT IN (1, 111)
    )
)
-- Return id and title for all categories found in the recursive tree with active products and valid vendors
SELECT id, title FROM category_tree;
`;
    return new Promise(function (resolve, reject) {
      db.query(q, [categoryIds])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getProductsByCategories: async (categories) => {
    // Extract category IDs from the array of objects
    const categoryIds = categories.map((category) => category.id);

    const q = `
WITH RankedProducts AS (
    SELECT
        p.id AS product_id,
        p.name AS product_name,
        pv.id AS variant_id,
        pv.name AS variant_name,
        p.description,
        pv.slug,
        pc.category_name AS category_name,
        pc.category_id AS category_id,
        -- Generate a row number for each unique product name within each category,
        -- but also treat same product ID across categories as a single entry
        ROW_NUMBER() OVER (
            PARTITION BY pv.name, pc.category_id 
            ORDER BY pv.id
        ) AS row_num_by_name_category,
        ROW_NUMBER() OVER (
            PARTITION BY pv.id
            ORDER BY pc.category_id
        ) AS row_num_by_id
    FROM tbl_product_variant pv
    JOIN tbl_product p ON p.id = pv.product_id
    INNER JOIN tbl_product_categories pc ON p.id = pc.product_id
    WHERE pc.category_id IN ($1:csv)  -- Dynamically insert the list of category IDs
      AND p.status = 1 
      AND pv.status = 1
      AND p.is_deleted = 0 
      AND p.is_review = 0 
      AND p.is_approve = 1
      AND pv.is_approve = 1
)
SELECT 
    product_id, product_name, variant_id, variant_name, description, category_name, category_id, slug
FROM RankedProducts
WHERE row_num_by_name_category = 1
  AND row_num_by_id = 1;  -- Ensure unique products both by ID and by name/category combination
`;

    return new Promise(function (resolve, reject) {
      db.query(q, [categoryIds]) // Pass the category IDs array
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  // 25-05-2025 mukul jatav, product make added
  searchVendor: async (
    buyerId,
    search_key = '',
    category_id,
    approved_by_id,
    state,
    city,
    country,
    turnOver,
    vendorType,
    prevWorkedWith,
    vendor_name, // Added vendor_name parameter
    myVendorType,
    subscriptionType,
    responseKeys,
    productMakes
  ) => {
    // get company_id for this buyer
    const buyer = await db.oneOrNone(
      'SELECT company_id FROM tbl_users WHERE id = $1',
      [buyerId]
    );
    if (!buyer || !buyer.company_id)
      throw new Error('Buyer not found or no company associated');
    const companyId = buyer.company_id;

    // Convert location names to IDs if they are strings (optimized)
    let stateIds = [];
    let cityIds = [];
    let countryIds = [];

    if (state && Array.isArray(state) && state.length > 0) {
        // If state is array of objects with id property
        stateIds = state.map((s) => s.id);
    }

    if (city && Array.isArray(city) && city.length > 0) {
        // If city is array of objects with id property
        cityIds = city.map((c) => c.id);
    }

    if (country && Array.isArray(country) && country.length > 0) {
        // If country is array of objects with id property
        countryIds = country.map((c) => c.id);
    }

    // Adding dynamic turnover condition
    let turnoverCondition = '';

    turnOver = {
      from: parseInt(turnOver?.from ?? 0),
      to: parseInt(turnOver?.to ?? 0)
    };

    if (turnOver && (turnOver.from > 0 || turnOver.to > 0)) {
      turnoverCondition = `AND tc.turnover IS NOT NULL AND TRIM(tc.turnover) != '' AND (`;

      const turnoverField = `NULLIF(TRIM(tc.turnover), '')::bigint`;

      if (turnOver.from > 0 && turnOver.to > 0) {
        turnoverCondition += `${turnoverField} BETWEEN ${turnOver.from} AND ${turnOver.to}`;
      } else if (turnOver.from > 0) {
        turnoverCondition += `${turnoverField} >= ${turnOver.from}`;
      } else if (turnOver.to > 0) {
        turnoverCondition += `${turnoverField} <= ${turnOver.to}`;
      }

      turnoverCondition += ')';
    }

    search_key = search_key?.toLowerCase();

    let q = `
    SELECT *,
        json_build_object(
          'is_private', is_private,
          'is_linked_with_buyer', is_linked_with_buyer,
          'prev_finalized', prev_finalized,
          'rfq_added', rfq_added
        ) AS vendor_info
      FROM (
        SELECT DISTINCT ON (tu.id)
          tu.id AS ${responseKeys?.vendorId ?? 'id'},
          tu.name AS ${responseKeys?.vendorName ?? 'vendor_name'},
          ${
            vendor_name
              ? 'similarity(COALESCE(tc.company_name, tu.organization_name), $1) AS similarity_score,'
              : ''
          }
          tu.email,
          tu.mobile,
          COALESCE(tc.company_name, tu.organization_name) AS company_name,
          tcl.address,
          tc.profile AS about,
          tc.is_private,
          tc.website,
          tc.turnover,
          tc.nature_of_business,

          ARRAY(
            SELECT json_build_object(
              'address', tcl2.address,
              'postal_code', tcl2.postal_code,
              'city_id', tcl2.city_id,
              'city_name', lc.city_name,
              'state_id', tcl2.state_id,
              'state_name', ls.state_name,
              'country_id', tcl2.country_id,
              'country_name', lco.country_name
            )
            FROM tbl_company_location tcl2
            LEFT JOIN tbl_location_cities lc ON lc.id = tcl2.city_id
            LEFT JOIN tbl_location_states ls ON ls.id = tcl2.state_id
            LEFT JOIN tbl_location_country lco ON lco.id = tcl2.country_id
            WHERE tcl2.company_id = tc.id
          ) AS location,
          CASE
          WHEN tc.logo IS NULL THEN NULL
           ELSE tc.logo
           END AS image_url,
          CASE
            WHEN bvm.vendor_id IS NOT NULL THEN 1
            ELSE 0
          END AS is_linked_with_buyer,
          CASE
            WHEN qf.vendor_id IS NOT NULL THEN 1
            ELSE 0
          END AS prev_finalized,
          CASE
            WHEN rfqv.user_id IS NOT NULL THEN 1
            ELSE 0
          END AS rfq_added,
          COALESCE(sub_info.is_premium, 0) AS is_premium,
          RANDOM() AS group_rand
        FROM tbl_product_variant_vendor_mapping pvvm
        JOIN tbl_product_variant pv ON pvvm.product_variant_id = pv.id 
        JOIN tbl_product p ON p.id = pv.product_id
        JOIN tbl_product_categories pc ON p.id = pc.product_id
        JOIN tbl_category c ON pc.category_id = c.id
        JOIN tbl_users tu ON tu.id = pvvm.vendor_id AND tu.user_type IN (3, 4)
        LEFT JOIN tbl_company tc ON tc.id = tu.company_id
        LEFT JOIN tbl_company_location tcl on tc.id = tcl.company_id
        LEFT JOIN tbl_buyer_private_vendors_mapping bvm ON tu.id = bvm.vendor_id AND bvm.company_id = ${companyId}
        LEFT JOIN tbl_quote_finalization qf ON qf.vendor_id = tu.id AND qf.created_by = ${buyerId}
        LEFT JOIN (
          SELECT DISTINCT rpv.user_id
          FROM tbl_rfq_product_vendors rpv
          JOIN tbl_rfq rfq ON rfq.id = rpv.rfq_id
          WHERE rfq.created_by = ${buyerId} AND rfq.is_published = 1
        ) rfqv ON rfqv.user_id = tu.id
        LEFT JOIN (
          SELECT
            tus.user_id,
            MAX(tus.end_date) AS max_end_date,
            MAX(
              CASE
                WHEN tsp.plan_name ILIKE '%Enterprise%'
                  AND tus.status = 1
                  AND CURRENT_DATE BETWEEN tus.start_date AND tus.end_date
                  THEN 2
                WHEN tsp.plan_name ILIKE '%Premium%'
                  AND tus.status = 1
                  AND CURRENT_DATE BETWEEN tus.start_date AND tus.end_date
                  THEN 1
                ELSE 0
              END
            ) AS is_premium
          FROM tbl_user_subscriptions tus
          LEFT JOIN tbl_subscription_plans tsp ON tsp.id = tus.plan_id
          GROUP BY tus.user_id
        ) sub_info ON sub_info.user_id = tu.id

        ${
          approved_by_id != ''
            ? `
          JOIN tbl_vendorapprove_product_mapping vum 
            ON vum.variant_vendor_mapping_id = pvvm.id
        `
            : ``
        }

        WHERE p.status = 1 AND pv.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND pv.is_approve = 1 
          AND pvvm.status = TRUE AND pvvm.is_approved = TRUE
          AND tu.is_deleted = 0 AND tu.status = 1 
          ${
            category_id && category_id != ''
              ? `AND p.id IN (SELECT product_id FROM tbl_product_categories WHERE category_id = ${category_id})`
              : search_key && search_key != ''
              ? `AND pv.id IN (SELECT id FROM tbl_product_variant _pv WHERE LOWER(_pv.name) = LOWER('${search_key}'))`
              : ``
          }
          AND tu.email IS NOT NULL

          ${
            vendor_name != ''
              ? `
            AND (
              to_tsvector('english', COALESCE(tc.company_name, tu.organization_name)) @@ plainto_tsquery('english', $1)
              OR (char_length($1) = 1 AND similarity(COALESCE(tc.company_name, tu.organization_name), $1) > 0)
              OR (char_length($1) > 1 AND similarity(COALESCE(tc.company_name, tu.organization_name), $1) > 0.1)
            )
          `
              : ''
          }

          ${
            stateIds.length > 0
              ? `AND tcl.state_id::int IN (${stateIds.join(',')})`
              : ``
          }
          ${
            cityIds.length > 0
              ? `AND tcl.city_id::int IN (${cityIds.join(',')})`
              : ``
          }
          ${
            countryIds.length > 0
              ? `AND COALESCE(tcl.country_id, '1')::int IN (${countryIds.join(
                  ','
                )})`
              : ``
          }
          ${turnoverCondition}
          ${
            vendorType.length > 0
              ? `
            AND EXISTS (
              SELECT 1
              FROM unnest(string_to_array(LOWER(tc.nature_of_business), ',')) AS nb
              WHERE TRIM(nb) IN (${vendorType
                .map((vt) => `'${vt.value.toLowerCase().trim()}'`)
                .join(', ')})
            )
          `
              : ``
          }
          ${
            approved_by_id != ''
              ? `
            AND vum.vendor_approve_id IN (${approved_by_id
              .map((vui) => vui.id)
              .join(',')})
          `
              : ``
          }

          AND (tc.is_private = 0 OR (tc.is_private = 1 AND bvm.vendor_id IS NOT NULL))
          ${
            myVendorType == 'is_private'
              ? `AND tc.is_private = 1 AND bvm.vendor_id IS NOT NULL`
              : ``
          }
          ${
            myVendorType == 'is_public'
              ? `AND tc.is_private = 0 AND bvm.vendor_id IS NOT NULL`
              : ``
          }
          ${myVendorType == 'both' ? `AND bvm.vendor_id IS NOT NULL` : ``}

          ${subscriptionType ? subscriptionType == 'premium' ? 'AND is_premium = 1' : subscriptionType == 'enterprise' ? 'AND is_premium = 2' : 'AND is_premium = 0' : ''}

          ${prevWorkedWith === 'prev_finalized' ? `AND qf.id IS NOT NULL` : ``}
          ${prevWorkedWith === 'rfq_sent' ? `AND rfqv.user_id IS NOT NULL` : ``}

          ${
            productMakes && productMakes.length > 0
              ? `
          AND EXISTS (
            SELECT 1
            FROM tbl_product_variant_vendor_make pvmm
            WHERE pvmm.variant_vendor_map_id = pvvm.id
            AND LOWER(pvmm.make_name) IN (${productMakes
              .map((m) => `'${m.toLowerCase().trim()}'`)
              .join(', ')})
          )
        `
              : ``
          }
        
      ) AS distinct_vendors
      ORDER BY is_premium DESC, 
         ${vendor_name ? 'similarity_score DESC, group_rand' : 'group_rand'};
  `;

  console.log("QUERY SEARCH VENDOR:", q);

    const values = vendor_name ? [vendor_name] : [];
    return new Promise(function (resolve, reject) {
      db.query(q, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

 genericSearchVendors: async (
    buyerId,
    productId,
    productName,
    responseKeys
  ) => {
    // get company_id for this buyer
    const buyer = await db.oneOrNone(
      'SELECT company_id FROM tbl_users WHERE id = $1',
      [buyerId]
    );
    if (!buyer || !buyer.company_id)
      throw new Error('Buyer not found or no company associated');
    const companyId = buyer.company_id;

    productName = productName?.toLowerCase();

    let q = `
    SELECT *,
    json_build_object(
        'is_private', is_private,
        'is_linked_with_buyer', is_linked_with_buyer,
        'prev_finalized', prev_finalized,
        'rfq_added', rfq_added
    ) AS vendor_info
    FROM (
      SELECT DISTINCT ON (tu.id)
        tu.id AS ${responseKeys?.vendorId ?? 'id'},
        tu.name AS ${responseKeys?.vendorName ?? 'vendor_name'},
        tu.email,
        tu.mobile,
        COALESCE(tc.company_name, tu.organization_name) AS company_name,
        tcl.address,
        tc.is_private,
        tc.turnover,
        tc.nature_of_business,
        lc.city_name,
        ls.state_name,
        lcn.country_name,
        CASE
          WHEN bvm.vendor_id IS NOT NULL THEN 1
          ELSE 0
        END AS is_linked_with_buyer,
        CASE
          WHEN qf.vendor_id IS NOT NULL THEN 1
          ELSE 0
        END AS prev_finalized,
        CASE
          WHEN rfqv.user_id IS NOT NULL THEN 1
          ELSE 0
        END AS rfq_added
      FROM tbl_product_variant_vendor_mapping pvvm
      JOIN tbl_product_variant pv ON pvvm.product_variant_id = pv.id 
      JOIN tbl_product p ON p.id = pv.product_id
      JOIN tbl_product_categories pc ON p.id = pc.product_id
      JOIN tbl_category c ON pc.category_id = c.id
      JOIN tbl_users tu ON tu.id = pvvm.vendor_id AND tu.user_type IN (3, 4)
      LEFT JOIN tbl_company tc ON tc.id = tu.company_id
      LEFT JOIN tbl_company_location tcl on tc.id = tcl.company_id
      LEFT JOIN tbl_buyer_private_vendors_mapping bvm ON tu.id = bvm.vendor_id AND bvm.company_id = ${companyId}
      LEFT JOIN tbl_quote_finalization qf ON qf.vendor_id = tu.id AND qf.created_by = ${buyerId}
      LEFT JOIN (
        SELECT DISTINCT rpv.user_id
        FROM tbl_rfq_product_vendors rpv
        JOIN tbl_rfq rfq ON rfq.id = rpv.rfq_id
        WHERE rfq.created_by = ${buyerId} AND rfq.is_published = 1
      ) rfqv ON rfqv.user_id = tu.id
      LEFT JOIN tbl_location_cities lc ON tcl.city_id = lc.id
      LEFT JOIN tbl_location_states ls ON tcl.state_id = ls.id
      LEFT JOIN tbl_location_country lcn ON tcl.country_id = lcn.id

      WHERE p.status = 1 
        AND pv.status = 1 
        AND p.is_deleted = 0 
        AND p.is_review = 0 
        AND p.is_approve = 1 
        AND pv.is_approve = 1 
        AND (pvvm.is_approved = TRUE OR bvm.vendor_id IS NOT NULL)
        AND (tc.is_private = 0 OR (tc.is_private = 1 AND bvm.vendor_id IS NOT NULL))
        AND tu.is_deleted = 0 
        AND tu.status = 1 
        AND ${
          productId
            ? `pv.id = $1`
            : productName
            ? `LOWER(pv.name) = LOWER($1)`
            : `1=1`
        }
        AND tu.email IS NOT NULL

    ) AS distinct_vendors
    ORDER BY is_linked_with_buyer DESC, RANDOM();
`;

    const values = productId ? [productId] : [productName];

    return new Promise(function (resolve, reject) {
      db.query(q, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.log('ERROR: ', err);
          let error = new Error(err);
          reject(error);
        });
    });
  },

  searchVendorsByName: async (buyerId, vendor_name) => {
    const buyer = await db.oneOrNone(
      'SELECT company_id FROM tbl_users WHERE id = $1',
      [buyerId]
    );
    if (!buyer || !buyer.company_id)
      throw new Error('Buyer not found or no company associated');
    const companyId = buyer.company_id;

    console.log(' mukul  =>         ', buyer);

    let q = `
    SELECT *
    FROM (
        SELECT
            tu.id AS vendor_id,
            tu.name AS vendor_name,
            tu.email,
            tu.mobile,
            tc.company_name AS company_name,
            tcl.address,
            ${
              vendor_name
                ? "ts_rank_cd(to_tsvector('english', tc.company_name), plainto_tsquery('english', $1)) AS rank,"
                : ''
            }
            ${
              vendor_name
                ? 'word_similarity(lower(tc.company_name), lower($1)) as similarity_score,'
                : ''
            }
            ${
              vendor_name
                ? `CASE
                WHEN lower(tc.company_name) LIKE lower($1) || '%' THEN 1
                ELSE 0
            END AS starts_with_input,`
                : ''
            }
            ${
              vendor_name
                ? `CASE
              WHEN lower(tc.company_name) ~* ('(^|\\s)' || lower($1) || '(\\s|$)') THEN 1
              ELSE 0
            END AS exact_word_match,`
                : ''
            }
            ${
              vendor_name
                ? `CASE
              WHEN position(lower($1) in lower(tc.company_name)) > 0 THEN 1
              ELSE 0
            END AS partial_word_match,`
                : ''
            }
            CASE
                WHEN bvm.vendor_id IS NOT NULL THEN 1
                ELSE 0
            END AS is_linked_with_buyer
        FROM
            tbl_users tu
        LEFT JOIN
            tbl_company tc ON tc.id = tu.company_id
        LEFT JOIN
            tbl_company_location tcl on tc.id = tcl.company_id
        LEFT JOIN
            tbl_buyer_private_vendors_mapping bvm ON tu.id = bvm.vendor_id AND bvm.company_id = ${companyId}
        LEFT JOIN
            tbl_location_cities lc ON tcl.city_id = lc.id
        LEFT JOIN
            tbl_location_states ls ON tcl.state_id = ls.id
        WHERE
            tu.user_type = 3 -- Vendor user types
            AND tu.status = 1 -- Active vendors
            AND tu.is_deleted = 0 -- Not deleted vendors
            AND tu.email IS NOT NULL -- Vendors with email
            AND (
                tc.is_private = 0 -- Public vendors
                OR (tc.is_private = 1 AND bvm.vendor_id IS NOT NULL) -- Privately mapped vendors for this buyer
            )
            ${
              vendor_name
                ? `AND (
                to_tsvector('english', tc.company_name) @@ plainto_tsquery('english', $1)
                OR (char_length($1) = 1 AND similarity(tc.company_name, $1) > 0)
                OR (char_length($1) > 1 AND similarity(tc.company_name, $1) > 0.1)
            )`
                : ''
            }
    ) AS distinct_vendors
    ORDER BY
      is_linked_with_buyer DESC,
      ${vendor_name ? 'rank DESC,' : ''}
      ${vendor_name ? 'starts_with_input DESC,' : ''}
      ${vendor_name ? 'exact_word_match DESC,' : ''}
      ${vendor_name ? 'partial_word_match DESC,' : ''}
      ${vendor_name ? 'similarity_score DESC' : ''};
    `;

    const values = vendor_name ? [vendor_name] : [];

    console.log('   values ', values);

    return new Promise(function (resolve, reject) {
      db.query(q, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.log(' ---------------------------------  ');
          console.log(err);
          console.log(' ---------------------------------  ');
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getVendorApprovedBy: async (user_id) => {
    let q = `SELECT tbl_vendor_approve.id, tbl_vendor_approve.vendor_approve as vendor_approve
    FROM tbl_vendorapprove_user_mapping
    LEFT JOIN tbl_vendor_approve on tbl_vendor_approve.id = tbl_vendorapprove_user_mapping.vendor_approve_id
    WHERE user_id = ${user_id}`;

    return new Promise(function (resolve, reject) {
      db.query(q)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getPastRFQS: async (vendor_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT tbl_rfq.id,tbl_rfq.rfq_no, tbl_quote_finalization.rfq_id,tbl_quote_finalization.vendor_id,tbl_quote_finalization.product_variant_id, tbl_product_variant.name
        FROM tbl_rfq
        LEFT JOIN tbl_quote_finalization ON tbl_rfq.id = tbl_quote_finalization.rfq_id
        LEFT JOIN tbl_product_variant ON tbl_quote_finalization.product_variant_id = tbl_product_variant.id
        WHERE tbl_rfq.created_by = ${user_id} AND tbl_quote_finalization.vendor_id = $1;`,
        [vendor_id]
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
  saveStateCities: async (stateCityData) => {
    return new Promise(function (resolve, reject) {
      const statePromises = [];
      for (const stateName in stateCityData) {
        const stateQuery =
          'INSERT INTO tbl_location_states (state_name) VALUES ($1) RETURNING id';
        const statePromise = db
          .query(stateQuery, [stateName])
          .then(function (stateResult) {
            if (stateResult?.length > 0) {
              const stateId = stateResult[0].id;

              const cityPromises = stateCityData[stateName].map((cityName) => {
                const cityQuery =
                  'INSERT INTO tbl_location_cities (city_name, state_id) VALUES ($1, $2)';
                return db.query(cityQuery, [cityName, stateId]);
              });
              return Promise.all(cityPromises);
            }
          })
          .catch(function (err) {
            throw new Error(err);
          });
        statePromises.push(statePromise);
      }
      Promise.all(statePromises)
        .then(() => resolve(true))
        .catch((err) => reject(new Error(err)));
    });
  },
  checkVendorRFQResponsibility: async (rfq_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT * FROM "tbl_rfq_product_vendors" WHERE "rfq_id" = $1 AND "user_id" = $2`,
        [rfq_id, user_id]
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
  getAllRfq: async (active) => {
    let dynamicWhere = ``;
    if (active) {
      dynamicWhere = `AND status = 1`;
    }
    const query = `SELECT count(id) FROM tbl_rfq WHERE is_published = 1 ${dynamicWhere}`;
    return new Promise(function (resolve, reject) {
      db.one(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getAllVendorRfq: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT DISTINCT RPV.rfq_id FROM tbl_rfq_product_vendors RPV
        JOIN tbl_rfq RFQ ON RFQ.id = RPV.rfq_id
        WHERE RFQ.is_published = 1 AND user_id = $1`,
        [vendorId]
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
  getAllProducts: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT * FROM tbl_product WHERE created_by = $1 AND is_deleted = '0'  ORDER BY id DESC `,
        [vendorId]
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
  getAllPendingProducts: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT * FROM tbl_product WHERE created_by = $1 AND is_deleted = '0' AND is_review = '0'`,
        [vendorId]
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
  getAllReviewedProducts: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT * FROM tbl_product WHERE created_by = $1 AND is_deleted = '0' AND is_review = '1'`,
        [vendorId]
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
  getClosedRfqs: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT DISTINCT (rfq_id) FROM tbl_rfq_product_vendors
        left join tbl_rfq on tbl_rfq.id = tbl_rfq_product_vendors.rfq_id WHERE user_id = $1 and tbl_rfq.status = 2 and tbl_rfq.is_published = 1`,
        [vendorId]
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
  getPendingOrders: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.one(`SELECT count(id) FROM tbl_quotes WHERE created_by = $1`, [
        vendorId
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getRfqChartData: async (
    user_id,
    chartFilter,
    start_date,
    end_date,
    project_id
  ) => {
    const dateQ = ['past7days', 'currentMonth'].includes(chartFilter);
    const query = `
        WITH date_series AS (
            SELECT
                CASE
                    WHEN $5 THEN to_char(d, 'YYYY-MM')
                    ELSE to_char(d, 'YYYY-MM-DD')
                END AS period
            FROM generate_series(
                CASE
                    WHEN $5 THEN $3::timestamp + INTERVAL '1 day'
                    ELSE $3::timestamp
                END,
                $4::timestamp,
                CASE WHEN $5 THEN '1 month' ELSE '1 day' END::interval
            ) AS d
        ),
        rfq_data AS (
            SELECT
                CASE
                    WHEN $5 THEN to_char(tr.timestamp, 'YYYY-MM')
                    ELSE to_char(tr.timestamp, 'YYYY-MM-DD')
                END AS period,
                count(*) FILTER (WHERE tr.status = 1) AS new_rfqs,
                count(*) FILTER (
                    WHERE tr.status = 2
                    OR (
                        (tr.bid_end_date IS NOT NULL AND tr.bid_end_date != ''
                        AND DATE(tr.bid_end_date) < now())
                    )
                ) AS closed_rfqs,
                count(*) FILTER (
                    WHERE tr.status = 1
                    AND tr.id IN (
                        SELECT trp.rfq_id
                        FROM tbl_rfq_products trp
                        LEFT JOIN tbl_quote_finalization tqf 
                            ON trp.product_variant_id = tqf.product_variant_id
                            AND trp.variant = tqf.variant
                        GROUP BY trp.rfq_id
                        HAVING count(trp.product_variant_id) = count(tqf.product_variant_id)
                    )
                ) AS completed_rfqs
            FROM tbl_rfq tr
            WHERE tr.created_by = $1
                AND tr.is_published = 1
                AND ($6 IS NULL OR tr.project_id = $6)
            GROUP BY period
        ),
        quotes_data AS (
            SELECT
                CASE
                    WHEN $5 THEN to_char(tq.timestamp, 'YYYY-MM')
                    ELSE to_char(tq.timestamp, 'YYYY-MM-DD')
                END AS period,
                count(*) AS quotes_received
            FROM tbl_quotes tq
            WHERE EXISTS (
                SELECT 1 FROM tbl_rfq tr
                WHERE tq.rfq_id = tr.id
                    AND tr.created_by = $1
                    AND tr.is_published = 1
                    AND ($6 IS NULL OR tr.project_id = $6)
            )
            GROUP BY period
        )
        SELECT
            ds.period AS date,
            COALESCE(rd.new_rfqs, 0) AS new_rfqs,
            COALESCE(rd.closed_rfqs, 0) AS closed_rfqs,
            COALESCE(rd.completed_rfqs, 0) AS completed_rfqs,
            COALESCE(qd.quotes_received, 0) AS quotes_received
        FROM date_series ds
        LEFT JOIN rfq_data rd ON ds.period = rd.period
        LEFT JOIN quotes_data qd ON ds.period = qd.period
        ORDER BY ds.period;
    `;

    try {
      const formattedStartDate = new Date(start_date).toISOString();
      const formattedEndDate = new Date(end_date).toISOString();
      const values = [
        user_id,
        1,
        formattedStartDate,
        formattedEndDate,
        !dateQ,
        project_id
      ];

      const result = await db.query(query, values);
      return result;
    } catch (error) {
      throw new Error(error);
    }
  },
  getQuotesChartData: async (
    user_id,
    chartFilter,
    start_date,
    end_date,
    product_id,
    vendor_ids
  ) => {
    const dateQ = ['past7days', 'currentMonth'].includes(chartFilter);
    const query = `
        SELECT
            ${
              dateQ
                ? `DATE(tqf.timestamp) AS date,`
                : `TO_CHAR(tqf.timestamp, 'YYYY-MM') AS date,`
            }
            tc.company_name,
            tu.organization_name,
            tu.name,
            COUNT(tqf.id) AS data_value
        FROM tbl_quote_finalization tqf
        JOIN tbl_rfq tr
            ON tr.id = tqf.rfq_id
        JOIN tbl_company tc
            ON tqf.vendor_id = tc.user_id
        JOIN tbl_users tu
            ON tqf.vendor_id = tu.id
        WHERE tqf.timestamp BETWEEN $3::timestamp AND $4::timestamp
          AND tr.created_by = $1
          ${product_id ? `AND tqf.product_id = $5` : ``}
          ${vendor_ids ? `AND tqf.vendor_id = ANY($6)` : ``}
        ${
          dateQ
            ? `GROUP BY DATE(tqf.timestamp), tc.company_name, tu.organization_name, tu.name
              ORDER BY date;`
            : `GROUP BY TO_CHAR(tqf.timestamp, 'YYYY-MM'), tc.company_name, tu.organization_name, tu.name
              ORDER BY date;`
        }
    `;

    try {
      const formattedStartDate = new Date(start_date).toISOString();
      const formattedEndDate = new Date(end_date).toISOString();
      const values = [
        user_id,
        1,
        formattedStartDate,
        formattedEndDate,
        product_id,
        vendor_ids
      ];

      const result = await db.query(query, values);
      return result;
    } catch (error) {
      throw new Error(error);
    }
  },
  getQuoteCostingData: async (
    user_id,
    chartFilter,
    start_date,
    end_date,
    product_id,
    vendor_ids
  ) => {
    const dateQ = ['past7days', 'currentMonth'].includes(chartFilter);
    const query = `
        SELECT
            ${
              dateQ
                ? `DATE(tqf.timestamp) AS date,`
                : `TO_CHAR(tqf.timestamp, 'YYYY-MM') AS date,`
            }
            tc.company_name,
            tu.organization_name,
            tu.name,
            SUM(tqi.total_price) AS data_value
        FROM tbl_quote_finalization tqf
        JOIN tbl_quote_items tqi
          ON tqf.id = tqi.quote_id
        JOIN tbl_rfq tr
            ON tr.id = tqf.rfq_id
        JOIN tbl_company tc
            ON tqf.vendor_id = tc.user_id
        JOIN tbl_users tu
            ON tqf.vendor_id = tu.id
        WHERE tqf.timestamp BETWEEN $3::timestamp AND $4::timestamp
          AND tr.created_by = $1
          ${product_id ? `AND tqf.product_id = $5` : ``}
          ${vendor_ids ? `AND tqf.vendor_id = ANY($6)` : ``}
        ${
          dateQ
            ? `GROUP BY DATE(tqf.timestamp), tc.company_name, tu.organization_name, tu.name
              ORDER BY date;`
            : `GROUP BY TO_CHAR(tqf.timestamp, 'YYYY-MM'), tc.company_name, tu.organization_name, tu.name
              ORDER BY date;`
        }
    `;

    try {
      const formattedStartDate = new Date(start_date).toISOString();
      const formattedEndDate = new Date(end_date).toISOString();
      const values = [
        user_id,
        1,
        formattedStartDate,
        formattedEndDate,
        product_id,
        vendor_ids
      ];

      const result = await db.query(query, values);
      return result;
    } catch (error) {
      throw new Error(error);
    }
  },
  getAllRfqByUser: async (user_id, status = null) => {
    const query = `
      SELECT count(*)
      FROM tbl_rfq
      WHERE created_by = $1
        ${status ? `AND status = $2` : ``}
        ${
          status == 1
            ? `AND bid_end_date IS NOT NULL
            AND bid_end_date != ''
            AND DATE(bid_end_date) >= now()`
            : ``
        }
        AND is_published = 1
    `;

    try {
      let values = [user_id, status];

      const result = await db.one(query, values);
      return result;
    } catch (error) {
      throw new Error(error);
    }
  },
  getCompletedRfqs: async (user_id) => {
    const query = `
      SELECT count(*)
      FROM tbl_rfq tr
      WHERE tr.status = 1
        AND tr.created_by = $1
        AND tr.id IN (
          SELECT trp.rfq_id
          FROM tbl_rfq_products trp
          LEFT JOIN tbl_quote_finalization tqf
            ON trp.product_variant_id = tqf.product_variant_id
          AND trp.variant = tqf.variant
          GROUP BY trp.rfq_id
          HAVING count(trp.product_variant_id) = count(tqf.product_variant_id)
        );
    `;

    try {
      let values = [user_id];

      const result = await db.one(query, values);
      return result;
    } catch (error) {
      throw new Error(error);
    }
  },
  getClosedRfqs: async (user_id) => {
    const query = `
      SELECT count(*)
      FROM tbl_rfq tr
      WHERE tr.created_by = $1
        AND (
          tr.status = 2
          OR (
            tr.bid_end_date IS NOT NULL
            AND tr.bid_end_date != ''
            AND DATE(tr.bid_end_date) < now()
          )
        );
    `;

    try {
      let values = [user_id];

      const result = await db.one(query, values);
      return result;
    } catch (error) {
      throw new Error(error);
    }
  },
  getActiveQuotes: async (user_id, status) => {
    const query = `
      SELECT count(*) FROM tbl_rfq tr
         JOIN tbl_quotes tq on tr.id = tq.rfq_id
         WHERE tr.created_by = $1
          AND tr.status = $2
          AND tr.is_published = 1
          AND bid_end_date IS NOT NULL
            AND bid_end_date != ''
            AND DATE(bid_end_date) >= now()
    `;

    try {
      let values = [user_id, status];

      const result = await db.one(query, values);
      return result;
    } catch (error) {
      throw new Error(error);
    }
  },
  getAllProjects: async (user_id, isActive) => {
    const query = `
        SELECT COUNT(DISTINCT TR.project_id)
        FROM tbl_rfq TR
        JOIN tbl_projects TP
            ON TR.project_id = TP.id
        WHERE TR.created_by = $1
            AND TR.is_published = 1
            ${
              isActive
                ? `
            AND (
                TP.ended_at IS NULL
                OR TP.ended_at >= NOW()
            )`
                : ``
            }
    `;

    try {
      let values = [user_id];

      const result = await db.one(query, values);
      return result;
    } catch (error) {
      throw new Error(error);
    }
  },
  getVendorReviews: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT review_date,rating,description,name,email FROM "tbl_vendor_reviews" left join "tbl_users" on tbl_users.id = tbl_vendor_reviews.reviewed_by where reviewed_to = $1`,
        [vendorId]
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
  getAllRfqCost: async (user_id, status) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT  SUM(tbl_quote_items.total_price) AS total_sales , SUM(tbl_quote_items.total_price) ::NUMERIC AS total_price_formatted FROM tbl_rfq
LEFT JOIN tbl_quote_items ON tbl_rfq.rfq_no = tbl_quote_items.rfq_no
WHERE created_by = $1 AND status = $2  AND tbl_rfq.is_published = 1`,
        [user_id, status]
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
  getSubmittedQuotes: async (limit, user_id, status) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT rfq_no, timestamp FROM "tbl_quotes" where created_by = $1 ORDER BY id DESC LIMIT $2`,
        [user_id, limit]
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
  getRecentQuotes: async (user_id, status) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT  tr.id, tr.rfq_no , tq.timestamp as timestamp, tq.created_by, COALESCE(tc.company_name, tu.organization_name, tu.name) as organization_name, tu.name as vendor_name FROM "tbl_rfq" tr
      LEFT JOIN "tbl_quotes" tq ON tr.id = tq.rfq_id
      LEFT JOIN "tbl_users" tu ON tq.created_by = tu.id
      LEFT JOIN "tbl_company" tc ON tc.id = tu.company_id
      WHERE tr.created_by = $1 AND tr.status = '1' AND tr.is_published = 1 ORDER BY "id" DESC LIMIT 50`,
        [user_id]
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
  insertVendorRfqToken: async (vendorId, rfqNumber) => {
    // Function to generate a unique token as BIGINT
    const generateUniqueToken = () => {
      const timestamp = Date.now(); // Current timestamp in milliseconds
      const randomNumber = Math.floor(Math.random() * 1000000); // 6-digit random number
      return parseInt((timestamp + randomNumber).toString().substring(0, 16)); // Ensure it's a BIGINT
    };

    let token;
    let insertedData;

    // SQL query to insert the token and related data
    const query = `
      INSERT INTO tbl_vendor_rfq_tokens_non_login (token, vendor_id, rfq_no)
      VALUES ($1, $2, $3)
      RETURNING *`;

    while (true) {
      token = generateUniqueToken(); // Generate a unique token

      try {
        // Attempt to insert the token into the database
        insertedData = await db.any(query, [token, vendorId, rfqNumber]);
        break; // Exit the loop if insertion is successful
      } catch (err) {
        // Handle unique constraint violation
        if (err.code === '23505') {
          // PostgreSQL unique violation error code
          // Retry with a new token if there is a token collision
          continue;
        }
        // Throw other errors
        throw err;
      }
    }

    return token; // Return the successfully inserted token
  },
  getVendorRfqToken: async (vendorId, rfqNumber) => {
    // Ensure both parameters are valid integers
    const safeVendorId = parseInt(vendorId, 10);
    const safeRfqNumber = parseInt(rfqNumber, 10);

    // Validate parameters
    if (isNaN(safeVendorId) || isNaN(safeRfqNumber)) {
      console.error('Invalid parameters for getVendorRfqToken:', {
        vendorId,
        rfqNumber
      });
      return Promise.reject(
        new Error(
          `Invalid parameters: vendorId=${vendorId}, rfqNumber=${rfqNumber}`
        )
      );
    }

    console.log('Querying token with:', {
      vendorId: safeVendorId,
      rfqNumber: safeRfqNumber
    });

    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT token FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id = $1 AND rfq_no = $2;`,
        [safeVendorId, safeRfqNumber]
      )
        .then(function (data) {
          console.log('Token data:', data, safeVendorId, safeRfqNumber);
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateQuoteItemWithHistory: async (quoteId, product, quoteExists) => {
    return new Promise(async (resolve, reject) => {
      try {
        // For existing product or not
        const existingProductQuery = `SELECT * FROM tbl_quote_items WHERE quote_id = $1 AND product_variant_id = $2 AND variant = $3`;
        let existingProductWithNoChange = false;
        const existingProduct = await db.query(existingProductQuery, [
          quoteId,
          product.product_id,
          product.variant
        ]);
        if (existingProduct.length > 0) {
          existingProductWithNoChange = true;
        }

        // Fetch existing quote item only if there are differences in specified fields
        const existingItemQuery = `
      SELECT * FROM tbl_quote_items
      WHERE quote_id = $1 AND product_variant_id = $2 AND variant = $3
       AND (unit_price != $4 OR package_price != $5 OR tax != $6 OR freight_price != $7 OR total_price != $8 OR comment != $9 OR delivery_period != $10 OR freight_mode != $11 OR package_mode != $12 OR tax_mode != $13)
   `;
        const result = await db.query(existingItemQuery, [
          quoteId,
          product.product_id,
          product.variant,
          (product.unit_price =
            product.unit_price != '' ? product.unit_price : 0),
          product.package_price,
          product.tax,
          product.freight_price,
          product.total_price,
          product.comment,
          product.delivery_period,
          product.freight_mode,
          product.package_mode,
          product.tax_mode
        ]);
        const item = result[0];

        // In case when product is existing but there is a change in the product details.
        if (item) {
          console.log('COMING INSIDE NO CHANGE BLOCK');
          existingProductWithNoChange = false;
        }

        // we process all products with unitprices and having comment

        if (!existingProductWithNoChange) {
          console.log('COMING INSIDE CHANGE BLOCK');
          let updatedItem = [];
          if (item) {
            // Move existing quote to quote history table
            const insertHistoryQuery = `INSERT INTO tbl_quote_item_history 
          (quote_item_id, rfq_id, product_variant_id, unit_price, package_price, tax, freight_price, total_price,
           comment, delivery_period, quantity, variant, freight_mode, package_mode, tax_mode, timestamp)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`;
            await db.query(insertHistoryQuery, [
              item.id,
              item.rfq_id,
              item.product_variant_id,
              item.unit_price,
              item.package_price,
              item.tax,
              item.freight_price,
              item.total_price,
              item.comment,
              item.delivery_period,
              item.quantity,
              item.variant,
              item.freight_mode,
              item.package_mode,
              item.tax_mode
            ]);

            // Update existing item with new data
            const updateQuery = `UPDATE tbl_quote_items SET
          unit_price = $1, package_price = $2, tax = $3, freight_price = $4,
          total_price = $5, comment = $6, delivery_period = $7, 
          freight_mode = $8, package_mode = $9, tax_mode = $10
          WHERE id = $11 RETURNING *`;
            const productPrice =
              product.unit_price != '' ? product.unit_price : 0;
            updatedItem = await db.query(updateQuery, [
              productPrice,
              product.package_price,
              product.tax,
              product.freight_price,
              product.total_price,
              product.comment,
              product.delivery_period,
              product.freight_mode,
              product.package_mode,
              product.tax_mode,
              item.id
            ]);
          } else {
            // for the new product whose quotes are updating either with the given unit price
            // or with the given comments (unit price = 0)

            let quote_items_data = [
              {
                rfq_id: quoteExists.rfq_id,
                rfq_no: quoteExists.rfq_no,
                quote_id: parseInt(quoteId),
                product_variant_id: product.product_id,
                product_name: product.product_name,
                unit_price: product.unit_price,
                package_price: product.package_price,
                tax: product.tax,
                freight_price: product.freight_price,
                total_price: product.total_price,
                comment: product.comment,
                delivery_period: product.delivery_period,
                quantity: product.quantity,
                variant: product.variant,
                freight_mode: product.freight_mode,
                package_mode: product.package_mode,
                tax_mode: product.tax_mode
              }
            ];

            // From frontend the `unit_price` will never come as empty string now.
            if (
              (product.comment != '' || product.document_files?.length > 0) &&
              (product.unit_price == '' || product.unit_price == 0)
            ) {
              quote_items_data[0].unit_price = 0;
            }

            const quote_items_keys = [
              'rfq_id',
              'rfq_no',
              'quote_id',
              'product_variant_id',
              'product_name',
              'unit_price',
              'package_price',
              'tax',
              'freight_price',
              'total_price',
              'comment',
              'delivery_period',
              'quantity',
              'variant',
              'freight_mode',
              'package_mode',
              'tax_mode'
            ];

            let quotes_items = await rfqModel.insertArray(
              quote_items_data,
              quote_items_keys,
              'tbl_quote_items'
            );

            // New code to insert file links into tbl_quote_item_files
            if (quotes_items.length > 0) {
              quotes_items.forEach(async (item, index) => {
                const file_links = product.document_files;
                if (file_links && file_links.length > 0) {
                  const file_records = file_links.map((link) => ({
                    quote_item_id: item.id,
                    file_type: 'DOC',
                    file_url: link,
                    created_at: new Date()
                  }));
                  await rfqModel.insertArray(
                    file_records,
                    ['quote_item_id', 'file_type', 'file_url', 'created_at'],
                    'tbl_quote_item_files'
                  );
                }
              });
            }

            updatedItem = quotes_items;
          }

          // quote updated message
          resolve({
            quote: {
              product_name: updatedItem[0].product_name,
              product: updatedItem[0].variant
            },
            changed: true,
            message: 'Quote successfully updated with the latest changes.'
          });
        } else {
          // no need to make any changes
          resolve({
            quote: {
              product_name: product.product_name,
              product: product.variant
            },
            changed: false,
            message: 'No updates made as the quote remains unchanged'
          });
        }
      } catch (error) {
        console.error('Error in updateQuoteItemWithHistory:', error);
        reject(error);
      }
    });
  },

  getQuoteItem: async (quoteId, product) => {
    try {
      const existingItemQuery = `
        SELECT * FROM tbl_quote_items
        WHERE quote_id = $1 AND product_variant_id = $2 AND variant = $3`;

      const result = await db.query(existingItemQuery, [
        quoteId,
        product.product_id,
        product.variant
      ]);

      const item = result[0] || null;
      return item;
    } catch (error) {
      console.error('Get QuoteItem: ', error);
      throw error;
    }
  },

  productPriceStatsMarket: async (product_name) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `
        WITH GeneralStats AS (
          SELECT
              MIN(qi.unit_price) AS min_price,
              MAX(qi.unit_price) AS max_price,
              AVG(qi.unit_price) AS avg_price
          FROM tbl_product AS p
          JOIN tbl_quote_items AS qi ON p.id = qi.product_id
          JOIN tbl_quotes AS q ON qi.rfq_id = q.rfq_id
          WHERE p.name = $1
              AND q.timestamp >= NOW() - INTERVAL '1 year'
        ), MonthlyStats AS (
          SELECT
              EXTRACT(YEAR FROM q.timestamp) AS year,
              EXTRACT(MONTH FROM q.timestamp) AS month,
              MIN(qi.unit_price) AS min_price,
              AVG(qi.unit_price) AS avg_price,
              MAX(qi.unit_price) AS max_price
          FROM tbl_product AS p
          JOIN tbl_quote_items AS qi ON p.id = qi.product_id
          JOIN tbl_quotes AS q ON qi.rfq_id = q.rfq_id
          WHERE p.name = $1
              AND q.timestamp >= NOW() - INTERVAL '1 year'
          GROUP BY EXTRACT(YEAR FROM q.timestamp), EXTRACT(MONTH FROM q.timestamp)
          ORDER BY year, month
        )
        SELECT
          JSON_BUILD_OBJECT(
              'min', (SELECT min_price FROM GeneralStats),
              'max', (SELECT max_price FROM GeneralStats),
              'avg', (SELECT avg_price FROM GeneralStats)
          ) AS general,
          JSON_OBJECT_AGG(
              CAST(year AS TEXT) || '-' || LPAD(CAST(month AS TEXT), 2, '0'),
              JSON_BUILD_OBJECT('min', min_price, 'avg', avg_price, 'max', max_price)
          ) AS monthly
        FROM MonthlyStats;
    `,
        [product_name]
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

  productPriceStatsLastQuoteAndFinilizeForUser: async (
    product_name,
    user_id
  ) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `
      WITH BuyerRFQs AS (
        SELECT
            rfq.id AS rfq_id
        FROM tbl_rfq AS rfq
        WHERE rfq.created_by = $1  -- $1 is the buyer_id
      ), ProductDetails AS (
        SELECT
            p.id AS product_id
        FROM tbl_product AS p
        WHERE p.name = $2  -- $2 is the product_name
      ), LatestQuote AS (
        SELECT
            qi.quote_id,
            qi.product_id,
            qi.unit_price,
            q.timestamp
        FROM tbl_quote_items AS qi
        JOIN tbl_quotes AS q ON qi.quote_id = q.id
        JOIN BuyerRFQs br ON q.rfq_id = br.rfq_id
        JOIN ProductDetails pd ON qi.product_id = pd.product_id
        ORDER BY q.timestamp DESC
        LIMIT 1
      ), LatestFinalizedQuote AS (
        SELECT
            qi.quote_id,
            qi.product_id,
            qi.unit_price,
            q.timestamp
        FROM tbl_quote_finalization AS fq
        JOIN tbl_quotes AS q ON fq.quote_id = q.id
        JOIN tbl_quote_items AS qi ON qi.quote_id = fq.quote_id
        JOIN BuyerRFQs br ON q.rfq_id = br.rfq_id
        JOIN ProductDetails pd ON qi.product_id = pd.product_id
        WHERE fq.product_id = pd.product_id
        ORDER BY q.timestamp DESC
        LIMIT 1
      )
      SELECT
        'Latest Quote' AS quote_type,
        lq.quote_id,
        lq.product_id,
        lq.unit_price,
        lq.timestamp AS quote_timestamp
      FROM LatestQuote lq
      UNION ALL
      SELECT
        'Latest Finalized Quote' AS quote_type,
        lfq.quote_id,
        lfq.product_id,
        lfq.unit_price,
        lfq.timestamp AS quote_timestamp
      FROM LatestFinalizedQuote lfq;
  `,
        [user_id, product_name]
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

  project_access_checker: async (project_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT 1
        FROM tbl_projects p
        LEFT JOIN tbl_project_team t ON p.id = t.project_id
        WHERE p.id = $1
        AND (p.user_id = $2 OR t.user_id = $2)`,
        [project_id, user_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(new Error(err));
        });
    });
  },

  getVendorRfqCount: async (user_id) => {
    return new Promise((resolve, reject) => {
      db.one(
        `SELECT COUNT(DISTINCT v.rfq_id)
         FROM tbl_rfq_product_vendors v
         JOIN tbl_rfq r ON v.rfq_id = r.id
         WHERE v.user_id = $1 AND r.is_published = 1`, // Matching user_id in tbl_rfq_product_vendors
        [user_id]
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

  getAllRfqsForAdmin: async (
    limit,
    offset,
    rfqStatus,
    adminServiceStatus,
    sort,
    rfq_no,
    company
  ) => {
    return new Promise((resolve, reject) => {
      let dynamicQuery = '';
      const values = [rfqStatus, adminServiceStatus, sort, limit, offset];
      let paramIndex = 6;

      // Admin service status
      if (adminServiceStatus === 'Pending') {
        dynamicQuery += ` AND (ARS.status IS NULL OR ARS.status = 'Pending')`;
      } else if (adminServiceStatus) {
        dynamicQuery += ` AND ARS.status = $${paramIndex}`;
        values.push(adminServiceStatus);
        paramIndex++;
      }

      // RFQ number
      if (rfq_no) {
        dynamicQuery += ` AND RFQ.rfq_no = $${paramIndex}`;
        values.push(Number(rfq_no));
        paramIndex++;
      }

      // COMPANY FILTER — SAFE & PARAMETERIZED
      if (company && Array.isArray(company) && company.length > 0) {
        const placeholders = company.map((_, i) => `$${paramIndex + i}`).join(',');
        dynamicQuery += ` AND U.company_id IN (${placeholders})`;
        company.forEach(id => values.push(Number(id)));
        paramIndex += company.length;
      }

      const query = `
        SELECT
          RFQ.id,
          RFQ.rfq_no,
          RFQ.comment,
          RFQ.company_name,
          RFQ.response_email,
          RFQ.contact_name,
          RFQ.contact_number,
          RFQ.bid_end_date,
          RFQ.location,
          RFQ.is_published,
          RFQ.created_by,
          RFQ.updated_by,
          RFQ.timestamp,
          RFQ.status AS rfq_status,
          RFQ.rfq_type,
          RFQ.reverse_auction,
          P.id AS project_id,
          P.name AS project_name,
          (
            SELECT COUNT(*)
            FROM tbl_rfq_products RFQ_P
            WHERE RFQ_P.rfq_id = RFQ.id
          ) AS total_products,
          (
            SELECT json_build_object(
              'quotes_received', COUNT(DISTINCT TQ.created_by),
              'total_vendors', COUNT(DISTINCT TRPV.user_id)
            )
            FROM tbl_quotes TQ
            RIGHT JOIN tbl_rfq_product_vendors TRPV ON TRPV.rfq_id = TQ.rfq_id
            WHERE TRPV.rfq_id = RFQ.id
          ) AS stats,
          json_build_object(
            'id', ARS.id,
            'subadmin_id', ARS.subadmin_id,
            'status', ARS.status,
            'comment', ARS.comment
          ) AS admin_service
        FROM tbl_rfq RFQ
        LEFT JOIN tbl_projects P ON RFQ.project_id = P.id
        LEFT JOIN tbl_admin_rfq_service ARS ON RFQ.id = ARS.rfq_id
        LEFT JOIN tbl_users U ON RFQ.created_by = U.id
        WHERE
          RFQ.is_published = 1
          AND ($1::text IS NULL OR RFQ.status = $1)
          ${dynamicQuery}
        ORDER BY RFQ.timestamp ${sort === 'DESC' ? 'DESC' : 'ASC'}
        LIMIT $4 OFFSET $5
      `;

      db.any(query, values)
        .then(data => resolve(data))
        .catch(err => reject(err));
    });
  },


getAllClientsrfqsForAdmin: async (page = 1, limit = 10, search = '', dateFilter = 'all', startDate = '', endDate = '', companyIds = []) => {
  const offset = (page - 1) * limit;

  // Date filter logic
  let dateCondition = '';
  let queryParams = [];

  if (dateFilter === '3days') {
    dateCondition = `AND tr.timestamp >= NOW() - INTERVAL '3 days'`;
  } else if (dateFilter === '7days') {
    dateCondition = `AND tr.timestamp >= NOW() - INTERVAL '7 days'`;
  } else if (dateFilter === 'custom' && startDate && endDate) {
    queryParams.push(startDate, endDate);
    dateCondition = `AND tr.timestamp BETWEEN $${queryParams.length - 1} AND $${queryParams.length}`;
  }

  // Company filter logic
  let companyCondition = '';
  if (Array.isArray(companyIds) && companyIds.length > 0) {
    const placeholders = companyIds.map((_, i) => `$${queryParams.length + i + 1}`).join(', ');
    companyCondition = `AND tc.id IN (${placeholders})`;
    queryParams = [...queryParams, ...companyIds];
  }

  // Search condition
  let searchCondition = '';
  if (search) {
    queryParams.push(`%${search}%`);
    searchCondition = `AND (tc.company_name ILIKE $${queryParams.length} OR tr.rfq_no ILIKE $${queryParams.length})`;
  }

  // Base query
  const baseQuery = `
    WITH vendors AS (
      SELECT tr.id AS rfq_id, tr.status AS rfq_status, tr.rfq_type, COUNT(DISTINCT trpv.user_id) AS total_vendors
      FROM tbl_rfq tr
      LEFT JOIN tbl_rfq_product_vendors trpv ON trpv.rfq_id = tr.id
      GROUP BY tr.id
    ),
    quotes AS (
      SELECT 
        rfq_id,
        COUNT(DISTINCT CASE WHEN is_regret = 0 THEN created_by END) AS quotes_received,
        COUNT(DISTINCT CASE WHEN is_regret = 1 THEN created_by END) AS quote_regrets,
        COUNT(DISTINCT created_by) AS total_quotes
      FROM tbl_quotes
      GROUP BY rfq_id
    ),
    products AS (
      SELECT rfq_id, COUNT(DISTINCT id) AS products_added
      FROM tbl_rfq_products
      GROUP BY rfq_id
    ),
    finalizations AS (
      SELECT rfq_id, COUNT(DISTINCT product_variant_id) AS finalization_count
      FROM tbl_quote_finalization
      GROUP BY rfq_id
    )
    SELECT 
      tr.id as rfq_id,
      tc.company_name,
      tr.rfq_no,
      tr.timestamp,
      tr.status AS rfq_status,
      tr.rfq_type,
      v.total_vendors,
      q.quotes_received,
      q.quote_regrets,
      (v.total_vendors - COALESCE(q.total_quotes, 0)) AS vendors_not_responded,
      p.products_added,
      f.finalization_count
    FROM tbl_rfq tr
    JOIN tbl_users tu ON tu.id = tr.created_by
    JOIN tbl_company tc ON tc.id = tu.company_id
    LEFT JOIN vendors v ON v.rfq_id = tr.id
    LEFT JOIN quotes q ON q.rfq_id = tr.id
    LEFT JOIN products p ON p.rfq_id = tr.id
    LEFT JOIN finalizations f ON f.rfq_id = tr.id
    WHERE 1=1
     AND tr.is_published IN (1, 2) 
    ${dateCondition}
    ${companyCondition}
    ${searchCondition}
    ORDER BY tr.timestamp DESC
    LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
  `;

  const countQuery = `
    SELECT COUNT(*) AS total_count
    FROM tbl_rfq tr
    JOIN tbl_users tu ON tu.id = tr.created_by
    JOIN tbl_company tc ON tc.id = tu.company_id
    WHERE 1=1
     AND tr.is_published IN (1, 2)
    ${dateCondition}
    ${companyCondition}
    ${searchCondition}
  `;

  try {
    const [data, countResult] = await Promise.all([
      db.any(baseQuery, [...queryParams, limit, offset]),
      db.one(countQuery, queryParams)
    ]);

    const totalCount = parseInt(countResult.total_count);
    const totalPages = Math.ceil(totalCount / limit);

    return {
      data,
      pagination: {
        current_page: page,
        total_pages: totalPages,
        total_items: totalCount,
        items_per_page: limit,
        has_next: page < totalPages,
        has_prev: page > 1
      }
    };
  } catch (err) {
    throw new Error(err);
  }
},
// getVendorInfoPageForAdmin: async () => {
//   return new Promise((resolve, reject) => {
//     const query = `
//       SELECT 
//         u.id AS vendor_id,
//         u.name AS vendor_name,
//         CONCAT(u.email, ' / ', u.mobile) AS vendor_contact,
        
//         -- Total product count
//         COUNT(DISTINCT pvm.id) AS total_products,
        
//         -- PSU Approved (list of approvals)
//         va.psu_approved,
        
//         -- Product Make
//         pvvm.product_makes,
        
//         -- Total Inquiry Received (unique RFQs)
//         rpv_stats.inquiry_count AS total_inquiry_received,
        
//         -- Total Quote Sent
//         q_stats.quote_count AS total_quote_sent,
        
//         -- Response Rate
//         CASE 
//           WHEN rpv_stats.inquiry_count = 0 THEN '0%'
//           ELSE ROUND((q_stats.quote_count::decimal / NULLIF(rpv_stats.inquiry_count, 0)) * 100, 2) || '%'
//         END AS response_rate,
        
//         -- Joining Date
//         TO_CHAR(u.created_at, 'DD/MM/YYYY') AS joining_date,
        
//         -- Status
//         u.status,
        
//         -- Vendor Profile
//         'View' AS vendor_profile

//       FROM tbl_users u

//       -- Pre-aggregate vendor approvals
//       LEFT JOIN (
//           SELECT 
//               vaum.user_id,
//               STRING_AGG(DISTINCT va.vendor_approve, ', ') AS psu_approved
//           FROM tbl_vendorapprove_user_mapping vaum
//           INNER JOIN tbl_vendor_approve va ON va.id = vaum.vendor_approve_id
//           GROUP BY vaum.user_id
//       ) va ON va.user_id = u.id

//       -- Pre-aggregate product makes
//       LEFT JOIN (
//           SELECT 
//               pvm.vendor_id,
//               STRING_AGG(DISTINCT pvvm2.make_name, ', ') AS product_makes
//           FROM tbl_product_variant_vendor_mapping pvm
//           INNER JOIN tbl_product_variant_vendor_make pvvm2 
//               ON pvvm2.variant_vendor_map_id = pvm.id
//           GROUP BY pvm.vendor_id
//       ) pvvm ON pvvm.vendor_id = u.id

//       -- Pre-aggregate RFQ statistics
//       LEFT JOIN (
//           SELECT 
//               user_id,
//               COUNT(DISTINCT rfq_id) AS inquiry_count
//           FROM tbl_rfq_product_vendors
//           GROUP BY user_id
//       ) rpv_stats ON rpv_stats.user_id = u.id

//       -- Pre-aggregate quote statistics
//       LEFT JOIN (
//           SELECT 
//               created_by,
//               COUNT(DISTINCT id) AS quote_count
//           FROM tbl_quotes
//           GROUP BY created_by
//       ) q_stats ON q_stats.created_by = u.id

//       -- For total product count
//       LEFT JOIN tbl_product_variant_vendor_mapping pvm 
//         ON pvm.vendor_id = u.id

//       WHERE u.user_type = 3 

//       GROUP BY 
//         u.id, u.name, u.email, u.mobile, u.created_at, u.status,
//         va.psu_approved, pvvm.product_makes, 
//         rpv_stats.inquiry_count, q_stats.quote_count
//       ORDER BY u.id;
//     `;

//     db.any(query)
//       .then((data) => {
//         resolve(data);
//       })
//       .catch((err) => {
//         reject(new Error(err));
//       });
//   });
// },



getAllCompaniesListForAdmin : async () => {
  return new Promise((resolve, reject) => {
    const query = `
    select DISTINCT tc.id, tc.company_name
    from tbl_company tc join tbl_users tu on tu.company_id = tc.id
    where tu.user_type = 2`;
    db.any
    (query)
      .then(function (data) {   
        resolve(data);
      })
      .catch(function (err) {
        let error = new Error(err);
        reject(error);
      });
  });
},

  getTotalRfqCountForAdmin: async (rfqStatus, adminServiceStatus, company = []) => {
    return new Promise((resolve, reject) => {
      let dynamicQuery = '';
      const values = [rfqStatus];  // $1
      let paramCount = 2;

      // Handle admin_service_status
      if (adminServiceStatus === 'Pending') {
        dynamicQuery += ` AND (ARS.status IS NULL OR ARS.status = 'Pending')`;
      } else if (adminServiceStatus) {
        dynamicQuery += ` AND ARS.status = $${paramCount}`;
        values.push(adminServiceStatus);
        paramCount++;
      }

      // Handle company filter - THIS IS WHAT WAS MISSING AND BROKEN BEFORE
      if (company && Array.isArray(company) && company.length > 0) {
        const placeholders = company.map((_, i) => `$${paramCount + i}`).join(', ');
        dynamicQuery += ` AND U.company_id IN (${placeholders})`;
        company.forEach(id => values.push(Number(id)));
        paramCount += company.length;
      }

      const query = `
        SELECT COUNT(*) AS total
        FROM tbl_rfq RFQ
        LEFT JOIN tbl_admin_rfq_service ARS ON RFQ.id = ARS.rfq_id
        LEFT JOIN tbl_users U ON RFQ.created_by = U.id
        WHERE RFQ.is_published = 1
          AND ($1 IS NULL OR RFQ.status = $1)
          ${dynamicQuery}
      `;

      db.one(query, values)
        .then(data => {
          resolve({ total: Number(data.total) }); // match your old format: { total: 123 }
        })
        .catch(err => {
          reject(new Error(err));
        });
    });
  },

  createOrUpdateAdminRfqService: async (
    rfq_id,
    subadmin_id,
    status,
    comment
  ) => {
    return new Promise((resolve, reject) => {
      db.one(
        `
        INSERT INTO tbl_admin_rfq_service (rfq_id, subadmin_id, status, comment)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (rfq_id) DO UPDATE SET
          subadmin_id = $2,
          status = $3,
          comment = $4,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `,
        [rfq_id, subadmin_id, status, comment || null]
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

  getRfqByIdForAdmin: async (id) => {
    let q = `SELECT RFQ.*,
      P.name AS project_name,
      ARRAY(
        SELECT json_build_object('vendor_id', V.id, 'vendor_name', V.name, 'vendor_email', V.email, 'vendor_mobile', V.mobile, 'vendor_organization', V.organization_name,
          'products', (
            SELECT json_agg(json_build_object('product_id', RFQ_P.product_variant_id, 'variant', RFQ_P.variant, 'product_name', PV.name, 'product_description', P.description, 
              'quotation_details', (
                SELECT json_agg(json_build_object('quote_id', Q.id, 'timestamp', Q.timestamp, 'status', Q.status, 'is_regret', Q.is_regret, 'total_price', QI.total_price, 'unit_price', QI.unit_price, 'package_price', QI.package_price, 'freight_price', QI.freight_price, 'tax', QI.tax, 'delivery_period', QI.delivery_period)
                )
                FROM tbl_quotes Q
                JOIN tbl_quote_items QI ON Q.id = QI.quote_id
                WHERE Q.rfq_id = RFQ.id AND Q.created_by = V.id AND QI.product_variant_id = RFQ_P.product_variant_id AND QI.variant = RFQ_P.variant
              ),
              'finalization', (
                SELECT json_build_object('id', TQF.id, 'rfq_no', TQF.rfq_no, 'vendor_id', TQF.vendor_id, 'timestamp', TQF.timestamp)
                FROM tbl_quote_finalization TQF
                WHERE TQF.rfq_id = RFQ_P.rfq_id AND TQF.product_variant_id = RFQ_P.product_variant_id AND TQF.variant = RFQ_P.variant
              ),
              'product_specs', (
                SELECT json_agg(json_build_object('title', SPEC.title, 'value', SPEC.value))
                FROM tbl_rfq_products_specs SPEC
                WHERE SPEC.rfq_id = RFQ_P.rfq_id
                AND SPEC.product_variant_id = RFQ_P.product_variant_id
                AND SPEC.variant = RFQ_P.variant
              )
            ))
            FROM tbl_rfq_products RFQ_P
            JOIN tbl_product_variant PV ON RFQ_P.product_variant_id = PV.id
            JOIN tbl_product P ON P.id = PV.product_id
            WHERE RFQ_P.rfq_id = RFQ.id
            AND EXISTS (SELECT 1 FROM tbl_rfq_product_vendors RFQ_P_V WHERE RFQ_P_V.rfq_id = RFQ_P.rfq_id AND RFQ_P_V.user_id = V.id AND RFQ_P_V.product_variant_id = RFQ_P.product_variant_id AND RFQ_P_V.variant = RFQ_P.variant)
          )
        )
        FROM tbl_users V
        WHERE EXISTS (
          SELECT 1 FROM tbl_rfq_product_vendors RFQ_P_V
          WHERE RFQ_P_V.rfq_id = RFQ.id AND RFQ_P_V.user_id = V.id
        )
      ) AS "vendor_details",

      -- Fetch admin service details for this RFQ
      (
        SELECT json_agg(json_build_object('id', A.id, 'subadmin_id', A.subadmin_id, 'status', A.status, 'comment', A.comment, 'created_at', A.created_at, 'updated_at', A.updated_at))
        FROM tbl_admin_rfq_service A
        WHERE A.rfq_id = RFQ.id
      ) AS "admin_service_details"

    FROM tbl_rfq RFQ
    LEFT JOIN tbl_projects P ON RFQ.project_id = P.id
    WHERE RFQ.id = ${id}
    ORDER BY RFQ.id DESC
    LIMIT 1;`;

    return new Promise(function (resolve, reject) {
      db.query(q)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  /**
   * @param {*} rfq_id
   * @param {*} sender_id
   * @param {*} receiver_id
   * @description this function get message from tbl_query_messages, and mark then by sent or received company wise
   * @last_updated by mukul - 16-06-2025
   */
  getQueryMessages: async (rfq_id, sender_id, receiver_id) => {
    const query = `WITH viewer AS (
  SELECT id, company_id FROM tbl_users WHERE id = $2
),
target AS (
  SELECT id, company_id FROM tbl_users WHERE id = $3
)

SELECT 
  m.id AS message_id,
  m.message_text,
  m.created_at,
  m.sender_id,
  m.sender_type,
  m.receiver_id,
  sender.name AS sender_name,
  CASE 
    WHEN sender.company_id = viewer.company_id THEN 'sent'
    ELSE 'received'
  END AS direction,
  COALESCE(
    JSON_AGG(
      JSON_BUILD_OBJECT('file_name', f.file_name, 'file_url', f.file_url)
    ) FILTER (WHERE f.file_url IS NOT NULL), 
    '[]'
  ) AS files
FROM tbl_query_messages m
LEFT JOIN tbl_query_message_files f ON m.id = f.message_id
JOIN tbl_users sender ON sender.id = m.sender_id
JOIN tbl_users receiver ON receiver.id = m.receiver_id
JOIN viewer ON true
JOIN target ON true
WHERE m.rfq_id = $1
  AND (
    (sender.company_id = viewer.company_id AND receiver.company_id = target.company_id) OR
    (sender.company_id = target.company_id AND receiver.company_id = viewer.company_id)
  )
GROUP BY 
  m.id, m.message_text, m.created_at, m.sender_id, m.sender_type, m.receiver_id, sender.name, sender.company_id, viewer.company_id
ORDER BY m.created_at;
`;

    const updateQuery = `
        UPDATE tbl_query_messages
        SET is_seen = TRUE
        WHERE rfq_id = $1 AND receiver_id = $2 AND sender_id = $3 AND is_seen = FALSE;
    `;

    return new Promise((resolve, reject) => {
      db.query(query, [rfq_id, sender_id, receiver_id])
        .then((data) => {
          // Mark the received messages as seen
          db.query(updateQuery, [rfq_id, sender_id, receiver_id])
            .then(() => resolve(data))
            .catch((err) => reject(new Error(err)));
        })
        .catch((err) => reject(new Error(err)));
    });
  },

  getQueryMessageSummary: async (rfq_id, user_id, other_user_id) => {
    const query = `
      SELECT
          user_data.user_id AS "user_id",
          user_data.user_name AS "user_name",
          user_data.company_name,
          COALESCE(unseen_data.unseen_count, 0) AS "unseen_count",
          COALESCE(latest_message_data.last_message, '') AS "last_message",
          COALESCE(latest_message_data.last_message_timestamp, NULL) AS "last_message_timestamp"
      FROM
          (SELECT tu.id AS user_id, tu.name AS user_name, tc.company_name FROM tbl_users tu JOIN tbl_company tc ON tc.id = tu.company_id WHERE tu.id = $3) AS user_data
      LEFT JOIN
          (SELECT COUNT(*) AS unseen_count
           FROM tbl_query_messages
           WHERE rfq_id = $1 AND sender_id = $3 AND receiver_id = $2 AND is_seen = false) AS unseen_data
      ON true
      LEFT JOIN
          (SELECT message_text AS last_message, created_at AS last_message_timestamp
           FROM tbl_query_messages
           WHERE rfq_id = $1 AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2))
           ORDER BY created_at DESC LIMIT 1) AS latest_message_data
      ON true;
    `;

    return new Promise((resolve, reject) => {
      db.query(query, [rfq_id, user_id, other_user_id])
        .then((result) => {
          resolve(result);
        })
        .catch((error) => {
          reject(new Error(error));
        });
    });
  },

  /**
   * Optimized conversation summary fetcher for buyer-vendor queries
   * Collapses the previous per-user Promise.all loop into a single SQL roundtrip
   * to keep latency predictable even with thousands of vendors.
   *
   * @param {*} rfq_id
   * @param {*} viewer_id
   * @param {*} viewer_type
   * @param {*} user_name optional search string
   */
  getQueryParticipantsSummary: async (
    rfq_id,
    viewer_id,
    viewer_type,
    user_name = ''
  ) => {
    const buyerTypes = [2, 8, 9, 10];
    const params = [rfq_id, viewer_id];
    let searchParamIndex = null;

    if (user_name) {
      params.push(user_name);
      searchParamIndex = params.length;
    }

    const searchFilter = user_name
      ? `
        AND (
          to_tsvector('english', TU.name) @@ plainto_tsquery('english', $${searchParamIndex}) OR
          (char_length($${searchParamIndex}) = 1 AND similarity(TU.name, $${searchParamIndex}) > 0) OR
          (char_length($${searchParamIndex}) > 1 AND similarity(TU.name, $${searchParamIndex}) > 0.1)
        )
      `
      : '';

    const candidateQuery = buyerTypes.includes(viewer_type)
      ? `
        SELECT DISTINCT
          TRPV.user_id AS user_id,
          TU.name AS user_name,
          COALESCE(TC.company_name, '') AS company_name
        FROM tbl_rfq_product_vendors TRPV
        JOIN tbl_users TU ON TU.id = TRPV.user_id
        LEFT JOIN tbl_company TC ON TC.id = TU.company_id
        WHERE TRPV.rfq_id = $1
        ${searchFilter}
      `
      : `
        SELECT
          TU.id AS user_id,
          TU.name AS user_name,
          COALESCE(TC.company_name, '') AS company_name
        FROM tbl_rfq TR
        JOIN tbl_users TU ON TU.id = TR.created_by
        LEFT JOIN tbl_company TC ON TC.id = TU.company_id
        WHERE TR.id = $1
        ${searchFilter}
      `;

    const query = `
      WITH candidates AS (
        ${candidateQuery}
      ),
      latest_messages AS (
        SELECT
          CASE WHEN m.sender_id = $2 THEN m.receiver_id ELSE m.sender_id END AS other_user_id,
          m.message_text,
          m.created_at,
          ROW_NUMBER() OVER (
            PARTITION BY CASE WHEN m.sender_id = $2 THEN m.receiver_id ELSE m.sender_id END
            ORDER BY m.created_at DESC
          ) AS rn
        FROM tbl_query_messages m
        WHERE m.rfq_id = $1
          AND (m.sender_id = $2 OR m.receiver_id = $2)
      ),
      unseen_counts AS (
        SELECT sender_id AS other_user_id, COUNT(*) AS unseen_count
        FROM tbl_query_messages
        WHERE rfq_id = $1
          AND receiver_id = $2
          AND is_seen = false
        GROUP BY sender_id
      )
      SELECT
        c.user_id,
        c.user_name,
        c.company_name,
        COALESCE(u.unseen_count, 0) AS unseen_count,
        COALESCE(l.message_text, '') AS last_message,
        l.created_at AS last_message_timestamp
      FROM candidates c
      LEFT JOIN unseen_counts u ON u.other_user_id = c.user_id
      LEFT JOIN latest_messages l ON l.other_user_id = c.user_id AND l.rn = 1
      ORDER BY
        CASE WHEN l.created_at IS NULL THEN 1 ELSE 0 END,
        l.created_at DESC NULLS LAST,
        c.user_name ASC;
    `;

    return new Promise((resolve, reject) => {
      db.query(query, params)
        .then((result) => resolve(result))
        .catch((error) => reject(new Error(error)));
    });
  },

  // Changes by Agnij 2025-05-14 [Add bulk clause insertion]
  addManyClauses: async (rfq_id, rfq_product_id, clauses) => {
    return new Promise(async (resolve, reject) => {
      try {
        // Validate RFQ and Product existence
        const validateRfqQuery = 'SELECT id FROM tbl_rfq WHERE id = $1';
        const validateProductQuery =
          'SELECT id FROM tbl_rfq_products WHERE id = $1';

        const [rfqExists, productExists] = await Promise.all([
          db.oneOrNone(validateRfqQuery, [rfq_id]),
          db.oneOrNone(validateProductQuery, [rfq_product_id])
        ]);

        if (!rfqExists) {
          return resolve({
            status: 0,
            message: `RFQ with ID ${rfq_id} does not exist.`
          });
        }
        if (!productExists) {
          return resolve({
            status: 0,
            message: `RFQ Product with ID ${rfq_product_id} does not exist.`
          });
        }

        // Changes by Agnij 2025-05-14 [Fix ON CONFLICT issue with tech evaluation record]
        // First check if tech evaluation record exists
        const checkTechEvalQuery = `
          SELECT id FROM tbl_rfq_product_tech_evaluation 
          WHERE rfq_id = $1 AND tbl_rfq_product_id = $2`;

        let techEval = await db.oneOrNone(checkTechEvalQuery, [
          rfq_id,
          rfq_product_id
        ]);

        // If it doesn't exist, create it
        if (!techEval) {
          const insertTechEvalQuery = `
            INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, timestamp)
            VALUES ($1, $2, NOW())
            RETURNING id`;

          techEval = await db.one(insertTechEvalQuery, [
            rfq_id,
            rfq_product_id
          ]);
        } else {
          // If it exists, update the timestamp
          await db.none(
            `
            UPDATE tbl_rfq_product_tech_evaluation 
            SET timestamp = NOW() 
            WHERE id = $1`,
            [techEval.id]
          );
        }
        const techEvalId = techEval.id;

        // Changes by Agnij 2025-05-14 [Improve bulk clause insertion with chunking and better error handling]
        console.log(
          `Preparing to insert ${clauses.length} clauses for tech evaluation ID ${techEvalId}`
        );

        // Filter invalid clauses and prepare values
        const validClauses = clauses.filter(
          (clause) => typeof clause === 'string' && clause.trim().length > 0
        );

        if (validClauses.length === 0) {
          return resolve({
            status: 0,
            message: 'No valid clauses provided for insertion'
          });
        }

        console.log(`Found ${validClauses.length} valid clauses for insertion`);

        // Prepare values for insertion
        const clauseValues = validClauses.map((clause) => ({
          tbl_rfq_product_tech_evaluation_id: techEvalId,
          clause_text: clause.substring(0, 2000), // Limit length to avoid DB errors
          timestamp: new Date()
        }));

        // Insert in smaller chunks to avoid potential DB issues with very large inserts
        const CHUNK_SIZE = 50;
        let insertedCount = 0;

        // Process in chunks
        for (let i = 0; i < clauseValues.length; i += CHUNK_SIZE) {
          const chunk = clauseValues.slice(i, i + CHUNK_SIZE);

          try {
            // Use pgp.helpers.insert for efficient bulk insertion
            const cs = new pgp.helpers.ColumnSet(
              [
                'tbl_rfq_product_tech_evaluation_id',
                'clause_text',
                'timestamp'
              ],
              { table: 'tbl_rfq_product_tech_evaluation_clauses' }
            );

            const insertQuery = pgp.helpers.insert(chunk, cs) + ' RETURNING id';
            const insertedChunk = await db.many(insertQuery);
            insertedCount += insertedChunk.length;

            console.log(
              `Inserted chunk ${i / CHUNK_SIZE + 1} with ${
                insertedChunk.length
              } clauses`
            );
          } catch (chunkError) {
            console.error(
              `Error inserting clause chunk ${i / CHUNK_SIZE + 1}:`,
              chunkError
            );
            // Continue with next chunk instead of failing completely
          }
        }

        // Successfully inserted clauses
        console.log(
          `Successfully inserted ${insertedCount} of ${validClauses.length} clauses`
        );

        // Changes by Agnij 2025-05-14 [Improve response with detailed counts]
        resolve({
          status: insertedCount > 0 ? 1 : 0,
          message:
            insertedCount > 0
              ? `Successfully added ${insertedCount} clauses`
              : 'Failed to insert any clauses',
          inserted: insertedCount,
          total: validClauses.length
        });
      } catch (error) {
        console.error('Error in addManyClauses:', error);
        resolve({
          status: 0,
          message: 'Error adding clauses',
          error: error.message
        });
      }
    });
  },

  addClause: async (rfq_id, rfq_product_id, clause_text, file_url) => {
    // console.log("values in add clause model", rfq_id, rfq_product_id, clause_text, file_url);

    const validateRfqQuery = `
      SELECT id
      FROM tbl_rfq
      WHERE id = $1;
    `;

    const validateRfqProductQuery = `
      SELECT id
      FROM tbl_rfq_products
      WHERE id = $1;
    `;

    const validateRfqProductTechEvaluationQuery = `
      SELECT id
      FROM tbl_rfq_product_tech_evaluation
      WHERE rfq_id = $1 AND tbl_rfq_product_id = $2;
    `;

    const insertRfqProductTechEvaluationQuery = `
      INSERT INTO tbl_rfq_product_tech_evaluation
      (rfq_id, tbl_rfq_product_id, timestamp)
      VALUES ($1, $2, NOW())
      RETURNING id;
    `;

    const insertClauseQuery = `
      INSERT INTO tbl_rfq_product_tech_evaluation_clauses
      (tbl_rfq_product_tech_evaluation_id, clause_text, timestamp)
      VALUES ($1, $2, NOW())
      RETURNING id;
    `;

    const insertFileQuery = `
      INSERT INTO tbl_rfq_product_tech_evaluation_clauses_files
      (tbl_rfq_product_tech_evaluation_clauses_id, file_url, timestamp)
      VALUES ($1, $2, NOW());
    `;

    return new Promise((resolve, reject) => {
      // console.log("Entered add-clause model");

      // Validate the RFQ ID
      db.query(validateRfqQuery, [rfq_id])
        .then(async (rfqValidationResult) => {
          if (rfqValidationResult.length === 0) {
            resolve({
              status: 0,
              message: `RFQ with ID ${rfq_id} does not exist.`
            });
            return;
          }

          // Validate the RFQ Product ID
          const rfqProductValidationResult = await db.query(
            validateRfqProductQuery,
            [rfq_product_id]
          );
          if (rfqProductValidationResult.length === 0) {
            resolve({
              status: 0,
              message: `RFQ Product with ID ${rfq_product_id} does not exist.`
            });
            return;
          }

          // Validate or Insert RFQ Product Tech Evaluation
          const techEvaluationResult = await db.query(
            validateRfqProductTechEvaluationQuery,
            [rfq_id, rfq_product_id]
          );
          let evaluationId;

          if (techEvaluationResult.length === 0) {
            // console.log("RFQ Product Tech Evaluation not found, inserting new record...");
            const insertResult = await db.query(
              insertRfqProductTechEvaluationQuery,
              [rfq_id, rfq_product_id]
            );
            evaluationId = insertResult[0].id;
            // console.log("New RFQ Product Tech Evaluation ID:", evaluationId);
          } else {
            evaluationId = techEvaluationResult[0].id;
            // console.log("RFQ Product Tech Evaluation found, using existing ID:", evaluationId);
          }

          // Insert the Clause
          return db.query(insertClauseQuery, [evaluationId, clause_text]);
        })
        .then(async (clauseResult) => {
          const clauseId = clauseResult[0].id; // Extract the returned clause ID
          // console.log("Clause ID:", clauseId);

          // Insert associated files
          if (file_url && file_url.length > 0) {
            for (const url of file_url) {
              await db.query(insertFileQuery, [clauseId, url]);
            }
          }

          // Respond after successful operations
          resolve({
            status: 1,
            message:
              'Clause and files successfully added to technical evaluation.'
          });
        })
        .catch((error) => {
          console.error('Error adding clause:', error);
          reject({
            status: 0,
            message: 'Error in adding clauses or associated files.',
            error: error.message
          });
        });
    });
  },

  updateClause: async (
    tbl_rfq_product_tech_evaluation_clauses_id,
    clause_text,
    file_url
  ) => {
    // console.log("entered update clause = ", tbl_rfq_product_tech_evaluation_clauses_id, clause_text,file_url);
    const queryCheckClauseId = `
    SELECT id
      FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE id = $1;
    `;
    const queryUpdateClause = `
      UPDATE tbl_rfq_product_tech_evaluation_clauses
      SET clause_text = $1, timestamp = NOW()
      WHERE id = $2
      RETURNING id;
    `;

    const queryGetExistingFiles = `
      SELECT file_url
      FROM tbl_rfq_product_tech_evaluation_clauses_files
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1;
    `;

    const queryInsertFile = `
      INSERT INTO tbl_rfq_product_tech_evaluation_clauses_files
      (tbl_rfq_product_tech_evaluation_clauses_id, file_url, timestamp)
      VALUES ($1, $2, NOW())
      ON CONFLICT (tbl_rfq_product_tech_evaluation_clauses_id, file_url)
      DO UPDATE SET timestamp = NOW();
    `;

    const queryDeleteFiles = `
      DELETE FROM tbl_rfq_product_tech_evaluation_clauses_files
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1
        AND file_url = ANY($2::text[]);
    `;

    const queryDeleteAllFiles = `
      DELETE FROM tbl_rfq_product_tech_evaluation_clauses_files
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1;
    `;

    return new Promise((resolve, reject) => {
      // Validate the clause ID
      db.query(queryCheckClauseId, [
        tbl_rfq_product_tech_evaluation_clauses_id
      ]).then(async (clauseIdValidationResult) => {
        if (clauseIdValidationResult.length === 0) {
          resolve({
            status: 0,
            message: `Clause with ID ${tbl_rfq_product_tech_evaluation_clauses_id} does not exist.`
          });
        }
      });

      // Updating the clause text
      db.query(queryUpdateClause, [
        clause_text,
        tbl_rfq_product_tech_evaluation_clauses_id
      ])
        .then(async (updateResult) => {
          if (updateResult.length === 0) {
            reject({
              success: false,
              message: `Clause ID ${tbl_rfq_product_tech_evaluation_clauses_id} not found.`
            });
            return;
          }

          // console.log(`Clause updated: ${tbl_rfq_product_tech_evaluation_clauses_id}`);

          // Handling file URLs
          if (file_url && file_url.length > 0) {
            // Get existing file URLs from the database
            db.query(queryGetExistingFiles, [
              tbl_rfq_product_tech_evaluation_clauses_id
            ])
              .then((existingFilesResult) => {
                // const existingFiles = existingFilesResult.rows.map(row => row.file_url);
                const existingFiles = [];
                for (let i = 0; i < existingFilesResult.length; i++) {
                  existingFiles.push(existingFilesResult[i].file_url);
                }
                // console.log("existing files = ",existingFiles);

                // Determining files to delete and to add
                const filesToDelete = existingFiles.filter(
                  (file) => !file_url.includes(file)
                );
                const filesToAdd = file_url.filter(
                  (file) => !existingFiles.includes(file)
                );
                // console.log("files to add = ",filesToAdd);
                // console.log("files to delete = ",filesToDelete);
                // Deleting files no longer needed
                if (filesToDelete.length > 0) {
                  db.query(queryDeleteFiles, [
                    tbl_rfq_product_tech_evaluation_clauses_id,
                    filesToDelete
                  ])
                    .then(() => {
                      console.log(`Deleted files: ${filesToDelete}`);
                    })
                    .catch((error) => {
                      console.error(`Error deleting files: ${error.message}`);
                      reject({
                        success: false,
                        message: 'Error deleting files.',
                        error: error.message
                      });
                    });
                }

                // Inserting new files
                if (filesToAdd.length > 0) {
                  for (const fileUrl of filesToAdd) {
                    db.query(queryInsertFile, [
                      tbl_rfq_product_tech_evaluation_clauses_id,
                      fileUrl
                    ])
                      .then(() => {
                        // console.log(`Inserted file: ${fileUrl}`);
                      })
                      .catch((error) => {
                        console.error(
                          `Error inserting file: ${fileUrl}. Error: ${error.message}`
                        );
                        reject({
                          success: false,
                          message: 'Error inserting files.',
                          error: error.message
                        });
                      });
                  }
                }

                resolve({
                  success: true,
                  message: 'Clause and associated files updated successfully.'
                });
              })
              .catch((error) => {
                console.error(
                  `Error retrieving existing files: ${error.message}`
                );
                reject({
                  success: false,
                  message: 'Error retrieving existing files.',
                  error: error.message
                });
              });
          } else {
            // If no file URLs provided, deleting all files
            db.query(queryDeleteAllFiles, [
              tbl_rfq_product_tech_evaluation_clauses_id
            ])
              .then(() => {
                console.log(
                  `All files deleted for clause ID: ${tbl_rfq_product_tech_evaluation_clauses_id}`
                );
                resolve({
                  success: true,
                  message: 'Clause updated successfully, and all files deleted.'
                });
              })
              .catch((error) => {
                console.error(`Error deleting all files: ${error.message}`);
                reject({
                  success: false,
                  message: 'Error deleting all files.',
                  error: error.message
                });
              });
          }
        })
        .catch((error) => {
          console.error(`Error updating clause: ${error.message}`);
          reject({
            success: false,
            message: 'Error updating clause.',
            error: error.message
          });
        });
    });
  },

  removeClause: async (tbl_rfq_product_tech_evaluation_clauses_id) => {
    const checkClauseExistsQuery = `
      SELECT 1 FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE id = $1;
    `;
    const deleteClauseQuery = `
      DELETE FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE id = $1;
    `;

    return new Promise((resolve, reject) => {
      //Checking if the clause exists
      db.query(checkClauseExistsQuery, [
        tbl_rfq_product_tech_evaluation_clauses_id
      ])
        .then(async (result) => {
          if (result.length === 0) {
            return reject(new Error('Clause not found.'));
          }

          //Deleting the clause (files will be deleted automatically due to ON DELETE CASCADE)
          db.query(deleteClauseQuery, [
            tbl_rfq_product_tech_evaluation_clauses_id
          ])
            .then(() => {
              resolve({
                success: true,
                message: 'Clause and associated files deleted successfully.'
              });
            })
            .catch((error) => {
              reject(new Error(error));
            });
        })
        .catch((error) => {
          reject(new Error(error));
        });
    });
  },

  getClauses: async (rfq_id) => {
    // console.log("entered get clauses model = ",tbl_rfq_product_tech_evaluation_id);
    // const query = `
    //   WITH clause_files AS (
    //     SELECT
    //       TE_C.id AS clause_id,
    //       TE_C.clause_text,
    //       TE.rfq_id,
    //       TE.tbl_rfq_product_id AS rfq_product_id,

    //       COALESCE(
    //         JSON_AGG(TE_F.file_url) FILTER (WHERE TE_F.file_url IS NOT NULL),
    //         '[]'
    //       ) AS files
    //     FROM tbl_rfq_product_tech_evaluation TE
    //     JOIN tbl_rfq_product_tech_evaluation_clauses AS TE_C
    //       ON TE.id = TE_C.tbl_rfq_product_tech_evaluation_id
    //     LEFT JOIN tbl_rfq_product_tech_evaluation_clauses_files AS TE_F
    //       ON TE_C.id = TE_F.tbl_rfq_product_tech_evaluation_clauses_id
    //     WHERE TE.rfq_id = $1
    //     GROUP BY TE_C.id, TE_C.clause_text, TE.rfq_id, TE.tbl_rfq_product_id
    //   )
    //   SELECT
    //     rfq_id,
    //     rfq_product_id,
    //     JSON_AGG(
    //       JSON_BUILD_OBJECT(
    //         'clause_id', clause_id,
    //         'clause_text', clause_text,
    //         'files', files
    //       )
    //     ) AS clauses
    //   FROM clause_files
    //   GROUP BY rfq_id, rfq_product_id;
    // `;

    const query = `
      WITH clause_files AS (SELECT TE.id                 as evaluation_id,
                                    TE_C.id               AS clause_id,
                                    TE_C.clause_text,
                                    TE.rfq_id,
                                    TE.tbl_rfq_product_id AS rfq_product_id,
                                    COALESCE(
                                                    JSON_AGG(TE_F.file_url) FILTER (WHERE TE_F.file_url IS NOT NULL),
                                                    '[]'
                                    )                     AS files
                              FROM tbl_rfq_product_tech_evaluation TE
                                      JOIN tbl_rfq_product_tech_evaluation_clauses AS TE_C
                                            ON TE.id = TE_C.tbl_rfq_product_tech_evaluation_id
                                      LEFT JOIN tbl_rfq_product_tech_evaluation_clauses_files AS TE_F
                                                ON TE_C.id = TE_F.tbl_rfq_product_tech_evaluation_clauses_id
                              WHERE TE.rfq_id = $1
                              GROUP BY TE.id, TE_C.id, TE_C.clause_text, TE.rfq_id, TE.tbl_rfq_product_id
                              ),

            vendor_response_files AS (SELECT vr.id                                                          AS vendor_response_id,
                                              JSON_AGG(vrf.file_url) FILTER (WHERE vrf.file_url IS NOT NULL) AS files
                                      FROM tbl_rfq_product_tech_evaluation_vendors_response vr
                                                LEFT JOIN tbl_rfq_product_tech_evaluation_vendors_response_files vrf
                                                          ON vr.id = vrf.tbl_rfq_product_tech_evaluation_vendors_response_id
                                      GROUP BY vr.id),

            vendor_responses_raw AS (SELECT vr.tbl_rfq_product_tech_evaluation_clauses_id AS clause_id,
                                            vr.vendor_id,
                                            vr.vendor_response,
                                            COALESCE(vrf.files, '[]')                     AS vendor_response_files
                                      FROM tbl_rfq_product_tech_evaluation_vendors_response vr
                                              LEFT JOIN vendor_response_files vrf
                                                        ON vr.id = vrf.vendor_response_id),

            vendor_responses_aggregated AS (SELECT clause_id,
                                                    JSON_AGG(
                                                            JSON_BUILD_OBJECT(
                                                                    'vendor_id', vendor_id,
                                                                    'vendor_response', vendor_response,
                                                                    'vendor_response_files', vendor_response_files
                                                            )
                                                    ) AS vendor_responses
                                            FROM vendor_responses_raw
                                            GROUP BY clause_id),

            clauses_data AS (
                SELECT
                    ordered_clauses.rfq_id,
                    ordered_clauses.rfq_product_id,
                    ordered_clauses.evaluation_id,
                    JSON_AGG(clause_entry ORDER BY clause_entry->>'clause_id') AS clauses
                FROM (
                          SELECT
                              cf.rfq_id,
                              cf.rfq_product_id,
                              cf.evaluation_id,
                              JSON_BUILD_OBJECT(
                                      'clause_id', cf.clause_id,
                                      'clause_text', cf.clause_text,
                                      'files', cf.files,
                                      'vendor_responses', COALESCE(vra.vendor_responses, '[]')
                              ) AS clause_entry
                          FROM clause_files cf
                                  LEFT JOIN vendor_responses_aggregated vra
                                            ON cf.clause_id = vra.clause_id
                      ) AS ordered_clauses
                GROUP BY rfq_id, rfq_product_id, evaluation_id
            ),

            vendors_list AS (
                SELECT
                    rfq_id,
                    rfq_product_id,
                    JSON_AGG(
                            JSON_BUILD_OBJECT(
                                    'vendor_id', vendor_id,
                                    'vendor_name', vendor_name,
                                    'vendor_email', vendor_email,
                                    'is_cleared', is_cleared,
                                    'evaluated_by', evaluated_by,
                                    'rfq_product_vendor_id', rfq_product_vendor_id
                            )
                    ) AS vendors
                FROM (
                          SELECT *
                          FROM (
                                  SELECT
                                      te.rfq_id,
                                      te.tbl_rfq_product_id AS rfq_product_id,
                                      tu.id AS vendor_id,
                                      COALESCE(tc.company_name, tu.organization_name, tu.name) AS vendor_name,
                                      tu.email AS vendor_email,
                                      rc.status AS is_cleared,
                                      _TU.name AS evaluated_by,
                                      rpv.id AS rfq_product_vendor_id,
                                      ROW_NUMBER() OVER (
                                          PARTITION BY te.rfq_id, te.tbl_rfq_product_id, tu.id
                                          ORDER BY te.id
                                          ) AS row_num
                                  FROM tbl_rfq_product_tech_evaluation te
                                            JOIN tbl_rfq_product_tech_evaluation_clauses c
                                                ON te.id = c.tbl_rfq_product_tech_evaluation_id
                                            JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
                                                ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
                                            JOIN tbl_users tu
                                                ON vr.vendor_id = tu.id
                                            LEFT JOIN tbl_company tc
                                                      ON tc.id = tu.company_id
                                            LEFT JOIN tbl_rfq_products trp
                                                      ON trp.id = te.tbl_rfq_product_id
                                            LEFT JOIN tbl_rfq_product_vendors rpv
                                                      ON rpv.rfq_id = te.rfq_id
                                                          AND rpv.user_id = tu.id
                                                          AND rpv.product_variant_id = trp.product_variant_id
                                                          AND rpv.variant = trp.variant
                                            LEFT JOIN tbl_rfq_product_tech_evaluation_cleared_vendors rc
                                                      ON rc.tbl_rfq_product_tech_evaluation_id = te.id
                                                          AND rc.vendor_id = tu.id
                                            LEFT JOIN tbl_users _TU ON _TU.id = rc.created_by
                              ) ranked
                          WHERE row_num = 1  -- ✅ This removes all duplicates
                      ) deduped
                GROUP BY rfq_id, rfq_product_id
            )

        SELECT cd.rfq_id,
              cd.rfq_product_id,
              cd.evaluation_id,
              cd.clauses,
              vl.vendors
        FROM clauses_data cd
                LEFT JOIN vendors_list vl
                          ON cd.rfq_id = vl.rfq_id AND cd.rfq_product_id = vl.rfq_product_id;
    `;

    return new Promise((resolve, reject) => {
      db.query(query, [rfq_id])
        .then((result) => {
          resolve({
            success: true,
            data: result
          });
        })
        .catch((error) => {
          console.error('Error fetching clauses and files:', error);
          reject({
            success: false,
            message: 'Error fetching clauses and files.',
            error: error.message
          });
        });
    });
  },

  addTechComment: async (
    tbl_rfq_product_tech_evaluation_clauses_id,
    sender_id,
    receiver_id,
    text,
    file_urls
  ) => {
    const validateClauseQuery = `
      SELECT EXISTS (SELECT 1 FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE id = $1) AS clause_exists;
    `;

    const insertCommentQuery = `
      INSERT INTO tbl_rfq_product_tech_evaluation_comments
      (tbl_rfq_product_tech_evaluation_clauses_id, sender_id, receiver_id, text, timestamp)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id;
    `;

    const insertFileQuery = `
      INSERT INTO tbl_rfq_product_tech_evaluation_comments_files
      (tbl_rfq_product_tech_evaluation_comments_id, user_id, file_url, timestamp)
      VALUES ($1, $2, $3, NOW());
    `;

    try {
      // Validate clause
      const clauseResult = await db.query(validateClauseQuery, [
        tbl_rfq_product_tech_evaluation_clauses_id
      ]);

      if (!clauseResult[0].clause_exists) {
        throw {
          status: 0,
          message: 'Invalid clause ID. Clause does not exist.'
        };
      }

      // Insert comment
      const commentResult = await db.query(insertCommentQuery, [
        tbl_rfq_product_tech_evaluation_clauses_id,
        sender_id,
        receiver_id,
        text
      ]);
      const commentId = commentResult[0].id;

      // Insert associated files if provided
      if (file_urls && file_urls.length > 0) {
        for (const file_url of file_urls) {
          try {
            await db.query(insertFileQuery, [commentId, sender_id, file_url]);
          } catch (fileError) {
            console.error(`Error adding file: ${file_url}`, fileError.message);
            throw {
              status: 0,
              message: 'Failed to add files associated with the comment.',
              error: fileError.message
            };
          }
        }
      }

      // Resolve if everything is successful
      return {
        status: 1,
        message: 'Comment and associated files added successfully.',
        commentId: commentId
      };
    } catch (error) {
      // Handle errors
      console.error('Error:', error.message);
      throw error;
    }
  },

  getTechComments: async (
    clause_id,
    sender_id,
    receiver_id,
    user_id,
    user_type
  ) => {
    const validateClauseQuery = `
      SELECT EXISTS (SELECT 1 FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE id = $1) AS clause_exists;
    `;

    const getRfqIdFromClauseQuery = `
      SELECT te.rfq_id
      FROM tbl_rfq_product_tech_evaluation_clauses c
      JOIN tbl_rfq_product_tech_evaluation te ON c.tbl_rfq_product_tech_evaluation_id = te.id
      WHERE c.id = $1;
    `;

    const fetchCommentsQuery = `
      SELECT id AS comment_id, text AS comment_text, sender_id AS created_by
      FROM tbl_rfq_product_tech_evaluation_comments
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1
        AND (
          (sender_id = $2 AND receiver_id = $3) OR  -- Buyer to Vendor
          (sender_id = $3 AND receiver_id = $2)    -- Vendor to Buyer
      )
      ORDER BY timestamp ASC;
    `;

    const fetchAllCommentsQuery = `
      SELECT id AS comment_id, text AS comment_text, sender_id AS created_by
      FROM tbl_rfq_product_tech_evaluation_comments
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1
      AND (
          (sender_id = $2) OR  -- Buyer to Vendor
          (receiver_id = $2)    -- Vendor to Buyer
      )
      ORDER BY timestamp ASC;
    `;

    const fetchCommentFilesQuery = `
      SELECT file_url
      FROM tbl_rfq_product_tech_evaluation_comments_files
      WHERE tbl_rfq_product_tech_evaluation_comments_id = $1
        AND user_id = $2;
    `;

    try {
      // Validate clause existence
      const clauseResult = await db.query(validateClauseQuery, [clause_id]);

      if (!clauseResult[0].clause_exists) {
        throw {
          status: 0,
          message: 'Invalid clause ID. Clause does not exist.'
        };
      }

      // Get RFQ ID from clause to check access
      const rfqResult = await db.query(getRfqIdFromClauseQuery, [clause_id]);

      if (rfqResult.length === 0) {
        throw {
          status: 0,
          message: 'Unable to find RFQ for this clause.'
        };
      }

      const rfqId = rfqResult[0].rfq_id;

      // Check if user has access to this RFQ (either as creator or team member)
      const hasAccess = await userModel.user_rfq_access_review(
        rfqId,
        user_id,
        user_type
      );
      let commentsResult;

      if (hasAccess && user_type != '3') {
        // User has access to RFQ (creator or team member), show all comments
        commentsResult = await db.query(fetchAllCommentsQuery, [
          clause_id,
          receiver_id
        ]);
      } else {
        // User doesn't have general access, use original restricted logic
        commentsResult = await db.query(fetchCommentsQuery, [
          clause_id,
          sender_id,
          receiver_id
        ]);
      }

      const data = [];

      for (const comment of commentsResult) {
        const { comment_id, comment_text, created_by } = comment;

        // Fetch files associated with the comment
        let filesResult = [];
        try {
          filesResult = await db.query(fetchCommentFilesQuery, [
            comment_id,
            created_by
          ]);
        } catch (fileError) {
          console.error(
            `Error fetching files for comment ID: ${comment_id}`,
            fileError.message
          );
          throw {
            status: 0,
            message: 'Failed to fetch files for comments.',
            error: fileError.message
          };
        }

        // Add comment and files to the response
        data.push({
          comment_id,
          comment_text,
          created_by,
          comment_files: filesResult.map((file) => file.file_url) || []
        });
      }

      // Return success response
      return {
        status: 1,
        message: 'Comments fetched successfully.',
        data
      };
    } catch (error) {
      console.error('Error:', error.message);
      throw error; // Rethrow the error for the caller to handle
    }
  },
  getSummarisedDeviation: async (rfq_id) => {
    return new Promise(async (resolve, reject) => {
      const q = `
      SELECT 
        tr.id, 
        tr.rfq_no, 
        trpec.id as clause_id,
        trptec.sender_id, 
        trptec.receiver_id,
        trptec.text AS deviation
      FROM tbl_rfq tr
      JOIN tbl_rfq_product_tech_evaluation trpte ON trpte.rfq_id = tr.id 
      JOIN tbl_rfq_product_tech_evaluation_clauses trpec ON trpec.tbl_rfq_product_tech_evaluation_id = trpte.id 
      JOIN tbl_rfq_product_tech_evaluation_comments trptec ON trptec.tbl_rfq_product_tech_evaluation_clauses_id = trpec.id
      WHERE tr.id = $1;
    `;

      try {
        const result = await db.query(q, [rfq_id]);
        resolve(result);
      } catch (error) {
        reject({
          status: 0,
          message: `Failed to fetch deviation summary for RFQ ID ${rfq_id}.`,
          error: error.message
        });
      }
    });
  },

  addVendorResponse: async (responses) => {
    const validateClauseQuery = `
      SELECT EXISTS (SELECT 1 FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE id = $1) AS clause_exists;
    `;

    const validateVendorQuery = `
      SELECT EXISTS (SELECT 1 FROM tbl_users WHERE id = $1) AS vendor_exists;
    `;

    const checkVendorResponseQuery = `
      SELECT EXISTS (SELECT 1 FROM tbl_rfq_product_tech_evaluation_vendors_response
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1 AND vendor_id = $2) AS response_exists;
    `;

    const insertVendorResponseQuery = `
      INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
      (vendor_id, tbl_rfq_product_tech_evaluation_clauses_id, vendor_response, timestamp)
      VALUES ($1, $2, $3, NOW())
      RETURNING id;
    `;

    const insertFileQuery = `
      INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response_files
      (tbl_rfq_product_tech_evaluation_vendors_response_id, file_url, timestamp)
      VALUES ($1, $2, NOW());
    `;

    return new Promise((resolve, reject) => {
      // Iterate over each vendor response
      const promises = responses.map(async (response) => {
        const { vendor_id, clause_id, vendor_response, file_url } = response;

        // Validate clause existence
        const clauseResult = await db.query(validateClauseQuery, [clause_id]);
        // console.log("Clause validation result =", clauseResult);
        if (!clauseResult[0].clause_exists) {
          throw {
            status: 0,
            message: `Clause ID ${clause_id} does not exist.`
          };
        }

        // Validate vendor existence
        const vendorResult = await db.query(validateVendorQuery, [vendor_id]);
        // console.log("Vendor validation result =", vendorResult);
        if (!vendorResult[0].vendor_exists) {
          reject({
            status: 0,
            message: `Vendor ID ${vendor_id} does not exist.`
          });
          return;
        }

        // Check if Vendor Response already exists
        const responseResult = await db.query(checkVendorResponseQuery, [
          clause_id,
          vendor_id
        ]);
        // console.log("Vendor response validation result =", responseResult);
        if (responseResult[0].response_exists) {
          reject({
            status: 0,
            message: `Vendor response already exists for Clause ID ${clause_id}.`
          });
          return;
        }

        // Insert vendor response
        const insertResponseResult = await db.query(insertVendorResponseQuery, [
          vendor_id,
          clause_id,
          vendor_response
        ]);
        const responseId = insertResponseResult[0].id;
        // console.log("Inserted Vendor Response ID =", responseId);

        // Insert associated files if provided
        if (file_url && file_url.length > 0) {
          for (const url of file_url) {
            await db
              .query(insertFileQuery, [responseId, url])
              .catch((fileError) => {
                console.error(`Error adding file: ${url}`, fileError.message);
                reject({
                  status: 0,
                  message:
                    'Failed to add files associated with the vendor response.',
                  error: fileError.message
                });
                return;
              });
          }
        }

        return {
          status: 1,
          message: 'Vendor response and files successfully added.',
          response_id: responseId
        };
      });

      // Wait for all vendor responses to be processed
      Promise.all(promises)
        .then((results) => {
          resolve({
            status: 1,
            message: 'All vendor responses successfully added.',
            results: results
          });
        })
        .catch((error) => {
          console.error('Error in addVendorResponses:', error);
          reject({
            status: 0,
            message: 'Error adding vendor responses or associated files.',
            error: error.message
          });
        });
    });
  },

  addtechEvaluationClearedVendors: (
    vendor_id,
    tbl_rfq_product_tech_evaluation_id,
    status,
    reject_message,
    user_id
  ) => {
    // console.log("Entered addClearedVendor =", vendor_id, tbl_rfq_product_tech_evaluation_id,status, reject_message);

    const validateVendorQuery = `
      SELECT id
      FROM tbl_users
      WHERE id = $1;
    `;

    const validateRfqEvaluationQuery = `
      SELECT id
      FROM tbl_rfq_product_tech_evaluation
      WHERE id = $1;
    `;

    const insertClearedVendorQuery = `
      INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
      (tbl_rfq_product_tech_evaluation_id, vendor_id, status, reject_message, timestamp, created_by)
      VALUES ($1, $2, $3, $4, NOW(), $5);
    `;

    return new Promise((resolve, reject) => {
      // console.log("Entered cleared vendor model");

      // Validate Vendor
      db.query(validateVendorQuery, [vendor_id])
        .then((vendorResult) => {
          // console.log("Vendor validation result =", vendorResult);

          if (vendorResult.length === 0) {
            reject({
              status: 0,
              message: `Vendor ID ${vendor_id} not found.`
            });
            return; // Stop further execution
          }

          // Validate RFQ Product Technical Evaluation ID
          return db.query(validateRfqEvaluationQuery, [
            tbl_rfq_product_tech_evaluation_id
          ]);
        })
        .then((evaluationResult) => {
          // console.log("RFQ Evaluation validation result =", evaluationResult);

          if (evaluationResult.length === 0) {
            reject({
              status: 0,
              message: `Technical Evaluation ID ${tbl_rfq_product_tech_evaluation_id} not found.`
            });
            return; // Stop further execution
          }

          // Insert Cleared Vendor
          return db.query(insertClearedVendorQuery, [
            tbl_rfq_product_tech_evaluation_id,
            vendor_id,
            status,
            reject_message,
            user_id
          ]);
        })
        .then(() => {
          // console.log("Vendor successfully added to cleared vendors.");

          // Respond after successful operation
          resolve({
            status: 1,
            message: 'Vendor successfully added to cleared vendors.'
          });
        })
        .catch((error) => {
          // console.error("Error in addClearedVendor:", error);
          reject({
            status: 0,
            message: 'Error in adding cleared vendor.',
            error: error.message
          });
        });
    });
  },
  getVendorNames: async (rfq_id, tbl_rfq_product_id) => {
    // console.log("Values in getVendorsDetails model:", rfq_id, tbl_rfq_product_id);

    // Updated query to fetch vendor IDs
    const fetchVendorsQuery = `
      SELECT DISTINCT vr.vendor_id
      FROM tbl_rfq_product_tech_evaluation te
      JOIN tbl_rfq_product_tech_evaluation_clauses c
          ON te.id = c.tbl_rfq_product_tech_evaluation_id
      JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
          ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
      WHERE te.rfq_id = $1
        AND te.tbl_rfq_product_id = $2;
    `;

    // Query to fetch vendor details (vendor_name, company_name, organization_name)
    const fetchVendorDetailsQuery = `
      SELECT
        u.id AS vendor_id,
        u.name AS vendor_name,
        COALESCE(c.company_name, '') AS company_name,
        COALESCE(u.organization_name, '') AS organization_name
      FROM tbl_users u
      LEFT JOIN tbl_company c ON u.company_id = c.id
      WHERE u.id = $1;
    `;

    return new Promise((resolve, reject) => {
      // console.log("Entered getVendorsDetails model");

      // Fetch vendor IDs related to the given RFQ and product
      db.query(fetchVendorsQuery, [rfq_id, tbl_rfq_product_id])
        .then(async (vendorIdsResult) => {
          if (vendorIdsResult.length === 0) {
            // If no vendors found, return an empty array
            resolve({
              status: 1,
              message: 'No vendors found.',
              data: []
            });
            return;
          }

          // Initialize an empty array to store the vendor details
          const vendorDetails = [];

          // Fetch vendor details for each unique vendor_id
          for (const vendor of vendorIdsResult) {
            const vendorId = vendor.vendor_id;

            // Fetch vendor details (vendor_name, company_name, organization_name)
            const vendorDetailsResult = await db.query(
              fetchVendorDetailsQuery,
              [vendorId]
            );

            if (vendorDetailsResult.length > 0) {
              const vendorData = vendorDetailsResult[0];
              vendorDetails.push({
                vendor_id: vendorData.vendor_id,
                vendor_name: vendorData.vendor_name,
                company_name: vendorData.company_name,
                organization_name: vendorData.organization_name
              });
            }
          }

          // Return the vendor details
          resolve({
            status: 1,
            message: 'Vendors fetched successfully.',
            data: vendorDetails
          });
        })
        .catch((error) => {
          console.error('Error fetching vendor details:', error);
          reject({
            status: 0,
            message: 'Error in fetching vendor details.',
            error: error.message
          });
        });
    });
  },

  getVendorResponses: async (rfq_id, tbl_rfq_product_id, vendor_id) => {
    // console.log("Values in getVendorResponsesForClauses model:", rfq_id, tbl_rfq_product_id, vendor_id);

    // Query to fetch the tbl_rfq_product_tech_evaluation_id
    const getTechEvaluationIdQuery = `
      SELECT id
      FROM tbl_rfq_product_tech_evaluation
      WHERE rfq_id = $1
        AND tbl_rfq_product_id = $2;
    `;

    // Query to fetch clauses associated with the tbl_rfq_product_tech_evaluation_id
    const getClausesQuery = `
      SELECT id AS clause_id, clause_text
      FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE tbl_rfq_product_tech_evaluation_id = $1;
    `;

    // Query to fetch clause files associated with each clause
    const getClauseFilesQuery = `
      SELECT tbl_rfq_product_tech_evaluation_clauses_id, file_url
      FROM tbl_rfq_product_tech_evaluation_clauses_files
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = ANY($1::int[]);
    `;

    // Query to fetch vendor responses and vendor response files
    const getVendorResponsesQuery = `
      SELECT vr.tbl_rfq_product_tech_evaluation_clauses_id, vr.vendor_response, vrf.file_url AS vendor_response_files
      FROM tbl_rfq_product_tech_evaluation_vendors_response vr
      LEFT JOIN tbl_rfq_product_tech_evaluation_vendors_response_files vrf
        ON vr.id = vrf.tbl_rfq_product_tech_evaluation_vendors_response_id
      WHERE vr.vendor_id = $1 AND vr.tbl_rfq_product_tech_evaluation_clauses_id = ANY($2::int[]);
    `;

    return new Promise((resolve, reject) => {
      // console.log("Entered getVendorResponsesForClauses model");

      // Step 1: Fetch tbl_rfq_product_tech_evaluation_id
      db.query(getTechEvaluationIdQuery, [rfq_id, tbl_rfq_product_id])
        .then(async (techEvalResult) => {
          if (techEvalResult.length === 0) {
            resolve({
              status: 0,
              message:
                'No tech evaluation found for the given rfq_id and tbl_rfq_product_id.',
              data: []
            });
            return;
          }

          const techEvaluationId = techEvalResult[0].id;

          // Step 2: Fetch clauses associated with the tbl_rfq_product_tech_evaluation_id
          const clausesResult = await db.query(getClausesQuery, [
            techEvaluationId
          ]);

          if (clausesResult.length === 0) {
            resolve({
              status: 0,
              message: 'No clauses found for the given tech evaluation.',
              data: []
            });
            return;
          }

          // Step 3: Fetch clause files associated with each clause
          const clauseIds = clausesResult.map((clause) => clause.clause_id);
          const clauseFilesResult = await db.query(getClauseFilesQuery, [
            clauseIds
          ]);

          // Step 4: Fetch vendor responses for each clause
          const vendorResponsesResult = await db.query(
            getVendorResponsesQuery,
            [vendor_id, clauseIds]
          );
          // console.log("vendor response result = ",vendorResponsesResult);
          // Step 5: Format the response
          const data = clausesResult.map((clause) => {
            const clauseFiles = clauseFilesResult
              .filter(
                (file) =>
                  file.tbl_rfq_product_tech_evaluation_clauses_id ===
                  clause.clause_id
              )
              .map((file) => (file.file_url ? file.file_url : []));

            const vendorResponse = vendorResponsesResult.filter(
              (vr) =>
                vr.tbl_rfq_product_tech_evaluation_clauses_id ===
                clause.clause_id
            );

            return {
              clause_id: clause.clause_id,
              clause_text: clause.clause_text,
              clause_files: clauseFiles,
              vendor_response:
                vendorResponse.length > 0
                  ? vendorResponse[0].vendor_response
                  : '',
              vendor_response_files: vendorResponse
                .map((vr) =>
                  vr.vendor_response_files ? vr.vendor_response_files : []
                )
                .flat()
            };
          });

          resolve({
            status: 1,
            message: 'Vendor responses fetched successfully.',
            data: data
          });
        })
        .catch((error) => {
          reject({
            status: 0,
            message: 'Error in fetching vendor responses.',
            error: error.message
          });
        });
    });
  },
  getTechEvaluationRFQDetails: (user_id, rfq_no, project_id) => {
    return new Promise(async (resolve, reject) => {
      // console.log("--------------    Fetching RFQ details    ----------------", user_id);

      try {
        // Step 1: Fetch rfq_ids for the given user_id
        const fetchRFQIdsQuery = `
        SELECT  r.id AS rfq_id, r.rfq_no
        FROM tbl_rfq r
        LEFT JOIN tbl_project_team pt ON pt.project_id = r.project_id
        WHERE r.created_by = $1 OR pt.user_id = $1;
      `;
        const rfqResult = await db.query(fetchRFQIdsQuery, [user_id]);

        if (rfqResult.length === 0) {
          resolve({
            status: 1,
            message: 'No RFQs found for the given user.',
            data: []
          });
          return;
        }

        const rfqData = rfqResult.map((row) => ({
          rfq_id: row.rfq_id,
          rfq_no: row.rfq_no
        }));
        const rfqIds = rfqData.map((row) => row.rfq_id);

        // Step 2: Fetch valid technical evaluations for the fetched RFQs
        const fetchTechEvaluationQuery = `
        SELECT rfq_id, tbl_rfq_product_id, id AS tbl_rfq_product_tech_evaluation_id
        FROM tbl_rfq_product_tech_evaluation
        WHERE rfq_id = ANY($1);
      `;
        const techEvalResult = await db.query(fetchTechEvaluationQuery, [
          rfqIds
        ]);

        if (techEvalResult.length === 0) {
          resolve({
            status: 1,
            message: 'No technical evaluations found for the given RFQs.',
            data: []
          });
          return;
        }

        // filters for the query as rfq_no and project_id3
        let filtersQuery = '';
        if (rfq_no) {
          filtersQuery = `AND RFQ.rfq_no::text LIKE '%$3%'`;
        }

        if (project_id) {
          filtersQuery += ` AND RFQ.project_id = $4`;
        }

        // Step 3: Fetch RFQ products and RFQ Details
        const fetchDetailsQuery = `
        SELECT RFQ.*,
              TP.name AS project_name,
              ARRAY(
                  SELECT json_build_object(
                      'id', RFQ_P.id,
                      'product_id', RFQ_P.product_variant_id,
                      'tbl_rfq_product_tech_evaluation_id', (
                          SELECT TE.id
                          FROM tbl_rfq_product_tech_evaluation TE
                          WHERE TE.rfq_id = RFQ.id
                            AND TE.tbl_rfq_product_id = RFQ_P.id
                          LIMIT 1
                      ),
                      'product_specs', (
                          SELECT json_agg(
                              json_build_object(
                                  'title', RFQ_P_SPEC.title,
                                  'value', RFQ_P_SPEC.value
                              )
                          )
                          FROM tbl_rfq_products_specs RFQ_P_SPEC
                          WHERE RFQ_P.product_variant_id = RFQ_P_SPEC.product_variant_id
                            AND RFQ_P.rfq_id = RFQ_P_SPEC.rfq_id
                            AND RFQ_P.variant = RFQ_P_SPEC.variant
                      ),
                      'product_details', (
                          SELECT json_agg(
                              json_build_object(
                                  'id', TV.id,
                                  'name', TV.name
                              )
                          )
                          FROM tbl_product_variant TV
                          JOIN tbl_product T_P ON TV.product_id = T_P.id
                          WHERE RFQ_P.product_variant_id = TV.id
                      )
                  )
                  FROM tbl_rfq_products RFQ_P
                  WHERE RFQ.id = RFQ_P.rfq_id
              ) AS "products"
        FROM tbl_rfq RFQ
        LEFT JOIN tbl_projects TP
          ON TP.id = RFQ.project_id
        JOIN tbl_rfq_product_tech_evaluation RFQ_T_E
          ON RFQ.id = RFQ_T_E.rfq_id
          WHERE (RFQ.created_by = $1 OR EXISTS (
            SELECT 1
            FROM tbl_project_team PT
            WHERE PT.project_id = RFQ.project_id AND PT.user_id = $1
          ))
          AND RFQ.is_published = 1
          AND RFQ.id = ANY($2)
          ${filtersQuery === '' ? `` : filtersQuery}
        GROUP BY RFQ.id, TP.name
        HAVING COUNT(RFQ_T_E.id) > 0
        ORDER BY RFQ.id DESC;
      `;

        const rfqDetails = await db.query(fetchDetailsQuery, [
          user_id,
          rfqIds,
          rfq_no,
          project_id
        ]);

        resolve({
          status: 1,
          message: 'RFQ details fetched successfully.',
          data: rfqDetails
        });
      } catch (error) {
        console.error('Error fetching RFQ details:', error);
        reject({
          status: 0,
          message: 'Error in fetching RFQ details.',
          error: error.message
        });
      }
    });
  },
  getClausesOfProduct: async (rfq_product_id, vendor_id) => {
    return new Promise(async (resolve, reject) => {
      try {
        // Step 1: Validate if tbl_rfq_product_tech_evaluation_id exists
        const validateQuery = `
        SELECT id AS tbl_rfq_product_tech_evaluation_id
        FROM tbl_rfq_product_tech_evaluation
        WHERE tbl_rfq_product_id = $1;
      `;
        const validationResult = await db.query(validateQuery, [
          rfq_product_id
        ]);

        if (validationResult.length === 0) {
          return resolve({
            success: false,
            message:
              'No technical evaluation found for the given RFQ and product.'
          });
        }

        const tbl_rfq_product_tech_evaluation_id =
          validationResult[0].tbl_rfq_product_tech_evaluation_id;

        // Step 2: Check if at least one vendor response exists
        const vendorResponseQuery = `
      SELECT 1 AS has_response
      FROM tbl_rfq_product_tech_evaluation_clauses AS c
      INNER JOIN tbl_rfq_product_tech_evaluation_vendors_response AS vr
      ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
      WHERE c.tbl_rfq_product_tech_evaluation_id = $1
      ${vendor_id ? `AND vr.vendor_id = $2` : ''}
      LIMIT 1;
      `;

        const queryParams = [tbl_rfq_product_tech_evaluation_id];
        if (vendor_id) queryParams.push(vendor_id);
        const vendorResponseResult = await db.query(
          vendorResponseQuery,
          queryParams
        );

        const vendorResponse = vendorResponseResult.length > 0 ? 1 : 0;

        // Step 3: Fetch clauses and associated files
        // Changes by Agnij May 13, 2025 [Fixed clause display limitation]
        const fetchClausesQuery = `
        SELECT
          c.id AS clause_id,
          c.clause_text,
          f.file_url
        FROM
          tbl_rfq_product_tech_evaluation_clauses AS c
        LEFT JOIN
          tbl_rfq_product_tech_evaluation_clauses_files AS f
        ON
          c.id = f.tbl_rfq_product_tech_evaluation_clauses_id
        WHERE
          c.tbl_rfq_product_tech_evaluation_id = $1
        ORDER BY c.id;
      `;
        const clausesResult = await db.query(fetchClausesQuery, [
          tbl_rfq_product_tech_evaluation_id
        ]);

        // Step 4: Group clauses by clause_id
        const groupedClauses = clausesResult.reduce((acc, row) => {
          const { clause_id, clause_text, file_url } = row;
          if (!acc[clause_id]) {
            acc[clause_id] = {
              clause_id,
              clause_text,
              files: []
            };
          }
          if (file_url) {
            acc[clause_id].files.push(file_url);
          }
          return acc;
        }, {});

        // Step 5: Format the response as an array of objects
        const response = Object.keys(groupedClauses).map((key) => ({
          clause_id: parseInt(key, 10),
          clause_text: groupedClauses[key].clause_text,
          files: groupedClauses[key].files
        }));

        // console.log("Response data =", response);

        // Step 6: Add vendor_response to the final response
        resolve({
          success: true,
          vendor_response: vendorResponse,
          data: response
        });
      } catch (error) {
        reject({
          success: false,
          message: 'Error fetching clauses and files.',
          error: error.message
        });
      }
    });
  },

  getTechEvaluationResult: (tbl_rfq_product_id, vendor_id) => {
    // console.log("Entered fetchTechClearedVendors =", rfq_id, tbl_rfq_product_id, vendor_id);

    const validateVendorIdQuery = `
      SELECT id
      FROM tbl_users
      WHERE id = $1;
  `;

    const getTechEvaluationIdQuery = `
      SELECT id
      FROM tbl_rfq_product_tech_evaluation
      WHERE tbl_rfq_product_id = $1;
  `;

    const fetchClearedVendorDetailsQuery = `
  SELECT 
    RC.id, 
    RC.status, 
    RC.reject_message,
    U.name AS evaluated_by
  FROM tbl_rfq_product_tech_evaluation_cleared_vendors RC
  LEFT JOIN tbl_users U ON RC.created_by = U.id
  WHERE RC.tbl_rfq_product_tech_evaluation_id = $1 
    AND RC.vendor_id = $2;
`;

    return new Promise((resolve, reject) => {
      // console.log("Validating Vendor ID in tbl_users...");

      // Step 1: Validate Vendor ID in tbl_users
      db.query(validateVendorIdQuery, [vendor_id])
        .then((vendorValidationResult) => {
          if (!vendorValidationResult || vendorValidationResult.length === 0) {
            reject({
              status: 0,
              message: `Vendor ID ${vendor_id} does not exist in tbl_users.`
            });
            return; // Stop further execution
          }

          // console.log("Fetching Technical Evaluation ID...");

          // Step 2: Fetch the Technical Evaluation ID
          return db.query(getTechEvaluationIdQuery, [tbl_rfq_product_id]);
        })
        .then((techEvaluationResult) => {
          if (!techEvaluationResult || techEvaluationResult.length === 0) {
            return resolve({
              status: 0,
              message: `No Technical Evaluation ID found for RFQ Product ID ${tbl_rfq_product_id}.`
            });
            return; // Stop further execution
          }

          const techEvaluationId = techEvaluationResult[0].id;

          // console.log("Fetching Cleared Vendor Details...");

          // Step 3: Fetch Cleared Vendor Details
          return db.query(fetchClearedVendorDetailsQuery, [
            techEvaluationId,
            vendor_id
          ]);
        })
        .then((clearedVendorResult) => {
          if (!clearedVendorResult || clearedVendorResult.length === 0) {
            return resolve({
              status: 2,
              message: `No cleared vendor details found for Vendor ID ${vendor_id} and provided Tech Evaluation ID.`
            });
            return; // Stop further execution
          }

          // Respond with fetched data
          resolve({
            status: 1,
            message: 'Cleared vendor details fetched successfully.',
            data: clearedVendorResult[0]
          });
        })
        .catch((error) => {
          reject({
            status: 0,
            message: 'Error in fetching cleared vendor details.',
            error: error.message
          });
        });
    });
  },

  rfqProductReport: async (
    userId,
    productId,
    productName,
    startDate,
    endDate
  ) => {
    return new Promise(function (resolve, reject) {
      const query = `
      SELECT 
        T.id AS rfq_id,
        T.rfq_no,
        PV.name AS product_name,
        TP.description AS product_description,
        T.comment AS rfq_comment,
        T.company_name,
        T.contact_name,
        T.contact_number,
        T.bid_end_date,
        T.location,
        T.status AS rfq_status,
        T.timestamp AS rfq_timestamp,
        
        JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
            'spec_title', TRPS.title,
            'spec_value', TRPS.value,
            'variant', TRPS.variant
        )) AS product_specs,

        JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
            'vendor_id', TU.id,
            'vendor_name', TU.name,
            'vendor_email', TU.email,
            'vendor_mobile', TU.mobile,
            'organization_name', COALESCE(TCC4.company_name, TU.organization_name, TU.name),
            'variant', TRPV.variant,
            'quote_details', COALESCE(
                (
                    SELECT JSONB_AGG(
                        JSONB_BUILD_OBJECT(
                            'status', TQ.status,
                            'quote_id', TQ.id,
                            'is_regret', TQ.is_regret,
                            'global_payment_term', TQ.global_payment_term,
                            'global_comment', TQ.global_comment,
                            'regret_reason', TQ.regret_reason,
                            'quote_items', (
                                SELECT JSONB_AGG(
                                    JSONB_BUILD_OBJECT(
                                        'tax', TQI.tax,
                                        'comment', TQI.comment,
                                        'quantity', TQI.quantity,
                                        'unit_price', TQI.unit_price,
                                        'total_price', TQI.total_price,
                                        'product_name', TQI.product_name,
                                        'freight_price', TQI.freight_price,
                                        'package_price', TQI.package_price,
                                        'delivery_period', TQI.delivery_period
                                    )
                                )
                                FROM tbl_quote_items TQI
                                WHERE TQI.quote_id = TQ.id 
                                    AND TQI.product_variant_id = TRPV.product_variant_id
                            )
                        )
                    )
                    FROM tbl_quotes TQ
                    WHERE TQ.rfq_id = T.id 
                        AND TQ.created_by = TU.id
                ),
                JSONB_BUILD_ARRAY(
                    JSONB_BUILD_OBJECT(
                        'status', 0,
                        'quote_id', 0,
                        'is_regret', 0,
                        'global_payment_term', '',
                        'global_comment', '',
                        'regret_reason', '',
                        'quote_items', JSONB_BUILD_ARRAY(
                            JSONB_BUILD_OBJECT(
                                'tax', 0,
                                'comment', 'quote not present',
                                'quantity', '0',
                                'unit_price', 0,
                                'total_price', 0,
                                'product_name', '',
                                'freight_price', 0,
                                'package_price', 0,
                                'delivery_period', ''
                            )
                        )
                    )
                )
            )
        )) AS vendors

    FROM tbl_rfq_products TRP
    JOIN tbl_product_variant PV ON PV.id = TRP.product_variant_id
    JOIN tbl_product TP ON TP.id = PV.product_id
    JOIN tbl_rfq T ON T.id = TRP.rfq_id
    LEFT JOIN tbl_rfq_products_specs TRPS 
        ON TRPS.rfq_id = T.id AND TRPS.product_variant_id = TRP.product_variant_id
    LEFT JOIN tbl_rfq_product_vendors TRPV 
        ON TRPV.rfq_id = T.id AND TRPV.product_variant_id = TRP.product_variant_id
    LEFT JOIN tbl_users TU ON TU.id = TRPV.user_id
    LEFT JOIN tbl_company TCC4 ON TCC4.id = TU.company_id

     WHERE (
     T.created_by = $1
     OR T.project_id IN (
     SELECT project_id FROM tbl_project_team WHERE user_id = $1
     )
    )

        AND PV.id = $2
        AND ($3::date IS NULL OR T.timestamp::date >= $3::date)
        AND ($4::date IS NULL OR T.timestamp::date <= $4::date)

    GROUP BY T.id, PV.name, TP.description
    ORDER BY T.timestamp DESC;
`;

      db.query(query, [userId, productId, startDate, endDate])
        .then((data) => resolve(data))
        .catch((err) => {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  // project report including all rfq quote etc
  getProductOrVariantNameByRfqProductId: async (rfq_product_id) => {
    return new Promise(function (resolve, reject) {
      const query = `
      SELECT 
        PV.name AS variant_name,
        P.name AS product_name
      FROM tbl_rfq_products RP
      LEFT JOIN tbl_product_variant PV ON RP.product_variant_id = PV.id
      LEFT JOIN tbl_product P ON PV.product_id = P.id
      WHERE RP.id = $1
      LIMIT 1;
    `;

      db.oneOrNone(query, [rfq_product_id])
        .then(function (result) {
          if (!result) {
            resolve(null);
            return;
          }

          // Prefer the variant name if available, otherwise use product name
          const productName =
            result.variant_name || result.product_name || null;
          resolve(productName);
        })
        .catch(function (err) {
          reject(new Error(`Error fetching product name: ${err.message}`));
        });
    });
  },

  getProjectDetailsReport: async (projectId, startDate, endDate) => {
    return new Promise(function (resolve, reject) {
      const query = `SELECT
      p.id AS project_id,
      p.name AS project_name,
      p.description AS project_description,
      p.location AS project_location,
      p.status AS project_status,
      json_agg(
          json_build_object(
              'rfq_id', r.id,
              'rfq_no', r.rfq_no,
              'comment', r.comment,
              'company_name', r.company_name,
              'response_email', r.response_email,
              'contact_name', r.contact_name,
              'contact_number', r.contact_number,
              'bid_end_date', r.bid_end_date,
              'location', r.location,
              'is_published', r.is_published,
              'status', r.status,
              'rfq_type', r.rfq_type,
              'reverse_auction', r.reverse_auction,
              'rfq_files', (
                  SELECT json_agg(
                      json_build_object(
                          'file_id', f.id,
                          'file_type', f.file_type,
                          'file_url', f.file_url
                      )
                  )
                  FROM tbl_rfq_files f
                  WHERE f.rfq_id = r.id
              ),
              'terms', (
                  SELECT json_agg(
                      json_build_object(
                          'term_content', t.term_content
                      )
                  )
                  FROM tbl_rfq_terms t
                  JOIN tbl_rfq_terms_map tm ON t.id = tm.terms_id
                  WHERE tm.rfq_id = r.id
              ),
'products', (
    SELECT json_agg(
        json_build_object(
            'product_id', prod.product_variant_id,
            'product_name', tp.name,
            'comment', prod.comment,
            'datasheet', prod.datasheet,
            'spec_file', prod.spec_file,
            'qap_file', prod.qap_file,
            'datasheet_file', prod.datasheet_file,
            'variant', prod.variant,
            'product_files', (
                SELECT json_agg(
                    json_build_object(
                        'file_id', pf.id,
                        'file_type', pf.file_type,
                        'file_url', pf.file_url
                    )
                )
                FROM tbl_rfq_product_files pf
                WHERE pf.rfq_product_id = prod.id
            ),
            'specs', (
                SELECT json_agg(
                    json_build_object(
                        'title', specs.title,
                        'value', specs.value
                    )
                )
                FROM tbl_rfq_products_specs specs
                WHERE specs.rfq_id = r.id AND specs.product_variant_id = prod.product_variant_id
            ),
            'vendors', (
                SELECT json_agg(
                    json_build_object(
                        'vendor_id', v.id,
                        'vendor_name', v.name,
                        'vendor_email', v.email,
                        'vendor_mobile', v.mobile,
                        'vendor_address', v.address
                    )
                )
                FROM tbl_rfq_product_vendors pv
                JOIN tbl_users v ON pv.user_id = v.id
                WHERE pv.product_variant_id = prod.product_variant_id AND pv.rfq_id = r.id  -- Assuming a filter condition here
            )
        )
    )
    FROM tbl_rfq_products prod
    JOIN tbl_product_variant tv ON prod.product_variant_id = tv.id
    JOIN tbl_product tp ON tp.id = tv.product_id
    WHERE prod.rfq_id = r.id
)

          )
      ) AS rfq_details
  FROM
      tbl_projects p
  JOIN
      tbl_rfq r ON p.id = r.project_id
  WHERE
      p.id = $1 AND
     r.timestamp >= $2::timestamp AND
    r.timestamp < ($3::timestamp + interval '1 day')
  GROUP BY
      p.id;
  `;

      // Assuming $2 and $3 are your start and end dates respectively passed as 'YYYY-MM-DD' strings
      db.query(query, [projectId, startDate, endDate])
        .then((data) => resolve(data))
        .catch((err) => reject(new Error(err)));
    });
  },

  // Changes by Agnij April 30, 2025 [Added method to search for variant products]
  searchVariantProducts: async (search_key) => {
    // SQL query to search for products in the variant mappings table
    const q = `
    SELECT 
      pv.id AS variant_id,
      pv.name AS variant_name,
      p.id AS product_id,
      p.name AS product_name,
      p.description,
      p.slug,
      c.id AS category_id,
      c.title AS category_name,
      img.new_image_name AS image_url,
      pvvm.id AS mapping_id,
      similarity(pv.name, $1) AS similarity_score,
      ts_rank_cd(to_tsvector('english', pv.name), plainto_tsquery('english', $1)) AS rank
    FROM 
      tbl_product_variant pv
    JOIN 
      tbl_product p ON pv.product_id = p.id
    JOIN 
      tbl_product_variant_vendor_mapping pvvm ON pvvm.product_variant_id = pv.id
    JOIN 
      tbl_product_categories pc ON p.id = pc.product_id
    JOIN 
      tbl_category c ON pc.category_id = c.id
    LEFT JOIN 
      tbl_product_images img ON p.id = img.product_id AND img.is_primary = 1
    WHERE 
      p.status = 1 
      AND p.is_deleted = 0 
      AND pv.status = 1
      AND pvvm.status = 1
      AND (
        to_tsvector('english', pv.name) @@ plainto_tsquery('english', $1) 
        OR similarity(pv.name, $1) > 0.1
        OR to_tsvector('english', p.name) @@ plainto_tsquery('english', $1)
        OR similarity(p.name, $1) > 0.1
      )
    GROUP BY 
      pv.id, p.id, c.id, img.new_image_name, pvvm.id
    ORDER BY 
      rank DESC, similarity_score DESC
    LIMIT 50;
  `;

    try {
      const { rows } = await db.query(q, [search_key]);
      return rows;
    } catch (error) {
      console.error(error.stack);
      // Return empty array instead of throwing error to avoid breaking the API response
      return [];
    }
  },

  // Changes by Agnij May 01, 2025 [Added method to search for variant vendors]
  searchVariantVendors: async (product_id, variant_id) => {
    console.log(
      `[RFQ Model] searchVariantVendors called with product_id: ${product_id}, variant_id: ${variant_id}`
    );

    // SQL query to find vendors associated with a product variant
    const q = `
    SELECT 
      u.id AS vendor_id,
      COALESCE(c.company_name, u.organization_name, u.name) AS vendor_name,
      CONCAT(COALESCE(c.company_name, u.organization_name, u.name), ' (', u.name, ')') AS vendor_display_name,
      u.email AS vendor_email,
      u.city,
      u.state,
      pvvm.id AS mapping_id,
      pvvm.created_at AS mapped_at
    FROM 
      tbl_product_variant_vendor_mapping pvvm
    JOIN 
      tbl_users u ON pvvm.vendor_id = u.id
    LEFT JOIN 
      tbl_company c ON c.id = u.company_id
    JOIN 
      tbl_product_variant pv ON pvvm.product_variant_id = pv.id
    WHERE 
      pvvm.status = TRUE
      AND pvvm.is_approved = TRUE
      AND u.status = 1
      AND u.is_deleted = 0
      AND ${variant_id ? 'pvvm.product_variant_id = $1' : 'pv.product_id = $1'}
    ORDER BY 
      COALESCE(c.company_name, u.organization_name, u.name) ASC;
  `;

    try {
      console.log(
        `[RFQ Model] Executing variant vendors search query for ${
          variant_id ? 'variant' : 'product'
        } ID: ${variant_id || product_id}`
      );
      const { rows } = await db.query(q, [variant_id || product_id]);
      console.log(
        `[RFQ Model] searchVariantVendors found ${rows.length} results`
      );
      return rows;
    } catch (error) {
      console.error(
        '[RFQ Model] Error in searchVariantVendors:',
        error.message
      );
      console.error(error.stack);
      // Return empty array instead of throwing error to avoid breaking the API response
      return [];
    }
  },

  /**
   * @mukul_jatav 11/07/2025
   * Reason for Changes:
   * - To optimize query performance and reduce payload size.
   * - To remove unnecessary or heavy data from the RFQ draft listing view.
   * Changes Made:
   * - Removed: tbl_query_messages and tbl_rfq_products_specs (not needed for drafts).
   * - Trimmed product_details: Only fetch basic product info (id, name) from tbl_product_variant.
   * - Limited products array: Return only 2 products per RFQ to minimize response time and frontend load.
   *
   * @PENDING injection protection
   */
  getAllDraftRfqs: async (
    limit,
    offset,
    user_id,
    project_id,
    sort,
    reverse_auction,
    rfq_type,
    rfq_no
  ) => {
    return new Promise(function (resolve, reject) {
      let q = `
      SELECT
        RFQ.*,
        P.name AS project_name, -- Fetch project_name using project_id from tbl_projects
        ARRAY(
            SELECT json_build_object(
                'id', RFQ_P.id, 
                'product_id', RFQ_P.product_variant_id,
                  'product_details', (
                      SELECT json_agg(json_build_object(
                          'id', T_P.id,
                          'name', T_P.name))
                      FROM tbl_product_variant T_P
                      WHERE RFQ_P.product_variant_id = T_P.id
                  )
              )
              FROM tbl_rfq_products RFQ_P
              WHERE RFQ.id = RFQ_P.rfq_id
              LIMIT 3
          ) AS "products"
      FROM tbl_rfq RFQ
      LEFT JOIN tbl_projects P ON RFQ.project_id = P.id  -- Join on project_id to get project_name
      WHERE (
        RFQ.created_by = ${user_id}
        OR RFQ.project_id IN (
          SELECT project_id FROM tbl_project_team WHERE user_id = ${user_id}
        )
      ) AND RFQ.is_published = 0
      ${project_id == -1 ? '' : ` AND RFQ.project_id = ${project_id}`}
      ${rfq_type == '' ? '' : ` AND RFQ.rfq_type = '${rfq_type}'`}
      ${
        reverse_auction == '-1'
          ? ''
          : ` AND RFQ.reverse_auction = ${reverse_auction}`
      }
      ${
        rfq_no == null ? '' : ` AND CAST(RFQ.rfq_no AS TEXT) LIKE '%${rfq_no}%'`
      }
      ORDER BY RFQ.id ${sort ? sort : 'ASC'} LIMIT ${limit} OFFSET ${offset}`;

      const countQuery = `
        SELECT COUNT(*) AS total_count
        FROM tbl_rfq RFQ
        WHERE RFQ.created_by = ${user_id} AND RFQ.is_published = 0
        ${project_id == -1 ? '' : ` AND RFQ.project_id = ${project_id}`}
        ${rfq_type == '' ? '' : ` AND RFQ.rfq_type = '${rfq_type}'`}
        ${
          reverse_auction == '-1'
            ? ''
            : ` AND RFQ.reverse_auction = ${reverse_auction}`
        }
        ${
          rfq_no == null
            ? ''
            : ` AND CAST(RFQ.rfq_no AS TEXT) LIKE '%${rfq_no}%'`
        }
      `;

      db.tx((t) => {
        return t.batch([db.query(q), db.query(countQuery)]);
      })
        .then(([data, countResult]) => {
          resolve({
            data: data,
            total_count: countResult[0].total_count
          });
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getAllProcessingRfqs: async (limit, offset, user_id, sort) => {
    return new Promise(function (resolve, reject) {
      let q = `
      SELECT
        RPJ.*,
        RFQ.is_published
      FROM tbl_rfq_persistent_jobs RPJ
      LEFT JOIN tbl_rfq RFQ ON RFQ.id = RPJ.persisted_rfq_id
      WHERE RPJ.user_id = ${user_id}
      ORDER BY started_at ${
        sort ? sort : 'ASC'
      } LIMIT ${limit} OFFSET ${offset}`;

      const countQuery = `
        SELECT COUNT(*) AS total_count
        FROM tbl_rfq_persistent_jobs RPJ
        WHERE RPJ.user_id = ${user_id}
      `;

      db.tx((t) => {
        return t.batch([db.query(q), db.query(countQuery)]);
      })
        .then(([data, countResult]) => {
          resolve({
            data: data,
            total_count: countResult[0].total_count
          });
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  //New Model added By Ayush For Fetching Vendors Associated with a particular product in an RFQ
  searchEmailAndNameForVendor: async (rfq_id, product_id) => {
    const query = `
    SELECT 
      tbu.id AS vendor_id,
      tbu.name, 
      tbu.email,
      tpv.name AS product_name
    FROM tbl_rfq_product_vendors trpv
    JOIN tbl_rfq_products trp 
      ON trp.product_variant_id = trpv.product_variant_id 
      AND trp.variant = trpv.variant
    JOIN tbl_product_variant tpv 
      ON trp.product_variant_id = tpv.id 
    JOIN tbl_users tbu 
      ON tbu.id = trpv.user_id
    WHERE trpv.rfq_id = $1 AND trp.id = $2
  `;

    const result = await db.query(query, [rfq_id, product_id]);

    return result || [];
  },

  getLprLqrByVariantId: async (user_id, variant_id, type) => {
    const validTypes = ['lpr', 'lqr'];
    if (!validTypes.includes(type)) {
      throw new Error(
        `Invalid type "${type}" - must be one of: ${validTypes.join(', ')}`
      );
    }

    const buyer = await db.oneOrNone(
      'SELECT company_id FROM tbl_users WHERE id = $1',
      [user_id]
    );
    if (!buyer || !buyer.company_id)
      throw new Error('Buyer not found or no company associated');
    const companyId = buyer.company_id;

    const queries = {
      lpr: `
              SELECT 
                  TQI.package_price,
                  TQI.package_mode,
                  TQI.tax,
                  TQI.tax_mode,
                  TQI.freight_price,
                  TQI.freight_mode,
                  TQI.total_price,
                  TQI.quantity,
                  TQI.product_name,
                  TU.name AS vendor_name,
                  TU.email AS vendor_email,
                  TQF.timestamp AS quote_date,
                  TQI.rfq_no,
                  TQI.unit_price,
                  FINALIZER.name AS created_by
                  FROM tbl_quote_items TQI
                  JOIN tbl_quote_finalization TQF ON TQI.quote_id = TQF.quote_id 
                    AND TQI.product_variant_id = TQF.product_variant_id 
                    AND TQI.variant = TQF.variant
                  JOIN tbl_quotes TQ ON TQ.id = TQF.quote_id
                  JOIN tbl_users TU ON TQ.created_by = TU.id
                  JOIN tbl_rfq RFQ ON RFQ.id = TQ.rfq_id
                  JOIN tbl_users FINALIZER ON FINALIZER.id = TQF.created_by
                  WHERE TQF.created_by IN (SELECT id FROM tbl_users WHERE company_id = ${companyId} AND user_type IN (2,8,10))
                    AND TQI.product_variant_id = $1
                  ORDER BY TQF.timestamp DESC;
        `,
      lqr: `
            SELECT 
                TQI.unit_price,
                TQI.package_price,
                TQI.tax,
                TQI.freight_price,
                TQI.package_mode,
                TQI.tax_mode,
                TQI.freight_mode,
                TQI.total_price,
                TQI.quantity,
                TQI.product_name,
                TQI.rfq_no,
                TQ.timestamp AS quote_date,
                U.name AS vendor_name,       -- ✅ User's name
                U.email AS vendor_email,      -- ✅ User's email
                COALESCE(FINALIZER.name, BUYER.name) AS created_by
            FROM tbl_rfq RFQ
            JOIN tbl_quotes TQ ON RFQ.id = TQ.rfq_id
            JOIN tbl_quote_items TQI ON TQ.id = TQI.quote_id
            JOIN tbl_users U ON TQ.created_by = U.id    -- ✅ Join with tbl_user
            JOIN tbl_users BUYER ON BUYER.id = RFQ.created_by
            LEFT JOIN tbl_quote_finalization TQF ON TQF.quote_id = TQ.id 
              AND TQF.product_variant_id = TQI.product_variant_id 
              AND TQF.variant = TQI.variant
            LEFT JOIN tbl_users FINALIZER ON FINALIZER.id = TQF.created_by
            WHERE RFQ.created_by IN (SELECT id FROM tbl_users WHERE company_id = ${companyId} AND user_type IN (2,3 ,8,10))
              AND TQI.product_variant_id = $1
              AND TQI.unit_price > 0
            ORDER BY TQ.timestamp DESC;

        `
    };
    try {
      const result = await db.query(queries[type], [variant_id]);
      if (result.length > 0) return result;
      else return [];
    } catch (error) {
      console.error(`[MODEL ERROR] Failed to execute ${type} query:`, error);
      throw error;
    }
  },

  getQuoteHistoryForvendor : async (user_id, variant_id) => {
    const query = `
    SELECT 
    tqi.*, 
    tu.name AS buyer_name, 
    tq.timestamp
FROM tbl_quote_items tqi
JOIN tbl_quotes tq ON tq.id = tqi.quote_id
JOIN tbl_rfq rfq ON tq.rfq_id = rfq.id
JOIN tbl_users tu ON tu.id = rfq.created_by
WHERE tq.created_by = $1 
  AND tqi.product_variant_id = $2
ORDER BY tq.timestamp DESC;
    `;
    try {
      const result = await db.query(query, [user_id, variant_id]);
      if (result.length > 0) return result;
      else return [];
    } catch (error) {
      console.error(`[MODEL ERROR] Failed to execute quote history query:`, error);
      throw error;
    }
  },

  getTargetPriceHistory: async (rfq_product_id, created_by, limit = null) => {
    return new Promise(async (resolve, reject) => {
      let query = `
      SELECT * FROM tbl_rfq_product_target_price
      WHERE tbl_rfq_product_id = $1
      AND created_by = $2
      ORDER BY created_at DESC
    `;

      // Add limit conditionally
      if (limit === 1) {
        query += ` LIMIT 1`;
      }

      try {
        const data = await db.any(query, [rfq_product_id, created_by]);

        if (data.length === 0) {
          resolve({
            success: false,
            message:
              'No target price history found for the given RFQ product and user.'
          });
          return;
        }

        resolve(data);
      } catch (error) {
        reject(error);
      }
    });
  },

  getVendorsForReminder: async (
    rfq_id,
    vendorIds = [],
    options = {}
  ) => {
    const { includeContactDetails = false } = options;
    const params = [rfq_id];

    let vendorFilterClause = '';
    if (Array.isArray(vendorIds) && vendorIds.length) {
      params.push(vendorIds);
      vendorFilterClause = `AND vendor_list.user_id = ANY($${params.length}::int[])`;
    }

    const spocCte = includeContactDetails
      ? `,
    spoc_data AS (
      SELECT 
        user_id,
        jsonb_agg(
          jsonb_build_object(
            'name', s.name,
            'email', s.email,
            'mobile', s.mobile
          )
        ) FILTER (WHERE s.id IS NOT NULL) AS spoc_list
      FROM tbl_users_spoc s
      WHERE s.is_deleted IS NULL OR s.is_deleted = 0
      GROUP BY user_id
    ),
    token_data AS (
      SELECT vendor_id, token
      FROM tbl_vendor_rfq_tokens_non_login
      WHERE rfq_no = $1
    )`
      : '';

    const contactSelect = includeContactDetails
      ? `
      u.email,
      u.mobile,
      u.organization_name,
      u.endpoint,
      u.user_type,
      COALESCE(sd.spoc_list, '[]'::jsonb) AS spocs,
      td.token as reminder_token,`
      : `
      NULL::text as email,
      NULL::text as mobile,
      NULL::text as organization_name,
      NULL::text as endpoint,
      NULL::int as user_type,
      '[]'::jsonb AS spocs,
      NULL::bigint as reminder_token,`;

    const contactJoins = includeContactDetails
      ? `
    LEFT JOIN spoc_data sd ON sd.user_id = vendor_list.user_id
    LEFT JOIN token_data td ON td.vendor_id = vendor_list.user_id`
      : '';

    const contactGroupBy = includeContactDetails
      ? ', u.email, u.mobile, u.organization_name, u.endpoint, u.user_type, sd.spoc_list, td.token'
      : '';

    const query = `
    WITH rfq_data AS (
      SELECT 
        r.id, r.company_name, r.rfq_no, r.status,
        r.created_by, r.timestamp, r.bid_end_date
      FROM tbl_rfq r 
      WHERE r.id = $1
    ),
    vendor_products AS (
      SELECT DISTINCT
        rpv.user_id,
        rp.product_variant_id,
        pv.name as product_name,
        rpv.variant,
        rpv.id as rfq_product_vendor_id
      FROM tbl_rfq_product_vendors rpv
      JOIN tbl_rfq_products rp ON rp.rfq_id = rpv.rfq_id 
        AND rp.product_variant_id = rpv.product_variant_id 
        AND rp.variant = rpv.variant
      JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
      WHERE rpv.rfq_id = $1
    ),
    quoted_products AS (
      SELECT DISTINCT
        q.created_by as user_id,
        qi.product_variant_id,
        qi.variant
      FROM tbl_quotes q
      JOIN tbl_quote_items qi ON qi.quote_id = q.id
      WHERE q.rfq_id = $1
        AND q.is_regret = 0
        AND (qi.unit_price != 0 
             OR (qi.comment IS NOT NULL AND qi.comment != '') 
             OR (qi.delivery_period IS NOT NULL AND qi.delivery_period != '') 
             OR EXISTS(SELECT 1 FROM tbl_quote_item_files qif WHERE qif.quote_item_id = qi.id))
    ),
    regret_vendors AS (
      SELECT DISTINCT created_by as user_id
      FROM tbl_quotes 
      WHERE rfq_id = $1 AND is_regret = 1
    )${spocCte}
    SELECT 
      rd.id as rfq_id,
      rd.company_name,
      rd.rfq_no,
      rd.status as rfq_status,

      rd.timestamp as rfq_timestamp,
      rd.bid_end_date as rfq_deadline,
      u.id as user_id,
      COALESCE(u.organization_name, u.name) as vendor_name,
      MIN(vp.rfq_product_vendor_id) as rfq_product_vendor_id,
      ${contactSelect}
      json_agg(
        json_build_object(
          'product_id', vp.product_variant_id,
          'name', vp.product_name,
          'variant', vp.variant,
          'rfq_product_vendor_id', vp.rfq_product_vendor_id
        )
      ) FILTER (WHERE vp.product_variant_id IS NOT NULL) as remaining_products
    FROM rfq_data rd
    CROSS JOIN (
      SELECT DISTINCT user_id 
      FROM vendor_products
    ) vendor_list
    JOIN tbl_users u ON u.id = vendor_list.user_id
    LEFT JOIN vendor_products vp ON vp.user_id = vendor_list.user_id
      AND NOT EXISTS (
        SELECT 1 FROM quoted_products qp 
        WHERE qp.user_id = vp.user_id 
          AND qp.product_variant_id = vp.product_variant_id 
          AND qp.variant = vp.variant
      )
    LEFT JOIN regret_vendors rv ON rv.user_id = vendor_list.user_id
    ${contactJoins}
    WHERE rv.user_id IS NULL
      AND u.status = 1
      AND u.is_deleted = 0
      ${vendorFilterClause}
    GROUP BY rd.id, rd.company_name, rd.rfq_no, rd.status, 
             rd.timestamp, rd.bid_end_date, u.id, u.organization_name, u.name${contactGroupBy}
    HAVING count(vp.product_variant_id) > 0
    ORDER BY vendor_name;
  `;

    try {
      const result = await db.query(query, params);

      if (result.length === 0) {
        return { rfq_details: null, vendors: [] };
      }

      const rfq_details = {
        id: result[0].rfq_id,
        company_name: result[0].company_name,
        rfq_no: result[0].rfq_no,
        status: result[0].rfq_status,

        timestamp: result[0].rfq_timestamp,
        bid_end_date: result[0].rfq_deadline
      };

      const vendors = result.map((row) => ({
        user_id: row.user_id,
        vendor_name: row.vendor_name,
        rfq_product_vendor_id: row.rfq_product_vendor_id || null,
        email: row.email || null,
        mobile: row.mobile || null,
        organization_name: row.organization_name || null,
        endpoint: row.endpoint || null,
        user_type: row.user_type || null,
        spocs: row.spocs || [],
        token: row.reminder_token || null,
        remainingProducts: row.remaining_products || []
      }));

      return { rfq_details, vendors };
    } catch (error) {
      throw error;
    }
  },

  ensureVendorTokens: async (rfq_id, vendorIds = []) => {
    if (!Array.isArray(vendorIds) || !vendorIds.length) return [];

    const uniqueVendorIds = Array.from(new Set(vendorIds));

    const existingTokens = await db.query(
      `SELECT vendor_id, token 
       FROM tbl_vendor_rfq_tokens_non_login 
       WHERE rfq_no = $1 AND vendor_id = ANY($2::int[])`,
      [rfq_id, uniqueVendorIds]
    );

    const tokensMap = new Map(
      existingTokens.map((row) => [row.vendor_id, row.token])
    );

    const missingVendorIds = uniqueVendorIds.filter(
      (id) => !tokensMap.has(id)
    );

    if (missingVendorIds.length) {
      const tokenRecords = missingVendorIds.map((vendor_id) => ({
        token: generateReminderTokenValue(),
        vendor_id,
        rfq_no: rfq_id
      }));

      const insertQuery =
        pgp.helpers.insert(
          tokenRecords,
          ['token', 'vendor_id', 'rfq_no'],
          'tbl_vendor_rfq_tokens_non_login'
        ) +
        ' ON CONFLICT (vendor_id, rfq_no) DO NOTHING RETURNING vendor_id, token';

      const insertedRows = await db.any(insertQuery);
      insertedRows.forEach((row) => tokensMap.set(row.vendor_id, row.token));

      const stillMissing = missingVendorIds.filter(
        (id) => !tokensMap.has(id)
      );

      if (stillMissing.length) {
        const fallbackRows = await db.query(
          `SELECT vendor_id, token 
           FROM tbl_vendor_rfq_tokens_non_login 
           WHERE rfq_no = $1 AND vendor_id = ANY($2::int[])`,
          [rfq_id, stillMissing]
        );
        fallbackRows.forEach((row) => tokensMap.set(row.vendor_id, row.token));
      }
    }

    return Array.from(tokensMap.entries()).map(([vendor_id, token]) => ({
      vendor_id,
      token
    }));
  },
  // New optimized method for sidebar data
  getRfqs: async (
    user_id,
    user_type,
    tech_eval,
    po,
    limit,
    offset,
    project_id,
    rfq_no,
    sort
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicJoins = '';
      let dynamicConditions = '';

      if (tech_eval) {
        dynamicJoins +=
          'JOIN tbl_rfq_product_tech_evaluation RFQ_T_E ON RFQ.id = RFQ_T_E.rfq_id';
        dynamicConditions +=
          'GROUP BY RFQ.id, P.name HAVING COUNT(RFQ_T_E.id) > 0';
      }

      if (po) {
        if(user_type == 3) {
          dynamicJoins += 
           `JOIN tbl_rfq_purchase_order TRPO ON RFQ.id = TRPO.rfq_id AND TRPO.finalized_vendor_id = ${user_id}`
        } else {
          dynamicJoins +=
            'JOIN tbl_rfq_purchase_order TRPO ON RFQ.id = TRPO.rfq_id';
        }
      }

      let q = `
      SELECT
        DISTINCT
        RFQ.id,
        RFQ.rfq_no,
        RFQ.timestamp,
        (
          SELECT
            CASE
              WHEN COUNT(*) = 0 THEN false
              ELSE
                (
                  SELECT COUNT(*) 
                    FROM tbl_rfq_products _rpv 
                    WHERE _rpv.rfq_id = RFQ.id
                ) = (
                  SELECT COUNT(*)
                    FROM tbl_quote_finalization tqf2
                    WHERE tqf2.rfq_id = RFQ.id
                )
            END
          FROM tbl_quotes tq
          WHERE tq.rfq_id = RFQ.id
        ) AS is_finalized,
        P.name AS project_name,
        RFQ.company_name,
        RFQ.contact_name,
        RFQ.response_email,
        RFQ.contact_number,
        RFQ.bid_end_date,
        RFQ.reverse_auction
      FROM tbl_rfq RFQ
      LEFT JOIN tbl_projects P ON RFQ.project_id = P.id
      ${dynamicJoins}
      WHERE (${
        user_type == 3
          ? `EXISTS (SELECT 1 FROM tbl_rfq_product_vendors WHERE rfq_id = RFQ.id AND user_id = ${user_id})`
          : `RFQ.created_by = ${user_id}`
      } OR EXISTS (
        ${
          po
            ? `
          SELECT 1 
            FROM tbl_company TC 
            JOIN tbl_users _TU ON _TU.id = RFQ.created_by 
            JOIN tbl_users _TU1 ON _TU1.id = ${user_id} 
            WHERE _TU.company_id = _TU1.company_id
          `
            : `
          SELECT 1 FROM tbl_project_team PT WHERE PT.project_id = RFQ.project_id AND PT.user_id = ${user_id}
          `
        }
      )) AND RFQ.is_published = 1
      ${
        !tech_eval
          ? `
        AND EXISTS (
          SELECT 1 FROM tbl_quotes ITQ
          WHERE ITQ.rfq_id = RFQ.id
        )
        `
          : ''
      }
      AND (RFQ.project_id = $1 OR $1 IS NULL)
      AND (RFQ.rfq_no::text LIKE '%$4%' OR $4 IS NULL)
      ${dynamicConditions}
      ORDER BY RFQ.timestamp ${sort || 'DESC'}
      LIMIT $3 OFFSET $2;`;

      db.any(q, [project_id, offset, limit, rfq_no])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getPricehistory: async (rfq_product_id) => {
    return new Promise((resolve, reject) => {
      try {
        const query = `
      SELECT * 
      FROM tbl_rfq_product_target_price
      WHERE tbl_rfq_product_id = $1
      ORDER BY created_at DESC
    `;
        const result = db.any(query, [rfq_product_id]);

        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  },
  getRfqProductvendorsForTargetPrice: async (rfq_product_id, vendorIds) => {
    return new Promise(function (resolve, reject) {
      try {
        const query = `
        WITH rfq_info AS (
          SELECT rfq_id, product_variant_id 
          FROM tbl_rfq_products
          WHERE id = $1
        ),
        valid_quotes AS (
          SELECT q.created_by, r.product_variant_id, r.rfq_id
          FROM tbl_quotes q
          JOIN rfq_info r ON q.rfq_id = r.rfq_id
          WHERE (q.is_regret IS NULL OR q.is_regret != 1)
        ),
        vendor_filter AS (
          SELECT DISTINCT vendor_id
          FROM tbl_rfq_product_target_price
          WHERE vendor_id = ANY($2::int[])
        )
        SELECT 
          pv.name AS productname,
          v.rfq_id,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', u.id,
              'name', u.name,
              'email', u.email,
              'company_name', c.company_name
            )
          ) AS created_by
        FROM valid_quotes v
        JOIN vendor_filter vf ON vf.vendor_id = v.created_by
        JOIN tbl_users u ON u.id = v.created_by
        JOIN tbl_company c ON c.id = u.company_id
        JOIN tbl_product_variant pv ON pv.id = v.product_variant_id
        GROUP BY pv.name, v.rfq_id;
      `;

        db.any(query, [rfq_product_id, vendorIds])
          .then((data) => {
            if (data.length === 0) {
              resolve({
                success: false,
                message: 'No vendors found for the given criteria.',
                data: []
              });
              return;
            }
            resolve(data);
          })
          .catch((error) => {
            reject(error);
          });
      } catch (err) {
        reject(err);
      }
    });
  },

  saveExcel: async (rfq_id, user_id, file_path) => {
    return new Promise(function (resolve, reject) {
      let q = `
      INSERT INTO tbl_rfq_quote_excel (rfq_id, user_id, downloaded_excel)
        VALUES($1, $2, $3)
    `;

      db.any(q, [rfq_id, user_id, file_path])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  // This function will delete all the entries from all the rfq related tables
  // for sheets other than the specified one
  removeRFQData: async (id, selectedSheets) => {
    try {
      if (!Array.isArray(selectedSheets) || selectedSheets.length <= 0)
        return false;

      return db.tx(async (t) => {
        // Delete RFQ-related records
        await t.none(
          `DELETE FROM tbl_rfq_products WHERE rfq_id = $1 AND sheet_id NOT IN (${selectedSheets.join(
            ','
          )})`,
          id
        );

        await t.none(
          `DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = $1 AND sheet_id NOT IN (${selectedSheets.join(
            ','
          )})`,
          id
        );
        await t.none(
          `DELETE FROM tbl_rfq_products_specs WHERE rfq_id = $1 AND sheet_id NOT IN (${selectedSheets.join(
            ','
          )})`,
          id
        );
        await db.none(
          `
          DELETE FROM tbl_rfq_product_files  AS f
          USING  tbl_rfq_products            AS p
          WHERE  p.id       = f.rfq_product_id
            AND  p.rfq_id   = $1
            AND  p.sheet_id <> ALL($2)
        `,
          [id, selectedSheets]
        );

        // Delete tech evaluations and associated data
        const techEvaluationCondition = { rfq_id: id };
        const techEvaluationDeletedRecordsIds =
          await rfqModel.deleteWithReturnIds(
            'tbl_rfq_product_tech_evaluation',
            techEvaluationCondition,
            null,
            { key: 'sheet_id', value: selectedSheets },
            t
          );

        let techEvalClauseFilesId = [];

        if (
          Array.isArray(techEvaluationDeletedRecordsIds) &&
          techEvaluationDeletedRecordsIds.length > 0
        ) {
          for (const evaluationClauseId of techEvaluationDeletedRecordsIds) {
            const clauseCondition = {
              tbl_rfq_product_tech_evaluation_id: evaluationClauseId
            };

            const clauseFiles = await rfqModel.deleteWithReturnIds(
              'tbl_rfq_product_tech_evaluation_clauses',
              clauseCondition,
              t
            );

            if (Array.isArray(clauseFiles) && clauseFiles.length > 0) {
              techEvalClauseFilesId.push(...clauseFiles);
            }
          }
        }

        // Delete clause files
        if (techEvalClauseFilesId.length > 0) {
          for (const techEvalClauseFileId of techEvalClauseFilesId) {
            const clauseFileCondition = {
              tbl_rfq_product_tech_evaluation_clauses_id: techEvalClauseFileId
            };

            await rfqModel.delete(
              'tbl_rfq_product_tech_evaluation_clauses_files',
              clauseFileCondition,
              t
            );
          }
        }

        // Finally Delete all the sheets
        await rfqModel.delete('tbl_rfq_draft_sheets', { rfq_id: id }, t);

        return true;
      });
    } catch (error) {
      throw error;
    }
  },

  getDraftPOByVendor: async (vendor_id, rfq_id, initiator) => {
    try {
      const existings = await db.any(
        `SELECT PO.* FROM tbl_rfq_purchase_order PO WHERE status = $1 AND finalized_vendor_id = $2 AND rfq_id = $3`, 
        [PO_STATUSES.DRAFT, vendor_id, rfq_id, initiator.company_id]
      );

      return existings;
    } catch (error) {
      throw error;
    }
  }
};
export default rfqModel;