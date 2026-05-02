// Quote-compare enrichment: takes the raw products+quotations payload that
// rfqModel.getQuotesByRfqById2 returns and layers engine output on top of it.
// Pure transformation — no DB calls. The frontend renders straight from this.

import pricingEngine from "./pricingEngine.js";

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const isQuoteRegret = (quote) => {
  if (!quote) return false;
  if (quote.is_regret == 1) return true;
  const details = Array.isArray(quote.quote_details) ? quote.quote_details[0] : quote.quote_details;
  return details?.is_regret == 1;
};

// Pull the line-item detail object regardless of the variant shape
// (some endpoints return it as an array, some as a single object).
const getDetail = (quote) => {
  if (!quote) return null;
  if (Array.isArray(quote.quote_details)) return quote.quote_details[0] || null;
  if (quote.quote_details && typeof quote.quote_details === "object") return quote.quote_details;
  return null;
};

const getQuantityFromProductOrDetail = (product, detail) => {
  const fromProductDetails = toNumber(
    product?.product_details?.[0]?.rfq_details?.find((s) => s.title === "Quantity")?.value
  );
  if (fromProductDetails > 0) return fromProductDetails;

  const fromSpecs = toNumber(
    product?.product_specs?.find((s) => s.title === "Quantity")?.value
  );
  if (fromSpecs > 0) return fromSpecs;

  const fromDetailSpecs = toNumber(
    detail?.rfq_details?.find((s) => s.title === "Quantity")?.value
  );
  if (fromDetailSpecs > 0) return fromDetailSpecs;

  const fromDetail = toNumber(detail?.quantity);
  if (fromDetail > 0) return fromDetail;

  return toNumber(product?.quantity);
};

// Convert the legacy flat freight/packaging fields into engine other_charges
// entries when the canonical array is missing (older quotes pre-migration).
const buildEngineCharges = (detail) => {
  const otherCharges = Array.isArray(detail?.other_charges) ? detail.other_charges : [];
  if (otherCharges.length > 0) return otherCharges;

  const synthesised = [];
  const freightPrice = toNumber(detail?.freight_price);
  if (freightPrice > 0) {
    synthesised.push({
      name: "Freight",
      amount: freightPrice,
      amount_mode: detail.freight_mode || "percentage",
      tax: toNumber(detail.freight_tax),
      tax_mode: detail.freight_tax_mode || "percentage",
    });
  }
  const packagePrice = toNumber(detail?.package_price);
  if (packagePrice > 0) {
    synthesised.push({
      name: "Packaging",
      amount: packagePrice,
      amount_mode: detail.package_mode || "percentage",
      tax: toNumber(detail.package_tax),
      tax_mode: detail.package_tax_mode || "percentage",
    });
  }
  return synthesised;
};

// Pricing fields may live on the parent `quote` (when quote_details is a
// single metadata object) OR on `detail` itself (when quote_details is an
// array of line items). Merge in the same precedence the frontend uses
// (`{ ...quote, ...detail }`) so the engine sees a complete row regardless
// of which shape the model returned.
const mergedQuoteRow = (quote, detail) => ({ ...(quote || {}), ...(detail || {}) });

const buildEngineLineInput = (product, quote, detail) => {
  const merged = mergedQuoteRow(quote, detail);
  const quantity = getQuantityFromProductOrDetail(product, merged);
  return {
    unit_price: merged.unit_price,
    quantity,
    tax: merged.tax,
    tax_mode: merged.tax_mode || "percentage",
    other_charges: buildEngineCharges(merged),
  };
};

// Apply payment-term normalization on top of the engine's line total. Only
// runs when the user has the "normalize" filter enabled.
const applyNormalization = (engineOut, vendor, detail) => {
  const paymentTerms = vendor?.payment_terms || [];
  if (!paymentTerms.length) return engineOut;
  const deliveryDays = toNumber(detail?.delivery_period);
  const normalised = pricingEngine.applyPaymentTermNormalization(
    engineOut.total,
    paymentTerms,
    deliveryDays
  );
  return { ...engineOut, total: Math.round(normalised) };
};

const isFinalizedFor = (product, vendorId) => {
  if (!vendorId) return false;
  return !!(product?.all_vendors || []).find(
    (v) => String(v.id) === String(vendorId) && v.is_finalized
  );
};

// Build comparison-band entries for a given metric across a product's quotes.
const bandEntriesFor = (columns, valueResolver) =>
  columns
    .filter((c) => !c.isRegret)
    .map((c) => ({ key: c.vendor_id, value: valueResolver(c) }));

const enrichProduct = (product, opts) => {
  const productCopy = { ...product };

  // Find the vendor's payment-terms record (used by normalization).
  const vendorTermsById = new Map(
    (product?.all_vendors || []).map((v) => [v.id, v.payment_terms || []])
  );

  // Annotate each quotation with engine output per detail row.
  const quotations = (product?.quotations || []).map((quote) => {
    const isRegret = isQuoteRegret(quote);
    // created_by may sit on the parent quote OR on quote_details depending
    // on shape — resolve via merge.
    const detailForVendor = getDetail(quote) || {};
    const vendorId = mergedQuoteRow(quote, detailForVendor).created_by;
    const vendor = (product.all_vendors || []).find(
      (v) => String(v.id) === String(vendorId)
    ) || (vendorTermsById.has(vendorId) ? { id: vendorId, payment_terms: vendorTermsById.get(vendorId) || [] } : null);

    const detailsArray = Array.isArray(quote.quote_details)
      ? quote.quote_details
      : quote.quote_details
      ? [quote.quote_details]
      : [];

    let engineQuoteTotal = 0;
    const annotatedDetails = detailsArray.map((detail) => {
      const input = buildEngineLineInput(product, quote, detail);
      let engineOut = pricingEngine.calculateLineTotal(input);
      if (opts.normalizeApplied) {
        engineOut = applyNormalization(engineOut, vendor, detail);
      }
      engineQuoteTotal += engineOut.total;
      return { ...detail, engine: engineOut };
    });

    return {
      ...quote,
      quote_details: Array.isArray(quote.quote_details) ? annotatedDetails : annotatedDetails[0],
      engine_total: engineQuoteTotal,
      is_regret_resolved: isRegret,
    };
  });

  // Build per-product comparison columns for band/lowest computations.
  // Pricing fields (unit_price, delivery_period) and identity fields
  // (created_by, timestamp) live on either the parent quote OR on
  // quote_details depending on the model output shape — merge both before
  // reading.
  const columns = quotations.map((quote) => {
    const detail = getDetail(quote) || {};
    const merged = mergedQuoteRow(quote, detail);
    const vendorId = merged.created_by;
    const engine = detail.engine || { base: 0, base_tax: 0, charges_total: 0, total: toNumber(quote.engine_total) };
    const quantity = getQuantityFromProductOrDetail(product, merged);
    const unitPrice = toNumber(merged.unit_price);
    return {
      vendor_id: vendorId,
      isRegret: isQuoteRegret(quote),
      quantity,
      unit_price: unitPrice,
      base: engine.base,
      base_tax: engine.base_tax,
      charges_total: engine.charges_total,
      total: engine.total,
      delivery: toNumber(merged.delivery_period),
      prev_worked: ((product.all_vendors || []).find(
        (v) => String(v.id) === String(vendorId)
      ) || {}).prev_worked || 0,
      timestamp: merged.timestamp,
      missingParts: merged.missingParts || [],
    };
  });

  // Comparison bands across the standard metrics.
  const bands = {
    basePrice: pricingEngine.computeComparisonBands(
      bandEntriesFor(columns, (c) => c.unit_price)
    ),
    subtotal: pricingEngine.computeComparisonBands(
      bandEntriesFor(columns, (c) => c.unit_price * c.quantity)
    ),
    gst: pricingEngine.computeComparisonBands(
      bandEntriesFor(columns, (c) => c.base_tax)
    ),
    total: pricingEngine.computeComparisonBands(
      bandEntriesFor(columns, (c) => c.total)
    ),
    delivery: pricingEngine.computeComparisonBands(
      bandEntriesFor(columns, (c) => c.delivery)
    ),
  };

  // Freight advantage: lookup each vendor's "Freight" charge subtotal from the engine breakdown.
  const freightAdvantageEntries = quotations.map((quote) => {
    const detail = getDetail(quote) || {};
    const merged = mergedQuoteRow(quote, detail);
    const charges = detail.engine?.charges || [];
    const freight = charges.find((c) => (c.name || "").toLowerCase() === "freight");
    return {
      vendorId: merged.created_by,
      isRegret: isQuoteRegret(quote),
      price: toNumber(merged.unit_price),
      freightCost: toNumber(freight?.subtotal),
      missingParts: [],
    };
  });
  const freightAdvantageVendorIds = pricingEngine.computeFreightAdvantage(freightAdvantageEntries);

  // Tie-broken lowest non-regret quote.
  const lowestPick = pricingEngine.pickLowestQuote(
    columns
      .filter((c) => !c.isRegret && c.unit_price > 0)
      .map((c) => ({
        vendorId: c.vendor_id,
        total: c.total,
        prev_worked: c.prev_worked,
        timestamp: c.timestamp,
      }))
  );

  // Baseline (last_purchase_rate or last_quote_rate) — engine recompute.
  let baseline_total = 0;
  const baselineSource = product.last_purchase_rate || product.last_quote_rate;
  if (baselineSource) {
    const baselineInput = buildEngineLineInput(product, null, baselineSource);
    const baselineOut = pricingEngine.calculateLineTotal(baselineInput);
    baseline_total = baselineOut.total;
  }

  // L1 / finalized totals for this product.
  const eligibleForL1 = columns.filter((c) => !c.isRegret && c.unit_price > 0 && c.total > 0);
  const l1Pick = pricingEngine.pickLowestQuote(
    eligibleForL1.map((c) => ({
      vendorId: c.vendor_id,
      total: c.total,
      prev_worked: c.prev_worked,
      timestamp: c.timestamp,
    }))
  );
  const l1_total = l1Pick?.total || 0;
  const finalizedQuote = quotations.find((q) => {
    if (isQuoteRegret(q)) return false;
    const qDetail = getDetail(q) || {};
    const qCreatedBy = mergedQuoteRow(q, qDetail).created_by;
    return isFinalizedFor(product, qCreatedBy);
  });
  const finalized_total = toNumber(finalizedQuote?.engine_total);

  return {
    ...productCopy,
    quotations,
    comparison: {
      bands,
      freight_advantage_vendor_ids: freightAdvantageVendorIds,
      lowest_vendor_id: lowestPick?.vendorId || null,
    },
    aggregates: {
      l1_total,
      finalized_total,
      baseline_total,
      regret_count: quotations.filter((q) => isQuoteRegret(q)).length,
      eligible_count: eligibleForL1.length,
    },
  };
};

export const enrichQuoteCompareData = (products, opts = {}) => {
  if (!Array.isArray(products) || products.length === 0) {
    return {
      products: [],
      metrics: {
        l1_total: 0,
        finalized_total: 0,
        baseline_total: 0,
        savings: 0,
        regrets_count: 0,
        products_count: 0,
        vendors_count: 0,
      },
    };
  }

  // If normalize filter is on, fill missing freight/packaging/tax across peers
  // BEFORE the engine pass so the resulting line totals reflect the peer-fill.
  let workingProducts = products;
  if (opts.normalizeApplied) {
    workingProducts = pricingEngine.fillMissingChargesFromPeers(products);
  }

  const enrichedProducts = workingProducts.map((p) => enrichProduct(p, opts));

  // Roll-ups across the whole RFQ.
  let l1_total = 0;
  let finalized_total = 0;
  let baseline_total = 0;
  let regrets_count = 0;
  const vendorSet = new Set();
  enrichedProducts.forEach((p) => {
    l1_total += p.aggregates.l1_total;
    finalized_total += p.aggregates.finalized_total;
    baseline_total += p.aggregates.baseline_total;
    regrets_count += p.aggregates.regret_count;
    (p.all_vendors || []).forEach((v) => v?.id && vendorSet.add(String(v.id)));
    (p.quotations || []).forEach((q) => {
      const qDetail = getDetail(q) || {};
      const qCreatedBy = mergedQuoteRow(q, qDetail).created_by;
      if (qCreatedBy) vendorSet.add(String(qCreatedBy));
    });
  });

  const savings = baseline_total > 0 ? baseline_total - l1_total : 0;

  // Per-vendor totals across all products in this RFQ.
  const vendorAccumulator = new Map();
  enrichedProducts.forEach((product) => {
    (product.all_vendors || []).forEach((vendor) => {
      const id = String(vendor.id);
      if (!vendorAccumulator.has(id)) {
        vendorAccumulator.set(id, {
          vendor_id: vendor.id,
          organization_name: vendor.organization_name || vendor.name || vendor.email || "Unknown Vendor",
          name: vendor.name,
          email: vendor.email,
          total: 0,
          base: 0,
          base_tax: 0,
          charges_total: 0,
          delivery_days: [],
        });
      }
      const acc = vendorAccumulator.get(id);
      // created_by lives on parent quote in some shapes, on quote_details in
      // others — match against the merged view.
      const quote = (product.quotations || []).find((q) => {
        if (isQuoteRegret(q)) return false;
        const qDetail = getDetail(q) || {};
        const qCreatedBy = mergedQuoteRow(q, qDetail).created_by;
        return String(qCreatedBy) === id;
      });
      if (!quote) return;
      const detail = getDetail(quote);
      if (!detail) return;
      const merged = mergedQuoteRow(quote, detail);
      const engine = detail.engine || {};
      acc.total += toNumber(engine.total);
      acc.base += toNumber(engine.base);
      acc.base_tax += toNumber(engine.base_tax);
      acc.charges_total += toNumber(engine.charges_total);
      const delivery = toNumber(merged.delivery_period);
      if (delivery > 0) acc.delivery_days.push(delivery);
    });
  });

  const vendor_totals = Array.from(vendorAccumulator.values())
    .sort((a, b) => a.total - b.total);

  return {
    products: enrichedProducts,
    metrics: {
      l1_total,
      finalized_total,
      baseline_total,
      savings,
      regrets_count,
      products_count: enrichedProducts.length,
      vendors_count: vendorSet.size,
    },
    vendor_totals,
  };
};

export default { enrichQuoteCompareData };
