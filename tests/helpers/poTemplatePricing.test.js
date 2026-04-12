import { buildPrimaryCompanyLocationPayload } from "../../app/helper/companyLocation.js";
import { buildPOTemplatePricing, resolvePOTaxMode } from "../../app/helper/poTemplatePricing.js";

describe("poTemplate pricing helpers", () => {
  test("builds a primary company location payload from registration fields", () => {
    expect(
      buildPrimaryCompanyLocationPayload(
        {
          address: "Plot 1, Sample Estate",
          country: "1",
          state: "27",
          city: "301",
          postal_code: "400001"
        },
        42
      )
    ).toEqual({
      address: "Plot 1, Sample Estate",
      country_id: 1,
      state_id: 27,
      city_id: 301,
      postal_code: "400001",
      created_by: 42,
      updated_by: 42
    });
  });

  test("uses CGST and SGST when buyer and vendor primary state_id values match", () => {
    const taxMode = resolvePOTaxMode({ state_id: 27 }, { state_id: 27 });
    const pricing = buildPOTemplatePricing(
      [
        {
          quantity: 2,
          unit_price: 100,
          freight_price: 10,
          freight_mode: "percentage",
          package_price: 5,
          package_mode: "actual",
          tax: 18,
          tax_mode: "percentage",
          delivery_period: "5",
          comment: "Pack carefully"
        }
      ],
      taxMode
    );

    expect(taxMode).toBe("split");
    expect(pricing.summaryTaxRows).toEqual([
      { label: "CGST", rate_display: "9.00", amount: "20.25" },
      { label: "SGST", rate_display: "9.00", amount: "20.25" }
    ]);
    expect(pricing.items[0].tax_detail_lines).toEqual([
      "CGST 9.00% Amt: 20.25",
      "SGST 9.00% Amt: 20.25"
    ]);
    expect(pricing.items[0].delivery_period_display).toBe("5 days");
    expect(pricing.items[0].comment).toBe("Pack carefully");
  });

  test("uses IGST when buyer and vendor primary state_id values differ", () => {
    const taxMode = resolvePOTaxMode({ state_id: 27 }, { state_id: 24 });
    const pricing = buildPOTemplatePricing(
      [
        {
          quantity: 1,
          unit_price: 100,
          freight_price: 0,
          freight_mode: "actual",
          package_price: 0,
          package_mode: "actual",
          tax: 18,
          tax_mode: "percentage"
        }
      ],
      taxMode
    );

    expect(taxMode).toBe("igst");
    expect(pricing.summaryTaxRows).toEqual([
      { label: "IGST", rate_display: "18.00", amount: "18.00" }
    ]);
    expect(pricing.items[0].tax_detail_lines).toEqual([
      "IGST 18.00% Amt: 18.00"
    ]);
  });

  test("falls back to plain GST when either side is missing usable company location state_id", () => {
    const taxMode = resolvePOTaxMode({ state_id: 27 }, null);
    const pricing = buildPOTemplatePricing(
      [
        {
          quantity: 1,
          unit_price: 250,
          freight_price: 0,
          freight_mode: "actual",
          package_price: 0,
          package_mode: "actual",
          tax: 12,
          tax_mode: "percentage"
        }
      ],
      taxMode
    );

    expect(taxMode).toBe("gst");
    expect(pricing.summaryTaxRows).toEqual([
      { label: "GST", rate_display: "12.00", amount: "30.00" }
    ]);
    expect(pricing.items[0].tax_detail_lines).toEqual([
      "GST 12.00% Amt: 30.00"
    ]);
  });
});
