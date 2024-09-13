import db from '../config/dbConn.js';

const sitemapModel = {
    vendorProfile: async () => {
        return new Promise((resolve, reject) => {

            const q = `SELECT id, updated_at FROM tbl_users 
         WHERE is_deleted = 0 AND user_type = 3 AND status = 1
        ORDER BY updated_at`

            db.any(q)
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


export default sitemapModel;
