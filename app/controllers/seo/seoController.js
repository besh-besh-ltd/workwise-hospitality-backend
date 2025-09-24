import Config from '../../config/app.config.js';
import {
  logError
} from '../../helper/common.js';
import seoModel from '../../models/seoModel.js';
import { Readable } from 'stream';

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
 vendorSitemap : async (req, res, next) => {
  try {
    const { page = 1, limit = 50000 } = req.query;
    const pageNumber = parseInt(page);
    const limitNumber = parseInt(limit);

    if (isNaN(pageNumber) || pageNumber < 1 || isNaN(limitNumber) || limitNumber < 1) {
      res.status(400).json({ status: 3, message: 'Invalid page or limit' }).end();
      return;
    }

    const offset = (pageNumber - 1) * limitNumber;

    // Create a readable stream for the sitemap
    const stream = new Readable({
      read() {}
    });

    // Set response headers
    res.set('Content-Type', 'application/xml');

    // Write XML header
    stream.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    stream.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n');

    // Pipe the stream to the response
    stream.pipe(res);

    // Generate and stream URLs
    for await (const url of seoModel.vendorSitemapUrls(limitNumber, offset)) {
      stream.push(url);
    }

    // Close the XML and stream
    stream.push('</urlset>\n');
    stream.push(null); // Signal end of stream

  } catch (error) {
    console.error('Error generating sitemap:', error);
    if (!res.headersSent) {
      res.status(400).json({ status: 3, message: 'Error generating sitemap' }).end();
    }
  }
}
};



export default seoController;
