// An award names its quote line by id, and those ids come from the request
// body (POST /rfq/finalize) or from the finalize body parked in a
// NEGOTIATION_QUOTE approval (po_payload). Gating the RFQ says nothing about
// them: buildAuthoritativePOPayload copied the unit price, tax and charges of
// whatever tbl_quote_items row the id named, and draftPO the global charges of
// its quote, so a buyer awarding their own RFQ could pass another tenant's
// quote line and read that vendor's pricing back on their own PO.
//
// bindAwardQuote ties the ids to the RFQ being awarded, in one read:
//   - the quote line exists and its quote is on THIS rfq;
//   - the RFQ product being awarded is on THIS rfq;
//   - the quote was submitted by the awarded vendor;
//   - the line is for that product's variant;
//   - the parent quote id, when the caller has one, is the line's quote.
// An id that is unknown or belongs to another RFQ is a 404, the same answer
// either way, so the refusal never confirms a foreign row exists. A mismatch
// inside this RFQ is a 400.
//
// It is called from finalize's pre-flight (before anything is written), from
// the approval pre-flights for a parked payload (before the approval is
// recorded), and from buildAuthoritativePOPayload and draftPO themselves, so a
// PO line can not be priced or written from an unbound id by any caller.
// bindSelectedQuotes is the same check for the other award an approval can
// carry, the selected_quotes of a submit-for-approval.

import { PoDecisionError } from './poDecisionError.js';

const NOT_ON_RFQ = 'This quote line is not part of this RFQ.';
const PRODUCT_NOT_ON_RFQ = 'The product being awarded is not part of this RFQ.';
const OTHER_VENDOR = 'This quote line was not submitted by the vendor being awarded.';
const OTHER_PRODUCT = 'This quote line is for a different product than the one being awarded.';
const OTHER_QUOTE = 'The quote does not match this quote line.';
const OTHER_AWARDED_PRODUCT = 'product_info names a different product than the one being awarded.';
const BAD_IDS = 'The award does not name a valid quote line, product and vendor.';

const notFound = (message) => new PoDecisionError(message, { code: 'AWARD_QUOTE_NOT_FOUND', httpStatus: 404 });
const mismatch = (message) => new PoDecisionError(message, { code: 'AWARD_QUOTE_MISMATCH', httpStatus: 400 });

const PG_INT_MAX = 2147483647;
/** An id as an int: a JS integer or a numeric string naming one; else null. */
const toId = (value) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= PG_INT_MAX ? n : null;
};

/**
 * Bind an award's quote line to the RFQ product being awarded.
 *
 * @param {object} dbCtx  db or a transaction
 * @param {object} ids
 * @param {*} ids.rfqId          the RFQ being awarded (already gated by the caller)
 * @param {*} ids.rfqProductId   the tbl_rfq_products row being awarded
 * @param {*} ids.vendorId       the vendor being awarded
 * @param {*} ids.quoteItemId    the tbl_quote_items row the award prices from
 * @param {*} [ids.quoteId]      the parent tbl_quotes id, when the caller sent one
 * @returns {Promise<{rfq_id:number, rfq_product_id:number, vendor_id:number, quote_id:number, quote_item_id:number}>}
 * @throws PoDecisionError 404 AWARD_QUOTE_NOT_FOUND | 400 AWARD_QUOTE_MISMATCH
 */
export async function bindAwardQuote(dbCtx, { rfqId, rfqProductId, vendorId, quoteItemId, quoteId }) {
  const rfq = toId(rfqId);
  const rfqProduct = toId(rfqProductId);
  const vendor = toId(vendorId);
  const item = toId(quoteItemId);
  if (!rfq || !rfqProduct || !vendor || !item) throw mismatch(BAD_IDS);

  const row = await dbCtx.oneOrNone(
    `SELECT qi.id AS quote_item_id, qi.quote_id, qi.rfq_id AS item_rfq_id,
            q.rfq_id AS quote_rfq_id, q.created_by AS quote_vendor_id,
            (rp.id IS NOT NULL) AS product_on_rfq,
            (qi.product_variant_id = rp.product_variant_id
               AND qi.variant IS NOT DISTINCT FROM rp.variant) AS same_product
       FROM tbl_quote_items qi
       JOIN tbl_quotes q ON q.id = qi.quote_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = $2 AND rp.rfq_id = $3
      WHERE qi.id = $1`,
    [item, rfqProduct, rfq]
  );

  // Unknown, or another RFQ's: one answer.
  if (!row || Number(row.quote_rfq_id) !== rfq || Number(row.item_rfq_id) !== rfq) throw notFound(NOT_ON_RFQ);
  if (!row.product_on_rfq) throw notFound(PRODUCT_NOT_ON_RFQ);
  if (Number(row.quote_vendor_id) !== vendor) throw mismatch(OTHER_VENDOR);
  if (!row.same_product) throw mismatch(OTHER_PRODUCT);
  if (quoteId !== undefined && quoteId !== null && toId(quoteId) !== Number(row.quote_id)) throw mismatch(OTHER_QUOTE);

  return {
    rfq_id: rfq,
    rfq_product_id: rfqProduct,
    vendor_id: vendor,
    quote_id: Number(row.quote_id),
    quote_item_id: Number(row.quote_item_id),
  };
}

/**
 * Bind a PO payload: finalize's body, or the copy of it parked in a
 * NEGOTIATION_QUOTE approval (po_payload), or a server-built payload. The PO
 * header carries product_info.finalized_vendor_id, so that is the vendor bound;
 * a top-level vendor_id that disagrees with it is refused. The parked copy has
 * quote_id overwritten with the quote line id, so only quote_item_id (falling
 * back to quote_id, as buildAuthoritativePOPayload reads it) is bound here.
 *
 * @throws PoDecisionError as bindAwardQuote
 */
export async function bindPoPayload(dbCtx, poInfo = {}) {
  const info = poInfo.product_info || {};
  const headerVendor = info.finalized_vendor_id ?? poInfo.vendor_id;
  if (
    info.finalized_vendor_id != null && poInfo.vendor_id != null
    && toId(info.finalized_vendor_id) !== toId(poInfo.vendor_id)
  ) {
    throw mismatch(OTHER_VENDOR);
  }
  return bindAwardQuote(dbCtx, {
    rfqId: poInfo.rfq_id,
    rfqProductId: info.rfq_product_id,
    vendorId: headerVendor,
    quoteItemId: poInfo.quote_item_id || poInfo.quote_id,
  });
}

/**
 * POST /rfq/finalize's binding, before anything is written. The product being
 * awarded is the RFQ's own row for the body's product_variant_id + variant
 * (`rfqProductId`, looked up by the caller on the gated rfq_id); the body's
 * product_info must name that same row and, when it carries a vendor, the
 * awarded vendor; and the quote line, and its parent quote, must bind to it.
 *
 * @param {object} dbCtx
 * @param {object} args
 * @param {object} args.body          the finalize request body
 * @param {*}      args.rfqProductId  the RFQ product row being awarded, or null
 * @throws PoDecisionError as bindAwardQuote
 */
export async function bindFinalizeAward(dbCtx, { body, rfqProductId }) {
  if (!rfqProductId) throw notFound(PRODUCT_NOT_ON_RFQ);
  const info = body.product_info;
  if (info) {
    if (toId(info.rfq_product_id) !== toId(rfqProductId)) throw mismatch(OTHER_AWARDED_PRODUCT);
    if (info.finalized_vendor_id != null && toId(info.finalized_vendor_id) !== toId(body.vendor_id)) {
      throw mismatch(OTHER_VENDOR);
    }
  }
  return bindAwardQuote(dbCtx, {
    rfqId: body.rfq_id,
    rfqProductId,
    vendorId: body.vendor_id,
    quoteItemId: body.quote_item_id,
    quoteId: body.quote_id,
  });
}

const INSTANCE_NOT_ON_RFQ = "This approval's award is not for a product of an RFQ of its company.";

/**
 * The approval instance must be its own company's award: the RFQ the metadata
 * names belongs to the instance's hospitality company, and the instance's
 * product (entity_id) is on that RFQ. The metadata is written by the server
 * flow that opened the instance, but the binding below only ties the quote
 * ids to `metadata.rfq_id`; an instance whose metadata names another
 * company's RFQ (one opened through the generic submit route before it was
 * closed to these types) would bind against that company's quotes and draft
 * a PO on its RFQ. One 404 whatever the reason.
 *
 * @param {object} dbCtx
 * @param {object} instance  the tbl_approval_instances row (hospitality_company_id, entity_id)
 * @param {*} rfqId          the RFQ the instance's metadata awards
 * @throws PoDecisionError 404 AWARD_QUOTE_NOT_FOUND
 */
async function bindInstanceToRfq(dbCtx, instance, rfqId) {
  const company = toId(instance?.hospitality_company_id);
  const rfqProduct = toId(instance?.entity_id);
  const rfq = toId(rfqId);
  if (!company || !rfqProduct || !rfq) throw notFound(INSTANCE_NOT_ON_RFQ);
  const row = await dbCtx.oneOrNone(
    `SELECT 1
       FROM tbl_rfq r
       JOIN tbl_rfq_products rp ON rp.id = $2 AND rp.rfq_id = r.id
      WHERE r.id = $1 AND r.hospitality_company_id = $3`,
    [rfq, rfqProduct, company]
  );
  if (!row) throw notFound(INSTANCE_NOT_ON_RFQ);
}

/** Does this approval instance belong to the company that owns `rfqId`? (No throw.) */
export async function instanceOwnsRfq(dbCtx, instance, rfqId) {
  try {
    await bindInstanceToRfq(dbCtx, instance, rfqId);
    return true;
  } catch (e) {
    if (e instanceof PoDecisionError) return false;
    throw e;
  }
}

/**
 * Does this approval instance belong to the company that owns the RFQ
 * negotiation round `roundId`? A NEGOTIATION instance names its round by
 * metadata.round_id (or entity_id), and its handlers activate or cancel that
 * round: the round's RFQ must be the instance company's. An ARC-sourced round,
 * an unknown id or a missing company is false.
 *
 * @param {object} dbCtx
 * @param {object} instance  the tbl_approval_instances row (hospitality_company_id)
 * @param {*} roundId
 * @returns {Promise<boolean>}
 */
export async function instanceOwnsRound(dbCtx, instance, roundId) {
  const company = toId(instance?.hospitality_company_id);
  const round = toId(roundId);
  if (!company || !round) return false;
  const row = await dbCtx.oneOrNone(
    `SELECT 1
       FROM tbl_negotiation_rounds nr
       JOIN tbl_rfq r ON r.id = nr.rfq_id
      WHERE nr.id = $1 AND COALESCE(nr.source_type, 'RFQ') = 'RFQ' AND r.hospitality_company_id = $2`,
    [round, company]
  );
  return !!row;
}

const PO_USER_NOT_INITIATOR = "This approval's parked award names a different user than the one who opened it.";

/**
 * A NEGOTIATION_QUOTE approval's parked award (metadata.po_payload, written by
 * finalize), checked before the approval that turns it into a PO is recorded.
 * The instance must be its company's award of a product on that company's
 * RFQ (bindInstanceToRfq); the payload must bind (bindPoPayload) and must be
 * the award of the product the instance is for (entity_id is the rfq_product
 * id) on the RFQ the instance names; a parked po_user must be the instance's
 * initiator. An instance with no po_payload has nothing to bind.
 *
 * @param {object} dbCtx
 * @param {object} instance  the tbl_approval_instances row: { entity_id, hospitality_company_id, initiated_by, metadata }
 * @throws PoDecisionError as bindAwardQuote
 */
export async function bindParkedAward(dbCtx, instance = {}) {
  const { entity_id: entityId, metadata } = instance;
  const meta = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
  const payload = meta.po_payload;
  if (!payload) return null;
  if (toId(payload.product_info?.rfq_product_id) !== toId(entityId)) throw mismatch(OTHER_AWARDED_PRODUCT);
  if (meta.rfq_id != null && toId(meta.rfq_id) !== toId(payload.rfq_id)) throw notFound(NOT_ON_RFQ);
  // finalize parks po_user = the finalizing user, who is also the instance's
  // initiator; the PO is drafted in that user's name. Anything else was not
  // written by finalize.
  if (meta.po_user != null && toId(meta.po_user?.id) !== toId(instance.initiated_by)) {
    throw mismatch(PO_USER_NOT_INITIATOR);
  }
  await bindInstanceToRfq(dbCtx, instance, payload.rfq_id);
  return bindPoPayload(dbCtx, payload);
}

const SELECTED_NOT_ON_PRODUCT = "A selected quote is not this RFQ product's quote by that vendor.";

/**
 * A NEGOTIATION_QUOTE approval's selected_quotes (written by
 * submit-for-approval), checked before the approval that awards them is
 * recorded. approveQuotes turns each entry into a finalization row and, off
 * the tender path, a PO line priced at the entry's quoted_price, so every
 * entry must still be a quote of THIS rfq product by the vendor it names.
 * Submit binds them now (getQuotesByIds / getRegularQuotesByIds), but an
 * instance parked before the round-quote ids were scoped was never bound.
 *
 * An entry's source is told apart by its shape: one sourced from a
 * negotiation round always carries `negotiation_round_id` (copied from the
 * round quote row, where it is NOT NULL); one sourced from tbl_quotes never
 * does.
 *   - round:   a tbl_negotiation_round_quotes row of an RFQ-sourced round of
 *              this rfq, for this product (COALESCE(nrq.rfq_product_id,
 *              nr.rfq_product_id): older round quotes left their own column
 *              NULL), by the entry's vendor;
 *   - regular: a tbl_quotes row of this rfq, by the entry's vendor, with a
 *              line for this product's variant.
 * An entry that does not bind is a 404, one answer whatever the reason, so it
 * never says whether a foreign quote exists. An instance without
 * selected_quotes, or without the rfq_id the award needs, has nothing to bind.
 *
 * The instance must be its company's award of a product on that company's
 * RFQ first (bindInstanceToRfq).
 *
 * @param {object} dbCtx
 * @param {object} instance  the tbl_approval_instances row: { entity_id, hospitality_company_id, metadata }
 * @throws PoDecisionError 404 AWARD_QUOTE_NOT_FOUND | 400 AWARD_QUOTE_MISMATCH
 */
export async function bindSelectedQuotes(dbCtx, instance = {}) {
  const { entity_id: entityId, metadata } = instance;
  const meta = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
  const entries = meta.selected_quotes;
  if (!Array.isArray(entries) || entries.length === 0 || meta.rfq_id == null) return null;

  const rfq = toId(meta.rfq_id);
  const rfqProduct = toId(entityId);
  if (!rfq || !rfqProduct) throw mismatch(BAD_IDS);
  await bindInstanceToRfq(dbCtx, instance, rfq);

  for (const entry of entries) {
    const quote = toId(entry?.quote_id);
    const vendor = toId(entry?.vendor_id);
    if (!quote || !vendor) throw mismatch(BAD_IDS);

    const fromRound = entry.negotiation_round_id !== undefined;
    const row = fromRound
      ? await dbCtx.oneOrNone(
        `SELECT 1
           FROM tbl_negotiation_round_quotes nrq
           JOIN tbl_negotiation_rounds nr ON nr.id = nrq.negotiation_round_id
          WHERE nrq.id = $1 AND nr.source_type = 'RFQ' AND nr.rfq_id = $2
            AND COALESCE(nrq.rfq_product_id, nr.rfq_product_id) = $3
            AND nrq.vendor_id = $4`,
        [quote, rfq, rfqProduct, vendor]
      )
      : await dbCtx.oneOrNone(
        `SELECT 1
           FROM tbl_quotes q
           JOIN tbl_rfq_products rp ON rp.id = $3 AND rp.rfq_id = q.rfq_id
          WHERE q.id = $1 AND q.rfq_id = $2 AND q.created_by = $4
            AND EXISTS (SELECT 1 FROM tbl_quote_items qi
                         WHERE qi.quote_id = q.id
                           AND qi.product_variant_id = rp.product_variant_id
                           AND qi.variant IS NOT DISTINCT FROM rp.variant)`,
        [quote, rfq, rfqProduct, vendor]
      );
    if (!row) throw notFound(SELECTED_NOT_ON_PRODUCT);
  }
  return entries.length;
}

/** The refusal for a quote line that is not (or no longer) on its RFQ. */
export const awardQuoteNotFound = () => notFound(NOT_ON_RFQ);

/**
 * The vendor quote line a selected_quotes entry is priced from, on this RFQ
 * product (null when the vendor has no line for it).
 *
 * Never the entry's own quoted_price. That figure is parked in the instance
 * metadata, and for a negotiation-round entry it is the round quote's
 * quoted_price, which is the landed LINE total the vendor re-quoted
 * (rfqController writes quoteItem.total_price into it), not a unit price:
 * pricing the PO line's unit_price from it multiplied the award by the
 * quantity. The vendor's re-quote updates their quote line itself, so the line
 * carries the negotiated rate either way.
 *   - a regular entry: the line of the very quote that was selected;
 *   - a round entry:   the vendor's latest line for this product on this RFQ.
 *
 * @param {object} dbCtx
 * @param {object} args { rfqId, rfqProductId, entry }
 * @returns {Promise<{quote_item_id:number, quantity:string}|null>}
 */
export async function selectedQuoteLine(dbCtx, { rfqId, rfqProductId, entry }) {
  const fromRound = entry?.negotiation_round_id !== undefined;
  return dbCtx.oneOrNone(
    `SELECT qi.id AS quote_item_id, qi.quantity
       FROM tbl_quote_items qi
       JOIN tbl_quotes q ON q.id = qi.quote_id
       JOIN tbl_rfq_products rp ON rp.id = $2 AND rp.rfq_id = q.rfq_id
      WHERE q.rfq_id = $1 AND qi.rfq_id = q.rfq_id AND q.created_by = $3
        AND qi.product_variant_id = rp.product_variant_id
        AND qi.variant IS NOT DISTINCT FROM rp.variant
        AND ($4::int IS NULL OR q.id = $4::int)
      ORDER BY q.timestamp DESC, qi.id DESC
      LIMIT 1`,
    [toId(rfqId), toId(rfqProductId), toId(entry?.vendor_id), fromRound ? null : toId(entry?.quote_id)]
  );
}
