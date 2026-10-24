// Cost of one PO unit for stock valuation (spec §6.8).
//
// The PO line's TAXABLE unit rate, plus GST when the receiving hotel's
// effective include_gst_in_cost is set (a hotel that cannot claim ITC carries
// GST in its stock value). Freight and other charges are excluded: there is
// no landed cost. The caller divides by the unit-conversion factor to get the
// cost per stock unit.
//
// The money comes from the same helpers that price the PO documents, so the
// valuation never drifts from what the PO says:
//   - RFQ POs:     helper/poTemplatePricing.js (buildPOTemplatePricing), fed the
//                  line exactly as helper/poTemplateDataBuilder.js feeds it;
//   - call-off POs: helper/arc_v2/callOffLineTax.js (the one engine mapping the
//                  release, the call-off PDF and the PO detail all use).

import { InventoryError } from './errors.js';
import { getEffectiveSettings } from './settings.js';
import { buildPOTemplatePricing } from '../../helper/poTemplatePricing.js';
import { callOffEngineInput, computeCallOffLine } from '../../helper/arc_v2/callOffLineTax.js';

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Taxable base and GST rate of an RFQ PO line, through the PO template
 * pricing. The item shape mirrors poTemplateDataBuilder's line query.
 */
function rfqLinePricing(line, quantity) {
  const cm = line.charges_meta || {};
  const item = {
    id: line.id,
    quantity,
    unit: line.unit,
    unit_price: line.unit_price,
    tax: cm.tax ?? 0,
    tax_mode: cm.tax_mode ?? null,
    freight_price: cm.freight_price ?? 0,
    freight_mode: cm.freight_mode ?? null,
    package_price: cm.package_price ?? 0,
    package_mode: cm.package_mode ?? null,
    other_charges: Array.isArray(cm.other_charges) ? cm.other_charges : [],
  };
  // The tax mode (split / igst / gst) only labels the tax rows; the taxable
  // amount and the effective rate do not depend on it.
  const [priced] = buildPOTemplatePricing([item], 'gst', []).items;
  return { lineBase: Number(priced.taxable_amount), gstPct: Number(priced.effective_tax_rate) };
}

/**
 * Taxable base and GST rate of a call-off PO line. The GST rate is the stored
 * charges_meta.tax, else the contract line's gst_pct (as the call-off PDF reads it).
 */
function callOffLinePricing(line, quantity) {
  const cm = line.charges_meta || {};
  const engineLine = {
    unit_price: line.unit_price,
    quantity,
    tax: cm.tax ?? line.contract_gst_pct ?? 0,
    other_charges: cm.other_charges,
  };
  const out = computeCallOffLine(engineLine);
  return { lineBase: Number(out.base), gstPct: Number(callOffEngineInput(engineLine).tax) };
}

/**
 * @param {object} t transaction
 * @param {{poLineId:number, hotelId:number, companyId:number}} args  hotelId is
 *   the RECEIVING hotel (its include_gst_in_cost override applies); companyId
 *   is the PO's hospitality company (trusted, from getPoContext).
 * @returns {Promise<{taxableUnitRate:number, gstPct:number, costPerPoUnit:number}>}
 *   per PO unit, rounded to 6 dp. costPerPoUnit = taxableUnitRate ×
 *   (includeGstInCost ? 1 + gstPct/100 : 1).
 * @throws InventoryError VALIDATION (poLineId | companyId | hotelId), NOT_FOUND
 *   when the PO line does not exist.
 */
export async function resolvePoLineUnitCost(t, { poLineId, hotelId, companyId } = {}) {
  const id = positiveInt(poLineId);
  if (!id) throw new InventoryError('VALIDATION', 'Invalid PO line', { field: 'poLineId' });

  const line = await t.oneOrNone(
    `SELECT pop.id, pop.quantity::text AS quantity, pop.unit, pop.unit_price::text AS unit_price,
            pop.charges_meta, po.is_call_off, cl.gst_pct::text AS contract_gst_pct
       FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_purchase_order po ON po.id = pop.purchase_order_id
       LEFT JOIN tbl_arc_contract_line cl ON cl.id = pop.arc_contract_line_id
      WHERE pop.id = $1`,
    [id]
  );
  if (!line) throw new InventoryError('NOT_FOUND', 'PO line not found', { poLineId: id });

  // Price the line at its real quantity (absolute tax / charges are per line);
  // a zero-quantity line is priced per one unit instead.
  const ordered = Number(line.quantity);
  const quantity = ordered > 0 ? ordered : 1;
  const { lineBase, gstPct } = line.is_call_off
    ? callOffLinePricing(line, quantity)
    : rfqLinePricing(line, quantity);

  const settings = await getEffectiveSettings(t, { companyId, hotelId });
  const taxableUnitRate = round6(lineBase / quantity);
  const gst = Number.isFinite(gstPct) ? gstPct : 0;
  const costPerPoUnit = round6(settings.includeGstInCost ? taxableUnitRate * (1 + gst / 100) : taxableUnitRate);
  return { taxableUnitRate, gstPct: gst, costPerPoUnit };
}

export default { resolvePoLineUnitCost };
