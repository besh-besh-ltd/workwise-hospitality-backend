import db from '../config/dbConn.js';
import Config from '../config/app.config.js';


const portalTourModel = {

    // get page tour content
    getPageTourContent: async (page_id, user_id) => {
        return new Promise(async (resolve, reject) => {
            try {
                // Check if the user has tour progress for the page
                const userTourStatus = await db.oneOrNone(
                    `SELECT * FROM tbl_portal_tour_progress WHERE page_id=$1 AND user_id=$2`,
                    [page_id, user_id]
                );

                // If user tour status doesn't exist, create one with completed=false
                if (!userTourStatus) {
                    await db.one(
                        `INSERT INTO tbl_portal_tour_progress (user_id, page_id, completed) 
                         VALUES ($1, $2, $3) 
                         RETURNING *`,
                        [user_id, page_id, false]
                    );
                }

                // Fetch the tour content only if the tour is not completed
                if (!userTourStatus || !userTourStatus.completed) {
                    const pageTourContent = await db.oneOrNone(
                        `SELECT * FROM tbl_portal_tour_content WHERE page_id=$1`,
                        [page_id]
                    );
                    if (pageTourContent) {
                        resolve(pageTourContent);
                    } else {
                        reject(new Error('Page tour content not found'));
                    }
                } else {
                    resolve(null); // Tour is already completed, no need to fetch content
                }
            } catch (err) {
                reject(new Error(err));
            }
        });
    },
    // get user tour progress by page ID and user ID
    getUserTourStatus: async (page_id, user_id) => {
        try {
            // Use db.oneOrNone to handle cases where no data is found
            const data = await db.oneOrNone(
                `SELECT * FROM tbl_portal_tour_progress WHERE page_id=$1 AND user_id=$2 AND completed=true`,
                [page_id, user_id]
            );

            if (data) {
                return { tourProgress: 1 };
            } else {
                return { tourProgress: 0 };
            }
        } catch (err) {
            // Handle and reject errors
            const error = new Error(err);
            throw error;
        }
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
