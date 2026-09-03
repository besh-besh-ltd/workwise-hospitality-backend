// Unit-level cover for the product half of `diffRfqSnapshot`.
//
// The integration suite (rfq.update.productRemoval.test.js) proves the
// behaviour end to end through the controller and Postgres. This file pins the
// decision table itself, where the edge cases are cheap to enumerate and the
// failure messages point straight at the rule that broke:
//
//   present in snapshot | named in deleted_product_ids | outcome
//   --------------------|------------------------------|------------------
//   yes                 | no                           | kept
//   no                  | yes                          | deleted
//   no                  | no                           | 409 (stale client)
//   yes                 | yes                          | 400 (contradiction)
//   not on the RFQ      | yes                          | ignored
//
// `diffRfqSnapshot` is the production function; nothing here re-implements it.

import { describe, it, expect } from "@jest/globals";
import { diffRfqSnapshot } from "../../app/controllers/rfq/rfqUpdateHelpers.js";

// Shape produced by rfqModel.getFullRfqForEdit for one product row.
const currentProduct = (over = {}) => ({
  id: 4732,
  product_variant_id: 3192,
  variant: 2,
  product_name: "SPLIT AC 2 TR",
  comment: "",
  specs: { Quantity: "4", Unit: "pcs" },
  vendors: [],
  qap_file: [],
  spec_file: [],
  datasheet_file: [],
  tech_eval_clauses: [],
  ...over,
});

// Shape the frontend's buildEditSnapshotPayload emits for one product.
const snapshotProduct = (over = {}) => ({
  id: 4732,
  product_variant_id: 3192,
  variant: 2,
  product_name: "SPLIT AC 2 TR",
  comment: "",
  specs: { Quantity: "4", Unit: "pcs" },
  files: { qap_file: [], spec_file: [], datasheet_file: [] },
  vendors: [],
  tech_eval_clauses: [],
  ...over,
});

const current = (products) => ({
  id: 701,
  hotel_ids: [30],
  terms: [],
  term_and_condition_files: [],
  products,
});

const snapshot = (products, over = {}) => ({
  products,
  deleted_product_ids: [],
  ...over,
});

const diff = (cur, snap) => diffRfqSnapshot(current(cur), snapshot(snap.products, snap));

describe("diffRfqSnapshot — products kept", () => {
  it("keeps a product that is present and not marked for removal", () => {
    const out = diff([currentProduct()], { products: [snapshotProduct()] });
    expect(out.products.removed).toEqual([]);
    expect(out.products.added).toEqual([]);
  });

  it("reports no changes at all when the snapshot matches the RFQ", () => {
    const out = diff([currentProduct()], { products: [snapshotProduct()] });
    expect(out.isEmpty).toBe(true);
  });

  it("treats a product with id null as an addition, not a removal candidate", () => {
    const out = diff([currentProduct()], {
      products: [snapshotProduct(), snapshotProduct({ id: null, product_variant_id: 3193 })],
    });
    expect(out.products.added).toHaveLength(1);
    expect(out.products.removed).toEqual([]);
  });
});

describe("diffRfqSnapshot — products removed", () => {
  it("removes a product that is absent and named in deleted_product_ids", () => {
    const out = diff([currentProduct({ id: 1 }), currentProduct({ id: 2 })], {
      products: [snapshotProduct({ id: 1 })],
      deleted_product_ids: [2],
    });
    expect(out.products.removed.map((r) => r.id)).toEqual([2]);
  });

  it("carries the current row along with the removal so history can describe it", () => {
    // applyProductChanges builds the "Removed — had N vendors, Qty …" card from
    // this, and the cascade needs product_variant_id + variant.
    const out = diff([currentProduct({ id: 1 }), currentProduct({ id: 2, variant: 3 })], {
      products: [snapshotProduct({ id: 1 })],
      deleted_product_ids: [2],
    });
    expect(out.products.removed[0].current.variant).toBe(3);
    expect(out.products.removed[0].current.product_name).toBe("SPLIT AC 2 TR");
  });

  it("removes several products at once", () => {
    const out = diff(
      [currentProduct({ id: 1 }), currentProduct({ id: 2 }), currentProduct({ id: 3 })],
      { products: [snapshotProduct({ id: 1 })], deleted_product_ids: [2, 3] }
    );
    expect(out.products.removed.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it("counts a removal as a change so the save is not treated as a no-op", () => {
    const out = diff([currentProduct({ id: 1 }), currentProduct({ id: 2 })], {
      products: [snapshotProduct({ id: 1 })],
      deleted_product_ids: [2],
    });
    expect(out.isEmpty).toBe(false);
  });

  it("accepts ids that arrive as numeric strings", () => {
    const out = diff([currentProduct({ id: 1 }), currentProduct({ id: 2 })], {
      products: [snapshotProduct({ id: 1 })],
      deleted_product_ids: ["2"],
    });
    expect(out.products.removed.map((r) => r.id)).toEqual([2]);
  });

  it("ignores a removal for an id the RFQ does not have", () => {
    // Already gone — a retry after a 409, or a concurrent save that beat us.
    // The desired end state already holds, so this is not an error.
    const out = diff([currentProduct({ id: 1 })], {
      products: [snapshotProduct({ id: 1 })],
      deleted_product_ids: [999],
    });
    expect(out.products.removed).toEqual([]);
    expect(out.isEmpty).toBe(true);
  });
});

describe("diffRfqSnapshot — refuses to infer a deletion", () => {
  const omitted = () =>
    diff([currentProduct({ id: 1 }), currentProduct({ id: 2 })], {
      products: [snapshotProduct({ id: 1 })],
      deleted_product_ids: [],
    });

  it("throws when a product is absent and nobody asked for it to go", () => {
    // The RFQ 536245 data-loss path.
    expect(omitted).toThrow();
  });

  it("throws 409 so the client can tell a conflict from a bad request", () => {
    expect(omitted).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it("tags the error with the products field so the wizard jumps to that step", () => {
    expect(omitted).toThrow(expect.objectContaining({ field: "products" }));
  });

  it("names the product at risk and tells the buyer to refresh", () => {
    expect(omitted).toThrow(/SPLIT AC 2 TR/);
    expect(omitted).toThrow(/refresh/i);
  });

  it("throws when deleted_product_ids is missing entirely", () => {
    const run = () =>
      diffRfqSnapshot(current([currentProduct({ id: 1 }), currentProduct({ id: 2 })]), {
        products: [snapshotProduct({ id: 1 })],
      });
    expect(run).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it("throws when the snapshot carries no products at all but the RFQ has some", () => {
    // A snapshot built before the store had loaded would look like this.
    const run = () =>
      diffRfqSnapshot(current([currentProduct({ id: 1 })]), { products: [], deleted_product_ids: [] });
    expect(run).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});

describe("diffRfqSnapshot — contradictory removal", () => {
  const contradictory = () =>
    diff([currentProduct({ id: 1 })], {
      products: [snapshotProduct({ id: 1 })],
      deleted_product_ids: [1],
    });

  it("throws when a product is both kept and deleted", () => {
    expect(contradictory).toThrow();
  });

  it("throws 400 — the request is malformed, not stale", () => {
    expect(contradictory).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it("names the product so the buyer can see which one disagreed", () => {
    expect(contradictory).toThrow(/SPLIT AC 2 TR/);
  });
});

describe("diffRfqSnapshot — the RFQ must keep at least one product", () => {
  it("throws 400 when the only product is removed", () => {
    const run = () =>
      diff([currentProduct({ id: 1 })], { products: [], deleted_product_ids: [1] });
    expect(run).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(run).toThrow(/at least one product/i);
  });

  it("allows the last product to be swapped for a replacement in one save", () => {
    const out = diff([currentProduct({ id: 1 })], {
      products: [snapshotProduct({ id: null, product_variant_id: 3193 })],
      deleted_product_ids: [1],
    });
    expect(out.products.removed.map((r) => r.id)).toEqual([1]);
    expect(out.products.added).toHaveLength(1);
  });

  it("does not fire on an RFQ that already had no products", () => {
    // Nothing was removed, so the guard must stay out of the way.
    const out = diff([], { products: [], deleted_product_ids: [] });
    expect(out.products.removed).toEqual([]);
  });
});
