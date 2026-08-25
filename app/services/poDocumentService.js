import { logger } from '../util/logger.js';
import seoController from '../controllers/seo/seoController.js';
import { uploadToS3 } from '../models/generalModel.js';

/**
 * Writing a PO's document: render, upload, store the URL.
 *
 * This used to live inline in `regeneratePODocument`, where every step could
 * fail quietly. Two of them turned failure into a fake success:
 *
 *   - `uploadToS3` RETURNS `{ok:false}` instead of throwing, and the caller
 *     read `s3Url.url || pdfResult.file`. So an S3 failure stored the
 *     container-local path `/app/storage/invoices/po-483.pdf` into
 *     `po_pdf_url`, logged "Regenerated PO document", and returned truthy.
 *     That column is what the buyer's download link and the vendor's
 *     acceptance email point at.
 *
 *   - a render failure returned `null`, which both callers then caught again.
 *
 * The contract here is deliberately narrow: this function either stores a URL
 * a vendor can open, or it throws. Nothing in between, and no logging-and-
 * carrying-on. Its caller runs inside the approval transaction and needs a
 * thrown error to roll that approval back.
 *
 * Dependencies are injected so the failure paths can be exercised without a
 * Chromium or an S3 bucket.
 */

const isFetchableUrl = (url) => typeof url === 'string' && /^https:\/\/\S+$/.test(url);

/**
 * Raised when a PO document cannot be produced or stored.
 *
 * Distinct from every other failure the approve endpoint can hit, because it
 * gets a distinct answer: a document failure means "nothing was recorded,
 * please approve again", while an authorization failure or a dead connection
 * means something else entirely. Telling an approver to retry when the real
 * problem is that they are not an approver would be its own small lie.
 */
export class PoDocumentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PoDocumentError';
  }
}

/**
 * Does this database have the watchdog bookkeeping columns yet?
 *
 * backend/.github/workflows/deploy-prod.yml has NO migration step — it builds
 * an image, pushes it to ECR and restarts the container over SSH. Migrations
 * are applied by hand, separately. So this code will, at least briefly, run
 * against a schema that predates 20260825120000_po_document_generation_state.
 *
 * `po_document_*` are watchdog bookkeeping; `po_pdf_url` is the contract. If a
 * missing bookkeeping column could fail the write, a deploy that ran ahead of
 * its migration would turn "some documents go stale" into "no purchase order
 * can be approved" — strictly worse than the bug being fixed here.
 *
 * A probe, not a try/catch fallback: this write runs inside the approval
 * transaction, and in Postgres a failed statement aborts the transaction
 * (25P02), so a retry after the error would fail too. A read is safe there.
 * Cached per process — one round trip, not one per approval.
 */
const defaultColumnProbe = (() => {
  let cached = null;
  return async (conn) => {
    if (cached !== null) return cached;
    const row = await conn.oneOrNone(
      `SELECT 1 AS present
         FROM information_schema.columns
        WHERE table_name = 'tbl_rfq_purchase_order'
          AND column_name = 'po_document_generated_at'`
    );
    cached = Boolean(row);
    if (!cached) {
      logger.warn(
        'tbl_rfq_purchase_order is missing po_document_* columns — PO documents will still be ' +
        'written, but the document watchdog is inert until migration ' +
        '20260825120000_po_document_generation_state is applied.'
      );
    }
    return cached;
  };
})();

export function createPoDocumentWriter({
  render,
  upload,
  clock = () => Date.now(),
  hasDocumentStateColumns = defaultColumnProbe,
}) {
  // Memoised here too, so an injected probe is also called only once.
  let columnsPresent = null;
  /**
   * @param {number} poId
   * @param {Object} conn - db or an open transaction. MUST be the approval's
   *   transaction when called during an approval: the document has to be built
   *   from the not-yet-committed approver rows so it prints this approval.
   * @returns {Promise<string>} the stored https URL
   * @throws if the document cannot be rendered, uploaded, or stored
   */
  return async function writePoDocument(poId, conn) {
    const po = await conn.oneOrNone(
      `SELECT PO.id, PO.po_number, PO.company_id,
              RFQ.hospitality_company_id, RFQ.hotel_id
         FROM tbl_rfq_purchase_order PO
         JOIN tbl_rfq RFQ ON RFQ.id = PO.rfq_id
        WHERE PO.id = $1`,
      [poId]
    );

    if (!po) throw new PoDocumentError(`Cannot generate PO document: PO ${poId} not found`);

    let rendered;
    try {
      rendered = await render(po, conn);
    } catch (err) {
      // Keeps the original on `.cause` — the Chromium or Handlebars message is
      // what makes a log entry actionable.
      throw new PoDocumentError(`PO ${poId} document render failed: ${err.message}`, { cause: err });
    }

    const absolutePath = rendered?.absolutePath;
    if (!absolutePath) {
      throw new PoDocumentError(`PO ${poId} document render produced no file`);
    }

    // Timestamped key: each write is a new object, so a failed upload can
    // never half-overwrite the document currently being served.
    const uploadResult = await upload(absolutePath, `po-${po.po_number}-${clock()}.pdf`);

    if (!uploadResult?.ok) {
      throw new PoDocumentError(
        `PO ${poId} document upload failed: ${uploadResult?.error || 'unknown error'}`
      );
    }

    const url = uploadResult.url;
    if (!isFetchableUrl(url)) {
      // The bug that put local container paths in front of clients. A URL that
      // is not https is not a document — refuse it rather than store it.
      throw new PoDocumentError(
        `PO ${poId} document upload returned no https URL (got: ${url ?? 'nothing'})`
      );
    }

    if (columnsPresent === null) columnsPresent = await hasDocumentStateColumns(conn);

    await conn.none(
      columnsPresent
        ? `UPDATE tbl_rfq_purchase_order
              SET po_pdf_url = $1,
                  updated_at = NOW(),
                  -- Authoritative write time. The watchdog falls back to the
                  -- millisecond timestamp in the S3 key for rows predating this.
                  po_document_generated_at = NOW(),
                  po_document_attempts = 0,
                  po_document_failure_reason = NULL,
                  po_document_failure_notified_at = NULL
            WHERE id = $2`
        : `UPDATE tbl_rfq_purchase_order
              SET po_pdf_url = $1, updated_at = NOW()
            WHERE id = $2`,
      [url, poId]
    );

    logger.info({ poId, poNumber: po.po_number, url }, 'PO document written');
    return url;
  };
}


/**
 * Retry wrapper for the S3 upload.
 *
 * Rendering is local work — a template read, a browser we already own, a file
 * write. The upload is the one network hop, and it used to get a single
 * attempt: one dropped socket looked exactly like a permanent failure.
 *
 * That mattered less when a failed upload was silently ignored. Now that it
 * rolls the approver's approval back, a transient blip must not cost someone
 * their approval, so the transient shapes are retried with a short backoff.
 *
 * `uploadToS3` reports failure by RETURNING `{ok:false}` rather than throwing,
 * so both shapes are handled here.
 */
const RETRYABLE = /timeout|timed out|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|NetworkingError|ThrottlingException|SlowDown|RequestTimeout|503|500/i;

// Nothing a retry can fix: the file we were told to upload is not there.
const PERMANENT = /File not found/i;

export function withUploadRetry(upload, { attempts = 3, baseDelayMs = 250, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  return async function uploadWithRetry(filePath, key) {
    let last = { ok: false, error: 'upload never ran' };

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await upload(filePath, key);
        if (result?.ok) return result;
        last = result || last;
      } catch (err) {
        last = { ok: false, error: err.message || String(err) };
      }

      const reason = String(last.error || '');
      if (PERMANENT.test(reason)) return last;
      if (!RETRYABLE.test(reason)) return last;
      if (attempt === attempts) break;

      await wait(baseDelayMs * 2 ** (attempt - 1));
      logger.warn({ key, attempt, error: reason }, 'PO document upload failed; retrying');
    }

    return last;
  };
}

/**
 * The wired writer used in production: render on the shared Chromium, upload
 * to S3 with retry, store the URL. Throws if any of that fails.
 */
export const writePoDocument = createPoDocumentWriter({
  render: async (po, conn) =>
    seoController.poPDF(
      {
        po_id: po.id,
        company_id: po.company_id,
        hospitality_company_id: po.hospitality_company_id,
        hotel_id: po.hotel_id,
      },
      conn
    ),
  upload: withUploadRetry((filePath, key) => uploadToS3(filePath, key)),
});
