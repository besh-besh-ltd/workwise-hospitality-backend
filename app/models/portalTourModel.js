import db from '../config/dbConn.js';
import Config from '../config/app.config.js';


const portalTourModel = {
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
    }

}







export default portalTourModel;
