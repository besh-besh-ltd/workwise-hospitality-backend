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
            ) AS "products"
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
    let q = `SELECT RFQ.*,
    ARRAY(
      SELECT json_build_object('id', TQF.id,'product_id',TQF.product_id, 'timestamp',TQF.timestamp,
      'winning_vendor', 
        (
          SELECT json_build_object('id', TUU.id, 'name' , TUU.name, 'email', TUU.email,'mobile' , TUU.mobile,'address' , TUU.address,'organization_name' , TUU.organization_name) FROM tbl_users TUU WHERE TUU.id = TQF.vendor_id
        ),
      'product_details', (
          SELECT json_build_object('id', TPP.id,'name', TPP.name, 'description', TPP.description, 'manufacturer', TPP.manufacturer, 'availability', TPP.availability, 'description', TPP.description ) FROM tbl_product TPP WHERE TPP.id = TQF.product_id
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
        SELECT json_agg(json_build_object('product_id', TQI.product_id,'product_name', TQI.product_name,'unit_price', TQI.unit_price,'package_price', TQI.package_price,'tax', TQI.tax,'freight_price', TQI.freight_price,'total_price', TQI.total_price,'comment', TQI.comment,'delivery_period', TQI.delivery_period))
        FROM tbl_quote_items TQI
        WHERE CAST(TQ.id AS INTEGER) = TQI.quote_id
    )
      ) FROM tbl_quotes TQ WHERE TQ.rfq_id = RFQ.id AND TQ.created_by = ${user_id}
    ) AS "quotations",
    ARRAY(
        SELECT json_build_object('id', RFQ_P.id, 'product_id', RFQ_P.product_id, 'comment', RFQ_P.comment, 'spec_file', RFQ_P.spec_file,'qap', RFQ_P.qap, 'qap_file', RFQ_P.qap_file,'datasheet_file', RFQ_P.datasheet_file,
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
                SELECT json_agg(json_build_object('title', RFQ_P_SPEC.title, 'value', RFQ_P_SPEC.value, 'id', RFQ_P_SPEC.id, 'product_id', RFQ_P_SPEC.product_id, 'rfq_id', RFQ_P_SPEC.rfq_id))
                FROM tbl_rfq_products_specs RFQ_P_SPEC
                WHERE RFQ_P.product_id = RFQ_P_SPEC.product_id AND RFQ_P.rfq_id = RFQ_P_SPEC.rfq_id
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
    
    FROM tbl_rfq RFQ WHERE id=${id}
    ORDER BY RFQ.id DESC
    LIMIT 1;`;

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
  getUserProducts: async (rfq_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select DISTINCT product_id from tbl_rfq_product_vendors where rfq_id = ${rfq_id} AND user_id=${user_id}`
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
              SELECT 
              json_build_object(
                  'total_vendors',  COUNT(TRPV.*),
                  'quote_received', (
                      SELECT total_vendors_applied
                      FROM (
                          SELECT COUNT(TQ.*) AS total_vendors_applied
                          FROM tbl_quotes TQ 
                          WHERE TQ.rfq_id = RFQ.id
                      ) AS subquery
                  )
              ) AS "vendors"
          FROM 
              tbl_rfq_product_vendors TRPV 
          WHERE 
              TRPV.rfq_id = RFQ.id   
            ) AS "vendors",
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
      db.query(
        `SELECT TRP.product_id, TRP.rfq_id,
          ARRAY(
            SELECT json_build_object('name', TP.name,'description', TP.description) FROM tbl_product TP WHERE TP.id = TRP.product_id 
          ) AS "product_details",
          ARRAY(
            SELECT json_build_object('id', TU.id, 'name', TU.name, 'email', TU.email, 'mobile', TU.mobile, 'address', TU.address, 'organization_name', TU.organization_name,
                'global_payment_term', (
                    SELECT json_agg(json_build_object('details', TQ_inner.global_payment_term,'comment', TQ_inner.global_comment))
                    FROM tbl_quotes TQ_inner
                    LEFT JOIN tbl_users TU_inner ON TU_inner.id = TQ_inner.created_by
                    WHERE TQ_inner.rfq_id = ${id} AND TQ_inner.created_by = TU.id
                )
            )
            FROM tbl_quotes TQ
            LEFT JOIN tbl_users TU ON TU.id = TQ.created_by
            WHERE TQ.rfq_id = ${id}
            ORDER BY TU.id ASC
        ) AS "all_vendors",
          ARRAY(
            SELECT json_build_object('id', TQ.id, 'timestamp', TQ.timestamp, 'status', TQ.status, 'created_by', TQ.created_by,'is_regret', TQ.is_regret,'global_payment_term', TQ.global_payment_term,'global_comment', TQ.global_comment, 
            'vendor_details', (              
                SELECT json_agg(json_build_object('id', TU.id, 'name' , TU.name, 'email', TU.email,'mobile' , TU.mobile,'address' , TU.address,'organization_name' , TU.organization_name)) FROM tbl_users TU WHERE TU.id = TQ.created_by
              ),
              'quote_details', (
                  SELECT json_agg(json_build_object('product_id', TQI.product_id,'product_name', TQI.product_name, 'unit_price', TQI.unit_price,'total_price', TQI.total_price, 'comment', TQI.comment, 'delivery_period', TQI.delivery_period,'package_price', TQI.package_price,'tax', TQI.tax,'freight_price', TQI.freight_price,'comment', TQI.comment,'quantity',TQI.quantity,
                  'rfq_details', (
                      SELECT json_agg(json_build_object('title' , TPS.title, 'value' , TPS.value)) FROM tbl_rfq_products_specs TPS WHERE TPS.product_id = TQI.product_id AND TPS.rfq_id = ${id}
                  )    
                  )) FROM tbl_quote_items TQI WHERE CAST(TQ.id AS INTEGER) = TQI.quote_id AND TQI.product_id = TRP.product_id
              )  
            )  FROM tbl_quotes TQ LEFT JOIN tbl_quote_items TQI ON TQI.quote_id = TQ.id WHERE TQ.rfq_id = ${id} AND TQI.product_id = TRP.product_id ORDER BY TQ.created_by ASC
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
                  SELECT json_agg(json_build_object('title' , TPS.title, 'value' , TPS.value)) FROM tbl_rfq_products_specs TPS WHERE TPS.product_id = TRF.product_id AND TPS.rfq_id = ${id}
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
                  ) FROM tbl_quote_finalization TQF WHERE TQF.quote_id = TQI.quote_id AND TQF.product_id = TQI.product_id
                ),              
                'quote_details', (
                  SELECT json_build_object('status' , TQ.status, 'created_by' , TQ.created_by,'is_regret', TQ.is_regret,
                  
                  'vendor_details', (
                      SELECT json_build_object('id', TU.id, 'name' , TU.name, 'email', TU.email,'mobile' , TU.mobile,'address' , TU.address,'organization_name' , TU.organization_name) FROM tbl_users TU WHERE TU.id = TQ.created_by
                  )                  
                  ) FROM tbl_quotes TQ WHERE TQ.id = TQI.quote_id AND TQ.rfq_id = ${id}
                )      
          ) FROM tbl_quote_items TQI WHERE TQI.rfq_id = ${id} AND TQI.product_id = TRF.product_id ORDER BY TQI.total_price ASC
          
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
        `SELECT user_id FROM "tbl_rfq_product_vendors" WHERE "rfq_id" = ${id}`
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
  searchProduct: async (search_key, category_id, approved_by_id) => {
    let q = `SELECT DISTINCT p.id as product_id, p.name as product_name,p.description, c.title as category_name,c.id as category_id,
        CASE
        WHEN p.tds_new_file_name IS NULL THEN NULL
        ELSE p.tds_new_file_name END AS pd_tds_file_url,
        CASE
        WHEN p.qap_new_file_name IS NULL THEN NULL
        ELSE p.qap_new_file_name END AS pd_qap_file_url ,
        img.new_image_name AS image_url
        FROM tbl_product p
    ${`JOIN tbl_product_categories pc ON p.id = pc.product_id`}
    ${`JOIN tbl_product_images img ON p.id = img.product_id AND img.is_featured = 1`}
    ${`JOIN tbl_category c ON pc.category_id = c.id`}
    ${`JOIN tbl_users u ON u.id = p.created_by`}
    ${
      approved_by_id != ''
        ? `JOIN tbl_vendorapprove_product_mapping vum ON p.id = vum.product_id `
        : ``
    }
    WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve =1 AND u.is_deleted = 0 AND u.status = 1 AND p.name ILIKE '%${search_key}%'
    ${category_id != '' ? `AND c.id = ${category_id}` : ``}
    ${
      approved_by_id != ''
        ? `AND (vum.vendor_approve_id = ${approved_by_id} OR vum.vendor_approve_id IS NULL)`
        : ``
    }
     ORDER BY p.name ASC;`;

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
  searchVendor: async (
    search_key,
    category_id,
    approved_by_id,
    state,
    city
  ) => {
    let q = `SELECT DISTINCT tu.id, tu.name as vendor_name, tu.email, tu.mobile, tu.organization_name as company_name,tu.address,tc.profile as about, tc.website,tc.company_name,
    CASE
        WHEN tu.new_profile_image IS NULL THEN
        NULL
        ELSE tu.new_profile_image
        END AS image_url
    FROM tbl_product p
    ${`JOIN tbl_product_categories pc ON p.id = pc.product_id`}
    ${`JOIN tbl_category c ON pc.category_id = c.id`}
    ${`JOIN tbl_users tu ON tu.id = p.created_by AND tu.user_type IN (3,4)`}
    LEFT JOIN tbl_company tc ON tc.user_id = tu.id
    ${
      approved_by_id != ''
        ? `JOIN tbl_vendorapprove_product_mapping vum ON p.id = vum.product_id `
        : ``
    }
    WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND tu.is_deleted = 0 AND tu.status = 1 AND p.name ILIKE '%${search_key}%'
    AND tu.email IS NOT NULL
    /*AND tu.organization_name IS NOT NULL*/
    ${state != '' ? `AND tu.state = ${state}` : ``}
    ${city != '' ? `AND tu.city = ${city}` : ``}
    ${category_id != '' ? `AND c.id = ${category_id}` : ``}
    ${
      approved_by_id != ''
        ? `AND (vum.vendor_approve_id = ${approved_by_id} OR vum.vendor_approve_id IS NULL)`
        : ``
    }
     ORDER BY tu.name ASC;`;

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
  }
};

export default rfqModel;
