// One call-off PO line through the pricing engine, and its GST broken down for documents.
//
// The engine input built here is the ONE mapping from a contract line's pricing
// (base rate, GST %, canonical ARC charges) to pricingEngine.calculateLineTotal. The
// release stores the line total from it (callOffPoService), and the PO document and the
// PO detail API split its tax from it, so the printed taxable value and tax rows always
// add up to the stored total_price.

import pricingEngine from '../../services/pricingEngine.js';
import { normalizeArcCharges } from '../../models/arc_v2/arcEvaluationModel.js';
import { taxLinesFor, summarizeTaxLines } from '../gstState.js';

const isPct = (mode) => mode === 'percentage' || mode === '%';
const hasValue = (v) => v !== null && v !== undefined && v !== '';

/**
 * Engine input for a call-off line: base `unit_price` × `quantity`, GST `tax` as a
 * percentage, and the line's ARC charges (any stored shape; normalised here).
 */
export function callOffEngineInput({ unit_price, quantity, tax, other_charges }) {
  return {
    unit_price: Number(unit_price || 0),
    quantity:   Number(quantity || 0),
    tax:        Number(tax || 0),
    tax_mode:   'percentage',
    other_charges: normalizeArcCharges(other_charges).map((c) => ({
      name:        c.name ?? null,
      amount:      Number(c.amount ?? 0),
      amount_mode: isPct(c.amount_mode) ? 'percentage' : 'absolute',
      tax:         hasValue(c.tax) ? Number(c.tax) : null,
      tax_mode:    isPct(c.tax_mode) ? 'percentage' : 'absolute',
    })),
  };
}

/** pricingEngine.calculateLineTotal of a call-off line (see callOffEngineInput). */
export function computeCallOffLine(line) {
  return pricingEngine.calculateLineTotal(callOffEngineInput(line));
}

/**
 * A call-off line's GST, every component of it: the tax on the base and the tax on each
 * charge (a charge with no tax of its own inherits the GST rate, as the engine does),
 * grouped by rate and split by `split` (gstState.taxSplitFor; null = the single 'GST'
 * row).
 *
 * Reconciles in paise: taxable_value + Σ tax_lines.amount === total, the engine's line
 * total (= the stored total_price). Rounding left over after quantising each rate group
 * goes to the largest group.
 *
 * @returns {{ taxable_value: number, tax_lines: Array<{label, rate, amount}>, total: number }}
 */
export function callOffLineTax(line, split) {
  const input = callOffEngineInput(line);
  const out = pricingEngine.calculateLineTotal(input);
  const paise = (v) => Math.round(Number(v || 0) * 100);

  const groups = new Map(); // rate -> raw tax amount
  const add = (rate, amount) => {
    if (!(Number(amount) > 0)) return;
    groups.set(rate, (groups.get(rate) || 0) + Number(amount));
  };
  add(input.tax, out.base_tax);
  out.charges.forEach((c, i) => {
    const src = input.other_charges[i];
    let rate;
    if (hasValue(src.tax)) {
      rate = src.tax_mode === 'percentage'
        ? src.tax
        : (c.amount > 0 ? Math.round((c.tax / c.amount) * 10000) / 100 : null);
    } else {
      rate = input.tax;
    }
    add(rate, c.tax);
  });

  const totalPaise = paise(out.total);
  const rows = [...groups.entries()].map(([rate, amount]) => ({ rate, paise: paise(amount) }));
  const taxablePaise = rows.length
    ? paise(out.base) + out.charges.reduce((s, c) => s + paise(c.amount), 0)
    : totalPaise;
  if (rows.length) {
    const drift = (totalPaise - taxablePaise) - rows.reduce((s, r) => s + r.paise, 0);
    rows.reduce((big, r) => (r.paise > big.paise ? r : big), rows[0]).paise += drift;
  }
  return {
    taxable_value: taxablePaise / 100,
    tax_lines: summarizeTaxLines(rows.flatMap((r) => taxLinesFor(split, r.rate, r.paise / 100))),
    total: totalPaise / 100,
  };
}

/**
 * The GST breakdown of a whole call-off PO: Σ taxable values and the tax rows summed by
 * (label, rate). `lines` are tbl_purchase_order_product rows (unit_price, quantity,
 * charges_meta) — charges_meta carries the GST rate and the charges the release used.
 */
export function callOffPoTax(lines, split) {
  let taxablePaise = 0;
  const all = [];
  for (const l of lines) {
    const cm = l.charges_meta || {};
    const t = callOffLineTax({ unit_price: l.unit_price, quantity: l.quantity, tax: cm.tax, other_charges: cm.other_charges }, split);
    taxablePaise += Math.round(t.taxable_value * 100);
    all.push(...t.tax_lines);
  }
  return { taxable_value: taxablePaise / 100, tax_lines: summarizeTaxLines(all) };
}
