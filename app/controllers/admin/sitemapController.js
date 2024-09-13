import { logError } from "../../helper/common.js";
import sitemapModel from "../../models/sitemapModel.js";

import Config from '../../config/app.config.js';

const sitemapController = {
    vendorProfiles: async (req, res, next) => {
        try {
         const vendorList = await  sitemapModel.vendorProfile()

         res
         .status(200)
         .json({
             status: 1,
             data:vendorList
         })
         .end();

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

export default sitemapController;
