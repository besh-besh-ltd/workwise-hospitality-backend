import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import portalTourModel from '../../models/portalTourModel.js';

const portalTourController = {
    // get tour content by page id
    getPageTourContent: async (req, res, next) => {
        try {
            const page_id = req.params.id;
            const user_id = req.user.id;

            const pageTourContent = await portalTourModel.getPageTourContent(page_id, user_id);

            if (pageTourContent) {
                res.status(200).json({
                    status: 1,
                    message: "Let's start portal tour",
                    data: pageTourContent
                }).end();
            } else {
                res.status(200).json({
                    status: 1,
                    message: 'Tour already completed'
                }).end();
            }
        } catch (error) {
            logError(error);
            res.status(400).json({
                status: 3,
                message: Config.errorText.value
            }).end();
        }
    },

    // get user tour progress status
    getUserTourProgrs: async (req, res, next) => {
        try {

            const page_id = req.params.id;
            const user_id = req.user.id;

            const userProgress = await portalTourModel.getUserTourStatus(page_id, user_id)

            res
                .status(200)
                .json({
                    status: 1,
                    data: userProgress
                })
                .end();

        } catch (error) {
            logError(error);
            res
                .status(400)
                .json({
                    status: 3,
                    message: Config.errorText.value,
                    data: error
                })
                .end();
        }
    },

    // post request to upload user tour status
    uploadUserTourProgress: async (req, res, next) => {
        try {
            const user_id = req.user.id;
            const { completed, page_id } = req.body;

            const uploadingResult = await portalTourModel.uploadUserProgress(user_id, completed, page_id);

            if (uploadingResult) {
                res
                    .status(200)
                    .json({
                        status: 1,
                        message: "tour progress successfully uploaded",
                    })
                    .end();
            }

        } catch (error) {
            logError(error);
            res
                .status(400)
                .json({
                    status: 3,
                    message: Config.errorText.value,
                    data: error
                })
                .end();
        }
    },

    // update user tour status, completed false means tour is pending, true means tour already completed
    updateUserTourProgress: async (req, res, next) => {
        try {
            const user_id = req.user.id
            const { page_id, completed } = req.body;

            const updatedUserDetails = await portalTourModel.updateUserProgress(user_id, page_id, completed)

            if (updatedUserDetails) {
                res
                    .status(200)
                    .json({
                        status: 1,
                        message: "tour progress successfully updated",
                    })
                    .end();
            }

        } catch (error) {
            logError(error);
            res
                .status(400)
                .json({
                    status: 3,
                    message: Config.errorText.value,
                    data: error
                })
                .end();
        }
    }
}



export default portalTourController;