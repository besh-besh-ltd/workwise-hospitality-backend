import db, { pgp } from '../config/dbConn.js';
import Config from '../config/app.config.js';
import generalModel, { getApprovalInstanceDetails, findBestMatchingPolicy, resolveApprovers, roleHasReadAndApprovePermission, ENTITY_APPROVE_RESOURCE_MAP } from './generalModel.js';
import userModel from './userModel.js';
import cmsModel from './cmsModel.js';
import { logError, PERSISTENCE_STATUSES } from '../helper/common.js';
import { logger } from '../util/logger.js';
import { notifyBuyerOnPersistenceViaEmail } from '../controllers/rfq/rfqController.js';
import { PO_STATUSES } from '../util/constants.js';
import rbacModel from './rbacModel.js';


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
      logger.debug({ data: res }, '[getVariantsCountForRFQ] result');

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

  checkProductVendors: async (rfq_id, selectedSheets) => {
    try {
      const sheetFilter = (selectedSheets && Array.isArray(selectedSheets) && selectedSheets.length > 0)
        ? `AND rp.sheet_id IN (${selectedSheets.map(Number).join(',')})` : '';
      const rows = await db.any(`
        SELECT rp.id, COALESCE(pv.name, 'Product ' || rp.id) AS product_name
        FROM tbl_rfq_products rp
        LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
        WHERE rp.rfq_id = $1 ${sheetFilter}
          AND NOT EXISTS (
            SELECT 1 FROM tbl_rfq_product_vendors rpv
            WHERE rpv.rfq_id = rp.rfq_id
              AND rpv.product_variant_id = rp.product_variant_id
              AND rpv.variant = rp.variant
          )
      `, [rfq_id]);
      return rows;
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
      logError('persistAIJobInDB failed', error);
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

          // Always include time so later edits don't create artificial diffs
          const formattedDate = nextMonth.toISOString().split('T')[0] + 'T00:00:00';

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

            await t.none(
              `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, variant, user_id, sheet_id)
              VALUES ($1, $2, $3, $4, $5)`,
              [rfq_id, product.product_id, product.variant, userId, sheet.id]
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
      logError('Transaction failed. All operations rolled back.', error);
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
      logError('Transaction failed. All operations rolled back.', error);
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

  // ─────────────────────────────────────────────────────────────────────────
  // WH-69: Denormalised RFQ read used by the snapshot-diff update flow.
  //
  // Returns one object containing every field that the edit page can change,
  // shaped exactly like the snapshot the frontend sends back. The diff helper
  // compares the two by walking the same keys.
  //
  // Hotels are exposed read-only (display-only on the edit page).
  // Returns null if the RFQ does not exist.
  // ─────────────────────────────────────────────────────────────────────────
  getFullRfqForEdit: async (rfq_id, db_con = db) => {
    const rfq = await db_con.oneOrNone(
      `SELECT
         id, rfq_no, title, comment, response_email, contact_name, contact_number,
         bid_end_date, location, is_published, created_by, status, rfq_type,
         tender_publish_date, vendor_clarification_date, tender_fees, reverse_auction,
         is_tender, ra_start_date, ra_end_date, project_id, hospitality_company_id,
         hotel_id, department_id, process_id, technical_evaluation_by, company_name
       FROM tbl_rfq
       WHERE id = $1`,
      [rfq_id]
    );
    if (!rfq) return null;

    const [hotelRows, termRows, productRows] = await Promise.all([
      db_con.any(
        `SELECT hotel_id FROM tbl_rfq_hotel_mappings WHERE rfq_id = $1 ORDER BY hotel_id`,
        [rfq_id]
      ),
      db_con.any(
        `SELECT terms_id FROM tbl_rfq_terms_map WHERE rfq_id = $1 ORDER BY terms_id`,
        [rfq_id]
      ),
      db_con.any(
        `SELECT
           rp.id,
           rp.product_variant_id,
           rp.variant,
           rp.comment,
           pv.name AS product_name
         FROM tbl_rfq_products rp
         LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
         WHERE rp.rfq_id = $1
         ORDER BY rp.id`,
        [rfq_id]
      )
    ]);

    // Load specs / files / vendors for all products in three batched queries
    let specsByKey = {};
    let filesByProduct = {};
    let vendorsByKey = {};
    let techEvalByProduct = {};

    if (productRows.length > 0) {
      const productIds = productRows.map((p) => p.id);

      const [specRows, fileRows, vendorRows, techRows] = await Promise.all([
        db_con.any(
          `SELECT rfq_id, product_variant_id, variant, title, value
           FROM tbl_rfq_products_specs
           WHERE rfq_id = $1`,
          [rfq_id]
        ),
        db_con.any(
          `SELECT rfq_product_id, file_type, file_url
           FROM tbl_rfq_product_files
           WHERE rfq_product_id = ANY($1::int[])
           ORDER BY id`,
          [productIds]
        ),
        db_con.any(
          `SELECT rpv.product_variant_id, rpv.variant, rpv.user_id,
                  u.name, u.email
           FROM tbl_rfq_product_vendors rpv
           LEFT JOIN tbl_users u ON u.id = rpv.user_id
           WHERE rpv.rfq_id = $1
           ORDER BY rpv.user_id`,
          [rfq_id]
        ),
        db_con.any(
          `SELECT te.tbl_rfq_product_id AS rfq_product_id,
                  json_agg(
                    json_build_object(
                      'id', tec.id,
                      'clause_text', tec.clause_text,
                      'clause_type', tec.clause_type,
                      'weightage', tec.weightage
                    ) ORDER BY tec.id
                  ) FILTER (WHERE tec.id IS NOT NULL) AS clauses
           FROM tbl_rfq_product_tech_evaluation te
           LEFT JOIN tbl_rfq_product_tech_evaluation_clauses tec
             ON tec.tbl_rfq_product_tech_evaluation_id = te.id
           WHERE te.rfq_id = $1
           GROUP BY te.tbl_rfq_product_id`,
          [rfq_id]
        )
      ]);

      // Specs are keyed by product_variant_id+variant
      for (const s of specRows) {
        const k = `${s.product_variant_id}:${s.variant}`;
        if (!specsByKey[k]) specsByKey[k] = {};
        specsByKey[k][s.title] = s.value;
      }

      // Files keyed by rfq_product_id with categorised buckets
      for (const f of fileRows) {
        if (!filesByProduct[f.rfq_product_id]) {
          filesByProduct[f.rfq_product_id] = {
            qap_file: [],
            spec_file: [],
            datasheet_file: []
          };
        }
        const bucket =
          f.file_type === 'QAP' ? 'qap_file'
          : f.file_type === 'SPEC' ? 'spec_file'
          : f.file_type === 'TDS' ? 'datasheet_file'
          : null;
        if (bucket) filesByProduct[f.rfq_product_id][bucket].push(f.file_url);
      }

      // Vendors keyed by product_variant_id+variant
      for (const v of vendorRows) {
        const k = `${v.product_variant_id}:${v.variant}`;
        if (!vendorsByKey[k]) vendorsByKey[k] = [];
        vendorsByKey[k].push({
          user_id: v.user_id,
          name: v.name,
          email: v.email
        });
      }

      for (const t of techRows) {
        techEvalByProduct[t.rfq_product_id] = t.clauses || [];
      }
    }

    const products = productRows.map((p) => {
      const key = `${p.product_variant_id}:${p.variant}`;
      return {
        id: p.id,
        product_variant_id: p.product_variant_id,
        variant: p.variant,
        product_name: p.product_name,
        comment: p.comment ?? '',
        specs: specsByKey[key] || {},
        files: filesByProduct[p.id] || {
          qap_file: [],
          spec_file: [],
          datasheet_file: []
        },
        vendors: vendorsByKey[key] || [],
        tech_eval_clauses: techEvalByProduct[p.id] || []
      };
    });

    return {
      ...rfq,
      hotel_ids: hotelRows.map((h) => h.hotel_id),
      terms: termRows.map((t) => t.terms_id),
      products
    };
  },


  //  mukul need to delete
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
      logError(`Error deleting from ${table}`, error);
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
          logError(`Error deleting from ${table}`, error);
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
      logError(`Error finding all from ${table}`, error);
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
      logError(`Error finding one from ${table}`, error);
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
          logError('Error checking if all products are finalized', err);
          reject(new Error(err));
        });
    });
  },

  /**
   * Check if all products in an RFQ are finalized (without user filter)
   * Used for ARC approval creation
   * @param {number} rfq_id - The RFQ ID
   * @param {Object} dbContext - Optional transaction context
   * @returns {Promise<Object>} - { total_products, finalized_products }
   */
  checkAllProductsFinalizedForArc: async (rfq_id, dbContext = db) => {
    const query = `
      SELECT 
        COUNT(*) AS total_products,
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
      WHERE RP.rfq_id = $1
    `;

    return new Promise((resolve, reject) => {
      dbContext.oneOrNone(query, [rfq_id])
        .then((data) => {
          if (data) {
            resolve({
              total_products: parseInt(data.total_products) || 0,
              finalized_products: parseInt(data.finalized_products) || 0
            });
          } else {
            resolve({ total_products: 0, finalized_products: 0 });
          }
        })
        .catch((err) => {
          logError('Error checking if all products are finalized for ARC', err);
          reject(new Error(err));
        });
    });
  },


  /**
   * Get quotes with vendor details for ARC lifecycle
   * @param {number} rfq_id - The RFQ ID
   * @returns {Promise<Array>} - Array of quotes with vendor details
   */
  getQuotesWithVendorDetails: async (rfq_id) => {
    const query = `
      SELECT 
        q.*,
        u.name as vendor_name,
        u.email as vendor_email,
        u.organization_name,
        c.company_name,
        (
          SELECT json_agg(
            json_build_object(
              'id', qi.id,
              'product_id', qi.product_variant_id,
              'product_name', qi.product_name,
              'quantity', qi.quantity,
              -- 'unit', qi.unit,
              'unit_price', qi.unit_price,
              'freight_price', qi.freight_price,
              'package_price', qi.package_price,
              'tax', qi.tax,
              'total_price', qi.total_price,
              'delivery_period', qi.delivery_period,
              'comment', qi.comment
            )
          )
          FROM tbl_quote_items qi
          WHERE qi.quote_id = q.id
        ) as quote_items
      FROM tbl_quotes q
      LEFT JOIN tbl_users u ON u.id = q.created_by
      LEFT JOIN tbl_company c ON c.id = u.company_id
      WHERE q.rfq_id = $1
      ORDER BY q.timestamp DESC
    `;
    return db.any(query, [rfq_id]);
  },

  /**
   * Get technical evaluation data for ARC lifecycle
   * @param {number} rfq_id - The RFQ ID
   * @returns {Promise<Array>} - Array of technical evaluation data
   */
  getTechEvaluationData: async (rfq_id) => {
    const query = `
      SELECT
        te.*,
        rp.id as rfq_product_id,
        rp.product_variant_id,
        (
          SELECT json_agg(
            json_build_object(
              'vendor_id', tev.vendor_id,
              'vendor_name', u.name,
              'vendor_email', u.email,
              'created_at', tev.timestamp,
              'is_accepted', CASE WHEN tev.status = 1 THEN true ELSE false END,
              'status', tev.status,
              'remarks', tev.reject_message,
              'is_verified', tev.is_verified,
              'evaluation_round', tev.evaluation_round
            )
          )
          FROM tbl_rfq_product_tech_evaluation_cleared_vendors tev
          LEFT JOIN tbl_users u ON u.id = tev.vendor_id
          WHERE tev.tbl_rfq_product_tech_evaluation_id = te.id
        ) as vendor_evaluations
      FROM tbl_rfq_product_tech_evaluation te
      JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
      WHERE te.rfq_id = $1
    `;
    return db.any(query, [rfq_id]);
  },

  /**
   * Get vendor rankings (L1-L5) for each product
   * @param {number} rfq_id - The RFQ ID
   * @returns {Promise<Array>} - Array of vendor rankings
   */
  getVendorRankingsByProduct: async (rfq_id) => {
    const query = `
      SELECT 
        rp.id as rfq_product_id,
        rp.product_variant_id,
        rp.variant,
        q.id as quote_id,
        q.created_by as vendor_id,
        u.name as vendor_name,
        u.email as vendor_email,
        u.organization_name,
        c.company_name,
        qi.total_price as quoted_price,
        qi.unit_price,
        qi.quantity,
        -- qi.unit,
        qf.id as finalization_id,
        qf.timestamp as finalized_at
      FROM tbl_rfq_products rp
      LEFT JOIN tbl_quote_items qi ON qi.product_variant_id = rp.product_variant_id AND qi.variant = rp.variant
      LEFT JOIN tbl_quotes q ON q.id = qi.quote_id AND q.rfq_id = rp.rfq_id
      LEFT JOIN tbl_quote_finalization qf ON qf.rfq_id = rp.rfq_id 
        AND qf.product_variant_id = rp.product_variant_id 
        AND qf.variant = rp.variant
        AND qf.vendor_id = q.created_by
      LEFT JOIN tbl_users u ON u.id = q.created_by
      LEFT JOIN tbl_company c ON c.id = u.company_id
      WHERE rp.rfq_id = $1 AND q.id IS NOT NULL
      ORDER BY rp.id, qi.total_price ASC
    `;
    return db.any(query, [rfq_id]);
  },

  /**
   * Get sampling data for ARC lifecycle
   * @param {number} rfq_id - The RFQ ID
   * @returns {Promise<Array>} - Array of sampling data
   */
  getSamplingData: async (rfq_id) => {
    const query = `
      SELECT 
        c.*,
        u.name as vendor_name,
        u.email as vendor_email,
        rp.id as rfq_product_id
      FROM tbl_rfq_product_tech_evaluation_clauses c
      JOIN tbl_rfq_product_tech_evaluation te ON te.id = c.tbl_rfq_product_tech_evaluation_id
      LEFT JOIN tbl_users u ON u.id = te.vendor_id
      JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
      WHERE c.rfq_id = $1 AND c.clause_type = 'sampling'
      ORDER BY c.created_at DESC
    `;
    try {
      return await db.any(query, [rfq_id]);
    } catch (error) {
      // Sampling table might not exist or have different structure
      logger.warn('Sampling data not available: %s', error.message);
      return [];
    }
  },

  /**
   * Get RFQs pending ARC approval
   * @param {Object} filters - { page, limit, project_id, is_tender }
   * @returns {Promise<Object>} - { rfqs, total }
   */
  getRfqsPendingArcApproval: async (filters = {}) => {
    const { page = 1, limit = 50, project_id, user_id, includeAll = false } = filters;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const whereConditions = [
      'r.hospitality_company_id IS NOT NULL',
      'r.status IN (1, 2)',
      'r.is_tender = 1', // ARC is only for tenders
    ];

    // Only filter to tenders with ARC approval instances when not showing all
    if (!includeAll) {
      whereConditions.push(`EXISTS (
        SELECT 1 FROM tbl_rfq_products rp
        JOIN tbl_approval_instances ai2 ON ai2.entity_type = 'ARC'
          AND ai2.entity_id::INTEGER = rp.id
          AND ai2.status IN ('PENDING', 'APPROVED', 'CANCELLED')
        WHERE rp.rfq_id = r.id
      )`);
    }
    const params = [];
    let paramIndex = 1;

    if (project_id && parseInt(project_id) > 0) {
      whereConditions.push(`r.project_id = $${paramIndex++}`);
      params.push(parseInt(project_id));
    }

    // Restrict RFQs to hospitality business units (hotels) where the current user
    // actually has a mapping. This ensures we don't show RFQs from BUs that the
    // user is not part of (even if they have generic procurement access).
    if (user_id) {
      whereConditions.push(`
        EXISTS (
          SELECT 1
          FROM tbl_hospitality_user_mappings hum
          WHERE hum.user_id = $${paramIndex++}
            AND hum.hospitality_company_id = r.hospitality_company_id
            AND (
              -- Hotel-level mapping
              (hum.mapping_type = 1 AND hum.hospitality_hotel_id = r.hotel_id)
              -- Or company-level mapping (covers all hotels under the company)
              OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL)
            )
        )
      `);
      params.push(parseInt(user_id));
    }

    const whereClause = whereConditions.join(' AND ');

    // Query to get RFQs with their products that have ARC approvals
    const query = `
      SELECT DISTINCT
        r.id as rfq_id,
        r.rfq_no,
        r.is_tender,
        r.company_name,
        r.timestamp,
        r.bid_end_date,
        r.status,
        p.name as project_name,
        rp.id as rfq_product_id,
        pv.name as product_name,
        rp.variant,
        ai.id as approval_instance_id,
        ai.status as approval_status,
        ai.created_at as approval_created_at,
        (
          SELECT COUNT(*)
          FROM tbl_quotes q
          WHERE q.rfq_id = r.id
        ) as quote_count,
        (
          SELECT COUNT(*)
          FROM tbl_rfq_products rp2
          WHERE rp2.rfq_id = r.id
        ) as product_count,
        (
          SELECT COUNT(*)
          FROM tbl_rfq_products rp3
          JOIN tbl_approval_instances ai3 ON ai3.entity_type = 'ARC'
            AND ai3.entity_id::INTEGER = rp3.id
            AND ai3.status = 'PENDING'
          WHERE rp3.rfq_id = r.id
        ) as pending_arc_count
      FROM tbl_rfq r
      LEFT JOIN tbl_projects p ON p.id = r.project_id
      JOIN tbl_rfq_products rp ON rp.rfq_id = r.id
      JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
      LEFT JOIN tbl_approval_instances ai ON ai.entity_type = 'ARC'
        AND ai.entity_id::INTEGER = rp.id
        AND ai.status IN ('PENDING', 'APPROVED', 'CANCELLED')
      WHERE ${whereClause}
      ORDER BY r.timestamp DESC, rp.id
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const countQuery = includeAll
      ? `SELECT COUNT(DISTINCT r.id)
         FROM tbl_rfq r
         WHERE ${whereClause}`
      : `SELECT COUNT(DISTINCT rp.id)
         FROM tbl_rfq r
         JOIN tbl_rfq_products rp ON rp.rfq_id = r.id
         JOIN tbl_approval_instances ai2 ON ai2.entity_type = 'ARC'
           AND ai2.entity_id::INTEGER = rp.id
           AND ai2.status IN ('PENDING', 'APPROVED', 'CANCELLED')
         WHERE ${whereClause}`;

    params.push(parseInt(limit), offset);

    const [rfqs, total] = await Promise.all([
      db.any(query, params),
      db.one(countQuery, params.slice(0, -2))
    ]);

    return {
      rfqs,
      total: parseInt(total.count)
    };
  },

  updateWithTimestamp: async (table_name, data, primary_key, txContext = null) => {
    const dbConn = txContext || db;
    const setClause = Object.keys(data)
      .map((key, index) => `${key} = $${index + 1}`)
      .join(', ');
    const values = Object.values(data);
    const paramIndex = Object.keys(data).length + 1;
    const updateQuery = `
      UPDATE ${table_name}
      SET ${setClause}
      , "timestamp" = CURRENT_TIMESTAMP
      WHERE id = $${paramIndex}
      RETURNING *`;
    values.push(primary_key);
    return await dbConn.any(updateQuery, values);
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
    // Show to creator:
    // - Published RFQs (is_published = 1, status 1 or 2)
    // - Pending approval RFQs (is_published = 0, status 3)
    // - Ready to publish RFQs (is_published = 0, status 4)
    const query = `SELECT RFQ.id,RFQ.rfq_no,RFQ.is_published,RFQ.created_by,RFQ.status,RFQ.timestamp,
      ARRAY(
      SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id
    ) AS "quotations",

    ARRAY(
      SELECT json_build_object('id', TQF.id,'rfq_id', TQF.rfq_id,'rfq_no', TQF.rfq_no, 'timestamp', TQF.timestamp, 'created_by', TQF.created_by ) FROM tbl_quote_finalization TQF WHERE TQF.rfq_id = RFQ.id AND TQF.created_by = '${user_id}'
    ) AS "finilize"
    FROM tbl_rfq RFQ
    WHERE created_by = '${user_id}'
      AND (RFQ.is_published = 1 OR RFQ.status IN (3, 4))
      AND EXTRACT(MONTH FROM timestamp) = '$1' AND EXTRACT(YEAR FROM timestamp) = '$2' ORDER BY id DESC LIMIT $3 OFFSET $4 `;
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
    // Show to creator:
    // - Published RFQs (is_published = 1, status 1 or 2)
    // - Pending approval RFQs (is_published = 0, status 3)
    // - Ready to publish RFQs (is_published = 0, status 4)
    const query = `SELECT RFQ.id,RFQ.rfq_no,RFQ.is_published,RFQ.created_by,RFQ.status,RFQ.timestamp,
      ARRAY(
      SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id
    ) AS "quotations",

    ARRAY(
      SELECT json_build_object('id', TQF.id,'rfq_id', TQF.rfq_id,'rfq_no', TQF.rfq_no, 'timestamp', TQF.timestamp, 'created_by', TQF.created_by ) FROM tbl_quote_finalization TQF WHERE TQF.rfq_id = RFQ.id AND TQF.created_by = '${user_id}'
    ) AS "finilize"
    FROM tbl_rfq RFQ
    WHERE created_by = '${user_id}'
      AND (RFQ.is_published = 1 OR RFQ.status IN (3, 4))
      AND EXTRACT(MONTH FROM timestamp) = '$1' AND EXTRACT(YEAR FROM timestamp) = '$2' ORDER BY id DESC  `;
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
        ) AND RFQ.is_published = 1 AND RFQ.status NOT IN (3, 4)
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
          'company_name', (
              SELECT STRING_AGG(DISTINCT hc.name, ', ')
              FROM tbl_rfq_hotel_mappings rhm
              JOIN tbl_hospitality_company_hotels hch ON hch.id = rhm.hotel_id
              JOIN tbl_hospitality_companies hc ON hc.id = hch.hospitality_company_id
              WHERE rhm.rfq_id = RFQ.id
          ),
          'bid_end_date', RFQ.bid_end_date,
          'rfq_type', RFQ.rfq_type,
          'reverse_auction', RFQ.reverse_auction,
          'ra_start_date', RFQ.ra_start_date,
          'ra_end_date', RFQ.ra_end_date,
          'project_id', RFQ.project_id,
          'location', RFQ.location,
          'rfq_added_from', RFQ.rfq_added_from,
          'tender_publish_date', RFQ.tender_publish_date ,
          'vendor_clarification_date', RFQ.vendor_clarification_date ,
          'tender_fees', RFQ.tender_fees,
          'is_tender', RFQ.is_tender,
          'hotel_id', RFQ.hotel_id,
          'department_id', RFQ.department_id,
          'process_id', RFQ.process_id,
          'title', RFQ.title,
          'created_by', RFQ.created_by,

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
                  AND tus.start_date::date <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND tus.end_date::date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                  THEN 2
                WHEN tsp.plan_name ILIKE '%Premium%'
                  AND tus.status = 1
                  AND tus.start_date::date <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND tus.end_date::date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
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

      logger.debug({ data: q }, 'GET DRAFT VENDORS query');

      return db.any(q, [draftId, rfqProductId, vendor_name]);
    } catch (error) {
      logError('getDraftProductVendors failed', error);
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
      RFQ.tender_publish_date,
      RFQ.vendor_clarification_date,
      RFQ.tender_fees,
      RFQ.reverse_auction,
      RFQ.is_tender,
      RFQ.ra_start_date, -- Select raw timestamp
      RFQ.ra_end_date,   -- Select raw timestamp
      RFQ.project_id,
      RFQ.title,
      RFQ.technical_evaluation_by,
      (SELECT name FROM tbl_users WHERE id = RFQ.technical_evaluation_by) AS technical_evaluation_by_name,
      H.name AS hotel_name,
      RFQ.hotel_id,
      RFQ.department_id,
      D_DEPT.title AS department_name,
      RFQ.hospitality_company_id,
      (
        SELECT EXISTS (
          SELECT 1
          FROM tbl_quotes tq
          WHERE tq.rfq_id = RFQ.id
          LIMIT 1
        )
      ) AS is_quotes_present,

      ${user_type == 3 ? `(SELECT COUNT(*)
     FROM tbl_query_messages TQM
     WHERE TQM.receiver_id = $2
     AND TQM.rfq_id = RFQ.id
     AND TQM.is_seen = false
    )` : `0`} AS "unseen_query_count",
    ${user_type == 3 ? `(
      SELECT json_build_object(
        'is_regret', TQ.is_regret,
        'regret_reason', TQ.regret_reason,
        'global_payment_term', TQ.global_payment_term,
        'global_comment', TQ.global_comment,
        'gstin', TQ.gstin
      )
      FROM tbl_quotes TQ
      WHERE TQ.rfq_id = RFQ.id
        AND TQ.created_by = $2
      LIMIT 1
    )` : `NULL`} AS "quote_details",

    ${user_type == 3 ? `(
      SELECT json_agg(json_build_object(
        'file_url', TQF.file_url
      ))
      FROM tbl_quotes_files TQF
      WHERE TQF.quote_id = (
        SELECT TQ.id
        FROM tbl_quotes TQ
        WHERE TQ.rfq_id = RFQ.id
          AND TQ.created_by = $2
        LIMIT 1
      )
        AND TQF.file_type = 'term_and_condition'
    )` : `NULL`} AS "terms_and_conditions_files",
    
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
    ${user_type == 3 ? `ARRAY(
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
      ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id AND TQ.created_by = $2
    )` : `ARRAY[]::json[]`} AS "quotations"
      ${user_type == 3 ? `,(
        SELECT VP.payment_status
        FROM tbl_vendor_payments VP
        WHERE VP.vendor_id = $2 AND VP.rfq_id = RFQ.id AND VP.payment_type = 'tender'
        ORDER BY VP.id DESC LIMIT 1
      ) AS "vendor_payment_status"` : ''}
FROM tbl_rfq RFQ
LEFT JOIN tbl_hospitality_company_hotels H
  ON H.id = RFQ.hotel_id
 AND H.is_deleted = 0
LEFT JOIN tbl_department D_DEPT
  ON D_DEPT.id = RFQ.department_id
WHERE RFQ.id = $1
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
          'latest_target_price', ${user_type == 3 ? `(
            SELECT tptp.target_price
            FROM tbl_rfq_product_target_price tptp
            WHERE tptp.tbl_rfq_product_id = RFQ_P.id and vendor_id = $2
            ORDER BY tptp.created_at DESC
            LIMIT 1
            )` : `NULL`},
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
                    WHERE TECV.vendor_id = $2 AND TECV.status = 1
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
                ),
                all_clauses AS (
                    SELECT COUNT(*) AS total_clauses
                    FROM tbl_rfq_product_tech_evaluation_clauses TEC
                    JOIN tech_eval TE ON TEC.tbl_rfq_product_tech_evaluation_id = TE.tech_eval_id
                    WHERE TEC.clause_type != 'sampling' OR TEC.clause_type IS NULL
                ),
                accepted_vendor AS (
                    SELECT TECV.vendor_id
                    FROM tbl_rfq_product_tech_evaluation_cleared_vendors TECV
                    JOIN tech_eval TE ON TECV.tbl_rfq_product_tech_evaluation_id = TE.tech_eval_id
                    WHERE TECV.status = 1
                    LIMIT 1
                ),
                completed_vendor AS (
                    SELECT VR.vendor_id
                    FROM tbl_rfq_product_tech_evaluation_vendors_response VR
                    JOIN tbl_rfq_product_tech_evaluation_clauses TEC ON VR.tbl_rfq_product_tech_evaluation_clauses_id = TEC.id
                    JOIN tech_eval TE ON TEC.tbl_rfq_product_tech_evaluation_id = TE.tech_eval_id
                    WHERE VR.vendor_response IS NOT NULL
                      AND VR.vendor_response != ''
                      AND VR.vendor_response != 'N/A'
                      AND TRIM(VR.vendor_response) != ''
                      AND (TEC.clause_type != 'sampling' OR TEC.clause_type IS NULL)
                    GROUP BY VR.vendor_id
                    HAVING COUNT(DISTINCT VR.tbl_rfq_product_tech_evaluation_clauses_id) = (SELECT total_clauses FROM all_clauses)
                    LIMIT 1
                ),
                product_vendor AS (
                    SELECT TRPV.user_id AS vendor_id
                    FROM tbl_rfq_product_vendors TRPV
                    WHERE TRPV.rfq_id = RFQ_P.rfq_id
                      AND TRPV.product_variant_id = RFQ_P.product_variant_id
                      AND TRPV.variant = RFQ_P.variant
                    LIMIT 1
                ),
                resolved_vendor AS (
                    SELECT CASE
                        WHEN $3 = 3 THEN $2
                        ELSE COALESCE(
                            (SELECT vendor_id FROM accepted_vendor),
                            (SELECT vendor_id FROM completed_vendor),
                            (SELECT vendor_id FROM product_vendor)
                        )
                    END AS vendor_id
                ),
                vendor_responses AS (
                    SELECT
                        COUNT(*) AS responded_clauses,
                        COUNT(CASE WHEN VR.vendor_response IS NOT NULL
                                   AND VR.vendor_response != ''
                                   AND VR.vendor_response != 'N/A'
                                   AND TRIM(VR.vendor_response) != '' THEN 1 END) AS valid_responses
                    FROM tbl_rfq_product_tech_evaluation_vendors_response VR
                    JOIN tbl_rfq_product_tech_evaluation_clauses TEC ON VR.tbl_rfq_product_tech_evaluation_clauses_id = TEC.id
                    JOIN tech_eval TE ON TEC.tbl_rfq_product_tech_evaluation_id = TE.tech_eval_id
                    WHERE VR.vendor_id = (SELECT vendor_id FROM resolved_vendor)
                      AND (TEC.clause_type != 'sampling' OR TEC.clause_type IS NULL)
                ),
                buyer_evaluation AS (
                    SELECT
                        TECV.status,
                        TECV.reject_message
                    FROM tbl_rfq_product_tech_evaluation_cleared_vendors TECV
                    JOIN tech_eval TE ON TECV.tbl_rfq_product_tech_evaluation_id = TE.tech_eval_id
                    WHERE TECV.vendor_id = (SELECT vendor_id FROM resolved_vendor)
                    LIMIT 1
                )
                SELECT json_build_object(
                    'has_tech_eval', (SELECT COUNT(*) > 0 FROM tech_eval),
                    'is_accepted', (
                        SELECT COALESCE(
                            (SELECT status = 1 FROM buyer_evaluation),
                            false
                        )
                    ),
                    'is_rejected', (
                        SELECT COALESCE(
                            (SELECT status = 0 FROM buyer_evaluation),
                            false
                        )
                    ),
                    'has_response', (
                        SELECT COALESCE((SELECT valid_responses > 0 FROM vendor_responses), false)
                    ),
                    'all_clauses_responded', (
                        SELECT COALESCE(
                            (SELECT valid_responses = total_clauses AND total_clauses > 0
                             FROM vendor_responses, all_clauses),
                            false
                        )
                    ),
                    'responded_count', (
                        SELECT COALESCE((SELECT valid_responses FROM vendor_responses), 0)
                    ),
                    'total_clauses', (
                        SELECT COALESCE((SELECT total_clauses FROM all_clauses), 0)
                    ),
                    'rejection_reason', (
                        SELECT reject_message FROM buyer_evaluation
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
        ,EXISTS (
            SELECT 1 FROM tbl_rfq_purchase_order _po
            JOIN tbl_purchase_order_product _pop ON _pop.purchase_order_id = _po.id
            WHERE _po.rfq_id = RFQ_P.rfq_id AND _pop.rfq_product_id = RFQ_P.id
              AND _po.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
        ) AS has_approved_po

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

    const [data, products] = await Promise.all([
      db.query(q, [id, user_id]),
      db.query(productQuery, [id, user_id, user_type]),
    ]);
    if (data && data[0] && products) {
      data[0].products = products;
    }
    return data;
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
  subscriptionType = null,
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
          WHERE rpv.user_id = tu.id AND r.user_id = ${user_id}
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
        ${subscriptionType ? subscriptionType == 'premium' ? 'AND is_premium = 1' : subscriptionType == 'enterprise' ? 'AND is_premium = 2' : 'AND is_premium = 0' : ''}
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
    logError('Error in bulkSearchVendorsByCategory', err);
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
      logger.debug({ data: countQuery }, 'searchVendorWithoutLogin countQuery');
      const totalCount = countResult[0].total;
      
      const dataResult = await db.query(dataQuery);
      logger.debug({ data: dataQuery }, 'searchVendorWithoutLogin dataQuery');
      return {
        total: totalCount,
        vendor: dataResult.length > 0 ? dataResult : null
      };
    } catch (err) {
      logError('Error in searchVendor', err);
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
    rfq_no,
    is_tender,
    completed_status,
    hotel_ids
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
          -- is_quotes_present: used by canEditRfq to block editing after bid deadline
          (
            SELECT EXISTS (
              SELECT 1 FROM tbl_quotes _tq_exists
              WHERE _tq_exists.rfq_id = RFQ.id
              LIMIT 1
            )
          ) AS is_quotes_present,
          -- po_completed: ALL products have an approved (or beyond) PO
          (
            SELECT CASE
              WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN false
              ELSE (
                SELECT BOOL_AND(has_approved)
                FROM (
                  SELECT EXISTS (
                    SELECT 1 FROM tbl_rfq_purchase_order _po2
                    JOIN tbl_purchase_order_product _pop2 ON _pop2.purchase_order_id = _po2.id
                    WHERE _po2.rfq_id = RFQ.id AND _pop2.rfq_product_id = _rp2.id
                      AND _po2.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
                  ) AS has_approved
                  FROM tbl_rfq_products _rp2 WHERE _rp2.rfq_id = RFQ.id
                ) _chk
              )
            END
          ) AS po_completed,
          -- po_partially_completed: at least one product has approved PO, but not all
          (
            SELECT CASE
              WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN false
              ELSE (
                SELECT COUNT(*) FILTER (WHERE has_approved) > 0
                  AND COUNT(*) FILTER (WHERE NOT has_approved) > 0
                FROM (
                  SELECT EXISTS (
                    SELECT 1 FROM tbl_rfq_purchase_order _po3
                    JOIN tbl_purchase_order_product _pop3 ON _pop3.purchase_order_id = _po3.id
                    WHERE _po3.rfq_id = RFQ.id AND _pop3.rfq_product_id = _rp3.id
                      AND _po3.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
                  ) AS has_approved
                  FROM tbl_rfq_products _rp3 WHERE _rp3.rfq_id = RFQ.id
                ) _chk2
              )
            END
          ) AS po_partially_completed,
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
          ) AS "products",
          -- can_edit: user has 'update' permission for this RFQ's hotel + department + resource type
          EXISTS (
            SELECT 1 FROM tbl_user_role_scopes _urs
            JOIN tbl_role_permissions _rp ON _rp.role_id = _urs.role_id
            JOIN tbl_permissions _p ON _p.id = _rp.permission_id
            WHERE _urs.user_id = ${user_id}
              AND _p.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
              AND _p.action = 'update'
              AND _urs.company_id = RFQ.hospitality_company_id
              AND (_urs.hotel_id IS NULL OR _urs.hotel_id = RFQ.hotel_id)
              AND (
                RFQ.department_id IS NULL
                OR _urs.department_id = RFQ.department_id
                OR _urs.department_id IS NULL
              )
          ) AS can_edit
      FROM tbl_rfq RFQ
      LEFT JOIN tbl_projects P ON RFQ.project_id = P.id  -- Join on project_id to get project_name
      WHERE (RFQ.created_by = ${user_id} OR EXISTS (
      SELECT 1 FROM tbl_project_team PT WHERE PT.project_id = RFQ.project_id AND PT.user_id = ${user_id}
      UNION ALL
      SELECT 1 FROM tbl_hospitality_user_mappings HUM
      WHERE HUM.user_id = ${user_id}
        AND (
          HUM.hospitality_hotel_id = RFQ.hotel_id
          OR (HUM.mapping_type = 0 AND HUM.hospitality_hotel_id IS NULL
              AND HUM.hospitality_company_id = RFQ.hospitality_company_id)
        )
      )) AND (RFQ.is_published = 1 OR RFQ.status IN (2, 3, 4))
      -- Permission filter: only RFQs the user has read access for
      AND EXISTS (
        SELECT 1 FROM tbl_user_role_scopes _urs2
        JOIN tbl_role_permissions _rp2 ON _rp2.role_id = _urs2.role_id
        JOIN tbl_permissions _p2 ON _p2.id = _rp2.permission_id
        WHERE _urs2.user_id = ${user_id}
          AND _p2.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
          AND _p2.action = 'read'
          AND _urs2.company_id = RFQ.hospitality_company_id
          AND (_urs2.hotel_id IS NULL OR _urs2.hotel_id = RFQ.hotel_id)
          AND (
            RFQ.department_id IS NULL
            OR _urs2.department_id = RFQ.department_id
            OR _urs2.department_id IS NULL
          )
      )
      AND (RFQ.project_id = $1 OR $1 IS NULL)
      AND (RFQ.rfq_type = $2 OR $2 IS NULL)  -- Filter by rfq_type if provided
      AND (RFQ.reverse_auction = $3 OR $3 IS NULL)  -- Filter by reverse_auction if provided
      AND (RFQ.rfq_no::text LIKE '%$6%' OR $6 IS NULL) -- Filter by rfq_no if provided
      ${is_tender !== null && is_tender !== undefined ? `AND RFQ.is_tender = ${is_tender === '1' || is_tender === 1 || is_tender === true ? 1 : 0}` : ''}
      ${completed_status === 'completed' ? `AND (
        (SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN false
          ELSE (SELECT BOOL_AND(_has_appr) FROM (
            SELECT EXISTS (
              SELECT 1 FROM tbl_rfq_purchase_order _po2
              JOIN tbl_purchase_order_product _pop2 ON _pop2.purchase_order_id = _po2.id
              WHERE _po2.rfq_id = RFQ.id AND _pop2.rfq_product_id = _rp2.id
                AND _po2.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
            ) AS _has_appr FROM tbl_rfq_products _rp2 WHERE _rp2.rfq_id = RFQ.id) _c)
        END) = true
        OR (SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN false
          ELSE (SELECT COUNT(*) FILTER (WHERE _has_appr) > 0 AND COUNT(*) FILTER (WHERE NOT _has_appr) > 0
            FROM (SELECT EXISTS (
              SELECT 1 FROM tbl_rfq_purchase_order _po3
              JOIN tbl_purchase_order_product _pop3 ON _pop3.purchase_order_id = _po3.id
              WHERE _po3.rfq_id = RFQ.id AND _pop3.rfq_product_id = _rp3.id
                AND _po3.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
            ) AS _has_appr FROM tbl_rfq_products _rp3 WHERE _rp3.rfq_id = RFQ.id) _c2)
        END) = true
      )` : ''}
      ${completed_status === 'closed' ? `AND RFQ.status = 2` : ''}
      ${completed_status === 'active' ? `AND RFQ.status != 2 AND (
        (SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN true
          ELSE (SELECT BOOL_OR(NOT _has_appr) FROM (
            SELECT EXISTS (
              SELECT 1 FROM tbl_rfq_purchase_order _po2
              JOIN tbl_purchase_order_product _pop2 ON _pop2.purchase_order_id = _po2.id
              WHERE _po2.rfq_id = RFQ.id AND _pop2.rfq_product_id = _rp2.id
                AND _po2.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
            ) AS _has_appr FROM tbl_rfq_products _rp2 WHERE _rp2.rfq_id = RFQ.id) _c)
        END) = true
        AND NOT (SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN false
          ELSE (SELECT COUNT(*) FILTER (WHERE _has_appr) > 0 AND COUNT(*) FILTER (WHERE NOT _has_appr) > 0
            FROM (SELECT EXISTS (
              SELECT 1 FROM tbl_rfq_purchase_order _po3
              JOIN tbl_purchase_order_product _pop3 ON _pop3.purchase_order_id = _po3.id
              WHERE _po3.rfq_id = RFQ.id AND _pop3.rfq_product_id = _rp3.id
                AND _po3.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
            ) AS _has_appr FROM tbl_rfq_products _rp3 WHERE _rp3.rfq_id = RFQ.id) _c2)
        END)
      )` : ''}
      ${Array.isArray(hotel_ids) && hotel_ids.length > 0 ? `AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = RFQ.id AND rhm.hotel_id IN (${hotel_ids.map(id => parseInt(id)).filter(Number.isFinite).join(',')}))` : ''}
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
  /**
   * Compute lifecycle stage for a batch of RFQ IDs.
   * Returns an object mapping rfq_id → lifecycle_stage string.
   *
   * Stages (evaluated most-advanced first):
   *  APPROVED_COMPLETED, PO_APPROVAL, AWAITING_PO, QUOTATION_APPROVAL,
   *  NEGOTIATION_ONGOING, COMMERCIAL_EVALUATION, TECHNICAL_REJECTED,
   *  TECHNICAL_APPROVING, TECHNICAL_EVALUATING, RFQ_APPROVAL
   */
  computeLifecycleStages: async (rfqIds) => {
    if (!rfqIds || rfqIds.length === 0) return {};

    const q = `
      WITH rfq_data AS (
        SELECT id, status, is_published
        FROM tbl_rfq
        WHERE id = ANY($1::int[])
      ),
      product_counts AS (
        SELECT rfq_id, COUNT(*)::int AS total_products
        FROM tbl_rfq_products
        WHERE rfq_id = ANY($1::int[])
        GROUP BY rfq_id
      ),
      -- Latest TECHNICAL approval per RFQ
      tech_approval AS (
        SELECT
          (metadata->>'rfq_id')::int AS rfq_id,
          status,
          ROW_NUMBER() OVER (PARTITION BY (metadata->>'rfq_id')::int ORDER BY created_at DESC) AS rn
        FROM tbl_approval_instances
        WHERE entity_type = 'TECHNICAL'
          AND metadata->>'rfq_id' IS NOT NULL
          AND (metadata->>'rfq_id')::int = ANY($1::int[])
      ),
      tech_latest AS (
        SELECT rfq_id, status FROM tech_approval WHERE rn = 1
      ),
      -- Products where tech eval is done: all eligible (responded) vendors
      -- have been evaluated (exist in cleared_vendors, passed or failed).
      products_with_cleared AS (
        SELECT te.rfq_id, COUNT(DISTINCT te.tbl_rfq_product_id)::int AS products_cleared
        FROM tbl_rfq_product_tech_evaluation te
        WHERE te.rfq_id = ANY($1::int[])
          AND (
            te.is_complete = true
            OR (
              -- At least 1 vendor evaluated
              EXISTS (
                SELECT 1 FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
                WHERE cv.tbl_rfq_product_tech_evaluation_id = te.id
              )
              -- AND no responded vendor left unevaluated
              AND NOT EXISTS (
                SELECT DISTINCT vr.vendor_id
                FROM tbl_rfq_product_tech_evaluation_vendors_response vr
                JOIN tbl_rfq_product_tech_evaluation_clauses c
                  ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
                WHERE c.tbl_rfq_product_tech_evaluation_id = te.id
                  AND NOT EXISTS (
                    SELECT 1 FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv2
                    WHERE cv2.tbl_rfq_product_tech_evaluation_id = te.id
                      AND cv2.vendor_id = vr.vendor_id
                  )
              )
            )
          )
        GROUP BY te.rfq_id
      ),
      -- Active negotiation rounds
      active_negotiations AS (
        SELECT DISTINCT rfq_id
        FROM tbl_negotiation_rounds
        WHERE rfq_id = ANY($1::int[])
          AND status = 'ACTIVE'
          AND end_date > NOW()
      ),
      -- Pending NEGOTIATION_QUOTE approvals (per RFQ)
      neg_quote_pending AS (
        SELECT DISTINCT (metadata->>'rfq_id')::int AS rfq_id
        FROM tbl_approval_instances
        WHERE entity_type = 'NEGOTIATION_QUOTE'
          AND status = 'PENDING'
          AND metadata->>'rfq_id' IS NOT NULL
          AND (metadata->>'rfq_id')::int = ANY($1::int[])
      ),
      -- Approved NEGOTIATION_QUOTE count per RFQ (distinct products)
      neg_quote_approved AS (
        SELECT
          (metadata->>'rfq_id')::int AS rfq_id,
          COUNT(DISTINCT entity_id)::int AS approved_products
        FROM tbl_approval_instances
        WHERE entity_type = 'NEGOTIATION_QUOTE'
          AND status = 'APPROVED'
          AND metadata->>'rfq_id' IS NOT NULL
          AND (metadata->>'rfq_id')::int = ANY($1::int[])
        GROUP BY (metadata->>'rfq_id')::int
      ),
      -- PO data per RFQ
      po_data AS (
        SELECT
          rfq_id,
          COUNT(*)::int AS total_pos,
          COUNT(*) FILTER (WHERE status = 'pending_approval')::int AS pending_approval_pos,
          COUNT(*) FILTER (WHERE status IN ('approved','sent','dispatched','GRN','completed','invoice_raised'))::int AS approved_pos
        FROM tbl_rfq_purchase_order
        WHERE rfq_id = ANY($1::int[])
        GROUP BY rfq_id
      ),
      -- Distinct products covered by approved POs
      po_products_approved AS (
        SELECT po.rfq_id, COUNT(DISTINCT pop.rfq_product_id)::int AS products_with_approved_po
        FROM tbl_rfq_purchase_order po
        JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
        WHERE po.rfq_id = ANY($1::int[])
          AND po.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
        GROUP BY po.rfq_id
      ),
      -- Whether tech eval is configured for this RFQ (+ count of TE products)
      has_tech_eval AS (
        SELECT DISTINCT rfq_id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])
      ),
      tech_eval_product_count AS (
        SELECT rfq_id, COUNT(DISTINCT tbl_rfq_product_id)::int AS te_products
        FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])
        GROUP BY rfq_id
      ),
      -- Whether any non-regret quotes have been received (= eligible vendors)
      has_eligible_vendors AS (
        SELECT rfq_id FROM tbl_quotes
        WHERE rfq_id = ANY($1::int[])
          AND (is_regret IS NULL OR is_regret != 1)
        GROUP BY rfq_id HAVING COUNT(*) > 0
      ),
      -- Whether the bid submission deadline has passed.
      -- bid_end_date is stored as text in ISO format (e.g. '2026-03-14T11:00'), so cast it.
      bid_status AS (
        SELECT id AS rfq_id,
               (bid_end_date IS NOT NULL AND bid_end_date != ''
                  AND bid_end_date::timestamp < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')) AS bid_ended
        FROM tbl_rfq WHERE id = ANY($1::int[])
      )
      SELECT
        rd.id AS rfq_id,
        CASE
          -- Stage 10: Approved & Completed (all products have approved POs)
          WHEN ppa.products_with_approved_po IS NOT NULL
            AND pc.total_products IS NOT NULL
            AND ppa.products_with_approved_po >= pc.total_products
            THEN 'APPROVED_COMPLETED'
          -- Stage 9: Purchase Order Approval
          WHEN COALESCE(pd.pending_approval_pos, 0) > 0
            THEN 'PO_APPROVAL'
          -- Stage 8: Awaiting PO Initiation (all products have approved quotes)
          WHEN nqa.approved_products IS NOT NULL
            AND pc.total_products IS NOT NULL
            AND nqa.approved_products >= pc.total_products
            THEN 'AWAITING_PO'
          -- Stage 7: Quotation Approval
          WHEN nqp.rfq_id IS NOT NULL
            THEN 'QUOTATION_APPROVAL'
          -- Stage 6: Negotiation Ongoing
          WHEN an.rfq_id IS NOT NULL
            THEN 'NEGOTIATION_ONGOING'
          -- Stage 5a: Commercial Evaluation (TE flow — all TE-configured products have been evaluated)
          WHEN pwc.products_cleared IS NOT NULL AND tepc.te_products IS NOT NULL
            AND pwc.products_cleared >= tepc.te_products
            THEN 'COMMERCIAL_EVALUATION'
          -- Stage 5b: Commercial Evaluation (no-TE flow — only after deadline AND eligible vendors exist)
          WHEN hte.rfq_id IS NULL AND COALESCE(bs.bid_ended, false) = true
            AND he.rfq_id IS NOT NULL
            THEN 'COMMERCIAL_EVALUATION'
          -- Stage 5c (NEW): Stuck at Commercial — no-TE flow, deadline passed, zero eligible vendors
          WHEN hte.rfq_id IS NULL AND COALESCE(bs.bid_ended, false) = true
            AND he.rfq_id IS NULL
            AND rd.is_published = 1 AND rd.status = 1
            THEN 'RFQ_STUCK_COMMERCIAL'
          -- Stage 4: Technical Approver Rejected
          WHEN tl.status = 'REJECTED'
            THEN 'TECHNICAL_REJECTED'
          -- Stage 3: Technical Approving
          WHEN tl.status = 'PENDING'
            THEN 'TECHNICAL_APPROVING'
          -- Stage 2: Technical Evaluating — TE configured, deadline passed, ≥1 eligible vendor
          -- Also matches when latest approval is APPROVED but not all products cleared yet
          WHEN rd.is_published = 1 AND rd.status = 1
            AND (tl.rfq_id IS NULL OR tl.status = 'APPROVED')
            AND hte.rfq_id IS NOT NULL
            AND COALESCE(bs.bid_ended, false) = true
            AND he.rfq_id IS NOT NULL
            THEN 'TECHNICAL_EVALUATING'
          -- Stage 1.9: Stuck at Technical — TE configured, deadline passed, zero eligible vendors
          WHEN rd.is_published = 1 AND rd.status = 1
            AND (tl.rfq_id IS NULL OR tl.status = 'APPROVED')
            AND hte.rfq_id IS NOT NULL
            AND COALESCE(bs.bid_ended, false) = true
            AND he.rfq_id IS NULL
            THEN 'RFQ_STUCK_TECHNICAL'
          -- Stage 1.75: Tech eval configured, bid window still open (with or without early quotes)
          WHEN rd.is_published = 1 AND rd.status = 1 AND hte.rfq_id IS NOT NULL
            AND COALESCE(bs.bid_ended, false) = false
            THEN 'TECHNICAL_AWAITING_QUOTES'
          -- Stage 1.5: Awaiting Quotes (published, open, NO tech eval configured, bid window still open)
          WHEN rd.is_published = 1 AND rd.status = 1 AND hte.rfq_id IS NULL
            AND COALESCE(bs.bid_ended, false) = false
            THEN 'AWAITING_QUOTES'
          -- Stage 1: RFQ Approval (ready to publish / pending approval)
          WHEN rd.status IN (3, 4) OR (rd.is_published = 0 AND rd.status != 1)
            THEN 'RFQ_APPROVAL'
          ELSE NULL
        END AS lifecycle_stage
      FROM rfq_data rd
      LEFT JOIN product_counts pc ON pc.rfq_id = rd.id
      LEFT JOIN tech_latest tl ON tl.rfq_id = rd.id
      LEFT JOIN products_with_cleared pwc ON pwc.rfq_id = rd.id
      LEFT JOIN active_negotiations an ON an.rfq_id = rd.id
      LEFT JOIN neg_quote_pending nqp ON nqp.rfq_id = rd.id
      LEFT JOIN neg_quote_approved nqa ON nqa.rfq_id = rd.id
      LEFT JOIN po_data pd ON pd.rfq_id = rd.id
      LEFT JOIN po_products_approved ppa ON ppa.rfq_id = rd.id
      LEFT JOIN has_tech_eval hte ON hte.rfq_id = rd.id
      LEFT JOIN tech_eval_product_count tepc ON tepc.rfq_id = rd.id
      LEFT JOIN has_eligible_vendors he ON he.rfq_id = rd.id
      LEFT JOIN bid_status bs ON bs.rfq_id = rd.id
    `;

    try {
      const rows = await db.any(q, [rfqIds]);
      const result = {};
      rows.forEach(row => {
        result[row.rfq_id] = row.lifecycle_stage;
      });
      return result;
    } catch (err) {
      logError('computeLifecycleStages error', err);
      return {};
    }
  },

  /**
   * Batch-resolve "who can act" for a list of RFQs based on their lifecycle stage.
   *
   * Approval stages  → current-step pending approvers from tbl_approval_instances
   * Permission stages → users with the required module permissions (via RBAC)
   * No-action stages  → null
   *
   * @param {Array} rfqList  - RFQ rows (must include id, hotel_id, department_id, is_tender)
   * @param {Object} lifecycleMap - { rfq_id: lifecycle_stage } from computeLifecycleStages
   * @returns {Object} { [rfq_id]: { type, label, users: [{id, name, email}] } | null }
   */
  getActionHoldersForRFQs: async (rfqList, lifecycleMap) => {
    if (!rfqList || rfqList.length === 0) return {};

    const APPROVAL_STAGES = ['RFQ_APPROVAL', 'TECHNICAL_APPROVING', 'QUOTATION_APPROVAL', 'PO_APPROVAL'];
    const PERMISSION_STAGE_CONFIG = {
      TECHNICAL_AWAITING_QUOTES: { resource: 'te',            actions: ['read', 'create'], useDepartment: true,  label: 'Technical Evaluators' },
      TECHNICAL_EVALUATING:      { resource: 'te',            actions: ['read', 'create'], useDepartment: true,  label: 'Technical Evaluators' },
      TECHNICAL_REJECTED:        { resource: 'te',            actions: ['read', 'create'], useDepartment: true,  label: 'Technical Evaluators' },
      AWAITING_QUOTES:           { resource: 'quote-compare', actions: ['read', 'create'], useDepartment: false, label: 'Commercial Evaluators' },
      COMMERCIAL_EVALUATION:     { resource: 'quote-compare', actions: ['read', 'create'], useDepartment: false, label: 'Commercial Evaluators' },
      AWAITING_PO:               { resource: 'awarding',      actions: ['read', 'create'], useDepartment: false, label: 'PO Initiators' },
    };
    const APPROVAL_LABEL = 'Pending Approvers';

    const result = {};

    // --- Categorize RFQs ---
    const approvalRfqs = [];  // { id, is_tender, stage }
    const permissionRfqs = []; // { id, hotel_id, department_id, stage }

    for (const rfq of rfqList) {
      const rfqId = parseInt(rfq.id);
      const stage = lifecycleMap[rfqId] || null;
      if (!stage) { result[rfqId] = null; continue; }

      if (APPROVAL_STAGES.includes(stage)) {
        approvalRfqs.push({ id: rfqId, is_tender: rfq.is_tender, stage });
      } else if (PERMISSION_STAGE_CONFIG[stage]) {
        permissionRfqs.push({ id: rfqId, hotel_id: rfq.hotel_id, department_id: rfq.department_id, stage });
      } else {
        result[rfqId] = null; // NEGOTIATION_ONGOING, APPROVED_COMPLETED, etc.
      }
    }

    // --- 1. Batch resolve approval-stage action holders ---
    if (approvalRfqs.length > 0) {
      try {
        const rfqApprovalIds = approvalRfqs.filter(r => r.stage === 'RFQ_APPROVAL').map(r => r.id);
        const techApprovingIds = approvalRfqs.filter(r => r.stage === 'TECHNICAL_APPROVING').map(r => r.id);
        const quoteApprovalIds = approvalRfqs.filter(r => r.stage === 'QUOTATION_APPROVAL').map(r => r.id);
        const poApprovalIds = approvalRfqs.filter(r => r.stage === 'PO_APPROVAL').map(r => r.id);

        // Build UNION query for all approval types at once
        const cteParts = [];
        const params = [];
        let paramIdx = 1;

        if (rfqApprovalIds.length > 0) {
          params.push(rfqApprovalIds);
          cteParts.push(`
            SELECT ai.entity_id AS rfq_id, u.id AS user_id, u.name, u.email, ais.decision_rule
            FROM tbl_approval_instances ai
            JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id AND ais.step_order = ai.current_step
            JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id AND asa.status = 'PENDING'
            JOIN tbl_users u ON u.id = asa.approver_user_id
            WHERE ai.entity_type IN ('RFQ', 'TENDER')
              AND ai.entity_id = ANY($${paramIdx}::int[])
              AND ai.status = 'PENDING'
          `);
          paramIdx++;
        }

        if (techApprovingIds.length > 0) {
          params.push(techApprovingIds);
          cteParts.push(`
            SELECT (ai.metadata->>'rfq_id')::int AS rfq_id, u.id AS user_id, u.name, u.email, ais.decision_rule
            FROM tbl_approval_instances ai
            JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id AND ais.step_order = ai.current_step
            JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id AND asa.status = 'PENDING'
            JOIN tbl_users u ON u.id = asa.approver_user_id
            WHERE ai.entity_type = 'TECHNICAL'
              AND ai.status = 'PENDING'
              AND metadata->>'rfq_id' IS NOT NULL
              AND (ai.metadata->>'rfq_id')::int = ANY($${paramIdx}::int[])
          `);
          paramIdx++;
        }

        if (quoteApprovalIds.length > 0) {
          params.push(quoteApprovalIds);
          cteParts.push(`
            SELECT (ai.metadata->>'rfq_id')::int AS rfq_id, u.id AS user_id, u.name, u.email, ais.decision_rule
            FROM tbl_approval_instances ai
            JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id AND ais.step_order = ai.current_step
            JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id AND asa.status = 'PENDING'
            JOIN tbl_users u ON u.id = asa.approver_user_id
            WHERE ai.entity_type = 'NEGOTIATION_QUOTE'
              AND ai.status = 'PENDING'
              AND metadata->>'rfq_id' IS NOT NULL
              AND (ai.metadata->>'rfq_id')::int = ANY($${paramIdx}::int[])
          `);
          paramIdx++;
        }

        if (poApprovalIds.length > 0) {
          params.push(poApprovalIds);
          cteParts.push(`
            SELECT (ai.metadata->>'rfq_id')::int AS rfq_id, u.id AS user_id, u.name, u.email, ais.decision_rule
            FROM tbl_approval_instances ai
            JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id AND ais.step_order = ai.current_step
            JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id AND asa.status = 'PENDING'
            JOIN tbl_users u ON u.id = asa.approver_user_id
            WHERE ai.entity_type = 'PO'
              AND ai.status = 'PENDING'
              AND metadata->>'rfq_id' IS NOT NULL
              AND (ai.metadata->>'rfq_id')::int = ANY($${paramIdx}::int[])
          `);
          paramIdx++;
        }

        if (cteParts.length > 0) {
          const sql = cteParts.join(' UNION ') + ' ORDER BY rfq_id, name';
          const rows = await db.any(sql, params);

          // Group by rfq_id
          const grouped = {};
          for (const row of rows) {
            if (!grouped[row.rfq_id]) grouped[row.rfq_id] = { users: [], decision_rule: row.decision_rule || null };
            // Deduplicate by user_id
            if (!grouped[row.rfq_id].users.some(u => u.id === row.user_id)) {
              grouped[row.rfq_id].users.push({ id: row.user_id, name: row.name, email: row.email });
            }
          }

          for (const rfq of approvalRfqs) {
            result[rfq.id] = {
              type: 'approval',
              label: APPROVAL_LABEL,
              users: grouped[rfq.id]?.users || [],
              decision_rule: grouped[rfq.id]?.decision_rule || null
            };
          }
        } else {
          for (const rfq of approvalRfqs) {
            result[rfq.id] = { type: 'approval', label: APPROVAL_LABEL, users: [], decision_rule: null };
          }
        }
      } catch (err) {
        logError('getActionHoldersForRFQs approval error', err);
        for (const rfq of approvalRfqs) {
          result[rfq.id] = null;
        }
      }
    }

    // --- 2. Batch resolve permission-stage action holders ---
    if (permissionRfqs.length > 0) {
      try {
        // Deduplicate by (hotel_id, department_id|null, resource)
        const lookupMap = new Map();
        for (const rfq of permissionRfqs) {
          const config = PERMISSION_STAGE_CONFIG[rfq.stage];
          const deptId = config.useDepartment && rfq.department_id ? parseInt(rfq.department_id) : null;
          const key = `${rfq.hotel_id}|${deptId}|${config.resource}`;

          if (!lookupMap.has(key)) {
            lookupMap.set(key, {
              hotelIds: [parseInt(rfq.hotel_id)],
              resource: config.resource,
              actions: config.actions,
              departmentId: deptId,
              label: config.label,
              rfqIds: []
            });
          }
          lookupMap.get(key).rfqIds.push(rfq.id);
        }

        // Execute all unique lookups in parallel
        const lookupResults = await Promise.all(
          [...lookupMap.values()].map(async (lookup) => {
            const users = await rbacModel.getUsersWithModuleActionsForHotels(
              lookup.hotelIds, lookup.resource, lookup.actions, lookup.departmentId
            );
            return { rfqIds: lookup.rfqIds, label: lookup.label, users };
          })
        );

        // Map results back to RFQ IDs
        for (const lr of lookupResults) {
          for (const rfqId of lr.rfqIds) {
            result[rfqId] = {
              type: 'permission',
              label: lr.label,
              users: lr.users.map(u => ({ id: u.id, name: u.name, email: u.email }))
            };
          }
        }
      } catch (err) {
        logError('getActionHoldersForRFQs permission error', err);
        for (const rfq of permissionRfqs) {
          result[rfq.id] = null;
        }
      }
    }

    return result;
  },

  /**
   * Get complete lifecycle summary for a single RFQ.
   * Returns 4 logical phases with full detail:
   *   1. RFQ Approval (with expired/auto-published handling)
   *   2. Technical Phase (evaluation + approval combined, per-product clause scores)
   *   3. Commercial Phase (finalization + negotiation + quotation approval)
   *   4. PO Phase (PO creation + approval + completion)
   *
   * @param {number} rfqId - RFQ ID
   * @param {number} userId - Current user ID (for can_user_approve)
   * @returns {Object} { rfq_id, current_stage, phases: [...] }
   */
  getLifecycleSummary: async (rfqId, userId) => {
    // Phase mapping from raw lifecycle stages
    const PHASE_MAP = {
      RFQ_APPROVAL: 'rfq_approval',
      AWAITING_QUOTES: 'commercial',  // No tech eval → skip technical phase, land in commercial
      TECHNICAL_AWAITING_QUOTES: 'technical',  // Tech eval configured but no quotes yet
      TECHNICAL_EVALUATING: 'technical',
      TECHNICAL_APPROVING: 'technical',
      TECHNICAL_REJECTED: 'technical',
      RFQ_STUCK_TECHNICAL: 'technical',  // Bid ended, no eligible vendors — stuck in technical phase
      COMMERCIAL_EVALUATION: 'commercial',
      RFQ_STUCK_COMMERCIAL: 'commercial', // Bid ended, no eligible vendors (no-TE flow) — stuck in commercial phase
      NEGOTIATION_ONGOING: 'commercial',
      QUOTATION_APPROVAL: 'commercial',
      AWAITING_PO: 'purchase_order',
      PO_APPROVAL: 'purchase_order',
      APPROVED_COMPLETED: 'purchase_order',
    };

    const PHASES_ORDERED = ['rfq_approval', 'technical', 'commercial', 'purchase_order'];

    try {
      // 1. Get RFQ basic info + current lifecycle stage
      const rfqBasic = await db.oneOrNone(`
        SELECT id, is_published, status, is_tender, hotel_id, department_id, hospitality_company_id, process_id, bid_end_date FROM tbl_rfq WHERE id = $1
      `, [rfqId]);
      if (!rfqBasic) return { rfq_id: rfqId, current_stage: null, phases: [] };

      const lifecycleMap = await rfqModel.computeLifecycleStages([rfqId]);
      const currentStage = lifecycleMap[rfqId] || null;
      let currentPhase = currentStage ? PHASE_MAP[currentStage] : null;
      let currentPhaseIndex = currentPhase ? PHASES_ORDERED.indexOf(currentPhase) : -1;

      // APPROVED_COMPLETED means all phases are done — no "current" phase
      if (currentStage === 'APPROVED_COMPLETED') {
        currentPhase = null;
        currentPhaseIndex = PHASES_ORDERED.length; // Beyond all phases → all show as 'completed'
      }

      // Resolve action holders for the current stage (who needs to act)
      let currentActionHolders = null;
      if (currentStage) {
        const actionMap = await rfqModel.getActionHoldersForRFQs([rfqBasic], lifecycleMap);
        currentActionHolders = actionMap[parseInt(rfqId)] || null;
      }

      // 2. Fetch all data in parallel
      const [
        rfqApprovalInstanceIds,
        techApprovalInstanceIds,
        quoteApprovalInstanceIds,
        poApprovalInstanceIds,
        techEvalProducts,
        techEvalClauseData,
        techEvalClearedVendors,
        negotiationRounds,
        finalizationData,
        poData,
        awaitingQuoteStats,
        evaluators,
      ] = await Promise.all([
        db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type IN ('RFQ','TENDER') AND entity_id = $1 ORDER BY created_at ASC`, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: RFQ approval instances query failed`); return []; }),
        db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type = 'TECHNICAL' AND metadata->>'rfq_id' IS NOT NULL AND (metadata->>'rfq_id')::int = $1 ORDER BY created_at ASC`, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: tech approval instances query failed`); return []; }),
        db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type = 'NEGOTIATION_QUOTE' AND metadata->>'rfq_id' IS NOT NULL AND (metadata->>'rfq_id')::int = $1 ORDER BY created_at ASC`, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: quote approval instances query failed`); return []; }),
        db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type = 'PO' AND metadata->>'rfq_id' IS NOT NULL AND (metadata->>'rfq_id')::int = $1 ORDER BY created_at ASC`, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: PO approval instances query failed`); return []; }),

        // Tech eval: per-product summary
        db.any(`
          SELECT te.id AS tech_eval_id, te.tbl_rfq_product_id AS product_id,
            COALESCE(pv.name, 'Product ' || te.tbl_rfq_product_id) AS product_name,
            te.minimum_passing_score, te.current_round,
            (SELECT COUNT(DISTINCT rpv.user_id) FROM tbl_rfq_product_vendors rpv WHERE rpv.rfq_id = $1 AND rpv.product_variant_id = rp.product_variant_id AND COALESCE(rpv.variant::text, '0') = COALESCE(rp.variant::text, '0')) AS total_vendors
          FROM tbl_rfq_product_tech_evaluation te
          LEFT JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
          LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
          WHERE te.rfq_id = $1
          ORDER BY te.tbl_rfq_product_id
        `, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: tech eval products query failed`); return []; }),

        // Tech eval: clause-level scores per vendor per product
        db.any(`
          SELECT
            c.tbl_rfq_product_tech_evaluation_id AS tech_eval_id,
            c.id AS clause_id, c.clause_text, c.clause_type, c.weightage,
            vr.vendor_id, u_vendor.name AS vendor_name,
            COALESCE(u_vendor_c.company_name, u_vendor.organization_name) AS vendor_company,
            vr.vendor_response, vr.buyer_marks, vr.buyer_remark,
            vr.score_timestamp
          FROM tbl_rfq_product_tech_evaluation_clauses c
          JOIN tbl_rfq_product_tech_evaluation te ON te.id = c.tbl_rfq_product_tech_evaluation_id
          LEFT JOIN tbl_rfq_product_tech_evaluation_vendors_response vr ON vr.tbl_rfq_product_tech_evaluation_clauses_id = c.id
          LEFT JOIN tbl_users u_vendor ON u_vendor.id = vr.vendor_id
          LEFT JOIN tbl_company u_vendor_c ON u_vendor_c.id = u_vendor.company_id
          WHERE te.rfq_id = $1
          ORDER BY c.tbl_rfq_product_tech_evaluation_id, c.id, vr.vendor_id
        `, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: tech eval clause data query failed`); return []; }),

        // Tech eval: cleared vendors (pass/fail)
        db.any(`
          SELECT cv.tbl_rfq_product_tech_evaluation_id AS tech_eval_id,
            cv.vendor_id, cv.status, cv.reject_message, cv.evaluation_round,
            cv.created_by AS evaluated_by_id, cv.timestamp AS evaluated_at,
            u_vendor.name AS vendor_name,
            COALESCE(u_vendor_c.company_name, u_vendor.organization_name) AS vendor_company,
            u_evaluator.name AS evaluated_by_name
          FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
          JOIN tbl_rfq_product_tech_evaluation te ON te.id = cv.tbl_rfq_product_tech_evaluation_id
          LEFT JOIN tbl_users u_vendor ON u_vendor.id = cv.vendor_id
          LEFT JOIN tbl_company u_vendor_c ON u_vendor_c.id = u_vendor.company_id
          LEFT JOIN tbl_users u_evaluator ON u_evaluator.id = cv.created_by
          WHERE te.rfq_id = $1
          ORDER BY cv.tbl_rfq_product_tech_evaluation_id, cv.vendor_id
        `, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: tech eval cleared vendors query failed`); return []; }),

        // Negotiation rounds with vendor quotes
        db.any(`
          SELECT nr.id, nr.rfq_product_id, nr.round_number, nr.status, nr.end_date, nr.target_price,
            COALESCE(pv.name, 'Product') AS product_name,
            nrq.vendor_id, u_v.name AS vendor_name,
            COALESCE(u_v_company.company_name, u_v.organization_name) AS vendor_company,
            nrq.quoted_price, nrq.submitted_at AS quote_submitted_at
          FROM tbl_negotiation_rounds nr
          LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
          LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
          LEFT JOIN tbl_negotiation_round_quotes nrq ON nrq.negotiation_round_id = nr.id
          LEFT JOIN tbl_users u_v ON u_v.id = nrq.vendor_id
          LEFT JOIN tbl_company u_v_company ON u_v_company.id = u_v.company_id
          WHERE nr.rfq_id = $1
          ORDER BY nr.round_number, nrq.vendor_id
        `, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: negotiation rounds query failed`); return []; }),

        // Finalization data
        db.any(`
          SELECT rp.id AS rfq_product_id, qf.product_variant_id, qf.vendor_id,
            COALESCE(pv.name, 'Product') AS product_name, qf.variant,
            u_vendor.name AS finalized_vendor_name,
            COALESCE(u_vendor_c.company_name, u_vendor.organization_name) AS finalized_vendor_company,
            qi.unit_price AS finalized_price, qi.total_price AS total_price,
            u_buyer.name AS finalized_by_name,
            qf.timestamp AS finalized_at
          FROM tbl_quote_finalization qf
          LEFT JOIN tbl_rfq_products rp ON rp.product_variant_id = qf.product_variant_id
            AND COALESCE(rp.variant, 0) = COALESCE(qf.variant, 0)
            AND rp.rfq_id = qf.rfq_id
          LEFT JOIN tbl_product_variant pv ON pv.id = qf.product_variant_id
          LEFT JOIN tbl_users u_vendor ON u_vendor.id = qf.vendor_id
          LEFT JOIN tbl_company u_vendor_c ON u_vendor_c.id = u_vendor.company_id
          LEFT JOIN tbl_users u_buyer ON u_buyer.id = qf.created_by
          LEFT JOIN tbl_quote_items qi ON qi.quote_id = qf.quote_id AND qi.product_variant_id = qf.product_variant_id AND qi.variant = qf.variant
          WHERE qf.rfq_id = $1
          ORDER BY qf.timestamp
        `, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: finalization data query failed`); return []; }),

        // PO data (with product names)
        db.any(`
          SELECT po.id, po.po_number, po.status, po.total_value,
            u_vendor.name AS vendor_name,
            COALESCE(u_vendor_c.company_name, u_vendor.organization_name) AS vendor_company,
            po.created_at,
            (
              SELECT STRING_AGG(COALESCE(pv.name, 'Product ' || pop.rfq_product_id), ', ' ORDER BY pop.id)
              FROM tbl_purchase_order_product pop
              LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
              LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
              WHERE pop.purchase_order_id = po.id
            ) AS product_names
          FROM tbl_rfq_purchase_order po
          LEFT JOIN tbl_users u_vendor ON u_vendor.id = po.finalized_vendor_id
          LEFT JOIN tbl_company u_vendor_c ON u_vendor_c.id = u_vendor.company_id
          WHERE po.rfq_id = $1
          ORDER BY po.created_at
        `, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: PO data query failed`); return []; }),

        db.one(`
          WITH assigned_products AS (
            SELECT DISTINCT
              rpv.user_id,
              rpv.product_variant_id,
              COALESCE(rpv.variant::text, '0') AS variant_key
            FROM tbl_rfq_product_vendors rpv
            WHERE rpv.rfq_id = $1
          ),
          vendor_regrets AS (
            SELECT DISTINCT q.created_by AS user_id
            FROM tbl_quotes q
            WHERE q.rfq_id = $1
              AND q.is_regret = 1
          ),
          product_responses AS (
            SELECT
              ap.user_id,
              ap.product_variant_id,
              ap.variant_key,
              BOOL_OR(
                q.id IS NOT NULL
                AND (
                  COALESCE(qi.unit_price, 0) > 0
                  OR NULLIF(BTRIM(COALESCE(qi.comment, '')), '') IS NOT NULL
                  OR NULLIF(BTRIM(COALESCE(qi.delivery_period::text, '')), '') IS NOT NULL
                  OR EXISTS (
                    SELECT 1
                    FROM tbl_quote_item_files qif
                    WHERE qif.quote_item_id = qi.id
                  )
                )
              ) AS has_any_submission,
              BOOL_OR(
                q.id IS NOT NULL
                AND COALESCE(qi.unit_price, 0) > 0
              ) AS has_commercial_submission
            FROM assigned_products ap
            LEFT JOIN tbl_quotes q
              ON q.rfq_id = $1
             AND q.created_by = ap.user_id
             AND COALESCE(q.is_regret, 0) != 1
            LEFT JOIN tbl_quote_items qi
              ON qi.quote_id = q.id
             AND qi.rfq_id = $1
             AND qi.product_variant_id = ap.product_variant_id
             AND COALESCE(qi.variant::text, '0') = ap.variant_key
            GROUP BY ap.user_id, ap.product_variant_id, ap.variant_key
          ),
          vendor_rollup AS (
            SELECT
              ap.user_id,
              COUNT(*)::int AS assigned_products,
              COUNT(*) FILTER (WHERE pr.has_any_submission)::int AS submitted_products,
              COUNT(*) FILTER (WHERE pr.has_commercial_submission)::int AS quoted_products,
              BOOL_OR(vr.user_id IS NOT NULL) AS has_regret
            FROM assigned_products ap
            LEFT JOIN product_responses pr
              ON pr.user_id = ap.user_id
             AND pr.product_variant_id = ap.product_variant_id
             AND pr.variant_key = ap.variant_key
            LEFT JOIN vendor_regrets vr
              ON vr.user_id = ap.user_id
            GROUP BY ap.user_id
          )
          SELECT
            COUNT(*)::int AS total_invited,
            COUNT(*) FILTER (
              WHERE NOT has_regret
                AND assigned_products > 0
                AND submitted_products = assigned_products
            )::int AS participated,
            COUNT(*) FILTER (
              WHERE NOT has_regret
                AND assigned_products > 0
                AND submitted_products = assigned_products
                AND quoted_products > 0
            )::int AS sent_quotes,
            COUNT(*) FILTER (
              WHERE NOT has_regret
                AND assigned_products > 0
                AND submitted_products = assigned_products
                AND quoted_products = 0
            )::int AS technical_only,
            COUNT(*) FILTER (WHERE has_regret)::int AS regrets,
            COUNT(*) FILTER (
              WHERE NOT has_regret
                AND submitted_products < assigned_products
            )::int AS remaining
          FROM vendor_rollup
        `, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: awaiting quote stats query failed`); return { total_invited: 0, participated: 0, sent_quotes: 0, technical_only: 0, regrets: 0, remaining: 0 }; }),

        // Evaluator names: users who have both te.read and te.create permissions
        // scoped to this RFQ's business unit (hotel) and department
        db.any(`
          SELECT DISTINCT u.id, u.name
          FROM tbl_users u
          JOIN tbl_user_role_scopes urs ON urs.user_id = u.id
          JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
          JOIN tbl_permissions p ON p.id = rp.permission_id
          JOIN tbl_rfq rfq ON rfq.id = $1
          JOIN tbl_hospitality_company_hotels hch ON hch.id = rfq.hotel_id AND hch.is_deleted = 0
          WHERE urs.company_id = hch.hospitality_company_id
            AND p.resource = 'te'
            AND p.action IN ('read', 'create')
            AND (
              urs.hotel_id = rfq.hotel_id
              OR (
                urs.hotel_id IS NULL
                AND EXISTS (
                  SELECT 1 FROM tbl_hospitality_user_mappings hum
                  WHERE hum.user_id = u.id
                    AND (
                      hum.hospitality_hotel_id = rfq.hotel_id
                      OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL
                          AND hum.hospitality_company_id = hch.hospitality_company_id)
                    )
                )
              )
            )
            AND (
              rfq.department_id IS NULL
              OR urs.department_id = rfq.department_id
              OR (
                urs.department_id IS NULL
                AND EXISTS (
                  SELECT 1 FROM tbl_user_department ud
                  WHERE ud.user_id = u.id AND ud.department_id = rfq.department_id
                )
              )
            )
          GROUP BY u.id, u.name
          HAVING COUNT(DISTINCT p.action) = 2
        `, [rfqId]).catch(e => { logger.warn(e, `Lifecycle[${rfqId}]: evaluators query failed`); return []; }),
      ]);

      // Override phase mapping: AWAITING_QUOTES defaults to 'commercial',
      // but when tech eval IS configured, the next step should be 'technical'.
      if (currentStage === 'AWAITING_QUOTES' && techEvalProducts.length > 0) {
        currentPhase = 'technical';
        currentPhaseIndex = PHASES_ORDERED.indexOf('technical');
      }

      // 3. Fetch detailed approval instances (parallel)
      const fetchDetails = async (rows) => {
        if (!rows?.length) return [];
        const results = await Promise.allSettled(
          rows.map(row => getApprovalInstanceDetails(row.id, userId))
        );
        return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
      };

      const [rfqApprovalDetails, techApprovalDetails, quoteApprovalDetails, poApprovalDetails] = await Promise.all([
        fetchDetails(rfqApprovalInstanceIds),
        fetchDetails(techApprovalInstanceIds),
        fetchDetails(quoteApprovalInstanceIds),
        fetchDetails(poApprovalInstanceIds),
      ]);

      // 3b. Enrich NEGOTIATION_QUOTE instances with product info (entity_id = rfq_product_id)
      if (quoteApprovalDetails.length > 0) {
        // Collect product IDs from entity_id AND metadata.rfq_product_id
        const productIds = [...new Set(
          quoteApprovalDetails.flatMap(d => [d.entity_id, d.metadata?.rfq_product_id]).filter(Boolean).map(Number)
        )];
        if (productIds.length > 0) {
          const productInfo = await db.any(`
            SELECT rp.id, COALESCE(pv.name, 'Product ' || rp.id) AS product_name, rp.variant
            FROM tbl_rfq_products rp
            LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
            WHERE rp.id = ANY($1::int[])
          `, [productIds]).catch(() => []);
          const prodMap = {};
          productInfo.forEach(p => { prodMap[parseInt(p.id)] = p; });
          for (const inst of quoteApprovalDetails) {
            const pid = parseInt(inst.metadata?.rfq_product_id || inst.entity_id);
            if (pid && prodMap[pid]) {
              const p = prodMap[pid];
              inst.metadata = inst.metadata || {};
              inst.metadata.product_name = p.product_name + (p.variant && p.variant !== '0' ? ` (${p.variant})` : '');
              inst.metadata.rfq_product_id = pid;
            }
          }
        }
      }

      // 3c. Enrich PO instances with PO number + product names (entity_id = po_id)
      if (poApprovalDetails.length > 0) {
        const poIds = [...new Set(poApprovalDetails.map(d => d.entity_id).filter(Boolean))];
        if (poIds.length > 0) {
          const poInfo = await db.any(`
            SELECT po.id, po.po_number,
              (SELECT STRING_AGG(COALESCE(pv.name, 'Product ' || pop.rfq_product_id), ', ' ORDER BY pop.id)
               FROM tbl_purchase_order_product pop
               LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
               LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
               WHERE pop.purchase_order_id = po.id) AS product_names
            FROM tbl_rfq_purchase_order po WHERE po.id = ANY($1::int[])
          `, [poIds]).catch(() => []);
          const poMap = {};
          poInfo.forEach(p => { poMap[p.id] = p; });
          for (const inst of poApprovalDetails) {
            if (inst.entity_id && poMap[inst.entity_id]) {
              inst.metadata = inst.metadata || {};
              inst.metadata.po_number = poMap[inst.entity_id].po_number;
              inst.metadata.product_names = poMap[inst.entity_id].product_names;
            }
          }
        }
      }

      // 4. Helper: format approval instances
      const formatApprovalInstances = (details) => {
        if (!details?.length) return null;
        return details.map(d => ({
          id: d.id, status: d.status,
          entity_type: d.entity_type, entity_id: d.entity_id,
          current_step: d.current_step, total_steps: d.total_steps,
          can_user_approve: d.can_user_approve || false,
          user_approval_step_id: d.user_approval_step_id || null,
          initiated_by: d.initiated_by || null,
          metadata: d.metadata || null,
          created_at: d.created_at, completed_at: d.completed_at,
          steps: (d.steps || []).map(s => ({
            step_order: s.step_order, decision_rule: s.decision_rule,
            status: s.status, completed_at: s.completed_at,
            approvers: (s.approvers || []).map(a => ({
              user_id: a.user_id, user_name: a.user_name, user_email: a.user_email,
              user_designation: a.user_designation, user_department: a.user_department,
              employee_code: a.employee_code,
              status: a.status, acted_at: a.acted_at, comment: a.comment,
            })),
          })),
        }));
      };

      // 5. Build tech eval detailed structure: per-product → vendors → clauses
      const buildTechEvalDetail = () => {
        if (!techEvalProducts.length) return null;

        return techEvalProducts.map(prod => {
          const teId = prod.tech_eval_id;
          // Get cleared vendors for this product
          const vendors = techEvalClearedVendors
            .filter(cv => cv.tech_eval_id === teId)
            .map(cv => {
              // Get clause scores for this vendor
              const clauseScores = techEvalClauseData
                .filter(c => c.tech_eval_id === teId && c.vendor_id === cv.vendor_id)
                .map(c => ({
                  clause_text: c.clause_text,
                  clause_type: c.clause_type,
                  weightage: c.weightage ? parseFloat(c.weightage) : null,
                  vendor_response: c.vendor_response,
                  buyer_marks: c.buyer_marks != null ? parseFloat(c.buyer_marks) : null,
                  buyer_remark: c.buyer_remark,
                }));

              const totalMarks = clauseScores.reduce((sum, c) => sum + (c.buyer_marks || 0), 0);
              const maxMarks = clauseScores.reduce((sum, c) => sum + (c.weightage || 0), 0);

              return {
                vendor_id: cv.vendor_id,
                vendor_name: cv.vendor_name,
                vendor_company: cv.vendor_company,
                status: cv.status === 1 ? 'PASSED' : 'FAILED',
                reject_message: cv.reject_message,
                evaluation_round: cv.evaluation_round,
                evaluated_by: cv.evaluated_by_name,
                evaluated_at: cv.evaluated_at,
                total_marks: totalMarks,
                max_marks: maxMarks,
                score_percentage: maxMarks > 0 ? Math.round((totalMarks / maxMarks) * 100) : null,
                clause_scores: clauseScores,
              };
            });

          const passed = vendors.filter(v => v.status === 'PASSED').length;
          const failed = vendors.filter(v => v.status === 'FAILED').length;

          return {
            product_id: prod.product_id,
            product_name: prod.product_name,
            minimum_passing_score: prod.minimum_passing_score ? parseFloat(prod.minimum_passing_score) : null,
            current_round: parseInt(prod.current_round || 1),
            total_vendors: parseInt(prod.total_vendors || 0),
            passed, failed,
            vendors,
          };
        });
      };

      // 6. Build negotiation detail: grouped by round
      // 6b. Build commercial data grouped by product (finalization + negotiation combined)
      const buildCommercialProducts = () => {
        const productMap = {};

        // Add finalization data
        for (const f of finalizationData) {
          const key = f.rfq_product_id || f.product_variant_id;
          if (!productMap[key]) {
            productMap[key] = {
              product_id: key,
              product_name: f.product_name + (f.variant && f.variant !== '0' ? ` (${f.variant})` : ''),
              finalization: null,
              negotiation_rounds: [],
            };
          }
          productMap[key].finalization = {
            vendor_name: f.finalized_vendor_name || 'Unknown',
            vendor_company: f.finalized_vendor_company,
            finalized_price: f.finalized_price ? parseFloat(f.finalized_price) : null,
            total_price: f.total_price ? parseFloat(f.total_price) : null,
            finalized_by: f.finalized_by_name,
            finalized_at: f.finalized_at,
          };
        }

        // Add negotiation rounds grouped by product
        const roundMap = {};
        for (const row of negotiationRounds) {
          if (!roundMap[row.id]) {
            roundMap[row.id] = {
              round_number: row.round_number, status: row.status,
              rfq_product_id: row.rfq_product_id,
              product_name: row.product_name, end_date: row.end_date,
              target_price: row.target_price ? parseFloat(row.target_price) : null,
              vendors: [],
            };
          }
          if (row.vendor_id) {
            roundMap[row.id].vendors.push({
              vendor_name: row.vendor_name, vendor_company: row.vendor_company,
              quoted_price: row.quoted_price ? parseFloat(row.quoted_price) : null,
              submitted_at: row.quote_submitted_at,
            });
          }
        }
        for (const round of Object.values(roundMap)) {
          const key = round.rfq_product_id;
          if (!productMap[key]) {
            productMap[key] = {
              product_id: key,
              product_name: round.product_name,
              finalization: null,
              negotiation_rounds: [],
            };
          }
          productMap[key].negotiation_rounds.push({
            round_number: round.round_number, status: round.status,
            end_date: round.end_date, target_price: round.target_price,
            vendors: round.vendors,
          });
        }

        // Sort negotiation rounds oldest first within each product
        for (const prod of Object.values(productMap)) {
          prod.negotiation_rounds.sort((a, b) => a.round_number - b.round_number);
        }

        const result = Object.values(productMap);
        return result.length > 0 ? result : null;
      };

      // 8. Build PO detail
      const buildPODetail = () => {
        if (!poData.length) return null;
        return poData.map(po => ({
          id: po.id, po_number: po.po_number, status: po.status,
          vendor_name: po.vendor_name, vendor_company: po.vendor_company,
          total_amount: po.total_value ? parseFloat(po.total_value) : null,
          product_names: po.product_names || null,
          created_at: po.created_at,
        }));
      };

      const buildAwaitingQuotesSnapshot = () => ({
        total_invited: parseInt(awaitingQuoteStats?.total_invited || 0, 10),
        participated: parseInt(awaitingQuoteStats?.participated || 0, 10),
        sent_quotes: parseInt(awaitingQuoteStats?.sent_quotes || 0, 10),
        technical_only: parseInt(awaitingQuoteStats?.technical_only || 0, 10),
        regrets: parseInt(awaitingQuoteStats?.regrets || 0, 10),
        remaining: parseInt(awaitingQuoteStats?.remaining || 0, 10),
        bid_end_date: rfqBasic.bid_end_date || null,
      });

      const buildAwaitingQuotesSummary = (stats) => {
        if (!stats) return null;
        const parts = [
          `${stats.participated} participated`,
          `${stats.sent_quotes} quote${stats.sent_quotes === 1 ? '' : 's'}`,
        ];
        if (stats.regrets > 0) {
          parts.push(`${stats.regrets} regret${stats.regrets === 1 ? '' : 's'}`);
        }
        parts.push(`${stats.remaining} remaining`);
        return parts.join(' · ');
      };

      // 9. Determine phase statuses
      const getPhaseStatus = (phaseKey) => {
        const phaseIndex = PHASES_ORDERED.indexOf(phaseKey);
        if (phaseIndex < 0) return 'upcoming';
        if (phaseKey === currentPhase) return 'current';
        if (phaseIndex < currentPhaseIndex) return 'completed';
        return 'upcoming';
      };

      const hasPhaseData = (phaseKey) => {
        switch (phaseKey) {
          case 'rfq_approval': return rfqApprovalDetails.length > 0;
          case 'technical': return techEvalProducts.length > 0 || techApprovalDetails.length > 0;
          case 'commercial': return finalizationData.length > 0 || negotiationRounds.length > 0 || quoteApprovalDetails.length > 0;
          case 'purchase_order': return poData.length > 0 || poApprovalDetails.length > 0;
          default: return false;
        }
      };

      // 10. Build phases
      const isPublished = rfqBasic.is_published === 1 || rfqBasic.status === 1;
      const phases = [];

      // Phase 1: RFQ Approval
      {
        let status = getPhaseStatus('rfq_approval');
        const hasData = rfqApprovalDetails.length > 0;
        if (!hasData && status === 'completed') status = 'skipped';

        const latestInstance = rfqApprovalDetails.length > 0 ? rfqApprovalDetails[rfqApprovalDetails.length - 1] : null;
        // Expired: RFQ is published but approval is still PENDING
        const isExpired = isPublished && latestInstance?.status === 'PENDING';

        let summary = null;
        if (isExpired) {
          summary = 'Auto-published — approval was not completed in time';
          status = 'expired';
        } else if (latestInstance?.status === 'APPROVED') {
          const names = [];
          (latestInstance.steps || []).forEach(s => (s.approvers || []).forEach(a => { if (a.status === 'APPROVED' && a.user_name) names.push(a.user_name); }));
          summary = names.length > 0 ? `Approved by ${names.join(', ')}` : 'Approved';
        } else if (latestInstance?.status === 'CANCELLED') {
          summary = 'Approval was cancelled';
        } else if (!hasData) {
          summary = 'No approval configured';
        }

        phases.push({
          key: 'rfq_approval', label: 'RFQ Approval', status, summary,
          is_cancelled: latestInstance?.status === 'CANCELLED',
          completed_at: latestInstance?.completed_at || null,
          approval_instances: hasData ? formatApprovalInstances(rfqApprovalDetails) : null,
        });
      }

      // Phase 2: Technical (Evaluation + Approval combined)
      {
        let status = getPhaseStatus('technical');
        const hasData = hasPhaseData('technical');
        if (!hasData && status === 'completed') status = 'skipped';

        const techProducts = buildTechEvalDetail();
        const totalPassed = techProducts ? techProducts.reduce((s, p) => s + p.passed, 0) : 0;
        const totalFailed = techProducts ? techProducts.reduce((s, p) => s + p.failed, 0) : 0;
        const totalVendors = techProducts ? techProducts.reduce((s, p) => s + p.total_vendors, 0) : 0;

        let summary = null;
        if (hasData && techProducts?.length > 0) {
          summary = `${totalPassed} passed, ${totalFailed} failed out of ${totalVendors} vendors across ${techProducts.length} product${techProducts.length === 1 ? '' : 's'}`;
        }

        // Determine sub-status based on current raw stage
        let subStatus = null;
        if (currentStage === 'TECHNICAL_AWAITING_QUOTES') subStatus = 'awaiting_quotes';
        else if (currentStage === 'TECHNICAL_EVALUATING') subStatus = 'evaluating';
        else if (currentStage === 'TECHNICAL_APPROVING') subStatus = 'approving';
        else if (currentStage === 'TECHNICAL_REJECTED') subStatus = 'rejected';
        else if (currentStage === 'RFQ_STUCK_TECHNICAL') subStatus = 'no_vendors_participated';

        const awaitingQuotes = ['TECHNICAL_AWAITING_QUOTES', 'RFQ_STUCK_TECHNICAL'].includes(currentStage)
          ? buildAwaitingQuotesSnapshot()
          : null;
        if (awaitingQuotes) {
          summary = buildAwaitingQuotesSummary(awaitingQuotes);
        }

        const latestTechInstance = techApprovalDetails.length > 0 ? techApprovalDetails[techApprovalDetails.length - 1] : null;

        phases.push({
          key: 'technical', label: 'Technical Evaluation', status, summary, sub_status: subStatus,
          is_cancelled: latestTechInstance?.status === 'CANCELLED',
          evaluators: evaluators.map(e => ({ id: e.id, name: e.name })),
          products: techProducts,
          awaiting_quotes: awaitingQuotes,
          approval_instances: techApprovalDetails.length > 0 ? formatApprovalInstances(techApprovalDetails) : null,
          action_holders: status === 'current' ? currentActionHolders : null,
        });
      }

      // Phase 3: Commercial (Finalization + Negotiation + Quote Approval) — product-centric
      {
        let status = getPhaseStatus('commercial');
        const hasData = hasPhaseData('commercial');
        if (!hasData && status === 'completed') status = 'skipped';

        const commercialProducts = buildCommercialProducts();

        let summary = null;
        const finalizedCount = commercialProducts?.filter(p => p.finalization)?.length || 0;
        if (finalizedCount > 0) {
          summary = `${finalizedCount} product${finalizedCount === 1 ? '' : 's'} finalized`;
        }
        const totalRounds = commercialProducts?.reduce((s, p) => s + p.negotiation_rounds.length, 0) || 0;
        if (totalRounds > 0) {
          summary = (summary ? summary + ' · ' : '') + `${totalRounds} negotiation round${totalRounds === 1 ? '' : 's'}`;
        }

        let subStatus = null;
        if (currentStage === 'AWAITING_QUOTES') subStatus = 'awaiting_quotes';
        else if (currentStage === 'COMMERCIAL_EVALUATION') subStatus = 'evaluating';
        else if (currentStage === 'NEGOTIATION_ONGOING') subStatus = 'negotiating';
        else if (currentStage === 'QUOTATION_APPROVAL') subStatus = 'approving';
        else if (currentStage === 'RFQ_STUCK_COMMERCIAL') subStatus = 'no_vendors_participated';

        const awaitingQuotes = ['AWAITING_QUOTES', 'RFQ_STUCK_COMMERCIAL'].includes(currentStage)
          ? buildAwaitingQuotesSnapshot()
          : null;
        if (awaitingQuotes) {
          summary = buildAwaitingQuotesSummary(awaitingQuotes);
        }

        const latestQuoteInstance = quoteApprovalDetails.length > 0 ? quoteApprovalDetails[quoteApprovalDetails.length - 1] : null;

        phases.push({
          key: 'commercial', label: 'Commercial Evaluation', status, summary, sub_status: subStatus,
          is_cancelled: latestQuoteInstance?.status === 'CANCELLED',
          products: commercialProducts,
          awaiting_quotes: awaitingQuotes,
          approval_instances: quoteApprovalDetails.length > 0 ? formatApprovalInstances(quoteApprovalDetails) : null,
          action_holders: status === 'current' ? currentActionHolders : null,
        });
      }

      // Phase 4: Purchase Order (PO + Approval + Completion)
      {
        let status = getPhaseStatus('purchase_order');
        const hasData = hasPhaseData('purchase_order');
        if (!hasData && status === 'completed') status = 'skipped';

        const purchaseOrders = buildPODetail();
        const totalAmount = purchaseOrders ? purchaseOrders.reduce((s, po) => s + (po.total_value || 0), 0) : 0;

        let summary = null;
        if (purchaseOrders?.length > 0) {
          summary = `${purchaseOrders.length} PO${purchaseOrders.length === 1 ? '' : 's'}`;
          if (totalAmount > 0) summary += ` · ₹${totalAmount.toLocaleString('en-IN')}`;
        }

        let subStatus = null;
        if (currentStage === 'AWAITING_PO') subStatus = 'awaiting_creation';
        else if (currentStage === 'PO_APPROVAL') subStatus = 'approving';
        else if (currentStage === 'APPROVED_COMPLETED') subStatus = 'completed';

        const latestPOInstance = poApprovalDetails.length > 0 ? poApprovalDetails[poApprovalDetails.length - 1] : null;

        phases.push({
          key: 'purchase_order', label: 'Purchase Order', status, summary, sub_status: subStatus,
          is_cancelled: latestPOInstance?.status === 'CANCELLED',
          purchase_orders: purchaseOrders,
          approval_instances: poApprovalDetails.length > 0 ? formatApprovalInstances(poApprovalDetails) : null,
          action_holders: status === 'current' ? currentActionHolders : null,
        });
      }

      // 11. Resolve upcoming actors (who will evaluate/approve in future phases)
      const UPCOMING_PERMISSION_CONFIG = {
        technical: { resource: 'te', actions: ['read', 'create'], useDepartment: true },
        commercial: { resource: 'quote-compare', actions: ['read', 'create'], useDepartment: false },
        purchase_order: { resource: 'awarding', actions: ['read', 'create'], useDepartment: false },
      };
      const UPCOMING_ENTITY_TYPE_MAP = {
        rfq_approval: rfqBasic.is_tender === 1 ? 'TENDER' : 'RFQ',
        technical: 'TECHNICAL',
        commercial: 'NEGOTIATION_QUOTE',
        purchase_order: 'PO',
      };

      // Resolve actors for upcoming + current phases (in parallel)
      const companyId = parseInt(rfqBasic.hospitality_company_id);
      const hotelId = rfqBasic.hotel_id ? parseInt(rfqBasic.hotel_id) : null;
      const deptId = rfqBasic.department_id ? parseInt(rfqBasic.department_id) : null;
      const processId = rfqBasic.process_id ? parseInt(rfqBasic.process_id) : null;
      const hotelIds = hotelId ? [hotelId] : [];

      const resolvePhaseActors = async (phase) => {
        const actors = { evaluators: null, approver_steps: null };

        // Permission-based evaluators
        const permConfig = UPCOMING_PERMISSION_CONFIG[phase.key];
        if (permConfig && hotelIds.length > 0) {
          const pd = permConfig.useDepartment ? deptId : null;
          const users = await rbacModel.getUsersWithModuleActionsForHotels(hotelIds, permConfig.resource, permConfig.actions, pd).catch(() => []);
          if (users.length > 0) actors.evaluators = users.map(u => ({ id: u.id, name: u.name }));
        }

        // Policy-based approvers
        const entityType = UPCOMING_ENTITY_TYPE_MAP[phase.key];
        if (entityType) {
          try {
            const policy = await findBestMatchingPolicy({ entity_type: entityType, hospitality_company_id: companyId, hotel_id: hotelId, department_id: deptId, process_id: processId });
            if (policy) {
              // All entities are department-scoped
              const resolveDeptId = deptId;

              const policySteps = await db.any('SELECT * FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 ORDER BY step_order ASC', [policy.id]);
              const resourceForEntity = ENTITY_APPROVE_RESOURCE_MAP[entityType] || entityType.toLowerCase();
              const stepResults = await Promise.allSettled(
                policySteps.map(async (step) => {
                  if (step.approver_source_type === 'ROLE') {
                    const hasBoth = await roleHasReadAndApprovePermission(step.approver_source_id, resourceForEntity, db);
                    if (!hasBoth) return null;
                  }
                  const ids = await resolveApprovers(step, companyId, hotelId, resolveDeptId, db, null);
                  if (!ids?.length) return null;
                  const names = await db.any('SELECT id, name FROM tbl_users WHERE id = ANY($1::int[])', [ids]);
                  return { step_order: step.step_order, decision_rule: step.decision_rule || 'ANY', approvers: names.map(u => ({ id: u.id, name: u.name })) };
                })
              );
              const resolved = stepResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
              if (resolved.length > 0) actors.approver_steps = resolved;
            }
          } catch (e) { logError(`Policy resolution failed for ${entityType}`, e); }
        }

        if (actors.evaluators || actors.approver_steps) phase.upcoming_actors = actors;
      };

      await Promise.allSettled(
        phases.filter(p => p.status === 'upcoming' || p.status === 'current').map(resolvePhaseActors)
      );

      // Surface top-level approval action info for header buttons.
      // Scan all phases for an approval instance where the current user can approve.
      let userCanApprove = false;
      let userApprovalInstanceId = null;
      let userApprovalStepId = null;
      let userApprovalEntityType = null;

      for (const phase of phases) {
        if (!phase.approval_instances) continue;
        // Skip expired phases — the approval is stale (e.g. auto-published RFQ)
        if (phase.status === 'expired') continue;
        for (const inst of phase.approval_instances) {
          if (inst.can_user_approve && inst.status === 'PENDING') {
            userCanApprove = true;
            userApprovalInstanceId = inst.id;
            userApprovalStepId = inst.user_approval_step_id;
            userApprovalEntityType = inst.entity_type;
            break;
          }
        }
        if (userCanApprove) break;
      }

      // Determine if the current user needs to take action (approval or evaluation).
      let userActionRequired = false;
      let userActionType = null;
      let userActionLabel = null;
      let userActionPhase = null;

      // Stages where the user's action is NOT yet required even if they are
      // an action holder: bid window still open (nothing to evaluate yet) or
      // bid ended with zero vendor participation (nothing to act on).
      const NON_ACTIONABLE_STAGES = new Set([
        'AWAITING_QUOTES',
        'TECHNICAL_AWAITING_QUOTES',
        'RFQ_STUCK_TECHNICAL',
        'RFQ_STUCK_COMMERCIAL',
      ]);

      if (userCanApprove) {
        userActionRequired = true;
        userActionType = 'approval';
        userActionLabel = 'You have a pending approval action';
        userActionPhase = phases.find(p => p.approval_instances?.some(i => i.id === userApprovalInstanceId))?.key || null;
      } else if (
        currentActionHolders?.users?.length > 0 &&
        !NON_ACTIONABLE_STAGES.has(currentStage)
      ) {
        const isCurrentUserActionHolder = currentActionHolders.users.some(u => parseInt(u.id) === parseInt(userId));
        if (isCurrentUserActionHolder) {
          userActionRequired = true;
          userActionType = currentActionHolders.type === 'permission' ? 'evaluation' : 'approval';
          userActionLabel = `You are a ${currentActionHolders.label?.toLowerCase() || 'action holder'} for this ${rfqBasic.is_tender === 1 ? 'Tender' : 'RFQ'}`;
          userActionPhase = currentPhase;
        }
      }

      return {
        rfq_id: rfqId,
        current_stage: currentStage,
        current_phase: currentPhase,
        // Top-level approval action info — for header approve/reject buttons
        user_can_approve: userCanApprove,
        user_approval_instance_id: userApprovalInstanceId,
        user_approval_step_id: userApprovalStepId,
        user_approval_entity_type: userApprovalEntityType,
        // Action-required indicator — for visual highlight on the current stage
        user_action_required: userActionRequired,
        user_action_type: userActionType,
        user_action_label: userActionLabel,
        user_action_phase: userActionPhase,
        phases,
      };
    } catch (err) {
      logError('getLifecycleSummary error', err);
      return { rfq_id: rfqId, current_stage: null, phases: [] };
    }
  },

  getBuyerRfqCount: async (
    user_id,
    project_id,
    rfq_type,
    reverse_auction,
    rfq_no,
    is_tender,
    completed_status,
    hotel_ids
  ) => {
    return new Promise(function (resolve, reject) {
      let isTenderFilter = '';
      if (is_tender !== null && is_tender !== undefined) {
        isTenderFilter = `AND RFQ.is_tender = ${is_tender === '1' || is_tender === 1 || is_tender === true ? 1 : 0}`;
      }
      db.any(
        `SELECT COUNT(*) from tbl_rfq RFQ
        LEFT JOIN tbl_projects P ON RFQ.project_id = P.id  -- Join on project_id to get project_name
        WHERE (RFQ.created_by = ${user_id} OR EXISTS (
        SELECT 1 FROM tbl_project_team PT WHERE PT.project_id = RFQ.project_id AND PT.user_id = ${user_id}
        UNION ALL
        SELECT 1 FROM tbl_hospitality_user_mappings HUM
        WHERE HUM.user_id = ${user_id}
          AND (
            HUM.hospitality_hotel_id = RFQ.hotel_id
            OR (HUM.mapping_type = 0 AND HUM.hospitality_hotel_id IS NULL
                AND HUM.hospitality_company_id = RFQ.hospitality_company_id)
          )
        )) AND (RFQ.is_published = 1 OR RFQ.status IN (2, 3, 4))
        -- Permission filter: only RFQs the user has read access for
        AND EXISTS (
          SELECT 1 FROM tbl_user_role_scopes _urs2
          JOIN tbl_role_permissions _rp2 ON _rp2.role_id = _urs2.role_id
          JOIN tbl_permissions _p2 ON _p2.id = _rp2.permission_id
          WHERE _urs2.user_id = ${user_id}
            AND _p2.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
            AND _p2.action = 'read'
            AND _urs2.company_id = RFQ.hospitality_company_id
            AND (_urs2.hotel_id IS NULL OR _urs2.hotel_id = RFQ.hotel_id)
            AND (
              RFQ.department_id IS NULL
              OR _urs2.department_id = RFQ.department_id
              OR _urs2.department_id IS NULL
            )
        )
        AND (RFQ.project_id = $1 OR $1 IS NULL)
        AND (RFQ.rfq_type = $2 OR $2 IS NULL)  -- Filter by rfq_type if provided
        AND (RFQ.reverse_auction = $3 OR $3 IS NULL)  -- Filter by reverse_auction if provided
        AND (RFQ.rfq_no::text LIKE '%$4%' OR $4 IS NULL) -- Filter by rfq_no if provided
        ${isTenderFilter}
        ${completed_status === 'completed' ? `AND (
          (SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN false
          ELSE (SELECT BOOL_AND(_ha) FROM (SELECT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po2
            JOIN tbl_purchase_order_product _pop2 ON _pop2.purchase_order_id = _po2.id
            WHERE _po2.rfq_id = RFQ.id AND _pop2.rfq_product_id = _rp2.id
            AND _po2.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
          ) AS _ha FROM tbl_rfq_products _rp2 WHERE _rp2.rfq_id = RFQ.id) _c) END) = true
          OR (SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN false
          ELSE (SELECT COUNT(*) FILTER (WHERE _ha) > 0 AND COUNT(*) FILTER (WHERE NOT _ha) > 0
            FROM (SELECT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po3
            JOIN tbl_purchase_order_product _pop3 ON _pop3.purchase_order_id = _po3.id
            WHERE _po3.rfq_id = RFQ.id AND _pop3.rfq_product_id = _rp3.id
            AND _po3.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
          ) AS _ha FROM tbl_rfq_products _rp3 WHERE _rp3.rfq_id = RFQ.id) _c2) END) = true
        )` : ''}
        ${completed_status === 'closed' ? `AND RFQ.status = 2` : ''}
        ${completed_status === 'active' ? `AND RFQ.status != 2 AND NOT (
          (SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN false
          ELSE (SELECT BOOL_AND(_ha) FROM (SELECT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po2
            JOIN tbl_purchase_order_product _pop2 ON _pop2.purchase_order_id = _po2.id
            WHERE _po2.rfq_id = RFQ.id AND _pop2.rfq_product_id = _rp2.id
            AND _po2.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
          ) AS _ha FROM tbl_rfq_products _rp2 WHERE _rp2.rfq_id = RFQ.id) _c) END) = true
        )` : ''}
        ${Array.isArray(hotel_ids) && hotel_ids.length > 0 ? `AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = RFQ.id AND rhm.hotel_id IN (${hotel_ids.map(id => parseInt(id)).filter(Number.isFinite).join(',')}))` : ''}
        ;`,
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
  // Get RFQs/Tenders where user is in the approval line (current pending step)
  getPendingApprovalRfqs: async (
    limit,
    offset,
    user_id,
    project_id,
    sort,
    reverse_auction,
    rfq_type,
    rfq_no,
    is_tender
  ) => {
    return new Promise(function (resolve, reject) {
      let q = `
        SELECT
          RFQ.*,
          P.name AS project_name,
          (SELECT ai_type.entity_type
           FROM tbl_approval_instances ai_type
           JOIN tbl_approval_instance_steps ais_type ON ais_type.approval_instance_id = ai_type.id
           JOIN tbl_approval_step_approvers asa_type ON asa_type.approval_instance_step_id = ais_type.id
           WHERE ai_type.status = 'PENDING'
             AND asa_type.approver_user_id = ${user_id}
             AND asa_type.status = 'PENDING'
             AND ais_type.step_order = ai_type.current_step
             AND (
               (ai_type.entity_type IN ('RFQ', 'TENDER') AND ai_type.entity_id = RFQ.id)
               OR (ai_type.entity_type = 'NEGOTIATION_QUOTE' AND ai_type.entity_id IN (SELECT rp.id FROM tbl_rfq_products rp WHERE rp.rfq_id = RFQ.id))
             )
           ORDER BY CASE WHEN ai_type.entity_type = 'NEGOTIATION_QUOTE' THEN 0 ELSE 1 END
           LIMIT 1
          ) AS pending_approval_type,
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
          ) AS "products",
          -- can_edit: user has 'update' permission for this RFQ's hotel + department + resource type
          EXISTS (
            SELECT 1 FROM tbl_user_role_scopes _urs
            JOIN tbl_role_permissions _rp ON _rp.role_id = _urs.role_id
            JOIN tbl_permissions _p ON _p.id = _rp.permission_id
            WHERE _urs.user_id = ${user_id}
              AND _p.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
              AND _p.action = 'update'
              AND _urs.company_id = RFQ.hospitality_company_id
              AND (_urs.hotel_id IS NULL OR _urs.hotel_id = RFQ.hotel_id)
              AND (
                RFQ.department_id IS NULL
                OR _urs.department_id = RFQ.department_id
                OR _urs.department_id IS NULL
              )
          ) AS can_edit
      FROM tbl_rfq RFQ
      LEFT JOIN tbl_projects P ON RFQ.project_id = P.id
      WHERE EXISTS (
        SELECT 1
        FROM tbl_approval_instances ai
        JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
        JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id
        WHERE ai.status = 'PENDING'
          AND asa.approver_user_id = ${user_id}
          AND asa.status = 'PENDING'
          AND ais.step_order = ai.current_step
          AND (
            (ai.entity_type IN ('RFQ', 'TENDER') AND ai.entity_id = RFQ.id)
            OR (ai.entity_type = 'NEGOTIATION_QUOTE' AND ai.entity_id IN (SELECT rp.id FROM tbl_rfq_products rp WHERE rp.rfq_id = RFQ.id))
          )
      )
      -- Permission filter: only RFQs the user has read access for
      AND EXISTS (
        SELECT 1 FROM tbl_user_role_scopes _urs2
        JOIN tbl_role_permissions _rp2 ON _rp2.role_id = _urs2.role_id
        JOIN tbl_permissions _p2 ON _p2.id = _rp2.permission_id
        WHERE _urs2.user_id = ${user_id}
          AND _p2.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
          AND _p2.action = 'read'
          AND _urs2.company_id = RFQ.hospitality_company_id
          AND (_urs2.hotel_id IS NULL OR _urs2.hotel_id = RFQ.hotel_id)
          AND (
            RFQ.department_id IS NULL
            OR _urs2.department_id = RFQ.department_id
            OR _urs2.department_id IS NULL
          )
      )
      AND (RFQ.project_id = $1 OR $1 IS NULL)
      AND (RFQ.rfq_type = $2 OR $2 IS NULL)
      AND (RFQ.reverse_auction = $3 OR $3 IS NULL)
      AND (RFQ.rfq_no::text LIKE '%$6%' OR $6 IS NULL)
      ${is_tender !== null && is_tender !== undefined ? `AND RFQ.is_tender = ${is_tender === '1' || is_tender === 1 || is_tender === true ? 1 : 0}` : ''}
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
  getPendingApprovalRfqCount: async (
    user_id,
    project_id,
    rfq_type,
    reverse_auction,
    rfq_no,
    is_tender
  ) => {
    return new Promise(function (resolve, reject) {
      let isTenderFilter = '';
      if (is_tender !== null && is_tender !== undefined) {
        isTenderFilter = `AND RFQ.is_tender = ${is_tender === '1' || is_tender === 1 || is_tender === true ? 1 : 0}`;
      }
      db.any(
        `SELECT COUNT(*) from tbl_rfq RFQ
        LEFT JOIN tbl_projects P ON RFQ.project_id = P.id
        WHERE EXISTS (
          SELECT 1
          FROM tbl_approval_instances ai
          JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
          JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id
          WHERE ai.status = 'PENDING'
            AND asa.approver_user_id = ${user_id}
            AND asa.status = 'PENDING'
            AND ais.step_order = ai.current_step
            AND (
              (ai.entity_type IN ('RFQ', 'TENDER') AND ai.entity_id = RFQ.id)
              OR (ai.entity_type = 'NEGOTIATION_QUOTE' AND ai.entity_id IN (SELECT rp.id FROM tbl_rfq_products rp WHERE rp.rfq_id = RFQ.id))
            )
        )
        -- Permission filter: only RFQs the user has read access for
        AND EXISTS (
          SELECT 1 FROM tbl_user_role_scopes _urs2
          JOIN tbl_role_permissions _rp2 ON _rp2.role_id = _urs2.role_id
          JOIN tbl_permissions _p2 ON _p2.id = _rp2.permission_id
          WHERE _urs2.user_id = ${user_id}
            AND _p2.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
            AND _p2.action = 'read'
            AND _urs2.company_id = RFQ.hospitality_company_id
            AND (_urs2.hotel_id IS NULL OR _urs2.hotel_id = RFQ.hotel_id)
            AND (
              RFQ.department_id IS NULL
              OR _urs2.department_id = RFQ.department_id
              OR _urs2.department_id IS NULL
            )
        )
        AND (RFQ.project_id = $1 OR $1 IS NULL)
        AND (RFQ.rfq_type = $2 OR $2 IS NULL)
        AND (RFQ.reverse_auction = $3 OR $3 IS NULL)
        AND (RFQ.rfq_no::text LIKE '%$4%' OR $4 IS NULL)
        ${isTenderFilter};
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
      // Filter for technically accepted vendors only
      // Two conditions ANDed: (1) vendor passed at least 1 product in RFQ, (2) vendor passed THIS product
      // Each condition falls through if no tech eval exists at that level
      const vendorCondition = `
        AND (
          -- Condition 1: Vendor passed at least one product in this RFQ (or no tech eval in RFQ)
          NOT EXISTS (
            SELECT 1 FROM tbl_rfq_product_tech_evaluation _TEC_rfq WHERE _TEC_rfq.rfq_id = $1
          )
          OR EXISTS (
            SELECT 1
            FROM tbl_rfq_product_tech_evaluation_cleared_vendors _TECV_rfq
            JOIN tbl_rfq_product_tech_evaluation _TEC_rfq2 ON _TECV_rfq.tbl_rfq_product_tech_evaluation_id = _TEC_rfq2.id
            WHERE _TEC_rfq2.rfq_id = $1
              AND _TECV_rfq.vendor_id = TQ.created_by
              AND _TECV_rfq.status = 1
          )
        )
        AND (
          -- Condition 2: Vendor passed THIS product (or this product has no tech eval)
          NOT EXISTS (
            SELECT 1 FROM tbl_rfq_product_tech_evaluation _TEC_prod WHERE _TEC_prod.tbl_rfq_product_id = TRP.id
          )
          OR EXISTS (
            SELECT 1
            FROM tbl_rfq_product_tech_evaluation_cleared_vendors _TECV_prod
            JOIN tbl_rfq_product_tech_evaluation _TEC_prod2 ON _TECV_prod.tbl_rfq_product_tech_evaluation_id = _TEC_prod2.id
            WHERE _TEC_prod2.tbl_rfq_product_id = TRP.id
              AND _TECV_prod.vendor_id = TQ.created_by
              AND _TECV_prod.status = 1
          )
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
    rfq_product_id,
    include_negotiation = false,
    vendor_filter_id = null
  ) => {
    if(rfq_product_id) {
      rfq_product_id = rfq_product_id.split(",").map(Number);
    }

    return new Promise(function (resolve, reject) {
      // Filter for technically accepted vendors only
      // Two conditions ANDed: (1) vendor passed at least 1 product in RFQ, (2) vendor passed THIS product
      // Each condition falls through if no tech eval exists at that level
      const vendorCondition = `
      AND (
        -- Condition 1: Vendor passed at least one product in this RFQ (or no tech eval in RFQ)
        NOT EXISTS (
          SELECT 1 FROM tbl_rfq_product_tech_evaluation _TEC_rfq WHERE _TEC_rfq.rfq_id = $1
        )
        OR EXISTS (
          SELECT 1
          FROM tbl_rfq_product_tech_evaluation_cleared_vendors _TECV_rfq
          JOIN tbl_rfq_product_tech_evaluation _TEC_rfq2 ON _TECV_rfq.tbl_rfq_product_tech_evaluation_id = _TEC_rfq2.id
          WHERE _TEC_rfq2.rfq_id = $1
            AND _TECV_rfq.vendor_id = TQ.created_by
            AND _TECV_rfq.status = 1
        )
      )
      AND (
        -- Condition 2: Vendor passed THIS product (or this product has no tech eval)
        NOT EXISTS (
          SELECT 1 FROM tbl_rfq_product_tech_evaluation _TEC_prod WHERE _TEC_prod.tbl_rfq_product_id = TRF.id
        )
        OR EXISTS (
          SELECT 1
          FROM tbl_rfq_product_tech_evaluation_cleared_vendors _TECV_prod
          JOIN tbl_rfq_product_tech_evaluation _TEC_prod2 ON _TECV_prod.tbl_rfq_product_tech_evaluation_id = _TEC_prod2.id
          WHERE _TEC_prod2.tbl_rfq_product_id = TRF.id
            AND _TECV_prod.vendor_id = TQ.created_by
            AND _TECV_prod.status = 1
        )
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

        ${include_negotiation ? `
        , (
          SELECT json_build_object(
            'id', NR.id, 'rfq_id', NR.rfq_id, 'rfq_product_id', NR.rfq_product_id,
            'round_number', NR.round_number, 'target_price', NR.target_price,
            'status', NR.status, 'end_date', NR.end_date,
            'approved_at', NR.approved_at, 'published_at', NR.published_at,
            'closed_at', NR.closed_at, 'created_by', NR.created_by,
            'created_by_name', NRU.name, 'created_by_email', NRU.email,
            'remarks', NR.remarks, 'created_at', NR.created_at,
            'vendor_ids', NR.vendor_ids,
            'vendor_approvals', NR.vendor_approvals
          )
          FROM tbl_negotiation_rounds NR
          LEFT JOIN tbl_users NRU ON NRU.id = NR.created_by
          WHERE NR.rfq_product_id = TRF.id
            AND NR.status IN ('PENDING_APPROVAL', 'ACTIVE', 'ENDED', 'CLOSED')
            AND ($5::int IS NULL OR $5 = ANY(NR.vendor_ids))
          ORDER BY NR.round_number DESC
          LIMIT 1
        ) AS "active_round"

        , (
          SELECT json_agg(sub ORDER BY sub.submitted_at DESC)
          FROM (
            SELECT
              NRQ.id, NRQ.negotiation_round_id,
              NRQ.vendor_id, NRQU.name AS vendor_name,
              NRQU.email AS vendor_email,
              COALESCE(NRQCO.company_name, NRQU.organization_name, NRQU.name) AS organization_name,
              NRQ.rfq_product_id,
              NRQ.quoted_price, NRQ.previous_price,
              NRQ.submitted_at
            FROM tbl_negotiation_round_quotes NRQ
            LEFT JOIN tbl_users NRQU ON NRQU.id = NRQ.vendor_id
            LEFT JOIN tbl_company NRQCO ON NRQCO.id = NRQU.company_id
            WHERE NRQ.negotiation_round_id = (
              SELECT NR2.id FROM tbl_negotiation_rounds NR2
              WHERE NR2.rfq_product_id = TRF.id
                AND NR2.status IN ('PENDING_APPROVAL', 'ACTIVE', 'ENDED', 'CLOSED')
                AND ($5::int IS NULL OR $5 = ANY(NR2.vendor_ids))
              ORDER BY NR2.round_number DESC LIMIT 1
            )
          ) sub
        ) AS "active_round_quotes"

        , (
          SELECT json_agg(pv_sub ORDER BY pv_sub.in_active_round ASC, pv_sub.organization_name ASC)
          FROM (
            SELECT
              RPV_U.id,
              RPV_U.name,
              RPV_U.email,
              RPV_U.organization_name,
              COALESCE(RPV_C.company_name, RPV_U.organization_name) AS company_name,
              CASE WHEN EXISTS (
                SELECT 1 FROM tbl_negotiation_rounds ANR
                WHERE ANR.rfq_product_id = TRF.id
                  AND ANR.status IN ('PENDING_APPROVAL', 'ACTIVE')
                  AND RPV_U.id = ANY(ANR.vendor_ids)
              ) THEN true ELSE false END AS in_active_round,
              (
                SELECT json_build_object('round_id', ANR2.id, 'round_number', ANR2.round_number, 'status', ANR2.status)
                FROM tbl_negotiation_rounds ANR2
                WHERE ANR2.rfq_product_id = TRF.id
                  AND ANR2.status IN ('PENDING_APPROVAL', 'ACTIVE')
                  AND RPV_U.id = ANY(ANR2.vendor_ids)
                ORDER BY ANR2.round_number DESC LIMIT 1
              ) AS active_round_info
            FROM tbl_rfq_product_vendors RPV
            JOIN tbl_users RPV_U ON RPV_U.id = RPV.user_id
            LEFT JOIN tbl_company RPV_C ON RPV_C.id = RPV_U.company_id
            WHERE RPV.rfq_id = TRF.rfq_id
              AND RPV.product_variant_id = TRF.product_variant_id
              AND RPV.variant = TRF.variant
              AND EXISTS (
                SELECT 1 FROM tbl_quotes _pv_q
                JOIN tbl_quote_items _pv_qi ON _pv_qi.quote_id = _pv_q.id
                WHERE _pv_q.rfq_id = TRF.rfq_id
                  AND _pv_q.created_by = RPV_U.id
                  AND _pv_qi.product_variant_id = TRF.product_variant_id
                  AND _pv_qi.variant = TRF.variant
              )
          ) pv_sub
        ) AS "product_vendors"

        , (
          SELECT json_build_object(
            'has_pending_approval', (AI.status = 'PENDING'),
            'approval_instance', json_build_object(
              'id', AI.id, 'status', AI.status, 'current_step', AI.current_step,
              'metadata', AI.metadata,
              'created_at', AI.created_at, 'completed_at', AI.completed_at
            )
          )
          FROM tbl_approval_instances AI
          WHERE AI.entity_type = 'NEGOTIATION_QUOTE'
            AND AI.entity_id = TRF.id
          ORDER BY AI.created_at DESC
          LIMIT 1
        ) AS "quote_approval_status"
        ` : ''}

        FROM tbl_rfq_products TRF
        WHERE TRF.rfq_id = $1
        ${rfq_product_id ? `AND TRF.id = ANY($4)` : ''}
        ;`;

      db.query(mainQuery, [id, user_id, company_id, rfq_product_id, vendor_filter_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getQuoteVisibilityLockedProductsByRfqId: async (id, rfq_product_id) => {
    if (rfq_product_id) {
      rfq_product_id = rfq_product_id.split(',').map(Number);
    }

    const query = `
      SELECT
        TRF.id,
        TRF.rfq_id,
        TRF.product_variant_id,
        TRF.variant,
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
            'product_name', COALESCE(PV.name, P.name),
            'rfq_details', (
              SELECT json_agg(
                json_build_object(
                  'title', TPS.title,
                  'value', TPS.value
                )
              )
              FROM tbl_rfq_products_specs TPS
              WHERE TPS.product_variant_id = TRF.product_variant_id
                AND COALESCE(TPS.variant, 0) = COALESCE(TRF.variant, 0)
                AND TPS.rfq_id = $1
            )
          )
          FROM tbl_product_variant PV
          LEFT JOIN tbl_product P ON P.id = PV.product_id
          WHERE PV.id = TRF.product_variant_id
        ) AS "product_details",
        ARRAY(
          SELECT json_build_object('title', TPS.title, 'value', TPS.value)
          FROM tbl_rfq_products_specs TPS
          WHERE TPS.product_variant_id = TRF.product_variant_id
            AND COALESCE(TPS.variant, 0) = COALESCE(TRF.variant, 0)
            AND TPS.rfq_id = $1
        ) AS "product_specs",
        '[]'::json AS "quotations",
        '[]'::json AS "all_vendors",
        '[]'::json AS "finalization_history",
        NULL::json AS "last_purchase_rate",
        NULL::json AS "last_quote_rate",
        NULL::numeric AS "latest_target_price"
      FROM tbl_rfq_products TRF
      WHERE TRF.rfq_id = $1
      ${rfq_product_id ? 'AND TRF.id = ANY($2)' : ''}
      ORDER BY TRF.id ASC;
    `;

    return db.any(query, rfq_product_id ? [id, rfq_product_id] : [id]);
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

  withdrawRFQPublish: async (id, user_id, status) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `UPDATE tbl_rfq
        SET status = $1, updated_by = $2
        WHERE id = $3 RETURNING *`,
        [status, user_id, id]
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
      logError('Error in getRFQActivity', error);
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
    _locationFilters = {},
    hotel_ids = []
  ) => {
    const normalizedSearchKey = (search_key || '').trim();
    const isSearchAll = normalizedSearchKey.toLowerCase() === 'all';

    const params = [normalizedSearchKey];
    let paramIdx = 2;

    const categoryParam = category_id ? `$${paramIdx++}` : null;
    if (category_id) params.push(category_id);

    const approvedByParam = approved_by_id ? `$${paramIdx++}` : null;
    if (approved_by_id) params.push(approved_by_id);

    let hotelIdsParam = null;
    if (Array.isArray(hotel_ids) && hotel_ids.length > 0) {
      hotelIdsParam = `$${paramIdx++}`;
      params.push(hotel_ids);
    }

    const candidateLimitParam = `$${paramIdx++}`;
    params.push(isSearchAll ? 500 : 200);

    const searchCondition = isSearchAll
      ? 'TRUE'
      : `(
          pv.slug = $1
          OR to_tsvector('english', pv.name) @@ plainto_tsquery('english', $1)
          OR to_tsvector('english', p.name) @@ plainto_tsquery('english', $1)
          OR similarity(pv.name, $1) > 0.1
          OR similarity(p.name, $1) > 0.1
        )`;

    // Include vendors with active OR expired subscriptions in vendor count.
    // Expired vendors are included in RFQs but blocked from actions until they renew.
    const vendorCountCte = hotelIdsParam
      ? `
      vendor_counts AS (
        SELECT pvvm.product_variant_id AS variant_id,
               pc.category_id,
               COUNT(DISTINCT pvvm.vendor_id)::int AS vendor_count
        FROM tbl_product_variant_vendor_mapping pvvm
        JOIN matched_variants mv ON mv.variant_id = pvvm.product_variant_id
        JOIN product_categories pc ON pc.product_id = mv.product_id
        JOIN tbl_vendor_hotel_category_subscription vhcs_cat
          ON vhcs_cat.vendor_id = pvvm.vendor_id
          AND vhcs_cat.item_type = 'category'
          AND vhcs_cat.item_id = pc.category_id
          AND vhcs_cat.status IN ('active', 'expired')
        JOIN tbl_vendor_hotel_category_subscription vhcs_hotel
          ON vhcs_hotel.vendor_id = pvvm.vendor_id
          AND vhcs_hotel.item_type = 'hotel'
          AND vhcs_hotel.item_id = ANY(${hotelIdsParam})
          AND vhcs_hotel.status IN ('active', 'expired')
        WHERE pvvm.status = TRUE
          AND pvvm.is_approved = TRUE
        GROUP BY pvvm.product_variant_id, pc.category_id
      )`
      : `
      vendor_counts AS (
        SELECT pvvm.product_variant_id AS variant_id,
               NULL::bigint AS category_id,
               COUNT(DISTINCT pvvm.vendor_id)::int AS vendor_count
        FROM tbl_product_variant_vendor_mapping pvvm
        JOIN matched_variants mv ON mv.variant_id = pvvm.product_variant_id
        WHERE pvvm.status = TRUE
          AND pvvm.is_approved = TRUE
        GROUP BY pvvm.product_variant_id
      )`;

    const q = `
      WITH matched_variants AS (
        SELECT pv.id AS variant_id,
               pv.product_id,
               pv.name AS variant_name,
               pv.slug,
               p.name AS product_name,
               p.description,
               CONCAT(pv.name, ' - ', p.name) AS unified_name,
               ${
                 isSearchAll
                   ? '0::float AS similarity_score, 0::float AS rank'
                   : `GREATEST(
                        similarity(pv.name, $1),
                        similarity(p.name, $1)
                      ) AS similarity_score,
                      GREATEST(
                        ts_rank_cd(to_tsvector('english', pv.name), plainto_tsquery('english', $1)),
                        ts_rank_cd(to_tsvector('english', p.name), plainto_tsquery('english', $1))
                      ) AS rank`
               }
        FROM tbl_product_variant pv
        JOIN tbl_product p ON pv.product_id = p.id
        WHERE p.status = 1
          AND p.is_deleted = 0
          AND p.is_review = 0
          AND p.is_approve = 1
          AND pv.is_approve = 1
          AND ${searchCondition}
        ORDER BY
          CASE WHEN pv.slug = $1 THEN 0 ELSE 1 END,
          rank DESC,
          similarity_score DESC,
          pv.id ASC
        LIMIT ${candidateLimitParam}
      ),
      product_categories AS (
        SELECT pc.product_id,
               c.id AS category_id,
               c.title AS category_name,
               c.parent_id
        FROM tbl_product_categories pc
        JOIN tbl_category c ON c.id = pc.category_id
        ${categoryParam ? `WHERE c.id = ${categoryParam}` : ''}
      ),
      ${vendorCountCte}
      SELECT *
      FROM (
        SELECT DISTINCT
               mv.product_id,
               mv.product_name,
               mv.unified_name,
               mv.variant_id,
               mv.variant_name,
               mv.description,
               mv.slug,
               pc.category_name,
               pc.category_id,
               pc.parent_id AS parent_category_id,
               img.new_image_name AS image_url,
               COALESCE(vc.vendor_count, 0) AS vendor_count,
               mv.similarity_score,
               mv.rank
        FROM matched_variants mv
        JOIN product_categories pc ON pc.product_id = mv.product_id
        LEFT JOIN LATERAL (
          SELECT tpi.new_image_name
          FROM tbl_product_images tpi
          WHERE tpi.product_id = mv.product_id
          LIMIT 1
        ) img ON TRUE
        LEFT JOIN vendor_counts vc
          ON vc.variant_id = mv.variant_id
         ${hotelIdsParam ? 'AND vc.category_id = pc.category_id' : ''}
        ${
          approvedByParam
            ? `WHERE EXISTS (
                SELECT 1
                FROM tbl_vendorapprove_product_mapping vum
                WHERE vum.product_id = mv.product_id
                  AND (vum.vendor_approve_id = ${approvedByParam} OR vum.vendor_approve_id IS NULL)
              )`
            : ''
        }
      ) ranked_results
      ORDER BY
        CASE WHEN ranked_results.slug = $1 THEN 0 ELSE 1 END,
        ranked_results.rank DESC,
        ranked_results.similarity_score DESC,
        ranked_results.unified_name ASC;
    `;

    return new Promise(function (resolve, reject) {
      db.query(q, params)
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
    SELECT c.id AS category_id,
           c.title AS category_name,
           c.parent_id AS parent_category_id,
           pc.title AS parent_category_name,
           similarity(c.title, $1) AS similarity_score,
           ts_rank_cd(to_tsvector('english', c.title), plainto_tsquery('english', $1)) AS rank
    FROM tbl_category c
    LEFT JOIN tbl_category pc ON c.parent_id = pc.id
    WHERE c.status = 1
      AND c.is_deleted = 0
      AND EXISTS (
        SELECT 1
        FROM tbl_product_categories pcats
        JOIN tbl_product p ON p.id = pcats.product_id
        WHERE pcats.category_id = c.id
          AND p.status = 1
          AND p.is_deleted = 0
          AND p.is_review = 0
          AND p.is_approve = 1
          AND p.created_by NOT IN (1, 111)
      )
      AND (
        to_tsvector('english', c.title) @@ plainto_tsquery('english', $1)
        OR similarity(c.title, $1) > 0.1
      )
    ORDER BY rank DESC, similarity_score DESC, c.title ASC
    LIMIT 50;
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
                  AND tus.start_date::date <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND tus.end_date::date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                  THEN 2
                WHEN tsp.plan_name ILIKE '%Premium%'
                  AND tus.status = 1
                  AND tus.start_date::date <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND tus.end_date::date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
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

  logger.debug({ data: q }, 'QUERY SEARCH VENDOR');

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
          logError('genericSearchVendors failed', err);
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

    logger.debug({ data: buyer }, 'searchVendorsByName buyer');

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

    logger.debug({ data: values }, 'searchVendorsByName values');

    return new Promise(function (resolve, reject) {
      db.query(q, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          logError('searchVendorsByName failed', err);
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
      logger.error({ vendorId, rfqNumber }, 'Invalid parameters for getVendorRfqToken');
      return Promise.reject(
        new Error(
          `Invalid parameters: vendorId=${vendorId}, rfqNumber=${rfqNumber}`
        )
      );
    }

    logger.debug({ vendorId: safeVendorId, rfqNumber: safeRfqNumber }, 'Querying token');

    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT token FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id = $1 AND rfq_no = $2;`,
        [safeVendorId, safeRfqNumber]
      )
        .then(function (data) {
          logger.debug({ data, safeVendorId, safeRfqNumber }, 'Token data');
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
          logger.debug('COMING INSIDE NO CHANGE BLOCK');
          existingProductWithNoChange = false;
        }

        // we process all products with unitprices and having comment

        if (!existingProductWithNoChange) {
          logger.debug('COMING INSIDE CHANGE BLOCK');
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
        logError('Error in updateQuoteItemWithHistory', error);
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
      logError('Get QuoteItem', error);
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
        SELECT
          TRPV.user_id AS user_id,
          TU.name AS user_name,
          COALESCE(TC.company_name, '') AS company_name,
          MIN(TRPV.id) AS rfq_product_vendor_id
        FROM tbl_rfq_product_vendors TRPV
        JOIN tbl_users TU ON TU.id = TRPV.user_id
        LEFT JOIN tbl_company TC ON TC.id = TU.company_id
        WHERE TRPV.rfq_id = $1
        ${searchFilter}
        GROUP BY TRPV.user_id, TU.name, TC.company_name
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
        logger.info(`Preparing to insert ${clauses.length} clauses for tech evaluation ID ${techEvalId}`);

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

        logger.info(`Found ${validClauses.length} valid clauses for insertion`);

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

            logger.info(`Inserted chunk ${i / CHUNK_SIZE + 1} with ${insertedChunk.length} clauses`);
          } catch (chunkError) {
            logError(`Error inserting clause chunk ${i / CHUNK_SIZE + 1}`, chunkError);
            // Continue with next chunk instead of failing completely
          }
        }

        // Successfully inserted clauses
        logger.info(`Successfully inserted ${insertedCount} of ${validClauses.length} clauses`);

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
        logError('Error in addManyClauses', error);
        resolve({
          status: 0,
          message: 'Error adding clauses',
          error: error.message
        });
      }
    });
  },

  addClause: async (rfq_id, rfq_product_id, clause_text, file_url, clause_type = 'clause', weightage = null) => {
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
      (tbl_rfq_product_tech_evaluation_id, clause_text, clause_type, weightage, timestamp)
      VALUES ($1, $2, $3, $4, NOW())
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
          return db.query(insertClauseQuery, [evaluationId, clause_text, clause_type, weightage]);
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
          logError('Error adding clause', error);
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
    file_url,
    clause_type = null,
    weightage = null
  ) => {
    // console.log("entered update clause = ", tbl_rfq_product_tech_evaluation_clauses_id, clause_text,file_url);
    const queryCheckClauseId = `
    SELECT id
      FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE id = $1;
    `;
    let queryUpdateClause = `
      UPDATE tbl_rfq_product_tech_evaluation_clauses
      SET clause_text = $1, timestamp = NOW()`;
    const params = [clause_text];
    let paramIndex = 2;
    
    if (clause_type) {
      queryUpdateClause += `, clause_type = $${paramIndex}`;
      params.push(clause_type);
      paramIndex++;
    }
    
    if (weightage !== null) {
      queryUpdateClause += `, weightage = $${paramIndex}`;
      params.push(weightage);
      paramIndex++;
    }
    
    queryUpdateClause += ` WHERE id = $${paramIndex} RETURNING id;`;
    params.push(tbl_rfq_product_tech_evaluation_clauses_id);

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

    // Cleanup queries to void evaluation data on clause update
    const deleteVendorResponsesQuery = `
      DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1;
    `;

    const deleteCommentsQuery = `
      DELETE FROM tbl_rfq_product_tech_evaluation_comments
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1;
    `;

    const deleteClearedVendorsQuery = `
      DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors
      WHERE tbl_rfq_product_tech_evaluation_id = (
        SELECT tbl_rfq_product_tech_evaluation_id
        FROM tbl_rfq_product_tech_evaluation_clauses
        WHERE id = $1
      );
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
          return; // Prevent further execution
        }

        // Updating the clause text
        return db.query(queryUpdateClause, params);
      }).then(async (updateResult) => {
        if (!updateResult) return; // Skip if validation failed
        if (updateResult.length === 0) {
          reject({
            success: false,
            message: `Clause ID ${tbl_rfq_product_tech_evaluation_clauses_id} not found.`
          });
          return;
        }

        // console.log(`Clause updated: ${tbl_rfq_product_tech_evaluation_clauses_id}`);

        // Void all related evaluation data on clause update
        await db.query(deleteVendorResponsesQuery, [tbl_rfq_product_tech_evaluation_clauses_id]);
        await db.query(deleteCommentsQuery, [tbl_rfq_product_tech_evaluation_clauses_id]);
        await db.query(deleteClearedVendorsQuery, [tbl_rfq_product_tech_evaluation_clauses_id]);

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
                    logger.info(`Deleted files: ${filesToDelete}`);
                  })
                  .catch((error) => {
                    logError('Error deleting files', error);
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
                      logError(`Error inserting file: ${fileUrl}`, error);
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
              logError('Error retrieving existing files', error);
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
                logger.info(`All files deleted for clause ID: ${tbl_rfq_product_tech_evaluation_clauses_id}`);
                resolve({
                  success: true,
                  message: 'Clause updated successfully, and all files deleted.'
                });
              })
              .catch((error) => {
                logError('Error deleting all files', error);
                reject({
                  success: false,
                  message: 'Error deleting all files.',
                  error: error.message
                });
              });
          }
        })
        .catch((error) => {
          logError('Error updating clause', error);
          reject({
            success: false,
            message: 'Error updating clause.',
            error: error.message
          });
        });
    });
  },

  removeClause: async (tbl_rfq_product_tech_evaluation_clauses_id) => {
    return db.tx(async (t) => {
      // 1. Verify the clause exists and capture its parent tech_evaluation row.
      const row = await t.oneOrNone(
        `SELECT tbl_rfq_product_tech_evaluation_id AS parent_id
           FROM tbl_rfq_product_tech_evaluation_clauses
          WHERE id = $1`,
        [tbl_rfq_product_tech_evaluation_clauses_id]
      );
      if (!row) {
        throw new Error('Clause not found.');
      }
      const parentId = row.parent_id;

      // 2. Cascade-clean child data tied to this clause + reset cleared vendors
      //    on the parent (existing behaviour: any clause edit invalidates the
      //    evaluation since scoring needs to be redone).
      await t.none(
        `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response
          WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1`,
        [tbl_rfq_product_tech_evaluation_clauses_id]
      );
      await t.none(
        `DELETE FROM tbl_rfq_product_tech_evaluation_comments
          WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1`,
        [tbl_rfq_product_tech_evaluation_clauses_id]
      );
      await t.none(
        `DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors
          WHERE tbl_rfq_product_tech_evaluation_id = $1`,
        [parentId]
      );

      // 3. Delete the clause itself (clause_files cascade automatically).
      await t.none(
        `DELETE FROM tbl_rfq_product_tech_evaluation_clauses WHERE id = $1`,
        [tbl_rfq_product_tech_evaluation_clauses_id]
      );

      // 4. If this was the LAST clause for the parent, delete the parent row
      //    too. Otherwise the product gets stuck — there's a tech_evaluation
      //    row but no clauses left to score, so the lifecycle treats it as
      //    "tech eval configured" forever and quote-compare hides the vendors.
      const remaining = await t.one(
        `SELECT COUNT(*)::int AS count
           FROM tbl_rfq_product_tech_evaluation_clauses
          WHERE tbl_rfq_product_tech_evaluation_id = $1`,
        [parentId]
      );

      let parentDeleted = false;
      if (remaining.count === 0) {
        await t.none(
          `DELETE FROM tbl_rfq_product_tech_evaluation WHERE id = $1`,
          [parentId]
        );
        parentDeleted = true;
      }

      return {
        success: true,
        parent_deleted: parentDeleted,
        message: parentDeleted
          ? 'Last clause removed; technical evaluation cleared for this product.'
          : 'Clause and all associated data deleted successfully.',
      };
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
                                    TE_C.clause_type,
                                    TE_C.weightage,
                                    TE.rfq_id,
                                    TE.tbl_rfq_product_id AS rfq_product_id,
                                    TE.minimum_passing_score,
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
                              GROUP BY TE.id, TE_C.id, TE_C.clause_text, TE_C.clause_type, TE_C.weightage, TE.rfq_id, TE.tbl_rfq_product_id, TE.minimum_passing_score
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
                                            vr.buyer_id,
                                            scorer.name AS scorer_name,
                                            vr.buyer_marks,
                                            vr.buyer_remark,
                                            vr.timestamp AS response_timestamp,
                                            vr.score_timestamp,
                                            COALESCE(vrf.files, '[]')                     AS vendor_response_files
                                      FROM tbl_rfq_product_tech_evaluation_vendors_response vr
                                              LEFT JOIN vendor_response_files vrf
                                                        ON vr.id = vrf.vendor_response_id
                                              LEFT JOIN tbl_users scorer
                                                        ON scorer.id = vr.buyer_id),

            vendor_responses_aggregated AS (SELECT clause_id,
                                                    JSON_AGG(
                                                            JSON_BUILD_OBJECT(
                                                                    'vendor_id', vendor_id,
                                                                    'vendor_response', vendor_response,
                                                                    'vendor_response_files', vendor_response_files,
                                                                    'buyer_id', buyer_id,
                                                                    'scorer_name', scorer_name,
                                                                    'buyer_marks', buyer_marks,
                                                                    'buyer_remark', buyer_remark,
                                                                    'response_timestamp', response_timestamp,
                                                                    'score_timestamp', score_timestamp
                                                            )
                                                    ) AS vendor_responses
                                            FROM vendor_responses_raw
                                            GROUP BY clause_id),

            vendor_scores AS (
                SELECT
                    te.rfq_id,
                    te.tbl_rfq_product_id AS rfq_product_id,
                    vr.vendor_id,
                    COALESCE(SUM(CASE WHEN vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp THEN vr.buyer_marks ELSE 0 END), 0) AS total_marks,
                    COALESCE(SUM(c.weightage), 0) AS total_weightage,
                    -- has_marks: true if ANY clause has been actually scored (score_timestamp differs from creation timestamp)
                    BOOL_OR(vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp) AS has_marks,
                    CASE
                        WHEN NOT BOOL_OR(vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp) THEN NULL
                        WHEN COALESCE(SUM(c.weightage), 0) > 0
                        THEN ROUND((COALESCE(SUM(CASE WHEN vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp THEN vr.buyer_marks ELSE 0 END), 0)::NUMERIC / COALESCE(SUM(c.weightage), 0)::NUMERIC) * 100, 2)
                        ELSE 0
                    END AS calculated_score,
                    te.minimum_passing_score,
                    -- is_passed: only calculated when ALL clauses are scored
                    CASE
                        WHEN NOT BOOL_AND(vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp) THEN NULL
                        WHEN COALESCE(SUM(c.weightage), 0) > 0
                        THEN CASE
                            WHEN ROUND((COALESCE(SUM(CASE WHEN vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp THEN vr.buyer_marks ELSE 0 END), 0)::NUMERIC / COALESCE(SUM(c.weightage), 0)::NUMERIC) * 100, 2) >= COALESCE(te.minimum_passing_score, 0)
                            THEN true
                            ELSE false
                        END
                        ELSE NULL
                    END AS is_passed
                FROM tbl_rfq_product_tech_evaluation te
                JOIN tbl_rfq_product_tech_evaluation_clauses c ON te.id = c.tbl_rfq_product_tech_evaluation_id
                LEFT JOIN tbl_rfq_product_tech_evaluation_vendors_response vr ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
                WHERE te.rfq_id = $1
                GROUP BY te.rfq_id, te.tbl_rfq_product_id, vr.vendor_id, te.minimum_passing_score
            ),

            clauses_data AS (
                SELECT
                    ordered_clauses.rfq_id,
                    ordered_clauses.rfq_product_id,
                    ordered_clauses.evaluation_id,
                    ordered_clauses.minimum_passing_score,
                    JSON_AGG(clause_entry ORDER BY clause_entry->>'clause_id') AS clauses
                FROM (
                          SELECT
                              cf.rfq_id,
                              cf.rfq_product_id,
                              cf.evaluation_id,
                              cf.minimum_passing_score,
                              JSON_BUILD_OBJECT(
                                      'clause_id', cf.clause_id,
                                      'clause_text', cf.clause_text,
                                      'clause_type', cf.clause_type,
                                      'weightage', cf.weightage,
                                      'files', cf.files,
                                      'vendor_responses', COALESCE(vra.vendor_responses, '[]')
                              ) AS clause_entry
                          FROM clause_files cf
                                  LEFT JOIN vendor_responses_aggregated vra
                                            ON cf.clause_id = vra.clause_id
                      ) AS ordered_clauses
                GROUP BY rfq_id, rfq_product_id, evaluation_id, minimum_passing_score
            ),

            vendor_replacements AS (
                SELECT rfq_id, rfq_product_id, old_vendor_id, new_vendor_id, created_at AS replaced_at
                FROM tbl_rfq_product_tech_eval_vendor_replacements
                WHERE rfq_id = $1
            ),
            vendors_list AS (
                SELECT
                    deduped.rfq_id,
                    deduped.rfq_product_id,
                    JSON_AGG(
                            JSON_BUILD_OBJECT(
                                    'vendor_id', deduped.vendor_id,
                                    'vendor_name', deduped.vendor_name,
                                    'vendor_email', deduped.vendor_email,
                                    'is_cleared', deduped.is_cleared,
                                    'is_verified', deduped.is_verified,
                                    'evaluated_by', deduped.evaluated_by,
                                    'approved_by', deduped.approved_by,
                                    'rfq_product_vendor_id', deduped.rfq_product_vendor_id,
                                    'calculated_score', deduped.calculated_score,
                                    'is_passed', deduped.is_passed,
                                    'has_marks', deduped.has_marks,
                                    'quote_price', deduped.quote_price,
                                    'has_quoted', deduped.has_quoted,
                                    'rank', deduped.rank,
                                    'evaluation_round', deduped.evaluation_round,
                                    'reject_message', deduped.reject_message,
                                    'is_replaced', EXISTS (
                                        SELECT 1 FROM vendor_replacements vrx
                                        WHERE vrx.rfq_id = deduped.rfq_id
                                          AND vrx.rfq_product_id = deduped.rfq_product_id
                                          AND vrx.new_vendor_id = deduped.vendor_id
                                    ),
                                    'is_replaced_out', EXISTS (
                                        SELECT 1 FROM vendor_replacements vrx
                                        WHERE vrx.rfq_id = deduped.rfq_id
                                          AND vrx.rfq_product_id = deduped.rfq_product_id
                                          AND vrx.old_vendor_id = deduped.vendor_id
                                    )
                            )
                            ORDER BY deduped.rank
                    ) AS vendors
                          FROM (
                                  SELECT
                                      te.rfq_id,
                                      te.tbl_rfq_product_id AS rfq_product_id,
                                      tu.id AS vendor_id,
                                      COALESCE(tc.company_name, tu.organization_name, tu.name) AS vendor_name,
                                      tu.email AS vendor_email,
                                      rc.status AS is_cleared,
                                      rc.is_verified AS is_verified,
                                      rc.evaluation_round AS evaluation_round,
                                      rc.reject_message AS reject_message,
                                      _TU.name AS evaluated_by,
                                      _APPROVER.name AS approved_by,
                                      rpv.id AS rfq_product_vendor_id,
                                      COALESCE(vs.calculated_score::NUMERIC, 0) AS calculated_score,
                                      vs.is_passed AS is_passed,
                                      COALESCE(vs.has_marks, false) AS has_marks,
                              COALESCE(tqi.total_price, 999999999) AS quote_price,
                              (tq.id IS NOT NULL) AS has_quoted,
                                      ROW_NUMBER() OVER (
                                          PARTITION BY te.rfq_id, te.tbl_rfq_product_id, tu.id
                                          ORDER BY te.id
                                  ) AS row_num,
                              DENSE_RANK() OVER (
                                  PARTITION BY te.rfq_id, te.tbl_rfq_product_id
                                  ORDER BY COALESCE(tqi.total_price, 999999999) ASC
                              ) AS rank
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
                                            LEFT JOIN tbl_tech_evaluation_rounds _TER
                                                      ON _TER.tbl_rfq_product_tech_evaluation_id = te.id
                                                      AND _TER.round_number = COALESCE(rc.evaluation_round, 1)
                                            LEFT JOIN tbl_approval_instances _AI ON _AI.id = _TER.approval_instance_id
                                            LEFT JOIN tbl_users _TU ON _TU.id = _AI.initiated_by
                                            LEFT JOIN LATERAL (
                                                SELECT approver_user_id FROM tbl_approval_actions
                                                WHERE approval_instance_id = _AI.id AND action = 'APPROVE'
                                                ORDER BY created_at DESC LIMIT 1
                                            ) _LAST_ACTION ON true
                                            LEFT JOIN tbl_users _APPROVER ON _APPROVER.id = _LAST_ACTION.approver_user_id
                                            LEFT JOIN vendor_scores vs
                                                      ON vs.rfq_id = te.rfq_id
                                                          AND vs.rfq_product_id = te.tbl_rfq_product_id
                                                          AND vs.vendor_id = tu.id
                                    LEFT JOIN tbl_quotes tq
                                              ON tq.rfq_id = te.rfq_id
                                                  AND tq.created_by = tu.id
                                                  AND tq.is_regret != 1
                                    LEFT JOIN tbl_quote_items tqi
                                              ON tqi.quote_id = tq.id
                                                  AND tqi.product_variant_id = trp.product_variant_id
                                                  AND tqi.variant = trp.variant
                      ) deduped
                      WHERE deduped.row_num = 1
                          AND (
                              -- Top ranked vendors
                              deduped.rank <= 5
                              OR
                              -- Replacement vendors (included regardless of rank)
                              EXISTS (
                                  SELECT 1 FROM vendor_replacements vrx
                                  WHERE vrx.rfq_id = deduped.rfq_id
                                    AND vrx.rfq_product_id = deduped.rfq_product_id
                                    AND vrx.new_vendor_id = deduped.vendor_id
                              )
                              OR
                              -- Replaced (failed) vendors — keep visible for audit
                              EXISTS (
                                  SELECT 1 FROM vendor_replacements vrx
                                  WHERE vrx.rfq_id = deduped.rfq_id
                                    AND vrx.rfq_product_id = deduped.rfq_product_id
                                    AND vrx.old_vendor_id = deduped.vendor_id
                              )
                          )
                GROUP BY deduped.rfq_id, deduped.rfq_product_id
            )

        SELECT cd.rfq_id,
              cd.rfq_product_id,
              cd.evaluation_id,
              cd.clauses,
              vl.vendors,
              cd.minimum_passing_score
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
          logError('Error fetching clauses and files', error);
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
            logError(`Error adding file: ${file_url}`, fileError);
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
      logError('addTechComment error', error);
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
    try {
      // Determine the vendor user id for filtering
      const vendorUserId = user_type != '3' ? receiver_id : sender_id;

      // Single query: validate clause, fetch comments with sender info and aggregated files
      const data = await db.any(`
        SELECT
          c.id AS comment_id,
          c.text AS comment_text,
          c.sender_id AS created_by,
          c.timestamp AS created_at,
          u.name AS sender_name,
          u.user_type AS sender_user_type,
          COALESCE(
            (SELECT json_agg(cf.file_url)
             FROM tbl_rfq_product_tech_evaluation_comments_files cf
             WHERE cf.tbl_rfq_product_tech_evaluation_comments_id = c.id),
            '[]'::json
          ) AS comment_files
        FROM tbl_rfq_product_tech_evaluation_comments c
        LEFT JOIN tbl_users u ON u.id = c.sender_id
        WHERE c.tbl_rfq_product_tech_evaluation_clauses_id = $1
          AND (c.sender_id = $2 OR c.receiver_id = $2)
        ORDER BY c.timestamp ASC
      `, [clause_id, vendorUserId]);

      return {
        status: 1,
        message: 'Comments fetched successfully.',
        data
      };
    } catch (error) {
      logError('getTechComments error', error);
      throw error;
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

  getDeviationPreviews: async (rfq_product_id, user_id) => {
    const query = `
      WITH ranked_comments AS (
        SELECT
          c.tbl_rfq_product_tech_evaluation_clauses_id AS clause_id,
          c.sender_id,
          c.receiver_id,
          c.text,
          c.timestamp,
          ROW_NUMBER() OVER (
            PARTITION BY c.tbl_rfq_product_tech_evaluation_clauses_id,
              LEAST(c.sender_id, c.receiver_id),
              GREATEST(c.sender_id, c.receiver_id)
            ORDER BY c.timestamp DESC
          ) AS rn
        FROM tbl_rfq_product_tech_evaluation_comments c
        JOIN tbl_rfq_product_tech_evaluation_clauses cl
          ON c.tbl_rfq_product_tech_evaluation_clauses_id = cl.id
        JOIN tbl_rfq_product_tech_evaluation te
          ON cl.tbl_rfq_product_tech_evaluation_id = te.id
        WHERE te.tbl_rfq_product_id = $1
        ${user_id ? 'AND (c.sender_id = $2 OR c.receiver_id = $2)' : ''}
      )
      SELECT clause_id, sender_id, receiver_id, text, timestamp
      FROM ranked_comments
      WHERE rn <= 4
      ORDER BY clause_id, timestamp ASC
    `;
    const params = user_id ? [rfq_product_id, user_id] : [rfq_product_id];
    return await db.any(query, params);
  },

  addVendorResponse: async (responses) => {
    const validateClauseQuery = `
      SELECT EXISTS (SELECT 1 FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE id = $1) AS clause_exists;
    `;

    const validateVendorQuery = `
      SELECT EXISTS (SELECT 1 FROM tbl_users WHERE id = $1) AS vendor_exists;
    `;

    const getExistingResponseQuery = `
      SELECT id FROM tbl_rfq_product_tech_evaluation_vendors_response
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1 AND vendor_id = $2;
    `;

    const updateVendorResponseQuery = `
      UPDATE tbl_rfq_product_tech_evaluation_vendors_response
      SET vendor_response = $1, timestamp = NOW()
      WHERE id = $2
      RETURNING id;
    `;

    const deleteExistingFilesQuery = `
      DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response_files
      WHERE tbl_rfq_product_tech_evaluation_vendors_response_id = $1;
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
        const existingResponse = await db.query(getExistingResponseQuery, [
          clause_id,
          vendor_id
        ]);

        let responseId;

        if (existingResponse.length > 0 && existingResponse[0].id) {
          // UPDATE existing response
          const existingId = existingResponse[0].id;

          // Update the response text
          await db.query(updateVendorResponseQuery, [vendor_response, existingId]);
          responseId = existingId;

          // Only delete existing files if new files are provided
          // If file_url is empty/null, keep existing files unchanged
          if (file_url && file_url.length > 0) {
            await db.query(deleteExistingFilesQuery, [existingId]);
          }
        } else {
          // INSERT new response
          const insertResponseResult = await db.query(insertVendorResponseQuery, [
            vendor_id,
            clause_id,
            vendor_response
          ]);
          responseId = insertResponseResult[0].id;
        }

        // Insert associated files if provided
        if (file_url && file_url.length > 0) {
          for (const url of file_url) {
            await db
              .query(insertFileQuery, [responseId, url])
              .catch((fileError) => {
                logError(`Error adding file: ${url}`, fileError);
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
          logError('Error in addVendorResponses', error);
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
      SELECT id, COALESCE(current_round, 1) AS current_round
      FROM tbl_rfq_product_tech_evaluation
      WHERE id = $1;
    `;

    // When status=1 (accepted), set is_verified=true so progress bar counts this vendor immediately
    const insertClearedVendorQuery = `
      INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
      (tbl_rfq_product_tech_evaluation_id, vendor_id, status, reject_message, is_verified, evaluation_round, timestamp, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7);
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

          // Validate RFQ Product Technical Evaluation ID and get current_round
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

          const currentRound = evaluationResult[0]?.current_round ?? 1;
          // Accepted vendors (status=1) count in progress bar only when is_verified=true
          const isVerified = status === 1;

          // Insert Cleared Vendor
          return db.query(insertClearedVendorQuery, [
            tbl_rfq_product_tech_evaluation_id,
            vendor_id,
            status,
            reject_message,
            isVerified,
            currentRound,
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

    // Fetch vendor_id and rfq_product_vendor_id so the dropdown can show VEN-{id} (same as evaluation card)
    const fetchVendorsQuery = `
      SELECT DISTINCT ON (vr.vendor_id) vr.vendor_id, rpv.id AS rfq_product_vendor_id
      FROM tbl_rfq_product_tech_evaluation te
      JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id AND rp.rfq_id = te.rfq_id
      JOIN tbl_rfq_product_tech_evaluation_clauses c
          ON te.id = c.tbl_rfq_product_tech_evaluation_id
      JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
          ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
      LEFT JOIN tbl_rfq_product_vendors rpv ON rpv.rfq_id = te.rfq_id
        AND rpv.user_id = vr.vendor_id
        AND rpv.product_variant_id = rp.product_variant_id
        AND COALESCE(rpv.variant, 0) = COALESCE(rp.variant, 0)
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

      // Fetch vendor IDs and rfq_product_vendor_id for the given RFQ and product
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
            const rfqProductVendorId = vendor.rfq_product_vendor_id || null;

            // Fetch vendor details (vendor_name, company_name, organization_name)
            const vendorDetailsResult = await db.query(
              fetchVendorDetailsQuery,
              [vendorId]
            );

            if (vendorDetailsResult.length > 0) {
              const vendorData = vendorDetailsResult[0];
              vendorDetails.push({
                vendor_id: vendorData.vendor_id,
                rfq_product_vendor_id: rfqProductVendorId,
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
          logError('Error fetching vendor details', error);
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
    // Changes by Agnij [Filter sampling clauses for vendors - vendors should not see sampling clauses]
    const getClausesQuery = `
      SELECT id AS clause_id, clause_text
      FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE tbl_rfq_product_tech_evaluation_id = $1
        AND clause_type != 'sampling';
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

            if(!vendorResponse) return null;

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
          }).filter(Boolean);

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
        logError('Error fetching RFQ details', error);
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

        // Step 1.5: Fetch minimum passing score
        const fetchMinimumScoreQuery = `
          SELECT minimum_passing_score
          FROM tbl_rfq_product_tech_evaluation
          WHERE id = $1;
        `;
        const minimumScoreResult = await db.query(fetchMinimumScoreQuery, [
          tbl_rfq_product_tech_evaluation_id
        ]);
        const minimum_passing_score = minimumScoreResult.length > 0 ? minimumScoreResult[0].minimum_passing_score : null;

        // Step 2: Check if at least one vendor response exists
        const vendorResponseQuery = `
      SELECT 1 AS has_response
      FROM tbl_rfq_product_tech_evaluation_clauses AS c
      INNER JOIN tbl_rfq_product_tech_evaluation_vendors_response AS vr
      ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
      WHERE c.clause_type = 'clause'
      AND c.tbl_rfq_product_tech_evaluation_id = $1
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
        // Filter sampling clauses for vendors - vendors should not see sampling clauses
        const fetchClausesQuery = `
        SELECT
          c.id AS clause_id,
          c.clause_text,
          c.clause_type,
          c.weightage,
          f.file_url
        FROM
          tbl_rfq_product_tech_evaluation_clauses AS c
        LEFT JOIN
          tbl_rfq_product_tech_evaluation_clauses_files AS f
        ON
          c.id = f.tbl_rfq_product_tech_evaluation_clauses_id
        WHERE
          c.tbl_rfq_product_tech_evaluation_id = $1
          ${vendor_id ? `AND c.clause_type != 'sampling'` : ''}
        ORDER BY c.id;
      `;
        const clausesResult = await db.query(fetchClausesQuery, [
          tbl_rfq_product_tech_evaluation_id
        ]);

        // Step 4: Group clauses by clause_id
        const groupedClauses = clausesResult.reduce((acc, row) => {
          const { clause_id, clause_text, clause_type, weightage, file_url } = row;
          if (!acc[clause_id]) {
            acc[clause_id] = {
              clause_id,
              clause_text,
              clause_type: clause_type || 'clause',
              weightage: weightage || 0,
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
          clause_type: groupedClauses[key].clause_type,
          weightage: groupedClauses[key].weightage,
          files: groupedClauses[key].files
        }));

        // console.log("Response data =", response);

        // Step 6: Add vendor_response and minimum_passing_score to the final response
        resolve({
          success: true,
          vendor_response: vendorResponse,
          minimum_passing_score: minimum_passing_score,
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
    _INITIATOR.name AS evaluated_by,
    _APPROVER.name AS approved_by
  FROM tbl_rfq_product_tech_evaluation_cleared_vendors RC
  LEFT JOIN tbl_tech_evaluation_rounds _TER
    ON _TER.tbl_rfq_product_tech_evaluation_id = RC.tbl_rfq_product_tech_evaluation_id
  LEFT JOIN tbl_approval_instances _AI ON _AI.id = _TER.approval_instance_id
  LEFT JOIN tbl_users _INITIATOR ON _INITIATOR.id = _AI.initiated_by
  LEFT JOIN LATERAL (
      SELECT approver_user_id FROM tbl_approval_actions
      WHERE approval_instance_id = _AI.id AND action = 'APPROVE'
      ORDER BY created_at DESC LIMIT 1
  ) _LAST_ACTION ON true
  LEFT JOIN tbl_users _APPROVER ON _APPROVER.id = _LAST_ACTION.approver_user_id
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
                        'vendor_mobile', v.mobile
                    )
                )
                FROM tbl_rfq_product_vendors pv
                JOIN tbl_users v ON pv.user_id = v.id
                WHERE pv.product_variant_id = prod.product_variant_id AND pv.rfq_id = r.id
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
      logError('searchProductForCMS error', error);
      // Return empty array instead of throwing error to avoid breaking the API response
      return [];
    }
  },

  // Changes by Agnij May 01, 2025 [Added method to search for variant vendors]
  searchVariantVendors: async (product_id, variant_id) => {
    logger.debug(`[RFQ Model] searchVariantVendors called with product_id: ${product_id}, variant_id: ${variant_id}`);

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
      logger.debug(`[RFQ Model] Executing variant vendors search query for ${variant_id ? 'variant' : 'product'} ID: ${variant_id || product_id}`);
      const { rows } = await db.query(q, [variant_id || product_id]);
      logger.debug(`[RFQ Model] searchVariantVendors found ${rows.length} results`);
      return rows;
    } catch (error) {
      logError('[RFQ Model] Error in searchVariantVendors', error);
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
    rfq_no,
    hotel_ids
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
        OR EXISTS (
          -- Business unit visibility (fallback): users mapped to the draft's scalar hotel_id
          -- (covers older rows where RFQ.hotel_id / hospitality_company_id are populated)
          SELECT 1 FROM tbl_hospitality_user_mappings HUM
          WHERE HUM.user_id = ${user_id}
            AND (
              HUM.hospitality_hotel_id = RFQ.hotel_id
              OR (HUM.mapping_type = 0 AND HUM.hospitality_hotel_id IS NULL
                  AND HUM.hospitality_company_id = RFQ.hospitality_company_id)
            )
        )
        OR EXISTS (
          -- Business unit visibility (primary): users mapped to ANY hotel the draft
          -- is associated with via tbl_rfq_hotel_mappings (the source of truth for saveDraft)
          SELECT 1
          FROM tbl_rfq_hotel_mappings rhm
          JOIN tbl_hospitality_company_hotels hch ON hch.id = rhm.hotel_id
          JOIN tbl_hospitality_user_mappings HUM ON HUM.user_id = ${user_id}
            AND (
              HUM.hospitality_hotel_id = rhm.hotel_id
              OR (HUM.mapping_type = 0 AND HUM.hospitality_hotel_id IS NULL
                  AND HUM.hospitality_company_id = hch.hospitality_company_id)
            )
          WHERE rhm.rfq_id = RFQ.id
        )
      ) AND (RFQ.is_published = 0 AND RFQ.status NOT IN (2, 3, 4))
      -- Permission filter: only drafts the user has read access for.
      -- Passes if the user has rfq/boq read on the draft's scalar company (fallback)
      -- OR on any company derived from tbl_rfq_hotel_mappings (primary).
      AND (
        EXISTS (
          SELECT 1 FROM tbl_user_role_scopes _urs2
          JOIN tbl_role_permissions _rp2 ON _rp2.role_id = _urs2.role_id
          JOIN tbl_permissions _p2 ON _p2.id = _rp2.permission_id
          WHERE _urs2.user_id = ${user_id}
            AND _p2.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
            AND _p2.action = 'read'
            AND _urs2.company_id = RFQ.hospitality_company_id
            AND (_urs2.hotel_id IS NULL OR _urs2.hotel_id = RFQ.hotel_id)
            AND (
              RFQ.department_id IS NULL
              OR _urs2.department_id = RFQ.department_id
              OR _urs2.department_id IS NULL
            )
        )
        OR EXISTS (
          SELECT 1
          FROM tbl_rfq_hotel_mappings rhm
          JOIN tbl_hospitality_company_hotels hch ON hch.id = rhm.hotel_id
          JOIN tbl_user_role_scopes _urs3 ON _urs3.user_id = ${user_id}
            AND _urs3.company_id = hch.hospitality_company_id
            AND (_urs3.hotel_id IS NULL OR _urs3.hotel_id = rhm.hotel_id)
            AND (
              RFQ.department_id IS NULL
              OR _urs3.department_id = RFQ.department_id
              OR _urs3.department_id IS NULL
            )
          JOIN tbl_role_permissions _rp3 ON _rp3.role_id = _urs3.role_id
          JOIN tbl_permissions _p3 ON _p3.id = _rp3.permission_id
          WHERE rhm.rfq_id = RFQ.id
            AND _p3.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
            AND _p3.action = 'read'
        )
      )
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
      ${Array.isArray(hotel_ids) && hotel_ids.length > 0 ? `AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = RFQ.id AND rhm.hotel_id IN (${hotel_ids.map(id => parseInt(id)).filter(Number.isFinite).join(',')}))` : ''}
      ORDER BY RFQ.id ${sort ? sort : 'ASC'} LIMIT ${limit} OFFSET ${offset}`;

      const countQuery = `
        SELECT COUNT(*) AS total_count
        FROM tbl_rfq RFQ
        WHERE (
          RFQ.created_by = ${user_id}
          OR RFQ.project_id IN (
            SELECT project_id FROM tbl_project_team WHERE user_id = ${user_id}
          )
          OR EXISTS (
            SELECT 1 FROM tbl_hospitality_user_mappings HUM
            WHERE HUM.user_id = ${user_id}
              AND (
                HUM.hospitality_hotel_id = RFQ.hotel_id
                OR (HUM.mapping_type = 0 AND HUM.hospitality_hotel_id IS NULL
                    AND HUM.hospitality_company_id = RFQ.hospitality_company_id)
              )
          )
          OR EXISTS (
            SELECT 1
            FROM tbl_rfq_hotel_mappings rhm
            JOIN tbl_hospitality_company_hotels hch ON hch.id = rhm.hotel_id
            JOIN tbl_hospitality_user_mappings HUM ON HUM.user_id = ${user_id}
              AND (
                HUM.hospitality_hotel_id = rhm.hotel_id
                OR (HUM.mapping_type = 0 AND HUM.hospitality_hotel_id IS NULL
                    AND HUM.hospitality_company_id = hch.hospitality_company_id)
              )
            WHERE rhm.rfq_id = RFQ.id
          )
        ) AND (RFQ.is_published = 0 AND RFQ.status NOT IN (2, 3, 4))
        AND (
          EXISTS (
            SELECT 1 FROM tbl_user_role_scopes _urs2
            JOIN tbl_role_permissions _rp2 ON _rp2.role_id = _urs2.role_id
            JOIN tbl_permissions _p2 ON _p2.id = _rp2.permission_id
            WHERE _urs2.user_id = ${user_id}
              AND _p2.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
              AND _p2.action = 'read'
              AND _urs2.company_id = RFQ.hospitality_company_id
              AND (_urs2.hotel_id IS NULL OR _urs2.hotel_id = RFQ.hotel_id)
              AND (
                RFQ.department_id IS NULL
                OR _urs2.department_id = RFQ.department_id
                OR _urs2.department_id IS NULL
              )
          )
          OR EXISTS (
            SELECT 1
            FROM tbl_rfq_hotel_mappings rhm
            JOIN tbl_hospitality_company_hotels hch ON hch.id = rhm.hotel_id
            JOIN tbl_user_role_scopes _urs3 ON _urs3.user_id = ${user_id}
              AND _urs3.company_id = hch.hospitality_company_id
              AND (_urs3.hotel_id IS NULL OR _urs3.hotel_id = rhm.hotel_id)
              AND (
                RFQ.department_id IS NULL
                OR _urs3.department_id = RFQ.department_id
                OR _urs3.department_id IS NULL
              )
            JOIN tbl_role_permissions _rp3 ON _rp3.role_id = _urs3.role_id
            JOIN tbl_permissions _p3 ON _p3.id = _rp3.permission_id
            WHERE rhm.rfq_id = RFQ.id
              AND _p3.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
              AND _p3.action = 'read'
          )
        )
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
        ${Array.isArray(hotel_ids) && hotel_ids.length > 0 ? `AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = RFQ.id AND rhm.hotel_id IN (${hotel_ids.map(id => parseInt(id)).filter(Number.isFinite).join(',')}))` : ''}
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
                  RFQ.is_tender,
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
                RFQ.is_tender,
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
      logError(`[MODEL ERROR] Failed to execute ${type} query`, error);
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
      logError('[MODEL ERROR] Failed to execute quote history query', error);
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

      // Insert only rows that don't already exist (works without unique constraint)
      // rfq_no column is integer in tbl_vendor_rfq_tokens_non_login
      const valuesClause = tokenRecords
        .map(
          (_, i) =>
            `($${i * 3 + 1}::bigint, $${i * 3 + 2}::int, $${i * 3 + 3}::int)`
        )
        .join(', ');
      const params = tokenRecords.flatMap((r) => [
        r.token,
        r.vendor_id,
        Number(r.rfq_no) || parseInt(r.rfq_no, 10)
      ]);
      const insertQuery = `
        INSERT INTO tbl_vendor_rfq_tokens_non_login (token, vendor_id, rfq_no)
        SELECT v.token, v.vendor_id, v.rfq_no
        FROM (VALUES ${valuesClause}) AS v(token, vendor_id, rfq_no)
        WHERE NOT EXISTS (
          SELECT 1 FROM tbl_vendor_rfq_tokens_non_login t
          WHERE t.vendor_id = v.vendor_id AND t.rfq_no = v.rfq_no
        )
        RETURNING vendor_id, token
      `;
      const insertedRows = await db.any(insertQuery, params);
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
    sort,
    is_tender,
    rfq_id,
    hotel_id = null,
    quote_compare = false
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicJoins = '';
      let dynamicConditions = '';
      let dynamicWhereFilters = '';
      let dynamicSelectColumns = '';

      if (tech_eval) {
        dynamicJoins +=
          'JOIN tbl_rfq_product_tech_evaluation RFQ_T_E ON RFQ.id = RFQ_T_E.rfq_id';
        dynamicConditions +=
          'GROUP BY RFQ.id, P.name, H.name, D.title HAVING COUNT(RFQ_T_E.id) > 0';
        // te_completed = true when ALL products have >= 5 cleared vendors
        dynamicSelectColumns += `,
          (
            SELECT BOOL_AND(cleared_count >= 5)
            FROM (
              SELECT rpe.tbl_rfq_product_id, COUNT(*) FILTER (WHERE rpe.is_complete) AS cleared_count
              FROM tbl_rfq_product_tech_evaluation rpe
              WHERE rpe.rfq_id = RFQ.id
              GROUP BY rpe.tbl_rfq_product_id
            ) _te_product_counts
          ) AS te_completed,
          -- has_pending_evaluation: vendors submitted quotes but not yet evaluated for a product
          -- Strict: excludes products that have a PENDING TECHNICAL approval (those are the
          -- approver's action, not the evaluator's). Also requires bid end date to have passed.
          -- bid_end_date is stored as text in ISO format (e.g. '2026-03-14T11:00'), so cast it.
          (
            RFQ.bid_end_date IS NOT NULL
            AND RFQ.bid_end_date != ''
            AND RFQ.bid_end_date::timestamp < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
            AND EXISTS (
              SELECT 1 FROM tbl_rfq_product_tech_evaluation rpe
              WHERE rpe.rfq_id = RFQ.id AND NOT rpe.is_complete
                AND NOT EXISTS (
                  -- Exclude products currently waiting on a technical approver
                  SELECT 1 FROM tbl_approval_instances ai_pte
                  WHERE ai_pte.entity_type = 'TECHNICAL'
                    AND ai_pte.status = 'PENDING'
                    AND ai_pte.metadata->>'rfq_product_id' IS NOT NULL
                    AND (ai_pte.metadata->>'rfq_product_id')::INTEGER = rpe.tbl_rfq_product_id
                )
                AND EXISTS (
                  SELECT 1 FROM tbl_quotes _q_te
                  WHERE _q_te.rfq_id = RFQ.id
                    AND (_q_te.is_regret IS NULL OR _q_te.is_regret != 1)
                    AND NOT EXISTS (
                      SELECT 1 FROM tbl_rfq_product_tech_evaluation_cleared_vendors _cv
                      WHERE _cv.tbl_rfq_product_tech_evaluation_id = rpe.id
                        AND _cv.vendor_id = _q_te.created_by
                    )
                )
            )
          ) AS has_pending_evaluation,
          -- te_approval_rejected: latest TECHNICAL approval is REJECTED with no newer PENDING/APPROVED
          EXISTS (
            SELECT 1 FROM tbl_approval_instances ai_rej
            WHERE ai_rej.entity_type = 'TECHNICAL'
              AND (ai_rej.metadata->>'rfq_id')::INTEGER = RFQ.id
              AND ai_rej.status = 'REJECTED'
              AND NOT EXISTS (
                SELECT 1 FROM tbl_approval_instances ai_newer
                WHERE ai_newer.entity_type = 'TECHNICAL'
                  AND (ai_newer.metadata->>'rfq_id')::INTEGER = RFQ.id
                  AND ai_newer.status IN ('PENDING', 'APPROVED')
                  AND ai_newer.created_at > ai_rej.created_at
              )
          ) AS te_approval_rejected,
          -- has_pending_te_approval: any PENDING TECHNICAL approval exists for this RFQ
          EXISTS (
            SELECT 1 FROM tbl_approval_instances ai_te
            WHERE ai_te.entity_type = 'TECHNICAL'
              AND (ai_te.metadata->>'rfq_id')::INTEGER = RFQ.id
              AND ai_te.status = 'PENDING'
          ) AS has_pending_te_approval`;
        // Filter out RFQs where user lacks te.read permission for the RFQ's hotel + department
        // When role scope has hotel_id/department_id NULL (company-wide), verify user is
        // explicitly mapped to the RFQ's hotel and department
        dynamicWhereFilters += `
          AND EXISTS (
            SELECT 1
            FROM tbl_user_role_scopes urs
            JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
            JOIN tbl_permissions p ON p.id = rp.permission_id
            JOIN tbl_hospitality_company_hotels hch ON hch.id = RFQ.hotel_id AND hch.is_deleted = 0
            WHERE urs.user_id = ${user_id}
              AND urs.company_id = hch.hospitality_company_id
              AND p.resource = 'te'
              AND p.action = 'read'
              AND (
                urs.hotel_id = RFQ.hotel_id
                OR (
                  urs.hotel_id IS NULL
                  AND EXISTS (
                    SELECT 1 FROM tbl_hospitality_user_mappings hum
                    WHERE hum.user_id = ${user_id}
                      AND (
                        hum.hospitality_hotel_id = RFQ.hotel_id
                        OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL
                            AND hum.hospitality_company_id = hch.hospitality_company_id)
                      )
                  )
                )
              )
              AND (
                RFQ.department_id IS NULL
                OR urs.department_id = RFQ.department_id
                OR urs.department_id IS NULL
              )
          )`;
      }

      if (po) {
        if(user_type == 3) {
          dynamicJoins +=
           `JOIN tbl_rfq_purchase_order TRPO ON RFQ.id = TRPO.rfq_id AND TRPO.finalized_vendor_id = ${user_id}`
        } else {
          dynamicJoins +=
            'JOIN tbl_rfq_purchase_order TRPO ON RFQ.id = TRPO.rfq_id';
        }
        // po_completed is now always included in the main SELECT
        dynamicSelectColumns += `,
          -- has_draft_po: any PO in draft status
          EXISTS (
            SELECT 1 FROM tbl_rfq_purchase_order po_draft
            WHERE po_draft.rfq_id = RFQ.id AND po_draft.status = 'draft'
          ) AS has_draft_po,
          -- has_pending_po_approval: any PO approval is PENDING
          EXISTS (
            SELECT 1 FROM tbl_approval_instances ai_po
            WHERE ai_po.entity_type = 'PO'
              AND (ai_po.metadata->>'rfq_id')::INTEGER = RFQ.id
              AND ai_po.status = 'PENDING'
          ) AS has_pending_po_approval`;

        // Only show RFQs where user has awarding.read permission for the RFQ's business unit
        if (user_type != 3) {
          dynamicWhereFilters += `
            AND EXISTS (
              SELECT 1
              FROM tbl_user_role_scopes urs
              JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
              JOIN tbl_permissions p ON p.id = rp.permission_id
              JOIN tbl_hospitality_company_hotels hch ON hch.id = RFQ.hotel_id AND hch.is_deleted = 0
              WHERE urs.user_id = ${user_id}
                AND urs.company_id = hch.hospitality_company_id
                AND p.resource = 'awarding'
                AND p.action = 'read'
                AND (
                  urs.hotel_id = RFQ.hotel_id
                  OR (
                    urs.hotel_id IS NULL
                    AND EXISTS (
                      SELECT 1 FROM tbl_hospitality_user_mappings hum
                      WHERE hum.user_id = ${user_id}
                        AND (
                          hum.hospitality_hotel_id = RFQ.hotel_id
                          OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL
                              AND hum.hospitality_company_id = hch.hospitality_company_id)
                        )
                    )
                  )
                )
                AND (
                  RFQ.department_id IS NULL
                  OR urs.department_id = RFQ.department_id
                  OR urs.department_id IS NULL
                )
            )`;
        }
      }

      // Filter out RFQs where user lacks negotiation.read or quote-compare.read for the quote-compare sidebar
      if (quote_compare && !tech_eval && !po) {
        dynamicWhereFilters += `
          AND EXISTS (
            SELECT 1
            FROM tbl_user_role_scopes urs
            JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
            JOIN tbl_permissions p ON p.id = rp.permission_id
            JOIN tbl_hospitality_company_hotels hch ON hch.id = RFQ.hotel_id AND hch.is_deleted = 0
            WHERE urs.user_id = ${user_id}
              AND urs.company_id = hch.hospitality_company_id
              AND (p.resource = 'negotiation' OR p.resource = 'quote-compare')
              AND p.action = 'read'
              AND (
                urs.hotel_id = RFQ.hotel_id
                OR (
                  urs.hotel_id IS NULL
                  AND EXISTS (
                    SELECT 1 FROM tbl_hospitality_user_mappings hum
                    WHERE hum.user_id = ${user_id}
                      AND (
                        hum.hospitality_hotel_id = RFQ.hotel_id
                        OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL
                            AND hum.hospitality_company_id = hch.hospitality_company_id)
                      )
                  )
                )
              )
              AND (
                RFQ.department_id IS NULL
                OR urs.department_id = RFQ.department_id
                OR urs.department_id IS NULL
              )
          )`;
      }

      let q = `
      SELECT
        DISTINCT
        RFQ.id,
        RFQ.rfq_no,
        RFQ.status,
        RFQ.timestamp,
        RFQ.hospitality_company_id,
        RFQ.hotel_id,
        RFQ.is_published,
        RFQ.created_by,
        RFQ.tender_publish_date,
        RFQ.vendor_clarification_date,
        (
          SELECT EXISTS (
            SELECT 1 FROM tbl_quotes _tq_exists
            WHERE _tq_exists.rfq_id = RFQ.id
            LIMIT 1
          )
        ) AS is_quotes_present,
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
        (
          SELECT COUNT(*) > 0
          FROM tbl_quote_finalization _tqf_any
          WHERE _tqf_any.rfq_id = RFQ.id
        ) AS has_finalization,
        P.name AS project_name,
        RFQ.company_name,
        RFQ.contact_name,
        RFQ.response_email,
        RFQ.contact_number,
        RFQ.bid_end_date,
        RFQ.reverse_auction,
        RFQ.is_tender,
        RFQ.title,
        H.name AS hotel_name,
        (
          SELECT COUNT(*)
          FROM tbl_quotes _tq_active
          WHERE _tq_active.rfq_id = RFQ.id
            AND (_tq_active.is_regret IS NULL OR _tq_active.is_regret != 1)
        ) AS active_quote_count,
        -- finalization_approval_completed: all finalized products have their approval fully done
        (
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM tbl_quote_finalization _f WHERE _f.rfq_id = RFQ.id)
              THEN false
            WHEN RFQ.is_tender = 1 THEN (
              -- Tender: all products finalized AND ARC approval done
              (
                SELECT CASE
                  WHEN COUNT(*) = 0 THEN false
                  ELSE (SELECT COUNT(*) FROM tbl_rfq_products _rpv WHERE _rpv.rfq_id = RFQ.id) = COUNT(*)
                END
                FROM tbl_quote_finalization _tqf_chk WHERE _tqf_chk.rfq_id = RFQ.id
              )
              AND (
                NOT EXISTS (
                  SELECT 1 FROM tbl_approval_instances _ai_arc
                  WHERE _ai_arc.entity_type = 'ARC'
                    AND (_ai_arc.metadata->>'rfq_id')::INTEGER = RFQ.id
                )
                OR EXISTS (
                  SELECT 1 FROM tbl_approval_instances _ai_arc2
                  WHERE _ai_arc2.entity_type = 'ARC'
                    AND (_ai_arc2.metadata->>'rfq_id')::INTEGER = RFQ.id
                    AND _ai_arc2.status = 'APPROVED'
                )
              )
            )
            ELSE (
              -- RFQ: per-product NEGOTIATION_QUOTE approval check
              SELECT BOOL_AND(
                NOT EXISTS (
                  SELECT 1 FROM tbl_approval_instances _ai
                  WHERE _ai.entity_type = 'NEGOTIATION_QUOTE'
                    AND _ai.entity_id = _rp_fin.id
                    AND _ai.status = 'PENDING'
                )
                AND (
                  NOT EXISTS (
                    SELECT 1 FROM tbl_approval_instances _ai2
                    WHERE _ai2.entity_type = 'NEGOTIATION_QUOTE' AND _ai2.entity_id = _rp_fin.id
                  )
                  OR EXISTS (
                    SELECT 1 FROM tbl_approval_instances _ai3
                    WHERE _ai3.entity_type = 'NEGOTIATION_QUOTE'
                      AND _ai3.entity_id = _rp_fin.id AND _ai3.status = 'APPROVED'
                  )
                )
              )
              FROM tbl_rfq_products _rp_fin
              JOIN tbl_quote_finalization _qf_fin ON _qf_fin.rfq_id = RFQ.id
                AND _qf_fin.product_variant_id = _rp_fin.product_variant_id
                AND _qf_fin.variant = _rp_fin.variant
              WHERE _rp_fin.rfq_id = RFQ.id
            )
          END
        ) AS finalization_approval_completed,
        -- finalization_partially_approved: some products approved, some not
        (
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM tbl_quote_finalization _f WHERE _f.rfq_id = RFQ.id) THEN false
            WHEN RFQ.is_tender = 1 THEN (
              -- Tender partial: all products finalized but ARC still PENDING
              (
                SELECT CASE
                  WHEN COUNT(*) = 0 THEN false
                  ELSE (SELECT COUNT(*) FROM tbl_rfq_products _rpv WHERE _rpv.rfq_id = RFQ.id) = COUNT(*)
                END
                FROM tbl_quote_finalization _tqf_chk WHERE _tqf_chk.rfq_id = RFQ.id
              )
              AND EXISTS (
                SELECT 1 FROM tbl_approval_instances _ai_arc_p
                WHERE _ai_arc_p.entity_type = 'ARC'
                  AND (_ai_arc_p.metadata->>'rfq_id')::INTEGER = RFQ.id
                  AND _ai_arc_p.status = 'PENDING'
              )
            )
            ELSE (
              -- RFQ partial: at least one product approved, but not all
              SELECT
                COUNT(*) FILTER (WHERE _is_approved) > 0
                AND (
                  COUNT(*) FILTER (WHERE NOT _is_approved) > 0
                  OR (SELECT COUNT(*) FROM tbl_rfq_products _rp_all WHERE _rp_all.rfq_id = RFQ.id) > COUNT(*)
                )
              FROM (
                SELECT (
                  NOT EXISTS (
                    SELECT 1 FROM tbl_approval_instances _ai
                    WHERE _ai.entity_type = 'NEGOTIATION_QUOTE'
                      AND _ai.entity_id = _rp_fin2.id AND _ai.status = 'PENDING'
                  )
                  AND (
                    NOT EXISTS (
                      SELECT 1 FROM tbl_approval_instances _ai2
                      WHERE _ai2.entity_type = 'NEGOTIATION_QUOTE' AND _ai2.entity_id = _rp_fin2.id
                    )
                    OR EXISTS (
                      SELECT 1 FROM tbl_approval_instances _ai3
                      WHERE _ai3.entity_type = 'NEGOTIATION_QUOTE'
                        AND _ai3.entity_id = _rp_fin2.id AND _ai3.status = 'APPROVED'
                    )
                  )
                ) AS _is_approved
                FROM tbl_rfq_products _rp_fin2
                JOIN tbl_quote_finalization _qf_fin2 ON _qf_fin2.rfq_id = RFQ.id
                  AND _qf_fin2.product_variant_id = _rp_fin2.product_variant_id
                  AND _qf_fin2.variant = _rp_fin2.variant
                WHERE _rp_fin2.rfq_id = RFQ.id
              ) _partial
            )
          END
        ) AS finalization_partially_approved,
        (
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order _po WHERE _po.rfq_id = RFQ.id) THEN false
            ELSE (
              SELECT BOOL_AND(has_approved)
              FROM (
                SELECT EXISTS (
                  SELECT 1 FROM tbl_rfq_purchase_order _po2
                  JOIN tbl_purchase_order_product _pop2 ON _pop2.purchase_order_id = _po2.id
                  WHERE _po2.rfq_id = RFQ.id
                    AND _pop2.rfq_product_id = _rp3.id
                    AND _po2.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
                ) AS has_approved
                FROM tbl_rfq_products _rp3 WHERE _rp3.rfq_id = RFQ.id
              ) _chk
            )
          END
        ) AS po_completed
        , D.title AS department_name
        ${dynamicSelectColumns}
      FROM tbl_rfq RFQ
      LEFT JOIN tbl_projects P ON RFQ.project_id = P.id
      LEFT JOIN tbl_hospitality_company_hotels H
      ON H.id = RFQ.hotel_id
      AND H.is_deleted = 0
      LEFT JOIN tbl_department D ON D.id = RFQ.department_id

      ${dynamicJoins}
      WHERE (${
        user_type == 3
          ? `EXISTS (SELECT 1 FROM tbl_rfq_product_vendors WHERE rfq_id = RFQ.id AND user_id = ${user_id})`
          : `RFQ.created_by = ${user_id}`
      } OR EXISTS (
        ${
          po
            ? `
          SELECT 1 FROM tbl_hospitality_user_mappings HUM
          WHERE HUM.user_id = ${user_id}
            AND (
              HUM.hospitality_hotel_id = RFQ.hotel_id
              OR (HUM.mapping_type = 0 AND HUM.hospitality_hotel_id IS NULL
                  AND HUM.hospitality_company_id = RFQ.hospitality_company_id)
            )
          `
            : `
          SELECT 1 FROM tbl_project_team PT WHERE PT.project_id = RFQ.project_id AND PT.user_id = ${user_id}
          UNION ALL
          SELECT 1 FROM tbl_hospitality_user_mappings HUM
          WHERE HUM.user_id = ${user_id}
            AND (
              HUM.hospitality_hotel_id = RFQ.hotel_id
              OR (HUM.mapping_type = 0 AND HUM.hospitality_hotel_id IS NULL
                  AND HUM.hospitality_company_id = RFQ.hospitality_company_id)
            )
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
      ${dynamicWhereFilters}
      AND (RFQ.project_id = $1 OR $1 IS NULL)
      AND (RFQ.rfq_no::text LIKE '%$4%' OR $4 IS NULL)
      AND (RFQ.id = $5 OR $5 IS NULL)
      AND (RFQ.hotel_id = $6 OR $6 IS NULL)
      ${is_tender !== null && is_tender !== undefined ? `AND RFQ.is_tender = ${is_tender ? 1 : 0}` : ''}
      ${dynamicConditions}
      ORDER BY RFQ.timestamp ${sort || 'DESC'}
      LIMIT $3 OFFSET $2;`;

      db.any(q, [project_id, offset, limit, rfq_no, rfq_id, hotel_id])
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
   * Get users eligible for technical evaluation assignment
   * Returns users from the project team who have role assignments in the hospitality context.
   * Falls back to all project team members if no users found with matching role scopes.
   */
  getTechEvalUsers: async (project_id, companyId = null, hotelId = null) => {
    // If hospitality context is provided, try to filter by role scopes
    if (companyId) {
      const params = [project_id, companyId];
      let hotelCondition = '';

      if (hotelId) {
        hotelCondition = `AND (urs.hotel_id IS NULL OR urs.hotel_id = $3)`;
        params.push(hotelId);
      }

      // Get users who have role assignments in the hospitality context
      const usersWithRoles = await db.any(`
        SELECT DISTINCT u.id, u.name, u.email
        FROM tbl_project_team pt
        JOIN tbl_users u ON u.id = pt.user_id AND u.status = 1
        JOIN tbl_user_role_scopes urs ON urs.user_id = u.id
        WHERE pt.project_id = $1
          AND urs.company_id = $2
          ${hotelCondition}
        ORDER BY u.name
      `, params);

      // If users with roles found, return them
      if (usersWithRoles.length > 0) {
        return usersWithRoles;
      }
    }
    return db.any(`
      SELECT DISTINCT u.id, u.name, u.email
      FROM tbl_project_team pt
      JOIN tbl_users u ON u.id = pt.user_id AND u.status = 1
      WHERE pt.project_id = $1
      ORDER BY u.name
    `, [project_id]);
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
  },

  updateMinimumPassingScore: async (rfq_id, rfq_product_id, minimum_passing_score) => {
    return new Promise(async (resolve, reject) => {
      try {
        // Require at least one clause to exist before allowing a minimum passing
        // score to be set. This prevents the orphan-row stuck-product bug:
        // setting a score used to INSERT an empty parent row, leaving the product
        // with a tech_evaluation row but no clauses to score — the lifecycle
        // treated it as "tech eval configured" forever and quote-compare hid the
        // vendors. The companion guarantee (removeClause deletes the parent row
        // when the last clause is removed) is enforced in removeClause.
        const clauseCheckQuery = `
          SELECT te.id
            FROM tbl_rfq_product_tech_evaluation te
            JOIN tbl_rfq_product_tech_evaluation_clauses c
              ON c.tbl_rfq_product_tech_evaluation_id = te.id
           WHERE te.rfq_id = $1 AND te.tbl_rfq_product_id = $2
           LIMIT 1;
        `;
        const clauseCheck = await db.query(clauseCheckQuery, [rfq_id, rfq_product_id]);

        if (clauseCheck.length === 0) {
          resolve({
            status: 0,
            message: 'Add at least one clause before setting a minimum passing score.'
          });
          return;
        }

        // Update the existing parent row.
        const updateQuery = `
          UPDATE tbl_rfq_product_tech_evaluation
             SET minimum_passing_score = $1
           WHERE rfq_id = $2 AND tbl_rfq_product_id = $3
           RETURNING id;
        `;
        const result = await db.query(updateQuery, [minimum_passing_score, rfq_id, rfq_product_id]);

        if (result.length > 0) {
          resolve({
            status: 1,
            message: 'Minimum passing score updated successfully.'
          });
          return;
        }

        resolve({
          status: 0,
          message: 'Failed to save minimum passing score.'
        });
      } catch (error) {
        logError('Error updating minimum passing score', error);
        reject({
          status: 0,
          message: 'Error updating minimum passing score.',
          error: error.message
        });
      }
    });
  },

  getClauseType: async (clause_id) => {
    return new Promise(async (resolve, reject) => {
      try {
        const query = `
          SELECT clause_type
          FROM tbl_rfq_product_tech_evaluation_clauses
          WHERE id = $1;
        `;
        const result = await db.query(query, [clause_id]);
        if (result.length > 0) {
          resolve(result[0]);
        } else {
          resolve(null);
        }
      } catch (error) {
        logError('Error fetching clause type', error);
        reject(error);
      }
    });
  },

  updateBuyerMarks: async (clause_id, vendor_id, buyer_id, buyer_marks, buyer_remark) => {
    return new Promise(async (resolve, reject) => {
      try {
        // First check if vendor response exists
        const checkQuery = `
          SELECT id FROM tbl_rfq_product_tech_evaluation_vendors_response
          WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1 AND vendor_id = $2;
        `;

        const existing = await db.query(checkQuery, [clause_id, vendor_id]);

        // Check if this is a sampling clause - if so, create response if it doesn't exist
        if (existing.length === 0) {
          const clauseTypeQuery = `
            SELECT clause_type 
            FROM tbl_rfq_product_tech_evaluation_clauses 
            WHERE id = $1;
          `;
          const clauseTypeResult = await db.query(clauseTypeQuery, [clause_id]);
          
          // For sampling clauses, create a vendor response record if it doesn't exist
          if (clauseTypeResult.length > 0 && clauseTypeResult[0].clause_type === 'sampling') {
            // For sampling clauses, vendor_response is not applicable, so use a placeholder value
            const insertQuery = `
              INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
              (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, buyer_id, buyer_marks, buyer_remark, score_timestamp)
              VALUES ($1, $2, 'N/A', $3, $4, $5, NOW())
              RETURNING id;
            `;
            const insertResult = await db.query(insertQuery, [
              clause_id,
              vendor_id,
              buyer_id,
              buyer_marks,
              buyer_remark
            ]);
            
            resolve({
              status: 1,
              message: 'Buyer marks and remark saved successfully.'
            });
            return;
          } else {
          resolve({
            status: 0,
            message: 'Vendor response not found for this clause.'
          });
          return;
          }
        }

        const updateQuery = `
          UPDATE tbl_rfq_product_tech_evaluation_vendors_response
          SET buyer_id = $1, buyer_marks = $2, buyer_remark = $3, score_timestamp = NOW()
          WHERE tbl_rfq_product_tech_evaluation_clauses_id = $4 AND vendor_id = $5
          RETURNING id;
        `;

        const result = await db.query(updateQuery, [
          buyer_id,
          buyer_marks,
          buyer_remark,
          clause_id,
          vendor_id
        ]);

        resolve({
          status: 1,
          message: 'Buyer marks and remark updated successfully.'
        });
      } catch (error) {
        logError('Error updating buyer marks', error);
        reject({
          status: 0,
          message: 'Error updating buyer marks.',
          error: error.message
        });
      }
    });
  },

  // ============================================
  // One-at-a-Time Clarification System Functions
  // ============================================

  /**
   * checkActiveClarification
   * Returns active (OPEN) clarification for an RFQ if exists, null otherwise
   * Used to enforce one-at-a-time rule
   */
  checkActiveClarification: async (rfq_id, db_con = db) => {
    try {
      const query = `
        SELECT c.id, c.rfq_id, c.raised_by as raised_by_vendor_id,
          u.name as raised_by_vendor_name,
          c.subject, c.question, c.status, c.created_at
        FROM tbl_rfq_clarifications c
        JOIN tbl_users u ON u.id = c.raised_by
        WHERE c.rfq_id = $1 AND c.status = 'OPEN'
      `;
      return await db_con.oneOrNone(query, [rfq_id]);
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  /**
   * createClarification
   * Creates a new clarification with optional file attachments
   * Will fail if active (OPEN) clarification exists due to unique index
   * Also creates the initial message in the messages table for the chat system
   */
  createClarification: async (
    rfq_id,
    raised_by,
    vendor_company_id,
    subject,
    question,
    files = [],
    db_con = db
  ) => {
    try {
      return await db_con.tx(async (t) => {
        // Insert clarification
        const clarification = await t.one(
          `
          INSERT INTO tbl_rfq_clarifications
          (rfq_id, raised_by, vendor_company_id, subject, question, status, created_at)
          VALUES ($1, $2, $3, $4, $5, 'OPEN', NOW())
          RETURNING *
        `,
          [rfq_id, raised_by, vendor_company_id, subject, question]
        );

        // Insert question files if any (legacy table for backward compatibility)
        let insertedFiles = [];
        if (files && files.length > 0) {
          for (const file of files) {
            const insertedFile = await t.one(
              `
              INSERT INTO tbl_rfq_clarification_files
              (clarification_id, file_name, file_url, file_type, is_response_file)
              VALUES ($1, $2, $3, $4, FALSE)
              RETURNING id, file_name, file_url
            `,
              [
                clarification.id,
                file.originalname,
                file.location,
                file.mimetype
              ]
            );
            insertedFiles.push(insertedFile);
          }
        }

        // Also insert initial message into messages table for chat system
        const initialMessage = await t.one(
          `
          INSERT INTO tbl_rfq_clarification_messages
          (clarification_id, sender_id, sender_type, message, created_at)
          VALUES ($1, $2, 'VENDOR', $3, NOW())
          RETURNING *
        `,
          [clarification.id, raised_by, question]
        );

        // Insert message files if any
        let messageFiles = [];
        if (files && files.length > 0) {
          for (const file of files) {
            const insertedFile = await t.one(
              `
              INSERT INTO tbl_rfq_clarification_message_files
              (message_id, file_name, file_url, file_type, uploaded_at)
              VALUES ($1, $2, $3, $4, NOW())
              RETURNING id, file_name, file_url
            `,
              [
                initialMessage.id,
                file.originalname,
                file.location,
                file.mimetype
              ]
            );
            messageFiles.push(insertedFile);
          }
        }

        return {
          ...clarification,
          question_files: insertedFiles,
          initial_message: { ...initialMessage, files: messageFiles }
        };
      });
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  /**
   * resolveClarification
   * Adds response to clarification and marks as CLOSED
   * Response is now optional - can just close without message
   * If response provided, it's added as a message in the chat system
   */
  resolveClarification: async (
    clarification_id,
    responded_by,
    response,
    response_files = [],
    db_con = db
  ) => {
    try {
      return await db_con.tx(async (t) => {
        // Update clarification with response (response can be null/empty now)
        const resolved = await t.oneOrNone(
          `
          UPDATE tbl_rfq_clarifications
          SET status = 'CLOSED',
              responded_by = $2,
              response = $3,
              responded_at = NOW(),
              closed_at = NOW(),
              closed_by = $2
          WHERE id = $1 AND status = 'OPEN'
          RETURNING *
        `,
          [clarification_id, responded_by, response || null]
        );

        if (!resolved) {
          return null;
        }

        // Insert response files if any (legacy table for backward compatibility)
        let insertedFiles = [];
        if (response_files && response_files.length > 0) {
          for (const file of response_files) {
            const insertedFile = await t.one(
              `
              INSERT INTO tbl_rfq_clarification_files
              (clarification_id, file_name, file_url, file_type, is_response_file)
              VALUES ($1, $2, $3, $4, TRUE)
              RETURNING id, file_name, file_url
            `,
              [
                clarification_id,
                file.originalname,
                file.location,
                file.mimetype
              ]
            );
            insertedFiles.push(insertedFile);
          }
        }

        // If response provided, also add as a message in the chat system
        let responseMessage = null;
        if (response && response.trim()) {
          responseMessage = await t.one(
            `
            INSERT INTO tbl_rfq_clarification_messages
            (clarification_id, sender_id, sender_type, message, created_at)
            VALUES ($1, $2, 'BUYER', $3, NOW())
            RETURNING *
          `,
            [clarification_id, responded_by, response]
          );

          // Insert message files if any
          let messageFiles = [];
          if (response_files && response_files.length > 0) {
            for (const file of response_files) {
              const insertedFile = await t.one(
                `
                INSERT INTO tbl_rfq_clarification_message_files
                (message_id, file_name, file_url, file_type, uploaded_at)
                VALUES ($1, $2, $3, $4, NOW())
                RETURNING id, file_name, file_url
              `,
                [
                  responseMessage.id,
                  file.originalname,
                  file.location,
                  file.mimetype
                ]
              );
              messageFiles.push(insertedFile);
            }
          }
          responseMessage.files = messageFiles;
        }

        return {
          ...resolved,
          response_files: insertedFiles,
          response_message: responseMessage
        };
      });
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  /**
   * getClarifications
   * Gets all clarifications for an RFQ with files, ordered by created_at DESC
   * Public - visible to all vendors for tender transparency
   */
  getClarifications: async (rfq_id, db_con = db) => {
    try {
      const query = `
        SELECT
          c.id,
          c.rfq_id,
          c.raised_by as raised_by_vendor_id,
          u.name as raised_by_vendor_name,
          c.subject,
          c.question,
          c.response,
          c.responded_by,
          c.status,
          c.created_at,
          c.responded_at,
          c.closed_at,
          COALESCE(
            json_agg(
              json_build_object('file_url', f.file_url, 'file_name', f.file_name)
            ) FILTER (WHERE f.id IS NOT NULL AND f.is_response_file = FALSE), '[]'
          ) as question_files,
          COALESCE(
            json_agg(
              json_build_object('file_url', f.file_url, 'file_name', f.file_name)
            ) FILTER (WHERE f.id IS NOT NULL AND f.is_response_file = TRUE), '[]'
          ) as response_files
        FROM tbl_rfq_clarifications c
        JOIN tbl_users u ON u.id = c.raised_by
        LEFT JOIN tbl_rfq_clarification_files f ON f.clarification_id = c.id
        WHERE c.rfq_id = $1
        GROUP BY c.id, u.name
        ORDER BY c.created_at DESC
      `;
      return await db_con.any(query, [rfq_id]);
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  /**
   * getClarificationById
   * Gets a single clarification by ID with RFQ details
   */
  getClarificationById: async (clarification_id, db_con = db) => {
    try {
      const query = `
        SELECT c.*,
          r.created_by as rfq_created_by,
          r.is_tender,
          u.name as raised_by_vendor_name
        FROM tbl_rfq_clarifications c
        JOIN tbl_rfq r ON r.id = c.rfq_id
        JOIN tbl_users u ON u.id = c.raised_by
        WHERE c.id = $1
      `;
      return await db_con.oneOrNone(query, [clarification_id]);
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  // ============================================
  // Chat/Ticket System Functions
  // ============================================

  /**
   * addClarificationMessage
   * Add a message to a clarification thread
   */
  addClarificationMessage: async (
    clarification_id,
    sender_id,
    sender_type,
    message,
    files = [],
    db_con = db
  ) => {
    try {
      return await db_con.tx(async (t) => {
        // Insert message
        const newMessage = await t.one(
          `
          INSERT INTO tbl_rfq_clarification_messages
          (clarification_id, sender_id, sender_type, message, created_at)
          VALUES ($1, $2, $3, $4, NOW())
          RETURNING *
        `,
          [clarification_id, sender_id, sender_type, message]
        );

        // Insert message files if any
        let insertedFiles = [];
        if (files && files.length > 0) {
          for (const file of files) {
            const insertedFile = await t.one(
              `
              INSERT INTO tbl_rfq_clarification_message_files
              (message_id, file_name, file_url, file_type, uploaded_at)
              VALUES ($1, $2, $3, $4, NOW())
              RETURNING id, file_name, file_url
            `,
              [
                newMessage.id,
                file.originalname,
                file.location,
                file.mimetype
              ]
            );
            insertedFiles.push(insertedFile);
          }
        }

        return { ...newMessage, files: insertedFiles };
      });
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  /**
   * getClarificationMessages
   * Get all messages for a clarification with files
   */
  getClarificationMessages: async (clarification_id, db_con = db) => {
    try {
      const query = `
        SELECT
          m.id,
          m.clarification_id,
          m.sender_id,
          m.sender_type,
          u.name as sender_name,
          m.message,
          m.created_at,
          COALESCE(
            json_agg(
              json_build_object('file_url', f.file_url, 'file_name', f.file_name)
            ) FILTER (WHERE f.id IS NOT NULL), '[]'
          ) as files
        FROM tbl_rfq_clarification_messages m
        JOIN tbl_users u ON u.id = m.sender_id
        LEFT JOIN tbl_rfq_clarification_message_files f ON f.message_id = m.id
        WHERE m.clarification_id = $1
        GROUP BY m.id, u.name
        ORDER BY m.created_at ASC
      `;
      return await db_con.any(query, [clarification_id]);
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  /**
   * closeClarification
   * Close a clarification without requiring a response message
   * The buyer can optionally send a final message before closing via addClarificationMessage
   */
  closeClarification: async (clarification_id, closed_by, db_con = db) => {
    try {
      const query = `
        UPDATE tbl_rfq_clarifications
        SET status = 'CLOSED',
            closed_by = $2,
            closed_at = NOW()
        WHERE id = $1 AND status = 'OPEN'
        RETURNING *
      `;
      return await db_con.oneOrNone(query, [clarification_id, closed_by]);
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  /**
   * getClarificationsWithMessages
   * Gets all clarifications for an RFQ with their messages
   */
  getClarificationsWithMessages: async (rfq_id, db_con = db) => {
    try {
      // Get all clarifications
      const clarifications = await db_con.any(
        `
        SELECT
          c.id,
          c.rfq_id,
          c.raised_by as raised_by_vendor_id,
          u.name as raised_by_vendor_name,
          c.subject,
          c.status,
          c.created_at,
          c.closed_at,
          c.closed_by
        FROM tbl_rfq_clarifications c
        JOIN tbl_users u ON u.id = c.raised_by
        WHERE c.rfq_id = $1
        ORDER BY c.created_at DESC
      `,
        [rfq_id]
      );

      // Get messages for each clarification
      for (const clarification of clarifications) {
        clarification.messages = await db_con.any(
          `
          SELECT
            m.id,
            m.sender_id,
            m.sender_type,
            u.name as sender_name,
            m.message,
            m.created_at,
            COALESCE(
              json_agg(
                json_build_object('file_url', f.file_url, 'file_name', f.file_name)
              ) FILTER (WHERE f.id IS NOT NULL), '[]'
            ) as files
          FROM tbl_rfq_clarification_messages m
          JOIN tbl_users u ON u.id = m.sender_id
          LEFT JOIN tbl_rfq_clarification_message_files f ON f.message_id = m.id
          WHERE m.clarification_id = $1
          GROUP BY m.id, u.name
          ORDER BY m.created_at ASC
        `,
          [clarification.id]
        );
      }

      return clarifications;
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  /**
   * getActiveClarificationWithMessages
   * Get active clarification with all its messages
   */
  getActiveClarificationWithMessages: async (rfq_id, db_con = db) => {
    try {
      const clarification = await db_con.oneOrNone(
        `
        SELECT
          c.id,
          c.rfq_id,
          c.raised_by as raised_by_vendor_id,
          u.name as raised_by_vendor_name,
          c.subject,
          c.status,
          c.created_at,
          c.closed_at,
          c.closed_by
        FROM tbl_rfq_clarifications c
        JOIN tbl_users u ON u.id = c.raised_by
        WHERE c.rfq_id = $1 AND c.status = 'OPEN'
      `,
        [rfq_id]
      );

      if (!clarification) {
        return null;
      }

      // Get messages for the clarification
      clarification.messages = await db_con.any(
        `
        SELECT
          m.id,
          m.sender_id,
          m.sender_type,
          u.name as sender_name,
          m.message,
          m.created_at,
          COALESCE(
            json_agg(
              json_build_object('file_url', f.file_url, 'file_name', f.file_name)
            ) FILTER (WHERE f.id IS NOT NULL), '[]'
          ) as files
        FROM tbl_rfq_clarification_messages m
        JOIN tbl_users u ON u.id = m.sender_id
        LEFT JOIN tbl_rfq_clarification_message_files f ON f.message_id = m.id
        WHERE m.clarification_id = $1
        GROUP BY m.id, u.name
        ORDER BY m.created_at ASC
      `,
        [clarification.id]
      );

      return clarification;
    } catch (error) {
      logError(error);
      throw error;
    }
  },

  /**
   * Replace a vendor in technical evaluation with the next vendor in line
   * @param {number} rfq_id - RFQ ID
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {number} old_vendor_id - Vendor ID to replace
   * @param {number} new_vendor_id - New vendor ID (next in line)
   * @param {number} user_id - User performing the replacement
   * @returns {Promise<Object>} - Replacement result
   */
  replaceTechEvalVendor: async (rfq_id, rfq_product_id, old_vendor_id, new_vendor_id, user_id, txContext = null) => {
    const dbContext = txContext || db;
    const insertQuery = `
      INSERT INTO tbl_rfq_product_tech_eval_vendor_replacements
      (rfq_id, rfq_product_id, old_vendor_id, new_vendor_id, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (rfq_id, rfq_product_id, old_vendor_id)
      DO UPDATE SET
        new_vendor_id = $4,
        created_by = $5,
        created_at = NOW()
      RETURNING *;
    `;

    const result = await dbContext.one(insertQuery, [rfq_id, rfq_product_id, old_vendor_id, new_vendor_id, user_id]);
    return {
      status: 1,
      message: 'Vendor replaced successfully',
      data: result
    };
  },

  /**
   * Get vendor replacements for a product
   * @param {number} rfq_id - RFQ ID
   * @param {number} rfq_product_id - RFQ Product ID
   * @returns {Promise<Map>} - Map of old_vendor_id -> new_vendor_id
   */
  getTechEvalVendorReplacements: async (rfq_id, rfq_product_id) => {
    const query = `
      SELECT old_vendor_id, new_vendor_id
      FROM tbl_rfq_product_tech_eval_vendor_replacements
      WHERE rfq_id = $1 AND rfq_product_id = $2;
    `;

    return new Promise((resolve, reject) => {
      db.query(query, [rfq_id, rfq_product_id])
        .then((result) => {
          const replacementMap = new Map();
          result.forEach(row => {
            replacementMap.set(row.old_vendor_id, row.new_vendor_id);
          });
          resolve(replacementMap);
        })
        .catch((error) => {
          // Table might not exist, return empty map
          resolve(new Map());
        });
    });
  },

  /**
   * Get next vendor in line (L6, L7, etc.) for a product, sorted by quote price
   * @param {number} rfq_id - RFQ ID
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {Array<number>} exclude_vendor_ids - Vendor IDs to exclude (already evaluated)
   * @param {number} limit - Number of vendors to return
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array>} - Array of vendors with quotes
   */
  getNextVendorsForProduct: async (rfq_id, rfq_product_id, exclude_vendor_ids = [], limit = 10, txContext = null) => {
    const dbContext = txContext || db;
    let query = `
      SELECT DISTINCT
        tu.id AS vendor_id,
        COALESCE(tc.company_name, tu.organization_name, tu.name) AS vendor_name,
        tu.email AS vendor_email,
        rpv.id AS rfq_product_vendor_id,
        COALESCE(tqi.total_price, 999999999) AS quote_price,
        DENSE_RANK() OVER (ORDER BY COALESCE(tqi.total_price, 999999999) ASC) AS rank
      FROM tbl_rfq_products trp
      JOIN tbl_quotes tq ON tq.rfq_id = trp.rfq_id AND tq.is_regret != 1
      JOIN tbl_users tu ON tu.id = tq.created_by
      LEFT JOIN tbl_company tc ON tc.id = tu.company_id
      LEFT JOIN tbl_rfq_product_vendors rpv ON rpv.rfq_id = trp.rfq_id
        AND rpv.user_id = tu.id
        AND rpv.product_variant_id = trp.product_variant_id
        AND rpv.variant = trp.variant
      LEFT JOIN tbl_quote_items tqi ON tqi.quote_id = tq.id
        AND tqi.product_variant_id = trp.product_variant_id
        AND tqi.variant = trp.variant
      WHERE trp.id = $1
        AND trp.rfq_id = $2
    `;

    const params = [rfq_product_id, rfq_id];

    if (exclude_vendor_ids.length > 0) {
      const placeholders = exclude_vendor_ids.map((_, idx) => `$${params.length + idx + 1}`).join(',');
      query += ` AND tu.id NOT IN (${placeholders})`;
      params.push(...exclude_vendor_ids);
    }

    query += ` ORDER BY quote_price ASC LIMIT $${params.length + 1};`;
    params.push(limit);

    return dbContext.any(query, params);
  },

  /**
   * Get RFQ product by variant
   * @param {number} rfq_id - RFQ ID
   * @param {number} product_variant_id - Product variant ID
   * @param {number} variant - Variant number
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - RFQ product record
   */
  getRfqProductByVariant: async (rfq_id, product_variant_id, variant, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT id FROM tbl_rfq_products 
       WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
      [rfq_id, product_variant_id, variant]
    );
  },

  /**
   * Get RFQ with hospitality details for ARC/approval flows
   * @param {number} rfq_id - RFQ ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - RFQ with hospitality company and hotel details
   */
  getRfqWithHospitalityDetails: async (rfq_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT r.*, hc.name as hospitality_company_name, h.name as hotel_name, d.title as department_name
       FROM tbl_rfq r
       LEFT JOIN tbl_hospitality_companies hc ON hc.id = r.hospitality_company_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
       LEFT JOIN tbl_department d ON d.id = r.department_id
       WHERE r.id = $1`,
      [rfq_id]
    );
  },

  /**
   * Get all product IDs for an RFQ
   * @param {number} rfq_id - RFQ ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array>} - Array of product objects with id
   */
  getRfqProductIds: async (rfq_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.any(
      `SELECT id FROM tbl_rfq_products WHERE rfq_id = $1`,
      [rfq_id]
    );
  },

  /**
   * Get RFQ product details with RFQ and hospitality info for ARC document
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Product with RFQ and hospitality details
   */
  getRfqProductDetailsForArc: async (rfq_product_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT 
        rp.id as rfq_product_id,
        rp.rfq_id,
        rp.product_variant_id,
        rp.variant,
        r.rfq_no,
        r.company_name,
        r.location,
        r.bid_end_date,
        r.is_tender,
        r.hospitality_company_id,
        r.hotel_id,
        hc.name as hospitality_company_name,
        hc.registered_office_address as hospitality_company_address,
        h.name as hotel_name,
        h.full_address as hotel_address,
        pv.name as product_name,
        p.name as product_category_name
      FROM tbl_rfq_products rp
      JOIN tbl_rfq r ON r.id = rp.rfq_id
      LEFT JOIN tbl_hospitality_companies hc ON hc.id = r.hospitality_company_id
      LEFT JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
      JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
      JOIN tbl_product p ON p.id = pv.product_id
      WHERE rp.id = $1`,
      [rfq_product_id]
    );
  },

  /**
   * Get finalized vendor for a product
   * @param {number} rfq_id - RFQ ID
   * @param {number} product_variant_id - Product variant ID
   * @param {number} variant - Variant number
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Finalization record
   */
  getFinalizedVendorForProduct: async (rfq_id, product_variant_id, variant, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT 
        qf.vendor_id,
        qf.quote_id,
        qf.timestamp as finalized_at
      FROM tbl_quote_finalization qf
      WHERE qf.rfq_id = $1
        AND qf.product_variant_id = $2
        AND qf.variant = $3
      ORDER BY qf.timestamp DESC
      LIMIT 1`,
      [rfq_id, product_variant_id, variant]
    );
  },

  /**
   * Get product specs for an RFQ product
   * @param {number} rfq_id - RFQ ID
   * @param {number} product_variant_id - Product variant ID
   * @param {number} variant - Variant number
   * @param {Array} titles - Optional array of spec titles to filter
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array>} - Array of spec records
   */
  getRfqProductSpecs: async (rfq_id, product_variant_id, variant, titles = null, txContext = null) => {
    const dbContext = txContext || db;
    let query = `
      SELECT title, value
      FROM tbl_rfq_products_specs
      WHERE rfq_id = $1
        AND product_variant_id = $2
        AND variant = $3
    `;
    const params = [rfq_id, product_variant_id, variant];
    
    if (titles && titles.length > 0) {
      query += ` AND title = ANY($4)`;
      params.push(titles);
    }
    
    return dbContext.any(query, params);
  },

  /**
   * Get quote item details
   * @param {number} quote_id - Quote item ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Quote item record
   */
  getQuoteItemDetails: async (quote_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT 
        qi.unit_price,
        qi.quantity,
        -- qi.unit,
        qi.total_price
      FROM tbl_quote_items qi
      WHERE qi.id = $1`,
      [quote_id]
    );
  },

  /**
   * Get RFQ product by ID
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {number} rfq_id - RFQ ID (for validation)
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - RFQ product record
   */
  getRfqProductById: async (rfq_product_id, rfq_id = null, txContext = null) => {
    const dbContext = txContext || db;
    let query = `SELECT * FROM tbl_rfq_products WHERE id = $1`;
    const params = [rfq_product_id];
    
    if (rfq_id) {
      query += ` AND rfq_id = $2`;
      params.push(rfq_id);
    }
    
    return dbContext.oneOrNone(query, params);
  },

  /**
   * Check if vendor is already finalized for a product
   * @param {number} rfq_id - RFQ ID
   * @param {number} product_variant_id - Product variant ID
   * @param {number} variant - Variant number
   * @param {number} vendor_id - Vendor ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Finalization record if exists
   */
  getExistingFinalization: async (rfq_id, product_variant_id, variant, vendor_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT id FROM tbl_quote_finalization
       WHERE rfq_id = $1
         AND product_variant_id = $2
         AND variant = $3
         AND vendor_id = $4`,
      [rfq_id, product_variant_id, variant, vendor_id]
    );
  },

  // ============================================================================
  // TECH EVALUATION ROUNDS MANAGEMENT
  // ============================================================================

  /**
   * Create a new tech evaluation round
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {number} round_number - Round number
   * @param {number} created_by - User ID who created the round
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Created round record
   */
  createTechEvalRound: async (tech_evaluation_id, round_number, created_by, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.one(
      `INSERT INTO tbl_tech_evaluation_rounds
       (tbl_rfq_product_tech_evaluation_id, round_number, status, created_by, created_at)
       VALUES ($1, $2, 'PENDING', $3, NOW())
       RETURNING *`,
      [tech_evaluation_id, round_number, created_by]
    );
  },

  /**
   * Get tech evaluation round by ID
   * @param {number} round_id - Round ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Round record
   */
  getTechEvalRoundById: async (round_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT r.*, te.rfq_id, te.tbl_rfq_product_id, te.minimum_passing_score
       FROM tbl_tech_evaluation_rounds r
       JOIN tbl_rfq_product_tech_evaluation te ON te.id = r.tbl_rfq_product_tech_evaluation_id
       WHERE r.id = $1`,
      [round_id]
    );
  },

  /**
   * Update tech evaluation round status and metadata
   * @param {number} round_id - Round ID
   * @param {Object} updates - Fields to update
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Updated round record
   */
  updateTechEvalRound: async (round_id, updates, txContext = null) => {
    const dbContext = txContext || db;
    const setClauses = [];
    const params = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.approval_instance_id !== undefined) {
      setClauses.push(`approval_instance_id = $${paramIndex++}`);
      params.push(updates.approval_instance_id);
    }
    if (updates.vendors_evaluated !== undefined) {
      setClauses.push(`vendors_evaluated = $${paramIndex++}`);
      params.push(JSON.stringify(updates.vendors_evaluated));
    }
    if (updates.passed_count !== undefined) {
      setClauses.push(`passed_count = $${paramIndex++}`);
      params.push(updates.passed_count);
    }
    if (updates.failed_count !== undefined) {
      setClauses.push(`failed_count = $${paramIndex++}`);
      params.push(updates.failed_count);
    }
    if (updates.submitted_at !== undefined) {
      setClauses.push(`submitted_at = $${paramIndex++}`);
      params.push(updates.submitted_at);
    }
    if (updates.completed_at !== undefined) {
      setClauses.push(`completed_at = $${paramIndex++}`);
      params.push(updates.completed_at);
    }

    if (setClauses.length === 0) {
      return dbContext.oneOrNone(`SELECT * FROM tbl_tech_evaluation_rounds WHERE id = $1`, [round_id]);
    }

    params.push(round_id);
    return dbContext.oneOrNone(
      `UPDATE tbl_tech_evaluation_rounds SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );
  },

  /**
   * Get current round for a tech evaluation
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Current round record
   */
  getCurrentTechEvalRound: async (tech_evaluation_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT r.*, te.current_round
       FROM tbl_tech_evaluation_rounds r
       JOIN tbl_rfq_product_tech_evaluation te ON te.id = r.tbl_rfq_product_tech_evaluation_id
       WHERE r.tbl_rfq_product_tech_evaluation_id = $1
       ORDER BY r.round_number DESC
       LIMIT 1`,
      [tech_evaluation_id]
    );
  },

  /**
   * Get all rounds for a tech evaluation
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array>} - Array of round records
   */
  getTechEvalRounds: async (tech_evaluation_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.any(
      `SELECT r.*, ai.status as approval_status
       FROM tbl_tech_evaluation_rounds r
       LEFT JOIN tbl_approval_instances ai ON ai.id = r.approval_instance_id
       WHERE r.tbl_rfq_product_tech_evaluation_id = $1
       ORDER BY r.round_number DESC`,
      [tech_evaluation_id]
    );
  },

  /**
   * Update tech evaluation completion status
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {Object} updates - Fields to update
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Updated tech evaluation record
   */
  updateTechEvalStatus: async (tech_evaluation_id, updates, txContext = null) => {
    const dbContext = txContext || db;
    const setClauses = [];
    const params = [];
    let paramIndex = 1;

    if (updates.is_complete !== undefined) {
      setClauses.push(`is_complete = $${paramIndex++}`);
      params.push(updates.is_complete);
    }
    if (updates.current_round !== undefined) {
      setClauses.push(`current_round = $${paramIndex++}`);
      params.push(updates.current_round);
    }
    if (updates.total_passed_verified !== undefined) {
      setClauses.push(`total_passed_verified = $${paramIndex++}`);
      params.push(updates.total_passed_verified);
    }
    if (updates.blocked_insufficient_vendors !== undefined) {
      setClauses.push(`blocked_insufficient_vendors = $${paramIndex++}`);
      params.push(updates.blocked_insufficient_vendors);
    }

    if (setClauses.length === 0) {
      return dbContext.oneOrNone(`SELECT * FROM tbl_rfq_product_tech_evaluation WHERE id = $1`, [tech_evaluation_id]);
    }

    params.push(tech_evaluation_id);
    return dbContext.oneOrNone(
      `UPDATE tbl_rfq_product_tech_evaluation SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );
  },

  /**
   * Get tech evaluation by rfq_product_id with completion info
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Tech evaluation record with completion info
   */
  getTechEvalByProductId: async (rfq_product_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT te.*, r.rfq_no, r.hospitality_company_id, r.hotel_id, r.department_id, r.is_tender
       FROM tbl_rfq_product_tech_evaluation te
       JOIN tbl_rfq r ON r.id = te.rfq_id
       WHERE te.tbl_rfq_product_id = $1`,
      [rfq_product_id]
    );
  },

  /**
   * Get vendor scores with pass/fail status for a tech evaluation
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {number} minimum_passing_score - Minimum passing score
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array>} - Array of vendor scores
   */
  getVendorScoresForTechEval: async (tech_evaluation_id, minimum_passing_score = 0, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.any(
      `SELECT
        vr.vendor_id,
        tu.name AS vendor_name,
        tu.email AS vendor_email,
        COALESCE(tc.company_name, tu.organization_name) AS company_name,
        MAX(rpv.id) AS rfq_product_vendor_id,
        COUNT(CASE WHEN vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp THEN 1 END) AS evaluated_clauses_count,
        COUNT(c.id) AS total_clauses_count,
        BOOL_OR(vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp) AS has_marks,
        BOOL_AND(vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp) AS is_fully_evaluated,
        COALESCE(SUM(CASE WHEN vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp THEN vr.buyer_marks ELSE 0 END), 0) AS total_marks,
        COALESCE(SUM(c.weightage), 0) AS total_weightage,
        CASE
          WHEN NOT BOOL_AND(vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp) THEN NULL
          WHEN COALESCE(SUM(c.weightage), 0) > 0
          THEN ROUND((COALESCE(SUM(CASE WHEN vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp THEN vr.buyer_marks ELSE 0 END), 0)::NUMERIC / COALESCE(SUM(c.weightage), 0)::NUMERIC) * 100, 2)
          ELSE 0
        END AS calculated_score,
        $2::NUMERIC AS minimum_passing_score,
        CASE
          WHEN NOT BOOL_AND(vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp) THEN NULL
          WHEN COALESCE(SUM(c.weightage), 0) > 0
          THEN CASE
            WHEN ROUND((COALESCE(SUM(CASE WHEN vr.score_timestamp IS NOT NULL AND vr.score_timestamp != vr.timestamp THEN vr.buyer_marks ELSE 0 END), 0)::NUMERIC / COALESCE(SUM(c.weightage), 0)::NUMERIC) * 100, 2) >= COALESCE($2::NUMERIC, 0)
            THEN true
            ELSE false
          END
          ELSE NULL
        END AS is_passed
      FROM tbl_rfq_product_tech_evaluation_clauses c
      LEFT JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
        ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
      LEFT JOIN tbl_users tu ON tu.id = vr.vendor_id
      LEFT JOIN tbl_company tc ON tc.id = tu.company_id
      LEFT JOIN tbl_rfq_product_tech_evaluation te_ref ON te_ref.id = c.tbl_rfq_product_tech_evaluation_id
      LEFT JOIN tbl_rfq_products trp_ref ON trp_ref.id = te_ref.tbl_rfq_product_id
      LEFT JOIN tbl_rfq_product_vendors rpv
        ON rpv.rfq_id = te_ref.rfq_id
        AND rpv.user_id = vr.vendor_id
        AND rpv.product_variant_id = trp_ref.product_variant_id
        AND rpv.variant = trp_ref.variant
      WHERE c.tbl_rfq_product_tech_evaluation_id = $1
        -- Exclude vendors already verified (approved) in a previous round
        AND NOT EXISTS (
          SELECT 1 FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
          WHERE cv.tbl_rfq_product_tech_evaluation_id = $1
            AND cv.vendor_id = vr.vendor_id
            AND cv.is_verified = true
        )
      GROUP BY vr.vendor_id, tu.name, tu.email, tc.company_name, tu.organization_name
      HAVING vr.vendor_id IS NOT NULL`,
      [tech_evaluation_id, minimum_passing_score]
    );
  },

  /**
   * Update cleared vendor with verification and round info
   * @param {number} cleared_vendor_id - Cleared vendor record ID
   * @param {Object} updates - Fields to update
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Updated cleared vendor record
   */
  updateClearedVendor: async (cleared_vendor_id, updates, txContext = null) => {
    const dbContext = txContext || db;
    const setClauses = [];
    const params = [];
    let paramIndex = 1;

    if (updates.is_verified !== undefined) {
      setClauses.push(`is_verified = $${paramIndex++}`);
      params.push(updates.is_verified);
    }
    if (updates.evaluation_round !== undefined) {
      setClauses.push(`evaluation_round = $${paramIndex++}`);
      params.push(updates.evaluation_round);
    }
    if (updates.approval_instance_id !== undefined) {
      setClauses.push(`approval_instance_id = $${paramIndex++}`);
      params.push(updates.approval_instance_id);
    }
    if (updates.calculated_score !== undefined) {
      setClauses.push(`calculated_score = $${paramIndex++}`);
      params.push(updates.calculated_score);
    }
    if (updates.replaced_by_vendor_id !== undefined) {
      setClauses.push(`replaced_by_vendor_id = $${paramIndex++}`);
      params.push(updates.replaced_by_vendor_id);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.reject_message !== undefined) {
      setClauses.push(`reject_message = $${paramIndex++}`);
      params.push(updates.reject_message);
    }

    if (setClauses.length === 0) {
      return dbContext.oneOrNone(`SELECT * FROM tbl_rfq_product_tech_evaluation_cleared_vendors WHERE id = $1`, [cleared_vendor_id]);
    }

    params.push(cleared_vendor_id);
    return dbContext.oneOrNone(
      `UPDATE tbl_rfq_product_tech_evaluation_cleared_vendors SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );
  },

  /**
   * Get cleared vendors for a tech evaluation with optional filters
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {Object} filters - Optional filters (is_verified, status, evaluation_round)
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array>} - Array of cleared vendor records
   */
  getClearedVendorsForTechEval: async (tech_evaluation_id, filters = {}, txContext = null) => {
    const dbContext = txContext || db;
    let query = `
      SELECT cv.*, tu.name AS vendor_name, tu.email AS vendor_email,
             COALESCE(tc.company_name, tu.organization_name) AS company_name,
             ru.name AS replaced_by_vendor_name
      FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
      JOIN tbl_users tu ON tu.id = cv.vendor_id
      LEFT JOIN tbl_company tc ON tc.id = tu.company_id
      LEFT JOIN tbl_users ru ON ru.id = cv.replaced_by_vendor_id
      WHERE cv.tbl_rfq_product_tech_evaluation_id = $1
    `;
    const params = [tech_evaluation_id];
    let paramIndex = 2;

    if (filters.is_verified !== undefined) {
      query += ` AND cv.is_verified = $${paramIndex++}`;
      params.push(filters.is_verified);
    }
    if (filters.status !== undefined) {
      query += ` AND cv.status = $${paramIndex++}`;
      params.push(filters.status);
    }
    if (filters.evaluation_round !== undefined) {
      query += ` AND cv.evaluation_round = $${paramIndex++}`;
      params.push(filters.evaluation_round);
    }

    query += ` ORDER BY cv.evaluation_round ASC, cv.timestamp ASC`;

    return dbContext.any(query, params);
  },

  /**
   * Get technical evaluation dashboard summary for an RFQ
   * @param {number} rfq_id - RFQ ID
   * @returns {Promise<Object>} - Dashboard summary
   */
  getTechEvalDashboard: async (rfq_id) => {
    return db.one(
      `SELECT
        COUNT(te.id) AS total_products,
        COUNT(te.id) FILTER (
          WHERE response_vendors.cnt > 0
          AND response_vendors.cnt = COALESCE(evaluated_vendors.cnt, 0)
        ) AS products_completed,
        COALESCE(
          ARRAY_AGG(te.tbl_rfq_product_id) FILTER (
            WHERE response_vendors.cnt > 0
            AND response_vendors.cnt = COALESCE(evaluated_vendors.cnt, 0)
          ),
          '{}'::int[]
        ) AS completed_product_ids,
        COUNT(te.id) FILTER (
          WHERE response_vendors.cnt > 0
          AND COALESCE(evaluated_vendors.cnt, 0) < response_vendors.cnt
          AND EXISTS (
            SELECT 1 FROM tbl_tech_evaluation_rounds r
            WHERE r.tbl_rfq_product_tech_evaluation_id = te.id
          )
        ) AS products_in_progress,
        COALESCE(SUM(passed.cnt), 0) AS vendors_passed,
        COALESCE(SUM(failed.cnt), 0) AS vendors_failed
      FROM tbl_rfq_product_tech_evaluation te
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT vr.vendor_id) AS cnt
        FROM tbl_rfq_product_tech_evaluation_vendors_response vr
        JOIN tbl_rfq_product_tech_evaluation_clauses c
          ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
        WHERE c.tbl_rfq_product_tech_evaluation_id = te.id
      ) response_vendors ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT cv.vendor_id) AS cnt
        FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
        WHERE cv.tbl_rfq_product_tech_evaluation_id = te.id
      ) evaluated_vendors ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt
        FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
        WHERE cv.tbl_rfq_product_tech_evaluation_id = te.id AND cv.status = 1
      ) passed ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt
        FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
        WHERE cv.tbl_rfq_product_tech_evaluation_id = te.id AND cv.status = 0
      ) failed ON true
      WHERE te.rfq_id = $1`,
      [rfq_id]
    );
  },

  /**
   * Count passed verified vendors for a tech evaluation
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<number>} - Count of passed verified vendors
   */
  countPassedVerifiedVendors: async (tech_evaluation_id, txContext = null) => {
    const dbContext = txContext || db;
    const result = await dbContext.one(
      `SELECT COUNT(*) AS count
       FROM tbl_rfq_product_tech_evaluation_cleared_vendors
       WHERE tbl_rfq_product_tech_evaluation_id = $1
         AND status = 1
         AND is_verified = true`,
      [tech_evaluation_id]
    );
    return parseInt(result.count, 10);
  },

  /**
   * Get all evaluated vendor IDs for a tech evaluation (to exclude from next round)
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array<number>>} - Array of vendor IDs
   */
  getAllEvaluatedVendorIds: async (tech_evaluation_id, txContext = null) => {
    const dbContext = txContext || db;
    const result = await dbContext.any(
      `SELECT DISTINCT vendor_id
       FROM tbl_rfq_product_tech_evaluation_cleared_vendors
       WHERE tbl_rfq_product_tech_evaluation_id = $1`,
      [tech_evaluation_id]
    );
    return result.map(r => r.vendor_id);
  },

  /**
   * Get the next-in-line replacement vendor from the tech eval pool.
   * Picks the HIGHEST-ranked pending vendor (highest rfq_product_vendor_id = last in L-ranking).
   * When L1 fails from a pool of L1-L6, this returns L6 (the next in line after L5).
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {number} rfq_id - RFQ ID
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {Array<number>} exclude_vendor_ids - Vendor IDs to exclude (already evaluated/scored)
   * @param {number} limit - Max vendors to return
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array>} - Array of replacement vendors sorted by highest L-number first
   */
  getReserveTechEvalVendors: async (tech_evaluation_id, rfq_id, rfq_product_id, exclude_vendor_ids = [], limit = 10, txContext = null) => {
    const dbContext = txContext || db;

    // Find pending vendors (have tech eval responses, not yet scored) sorted by
    // rfq_product_vendor_id DESC so the highest-ranked (L6, L7, etc.) comes first.
    // This ensures when L1 fails, we pick L6 (next in line) not L3 (already in top 5).
    let query = `
      SELECT DISTINCT ON (vr.vendor_id)
        vr.vendor_id,
        COALESCE(tc.company_name, tu.organization_name, tu.name) AS vendor_name,
        tu.email AS vendor_email,
        rpv.id AS rfq_product_vendor_id
      FROM tbl_rfq_product_tech_evaluation_vendors_response vr
      JOIN tbl_rfq_product_tech_evaluation_clauses c
        ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
      JOIN tbl_users tu ON tu.id = vr.vendor_id
      LEFT JOIN tbl_company tc ON tc.id = tu.company_id
      JOIN tbl_rfq_products rp ON rp.id = $2
      LEFT JOIN tbl_rfq_product_vendors rpv ON rpv.rfq_id = $3
        AND rpv.user_id = vr.vendor_id
        AND rpv.product_variant_id = rp.product_variant_id
        AND COALESCE(rpv.variant, 0) = COALESCE(rp.variant, 0)
      WHERE c.tbl_rfq_product_tech_evaluation_id = $1
    `;

    const params = [tech_evaluation_id, rfq_product_id, rfq_id];

    if (exclude_vendor_ids.length > 0) {
      const placeholders = exclude_vendor_ids.map((_, idx) => `$${params.length + idx + 1}`).join(',');
      query += ` AND vr.vendor_id NOT IN (${placeholders})`;
      params.push(...exclude_vendor_ids);
    }

    // Use a subquery to first get distinct vendors, then sort by rpv.id DESC
    const wrappedQuery = `
      SELECT * FROM (${query} ORDER BY vr.vendor_id) sub
      ORDER BY sub.rfq_product_vendor_id DESC NULLS LAST
      LIMIT $${params.length + 1}
    `;
    params.push(limit);

    return dbContext.any(wrappedQuery, params);
  },

  /**
   * Create empty vendor response records for replacement vendors
   * @param {number} tech_evaluation_id - Tech evaluation ID
   * @param {number} vendor_id - Vendor ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array>} - Created response records
   */
  createEmptyVendorResponses: async (tech_evaluation_id, vendor_id, txContext = null) => {
    const dbContext = txContext || db;

    // Get all clause IDs for this tech evaluation
    const clauses = await dbContext.any(
      `SELECT id FROM tbl_rfq_product_tech_evaluation_clauses
       WHERE tbl_rfq_product_tech_evaluation_id = $1`,
      [tech_evaluation_id]
    );

    const insertedRecords = [];
    for (const clause of clauses) {
      // Check if response already exists
      const exists = await dbContext.oneOrNone(
        `SELECT id FROM tbl_rfq_product_tech_evaluation_vendors_response
         WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1 AND vendor_id = $2`,
        [clause.id, vendor_id]
      );

      if (!exists) {
        const record = await dbContext.one(
          `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
           (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, timestamp)
           VALUES ($1, $2, '', NOW())
           RETURNING *`,
          [clause.id, vendor_id]
        );
        insertedRecords.push(record);
      }
    }

    return insertedRecords;
  },

  /**
   * Get tech evaluation status with all details for API response
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Complete status object
   */
  getTechEvalStatusByProductId: async (rfq_product_id, txContext = null) => {
    const dbContext = txContext || db;

    // Get tech evaluation with product info
    const techEval = await dbContext.oneOrNone(
      `SELECT te.*, rp.product_variant_id, rp.variant, pv.name AS product_name, r.rfq_no
       FROM tbl_rfq_product_tech_evaluation te
       JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
       JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
       JOIN tbl_rfq r ON r.id = te.rfq_id
       WHERE te.tbl_rfq_product_id = $1`,
      [rfq_product_id]
    );

    if (!techEval) {
      return null;
    }

    // Get all rounds
    const rounds = await dbContext.any(
      `SELECT r.*, ai.status AS approval_status
       FROM tbl_tech_evaluation_rounds r
       LEFT JOIN tbl_approval_instances ai ON ai.id = r.approval_instance_id
       WHERE r.tbl_rfq_product_tech_evaluation_id = $1
       ORDER BY r.round_number ASC`,
      [techEval.id]
    );

    // Get selected vendors for this RFQ product so consumers can show the full roster,
    // including vendors who have not started responding yet.
    const selectedVendors = await dbContext.any(
      `SELECT
          rpv.id AS rfq_product_vendor_id,
          rpv.user_id AS vendor_id,
          tu.name AS vendor_name,
          tu.email AS vendor_email,
          COALESCE(tc.company_name, tu.organization_name) AS company_name,
          EXISTS (
            SELECT 1
            FROM tbl_quotes tq
            JOIN tbl_quote_items tqi ON tqi.quote_id = tq.id
            WHERE tq.rfq_id = $1
              AND tq.created_by = rpv.user_id
              AND tqi.product_variant_id = $2
              AND COALESCE(tqi.variant, 0) = COALESCE($3, 0)
              AND tqi.total_price > 0
          ) AS has_submitted_quote
       FROM tbl_rfq_product_vendors rpv
       JOIN tbl_users tu ON tu.id = rpv.user_id
       LEFT JOIN tbl_company tc ON tc.id = tu.company_id
       WHERE rpv.rfq_id = $1
         AND rpv.product_variant_id = $2
         AND COALESCE(rpv.variant, 0) = COALESCE($3, 0)
         AND tu.status = 1
       ORDER BY rpv.id ASC`,
      [techEval.rfq_id, techEval.product_variant_id, techEval.variant]
    );

    // Get passed verified vendors
    const passedVerified = await dbContext.any(
      `SELECT cv.*, tu.name AS vendor_name, tu.email AS vendor_email,
              COALESCE(tc.company_name, tu.organization_name) AS company_name
              , rpv.id AS rfq_product_vendor_id
       FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
       JOIN tbl_users tu ON tu.id = cv.vendor_id
       LEFT JOIN tbl_company tc ON tc.id = tu.company_id
       LEFT JOIN tbl_rfq_product_vendors rpv ON rpv.rfq_id = $2
         AND rpv.user_id = cv.vendor_id
         AND rpv.product_variant_id = $3
         AND COALESCE(rpv.variant, 0) = COALESCE($4, 0)
       WHERE cv.tbl_rfq_product_tech_evaluation_id = $1
         AND cv.status = 1
         AND cv.is_verified = true
       ORDER BY cv.evaluation_round ASC`,
      [techEval.id, techEval.rfq_id, techEval.product_variant_id, techEval.variant]
    );

    // Get failed verified vendors
    const failedVerified = await dbContext.any(
      `SELECT cv.*, tu.name AS vendor_name, tu.email AS vendor_email,
              COALESCE(tc.company_name, tu.organization_name) AS company_name,
              ru.name AS replaced_by_vendor_name,
              rpv_failed.id AS rfq_product_vendor_id,
              rpv_replaced.id AS replaced_by_rfq_product_vendor_id
       FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
       JOIN tbl_users tu ON tu.id = cv.vendor_id
       LEFT JOIN tbl_company tc ON tc.id = tu.company_id
       LEFT JOIN tbl_users ru ON ru.id = cv.replaced_by_vendor_id
       LEFT JOIN tbl_rfq_product_vendors rpv_failed ON rpv_failed.rfq_id = $2
         AND rpv_failed.user_id = cv.vendor_id
         AND rpv_failed.product_variant_id = $3
         AND COALESCE(rpv_failed.variant, 0) = COALESCE($4, 0)
       LEFT JOIN tbl_rfq_product_vendors rpv_replaced ON rpv_replaced.rfq_id = $2
         AND rpv_replaced.user_id = cv.replaced_by_vendor_id
         AND rpv_replaced.product_variant_id = $3
         AND COALESCE(rpv_replaced.variant, 0) = COALESCE($4, 0)
       WHERE cv.tbl_rfq_product_tech_evaluation_id = $1
         AND cv.status = 0
         AND cv.is_verified = true
       ORDER BY cv.evaluation_round ASC`,
      [techEval.id, techEval.rfq_id, techEval.product_variant_id, techEval.variant]
    );

    // Get pending evaluation vendors (those with responses but not in cleared table or not verified)
    const pendingEvaluation = await dbContext.any(
      `SELECT DISTINCT vr.vendor_id, tu.name AS vendor_name, tu.email AS vendor_email,
              COALESCE(tc.company_name, tu.organization_name) AS company_name,
              rpv.id AS rfq_product_vendor_id
       FROM tbl_rfq_product_tech_evaluation_vendors_response vr
       JOIN tbl_rfq_product_tech_evaluation_clauses c ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
       JOIN tbl_users tu ON tu.id = vr.vendor_id
       LEFT JOIN tbl_company tc ON tc.id = tu.company_id
       LEFT JOIN tbl_rfq_product_vendors rpv ON rpv.rfq_id = $2
         AND rpv.user_id = vr.vendor_id
         AND rpv.product_variant_id = $3
         AND COALESCE(rpv.variant, 0) = COALESCE($4, 0)
       LEFT JOIN tbl_rfq_product_tech_evaluation_cleared_vendors cv
         ON cv.tbl_rfq_product_tech_evaluation_id = c.tbl_rfq_product_tech_evaluation_id
         AND cv.vendor_id = vr.vendor_id
       WHERE c.tbl_rfq_product_tech_evaluation_id = $1
         AND (cv.id IS NULL OR cv.is_verified = false)`,
      [techEval.id, techEval.rfq_id, techEval.product_variant_id, techEval.variant]
    );

    const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    let currentPendingApprovers = [];

    if (latestRound?.approval_instance_id && latestRound?.approval_status === 'PENDING') {
      currentPendingApprovers = await dbContext.any(
        `SELECT DISTINCT
            u.id AS user_id,
            u.name AS user_name,
            u.email AS user_email
         FROM tbl_approval_instances ai
         JOIN tbl_approval_instance_steps ais
           ON ais.approval_instance_id = ai.id
         JOIN tbl_approval_step_approvers asa
           ON asa.approval_instance_step_id = ais.id
         JOIN tbl_users u
           ON u.id = asa.approver_user_id
         WHERE ai.id = $1
           AND ai.status = 'PENDING'
           AND ais.step_order = ai.current_step
           AND asa.status = 'PENDING'
         ORDER BY u.name ASC`,
        [latestRound.approval_instance_id]
      );
    }

    // Use actual passed verified count as source of truth (more reliable than stored field)
    const actualPassedVerifiedCount = passedVerified.length;

    return {
      tech_evaluation_id: techEval.id,
      rfq_product_id: techEval.tbl_rfq_product_id,
      rfq_id: techEval.rfq_id,
      rfq_no: techEval.rfq_no,
      product_name: techEval.product_name,
      is_complete: techEval.is_complete || false,
      current_round: techEval.current_round || 1,
      total_passed_verified: Math.max(actualPassedVerifiedCount, techEval.total_passed_verified || 0),
      required_passed_vendors: techEval.required_passed_vendors || 5,
      blocked_insufficient_vendors: techEval.blocked_insufficient_vendors || false,
      minimum_passing_score: techEval.minimum_passing_score,
      rounds: rounds.map(r => ({
        round_id: r.id,
        round_number: r.round_number,
        status: r.status,
        approval_instance_id: r.approval_instance_id,
        approval_status: r.approval_status,
        passed_count: r.passed_count,
        failed_count: r.failed_count,
        submitted_at: r.submitted_at,
        completed_at: r.completed_at
      })),
      current_pending_approvers: currentPendingApprovers.map((approver) => ({
        user_id: approver.user_id,
        user_name: approver.user_name,
        user_email: approver.user_email
      })),
      vendors: {
        selected: selectedVendors.map(v => ({
          vendor_id: v.vendor_id,
          vendor_name: v.vendor_name,
          vendor_email: v.vendor_email,
          company_name: v.company_name,
          rfq_product_vendor_id: v.rfq_product_vendor_id,
          has_submitted_quote: v.has_submitted_quote || false
        })),
        passed_verified: passedVerified.map(v => ({
          vendor_id: v.vendor_id,
          vendor_name: v.vendor_name,
          vendor_email: v.vendor_email,
          company_name: v.company_name,
          rfq_product_vendor_id: v.rfq_product_vendor_id,
          calculated_score: v.calculated_score,
          evaluation_round: v.evaluation_round,
          is_verified: v.is_verified
        })),
        failed_verified: failedVerified.map(v => ({
          vendor_id: v.vendor_id,
          vendor_name: v.vendor_name,
          vendor_email: v.vendor_email,
          company_name: v.company_name,
          rfq_product_vendor_id: v.rfq_product_vendor_id,
          calculated_score: v.calculated_score,
          reject_message: v.reject_message,
          evaluation_round: v.evaluation_round,
          is_verified: v.is_verified,
          replaced_by_vendor_id: v.replaced_by_vendor_id,
          replaced_by_vendor_name: v.replaced_by_vendor_name,
          replaced_by_rfq_product_vendor_id: v.replaced_by_rfq_product_vendor_id
        })),
        pending_evaluation: pendingEvaluation.map(v => ({
          vendor_id: v.vendor_id,
          vendor_name: v.vendor_name,
          vendor_email: v.vendor_email,
          company_name: v.company_name,
          rfq_product_vendor_id: v.rfq_product_vendor_id,
          evaluation_round: techEval.current_round || 1,
          is_verified: false
        }))
      },
      summary: {
        selected_vendor_count: selectedVendors.length,
        passed_verified_count: passedVerified.length,
        failed_verified_count: failedVerified.length,
        pending_count: pendingEvaluation.length,
        vendors_needed: Math.max(0, (techEval.required_passed_vendors || 5) - passedVerified.length)
      }
    };
  },

  /**
   * Get tech evaluation history for a product
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Array>} - Array of round history
   */
  getTechEvalHistoryByProductId: async (rfq_product_id, txContext = null) => {
    const dbContext = txContext || db;

    const techEval = await dbContext.oneOrNone(
      `SELECT id FROM tbl_rfq_product_tech_evaluation WHERE tbl_rfq_product_id = $1`,
      [rfq_product_id]
    );

    if (!techEval) {
      return [];
    }

    // Get all rounds with vendors
    const rounds = await dbContext.any(
      `SELECT r.*, ai.status AS approval_status
       FROM tbl_tech_evaluation_rounds r
       LEFT JOIN tbl_approval_instances ai ON ai.id = r.approval_instance_id
       WHERE r.tbl_rfq_product_tech_evaluation_id = $1
       ORDER BY r.round_number DESC`,
      [techEval.id]
    );

    // Get cleared vendors for each round
    const history = [];
    for (const round of rounds) {
      const vendorsInRound = await dbContext.any(
        `SELECT cv.*, tu.name AS vendor_name, tu.email AS vendor_email,
                COALESCE(tc.company_name, tu.organization_name) AS company_name
         FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
         JOIN tbl_users tu ON tu.id = cv.vendor_id
         LEFT JOIN tbl_company tc ON tc.id = tu.company_id
         WHERE cv.tbl_rfq_product_tech_evaluation_id = $1
           AND cv.evaluation_round = $2
         ORDER BY cv.status DESC, cv.calculated_score DESC`,
        [techEval.id, round.round_number]
      );

      history.push({
        round_id: round.id,
        round_number: round.round_number,
        status: round.status,
        approval_instance_id: round.approval_instance_id,
        approval_status: round.approval_status,
        submitted_at: round.submitted_at,
        completed_at: round.completed_at,
        vendors_in_round: vendorsInRound.map(v => ({
          vendor_id: v.vendor_id,
          vendor_name: v.vendor_name,
          vendor_email: v.vendor_email,
          company_name: v.company_name,
          status: v.status,
          is_verified: v.is_verified,
          calculated_score: v.calculated_score,
          reject_message: v.reject_message,
          replaced_by_vendor_id: v.replaced_by_vendor_id
        }))
      });
    }

    return history;
  },

  /**
   * Insert or update cleared vendor record
   * @param {Object} vendorData - Vendor data to insert/update
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Inserted/updated record
   */
  upsertClearedVendor: async (vendorData, txContext = null) => {
    const dbContext = txContext || db;
    const {
      tech_evaluation_id,
      vendor_id,
      status,
      reject_message,
      is_verified,
      evaluation_round,
      approval_instance_id,
      calculated_score,
      created_by
    } = vendorData;

    // Check if record exists
    const existing = await dbContext.oneOrNone(
      `SELECT id FROM tbl_rfq_product_tech_evaluation_cleared_vendors
       WHERE tbl_rfq_product_tech_evaluation_id = $1 AND vendor_id = $2`,
      [tech_evaluation_id, vendor_id]
    );

    if (existing) {
      // Update existing
      return dbContext.one(
        `UPDATE tbl_rfq_product_tech_evaluation_cleared_vendors
         SET status = $1, reject_message = $2, is_verified = $3, evaluation_round = $4,
             approval_instance_id = $5, calculated_score = $6, timestamp = NOW(), created_by = $7
         WHERE id = $8
         RETURNING *`,
        [status, reject_message, is_verified, evaluation_round, approval_instance_id, calculated_score, created_by, existing.id]
      );
    } else {
      // Insert new
      return dbContext.one(
        `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
         (tbl_rfq_product_tech_evaluation_id, vendor_id, status, reject_message, is_verified,
          evaluation_round, approval_instance_id, calculated_score, timestamp, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
         RETURNING *`,
        [tech_evaluation_id, vendor_id, status, reject_message, is_verified,
         evaluation_round, approval_instance_id, calculated_score, created_by]
      );
    }
  },
};

export default rfqModel;
