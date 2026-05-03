// Server-authoritative write-path tests. These exercise the production
// controllers (createQuote, updateQuoteItems, draftPO, handleUpdatePO) and
// assert that the persisted total_price reflects the engine's recomputation
// — NOT whatever total_price the client posted.
//
// They require a fully seeded test DB (RFQ, vendor mapping, products, etc.)
// and the standard Jest harness with Postgres globalSetup. See
// tests/setup/db.js (withTx) and tests/CONVENTIONS.md.
//
// Filed as it.todo for now: the harness pieces (RFQ factory + active-vendor
// mapping in a withTx context) are partially in place but a full smoke that
// inserts a quote with a wrong total_price and reads it back needs the
// approval-policy + visibility scaffolding from rfq.create.flow.test.js,
// which is heavy. Tracked in TODOS.md.

import { describe, it } from "@jest/globals";

describe("pricing — server-authoritative write paths (integration)", () => {
  it.todo("createQuote: client total_price=999999 → persisted total_price = engine recomputation");
  it.todo("updateQuoteItems: client total_price=0 with valid inputs → persisted total_price = engine recomputation");
  it.todo("draftPO: client total_value drifts from charges_meta → persisted total_value = engine recomputation");
  it.todo("handleUpdatePO: changing only charges_meta.tax → total_price recomputed; PO total_value re-aggregated");
  it.todo("handleUpdatePO: client supplies bogus total_price in changes → silently overwritten by engine");
});
