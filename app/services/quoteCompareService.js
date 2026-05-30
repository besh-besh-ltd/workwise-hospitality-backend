// Quote-compare enrichment: takes the raw products+quotations payload that
// rfqModel.getQuotesByRfqById2 returns and layers engine output on top of it.
// Pure transformation — no DB calls. The frontend renders straight from this.

import pricingEngine from "./pricingEngine.js";

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

// Quantise to 2 decimals. Used when this service rounds up engine output
// across multiple quotes/products (engine_total, l1_total, vendor totals)
// so the API response matches DB column precision (numeric(15,2)) and
// doesn't leak float-add drift to the frontend.
const q2 = (value) => Math.round(toNumber(value) * 100) / 100;

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
// Synthetic Freight/Packaging tax is `null` (= inherit base) when the legacy
// freight_tax / package_tax field is absent; only an explicitly-set legacy
// value becomes a non-null tax. This preserves historical totals under the
// engine's tri-state tax semantics (null = inherit, 0 = explicit zero).
const legacyTaxOrNull = (raw) =>
  raw === null || raw === undefined || raw === "" ? null : toNumber(raw);

const buildEngineCharges = (detail) => {
  const otherCharges = Array.isArray(detail?.other_charges) ? detail.other_charges : [];
  if (otherCharges.length > 0) return otherCharges;

  const synthesised = [];
  const freightPrice = toNumber(detail?.freight_price);
  if (freightPrice > 0) {
    synthesised.push({
      name: "Freight",
      slug: "freight",
      amount: freightPrice,
      amount_mode: detail.freight_mode || "percentage",
      tax: legacyTaxOrNull(detail.freight_tax),
      tax_mode: detail.freight_tax_mode || "percentage",
    });
  }
  const packagePrice = toNumber(detail?.package_price);
  if (packagePrice > 0) {
    synthesised.push({
      name: "Packaging",
      slug: "packaging",
      amount: packagePrice,
      amount_mode: detail.package_mode || "percentage",
      tax: legacyTaxOrNull(detail.package_tax),
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
  return { ...engineOut, total: q2(normalised) };
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

    // Resolve quote-level global charges (TCS, TDS, document fees, etc.)
    // against the per-line sum. `engine_total` keeps its legacy meaning
    // (per-line sum) so existing consumers (FE per-line rows) are unchanged.
    // The negotiation modal + compare matrix read `engine_grand_total` to
    // surface global charges.
    //
    // Both on-disk shapes are accepted: legacy `{tax, tax_mode, is_global: true}`
    // for TCS-style document taxes and the newer `{amount, amount_mode}` for
    // user-defined globals. `pricingEngine.normalizeGlobalCharge` collapses
    // both into the canonical `{amount, amount_mode}` pair before applying.
    const savedGlobalCharges = Array.isArray(quote.global_charges) ? quote.global_charges : [];
    const resolvedGlobalCharges = savedGlobalCharges
      .map((c) => {
        const norm = pricingEngine.normalizeGlobalCharge(c);
        if (!norm) return null;
        const amount = pricingEngine.applyChargeMode(norm.amount, norm.amount_mode, engineQuoteTotal);
        const additionalTax = pricingEngine.applyChargeMode(norm.additional_tax, norm.additional_tax_mode, amount);
        return {
          name: norm.name,
          slug: norm.slug,
          amount,
          additional_tax: additionalTax,
        };
      })
      .filter(Boolean);
    const globalChargesTotal = resolvedGlobalCharges.reduce((s, c) => s + c.amount + c.additional_tax, 0);
    const grandTotal = engineQuoteTotal + globalChargesTotal;

    return {
      ...quote,
      quote_details: Array.isArray(quote.quote_details) ? annotatedDetails : annotatedDetails[0],
      engine_total: q2(engineQuoteTotal),
      engine_global_charges: resolvedGlobalCharges.map((c) => ({
        ...c,
        amount: q2(c.amount),
        additional_tax: q2(c.additional_tax),
        subtotal: q2(c.amount + c.additional_tax),
      })),
      engine_global_charges_total: q2(globalChargesTotal),
      engine_grand_total: q2(grandTotal),
      is_regret_resolved: isRegret,
    };
  });

  // Build per-product comparison columns for band/lowest computations.
  // Pricing fields (unit_price, delivery_period) and identity fields
  // (created_by, timestamp) live on either the parent quote OR on
  // quote_details depending on the model output shape — merge both before
  // reading.
  //
  // Two parallel totals are exposed deliberately:
  //   - `total` is the per-line engine total (base + base_tax + per-line
  //     charges). This is what the FE compare matrix renders as the "Total"
  //     row AND what it uses as the base for adding global charges on top.
  //     Conflating it with the grand total double-counts globals on the
  //     compare display.
  //   - `grand_total` is the document-level total (per-line + global_charges).
  //     Used by RFQ-level aggregates (l1_total, finalized_total, vendor_totals)
  //     so the comparison header reflects the SAME number that becomes
  //     tbl_rfq_purchase_order.total_value at PO drafting time.
  const columns = quotations.map((quote) => {
    const detail = getDetail(quote) || {};
    const merged = mergedQuoteRow(quote, detail);
    const vendorId = merged.created_by;
    const engine = detail.engine || { base: 0, base_tax: 0, charges_total: 0, total: toNumber(quote.engine_total) };
    const quantity = getQuantityFromProductOrDetail(product, merged);
    const unitPrice = toNumber(merged.unit_price);
    const grandTotal = toNumber(quote.engine_grand_total ?? engine.total);
    return {
      vendor_id: vendorId,
      isRegret: isQuoteRegret(quote),
      quantity,
      unit_price: unitPrice,
      base: engine.base,
      base_tax: engine.base_tax,
      charges_total: engine.charges_total,
      total: engine.total,
      grand_total: grandTotal,
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

  // Freight advantage: lookup each vendor's freight charge subtotal from the
  // engine breakdown. Match by canonical slug (`freight`) rather than the
  // user-typed name. After the migration to `other_charges`, vendors' freight
  // entries can be named anything ("Freight Charges", "Transportation",
  // "Logistics"), but the canonical seeded "Freight" charge always carries
  // slug=`freight`. Legacy quotes without other_charges are synthesised with
  // slug=`freight` in buildEngineCharges, so both paths converge on slug.
  const freightAdvantageEntries = quotations.map((quote) => {
    const detail = getDetail(quote) || {};
    const merged = mergedQuoteRow(quote, detail);
    const charges = detail.engine?.charges || [];
    const freight = charges.find((c) => {
      if (c?.slug) return c.slug === "freight";
      return (c?.name || "").toLowerCase() === "freight";
    });
    return {
      vendorId: merged.created_by,
      isRegret: isQuoteRegret(quote),
      price: toNumber(merged.unit_price),
      freightCost: toNumber(freight?.subtotal),
      missingParts: [],
    };
  });
  const freightAdvantageVendorIds = pricingEngine.computeFreightAdvantage(freightAdvantageEntries);

  // Tie-broken lowest non-regret quote — keyed off the document-level grand
  // total (line + global_charges) so the highlighted vendor on the compare
  // matrix is the one whose final invoiceable amount is genuinely lowest,
  // not just whoever's per-line subtotal looks smallest before TCS/document
  // charges are added.
  const lowestPick = pricingEngine.pickLowestQuote(
    columns
      .filter((c) => !c.isRegret && c.unit_price > 0)
      .map((c) => ({
        vendorId: c.vendor_id,
        total: c.grand_total,
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

  // L1 total = the cheapest vendor's grand total (line + globals). Using
  // grand_total here keeps the RFQ-level "lowest cost" consistent with the
  // amount that becomes tbl_rfq_purchase_order.total_value if that vendor
  // is finalized.
  const eligibleForL1 = columns.filter((c) => !c.isRegret && c.unit_price > 0 && c.grand_total > 0);
  const l1Pick = pricingEngine.pickLowestQuote(
    eligibleForL1.map((c) => ({
      vendorId: c.vendor_id,
      total: c.grand_total,
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
  // Per-product finalized aggregate uses grand total (with global charges)
  // so RFQ-level "Finalized Total" matches the eventual PO total exactly.
  const finalized_total = toNumber(finalizedQuote?.engine_grand_total ?? finalizedQuote?.engine_total);

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

  // Quantise rolled-up sums to 2dp at the API boundary.
  l1_total = q2(l1_total);
  finalized_total = q2(finalized_total);
  baseline_total = q2(baseline_total);
  const savings = baseline_total > 0 ? q2(baseline_total - l1_total) : 0;

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
      // Cross-vendor RFQ-level total uses the grand total per quote (line +
      // global_charges) so the comparison header matches the eventual PO
      // total when this vendor is finalized.
      acc.total += toNumber(quote.engine_grand_total ?? engine.total);
      acc.base += toNumber(engine.base);
      acc.base_tax += toNumber(engine.base_tax);
      acc.charges_total += toNumber(engine.charges_total);
      const delivery = toNumber(merged.delivery_period);
      if (delivery > 0) acc.delivery_days.push(delivery);
    });
  });

  const vendor_totals = Array.from(vendorAccumulator.values())
    .map((v) => ({
      ...v,
      total: q2(v.total),
      base: q2(v.base),
      base_tax: q2(v.base_tax),
      charges_total: q2(v.charges_total),
    }))
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
