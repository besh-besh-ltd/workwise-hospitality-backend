import { jest } from "@jest/globals";
import {
  buildQuoteVisibilityMeta,
  sanitizeQuoteProductsForLockedState,
} from "../../app/helper/quoteVisibility.js";

describe("quoteVisibility helper", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("locks quote visibility before the IST deadline", () => {
    jest.setSystemTime(new Date("2026-04-09T05:00:00.000Z")); // 10:30 IST

    const meta = buildQuoteVisibilityMeta({ bid_end_date: "2026-04-09 11:00:00" });

    expect(meta.locked).toBe(true);
    expect(meta.timezone).toBe("Asia/Kolkata");
    expect(meta.remainingMs).toBeGreaterThan(0);
  });

  test("keeps quotes locked at the exact deadline instant", () => {
    jest.setSystemTime(new Date("2026-04-09T05:30:00.000Z")); // 11:00 IST

    const meta = buildQuoteVisibilityMeta({ bid_end_date: "2026-04-09 11:00:00" });

    expect(meta.locked).toBe(true);
    expect(meta.remainingMs).toBe(0);
  });

  test("unlocks quote visibility after the IST deadline has passed", () => {
    jest.setSystemTime(new Date("2026-04-09T05:30:01.000Z")); // 11:00:01 IST

    const meta = buildQuoteVisibilityMeta({ bid_end_date: "2026-04-09 11:00:00" });

    expect(meta.locked).toBe(false);
    expect(meta.remainingMs).toBe(0);
  });

  test("sanitizes quote-bearing fields for locked product payloads", () => {
    const quoteVisibility = {
      locked: true,
      deadline: "2026-04-09 11:00:00",
      remainingMs: 60000,
    };
    const products = [
      {
        id: 11,
        quotations: [{ id: 91 }],
        all_vendors: [{ id: 7 }],
        finalization_history: [{ id: 12 }],
        last_purchase_rate: { total_price: 500 },
        last_quote_rate: { total_price: 480 },
        latest_target_price: 450,
      },
    ];

    const sanitized = sanitizeQuoteProductsForLockedState(products, quoteVisibility);

    expect(sanitized[0].quotations).toEqual([]);
    expect(sanitized[0].all_vendors).toEqual([]);
    expect(sanitized[0].finalization_history).toEqual([]);
    expect(sanitized[0].last_purchase_rate).toBeNull();
    expect(sanitized[0].last_quote_rate).toBeNull();
    expect(sanitized[0].latest_target_price).toBeNull();
    expect(sanitized[0].quoteVisibility).toEqual(quoteVisibility);
  });
});
