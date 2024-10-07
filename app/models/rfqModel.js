import db, { pgp } from '../config/dbConn.js';
import Config from '../config/app.config.js';

const rfqModel = {
  insert: async (table_name, data) => {
    const keys = Object.keys(data);
    const values = keys.map((key) => {
      if (typeof data[key] === 'string') {
        return `'${data[key]}'`;
      } else {
        return data[key];
      }
    });
    const d_keys = keys.join(', ');
    const query = `INSERT INTO ${table_name} (${d_keys}) VALUES (${values.join(
      ', '
    )}) RETURNING *`;
    console.log('query', query);
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
  insertArray: async (dataArray, keys, table_name) => {
    const insertQuery =
      pgp.helpers.insert(dataArray, keys, table_name) + ' RETURNING *';

    return new Promise(function (resolve, reject) {
      db.manyOrNone(insertQuery)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
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
      db.any(`select * from tbl_rfq`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  update: async (table_name, data, primary_key) => {
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
      db.query(updateQuery, values)
        .then(function (data) {
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
  getAllRfqBuyer: async (limit, offset, user_id, month, year) => {
    const query = `SELECT RFQ.id,RFQ.rfq_no,RFQ.is_published,RFQ.created_by,RFQ.status,RFQ.timestamp,  
      ARRAY(
      SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id 
    ) AS "quotations",

    ARRAY(
      SELECT json_build_object('id', TQF.id,'rfq_id', TQF.rfq_id,'rfq_no', TQF.rfq_no, 'timestamp', TQF.timestamp, 'created_by', TQF.created_by ) FROM tbl_quote_finalization TQF WHERE TQF.rfq_id = RFQ.id AND TQF.created_by = '${user_id}'
    ) AS "finilize"
    FROM tbl_rfq RFQ 
    WHERE created_by =  '${user_id}' AND EXTRACT(MONTH FROM timestamp) = '${month}' AND EXTRACT(YEAR FROM timestamp) = '${year}' ORDER BY id DESC LIMIT ${limit} OFFSET ${offset} `;
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
  getAllRfqBuyerExport: async (user_id, month, year) => {
    const query = `SELECT RFQ.id,RFQ.rfq_no,RFQ.is_published,RFQ.created_by,RFQ.status,RFQ.timestamp,  
      ARRAY(
      SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id 
    ) AS "quotations",

    ARRAY(
      SELECT json_build_object('id', TQF.id,'rfq_id', TQF.rfq_id,'rfq_no', TQF.rfq_no, 'timestamp', TQF.timestamp, 'created_by', TQF.created_by ) FROM tbl_quote_finalization TQF WHERE TQF.rfq_id = RFQ.id AND TQF.created_by = '${user_id}'
    ) AS "finilize"
    FROM tbl_rfq RFQ 
    WHERE created_by =  '${user_id}' AND EXTRACT(MONTH FROM timestamp) = '${month}' AND EXTRACT(YEAR FROM timestamp) = '${year}' ORDER BY id DESC  `;
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
  getRfqByUser: async (limit, offset, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT RFQ.*,           
            ARRAY(
                SELECT json_build_object('id', RFQ_P.id, 'product_id', RFQ_P.product_id,
                    'product_categories', (
                        SELECT json_agg(json_build_object('category_id',TPC.category_id,'category_name',TC.title))
                        FROM tbl_product_categories TPC
                        LEFT JOIN tbl_category TC ON TC.id = TPC.category_id
                        WHERE TPC.product_id = RFQ_P.id
                    ),
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
                        AND RFQ_P_V.user_id = ${user_id} 
                    )
                )
                FROM tbl_rfq_products RFQ_P
                JOIN tbl_rfq_product_vendors trpv ON trpv.rfq_id = RFQ.id AND trpv.user_id = ${user_id} AND trpv.product_id = RFQ_P.product_id
                WHERE RFQ.id = RFQ_P.rfq_id AND trpv.rfq_id = RFQ.id AND trpv.user_id = ${user_id} AND trpv.product_id = RFQ_P.product_id
            ) AS "products" ,
            CASE 
                WHEN EXISTS (
                SELECT * FROM tbl_quotes TQ
                WHERE TQ.rfq_id = RFQ.id AND TQ.rfq_no = RFQ.rfq_no AND TQ.created_by = ${user_id}
             ) THEN
             CASE 
             WHEN (SELECT TQ.is_regret FROM tbl_quotes TQ 
                  WHERE TQ.rfq_id = RFQ.id AND TQ.rfq_no = RFQ.rfq_no AND TQ.created_by = ${user_id} LIMIT 1) = 1 THEN 'rejected'
             ELSE 'sent'
            END
            ELSE 'pending'
        END AS "quote_status"
        FROM tbl_rfq RFQ
        WHERE EXISTS (
            SELECT 1
            FROM tbl_rfq_product_vendors RFQ_P_V
            WHERE RFQ.id = RFQ_P_V.rfq_id
            AND RFQ_P_V.user_id = ${user_id} 
        )
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
  getRfqById: async (id, user_id, user_type) => {

    //  query changed by mukul,
    let q = `SELECT RFQ.*,
    ARRAY(
      SELECT json_build_object('id', TQF.id,'product_id',TQF.product_id, 'timestamp', TQF.timestamp,'variant', TQF.variant,
        'winning_vendor', 
          (
            SELECT json_build_object( 'id', TUU.id, 'name', TUU.name, 'email', TUU.email, 'mobile', TUU.mobile, 'address', TUU.address, 'organization_name', TUU.organization_name ) FROM tbl_users TUU WHERE TUU.id = TQF.vendor_id
          ),
        'product_details', (
          SELECT json_build_object( 'id', TPP.id, 'name', TPP.name, 'description', TPP.description, 'manufacturer', TPP.manufacturer, 'availability', TPP.availability, 'description', TPP.description ) FROM tbl_product TPP WHERE TPP.id = TQF.product_id
        )
      ) FROM tbl_quote_finalization TQF WHERE TQF.rfq_id = RFQ.id
  ) AS "finalizations",
    ARRAY(
      SELECT json_build_object('id', RFQ_TM.id,
        'content', (
          SELECT json_agg(json_build_object('title', RFQ_T.term_content))
          FROM tbl_rfq_terms RFQ_T
          WHERE CAST(RFQ_TM.terms_id AS INTEGER) = RFQ_T.id
        )
      ) FROM tbl_rfq_terms_map RFQ_TM WHERE RFQ_TM.rfq_id = RFQ.id
    ) AS "terms",
    ARRAY(
      SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret,
        'products', (
          SELECT json_agg(json_build_object('product_id', TQI.product_id,'variant', TQI.variant,'product_name', TQI.product_name,'unit_price', TQI.unit_price,'package_price', TQI.package_price,'tax', TQI.tax,'freight_price', TQI.freight_price,'total_price', TQI.total_price,'comment', TQI.comment,'delivery_period', TQI.delivery_period))
          FROM tbl_quote_items TQI
          WHERE CAST(TQ.id AS INTEGER) = TQI.quote_id
        )
      ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id AND TQ.created_by = ${user_id}
    ) AS "quotations",
    ARRAY(
        SELECT json_build_object('id', RFQ_P.id, 'product_id', RFQ_P.product_id, 'variant', RFQ_P.variant, 'comment', RFQ_P.comment, 'spec_file', RFQ_P.spec_file, 'qap', RFQ_P.qap, 'qap_file', RFQ_P.qap_file, 'datasheet_file', RFQ_P.datasheet_file,
          'datasheet', (
            SELECT json_agg(json_build_object('name', TVA.vendor_approve,'datasheet_link',
                CASE
                  WHEN TVA.datasheet_file IS NULL THEN 
                  NULL
                  ELSE TVA.datasheet_file
                END
              ))
            FROM tbl_vendor_approve TVA
            WHERE CAST(RFQ_P.datasheet AS INTEGER) = TVA.id
          ),
          'qap', (
            SELECT json_agg(json_build_object('name', TVA.vendor_approve,'qap_link', CASE
                  WHEN TVA.qap_file IS NULL THEN
                  NULL
                  ELSE TVA.qap_file
                END))
            FROM tbl_vendor_approve TVA
            WHERE CAST(RFQ_P.qap AS INTEGER) = TVA.id
          ),
          'product_specs', (
            SELECT json_agg(json_build_object('title', RFQ_P_SPEC.title,'value', RFQ_P_SPEC.value,'id', RFQ_P_SPEC.id,'product_id', RFQ_P_SPEC.product_id,'rfq_id', RFQ_P_SPEC.rfq_id,'variant', RFQ_P_SPEC.variant))
            FROM tbl_rfq_products_specs RFQ_P_SPEC
            WHERE RFQ_P.product_id = RFQ_P_SPEC.product_id AND RFQ_P.rfq_id = RFQ_P_SPEC.rfq_id AND RFQ_P.variant = RFQ_P_SPEC.variant
          ),
          'product_details', (
            SELECT json_agg(json_build_object('id', T_P.id,'name', T_P.name, 'description', T_P.description, 'manufacturer', T_P.manufacturer, 'availability', T_P.availability, 'description', T_P.description,
                'predefined_tds_file',
                CASE
                  WHEN T_P.tds_new_file_name IS NULL THEN NULL
                  ELSE T_P.tds_new_file_name END,
                'predefined_qap_file',
                CASE
                  WHEN T_P.qap_new_file_name IS NULL THEN NULL
                  ELSE T_P.qap_new_file_name END))
            FROM tbl_product T_P
            WHERE RFQ_P.product_id = T_P.id
          ),
            ${
              user_type == 3
                ? `-- Changes made by Imtiaj 28/09/2024 [Added logic to get the lowest_total from quotes for each unique product with the specified RFQ_id.] 
                'lowest_quotation', (
                        SELECT json_build_object(
                            'quote_id', TQI.quote_id,
                            'total_price', TQI.total_price
                        )
                        FROM tbl_quote_items TQI
                        WHERE TQI.product_id = RFQ_P.product_id
                        AND TQI.variant = RFQ_P.variant
                        AND TQI.rfq_id = RFQ_P.rfq_id  -- Ensure you're getting quotes for the specific RFQ
                        AND TQI.total_price > 0 
                        AND RFQ.reverse_auction = 1
                        AND (
                            (RFQ.bid_end_date IS NOT NULL AND RFQ.bid_end_date != '' 
                            AND CAST(RFQ.bid_end_date AS TIMESTAMP) <= (CURRENT_TIMESTAMP + interval '1 days'))
                        OR
                            (RFQ.bid_end_date IS NULL OR RFQ.bid_end_date = '' 
                            AND (CAST(RFQ.timestamp AS TIMESTAMP) + interval '1 days') <= CURRENT_TIMESTAMP)
                        )
                        ORDER BY TQI.total_price ASC  -- Get the lowest total_price
                        LIMIT 1  -- Limit to the lowest price for that product and variant
                    ),
                    `
                : ''
            }
          'vendor_details', (
            SELECT json_agg(json_build_object('id', RFQ_P_V.id, 'user_id', RFQ_P_V.user_id, 'variant', RFQ_P_V.variant,
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
            WHERE RFQ_P.product_id = RFQ_P_V.product_id AND RFQ_P.rfq_id = RFQ_P_V.rfq_id AND RFQ_P.variant = RFQ_P_V.variant
          )
        )
        FROM tbl_rfq_products RFQ_P        
        WHERE RFQ.id = RFQ_P.rfq_id
       
    ) AS "products"
    
FROM tbl_rfq RFQ WHERE id=${id}
ORDER BY RFQ.id DESC
LIMIT 1;`;


    // MODIFIED ON 23TH AUG MUKUL
    // modified query for veriants

    // MODIFIED ON 28TH MAY RANIT
    // ${
    //   user_type != 2
    //     ? `JOIN tbl_rfq_product_vendors trpv ON trpv.rfq_id = ${id} AND trpv.user_id = ${user_id} AND trpv.product_id = RFQ_P.product_id`
    //     : ``
    // }
    // WHERE RFQ.id = RFQ_P.rfq_id
    // ${
    //   user_type != 2
    //     ? `AND trpv.rfq_id = ${id} AND trpv.user_id = ${user_id} AND trpv.product_id = RFQ_P.product_id`
    //     : ``
    // }

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
  searchVendorWithoutLogin: async (
    search_key,
    category_id,
    approved_by_id,
    state,
    city
  ) => {

    // query changes by mukul jatav 30-08-2024,
    // include city and state name in response, left join of tbl_location_states and tbl_location_cities

    // Query to fetch the total count of vendors
    let countQuery = `
      WITH vendor_data AS (
        SELECT DISTINCT tu.id
        FROM tbl_product p
        JOIN tbl_product_categories pc ON p.id = pc.product_id
        JOIN tbl_category c ON pc.category_id = c.id
        JOIN tbl_users tu ON tu.id = p.created_by AND tu.user_type IN (3,4)
        LEFT JOIN tbl_company tc ON tc.user_id = tu.id
        ${approved_by_id != ''
            ? `JOIN tbl_vendorapprove_product_mapping vum ON p.id = vum.product_id `
            : ``
        }
        WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND tu.is_deleted = 0 AND tu.status = 1 AND p.name = '${search_key}'
        ${state != '' ? `AND tu.state = ${state}` : ``}
        ${city != '' ? `AND tu.city = ${city}` : ``}
        ${category_id != '' ? `AND c.id = ${category_id}` : ``}
        ${approved_by_id != ''
            ? `AND (vum.vendor_approve_id = ${approved_by_id} OR vum.vendor_approve_id IS NULL)`
            : ``
        }
      )
      SELECT COUNT(*) AS total FROM vendor_data;
    `;

    // Query to fetch only one vendor
    let dataQuery = `
    WITH vendor_data AS (
      SELECT DISTINCT tu.id, tu.name as vendor_name, tu.organization_name as company_name,
      tu.address, tc.profile as about, tc.website, tc.company_name, lc.city_name, ls.state_name,
      CASE
          WHEN tu.new_profile_image IS NULL THEN
          NULL
          ELSE tu.new_profile_image
      END AS image_url
      FROM tbl_product p
      JOIN tbl_product_categories pc ON p.id = pc.product_id
      JOIN tbl_category c ON pc.category_id = c.id
      JOIN tbl_users tu ON tu.id = p.created_by AND tu.user_type IN (3,4)
      LEFT JOIN tbl_company tc ON tc.user_id = tu.id
      LEFT JOIN tbl_location_cities lc ON tu.city = lc.id 
      LEFT JOIN tbl_location_states ls ON tu.state = ls.id 
      ${approved_by_id != ''
          ? `JOIN tbl_vendorapprove_product_mapping vum ON p.id = vum.product_id `
          : ``
      }
      WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND tu.is_deleted = 0 AND tu.status = 1 AND p.name = '${search_key}'
      ${state != '' ? `AND tu.state = ${state}` : ``}
      ${city != '' ? `AND tu.city = ${city}` : ``}
      ${category_id != '' ? `AND c.id = ${category_id}` : ``}
      ${approved_by_id != ''
          ? `AND (vum.vendor_approve_id = ${approved_by_id} OR vum.vendor_approve_id IS NULL)`
          : ``
      }
    )
    SELECT * FROM vendor_data ORDER BY RANDOM() LIMIT 1;
  `;



    try {
      // Execute the count query
      const countResult = await db.query(countQuery);
      const totalCount = countResult[0].total;

      // Execute the data query
      const dataResult = await db.query(dataQuery);
      console.log(dataResult);

      return {
        total: totalCount,
        vendor: dataResult.length > 0 ? dataResult[0] : null
      };
    } catch (err) {
      console.error('Error in searchVendor:', err);
      throw new Error(err);
    }
  },
  getUserProducts: async (rfq_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select DISTINCT product_id, variant from tbl_rfq_product_vendors where rfq_id = ${rfq_id} AND user_id=${user_id}`
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
  getAllBuyerRfq: async (limit, offset, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT RFQ.*,
            ARRAY(
              SELECT json_build_object('id', TQ.id ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id      
            ) AS "quotes",            
            ARRAY(
              SELECT json_build_object( 'total_vendors', COUNT(DISTINCT TRPV.user_id), 'quote_received', 
                (SELECT COUNT(DISTINCT TQ.created_by)
                FROM tbl_quotes TQ
                WHERE TQ.rfq_id = RFQ.id ) ) AS "vendors"
            FROM tbl_rfq_product_vendors TRPV
            WHERE TRPV.rfq_id = RFQ.id
            GROUP BY  TRPV.rfq_id ) AS "vendors",
            ARRAY(
                SELECT json_build_object('id', RFQ_P.id, 'product_id', RFQ_P.product_id,
                    'product_specs', (
                        SELECT json_agg(json_build_object('title', RFQ_P_SPEC.title, 'value', RFQ_P_SPEC.value, 'id', RFQ_P_SPEC.id, 'product_id', RFQ_P_SPEC.product_id, 'rfq_id', RFQ_P_SPEC.rfq_id))
                        FROM tbl_rfq_products_specs RFQ_P_SPEC
                        WHERE RFQ_P.product_id = RFQ_P_SPEC.product_id AND RFQ_P.rfq_id = RFQ_P_SPEC.rfq_id AND RFQ_P.variant = RFQ_P_SPEC.variant
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
                      WHERE RFQ_P.product_id = RFQ_P_V.product_id AND RFQ_P.rfq_id = RFQ_P_V.rfq_id AND RFQ_P.variant = RFQ_P_V.variant
                  )
                )
                FROM tbl_rfq_products RFQ_P
                WHERE RFQ.id = RFQ_P.rfq_id
            ) AS "products"
            
            FROM tbl_rfq RFQ WHERE created_by = ${user_id}
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
  getBuyerRfqCount: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(`select * from tbl_rfq where created_by = ${user_id}`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendors: async (vendors) => {
    const query = `SELECT 
    TU.id,
    TU.name,
    TU.email,
    TU.mobile,
    TU.address,
    TU.organization_name,
    ARRAY(
      SELECT json_build_object('id',TP.id, 'name',TP.name) FROM tbl_product TP WHERE TU.id = TP.created_by
    ) AS "products" FROM tbl_users TU WHERE id IN (${vendors.join(',')})`;
    console.log(query);
    return new Promise(function (resolve, reject) {
      db.any(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  checkIfExists: async (table_name, parameter) => {
    const query = `SELECT * FROM ${table_name} WHERE ${parameter}`;
    return new Promise(function (resolve, reject) {
      db.any(query)
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
                    SELECT json_agg(json_build_object('id', TU.id, 'name' , TU.name, 'email', TU.email,'mobile' , TU.mobile,'address' , TU.address,'organization_name' , TU.organization_name)) FROM tbl_users TU WHERE TU.id = TQ.created_by
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
  getQuotesByRfqByIdByProduct: async (id, user_id) => {
    return new Promise(function (resolve, reject) {

      // changes by Mukul Jatav 30/08/2024,
      // finding finalized_vendor for each product
      
      // Changes by Mukul Jatav, 30/09/2024,
      // Optimizing query to ensure matching product_id and variant across all sections.
      db.query(
        `SELECT TRP.product_id, TRP.variant, TRP.rfq_id,
          ARRAY(
            SELECT json_build_object('name', TP.name,'description', TP.description) FROM tbl_product TP WHERE TP.id = TRP.product_id 
          ) AS "product_details",
          ARRAY(
            SELECT json_build_object('id', TU.id, 'name', TU.name, 'email', TU.email, 'mobile', TU.mobile, 'address', TU.address, 'organization_name', TU.organization_name,
                'global_payment_term', (
                    SELECT json_agg(json_build_object('details', TQ_inner.global_payment_term,'comment', TQ_inner.global_comment))
                    FROM tbl_quotes TQ_inner
                     WHERE TQ_inner.rfq_id = TRP.rfq_id AND TQ_inner.created_by = TU.id
                )
            )
            FROM tbl_quotes TQ
            LEFT JOIN tbl_users TU ON TU.id = TQ.created_by
            WHERE TQ.rfq_id = TRP.rfq_id
            ORDER BY TU.id ASC
        ) AS "all_vendors",
          ARRAY(
            SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret,'global_payment_term', TQ.global_payment_term,'global_comment', TQ.global_comment, 
            'vendor_details', (              
                SELECT json_agg(json_build_object('id', TU.id, 'name' , TU.name, 'email', TU.email,'mobile' , TU.mobile,'address' , TU.address,'organization_name' , TU.organization_name)) FROM tbl_users TU WHERE TU.id = TQ.created_by
              ),
              'quote_details', (
                SELECT json_agg(json_build_object('product_id', TQI.product_id,'variant', TQI.variant,'product_name', TQI.product_name, 'unit_price', TQI.unit_price,'total_price', TQI.total_price, 'comment', TQI.comment, 'delivery_period', TQI.delivery_period,'package_price', TQI.package_price,'tax', TQI.tax,'freight_price', TQI.freight_price,'quantity',TQI.quantity,
                  'rfq_details', (
                    SELECT json_agg(json_build_object('title' , TPS.title, 'value' , TPS.value)) FROM tbl_rfq_products_specs TPS WHERE TPS.product_id = TQI.product_id AND TPS.variant = TQI.variant AND TPS.rfq_id = TRP.rfq_id
                  )    
                  )) FROM tbl_quote_items TQI WHERE TQI.quote_id = TQ.id AND TQI.product_id = TRP.product_id AND TQI.variant = TRP.variant
              ),
              'finalized_vendor', (
                  SELECT json_build_object('vendor_id', TQF.vendor_id, 'timestamp', TQF.timestamp) 
                  FROM tbl_quote_finalization TQF 
                WHERE TQF.product_id = TRP.product_id AND TQF.variant = TRP.variant AND TQF.rfq_id = TRP.rfq_id
              )
            )  FROM tbl_quotes TQ LEFT JOIN tbl_quote_items TQI ON TQI.quote_id = TQ.id WHERE TQ.rfq_id = TRP.rfq_id AND TQI.product_id = TRP.product_id AND TQI.variant = TRP.variant ORDER BY TQ.created_by ASC
          ) AS "quotations"
          
          FROM tbl_rfq_products TRP WHERE TRP.rfq_id=${id}`
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
  getQuotesByRfqById2: async (id, user_id) => {

      // Changes by Mukul Jatav, 30/09/2024,
      // Optimizing query to ensure matching product_id and variant across all sections.

    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT  TRF.* ,
        ARRAY(
          SELECT json_build_object('rfq_no', TR.rfq_no,'response_email', TR.response_email,'contact_name', TR.contact_name,'contact_number', TR.contact_number,'status', TR.status ) FROM tbl_rfq TR WHERE TR.id = ${id}      
        ) AS "rfq",
        ARRAY(
          SELECT json_build_object(              
              'product_name', TP.name ,
              'rfq_details', (
                  SELECT json_agg(json_build_object('title' , TPS.title, 'value' , TPS.value)) FROM tbl_rfq_products_specs TPS WHERE TPS.product_id = TRF.product_id AND TPS.variant = TRF.variant AND TPS.rfq_id = ${id}
              )     
          ) FROM tbl_product TP WHERE TP.id = TRF.product_id      
        ) AS "product_details",
          ARRAY(  
              SELECT json_build_object(
                'quote_id', TQI.quote_id,
                'unit_price', TQI.unit_price,
                'package_price', TQI.package_price,
                'tax', TQI.tax,
                'freight_price', TQI.freight_price,
                'total_price', TQI.total_price,
                'comment', TQI.comment,
                'delivery_period', TQI.delivery_period,  
                'quantity', TQI.quantity,
                'finalization',(
                  SELECT json_build_object('id', TQF.id, 'product_id',TQF.product_id, 'timestamp',TQF.timestamp, 
                  'winning_vendor', 
                    (
                      SELECT json_build_object('id', TUU.id, 'name' , TUU.name, 'email', TUU.email,'mobile' , TUU.mobile,'address' , TUU.address,'organization_name' , TUU.organization_name) FROM tbl_users TUU WHERE TUU.id = TQF.vendor_id
                    )
                  ) FROM tbl_quote_finalization TQF WHERE TQF.quote_id = TQI.quote_id AND TQF.product_id = TQI.product_id AND TQF.variant = TQI.variant
                ),              
                'quote_details', (
                  SELECT json_build_object('status' , TQ.status, 'created_by' , TQ.created_by,'is_regret', TQ.is_regret,
                  
                  'vendor_details', (
                      SELECT json_build_object('id', TU.id, 'name' , TU.name, 'email', TU.email,'mobile' , TU.mobile,'address' , TU.address,'organization_name' , TU.organization_name) FROM tbl_users TU WHERE TU.id = TQ.created_by
                  )                  
                  ) FROM tbl_quotes TQ WHERE TQ.id = TQI.quote_id AND TQ.rfq_id = ${id}
                ),      
                'previous_quotes', (
              SELECT json_agg(json_build_object(
                'id', TH.id,
                'quote_item_id', TH.quote_item_id,
                'rfq_id', TH.rfq_id,
                'product_id', TH.product_id,
                'unit_price', TH.unit_price,
                'package_price', TH.package_price,
                'tax', TH.tax,
                'freight_price', TH.freight_price,
                'total_price', TH.total_price,
                'comment', TH.comment,
                'delivery_period', TH.delivery_period,
                'quantity', TH.quantity,
                'variant', TH.variant,
                'timestamp', TH.timestamp
              ) ORDER BY TH.timestamp DESC)  -- Sorting by timestamp descending
              FROM tbl_quote_item_history TH
              WHERE TH.quote_item_id = TQI.id
            )   
          ) FROM tbl_quote_items TQI WHERE TQI.rfq_id = ${id} AND TQI.product_id = TRF.product_id AND TQI.variant = TRF.variant
          
        ) AS "quotations"
        FROM tbl_rfq_products TRF WHERE TRF.rfq_id = ${id}`
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
  changeRFQStatus: async (id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `UPDATE tbl_rfq
        SET status = ${parseInt(2)}, updated_by = ${user_id}
        WHERE id=${id} RETURNING *`
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
        `SELECT DISTINCT  user_id FROM "tbl_rfq_product_vendors" WHERE "rfq_id" = ${id} `
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
      db.query(`SELECT created_by  FROM "tbl_quotes" WHERE "rfq_id" = ${id}`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getRFQCreatedBy: async (id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT tbl_users.name,tbl_users.email,tbl_users.organization_name
        FROM tbl_rfq
        LEFT JOIN tbl_users ON tbl_rfq.created_by = tbl_users.id
        WHERE tbl_rfq.id = ${id}`
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
  getRFQActivity: async (rfq_id, user_id) => {
    try {
      const result = await db.query(
        `SELECT *
         FROM tbl_rfq_activity
         WHERE rfq_id = ${rfq_id} AND user_id = ${user_id}`
      );
      return result;

    } catch (error) {
      throw new Error(error);
    }
  },

  // function created by Imtiaj for updating RFQ activity 20/09/2024
  updateRFQActivity: async (rfq_id, user_id, rfq_activity_id) => {
    try {
      if (!rfq_activity_id) {
        //insert new data
        const insertQuery = `
          INSERT INTO tbl_rfq_activity (rfq_id, user_id, last_reminder_sent)
          VALUES ($1, $2, CURRENT_TIMESTAMP)
          RETURNING *;
        `;
        await db.query(insertQuery, [rfq_id, user_id]);
      } 
      else {
        // update existing row
        const updateQuery = `
        UPDATE tbl_rfq_activity
        SET last_reminder_sent = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
        await db.query(updateQuery, [rfq_activity_id]);
      }
    } catch (error) {
      throw new Error(error);
    }
  },

  searchProduct: async (search_key, category_id, approved_by_id) => {
    // query change by mukul 28-08-2024
    // query change by mukul 08-09-2024, added one more filter for created by 1 or 111 to exclude product for them
    let q = `
      SELECT DISTINCT p.id AS product_id,
                      p.name AS product_name,
                      p.description,
                      p.slug AS slug,
                      c.title AS category_name,
                      c.id AS category_id,
                      c.parent_id AS parent_category_id,
                      CASE WHEN p.tds_new_file_name IS NULL THEN NULL ELSE p.tds_new_file_name END AS pd_tds_file_url,
                      CASE WHEN p.qap_new_file_name IS NULL THEN NULL ELSE p.qap_new_file_name END AS pd_qap_file_url,
                      img.new_image_name AS image_url,
                      similarity(p.name, $1) AS similarity_score,
                      ts_rank_cd(to_tsvector('english', p.name), plainto_tsquery('english', $1)) AS rank
      FROM tbl_product p
      JOIN tbl_product_categories pc ON p.id = pc.product_id
      LEFT JOIN tbl_product_images img ON p.id = img.product_id
      JOIN tbl_category c ON pc.category_id = c.id
      JOIN tbl_users u ON u.id = p.created_by
      ${approved_by_id ? `JOIN tbl_vendorapprove_product_mapping vum ON p.id = vum.product_id` : ``}
      WHERE p.status = 1 
        AND p.is_deleted = 0 
        AND p.is_review = 0 
        AND p.is_approve = 1 
        AND p.created_by NOT IN (1, 111) 
        AND u.is_deleted = 0 
        AND u.status = 1 
        AND (
          to_tsvector('english', p.name) @@ plainto_tsquery('english', $1) 
          OR similarity(p.name, $1) > 0.1
        )
        ${category_id ? `AND c.id = $2` : ``}
        ${approved_by_id ? `AND (vum.vendor_approve_id = $3 OR vum.vendor_approve_id IS NULL)` : ``}
      ORDER BY rank DESC, similarity_score DESC, p.name ASC;`;

    console.log('QUERY======', q);

    // Assuming db.query can handle parameterized queries:
    return new Promise(function (resolve, reject) {
      db.query(q, [search_key, category_id, approved_by_id].filter(Boolean)) // Filters out any undefined or empty values
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
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
    const categoryIds = categories.map((category)=> category.id);

    const q = `
WITH RankedProducts AS (
    SELECT 
        p.id AS product_id,
        p.name AS product_name,
        p.description,
        pc.category_name AS category_name,
        pc.category_id AS category_id,
        CASE WHEN p.tds_new_file_name IS NULL THEN NULL ELSE p.tds_new_file_name END AS pd_tds_file_url,
        CASE WHEN p.qap_new_file_name IS NULL THEN NULL ELSE p.qap_new_file_name END AS pd_qap_file_url,
        -- Generate a row number for each unique product name within each category,
        -- but also treat same product ID across categories as a single entry
        ROW_NUMBER() OVER (
            PARTITION BY p.name, pc.category_id 
            ORDER BY p.id
        ) AS row_num_by_name_category,
        ROW_NUMBER() OVER (
            PARTITION BY p.id
            ORDER BY pc.category_id
        ) AS row_num_by_id
    FROM tbl_product p
    INNER JOIN tbl_product_categories pc ON p.id = pc.product_id
    WHERE pc.category_id IN ($1:csv)  -- Dynamically insert the list of category IDs
      AND p.status = 1 
      AND p.is_deleted = 0 
      AND p.is_review = 0 
      AND p.is_approve = 1
      AND p.created_by NOT IN (1, 111)  -- Exclude specific creators
)
SELECT 
    product_id, product_name, description, category_name, category_id, pd_tds_file_url, pd_qap_file_url
FROM RankedProducts
WHERE row_num_by_name_category = 1
  AND row_num_by_id = 1;  -- Ensure unique products both by ID and by name/category combination
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
  }
  ,
  searchVendor: async (
    buyerId,
    search_key,
    category_id,
    approved_by_id,
    state,
    city
  ) => {
    // query changes by mukul jatav30-08-2024,
    // include city and state name in response, left join of tbl_location_states and tbl_location_cities
    let q = `
SELECT * FROM (
    SELECT DISTINCT tu.id, tu.name as vendor_name, tu.email, tu.mobile, tu.organization_name as company_name,
           tu.address, tc.profile as about, tc.website, tc.company_name, lc.city_name, ls.state_name,
           CASE
               WHEN tu.new_profile_image IS NULL THEN NULL
               ELSE tu.new_profile_image
           END AS image_url,
           CASE
               WHEN bvm.vendor_id IS NOT NULL THEN 1
               ELSE 0
           END AS is_linked_with_buyer
    FROM tbl_product p
    JOIN tbl_product_categories pc ON p.id = pc.product_id
    JOIN tbl_category c ON pc.category_id = c.id
    JOIN tbl_users tu ON tu.id = p.created_by AND tu.user_type IN (3, 4)
    LEFT JOIN tbl_company tc ON tc.user_id = tu.id
    LEFT JOIN tbl_buyer_private_vendors_mapping bvm ON tu.id = bvm.vendor_id AND bvm.buyer_id = ${buyerId}
    LEFT JOIN tbl_location_cities lc ON tu.city = lc.id
    LEFT JOIN tbl_location_states ls ON tu.state = ls.id
    ${approved_by_id != '' ? `JOIN tbl_vendorapprove_product_mapping vum ON p.id = vum.product_id` : ``}
    WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND tu.is_deleted = 0 AND tu.status = 1 
      AND p.name = '${search_key}' AND tu.email IS NOT NULL
      ${state != '' ? `AND tu.state = ${state}` : ``}
      ${city != '' ? `AND tu.city = ${city}` : ``}
      ${category_id != '' ? `AND c.id = ${category_id}` : ``}
      ${approved_by_id != '' ? `AND (vum.vendor_approve_id = ${approved_by_id} OR vum.vendor_approve_id IS NULL)` : ``}
) AS distinct_vendors
ORDER BY is_linked_with_buyer DESC, RANDOM();
    `;


    console.log('QUERY======', q);

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
  getVendorApprovedBy: async (user_id) => {
    let q = `SELECT tbl_vendor_approve.id, tbl_vendor_approve.vendor_approve as vendor_approve
    FROM tbl_vendorapprove_user_mapping
    LEFT JOIN tbl_vendor_approve on tbl_vendor_approve.id = tbl_vendorapprove_user_mapping.vendor_approve_id
    WHERE user_id = ${user_id}`;

    console.log('QUERY======', q);

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
        `SELECT tbl_rfq.id,tbl_rfq.rfq_no, tbl_quote_finalization.rfq_id,tbl_quote_finalization.vendor_id,tbl_quote_finalization.product_id, tbl_product.name
        FROM tbl_rfq
        LEFT JOIN tbl_quote_finalization ON tbl_rfq.id = tbl_quote_finalization.rfq_id
        LEFT JOIN tbl_product ON tbl_quote_finalization.product_id = tbl_product.id
        WHERE tbl_rfq.created_by = ${user_id} AND tbl_quote_finalization.vendor_id = ${vendor_id};`
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
            console.log('stateResult:', stateResult); // Log stateResult to inspect its structure
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
        `SELECT * FROM "tbl_rfq_product_vendors" WHERE "rfq_id" = ${rfq_id} AND "user_id" = ${user_id}`
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
      dynamicWhere = `WHERE status = 1`;
    }
    const query = `SELECT count(id) FROM tbl_rfq ${dynamicWhere}`;
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
        `SELECT DISTINCT rfq_id FROM tbl_rfq_product_vendors WHERE user_id = $1`,
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
        left join tbl_rfq on tbl_rfq.id = tbl_rfq_product_vendors.rfq_id WHERE user_id = $1 and tbl_rfq.status = 2`,
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
  getAllRfqByUser: async (user_id, status) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT count(id) FROM tbl_rfq WHERE created_by = $1 AND status = $2`,
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
  getPendingResponseCount: async (user_id, status) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT count(*) FROM "tbl_rfq" tr JOIN "tbl_quotes" tq on tr.id = tq.rfq_id where tr.created_by = $1 and tr.status = $2 and tr.id = tq.rfq_id`,
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
WHERE created_by = $1 AND status = $2`,
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
        `SELECT  tr.id, tr.rfq_no , tq.timestamp as timestamp, tq.created_by FROM "tbl_rfq" tr
      LEFT JOIN "tbl_quotes" tq ON tr.id = tq.rfq_id      
      WHERE tr.created_by = $1 AND tr.status = '1' ORDER BY "id" DESC LIMIT 50`,
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
        if (err.code === '23505') { // PostgreSQL unique violation error code
          // Retry with a new token if there is a token collision
          continue;
        }
        // Throw other errors
        throw err;
      }
    }

    return token; // Return the successfully inserted token
  },
  updateQuoteItemWithHistory: async (quoteId, product) => {
    return new Promise(async (resolve, reject) => {
      try {
        // Fetch existing quote item only if there are differences in specified fields
        const existingItemQuery = `
     SELECT * FROM tbl_quote_items
     WHERE quote_id = $1 AND product_id = $2 AND variant = $3
       AND (unit_price != $4 OR package_price != $5 OR tax != $6 OR freight_price != $7 OR total_price != $8 OR comment != $9 OR delivery_period != $10)
   `;
        const result = await db.query(existingItemQuery, [
          quoteId,
          product.product_id,
          product.variant,
          product.unit_price,
          product.package_price,
          product.tax,
          product.freight_price,
          product.total_price,
          product.comment,
          product.delivery_period
        ]);
        const item = result[0];

        if (item) {
          // Move existing quote to quote history table
          const insertHistoryQuery = `INSERT INTO tbl_quote_item_history 
                  (quote_item_id, rfq_id, product_id, unit_price, package_price, tax, freight_price, total_price,
                   comment, delivery_period, quantity, variant, timestamp)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`;
          await db.query(insertHistoryQuery, [
            item.id,
            item.rfq_id,
            item.product_id,
            item.unit_price,
            item.package_price,
            item.tax,
            item.freight_price,
            item.total_price,
            item.comment,
            item.delivery_period,
            item.quantity,
            item.variant
          ]);

          // Update existing item with new data
          const updateQuery = `UPDATE tbl_quote_items SET 
                  unit_price = $1, package_price = $2, tax = $3, freight_price = $4, 
                  total_price = $5, comment = $6, delivery_period = $7
                  WHERE id = $8 RETURNING *`;
          const updatedItem = await db.query(updateQuery, [
            product.unit_price,
            product.package_price,
            product.tax,
            product.freight_price,
            product.total_price,
            product.comment,
            product.delivery_period,
            item.id
          ]);

          // quote updated message
          resolve({
            quote: { product_name:updatedItem[0].product_name, product:updatedItem[0].variant },
            changed:true,
            message: 'Quote successfully updated with the latest changes.'
          });
        } else {
          // no need to make any changes
          resolve({
            quote: { product_name:product.product_name, product:product.variant },
            changed:false,
            message: 'No updates made as the quote remains unchanged'
          });
        }
      } catch (error) {
        console.error('Error in updateQuoteItemWithHistory:', error);
        reject(error);
      }
    });
  },
  productPriceStats: async (product_name, user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(`
        WITH ProductPriceStats AS (
           SELECT 
             MIN(qi.unit_price) AS min_price,
             MAX(qi.unit_price) AS max_price,
             AVG(qi.unit_price) AS avg_price
           FROM tbl_product AS p
           JOIN tbl_quote_items AS qi ON p.id = qi.product_id
           WHERE p.name = $1
         ), RFQDetails AS (
           SELECT
             r.id AS rfq_id
           FROM tbl_rfq AS r
           WHERE r.created_by = $2
         ), QuoteDetails AS (
           SELECT
             qi.product_id,
             qi.unit_price,
             qi.quantity,
             q.timestamp AS last_quote_timestamp
           FROM tbl_quote_items AS qi
           JOIN RFQDetails ON qi.rfq_id = RFQDetails.rfq_id
           JOIN tbl_product AS p ON p.id = qi.product_id
           JOIN tbl_quotes AS q ON q.rfq_id = qi.rfq_id
           WHERE p.name = $1
           ORDER BY q.timestamp DESC
           LIMIT 1
         ), PriceHistory AS (
           SELECT
             qi.unit_price,
             CAST(q.timestamp AS BIGINT) AS numeric_timestamp,
             EXTRACT(YEAR FROM to_timestamp(CAST(q.timestamp AS BIGINT) / 1000)) AS year,
             EXTRACT(MONTH FROM to_timestamp(CAST(q.timestamp AS BIGINT) / 1000)) AS month
           FROM tbl_quote_items AS qi
           JOIN tbl_product AS p ON p.id = qi.product_id
           JOIN tbl_quotes AS q ON qi.rfq_id = q.rfq_id
           WHERE p.name = $1 AND CAST(q.timestamp AS BIGINT) >= EXTRACT(EPOCH FROM NOW() - INTERVAL '12 months') * 1000
         ), MonthlyPriceStats AS (
           SELECT
             MIN(unit_price) AS min_price,
             AVG(unit_price) AS avg_price,
             MAX(unit_price) AS max_price,
             year,
             month
           FROM PriceHistory
           GROUP BY year, month
           ORDER BY year, month
         )
         SELECT 
           pps.min_price,
           pps.max_price,
           pps.avg_price,
           qd.product_id,
           qd.unit_price AS last_purchase_price,
           qd.quantity AS last_purchase_quantity,
           qd.last_quote_timestamp AS last_purchase_date,
           JSON_AGG(JSON_BUILD_OBJECT('min', mp.min_price, 'avg', mp.avg_price, 'max', mp.max_price, 'month', mp.month, 'year', mp.year)) AS monthly_price_stats
         FROM ProductPriceStats AS pps
         CROSS JOIN QuoteDetails AS qd
         CROSS JOIN MonthlyPriceStats AS mp
         GROUP BY pps.min_price, pps.max_price, pps.avg_price, qd.product_id, qd.unit_price, qd.quantity, qd.last_quote_timestamp`,
        [product_name, user_id]
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
  rfq_project_exist: async (project_id,user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT 1 
        FROM tbl_rfq 
        WHERE project_id = ${project_id} 
        AND created_by = ${user_id};`
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
  getVendorRfqCount: async(user_id)=>{
    return new Promise((resolve, reject) => {
      db.one(
        `SELECT COUNT(DISTINCT rfq_id)
         FROM tbl_rfq_product_vendors
         WHERE user_id = $1`, // Matching user_id in tbl_rfq_product_vendors
        [user_id]
      )
      .then(function (data) {
        resolve(data);
      })
      .catch(function (err) {
        let error = new Error(err);
        reject(error);
      });
    })
  }
};

export default rfqModel;
