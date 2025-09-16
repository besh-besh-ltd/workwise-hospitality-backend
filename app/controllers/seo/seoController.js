import Config from '../../config/app.config.js';
import {
  logError
} from '../../helper/common.js';
import seoModel from '../../models/seoModel.js';

const seoController = {
  productSlugForSitemap: async (req, res, next) => {
    try {
      const { page = 1, limit = 50000 } = req.query;
      const pageNumber = parseInt(page);
      const limitNumber = parseInt(limit);
      const offset = (pageNumber - 1) * limitNumber;

      const { productSlugList, total } = await seoModel.productSlugSitemap(limitNumber, offset);
      const slugArray = productSlugList.map((item) => item.slug);
      const responsePayload = {
          status: 1,
          data: slugArray,
          total: total,
          page: pageNumber,
          limit: limitNumber
      };

      res
        .status(200)
        .json(responsePayload)
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
  ,
  vendorSitemap: async (req, res, next) => {
    try {
      const { page = 1, limit = 50000 } = req.query;
      const pageNumber = parseInt(page);
      const limitNumber = parseInt(limit);
      const offset = (pageNumber - 1) * limitNumber;

      const rows = await seoModel.vendorSitemapUrls(limitNumber, offset);
      const baseUrl = process.env.FRONTEND_URL || 'https://letsworkwise.com';
      const xmlBody = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...rows.map(r => `  <url>\n    <loc>${baseUrl}${r.loc}</loc>\n    <changefreq>${r.changefreq}</changefreq>\n    <priority>${r.priority}</priority>\n  </url>`),
        '</urlset>'
      ].join('\n');

      res
        .set('Content-Type', 'application/xml')
        .status(200)
        .send(xmlBody)
        .end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  }
};



export default seoController;
