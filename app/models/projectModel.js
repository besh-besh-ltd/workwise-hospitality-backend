import db, { pgp } from '../config/dbConn.js';

const projectModel = {
    create_project: async (projectObj) => {
        console.log(projectObj);
        return new Promise(function (resolve, reject) {
            db.any(
                `INSERT INTO tbl_projects(name, description, location, ended_at, user_id)
                 VALUES($1, $2, $3, $4, $5)`,
                 [
                    projectObj.name,
                    projectObj.description,
                    projectObj.location,
                    projectObj.ended_at,
                    projectObj.user_id
                 ]
            )
                .then(function (data) {
                resolve(data);
              })
               .catch(function (err) {
                let error = new Error(err);
                reject(error);
              });
        })
    },
    project_exist: async (name,user_id) => {
        return new Promise(function (resolve, reject) {
            db.any(
                `SELECT 1 
                FROM tbl_projects 
                WHERE name = $1 
                AND user_id = $2`,
                 [
                    name,
                    user_id
                 ]
            )
                .then(function (data) {
                resolve(data);
              })
               .catch(function (err) {
                let error = new Error(err);
                reject(error);
              });
        })
    },
    getProjectById: async (project_id,user_id,limit,offset) => {
        return new Promise(function (resolve, reject) {
                db.any(
                    `SELECT 
        p.*, 
        -- Aggregated RFQ counts
        COUNT(r.id) AS total_rfqs,
        COUNT(CASE WHEN r.status = 0 THEN 1 END) AS closed_rfqs,
        COUNT(CASE WHEN r.status = 1 THEN 1 END) AS open_rfqs,

        -- Fetch RFQ details with quotes, products, vendors
        ARRAY(
            SELECT json_build_object(
              'rfq_id', r.id,
              'status', r.status,
              'quotes', (
                SELECT json_agg(json_build_object('id', tq.id))
                FROM tbl_quotes tq
                WHERE tq.rfq_id = r.id
              ),
              'vendors', (
                SELECT json_build_object(
                  'total_vendors', COUNT(DISTINCT trpv.user_id),
                  'quote_received', (
                    SELECT COUNT(DISTINCT tq.created_by)
                    FROM tbl_quotes tq
                    WHERE tq.rfq_id = r.id
                  )
                )
                FROM tbl_rfq_product_vendors trpv
                WHERE trpv.rfq_id = r.id
                GROUP BY trpv.rfq_id
              ),
              'products', (
                SELECT json_agg(json_build_object(
                  'id', rfq_p.id, 
                  'product_id', rfq_p.product_id,
                  'product_specs', (
                    SELECT json_agg(json_build_object(
                      'title', rfq_p_spec.title, 
                      'value', rfq_p_spec.value, 
                      'id', rfq_p_spec.id, 
                      'product_id', rfq_p_spec.product_id, 
                      'rfq_id', rfq_p_spec.rfq_id
                    ))
                    FROM tbl_rfq_products_specs rfq_p_spec
                    WHERE rfq_p.product_id = rfq_p_spec.product_id 
                      AND rfq_p.rfq_id = rfq_p_spec.rfq_id 
                      AND rfq_p.variant = rfq_p_spec.variant
                  ),
                  'product_details', (
                    SELECT json_agg(json_build_object(
                      'id', tp.id,
                      'name', tp.name,
                      'description', tp.description,
                      'manufacturer', tp.manufacturer,
                      'availability', tp.availability
                    ))
                    FROM tbl_product tp
                    WHERE rfq_p.product_id = tp.id
                  ),
                  'vendor_details', (
                    SELECT json_agg(json_build_object(
                      'id', rfq_p_v.id, 
                      'user_id', rfq_p_v.user_id,
                      'user_details', (
                        SELECT json_build_object(
                          'user_id', u.id,
                          'name', u.name,
                          'email', u.email
                        )
                        FROM tbl_users u
                        WHERE rfq_p_v.user_id = u.id
                      )
                    ))
                    FROM tbl_rfq_product_vendors rfq_p_v
                    WHERE rfq_p.product_id = rfq_p_v.product_id 
                      AND rfq_p.rfq_id = rfq_p_v.rfq_id 
                      AND rfq_p.variant = rfq_p_v.variant
                  )
                ))
                FROM tbl_rfq_products rfq_p
                WHERE r.id = rfq_p.rfq_id
              )
            )
            FROM tbl_rfq r
            WHERE r.project_id = p.id
            ORDER BY r.id DESC
            LIMIT ${limit} OFFSET ${offset}
        ) AS rfqs

    FROM 
        tbl_projects p
    LEFT JOIN 
        tbl_rfq r ON r.project_id = p.id
    WHERE 
        p.id = $1
        AND p.user_id = $2
    GROUP BY 
        p.id
  `,
  [project_id, user_id]

            )
                .then(function (data) {
                resolve(data);
              })
               .catch(function (err) {
                let error = new Error(err);
                reject(error);
              });
        })
    },
    getAllProjects: async (user_id) => {
        return new Promise(function (resolve, reject) {
            db.any(
                `SELECT 
                    p.*, 
                    COUNT(r.id) AS total_rfqs,

                    COUNT(CASE WHEN r.status = 0 THEN 1 END) AS closed_rfqs,

                    COUNT(CASE WHEN r.status = 1 THEN 1 END) AS open_rfqs
                FROM 
                    tbl_projects p
                LEFT JOIN 
                    tbl_rfq r ON r.project_id = p.id 
                WHERE 
                    p.user_id = ${user_id}
                GROUP BY 
                    p.id
                ORDER BY 
                    p.id`,
            )
                .then(function (data) {
                resolve(data);
              })
               .catch(function (err) {
                let error = new Error(err);
                reject(error);
              });
        })
    },
}
export default projectModel;