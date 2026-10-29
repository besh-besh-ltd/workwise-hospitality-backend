// Purchase Requisitions — catalog guards (spec §8 guided buying, §9 map/convert).
//
//   isUsableVariant / variantCategoryId / describeVariants
//       The RFQ "usable" predicate (rfqModel.searchProduct) and the category a
//       catalog line is filed under. A PR line may only reference a variant the
//       RFQ wizard would accept, so conversion can never produce an RFQ line
//       the wizard rejects.
//   contractCoverage
//       Variants with a live rate contract for (hotel × department). Those must
//       go through MR, not PR. The SQL is mrModel.contractedVariantPredicateSql —
//       the very predicate behind the MR item picker — so "blocked on PR" and
//       "offered by MR" can never disagree.
//
//   guardCatalogLines
//       All of the above for a PR's lines, as one refusal per severity.
//   isOwnUploadUrl
//       Is a file URL one our upload endpoint produced (an object in our S3
//       bucket)? PR attachments accept nothing else (spec §12).
//
// Used at save (create/update), at submit, and again at map / convert by later
// tasks: the catalog can change between draft and use.

import db from '../../config/dbConn.js';
import { contractedVariantPredicateSql } from '../../models/mr/mrModel.js';
import { activeCategoryIds } from '../../models/pr/prModel.js';
import { USABLE_VARIANT_SQL, FIRST_CATEGORY_SQL, MAX_LEN } from './prConstants.js';
import { PR_ERR, prError } from './prErrors.js';

export { USABLE_VARIANT_SQL, FIRST_CATEGORY_SQL };

const toIds = (ids) => [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/**
 * One round trip for many variants.
 * @returns {Promise<Map<number, {usable: boolean, category_id: number|null, name: string|null}>>}
 *   Variants that do not exist are absent from the map.
 */
export async function describeVariants(variantIds, t = db) {
  const ids = toIds(variantIds);
  const out = new Map();
  if (!ids.length) return out;
  const rows = await t.any(
    `SELECT pv.id,
            pv.name,
            COALESCE((${USABLE_VARIANT_SQL}), false) AS usable,
            ${FIRST_CATEGORY_SQL('pv.product_id')} AS category_id
       FROM tbl_product_variant pv
       LEFT JOIN tbl_product p ON p.id = pv.product_id
      WHERE pv.id = ANY($1::int[])`,
    [ids]
  );
  for (const r of rows) {
    out.set(Number(r.id), {
      usable: r.usable === true,
      category_id: r.category_id == null ? null : Number(r.category_id),
      name: r.name,
    });
  }
  return out;
}

export async function isUsableVariant(variantId, t = db) {
  const info = (await describeVariants([variantId], t)).get(Number(variantId));
  return info?.usable === true;
}

/** The variant's product's first category id (by id asc), or null. */
export async function variantCategoryId(variantId, t = db) {
  const info = (await describeVariants([variantId], t)).get(Number(variantId));
  return info?.category_id ?? null;
}

/**
 * Variants (of `variantIds`) that are on a live rate contract for the cell.
 * When several contracts cover one variant, the lowest contract id is reported.
 * @returns {Promise<Map<number, {arc_contract_id: number, arc_number: string}>>}
 */
export async function contractCoverage({ hotelId, departmentId, variantIds }, t = db) {
  const ids = toIds(variantIds);
  const out = new Map();
  if (!ids.length || !hotelId || !departmentId) return out;
  const contracted = contractedVariantPredicateSql('$1', '$2');
  const rows = await t.any(
    `SELECT DISTINCT ON (ai.product_variant_id)
            ai.product_variant_id, c.id AS arc_contract_id, a.arc_number
       FROM ${contracted.from}
      WHERE ${contracted.where}
        AND ai.product_variant_id = ANY($3::int[])
      ORDER BY ai.product_variant_id, c.id`,
    [Number(hotelId), Number(departmentId), ids]
  );
  for (const r of rows) {
    out.set(Number(r.product_variant_id), { arc_contract_id: Number(r.arc_contract_id), arc_number: r.arc_number });
  }
  return out;
}

/**
 * Catalog guards for a PR's lines, in severity order (each code lists every
 * offending line): unknown variant/category → PR_VALIDATION; variant the RFQ
 * wizard would refuse → PR_VARIANT_NOT_USABLE; variant on a live rate contract
 * for the cell → PR_LINE_ON_CONTRACT. Run at save (create/update) and again at
 * submit — the catalog can change in between.
 *
 * @param {object} t
 * @param {{hotelId: number, departmentId: number}} cell
 * @param {Array<{line_no, line_kind, product_variant_id, category_id}>} lines
 * @returns the lines, each catalog line's category_id = its product's category now.
 */
export async function guardCatalogLines(t, cell, lines) {
  const catalog = lines.filter((l) => l.line_kind === 'catalog');
  const freeText = lines.filter((l) => l.line_kind === 'free_text');
  const variants = await describeVariants(catalog.map((l) => l.product_variant_id), t);
  const categories = await activeCategoryIds(freeText.map((l) => l.category_id), t);

  const unknown = [
    ...catalog.filter((l) => !variants.has(l.product_variant_id))
      .map((l) => ({ field: 'product_variant_id', line_no: l.line_no, message: 'This catalog item does not exist' })),
    ...freeText.filter((l) => !categories.has(l.category_id))
      .map((l) => ({ field: 'category_id', line_no: l.line_no, message: 'This category does not exist or is inactive' })),
  ].sort((a, b) => a.line_no - b.line_no);
  if (unknown.length) throw prError(PR_ERR.VALIDATION, 'Some lines reference items or categories that do not exist', unknown);

  const unusable = catalog
    .filter((l) => !variants.get(l.product_variant_id).usable || variants.get(l.product_variant_id).category_id == null)
    .map((l) => {
      const v = variants.get(l.product_variant_id);
      return { line_no: l.line_no, product_variant_id: l.product_variant_id, variant_name: v.name, reason: v.usable ? 'no_category' : 'not_usable' };
    });
  if (unusable.length) throw prError(PR_ERR.VARIANT_NOT_USABLE, 'Some catalog items can no longer be requested', unusable);

  const coverage = await contractCoverage({
    hotelId: cell.hotelId, departmentId: cell.departmentId, variantIds: catalog.map((l) => l.product_variant_id),
  }, t);
  const onContract = catalog.filter((l) => coverage.has(l.product_variant_id)).map((l) => ({
    line_no: l.line_no,
    product_variant_id: l.product_variant_id,
    variant_name: variants.get(l.product_variant_id).name,
    ...coverage.get(l.product_variant_id),
  }));
  if (onContract.length) {
    throw prError(PR_ERR.LINE_ON_CONTRACT, 'These items are on a rate contract for this hotel and department — raise an MR instead', onContract);
  }

  return lines.map((l) => (l.line_kind === 'catalog' ? { ...l, category_id: variants.get(l.product_variant_id).category_id } : l));
}

/**
 * Is `hostname` (a WHATWG URL hostname, lower-cased) this machine? `localhost`,
 * any `*.localhost` name (RFC 6761 — always loopback), 127.0.0.0/8, or ::1.
 */
function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]') return true;
  const v4 = h.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(v4) && v4.slice(1).every((n) => Number(n) <= 255);
}

// Object URL on the configured S3 endpoint override (local sink). multer-s3
// addresses the sink virtual-hosted (http://<bucket>.<endpoint host>:<port>/<key>);
// path-style (<endpoint>/<bucket>/<key>) is accepted too. Honoured ONLY when the
// endpoint is loopback / *.localhost: an override pointing anywhere else (a stray
// env var on a real server) never widens what counts as our upload.
function isOwnEndpointUrl(u, bucketLower, endpoint) {
  const raw = String(endpoint ?? '').trim();
  if (!raw) return false;
  let e;
  try {
    e = new URL(raw);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(e.protocol) || e.username || e.password) return false;
  if (!isLoopbackHost(e.hostname)) return false;
  if (u.protocol !== e.protocol || u.username || u.password || u.search || u.hash) return false;
  const host = u.host.toLowerCase();
  const endpointHost = e.host.toLowerCase();
  if (host === `${bucketLower}.${endpointHost}`) return u.pathname.length > 1;
  if (host !== endpointHost) return false;
  const prefix = `${e.pathname.replace(/\/+$/, '')}/${bucketLower}/`.toLowerCase();
  const path = u.pathname.toLowerCase();
  return path.startsWith(prefix) && path.length > prefix.length;
}

/**
 * Is `url` an object URL in OUR upload bucket — what the platform's upload
 * endpoint (POST /users/upload-file, multer-s3 into AWS_S3_BUCKET) hands the
 * FE as `file_path`? The platform stores full URLs, never bare keys, so a bare
 * key is refused too.
 *
 * Accepted, over https only, for bucket B and region R (AWS_S3_BUCKET /
 * AWS_REGION unless overridden):
 *   virtual-hosted  https://B.s3.R.amazonaws.com/<key>   (what multer-s3 returns)
 *                   https://B.s3.amazonaws.com/<key>     (legacy global form)
 *   path-style      https://s3.R.amazonaws.com/B/<key>
 *                   https://s3.amazonaws.com/B/<key>
 * The host must match EXACTLY (so `B.s3.amazonaws.com.evil.com` fails), the
 * key must be non-empty, and a URL carrying credentials, a port, a query (a
 * presigned, expiring URL) or a fragment is refused. Paths are compared after
 * WHATWG normalisation, so `/B/../other/x` (path-style) cannot leave the
 * bucket; inside a virtual-hosted URL every path is in our bucket anyway.
 * No bucket configured → nothing is ours.
 *
 * Local/E2E only: when AWS_ENDPOINT_URL_S3 is set to a loopback or *.localhost
 * endpoint (a local S3 sink; unset in production), objects at `<bucket>.<endpoint host>/<key>` (virtual-hosted, what
 * multer-s3 returns for the sink) and `<endpoint>/<bucket>/<key>` (path-style)
 * are ours too, with the same rules (exact origin, no credentials/query/
 * fragment, non-empty key, normalised path stays inside the bucket prefix).
 */
export function isOwnUploadUrl(url, {
  bucket = process.env.AWS_S3_BUCKET,
  region = process.env.AWS_REGION,
  endpoint = process.env.AWS_ENDPOINT_URL_S3,
} = {}) {
  if (typeof url !== 'string' || !url || url.length > MAX_LEN.file_url) return false;
  const b = String(bucket ?? '').trim().toLowerCase();
  const r = String(region ?? '').trim().toLowerCase();
  if (!b) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (isOwnEndpointUrl(u, b, endpoint)) return true;
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return false;
  const host = u.hostname.toLowerCase();
  const virtualHosts = [`${b}.s3.amazonaws.com`, ...(r ? [`${b}.s3.${r}.amazonaws.com`] : [])];
  const pathStyleHosts = ['s3.amazonaws.com', ...(r ? [`s3.${r}.amazonaws.com`] : [])];
  if (virtualHosts.includes(host)) return u.pathname.length > 1;
  if (pathStyleHosts.includes(host)) {
    const prefix = `/${b}/`;
    return u.pathname.startsWith(prefix) && u.pathname.length > prefix.length;
  }
  return false;
}

export default {
  USABLE_VARIANT_SQL, FIRST_CATEGORY_SQL, describeVariants, isUsableVariant, variantCategoryId, contractCoverage, guardCatalogLines,
  isOwnUploadUrl,
};
