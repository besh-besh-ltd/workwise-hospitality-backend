const roundCurrency = (value) => Number((Number(value) || 0).toFixed(2));
const formatAmount = (value) => roundCurrency(value).toFixed(2);
const formatRate = (value) => (Number(value) || 0).toFixed(2);

const calculateChargeAmount = (baseAmount, value, mode) => {
  const normalizedValue = Number(value) || 0;
  if (mode === 'percentage') {
    return roundCurrency((baseAmount * normalizedValue) / 100);
  }
  return roundCurrency(normalizedValue);
};

const calculateTaxAmount = (taxableAmount, value, mode) => {
  const normalizedValue = Number(value) || 0;
  if (!mode || mode === 'percentage') {
    return roundCurrency((taxableAmount * normalizedValue) / 100);
  }
  return roundCurrency(normalizedValue);
};

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

export const buildPOTemplatePricing = (items = [], taxMode = 'gst') => {
  let basicAmount = 0;
  let totalFreight = 0;
  let totalPackage = 0;
  let totalTax = 0;
  let totalTaxableAmount = 0;

  const enrichedItems = items.map((item) => {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unit_price) || 0;
    const baseAmount = roundCurrency(quantity * unitPrice);
    const freightAmount = calculateChargeAmount(baseAmount, item.freight_price, item.freight_mode);
    const packageAmount = calculateChargeAmount(baseAmount, item.package_price, item.package_mode);
    const taxableAmount = roundCurrency(baseAmount + freightAmount + packageAmount);
    const taxAmount = calculateTaxAmount(taxableAmount, item.tax, item.tax_mode);
    const effectiveTaxRate = taxableAmount > 0 ? (taxAmount / taxableAmount) * 100 : 0;
    const comment = item.comment ? String(item.comment).trim() : null;

    basicAmount += baseAmount;
    totalFreight += freightAmount;
    totalPackage += packageAmount;
    totalTax += taxAmount;
    totalTaxableAmount += taxableAmount;

    const payload = {
      ...item,
      comment,
      delivery_period_display: formatDeliveryPeriodLabel(item.delivery_period),
      basic_amount: formatAmount(baseAmount),
      freight_amount: formatAmount(freightAmount),
      package_amount: formatAmount(packageAmount),
      taxable_amount: formatAmount(taxableAmount),
      effective_tax_rate: formatRate(effectiveTaxRate),
      tax_rate_display: formatRate(effectiveTaxRate),
      tax_amount: formatAmount(taxAmount),
      tax_detail_lines: buildItemTaxDetailLines(taxMode, effectiveTaxRate, taxAmount)
    };

    if (taxMode === 'split') {
      const cgstAmount = roundCurrency(taxAmount / 2);
      const sgstAmount = roundCurrency(taxAmount - cgstAmount);
      const splitRate = effectiveTaxRate / 2;

      payload.cgst_rate = formatRate(splitRate);
      payload.sgst_rate = formatRate(splitRate);
      payload.cgst_amount = formatAmount(cgstAmount);
      payload.sgst_amount = formatAmount(sgstAmount);
    } else if (taxMode === 'igst') {
      payload.igst_rate = formatRate(effectiveTaxRate);
      payload.igst_amount = formatAmount(taxAmount);
    } else {
      payload.gst_rate = formatRate(effectiveTaxRate);
      payload.gst_amount = formatAmount(taxAmount);
    }

    return payload;
  });

  const roundedBasicAmount = roundCurrency(basicAmount);
  const roundedFreight = roundCurrency(totalFreight);
  const roundedPackage = roundCurrency(totalPackage);
  const roundedTax = roundCurrency(totalTax);
  const totalPrice = roundCurrency(roundedBasicAmount + roundedFreight + roundedPackage + roundedTax);

  return {
    items: enrichedItems,
    taxMode,
    basicAmount: formatAmount(roundedBasicAmount),
    totalFreight: roundedFreight > 0 ? formatAmount(roundedFreight) : null,
    totalPackage: roundedPackage > 0 ? formatAmount(roundedPackage) : null,
    gstAmount: formatAmount(roundedTax),
    totalPrice: formatAmount(totalPrice),
    summaryTaxRows: buildTaxSummaryRows(taxMode, roundedTax, roundCurrency(totalTaxableAmount))
  };
};
