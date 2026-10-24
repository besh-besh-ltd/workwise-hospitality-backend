// "Is this a file we stored?" for document URLs that clients send back to us
// (invoice_url, grn_document_url, ...).
//
// Uploads land in AWS_S3_BUCKET and come back as virtual-hosted URLs:
//   https://<bucket>.s3.<region>.amazonaws.com/<key>   (multer-s3, uploadToS3)
// The legacy global endpoint form https://<bucket>.s3.amazonaws.com/<key> is
// accepted too. The URL is parsed (WHATWG URL) and its hostname compared
// exactly: no substring or prefix matching, https only, no credentials, no
// non-default port, and a non-empty object key. Without bucket config nothing
// is accepted.

export function ownS3Hosts(env = process.env) {
  const bucket = String(env.AWS_S3_BUCKET || '').trim().toLowerCase();
  const region = String(env.AWS_REGION || '').trim().toLowerCase();
  if (!bucket) return [];
  const hosts = [`${bucket}.s3.amazonaws.com`];
  if (region) hosts.unshift(`${bucket}.s3.${region}.amazonaws.com`);
  return hosts;
}

/**
 * @param {unknown} url
 * @param {object} [env] defaults to process.env
 * @returns {boolean}
 */
export function isOwnS3Url(url, env = process.env) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port) return false;
  if (!ownS3Hosts(env).includes(parsed.hostname.toLowerCase())) return false;
  return parsed.pathname.length > 1; // an object key, not the bucket root
}

/**
 * Route middleware: each named body field, when present and non-empty, must be
 * one of our own S3 URLs; otherwise 400 before the handler runs.
 *
 * @param {...string} fields
 */
export const requireOwnS3Urls = (...fields) => (req, res, next) => {
  for (const field of fields) {
    const value = req.body?.[field];
    if (value === undefined || value === null || value === '') continue;
    if (!isOwnS3Url(value)) {
      return res.status(400).json({
        status: 0,
        message: 'Please upload the document again: the file link is not one of ours.',
        code: 'INVALID_DOCUMENT_URL',
        details: { field },
      });
    }
  }
  return next();
};

export default { isOwnS3Url, ownS3Hosts, requireOwnS3Urls };
