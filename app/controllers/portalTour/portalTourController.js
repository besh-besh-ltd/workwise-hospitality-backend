import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import portalTourModel from '../../models/portalTourModel.js';

const portalTourController = {
    getPageTourContent: async (req, res, next) => {
        try {

            const page_id = req.params.id

            const getPageTourContent = await portalTourModel.getPageTourContent(page_id);

            if (getPageTourContent) {
                res
                    .status(200)
                    .json({
                        status: 1,
                        data: getPageTourContent
                    })
                    .end();
            }
            else{
                res.status(404).json({
                    status: 0,
                    message: 'Page tour content not found'
                });
            }

        } catch (error) {
            logError(error);
            res
                .status(400)
                .json({
                    status: 3,
                    message: Config.errorText.value
                })
                .end();
        }
    }


}



export default portalTourController;