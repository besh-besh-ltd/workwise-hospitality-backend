// Pricing engine: the single source of truth for quote/PO money math.
//
// Pure functions — no DB, no I/O, no HTTP. Everything here is deterministic and
// safe to unit-test. Controllers and models call into this module both on
// writes (to overwrite client-supplied totals) and on the live-preview endpoint.
//
// Canonical input shape for a line item:
//   { unit_price, quantity, tax, tax_mode, other_charges: [...] }
// Where each charge is:
//   { name, amount, amount_mode, tax, tax_mode, slug?, comment? }
//
// Modes are the strings 'percentage' or 'absolute'. They default to 'percentage'
// when undefined, matching the legacy frontend behavior.
//
// Tax inheritance for charges:
//   - explicit non-zero charge.tax wins.
//   - else, if the line's base tax_mode is 'percentage' and base tax > 0,
//     the charge inherits the base rate (applied to the charge amount).
//   - else, no tax on the charge.
//
// Rounding strategy:
//   - Intermediates inside the engine stay raw float so chained percentage
//     calculations don't accumulate rounding error.
//   - At the *return boundary* every money field (base, base_tax, each
//     charge's amount/tax/subtotal, charges_total, total, grand_total) is
//     quantised to 2 decimals via `q2`. This matches the DB column type
//     (numeric(15,2)) so the buyer's recomputed engine output looks
//     identical to the vendor's persisted total_price — no 14-digit float
//     drift in the API response.

const DEFAULT_MODE = "percentage";

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

// Quantise to 2 decimal places. Used only at the engine's return boundary;
// internal arithmetic stays raw.
const q2 = (value) => Math.round(toNumber(value) * 100) / 100;

const isPercentageMode = (mode) => (mode ?? DEFAULT_MODE) === "percentage";

export const applyChargeMode = (value, mode, base) => {
  const v = toNumber(value);
  return isPercentageMode(mode) ? (toNumber(base) * v) / 100 : v;
};

// Tri-state semantics for charge.tax:
//   null / undefined / ""  → inherit base rate (when base tax_mode is %)
//   0 (number)             → explicit no tax (never inherits)
//   <positive number>      → explicit rate in charge.tax_mode
// Anything that is "present" — i.e. not null/undefined/"" — is treated as
// explicit, even if it's zero. Vendors who want a charge with no tax type 0
// in the input; vendors who want inheritance leave the field blank.
const hasExplicitChargeTax = (charge) =>
  charge?.tax !== null &&
  charge?.tax !== undefined &&
  charge?.tax !== "";

// Compute one line's total. Returns the engine output that callers persist
// and that the frontend renders.
export const calculateLineTotal = (line = {}) => {
  const unitPrice = toNumber(line.unit_price);
  const quantity = toNumber(line.quantity);
  const base = unitPrice * quantity;

  if (base <= 0) {
    return {
      base: 0,
      base_tax: 0,
      charges: [],
      charges_total: 0,
      total: 0,
    };
  }

  const taxMode = line.tax_mode ?? DEFAULT_MODE;
  const baseTax = applyChargeMode(line.tax, taxMode, base);
  const baseTaxRateForInherit =
    taxMode === "percentage" ? toNumber(line.tax) : 0;

  const otherCharges = Array.isArray(line.other_charges) ? line.other_charges : [];

  const charges = [];
  let chargesTotal = 0;

  for (const charge of otherCharges) {
    const amount = applyChargeMode(charge.amount, charge.amount_mode, base);

    let chargeTax;
    if (hasExplicitChargeTax(charge)) {
      chargeTax = applyChargeMode(charge.tax, charge.tax_mode, amount);
    } else if (baseTaxRateForInherit > 0) {
      chargeTax = (amount * baseTaxRateForInherit) / 100;
    } else {
      chargeTax = 0;
    }

    const subtotal = amount + chargeTax;
    chargesTotal += subtotal;
    // Per-charge fields are quantised to 2dp at the boundary so the response
    // matches DB precision; raw values still drive the running totals above.
    const chargeOut = {
      name: charge.name ?? null,
      amount: q2(amount),
      tax: q2(chargeTax),
      subtotal: q2(subtotal),
    };
    // Carry the canonical slug through when the input has one. Lets downstream
    // consumers (e.g. quote-compare freight-advantage matcher) key off slug
    // rather than the user-typed name. Omitted when absent to keep the legacy
    // engine output shape stable for existing assertions.
    if (charge.slug !== undefined && charge.slug !== null) {
      chargeOut.slug = charge.slug;
    }
    // Preserve the vendor's comment on the charge so downstream renderers
    // (PO Details page, printed PDF, quote-compare matrix) can show *why*
    // the charge was applied. Comments are part of the contract — vendors
    // explain TCS reasons, freight basis, etc. — and dropping them at the
    // engine boundary erases that explanation. Gated on presence so existing
    // toEqual assertions on commentless inputs aren't broken.
    if (charge.comment !== undefined && charge.comment !== null && charge.comment !== '') {
      chargeOut.comment = charge.comment;
    }
    charges.push(chargeOut);
  }

  const total = base + baseTax + chargesTotal;

  return {
    base: q2(base),
    base_tax: q2(baseTax),
    charges,
    charges_total: q2(chargesTotal),
    total: q2(total),
  };
};

// Document-level global charges have two on-disk shapes that need to be
// reconciled before they can be fed into the engine:
//
//   - newer / "amount" shape:  { name, amount, amount_mode, ... }
//   - legacy / "tax" shape:    { name, tax,    tax_mode,    is_global: true, ... }
//
// The legacy shape is what the vendor send-quote screen produces today (TCS
// 5%, TDS 1% etc. — quote-document-level taxes that piggyback on the same
// JSONB array as user-defined "amount" global charges). Both shapes describe
// the same arithmetic: add `value` percent/absolute on top of the document
// subtotal. We normalise to a single { amount, amount_mode } pair before the
// engine touches it; downstream consumers (engine, PO template, FE breakdown)
// can stay shape-agnostic.
export const normalizeGlobalCharge = (charge) => {
  if (!charge || typeof charge !== 'object') return null;
  const amount = charge.amount ?? charge.tax;
  const amount_mode = charge.amount_mode ?? charge.tax_mode;
  return {
    name: charge.name ?? null,
    slug: charge.slug ?? null,
    amount: toNumber(amount),
    amount_mode: amount_mode ?? DEFAULT_MODE,
    is_global: charge.is_global === true ? true : undefined,
    comment: charge.comment ?? undefined,
  };
};

// Document-level aggregation across line items + invoice-wide global charges.
// Global charges are applied as a percentage/absolute of the *grand subtotal*
// (sum of line totals), matching today's send-quote behavior.
export const calculateDocumentTotals = (lineItems = [], globalCharges = []) => {
  const lines = lineItems.map((line) => ({
    input: line,
    ...calculateLineTotal(line),
  }));

  const grandSubtotal = lines.reduce((sum, l) => sum + l.total, 0);

  // Track raw global-charge amounts separately from the q2'd values exposed
  // on each resolved charge — the running grandTotal sums raw, the response
  // shows quantised values.
  const rawGlobalAmounts = [];
  const resolvedGlobalCharges = (globalCharges || [])
    .map(normalizeGlobalCharge)
    .filter(Boolean)
    .map((charge) => {
      const amount = applyChargeMode(charge.amount, charge.amount_mode, grandSubtotal);
      rawGlobalAmounts.push(amount);
      const out = {
        name: charge.name ?? null,
        slug: charge.slug ?? null,
        amount: q2(amount),
      };
      // Preserve the vendor-supplied rate + mode so renderers can display
      // "TCS (5%)" alongside the resolved currency value, and the comment
      // so the buyer sees the vendor's explanation on the printed PO.
      if (charge.amount !== undefined && charge.amount !== null) {
        out.rate = charge.amount;
        out.mode = charge.amount_mode;
      }
      if (charge.comment !== undefined && charge.comment !== null && charge.comment !== '') {
        out.comment = charge.comment;
      }
      return out;
    });

  const globalChargesTotal = rawGlobalAmounts.reduce((sum, a) => sum + a, 0);

  const grandTotal = grandSubtotal + globalChargesTotal;

  return {
    lines,
    grand_subtotal: q2(grandSubtotal),
    global_charges: resolvedGlobalCharges,
    global_charges_total: q2(globalChargesTotal),
    grand_total: q2(grandTotal),
  };
};

// Quote-compare's "normalize" filter applies a payment-term factor to the
// total, simulating the cost-of-money for advance/credit terms so vendors with
// different payment terms can be compared apples-to-apples.
//
// Per term:
//   - "advance" → factor = 1 + (delivery_days / 30) * 0.01
//   - "credit"  → factor = 1 - (days / 30) * 0.01     (clamped >= 0)
//   - else      → leftover (handled at the end)
//
// Any percentage not covered by advance/credit terms is added back at factor 1.
export const applyPaymentTermNormalization = (
  total,
  paymentTerms = [],
  deliveryDays = 0
) => {
  const baseTotal = toNumber(total);
  if (baseTotal <= 0) return 0;

  const days = parseInt(toNumber(deliveryDays), 10) || 0;

  let normalized = 0;
  let coveredPercent = 0;

  for (const term of paymentTerms || []) {
    const percentage = toNumber(term?.value);
    if (percentage <= 0) continue;
    const type = (term?.type || "").toLowerCase();
    const termDays = parseInt(toNumber(term?.days), 10) || 0;
    const pctAmount = (percentage / 100) * baseTotal;

    let factor;
    if (type === "advance") {
      factor = 1 + (days / 30) * 0.01;
    } else if (type === "credit") {
      factor = 1 - (termDays / 30) * 0.01;
    } else {
      // Unknown / "other" — treat as leftover at factor 1.
      continue;
    }

    factor = Math.max(0, factor);
    normalized += pctAmount * factor;
    coveredPercent += percentage;
  }

  if (coveredPercent < 100) {
    const leftover = 100 - coveredPercent;
    normalized += (leftover / 100) * baseTotal;
  }

  return normalized;
};

// Quote-compare peer fill-in (the "normalize" filter as applied to data shape).
// For each product's quotations, vendors who didn't quote freight, packaging,
// or tax get the peer average (freight/packaging) or peer median (tax) filled
// in so we're not penalising whoever bundled charges into base price.
//
// Operates on the *legacy flat schema* the quote-compare page consumes today:
//   quote.quote_details[i].{ freight_price, freight_mode, package_price,
//                            package_mode, tax, tax_mode, unit_price, ... }
// Absolute values are converted to a percentage-of-base before pooling.
const isQuoteRegret = (quote) =>
  quote?.is_regret == 1 ||
  quote?.quote_details?.is_regret == 1 ||
  (Array.isArray(quote?.quote_details) && quote.quote_details[0]?.is_regret == 1);

const safeTwoDecimals = (value) => Math.round(toNumber(value) * 100) / 100;

const getQtyFromProductOrDetail = (productOrDetail) => {
  const fromRfq = productOrDetail?.rfq_details?.find?.(
    (x) => x.title === "Quantity"
  )?.value;
  const q = toNumber(fromRfq ?? productOrDetail?.quantity ?? 0);
  return q > 0 ? q : 0;
};

// Normalise `quote.quote_details` to an array. The model's
// `getQuotesByRfqById2` returns it as a single object in many shapes (carries
// `created_by`, `timestamp`, `unit_price`, etc. directly) and as an array of
// line items in others. Downstream `enrichProduct` already accepts both,
// but the peer-fill loop iterates `quote_details` three times and needs
// array semantics throughout.
const detailsAsArray = (qd) =>
  Array.isArray(qd) ? qd : (qd && typeof qd === "object" ? [qd] : []);

export const fillMissingChargesFromPeers = (data = []) => {
  // Step 1: pre-normalize absolute → percentage so the pool is comparable.
  const preNormalized = (data || []).map((item) => ({
    ...item,
    quotations: (item.quotations || []).map((quote) => ({
      ...quote,
      quote_details: detailsAsArray(quote.quote_details).map((detail) => {
        const unit = toNumber(detail.unit_price);
        const qty = getQtyFromProductOrDetail(detail) || getQtyFromProductOrDetail(item);
        const base = unit * qty;
        const d = { ...detail };

        if (d.freight_mode === "absolute") {
          d.freight_price = base ? (toNumber(d.freight_price) / base) * 100 : 0;
          d.freight_mode = "percentage";
        }
        if (d.package_mode === "absolute") {
          d.package_price = base ? (toNumber(d.package_price) / base) * 100 : 0;
          d.package_mode = "percentage";
        }
        if (d.tax_mode === "absolute") {
          d.tax = base ? (toNumber(d.tax) / base) * 100 : 0;
          d.tax_mode = "percentage";
        }
        return d;
      }),
    })),
  }));

  // Step 2: build pools across non-regret, priced quotes.
  const freightPool = [];
  const packagePool = [];
  const taxPool = [];

  preNormalized.forEach((item) => {
    item.quotations.forEach((quote) => {
      if (isQuoteRegret(quote)) return;
      (quote.quote_details || []).forEach((detail) => {
        const f = toNumber(detail.freight_price);
        if (f > 0) freightPool.push(f);
        const p = toNumber(detail.package_price);
        if (p > 0) packagePool.push(p);
        const tx = toNumber(detail.tax);
        if (Number.isFinite(tx)) taxPool.push(tx);
      });
    });
  });

  const mean = (arr) =>
    arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;

  const median = (arr) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  };

  const averageFreight = mean(freightPool);
  const averagePackage = mean(packagePool);
  const medianTax = median(taxPool);

  // Step 3: fill zero values with pool stats; preserve everything else.
  return preNormalized.map((item) => {
    const vendorTermsById = new Map(
      (item.all_vendors || []).map((v) => [v.id, v.payment_terms || []])
    );

    return {
      ...item,
      quotations: (item.quotations || []).map((quote) => {
        const paymentTerms = vendorTermsById.get(quote.created_by) || [];
        return {
          ...quote,
          quote_details: (quote.quote_details || []).map((detail) => {
            const f = safeTwoDecimals(detail.freight_price);
            const p = safeTwoDecimals(detail.package_price);
            const tx = safeTwoDecimals(detail.tax);
            return {
              ...detail,
              freight_price: f === 0 ? safeTwoDecimals(averageFreight) : f,
              package_price: p === 0 ? safeTwoDecimals(averagePackage) : p,
              tax: tx === 0 ? safeTwoDecimals(medianTax) : tx,
              payment_terms: paymentTerms,
            };
          }),
        };
      }),
    };
  });
};

// Comparison-stat primitives used by the quote-compare page.

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Bucket each candidate value into one of best/competitive/neutral/high based
// on its position in the [min, max] range, matching the legacy frontend rule.
export const computeComparisonBands = (entries = []) => {
  const valid = entries.filter(
    (e) => e && Number.isFinite(toNumber(e.value)) && toNumber(e.value) > 0
  );
  if (valid.length === 0) {
    return { min: 0, max: 0, bands: {}, normalizedScores: {} };
  }

  const values = valid.map((e) => toNumber(e.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 1);

  const bands = {};
  const normalizedScores = {};

  for (const entry of valid) {
    const v = toNumber(entry.value);
    const normalized = clamp((v - min) / spread, 0, 1);
    normalizedScores[entry.key] = normalized;
    if (v <= min * 1.01) {
      bands[entry.key] = "best";
    } else if (normalized <= 0.4) {
      bands[entry.key] = "competitive";
    } else if (normalized >= 0.8) {
      bands[entry.key] = "high";
    } else {
      bands[entry.key] = "neutral";
    }
  }

  return { min, max, bands, normalizedScores };
};

// Tie-broken lowest pick across a list of priced quotes.
//   1. cheapest total wins
//   2. on tie, prefer prev_worked === 1
//   3. on still-tie, prefer earliest submission timestamp
export const pickLowestQuote = (quotes = []) => {
  if (!Array.isArray(quotes) || quotes.length === 0) return null;
  return quotes.reduce((winner, current) => {
    if (!winner) return current;
    const wTotal = toNumber(winner.total);
    const cTotal = toNumber(current.total);
    if (cTotal < wTotal) return current;
    if (cTotal > wTotal) return winner;
    const wPrev = winner.prev_worked === 1 ? 1 : 0;
    const cPrev = current.prev_worked === 1 ? 1 : 0;
    if (cPrev > wPrev) return current;
    if (cPrev < wPrev) return winner;
    const wTime = new Date(winner.timestamp || 0).getTime();
    const cTime = new Date(current.timestamp || 0).getTime();
    return cTime < wTime ? current : winner;
  }, null);
};

// Return the set of vendor IDs whose freight cost is within 1% of the lowest.
// Excludes regret quotes, unpriced quotes, and quotes with missing parts.
export const computeFreightAdvantage = (entries = []) => {
  const eligible = (entries || [])
    .filter(
      (e) =>
        e &&
        !e.isRegret &&
        toNumber(e.price) > 0 &&
        (Array.isArray(e.missingParts) ? e.missingParts.length === 0 : true) &&
        toNumber(e.freightCost) > 0
    )
    .map((e) => ({ vendorId: e.vendorId, freightCost: toNumber(e.freightCost) }));

  if (eligible.length === 0) return [];

  const min = Math.min(...eligible.map((e) => e.freightCost));
  const tolerance = min * 1.01;
  return eligible.filter((e) => e.freightCost <= tolerance).map((e) => e.vendorId);
};

// Adapter: convert a legacy PO charges_meta ({ freight_price, package_price,
// tax, ... }) into the canonical shape ({ tax, tax_mode, other_charges: [...] })
// that the engine consumes. Idempotent — already-canonical input passes through.
export const normalizeChargesMeta = (rawMeta = {}) => {
  const meta = rawMeta || {};

  if (Array.isArray(meta.other_charges)) {
    return {
      tax: toNumber(meta.tax),
      tax_mode: meta.tax_mode ?? DEFAULT_MODE,
      other_charges: meta.other_charges,
    };
  }

  // When converting legacy flat charges to the canonical other_charges[]
  // shape, the synthetic entry's tax must be `null` (inherit) when the
  // legacy `*_tax` field is absent. Coercing absent legacy fields to 0
  // would, under tri-state semantics, mean "explicit zero" — silently
  // dropping the inherited base tax that historical totals were built on.
  const legacyTaxOrNull = (raw) => (raw === null || raw === undefined || raw === "" ? null : toNumber(raw));

  const otherCharges = [];
  const freightPrice = toNumber(meta.freight_price);
  if (freightPrice > 0) {
    otherCharges.push({
      name: "Freight",
      amount: freightPrice,
      amount_mode: meta.freight_mode ?? DEFAULT_MODE,
      tax: legacyTaxOrNull(meta.freight_tax),
      tax_mode: meta.freight_tax_mode ?? DEFAULT_MODE,
    });
  }
  const packagePrice = toNumber(meta.package_price);
  if (packagePrice > 0) {
    otherCharges.push({
      name: "Packaging",
      amount: packagePrice,
      amount_mode: meta.package_mode ?? DEFAULT_MODE,
      tax: legacyTaxOrNull(meta.package_tax),
      tax_mode: meta.package_tax_mode ?? DEFAULT_MODE,
    });
  }

  return {
    tax: toNumber(meta.tax),
    tax_mode: meta.tax_mode ?? DEFAULT_MODE,
    other_charges: otherCharges,
  };
};

export default {
  applyChargeMode,
  calculateLineTotal,
  calculateDocumentTotals,
  applyPaymentTermNormalization,
  fillMissingChargesFromPeers,
  computeComparisonBands,
  pickLowestQuote,
  computeFreightAdvantage,
  normalizeChargesMeta,
  normalizeGlobalCharge,
};
