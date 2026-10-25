// Mark out to a department, and return to stock (spec §8.1-8.2).
//
// One scan session = one tbl_inv_out document, posted on creation (no draft,
// no approval). OUT posts MARK_OUT per line at the current average cost;
// RETURN posts RETURN_IN tagged with the department, at the current average,
// or at the last MARK_OUT unit cost of that item at the hotel when nothing is
// on hand (the goods go back at what they were issued at). A department
// returns at most its net issued quantity of the item at the hotel (mark-outs
// less earlier returns); stock that was never issued comes in as a FOUND
// adjustment instead.
//
// Idempotency: tbl_inv_out.client_event_id is UNIQUE. A replayed session
// (dropped connection, outbox retry) returns the original document; replays
// of one key are serialised on an advisory lock so two concurrent copies
// cannot both post.
//
// Lock order inside the posting transaction: client-event advisory lock →
// doc sequence (nextDocNumber) → balance rows (for RETURN, locked here in
// item order before postMovements, which takes the same rows in the same
// order) → postMovements (called once).

import { hotelIdsWithPermission } from './scope.js';
import { nextDocNumber } from './docNumber.js';
import { postMovements } from './ledger.js';
import {
  MAX_LINES, PAGE_SIZE, positiveInt, invalid, notFound, conflict, num, money, iso, pageOf, requireUuid, toQty,
  optionalText, optionalDay, assertDocAccess, loadCompanyItems, assertNotFrozen, explainMissingCost,
} from './stockCommon.js';

export const OUT_DOC_TYPES = Object.freeze(['OUT', 'RETURN']);
const DOC_CODE = { OUT: 'OUT', RETURN: 'RET' };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** OutDoc payload (no access check). */
export async function loadOutDoc(t, outId) {
  const h = await t.oneOrNone(
    `SELECT o.id, o.out_number, o.doc_type, o.hospitality_company_id, o.hotel_id, hh.name AS hotel_name,
            o.department_id, d.title AS department_name, o.requested_by_name, o.remarks,
            o.client_event_id, o.posted_by, u.name AS posted_by_name, o.posted_at
       FROM tbl_inv_out o
       JOIN tbl_hospitality_company_hotels hh ON hh.id = o.hotel_id
       LEFT JOIN tbl_department d ON d.id = o.department_id
       LEFT JOIN tbl_users u      ON u.id = o.posted_by
      WHERE o.id = $1`,
    [outId]
  );
  if (!h) throw notFound('Document not found');
  const lines = await t.any(
    `SELECT l.id, l.inv_item_id, i.display_name, i.item_code, i.stock_uom, l.qty::text AS qty,
            m.unit_cost::text AS unit_cost, m.value::text AS value
       FROM tbl_inv_out_line l
       JOIN tbl_inv_item i ON i.id = l.inv_item_id
       -- one row per batch for a track_expiry item split across batches (ledger FEFO)
       LEFT JOIN LATERAL (
         SELECT min(mm.unit_cost) AS unit_cost, sum(mm.value) AS value
           FROM tbl_inv_movement mm
          WHERE mm.source_type = 'OUT' AND mm.source_id = l.out_id AND mm.source_line_id = l.id
            AND mm.hospitality_company_id = l.hospitality_company_id
       ) m ON true
      WHERE l.out_id = $1
      ORDER BY l.id`,
    [outId]
  );
  const mapped = lines.map((l) => ({
    id: Number(l.id),
    invItemId: Number(l.inv_item_id),
    displayName: l.display_name,
    itemCode: l.item_code ?? null,
    qty: Number(l.qty),
    stockUom: l.stock_uom,
    unitCost: num(l.unit_cost),
    value: l.value == null ? null : Math.abs(Number(l.value)),
  }));
  return {
    id: Number(h.id),
    outNumber: h.out_number,
    docType: h.doc_type,
    companyId: Number(h.hospitality_company_id),
    hotelId: Number(h.hotel_id),
    hotelName: h.hotel_name,
    departmentId: Number(h.department_id),
    departmentName: h.department_name ?? null,
    requestedByName: h.requested_by_name ?? null,
    remarks: h.remarks ?? null,
    clientEventId: h.client_event_id ?? null,
    lines: mapped,
    totalValue: money(mapped.reduce((s, l) => s + (l.value ?? 0), 0)),
    postedAt: iso(h.posted_at),
    postedBy: h.posted_by == null ? null : Number(h.posted_by),
    postedByName: h.posted_by_name ?? null,
  };
}

/** GET /out/:id: inventory.read at the document's hotel, else NOT_FOUND. */
export async function getOut(t, user, outId) {
  const id = positiveInt(outId);
  const row = id ? await t.oneOrNone(`SELECT hotel_id FROM tbl_inv_out WHERE id = $1`, [id]) : null;
  if (!row) throw notFound('Document not found');
  await assertDocAccess(t, user, Number(row.hotel_id), 'read', { missing: 'Document not found' });
  return loadOutDoc(t, id);
}

/**
 * GET /out: documents at hotels where the user holds inventory.read, newest
 * first, PAGE_SIZE a page. hotelId / departmentId / docType / from / to
 * (IST days on posted_at) narrow it.
 */
export async function listOut(t, user, { hotelId, departmentId, docType, from, to, page } = {}) {
  let hotels = await hotelIdsWithPermission(t, user, 'inventory', 'read');
  if (hotelId != null && hotelId !== '') hotels = hotels.filter((h) => h === positiveInt(hotelId));
  if (docType != null && docType !== '' && !OUT_DOC_TYPES.includes(docType)) {
    throw invalid('Unknown document type', { field: 'docType', allowed: OUT_DOC_TYPES });
  }
  const fromDay = optionalDay(from, 'from');
  const toDay = optionalDay(to, 'to');
  if (!hotels.length) return { rows: [], total: 0 };

  const p = pageOf(page);
  const rows = await t.any(
    `SELECT o.id, o.out_number, o.doc_type, o.hotel_id, hh.name AS hotel_name, o.department_id,
            d.title AS department_name, o.requested_by_name, o.posted_at, u.name AS posted_by_name,
            (SELECT count(*) FROM tbl_inv_out_line l WHERE l.out_id = o.id) AS line_count,
            (SELECT COALESCE(sum(abs(m.value)), 0) FROM tbl_inv_movement m
              WHERE m.source_type = 'OUT' AND m.source_id = o.id
                AND m.hospitality_company_id = o.hospitality_company_id)::text AS value,
            count(*) OVER () AS total
       FROM tbl_inv_out o
       JOIN tbl_hospitality_company_hotels hh ON hh.id = o.hotel_id
       LEFT JOIN tbl_department d ON d.id = o.department_id
       LEFT JOIN tbl_users u      ON u.id = o.posted_by
      WHERE o.hotel_id = ANY($1::int[])
        AND ($2::int IS NULL OR o.department_id = $2)
        AND ($3::text IS NULL OR o.doc_type = $3)
        AND ($4::date IS NULL OR o.posted_at >= ($4::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND ($5::date IS NULL OR o.posted_at < ($5::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
      ORDER BY o.posted_at DESC, o.id DESC
      LIMIT $6 OFFSET $7`,
    [hotels, positiveInt(departmentId), docType || null, fromDay, toDay, PAGE_SIZE, (p - 1) * PAGE_SIZE]
  );
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      outNumber: r.out_number,
      docType: r.doc_type,
      hotelId: Number(r.hotel_id),
      hotelName: r.hotel_name,
      departmentId: Number(r.department_id),
      departmentName: r.department_name ?? null,
      requestedByName: r.requested_by_name ?? null,
      lineCount: Number(r.line_count),
      value: money(r.value),
      postedAt: iso(r.posted_at),
      postedByName: r.posted_by_name ?? null,
    })),
    total: rows.length ? Number(rows[0].total) : 0,
  };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * The document an earlier request with this client event id posted, or null.
 * A key used at another company is NOT_FOUND; at another hotel, CONFLICT.
 */
export async function replayOut(t, user, clientEventId, { hotelId = null, companyId = null } = {}) {
  const key = requireUuid(clientEventId);
  const prior = await t.oneOrNone(
    `SELECT id, hotel_id, hospitality_company_id FROM tbl_inv_out WHERE client_event_id = $1`,
    [key]
  );
  if (!prior) return null;
  if (companyId != null && Number(prior.hospitality_company_id) !== companyId) throw notFound('Document not found');
  if (hotelId != null && Number(prior.hotel_id) !== hotelId) {
    throw conflict('That clientEventId was used for another document', { field: 'clientEventId' });
  }
  await assertDocAccess(t, user, Number(prior.hotel_id), 'create');
  return { doc: await loadOutDoc(t, Number(prior.id)), replayed: true };
}

function validateLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw invalid('Add at least one item', { field: 'lines' });
  if (lines.length > MAX_LINES) throw invalid(`At most ${MAX_LINES} items per document`, { field: 'lines' });
  const seen = new Set();
  return lines.map((l, index) => {
    const invItemId = positiveInt(l?.invItemId);
    if (!invItemId) throw invalid('Each line needs an item', { field: 'lines', index });
    const qty = toQty(l?.qty);
    if (qty == null || qty <= 0) throw invalid('Quantities must be more than 0', { field: 'lines', index, invItemId });
    if (seen.has(invItemId)) {
      throw invalid('The same item is on two lines: add the quantities together', { field: 'lines', index, invItemId });
    }
    seen.add(invItemId);
    return { index, invItemId, qty };
  });
}

/**
 * POST /out: mark stock out to a department (OUT) or take it back (RETURN).
 *
 * @param {object} t transaction
 * @param {object} user req.user (needs inventory.create at the hotel)
 * @param {{hotelId:number, docType:'OUT'|'RETURN', departmentId:number,
 *   requestedByName?:string, remarks?:string, clientEventId:string,
 *   lines:Array<{invItemId:number, qty:number}>}} input  qty > 0, stock units
 * @returns {Promise<{doc:object, replayed:boolean}>} doc is the OutDoc
 * @throws {InventoryError} VALIDATION (a RETURN over the department's net
 *   issued qty: {field:'lines', index, invItemId, maxReturnable}) |
 *   NOT_FOUND (a hotel the caller can neither read nor post at) | FORBIDDEN
 *   (can read it, cannot post) | CONFLICT | LOCKED (count freeze) |
 *   NEGATIVE_STOCK (details.lines: every short line,
 *   {invItemId, itemName, available, requested, …})
 */
export async function postOut(t, user, input = {}) {
  const clientEventId = requireUuid(input.clientEventId);
  const hotelId = positiveInt(input.hotelId);
  if (!hotelId) throw invalid('Choose a hotel', { field: 'hotelId' });
  // Out of the caller's sight (another company, or no read here): NOT_FOUND.
  const { companyId } = await assertDocAccess(t, user, hotelId, 'create');

  // Serialise copies of one scan session, then answer from the first.
  await t.one(`SELECT pg_advisory_xact_lock(hashtext('inv:out'), hashtext($1))`, [clientEventId]);
  const prior = await replayOut(t, user, clientEventId, { hotelId, companyId });
  if (prior) return prior;

  const docType = input.docType;
  if (!OUT_DOC_TYPES.includes(docType)) throw invalid('Choose Mark out or Return', { field: 'docType' });
  const departmentId = positiveInt(input.departmentId);
  if (!departmentId) throw invalid('Choose a department', { field: 'departmentId' });
  const department = await t.oneOrNone(`SELECT id, title FROM tbl_department WHERE id = $1`, [departmentId]);
  if (!department) throw invalid('Unknown department', { field: 'departmentId' });
  const requestedByName = optionalText(input.requestedByName, 'requestedByName', 255);
  const remarks = optionalText(input.remarks, 'remarks', 2000);
  const lines = validateLines(input.lines);
  const items = await loadCompanyItems(t, companyId, lines.map((l) => l.invItemId));

  await assertNotFrozen(t, { companyId, hotelId });

  const outNumber = await nextDocNumber(t, { hotelId, docType: DOC_CODE[docType] });
  const header = await t.one(
    `INSERT INTO tbl_inv_out
       (out_number, hospitality_company_id, hotel_id, doc_type, department_id, requested_by_name, remarks,
        client_event_id, posted_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [outNumber, companyId, hotelId, docType, departmentId, requestedByName, remarks, clientEventId, user.id ?? null]
  );
  const outId = Number(header.id);
  const written = await t.any(
    `INSERT INTO tbl_inv_out_line (hospitality_company_id, out_id, inv_item_id, qty)
     SELECT $1, $2, x.item, x.qty
       FROM unnest($3::int[], $4::numeric[]) WITH ORDINALITY AS x(item, qty, ord)
      ORDER BY x.ord
     RETURNING id, inv_item_id`,
    [companyId, outId, lines.map((l) => l.invItemId), lines.map((l) => l.qty)]
  );
  const lineIdOf = new Map(written.map((w) => [Number(w.inv_item_id), Number(w.id)]));

  // RETURN: at most what this department still holds of the item here (net
  // of earlier returns), read under the balance locks; with nothing on hand,
  // back at the last mark-out cost.
  const returnCost = new Map();
  if (docType === 'RETURN') {
    const ids = [...lineIdOf.keys()].sort((a, b) => a - b);
    await t.any(
      `SELECT inv_item_id FROM tbl_inv_balance
        WHERE hotel_id = $1 AND inv_item_id = ANY($2::int[])
        ORDER BY inv_item_id FOR UPDATE`,
      [hotelId, ids]
    );
    const issued = new Map(
      (
        await t.any(
          `SELECT inv_item_id, (-sum(qty))::text AS net
             FROM tbl_inv_movement
            WHERE hotel_id = $1 AND inv_item_id = ANY($2::int[]) AND department_id = $3
              AND movement_type IN ('MARK_OUT', 'RETURN_IN')
            GROUP BY inv_item_id`,
          [hotelId, ids, departmentId]
        )
      ).map((r) => [Number(r.inv_item_id), Math.max(0, Number(r.net))])
    );
    for (const l of lines) {
      const max = issued.get(l.invItemId) ?? 0;
      if (l.qty > max) {
        const item = items.get(l.invItemId);
        throw invalid(
          `Only ${max} ${item.stockUom} of ${item.displayName} was marked out to ${department.title} here`,
          { field: 'lines', index: l.index, invItemId: l.invItemId, maxReturnable: max }
        );
      }
    }
    const balances = await t.any(
      `SELECT inv_item_id, qty::text AS qty FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = ANY($2::int[])`,
      [hotelId, ids]
    );
    const empty = balances.filter((b) => Number(b.qty) <= 0).map((b) => Number(b.inv_item_id));
    if (empty.length) {
      const last = await t.any(
        `SELECT DISTINCT ON (inv_item_id) inv_item_id, unit_cost::text AS unit_cost
           FROM tbl_inv_movement
          WHERE hotel_id = $1 AND inv_item_id = ANY($2::int[]) AND movement_type = 'MARK_OUT'
          ORDER BY inv_item_id, posted_at DESC, id DESC`,
        [hotelId, empty]
      );
      for (const r of last) {
        if (Number(r.unit_cost) > 0) returnCost.set(Number(r.inv_item_id), Number(r.unit_cost));
      }
    }
  }

  const movements = lines.map((l) => ({
    companyId,
    hotelId,
    invItemId: l.invItemId,
    type: docType === 'OUT' ? 'MARK_OUT' : 'RETURN_IN',
    qty: docType === 'OUT' ? -l.qty : l.qty,
    unitCost: returnCost.get(l.invItemId),
    departmentId,
    sourceType: 'OUT',
    sourceId: outId,
    sourceLineId: lineIdOf.get(l.invItemId),
    postedBy: positiveInt(user.id),
  }));
  try {
    await postMovements(t, movements);
  } catch (err) {
    throw explainMissingCost(err, (index) => {
      const l = lines[index];
      return l && { ...l, displayName: items.get(l.invItemId)?.displayName };
    });
  }

  return { doc: await loadOutDoc(t, outId), replayed: false };
}

export default { postOut, getOut, listOut, loadOutDoc, replayOut, OUT_DOC_TYPES };
