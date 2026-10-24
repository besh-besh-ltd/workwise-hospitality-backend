// "Is this a file we stored?" for document URLs that clients send back to us
// (invoice_url, grn_document_url, ...).
//
// The allowed hosts come from the same two settings every uploader uses:
//   AWS_S3_BUCKET  the bucket multer-s3 (`bucket:`) and generalModel.uploadToS3
//                  (`Bucket:`) write to;
//   AWS_REGION     the region of the shared S3 client (config/s3config.js) and
//                  the one uploadToS3 puts in the URL it returns.
// Uploads come back as virtual-hosted URLs, https://<bucket>.s3.<region>.amazonaws.com/<key>
// (uploadToS3 builds exactly that; multer-s3's `location` is the SDK's
// <bucket>.<regional endpoint>). The global form https://<bucket>.s3.amazonaws.com/<key>,
// which S3 hands back for some multipart uploads and older objects, is accepted
// for the same bucket.
//
// The URL is parsed (WHATWG URL) and its hostname compared exactly: no
// substring or prefix matching, https only, no credentials, no non-default
// port, and a non-empty object key. Without bucket config nothing is accepted.
// Callers store the parsed URL's href, never the raw string.

export function ownS3Hosts(env = process.env) {
  const bucket = String(env.AWS_S3_BUCKET || '').trim().toLowerCase();
  const region = String(env.AWS_REGION || '').trim().toLowerCase();
  if (!bucket) return [];
  const hosts = [`${bucket}.s3.amazonaws.com`];
  if (region) hosts.unshift(`${bucket}.s3.${region}.amazonaws.com`);
  return hosts;
}

/**
 * The normalized URL (WHATWG href) when `url` is one of our own S3 objects,
 * otherwise null. Store this, not the string the client sent.
 *
 * @param {unknown} url
 * @param {object} [env] defaults to process.env
 * @returns {string|null}
 */
export function normalizeOwnS3Url(url, env = process.env) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port) return null;
  if (!ownS3Hosts(env).includes(parsed.hostname.toLowerCase())) return null;
  if (parsed.pathname.length <= 1) return null; // an object key, not the bucket root
  return parsed.href;
}

/**
 * @param {unknown} url
 * @param {object} [env] defaults to process.env
 * @returns {boolean}
 */
export const isOwnS3Url = (url, env = process.env) => normalizeOwnS3Url(url, env) !== null;

/**
 * Route middleware: each named body field, when present and non-empty, must be
 * one of our own S3 URLs; otherwise 400 before the handler runs. A valid value
 * is replaced with its normalized href.
 *
 * @param {...string} fields
 */
export const requireOwnS3Urls = (...fields) => (req, res, next) => {
  for (const field of fields) {
    const value = req.body?.[field];
    if (value === undefined || value === null || value === '') continue;
    const href = normalizeOwnS3Url(value);
    if (!href) {
      return res.status(400).json({
        status: 0,
        message: 'Please upload the document again: the file link is not one of ours.',
        code: 'INVALID_DOCUMENT_URL',
        details: { field },
      });
    }
    req.body[field] = href; // the handler stores the normalized form
  }
  return next();
};

export default { isOwnS3Url, normalizeOwnS3Url, ownS3Hosts, requireOwnS3Urls };
