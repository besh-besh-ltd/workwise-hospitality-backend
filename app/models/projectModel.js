import db, { pgp } from '../config/dbConn.js';

const projectModel = {
  createProject: async (projectObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `INSERT INTO tbl_projects(name, description, location, ended_at, user_id, rfq_type, reverse_auction,budget)
                 VALUES($1, $2, $3, $4, $5, $6, $7 , $8s)`,
        [
          projectObj.name,
          projectObj.description,
          projectObj.location,
          projectObj.ended_at,
          projectObj.user_id,
          projectObj.rfq_type,
          projectObj.reverse_auction,
          projectObj.budget
        ]
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
  projectExist: async (name, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT 1 
                FROM tbl_projects 
                WHERE name = $1 
                AND user_id = $2`,
        [name, user_id]
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

  getProjectTableDataById: async (project_id, user_id, file = 'no') => {
    return new Promise(function (resolve, reject) {
      let query = '';
      let params = [project_id, user_id];

      if (file === 'yes') {
        query = `
        SELECT 
          t.*,
          COALESCE(
            json_agg(
              json_build_object(
                'file_name', tpf.file_name,
                'file_type', tpf.file_type,
                'file_url', tpf.file_url
              )
            ) FILTER (WHERE tpf.file_name IS NOT NULL), '[]'
          ) AS files
        FROM tbl_projects t
        LEFT JOIN tbl_project_files tpf ON tpf.project_id = t.id
        WHERE t.id = $1
        GROUP BY t.id;
      `;
      } else {
        query = `
        SELECT *
        FROM tbl_projects
        WHERE id = $1
        and user_id = $2;
      `;
      }

      db.any(query, params)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(new Error(err));
        });
    });
  },

    getProjectById: async (project_id, user_id, limit, offset) => {
        return new Promise(function (resolve, reject) {
                db.any(
                  `SELECT
                                p.*,
                                -- Aggregated RFQ counts
                                (
                    SELECT COUNT(*)
                    FROM tbl_rfq r
                    WHERE r.project_id = p.id AND is_published = 1
                  ) AS total_rfqs,
                                (
                    SELECT COUNT(*)
                    FROM tbl_rfq r
                    WHERE r.project_id = p.id AND r.status = 2
                  ) AS closed_rfqs,
                                (
                    SELECT COUNT(*)
                    FROM tbl_rfq r
                    WHERE r.project_id = p.id AND r.status = 1 AND is_published = 1
                  ) AS open_rfqs,
                                COALESCE(
                                    jsonb_object_agg(
                                        f.file_type,
                                        ARRAY(
                                            SELECT json_build_object(
                                                'name', file.file_name,
                                                'url', file.file_url
                                            )
                                            FROM tbl_project_files file
                                            WHERE file.project_id = p.id AND file.file_type = f.file_type
                                        )
                                    ) FILTER (WHERE f.file_type IS NOT NULL),
                                    '{}'::jsonb
                                ) AS files,
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
                            LEFT JOIN
                                tbl_project_files f ON f.project_id = p.id
                            WHERE
                                p.id = $1
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
  /**
   *
   * @param {*} user_id
   * @returns list of project in which user is creator or team member
   */
  getAllProjects: async (user_id) => {
    return new Promise(function (resolve, reject) {
      const query = `SELECT 
        p.*, 
        u.name AS created_by_name,
        COUNT(r.id) AS total_rfqs,
        COUNT(CASE WHEN r.status = 2 THEN 1 END) AS closed_rfqs,
        COUNT(CASE WHEN r.status = 1 THEN 1 END) AS open_rfqs
      FROM 
        tbl_projects p
      LEFT JOIN 
        tbl_users u ON u.id = p.user_id
      LEFT JOIN 
        tbl_rfq r ON r.project_id = p.id 
      WHERE 
        p.user_id = $1 OR EXISTS (
          SELECT 1 FROM tbl_project_team pt
          WHERE pt.project_id = p.id AND pt.user_id = $1
        )
      GROUP BY 
        p.id, u.name
      ORDER BY 
        p.created_at DESC;`;

      console.log(' query ', query);

      db.any(query, [user_id])
        .then((data) => resolve(data))
        .catch((err) => reject(new Error(err)));
    });
  },

  /**
   * @param {*} company_id
   * @returns return list of project created in a company,
   */
  getAllProjectsByCompany: async (company_id) => {
    return new Promise((resolve, reject) => {
      const query = `SELECT 
  p.*, 
  u.name AS created_by_name,
  COALESCE(COUNT(r.id), 0) AS total_rfqs,
  COALESCE(COUNT(CASE WHEN r.status = 2 THEN 1 END), 0) AS closed_rfqs,
  COALESCE(COUNT(CASE WHEN r.status = 1 THEN 1 END), 0) AS open_rfqs
FROM 
  tbl_projects p
LEFT JOIN 
  tbl_users u ON u.id = p.user_id  -- fetch creator name
LEFT JOIN 
  tbl_rfq r ON r.project_id = p.id
WHERE 
  p.user_id IN (
    SELECT id FROM tbl_users 
    WHERE company_id = $1 
  )
  OR p.id IN (
    SELECT pt.project_id 
    FROM tbl_project_team pt
    JOIN tbl_users tu ON pt.user_id = tu.id
    WHERE tu.company_id = $1 
  )
GROUP BY 
  p.id, u.name
ORDER BY 
  p.created_at DESC;
`;

      db.any(query, [company_id])
        .then((data) => resolve(data))
        .catch((err) => reject(new Error(err)));
    });
  },

  updateProject: async (projectObj) => {
    console.log('projectObj in updateProject user', projectObj);
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
               budget = $9,
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
          projectObj.reverse_auction,
          projectObj.budget
        ]
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
  // mukul 03--06-2025 retuen project list for user team
  getIdAndNameOfProjects: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT 
                p.id,
                p.name 
            FROM 
                tbl_projects p
            LEFT JOIN tbl_project_team pt ON p.id = pt.project_id
            WHERE 
                p.user_id = $1 OR pt.user_id = $1
            GROUP BY p.id, p.name`,
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

  // Changes by Agnij 14-01-2025 [Added functions to handle project team members]

  // Get all team members for a project
  getProjectTeamMembers: async (project_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT 
                pt.id,
                pt.project_id,
                pt.user_id,
                pt.role,
                pt.created_at,
                pt.created_by,
                u.name,
                u.email,
                u.mobile
            FROM 
                tbl_project_team pt
            JOIN
                tbl_users u ON pt.user_id = u.id
            WHERE 
                pt.project_id = $1
            ORDER BY
                pt.created_at DESC`,
        [project_id]
      )
        .then(function (data) {
          // Ensure data is always an array
          const teamMembers = Array.isArray(data) ? data : data ? [data] : [];
          resolve(teamMembers);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  // Add a team member to a project
  addTeamMember: async (memberObj) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `INSERT INTO tbl_project_team
                (project_id, user_id, role, created_by)
             VALUES
                ($1, $2, $3, $4)
             RETURNING *`,
        [
          memberObj.project_id,
          memberObj.user_id,
          memberObj.role,
          memberObj.created_by
        ]
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

  // Remove a team member from a project
  removeTeamMember: async (project_id, user_id) => {
    return new Promise(function (resolve, reject) {
      // Ensure parameters are integers
      project_id = parseInt(project_id);
      user_id = parseInt(user_id);

      db.result(
        `DELETE FROM tbl_project_team
             WHERE project_id = $1 AND user_id = $2`,
        [project_id, user_id]
      )
        .then(function (result) {
          if (result.rowCount === 0) {
          }
          resolve({ rowCount: result.rowCount });
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  // Check if a user is already a member of a project
  isTeamMember: async (project_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.oneOrNone(
        `SELECT 1
             FROM tbl_project_team
             WHERE project_id = $1 AND user_id = $2`,
        [project_id, user_id]
      )
        .then(function (data) {
          const isMember = data !== null;
          resolve(isMember);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  // Get all projects where a user is a team member
  getUserProjects: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT 
                p.id, 
                p.name,
                p.description,
                p.location,
                p.ended_at,
                p.created_at,
                pt.role
            FROM 
                tbl_projects p
            JOIN
                tbl_project_team pt ON p.id = pt.project_id
            WHERE 
                pt.user_id = $1
            ORDER BY
                p.created_at DESC`,
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

  getTeamMemberDetails: async (team_member_id) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT 
          pt.id,
          pt.project_id,
          pt.user_id,
          pt.role,
          pt.created_at,
          u.name,
          u.email,
          u.mobile
        FROM 
          tbl_project_team pt
        JOIN
          tbl_users u ON pt.user_id = u.id
        WHERE 
          pt.id = $1`,
        [team_member_id]
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

  checkProjectOwnership: async (project_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.oneOrNone(
        `SELECT 1 FROM tbl_projects WHERE id = $1 AND user_id = $2`,
        [project_id, user_id]
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
  getProjectBudget: async (project_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
                    `SELECT 
                trpo.id,
                tr.rfq_no, 
                tu.name AS vendor_name, 
                trpo.updated_at, 
                trpo.total_value::int AS total_value
            FROM 
                tbl_rfq_purchase_order trpo 
            JOIN 
                tbl_rfq tr ON tr.id = trpo.rfq_id 
            JOIN 
                tbl_users tu ON tu.id = trpo.finalized_vendor_id
                where trpo.project_id = $1 and trpo.status = 'approved';`,
        [project_id]
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
 

  getProjectByIdForAdmin: async (project_id, limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT 
          p.*, 
          -- Aggregated RFQ counts
          COUNT(r.id) AS total_rfqs,
          COUNT(CASE WHEN r.status = 0 THEN 1 END) AS closed_rfqs,
          COUNT(CASE WHEN r.status = 1 THEN 1 END) AS open_rfqs,

          COALESCE(
              jsonb_object_agg(
                  f.file_type,
                  ARRAY(
                      SELECT json_build_object(
                          'name', file.file_name,
                          'url', file.file_url
                      )
                      FROM tbl_project_files file
                      WHERE file.project_id = p.id AND file.file_type = f.file_type
                  )
              ) FILTER (WHERE f.file_type IS NOT NULL),
              '{}'::jsonb
          ) AS files,

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
              LIMIT $2 OFFSET $3
          ) AS rfqs

      FROM 
          tbl_projects p
      LEFT JOIN 
          tbl_rfq r ON r.project_id = p.id
      LEFT JOIN 
          tbl_project_files f ON f.project_id = p.id    
      WHERE 
          p.id = $1
      GROUP BY 
          p.id`,
        [project_id, limit, offset]
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

  getProjectTableDataByIdForAdmin: async (project_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT t.* 
         FROM tbl_projects t
         WHERE t.id = $1`,
        [project_id]
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

  getAllProjectsForAdmin: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT 
          p.*, 
          COUNT(r.id) AS total_rfqs,
          COUNT(CASE WHEN r.status = 2 THEN 1 END) AS closed_rfqs,
          COUNT(CASE WHEN r.status = 1 THEN 1 END) AS open_rfqs
        FROM 
          tbl_projects p
        LEFT JOIN 
          tbl_rfq r ON r.project_id = p.id 
        WHERE 
          p.user_id = $1
        GROUP BY 
          p.id
        ORDER BY 
          p.created_at DESC`,
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

  updateProjectForAdmin: async (projectObj) => {
    console.log('projectObj in updateProjectForAdmin', projectObj);
    return new Promise(function (resolve, reject) {
      db.oneOrNone(
        `UPDATE tbl_projects
        SET
           status = $1,
           description = $2,
           location = $3,
           ended_at = $4,
           rfq_type = $5,
           reverse_auction = $6,
           budget = $7,
           updated_at = NOW()
        WHERE
           id = $8
        RETURNING *`,
        [
          projectObj.status,
          projectObj.description,
          projectObj.location,
          projectObj.ended_at,
          projectObj.rfq_type,
          projectObj.reverse_auction,
          projectObj.budget,
          projectObj.project_id
          
        ]
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

export default projectModel;