import db from '../config/dbConn.js';
import Config from '../config/app.config.js';


const portalTourModel = {

    // get page tour content
    getPageTourContent: async (page_id) => {
        return new Promise((resolve, reject) => {
            db.one(
                `SELECT * FROM tbl_portal_tour_content WHERE page_id=$1`,
                [page_id]
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
    // get user tour progress by page ID and user ID
    getUserTourStatus: async (page_id, user_id) => {
        return new Promise((resolve, reject) => {
            db.one(
                `SELECT * FROM tbl_portal_tour_progress WHERE page_id=$1 AND user_id=$2`,
                [page_id, user_id]
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
    //  upload user tour progress
    uploadUserProgress: async (user_id, completed, page_id) => {
        return new Promise((resolve, reject) => {
            db.one(
                `INSERT INTO tbl_portal_tour_progress (user_id, page_id, completed) 
                 VALUES ($1, $2, $3) 
                 RETURNING *`,
                [user_id, page_id, completed]
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
    // Update user tour progress status
    updateUserProgress: async (user_id, page_id, completed) => {
        return new Promise((resolve, reject) => {
            db.one(
                `UPDATE tbl_portal_tour_progress 
             SET completed = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE user_id = $2 AND page_id = $3 
             RETURNING *`,
                [completed, user_id, page_id]
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







export default portalTourModel;
