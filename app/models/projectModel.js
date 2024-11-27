import db, { pgp } from '../config/dbConn.js';

const projectModel = {
    createProject: async (projectObj) => {
        console.log(projectObj);
        return new Promise(function (resolve, reject) {
            db.any(
                `INSERT INTO tbl_projects(name, description, location, ended_at, user_id, rfq_type, reverse_auction)
                 VALUES($1, $2, $3, $4, $5, $6, $7)`,
                 [
                    projectObj.name,
                    projectObj.description,
                    projectObj.location,
                    projectObj.ended_at,
                    projectObj.user_id,
                    projectObj.rfq_type,
                    projectObj.reverse_auction
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
    projectExist: async (name,user_id) => {
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

    getProjectTableDataById: async (project_id, user_id) => {
        return new Promise(function (resolve, reject) {
                db.any(`
                    SELECT t.* 
                    FROM tbl_projects t
                    WHERE t.id = $1 AND t.user_id = $2;
                `,
              [project_id, user_id]
            )
                .then(function (data) {
                    console.log("data: ", data)
                resolve(data);
              })
               .catch(function (err) {
                let error = new Error(err);
                console.log("error: ", error)
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

                -- Fetch RFQ details with vendors, number of products and quotes, including all RFQ columns
                ARRAY(
                    SELECT json_build_object(
                        -- Fetch all columns of tbl_rfq
                        'rfq_details', row_to_json(r),
                        'no_of_quotes', (
                            SELECT COUNT(*)
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
                        'no_of_products', (
                            SELECT COUNT(*)
                            FROM tbl_rfq_products rfq_p
                            WHERE rfq_p.rfq_id = r.id
                        )
                    )
                    FROM tbl_rfq r
                    WHERE r.project_id = p.id
                    ORDER BY r.timestamp DESC
                    LIMIT $3 OFFSET $4
                ) AS rfqs

            FROM 
                tbl_projects p
            LEFT JOIN 
                tbl_rfq r ON r.project_id = p.id
            WHERE 
                p.id = $1
                AND p.user_id = $2
            GROUP BY 
                p.id;
              `,
              [project_id, user_id, limit, offset]

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
                    p.created_at DESC`,
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

    updateProject: async (projectObj) => {
      console.log(projectObj);
      return new Promise(function (resolve, reject) {
          db.oneOrNone(
            `UPDATE tbl_projects
            SET
               status = $1,
               description = $2,
               location = $3,
               ended_at = $4,
               rfq_type = $7,
               reverse_auction = $8,
               updated_at = NOW()
            WHERE
               id = $5
               AND user_id = $6
            RETURNING *;`,
           [
               projectObj.status,        
               projectObj.description,   
               projectObj.location,      
               projectObj.ended_at,      
               projectObj.project_id,    
               projectObj.user_id,
               projectObj.rfq_type,
               projectObj.reverse_auction        
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

  getIdAndNameOfProjects: async (user_id) => {
    return new Promise(function (resolve, reject) {
        db.any(
            `SELECT 
                p.id,
                p.name 
            FROM 
                tbl_projects p 
            WHERE 
                p.user_id = ${user_id}`
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

}
export default projectModel;