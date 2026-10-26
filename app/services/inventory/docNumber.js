// Inventory document numbers: {DOC}/{doc_code}/{FY}/{seq5}, e.g.
// GRN/46/2026-27/00012. One sequence per (hotel, doc type, Indian FY).
//
// Call it inside the posting transaction. The upsert's ON CONFLICT DO UPDATE
// takes the sequence row lock until that transaction ends, so concurrent posts
// for the same hotel and type get distinct, consecutive numbers, and a rolled
// back post gives its number back (no gaps, no duplicates; unlike
// getNextPONumber's read-then-write).

import { financialYearOf } from '../../helper/financialYear.js';
import { InventoryError } from './errors.js';

export const DOC_TYPES = Object.freeze(['GRN', 'RTV', 'DSP', 'OUT', 'RET', 'ADJ', 'CNT']);

/**
 * @param {object} t pg-promise transaction (the posting transaction)
 * @param {{hotelId:number, docType:string, date?:string|Date}} args
 *   date is the document's business date and picks the FY (IST wall clock;
 *   'YYYY-MM-DD' strings are read as IST). Defaults to now.
 * @returns {Promise<string>}
 */
export async function nextDocNumber(t, { hotelId, docType, date } = {}) {
  if (!DOC_TYPES.includes(docType)) {
    throw new InventoryError('VALIDATION', `Unknown document type ${docType}`, { field: 'docType' });
  }
  const hotel = Number(hotelId);
  if (!Number.isInteger(hotel) || hotel <= 0) {
    throw new InventoryError('VALIDATION', 'Invalid hotel', { field: 'hotelId' });
  }
  let fy;
  try {
    fy = financialYearOf(date ?? null);
  } catch {
    throw new InventoryError('VALIDATION', 'Invalid document date', { field: 'date' });
  }

  const row = await t.oneOrNone(
    `WITH seq AS (
       INSERT INTO tbl_inv_doc_sequence (hotel_id, doc_type, fy, hospitality_company_id, last_no)
       SELECT h.id, $2, $3, h.hospitality_company_id, 1
         FROM tbl_hospitality_company_hotels h
        WHERE h.id = $1
       ON CONFLICT (hotel_id, doc_type, fy) DO UPDATE
         SET last_no = tbl_inv_doc_sequence.last_no + 1, updated_at = now()
       RETURNING hotel_id, last_no
     )
     SELECT seq.last_no, hs.doc_code
       FROM seq
       LEFT JOIN tbl_inv_hotel_settings hs ON hs.hotel_id = seq.hotel_id`,
    [hotel, docType, fy]
  );
  if (!row) throw new InventoryError('NOT_FOUND', 'Hotel not found');

  const docCode = row.doc_code || String(hotel);
  return `${docType}/${docCode}/${fy}/${String(row.last_no).padStart(5, '0')}`;
}

export default { nextDocNumber, DOC_TYPES };
