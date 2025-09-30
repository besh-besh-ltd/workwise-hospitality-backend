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
},
vendorSitemapIndex: async (req, res, next) => {
  try {
    const { totalUrls } = await seoModel.getVendorSitemapTotal();
    const limit = 50000;
    const totalPages = Math.ceil(totalUrls / limit);
    const baseUrl = process.env.FRONTEND_URL || "https://letsworkwise.com";

    res.set("Content-Type", "application/xml");

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    for (let i = 1; i <= totalPages; i++) {
      xml += `  <sitemap>\n`;
      xml += `    <loc>${baseUrl}/vendors/${i}.xml</loc>\n`;
      xml += `  </sitemap>\n`;
    }

    xml += "</sitemapindex>";

    res.send(xml);
  } catch (error) {
    console.error("Error generating sitemap index:", error);
    if (!res.headersSent) {
      res.status(500).json({ status: 3, message: "Error generating sitemap index" });
    }
  }
}

};



export default seoController;
