import pricingEngine from '../services/pricingEngine.js';

const roundCurrency = (value) => Number((Number(value) || 0).toFixed(2));
const formatAmount = (value) => roundCurrency(value).toFixed(2);
const formatRate = (value) => (Number(value) || 0).toFixed(2);

export const resolvePOTaxMode = (buyerLocation, supplierLocation) => {
  const buyerStateId = Number.parseInt(buyerLocation?.state_id, 10);
  const supplierStateId = Number.parseInt(supplierLocation?.state_id, 10);

  if (!buyerLocation || !supplierLocation || Number.isNaN(buyerStateId) || Number.isNaN(supplierStateId)) {
    return 'gst';
  }

  return buyerStateId === supplierStateId ? 'split' : 'igst';
};

export const formatDeliveryPeriodLabel = (deliveryPeriod) => {
  if (deliveryPeriod === undefined || deliveryPeriod === null || deliveryPeriod === '') return null;

  const deliveryDays = Number.parseInt(deliveryPeriod, 10);
  if (!Number.isNaN(deliveryDays)) {
    return `${deliveryDays} day${deliveryDays === 1 ? '' : 's'}`;
  }

  return String(deliveryPeriod).trim() || null;
};

const buildTaxSummaryRows = (taxMode, totalTaxAmount, totalTaxableAmount) => {
  const effectiveRate = totalTaxableAmount > 0 ? (totalTaxAmount / totalTaxableAmount) * 100 : 0;

  if (taxMode === 'split') {
    const cgstAmount = roundCurrency(totalTaxAmount / 2);
    const sgstAmount = roundCurrency(totalTaxAmount - cgstAmount);
    const splitRate = effectiveRate / 2;

    return [
      {
        label: 'CGST',
        rate_display: formatRate(splitRate),
        amount: formatAmount(cgstAmount)
      },
      {
        label: 'SGST',
        rate_display: formatRate(splitRate),
        amount: formatAmount(sgstAmount)
      }
    ];
  }

  return [
    {
      label: taxMode === 'igst' ? 'IGST' : 'GST',
      rate_display: formatRate(effectiveRate),
      amount: formatAmount(totalTaxAmount)
    }
  ];
};

const buildItemTaxDetailLines = (taxMode, effectiveTaxRate, taxAmount) => {
  if (taxMode === 'split') {
    const cgstAmount = roundCurrency(taxAmount / 2);
    const sgstAmount = roundCurrency(taxAmount - cgstAmount);
    const splitRate = effectiveTaxRate / 2;

    return [
      `CGST ${formatRate(splitRate)}% Amt: ${formatAmount(cgstAmount)}`,
      `SGST ${formatRate(splitRate)}% Amt: ${formatAmount(sgstAmount)}`
    ];
  }

  const label = taxMode === 'igst' ? 'IGST' : 'GST';
  return [`${label} ${formatRate(effectiveTaxRate)}% Amt: ${formatAmount(taxAmount)}`];
};

// Build engine input from a PO line. Routes both the new other_charges[] and
// legacy flat freight/package shapes through the same canonical adapter the
// rest of the codebase uses (pricingEngine.normalizeChargesMeta).
const buildEngineInput = (item) => {
  const meta = pricingEngine.normalizeChargesMeta({
    tax: item.tax,
    tax_mode: item.tax_mode,
    other_charges: Array.isArray(item.other_charges) && item.other_charges.length > 0
      ? item.other_charges
      : undefined,
    freight_price: item.freight_price,
    freight_mode: item.freight_mode,
    package_price: item.package_price,
    package_mode: item.package_mode
  });
  return {
    unit_price: item.unit_price,
    quantity: item.quantity,
    tax: meta.tax,
    tax_mode: meta.tax_mode,
    other_charges: meta.other_charges
  };
};

// PDF totals are sourced from the same pricing engine that recomputes on save
// (handleUpdatePO) and that the quote-compare page renders. Per-line "Subtotal"
// (basic + charges + tax) is shown in its own column so each row is
// self-contained; the bottom cost-breakup carries only aggregate amounts and,
// when present, PO-level global charges.
export const buildPOTemplatePricing = (items = [], taxMode = 'gst', globalChargesInput = []) => {
  let totalBasic = 0;
  let totalChargesAmount = 0; // sum of per-line charge AMOUNTS (excl. their tax)
  let totalChargesTax = 0;    // sum of per-line charge taxes
  let totalBaseTax = 0;       // sum of base tax across lines
  let totalSubtotal = 0;      // sum of per-line engine totals

  const enrichedItems = items.map((item) => {
    const engineOut = pricingEngine.calculateLineTotal(buildEngineInput(item));
    const comment = item.comment ? String(item.comment).trim() : null;

    const baseAmount = roundCurrency(engineOut.base);
    const baseTaxAmount = roundCurrency(engineOut.base_tax);
    const lineSubtotal = roundCurrency(engineOut.total);

    // Per-charge breakdown for the row's description column. `has_tax` lets
    // the template render "Charge: ₹X + ₹Y tax" only when a tax actually
    // applies (matches the engine's inheritance rule via the tax field
    // already being populated).
    const chargeDetails = (engineOut.charges || []).map((c) => {
      const amount = roundCurrency(c.amount);
      const tax = roundCurrency(c.tax);
      return {
        name: c.name || 'Other',
        amount: formatAmount(amount),
        tax: formatAmount(tax),
        has_tax: tax > 0,
        amount_raw: amount,
        tax_raw: tax,
      };
    });

    let lineChargesAmount = 0;
    let lineChargesTax = 0;
    for (const cd of chargeDetails) {
      lineChargesAmount += cd.amount_raw;
      lineChargesTax += cd.tax_raw;
    }

    const lineTaxAmount = roundCurrency(baseTaxAmount + lineChargesTax);
    const effectiveTaxRate = baseAmount > 0 ? (baseTaxAmount / baseAmount) * 100 : 0;

    totalBasic += baseAmount;
    totalChargesAmount += lineChargesAmount;
    totalChargesTax += lineChargesTax;
    totalBaseTax += baseTaxAmount;
    totalSubtotal += lineSubtotal;

    const payload = {
      ...item,
      comment,
      total_price: lineSubtotal,
      subtotal: formatAmount(lineSubtotal),
      delivery_period_display: formatDeliveryPeriodLabel(item.delivery_period),
      basic_amount: formatAmount(baseAmount),
      charge_details: chargeDetails,
      taxable_amount: formatAmount(baseAmount),
      effective_tax_rate: formatRate(effectiveTaxRate),
      tax_rate_display: formatRate(effectiveTaxRate),
      tax_amount: formatAmount(lineTaxAmount),
      tax_detail_lines: buildItemTaxDetailLines(taxMode, effectiveTaxRate, lineTaxAmount),
    };

    if (taxMode === 'split') {
      const cgstAmount = roundCurrency(lineTaxAmount / 2);
      const sgstAmount = roundCurrency(lineTaxAmount - cgstAmount);
      const splitRate = effectiveTaxRate / 2;

      payload.cgst_rate = formatRate(splitRate);
      payload.sgst_rate = formatRate(splitRate);
      payload.cgst_amount = formatAmount(cgstAmount);
      payload.sgst_amount = formatAmount(sgstAmount);
    } else if (taxMode === 'igst') {
      payload.igst_rate = formatRate(effectiveTaxRate);
      payload.igst_amount = formatAmount(lineTaxAmount);
    } else {
      payload.gst_rate = formatRate(effectiveTaxRate);
      payload.gst_amount = formatAmount(lineTaxAmount);
    }

    return payload;
  });

  const roundedBasic = roundCurrency(totalBasic);
  const roundedChargesAmount = roundCurrency(totalChargesAmount);
  const roundedTotalTax = roundCurrency(totalBaseTax + totalChargesTax);
  const roundedSubtotal = roundCurrency(totalSubtotal);

  // Resolve PO-level global charges (Insurance, Handling, Discount applied
  // to the whole PO) as percentage/absolute against the items subtotal.
  // Global charges sit at the bottom — never per-row — so they're clearly
  // separated from the product-level charges already rendered inline.
  const resolvedGlobalCharges = (globalChargesInput || [])
    .map((gc) => {
      if (!gc) return null;
      const amount = roundCurrency(
        pricingEngine.applyChargeMode(gc.amount, gc.amount_mode, roundedSubtotal)
      );
      if (amount <= 0) return null;
      return {
        name: gc.name || 'Global Charge',
        amount: formatAmount(amount),
        amount_raw: amount,
      };
    })
    .filter(Boolean);

  const globalChargesTotal = resolvedGlobalCharges.reduce((s, gc) => s + gc.amount_raw, 0);
  const totalPOValue = roundCurrency(roundedSubtotal + globalChargesTotal);

  return {
    items: enrichedItems,
    taxMode,
    basicAmount: formatAmount(roundedBasic),
    totalCharges: roundedChargesAmount > 0 ? formatAmount(roundedChargesAmount) : null,
    gstAmount: formatAmount(roundedTotalTax),
    totalSubtotal: formatAmount(roundedSubtotal),
    globalCharges: resolvedGlobalCharges.length > 0 ? resolvedGlobalCharges : null,
    totalPrice: formatAmount(totalPOValue),
    summaryTaxRows: buildTaxSummaryRows(taxMode, roundedTotalTax, roundedBasic),
  };
};
