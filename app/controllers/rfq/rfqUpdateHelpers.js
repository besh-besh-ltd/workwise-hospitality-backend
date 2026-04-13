/**
 * WH-69: Snapshot-diff helpers for the rewritten PUT /rfq/update flow.
 *
 * The frontend sends a complete `snapshot` of the RFQ as it should be.
 * We read the current DB state via rfqModel.getFullRfqForEdit, compute a
 * structured diff, apply each section in a transaction, and emit one
 * tbl_rfq_change_history row per field touched.
 *
 * Hotels are intentionally NOT diffed here — they are immutable post-create.
 */

import {
  RFQ_EDITABLE_FIELDS,
  isFieldEditable,
  isFieldMaterial,
  isEntityChangeMaterial
} from './rfqEditableFields.js';

// ──────────────────────────────────────────────────────────────────────────
// 1. assertEditAllowed
// ──────────────────────────────────────────────────────────────────────────

/**
 * Throws a structured error if the current user is not allowed to edit
 * this RFQ. The check ladder is:
 *   1. RFQ exists
 *   2. Caller is the original creator
 *   3. Status is not CLOSED (2)
 *   4. bid_end_date is still in the future
 *   5. (per-product PO lock check happens inside applyProductChanges)
 */
export function assertEditAllowed(rfq, userId, { hasQuotes = false } = {}) {
  if (!rfq) {
    throw httpError(404, 'RFQ not found.');
  }
  if (Number(rfq.created_by) !== Number(userId)) {
    throw httpError(403, 'Only the RFQ creator can edit this RFQ.');
  }
  if (rfq.status === 2) {
    throw httpError(400, 'This RFQ is closed and can no longer be edited.');
  }
  if (rfq.bid_end_date && new Date(rfq.bid_end_date) <= new Date()) {
    // Allow editing when bid window closed but no vendors submitted quotes,
    // so the creator can extend the deadline.
    if (hasQuotes) {
      throw httpError(
        400,
        'The bid window has closed; this RFQ can no longer be edited.'
      );
    }
  }
}

export function httpError(status, message) {
  const err = new Error(message);
  err.isHttpError = true;
  err.statusCode = status;
  return err;
}

/**
 * Parse a wall-clock-IST datetime string ("2026-04-09 11:11", "2026-04-09T11:11",
 * "2026-04-09T11:11:00", or "2026-04-09") into an absolute epoch-ms.
 *
 * Critical: RFQ form dates flow through the API as wall-clock IST (no
 * timezone suffix). To compare them against `Date.now()` reliably we have
 * to anchor them to the IST offset BEFORE constructing the JS Date,
 * otherwise the comparison would be skewed by however the server happens
 * to be configured (UTC, IST, somewhere else). Mirror of the frontend
 * helper at frontend/utils/sharedFunctions.js → parseIstWallTimeToEpoch.
 *
 * Returns null when the input cannot be parsed.
 */
export function parseIstWallTimeToEpoch(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return raw.getTime();
  let s = String(raw).trim();
  if (!s) return null;
  // Strip any trailing timezone suffix to avoid double-offsetting.
  s = s.replace(/([+-]\d{2}:?\d{2}|Z)$/i, '');
  s = s.replace(' ', 'T');
  if (!/T/.test(s)) s += 'T00:00:00';
  else if (/T\d{2}:\d{2}$/.test(s)) s += ':00';
  const d = new Date(`${s}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Cross-cutting validation: enforces the bid_end_date 2-hour rule and the
 * vendor_clarification_date 1-hour buffer + post-publish constraint. Used
 * by the update controller before any DB mutation runs.
 *
 *   - bid_end_date >= now + 2h (IST)
 *   - vendor_clarification_date <= bid_end_date - 1h
 *   - vendor_clarification_date > tender_publish_date (when both present)
 *
 * The "effective" date is taken from the snapshot when present, falling
 * back to the current row when the snapshot doesn't carry the field. This
 * lets a partial edit (e.g. changing only `bid_end_date`) still validate
 * against the existing clarification date in the DB.
 */
export function assertEditDateConstraints({ snapshot, current }) {
  const eff = (key) => (snapshot && snapshot[key] !== undefined && snapshot[key] !== null && snapshot[key] !== ''
    ? snapshot[key]
    : current?.[key] ?? null);

  const bidEndRaw = eff('bid_end_date');
  const clarRaw = eff('vendor_clarification_date');
  const pubRaw = eff('tender_publish_date');

  // 2-hour minimum on bid_end_date — only re-validated when the snapshot
  // is actually trying to set the field. We don't want to retroactively
  // reject the existing value if the user is editing something unrelated.
  if (snapshot && snapshot.bid_end_date !== undefined && snapshot.bid_end_date !== null && snapshot.bid_end_date !== '') {
    const bidMs = parseIstWallTimeToEpoch(bidEndRaw);
    if (bidMs == null) {
      throw httpError(400, 'Invalid Quote Submission Deadline.');
    }
    const minMs = Date.now() + 2 * 60 * 60 * 1000;
    if (bidMs < minMs) {
      throw httpError(
        400,
        'Quote Submission Deadline must be at least 2 hours from now (IST).'
      );
    }
  }

  // Vendor clarification deadline rules — re-validated whenever the
  // snapshot touches either the clarification date OR the bid_end_date,
  // because changing one affects the buffer with the other.
  const touchesClarOrBid =
    snapshot &&
    (snapshot.vendor_clarification_date !== undefined ||
      snapshot.bid_end_date !== undefined);

  if (touchesClarOrBid && clarRaw) {
    const clarMs = parseIstWallTimeToEpoch(clarRaw);
    if (clarMs == null) {
      throw httpError(400, 'Invalid Vendor Clarification Deadline.');
    }
    if (bidEndRaw) {
      const bidMs = parseIstWallTimeToEpoch(bidEndRaw);
      if (bidMs != null && bidMs - clarMs < 60 * 60 * 1000) {
        throw httpError(
          400,
          'Vendor Clarification Deadline must be at least 1 hour before the Quote Submission Deadline.'
        );
      }
    }
    if (pubRaw) {
      const pubMs = parseIstWallTimeToEpoch(pubRaw);
      if (pubMs != null && clarMs <= pubMs) {
        throw httpError(
          400,
          'Vendor Clarification Deadline must be after the Tender Publish Date.'
        );
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 2. diffRfqSnapshot
// ──────────────────────────────────────────────────────────────────────────

/**
 * Returns a structured diff describing every change between current and
 * snapshot. Empty diff (`isEmpty: true`) means there is nothing to do.
 */
export function diffRfqSnapshot(current, snapshot) {
  // Defence in depth: hotels are not editable.
  if (
    Array.isArray(snapshot.hotel_ids) &&
    !sameNumberArrays(snapshot.hotel_ids, current.hotel_ids || [])
  ) {
    throw httpError(400, 'Hotel mappings cannot be changed after RFQ creation.');
  }

  const rfqFields = diffRfqFields(current, snapshot);
  const products  = diffProducts(current.products || [], snapshot.products || []);
  const terms     = diffTerms(current.terms || [], snapshot.terms || []);

  const isEmpty =
    rfqFields.length === 0 &&
    products.added.length === 0 &&
    products.removed.length === 0 &&
    products.updated.length === 0 &&
    terms.added.length === 0 &&
    terms.removed.length === 0;

  return { rfqFields, products, terms, isEmpty };
}

function diffRfqFields(current, snapshot) {
  const out = [];
  for (const fieldName of Object.keys(RFQ_EDITABLE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, fieldName)) continue;
    const oldValue = normaliseValue(current[fieldName]);
    const newValue = normaliseValue(snapshot[fieldName]);
    if (!valuesEqual(oldValue, newValue)) {
      out.push({
        field_name: fieldName,
        old_value: current[fieldName] ?? null,
        new_value: snapshot[fieldName] ?? null,
        material: isFieldMaterial(fieldName)
      });
    }
  }
  return out;
}

function diffProducts(currentProducts, snapshotProducts) {
  const currentById = new Map(currentProducts.map((p) => [p.id, p]));
  const snapshotIds = new Set(
    snapshotProducts.filter((p) => p.id != null).map((p) => p.id)
  );

  const added = [];
  const updated = [];
  const removed = [];

  for (const sp of snapshotProducts) {
    if (sp.id == null) {
      // newly added by the user
      added.push({ snapshot: sp });
      continue;
    }
    const cur = currentById.get(sp.id);
    if (!cur) {
      // shouldn't happen — frontend sent an id we no longer have
      throw httpError(
        400,
        `Product id ${sp.id} no longer exists on this RFQ. Refresh and try again.`
      );
    }
    const productDiff = diffSingleProduct(cur, sp);
    if (productDiff.hasChanges) {
      updated.push({ id: sp.id, current: cur, snapshot: sp, ...productDiff });
    }
  }

  for (const cp of currentProducts) {
    if (!snapshotIds.has(cp.id)) {
      removed.push({ id: cp.id, current: cp });
    }
  }

  return { added, removed, updated };
}

function diffSingleProduct(cur, snap) {
  const diff = {
    commentChanged: false,
    oldComment: cur.comment ?? '',
    newComment: snap.comment ?? '',
    specs: { added: [], removed: [], updated: [] },
    files: { added: [], removed: [] },        // each: { type: 'qap_file'|... , url }
    vendors: { added: [], removed: [] },      // user_id arrays
    techEvalChanged: false
  };

  // comment
  if (normaliseValue(cur.comment) !== normaliseValue(snap.comment)) {
    diff.commentChanged = true;
  }

  // specs (key/value map)
  const curSpecs = cur.specs || {};
  const newSpecs = snap.specs || {};
  for (const key of Object.keys(newSpecs)) {
    if (!(key in curSpecs)) {
      diff.specs.added.push({ title: key, value: newSpecs[key] });
    } else if (normaliseValue(curSpecs[key]) !== normaliseValue(newSpecs[key])) {
      diff.specs.updated.push({
        title: key,
        old_value: curSpecs[key],
        new_value: newSpecs[key]
      });
    }
  }
  for (const key of Object.keys(curSpecs)) {
    if (!(key in newSpecs)) {
      diff.specs.removed.push({ title: key, value: curSpecs[key] });
    }
  }

  // files (3 buckets, each is an array of urls)
  for (const bucket of ['qap_file', 'spec_file', 'datasheet_file']) {
    const cur_urls = (cur.files?.[bucket] || []).filter(Boolean);
    const new_urls = (snap.files?.[bucket] || []).filter(Boolean);
    const curSet = new Set(cur_urls);
    const newSet = new Set(new_urls);
    for (const u of new_urls) if (!curSet.has(u)) diff.files.added.push({ type: bucket, url: u });
    for (const u of cur_urls) if (!newSet.has(u)) diff.files.removed.push({ type: bucket, url: u });
  }

  // vendors (array of user_ids) — only additions; vendors are never removed
  // via the Edit RFQ flow (they can only be added via Refresh Vendors).
  const curVendorIds = new Set((cur.vendors || []).map((v) => Number(v.user_id)));
  const newVendorIds = new Set((snap.vendors || []).map((v) => Number(v)));
  for (const id of newVendorIds) if (!curVendorIds.has(id)) diff.vendors.added.push(id);

  // tech eval (loose check — just stringify-compare; deeper diff is overkill for now)
  const curTech = JSON.stringify(cur.tech_eval_clauses || []);
  const newTech = JSON.stringify(snap.tech_eval_clauses || []);
  if (curTech !== newTech) diff.techEvalChanged = true;

  diff.hasChanges =
    diff.commentChanged ||
    diff.specs.added.length > 0 ||
    diff.specs.removed.length > 0 ||
    diff.specs.updated.length > 0 ||
    diff.files.added.length > 0 ||
    diff.files.removed.length > 0 ||
    diff.vendors.added.length > 0 ||
    diff.techEvalChanged;

  return diff;
}

function diffTerms(currentTerms, snapshotTerms) {
  const cur = new Set(currentTerms.map(Number));
  const snap = new Set(snapshotTerms.map(Number));
  const added = [...snap].filter((id) => !cur.has(id));
  const removed = [...cur].filter((id) => !snap.has(id));
  return { added, removed };
}

// ──────────────────────────────────────────────────────────────────────────
// 3. apply* — write the diff to the database
// Each helper uses the pg-promise transaction `t` and is responsible for
// returning the list of history rows it produced.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Apply RFQ-level scalar field changes.
 * Returns: history rows
 */
export async function applyRfqFieldChanges(t, rfqId, rfqDiff) {
  if (rfqDiff.length === 0) return [];

  const setClauses = [];
  const values = [];
  rfqDiff.forEach((d, i) => {
    setClauses.push(`"${d.field_name}" = $${i + 1}`);
    values.push(d.new_value);
  });
  values.push(rfqId);

  await t.none(
    `UPDATE tbl_rfq SET ${setClauses.join(', ')} WHERE id = $${values.length}`,
    values
  );

  return rfqDiff.map((d) => ({
    entity_type: 'RFQ',
    entity_id: rfqId,
    entity_label: null,
    field_name: d.field_name,
    change_type: 'UPDATE',
    old_value: d.old_value,
    new_value: d.new_value,
    is_material: d.material
  }));
}

/**
 * Apply product changes (added/removed/updated). Mutates the DB and returns
 * history rows. Skips products that have an approved-PO lock and throws if
 * the user tried to modify them.
 *
 * @param poLockedIds Set<number> of rfq_product_ids with active POs
 */
export async function applyProductChanges(t, rfqId, productDiff, poLockedIds, rfqMeta) {
  const history = [];

  // Reject changes to PO-locked products
  for (const u of productDiff.updated) {
    if (poLockedIds.has(u.id)) {
      throw httpError(
        400,
        `Cannot edit product "${u.current.product_name || u.id}" — it has an approved Purchase Order.`
      );
    }
  }
  for (const r of productDiff.removed) {
    if (poLockedIds.has(r.id)) {
      throw httpError(
        400,
        `Cannot remove product "${r.current.product_name || r.id}" — it has an approved Purchase Order.`
      );
    }
  }

  // ── Removed products ────────────────────────────────────────────────────
  for (const r of productDiff.removed) {
    const label = r.current.product_name || `product ${r.id}`;
    // Cascading delete (mirrors current behaviour, but transactional)
    await t.none(
      `DELETE FROM tbl_rfq_product_files WHERE rfq_product_id = $1`,
      [r.id]
    );
    await t.none(
      `DELETE FROM tbl_rfq_products_specs
        WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
      [rfqId, r.current.product_variant_id, r.current.variant]
    );
    await t.none(
      `DELETE FROM tbl_rfq_product_vendors
        WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
      [rfqId, r.current.product_variant_id, r.current.variant]
    );
    await t.none(
      `DELETE FROM tbl_rfq_products WHERE id = $1`,
      [r.id]
    );

    // Enrich the DELETE row with the same shape the CREATE row uses so the
    // Edit History modal can render a friendly "Removed — had N vendors,
    // Qty: 20, Unit: Pcs, …" card instead of leaking raw JSON. r.current
    // is the row from getFullRfqForEdit and already carries specs/vendors.
    history.push({
      entity_type: 'PRODUCT',
      entity_id: r.id,
      entity_label: label,
      field_name: null,
      change_type: 'DELETE',
      old_value: {
        product_variant_id: r.current.product_variant_id,
        variant: r.current.variant,
        product_name: label,
        specs: r.current.specs || {},
        spec_count: Object.keys(r.current.specs || {}).length,
        vendor_count: (r.current.vendors || []).length,
        vendor_ids: (r.current.vendors || []).map((v) => Number(v.user_id)).filter((n) => !Number.isNaN(n))
      },
      new_value: null,
      is_material: isEntityChangeMaterial('PRODUCT', 'DELETE')
    });
  }

  // ── New products ────────────────────────────────────────────────────────
  for (const a of productDiff.added) {
    const sp = a.snapshot;
    // Pick the next variant for this product_variant_id under this RFQ
    const existingVariants = await t.any(
      `SELECT variant FROM tbl_rfq_products
        WHERE rfq_id = $1 AND product_variant_id = $2`,
      [rfqId, sp.product_variant_id]
    );
    const nextVariant =
      existingVariants.length === 0
        ? 0
        : Math.max(...existingVariants.map((v) => Number(v.variant) || 0)) + 1;

    // tbl_rfq_products has a handful of legacy NOT NULL columns left over
    // from the pre-files-as-rows era: comment, qap, qap_file, spec_file,
    // datasheet, datasheet_file. The new flow stores files in
    // tbl_rfq_product_files (per-row), so these legacy columns are
    // redundant — but the constraints still exist, so we have to write
    // empty strings to satisfy them. The legacy createOrUpdateRfqDraft
    // controller does the same thing.
    const inserted = await t.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, product_variant_id, variant, comment,
          qap, qap_file, spec_file, datasheet, datasheet_file)
       VALUES ($1, $2, $3, $4, '', '', '', '', '')
       RETURNING id`,
      [rfqId, sp.product_variant_id, nextVariant, sp.comment ?? '']
    );

    // Specs
    for (const [title, value] of Object.entries(sp.specs || {})) {
      await t.none(
        `INSERT INTO tbl_rfq_products_specs
           (rfq_id, product_variant_id, variant, title, value)
         VALUES ($1, $2, $3, $4, $5)`,
        [rfqId, sp.product_variant_id, nextVariant, title, value]
      );
    }

    // Files
    for (const bucket of ['qap_file', 'spec_file', 'datasheet_file']) {
      const fileType =
        bucket === 'qap_file' ? 'QAP' : bucket === 'spec_file' ? 'SPEC' : 'TDS';
      for (const url of (sp.files?.[bucket] || []).filter(Boolean)) {
        await t.none(
          `INSERT INTO tbl_rfq_product_files (rfq_product_id, file_type, file_url)
           VALUES ($1, $2, $3)`,
          [inserted.id, fileType, url]
        );
      }
    }

    // Vendors — explicit vendor list wins when present. Otherwise we
    // mirror the add-product-to-draft contract and auto-resolve every
    // eligible vendor for this variant within the RFQ's hotel scope. The
    // edit page never lets the user pick vendors for a brand-new product
    // (it can't — the rfq_product_id doesn't exist until this very
    // INSERT), so leaving the slot empty would silently break new-product
    // adds. The user can still tweak the vendor list after the save.
    let resolvedVendorIds = (sp.vendors || []).map(Number).filter((n) => !Number.isNaN(n));
    if (resolvedVendorIds.length === 0) {
      const hotelIds = Array.isArray(rfqMeta?.hotel_ids) ? rfqMeta.hotel_ids : [];
      if (hotelIds.length > 0) {
        // Inline copy of hospitalityModel.getEligibleVendorsForVariant so
        // the read participates in the same transaction as the inserts.
        const eligibleRows = await t.any(
          `WITH variant_vendors AS (
             SELECT DISTINCT vendor_id
             FROM tbl_product_variant_vendor_mapping
             WHERE product_variant_id = $1
               AND status = true
               AND is_approved = true
           ),
           eligible_hotel_vendors AS (
             SELECT DISTINCT s.vendor_id
             FROM tbl_vendor_hotel_category_subscription s
             JOIN variant_vendors vv ON vv.vendor_id = s.vendor_id
             WHERE s.item_type = 'hotel'
               AND s.item_id = ANY ($2)
               AND s.status IN ('active', 'expired')
           )
           SELECT vv.vendor_id
           FROM variant_vendors vv
           JOIN eligible_hotel_vendors ehv ON ehv.vendor_id = vv.vendor_id`,
          [sp.product_variant_id, hotelIds]
        );
        resolvedVendorIds = eligibleRows.map((r) => Number(r.vendor_id)).filter((n) => !Number.isNaN(n));
      }
    }

    const productLabel = sp.product_name || `product ${inserted.id}`;
    for (const userId of resolvedVendorIds) {
      await t.none(
        `INSERT INTO tbl_rfq_product_vendors
           (rfq_id, product_variant_id, variant, user_id)
         VALUES ($1, $2, $3, $4)`,
        [rfqId, sp.product_variant_id, nextVariant, userId]
      );
      // Per-vendor history row so the audit log captures who got
      // auto-attached to the new product. Mirrors the existing
      // PRODUCT_VENDOR / CREATE row used by `productDiff.updated`.
      history.push({
        entity_type: 'PRODUCT_VENDOR',
        entity_id: inserted.id,
        entity_label: productLabel,
        field_name: 'vendor',
        change_type: 'CREATE',
        old_value: null,
        new_value: userId,
        is_material: true
      });
    }

    // Mutate the diff snapshot in-place so `sendVendorEditNotifications`
    // sees the auto-resolved vendors and emails them with NEW_PRODUCT.
    // The notification helper reads `a.snapshot.vendors` directly.
    sp.vendors = resolvedVendorIds;

    history.push({
      entity_type: 'PRODUCT',
      entity_id: inserted.id,
      entity_label: productLabel,
      field_name: null,
      change_type: 'CREATE',
      old_value: null,
      // Carry the full specs map and vendor count so the Edit History
      // modal can render a human-readable "Added with 20 vendors. Qty: 20,
      // Unit: Pcs, Size: …" summary instead of leaking raw JSON. The
      // sibling PRODUCT_VENDOR rows below stay in the audit log but the
      // frontend collapses them under this row when both share the same
      // entity_id within an edit session.
      new_value: {
        product_variant_id: sp.product_variant_id,
        variant: nextVariant,
        product_name: productLabel,
        specs: sp.specs || {},
        spec_count: Object.keys(sp.specs || {}).length,
        vendor_count: resolvedVendorIds.length,
        vendor_ids: resolvedVendorIds
      },
      is_material: isEntityChangeMaterial('PRODUCT', 'CREATE')
    });
  }

  // ── Updated products ────────────────────────────────────────────────────
  for (const u of productDiff.updated) {
    const label = u.current.product_name || `product ${u.id}`;

    if (u.commentChanged) {
      await t.none(
        `UPDATE tbl_rfq_products SET comment = $1 WHERE id = $2`,
        [u.newComment, u.id]
      );
      history.push({
        entity_type: 'PRODUCT',
        entity_id: u.id,
        entity_label: label,
        field_name: 'comment',
        change_type: 'UPDATE',
        old_value: u.oldComment,
        new_value: u.newComment,
        is_material: false
      });
    }

    // Specs
    for (const s of u.specs.added) {
      await t.none(
        `INSERT INTO tbl_rfq_products_specs
           (rfq_id, product_variant_id, variant, title, value)
         VALUES ($1, $2, $3, $4, $5)`,
        [rfqId, u.current.product_variant_id, u.current.variant, s.title, s.value]
      );
      history.push({
        entity_type: 'PRODUCT_SPEC', entity_id: u.id, entity_label: label,
        field_name: s.title, change_type: 'CREATE',
        old_value: null, new_value: s.value, is_material: true
      });
    }
    for (const s of u.specs.updated) {
      await t.none(
        `UPDATE tbl_rfq_products_specs SET value = $1
          WHERE rfq_id = $2 AND product_variant_id = $3 AND variant = $4 AND title = $5`,
        [s.new_value, rfqId, u.current.product_variant_id, u.current.variant, s.title]
      );
      history.push({
        entity_type: 'PRODUCT_SPEC', entity_id: u.id, entity_label: label,
        field_name: s.title, change_type: 'UPDATE',
        old_value: s.old_value, new_value: s.new_value, is_material: true
      });
    }
    for (const s of u.specs.removed) {
      await t.none(
        `DELETE FROM tbl_rfq_products_specs
          WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3 AND title = $4`,
        [rfqId, u.current.product_variant_id, u.current.variant, s.title]
      );
      history.push({
        entity_type: 'PRODUCT_SPEC', entity_id: u.id, entity_label: label,
        field_name: s.title, change_type: 'DELETE',
        old_value: s.value, new_value: null, is_material: true
      });
    }

    // Files
    for (const f of u.files.added) {
      const fileType =
        f.type === 'qap_file' ? 'QAP' : f.type === 'spec_file' ? 'SPEC' : 'TDS';
      await t.none(
        `INSERT INTO tbl_rfq_product_files (rfq_product_id, file_type, file_url)
         VALUES ($1, $2, $3)`,
        [u.id, fileType, f.url]
      );
      history.push({
        entity_type: 'PRODUCT_FILE', entity_id: u.id, entity_label: label,
        field_name: f.type, change_type: 'CREATE',
        old_value: null, new_value: f.url, is_material: true
      });
    }
    for (const f of u.files.removed) {
      const fileType =
        f.type === 'qap_file' ? 'QAP' : f.type === 'spec_file' ? 'SPEC' : 'TDS';
      await t.none(
        `DELETE FROM tbl_rfq_product_files
          WHERE rfq_product_id = $1 AND file_type = $2 AND file_url = $3`,
        [u.id, fileType, f.url]
      );
      history.push({
        entity_type: 'PRODUCT_FILE', entity_id: u.id, entity_label: label,
        field_name: f.type, change_type: 'DELETE',
        old_value: f.url, new_value: null, is_material: true
      });
    }

    // Vendors
    for (const userId of u.vendors.added) {
      await t.none(
        `INSERT INTO tbl_rfq_product_vendors
           (rfq_id, product_variant_id, variant, user_id)
         VALUES ($1, $2, $3, $4)`,
        [rfqId, u.current.product_variant_id, u.current.variant, userId]
      );
      history.push({
        entity_type: 'PRODUCT_VENDOR', entity_id: u.id, entity_label: label,
        field_name: 'vendor', change_type: 'CREATE',
        old_value: null, new_value: userId, is_material: true
      });
    }
    // Vendor removal is intentionally disabled — vendors can only be added
    // via the Edit RFQ flow, never removed.

    if (u.techEvalChanged) {
      // Tech eval clauses are saved by their own dedicated endpoints
      // (addClause / updateClause / removeClause) BEFORE the RFQ update
      // flow runs, so u.current (fetched from DB) already reflects the NEW
      // state while u.snapshot (from the frontend) still holds the OLD
      // state. Swap them so old_value/new_value are correct in history.
      history.push({
        entity_type: 'PRODUCT_TECH_EVAL', entity_id: u.id, entity_label: label,
        field_name: 'clauses', change_type: 'UPDATE',
        old_value: u.snapshot.tech_eval_clauses,
        new_value: u.current.tech_eval_clauses,
        is_material: true
      });
    }
  }

  return history;
}

/**
 * Apply terms changes (just diff the rfq_terms_map).
 */
export async function applyTermsChanges(t, rfqId, termsDiff) {
  const history = [];
  for (const id of termsDiff.added) {
    await t.none(
      `INSERT INTO tbl_rfq_terms_map (rfq_id, terms_id) VALUES ($1, $2)`,
      [rfqId, id]
    );
    history.push({
      entity_type: 'TERMS', entity_id: id, entity_label: null,
      field_name: null, change_type: 'CREATE',
      old_value: null, new_value: id, is_material: false
    });
  }
  for (const id of termsDiff.removed) {
    await t.none(
      `DELETE FROM tbl_rfq_terms_map WHERE rfq_id = $1 AND terms_id = $2`,
      [rfqId, id]
    );
    history.push({
      entity_type: 'TERMS', entity_id: id, entity_label: null,
      field_name: null, change_type: 'DELETE',
      old_value: id, new_value: null, is_material: false
    });
  }
  return history;
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Internal helpers
// ──────────────────────────────────────────────────────────────────────────

function normaliseValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim();
  if (v instanceof Date) return v.toISOString();
  return v;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object')
    return JSON.stringify(a) === JSON.stringify(b);
  // numeric coercion (e.g. "1" vs 1)
  if (!isNaN(Number(a)) && !isNaN(Number(b))) return Number(a) === Number(b);
  return false;
}

function sameNumberArrays(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].map(Number).sort();
  const sb = [...b].map(Number).sort();
  return sa.every((v, i) => v === sb[i]);
}
