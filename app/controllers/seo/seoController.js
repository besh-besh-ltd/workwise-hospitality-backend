import Config from '../../config/app.config.js';
import {
  logError
} from '../../helper/common.js';
import seoModel from '../../models/seoModel.js';


// Simple in-memory cache to speed up sitemap responses
// Keyed by `${page}:${limit}` with short TTL to keep data fresh
const sitemapCache = new Map();
const SITEMAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(pageNumber, limitNumber) {
  return `${pageNumber}:${limitNumber}`;
}

function getFromCache(cacheKey) {
  const cached = sitemapCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    sitemapCache.delete(cacheKey);
    return null;
  }
  return cached.payload;
}

function setInCache(cacheKey, payload) {
  sitemapCache.set(cacheKey, {
    payload,
    expiresAt: Date.now() + SITEMAP_CACHE_TTL_MS
  });
}

const seoController = {
  productSlugForSitemap: async (req, res, next) => {
    try {
      const { page = 1, limit = 50000 } = req.query;
      const pageNumber = parseInt(page);
      const limitNumber = parseInt(limit);
      const offset = (pageNumber - 1) * limitNumber;
      const cacheKey = getCacheKey(pageNumber, limitNumber);

      // Serve from cache if present
      const cached = getFromCache(cacheKey);
      if (cached) {
        res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=300');
        return res.status(200).json(cached).end();
      }

      const { productSlugList, total } = await seoModel.productSlugSitemap(limitNumber, offset);
      const slugArray = productSlugList.map((item) => item.slug);
      const responsePayload = {
        status: 1,
        data: slugArray,
        total: total,
        page: pageNumber,
        limit: limitNumber
      };

      // Store in cache
      setInCache(cacheKey, responsePayload);

      res
        .set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=300')
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
      const cacheKey = getCacheKey(pageNumber, limitNumber);

      const cached = getFromCache(cacheKey + ':vendor');
      if (cached) {
        res.set('Content-Type', 'application/xml');
        res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=300');
        return res.status(200).send(cached).end();
      }

      const rows = await seoModel.vendorSitemapUrls(limitNumber, offset);
      const baseUrl = process.env.FRONTEND_URL || 'https://letsworkwise.com';
      const xmlBody = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...rows.map(r => `  <url>\n    <loc>${baseUrl}${r.loc}</loc>\n    <changefreq>${r.changefreq}</changefreq>\n    <priority>${r.priority}</priority>\n  </url>`),
        '</urlset>'
      ].join('\n');

      setInCache(cacheKey + ':vendor', xmlBody);

      res
        .set('Content-Type', 'application/xml')
        .set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=300')
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
