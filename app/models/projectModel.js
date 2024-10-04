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
    }
}
export default projectModel;