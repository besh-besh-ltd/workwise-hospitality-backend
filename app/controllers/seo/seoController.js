import Config from '../../config/app.config.js';
import {
  logError
} from '../../helper/common.js';
import seoModel from '../../models/seoModel.js';


const seoController = {
  productSlugForSitemap: async (req, res, next) => {
    try {
      const productSlugList = await seoModel.productSlugSitemap();
      const slugArray = productSlugList.map((item) => item.slug);

      res
        .status(200)
        .json({
          status: 1,
          data: slugArray,
          total:slugArray.length
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
};



export default seoController;
