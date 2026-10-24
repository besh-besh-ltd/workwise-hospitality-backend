import db from '../../../config/dbConn.js';
import { logError } from '../../../helper/common.js';
import { dispatch } from '../../notificationService.js';

export const PHASE_DUE_DIGEST_TYPE = 'inventory_phase_due_digest';

const BUCKET_LABEL = { due_today: 'Due today', due_tomorrow: 'Due tomorrow', overdue: 'Overdue' };
const BUCKET_ORDER = ['overdue', 'due_today', 'due_tomorrow'];

/** Active buyer-side users holding grn.create at the hotel (company + hotel axes, spec §6.1). */
async function hotelReceivers(conn, hotelId) {
  const rows = await conn.any(
    `SELECT DISTINCT urs.user_id
       FROM tbl_hospitality_company_hotels h
       JOIN tbl_user_role_scopes urs
         ON urs.company_id = h.hospitality_company_id
        AND (urs.hotel_id IS NULL OR urs.hotel_id = h.id)
       JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
       JOIN tbl_permissions p       ON p.id = rp.permission_id
       JOIN tbl_users u             ON u.id = urs.user_id
      WHERE h.id = $1
        AND COALESCE(h.is_deleted, 0) = 0
        AND p.resource::text = 'grn' AND p.action::text = 'create'
        AND u.status = 1
        AND COALESCE(u.is_deleted, 0) = 0
        AND COALESCE(u.user_type, 0) <> 3
      ORDER BY urs.user_id`,
    [hotelId]
  );
  return rows.map((r) => Number(r.user_id));
}

function digestBody(deliveries) {
  const parts = [];
  for (const bucket of BUCKET_ORDER) {
    const list = deliveries.filter((d) => d.bucket === bucket);
    if (!list.length) continue;
    const names = list.map((d) => `PO #${d.poNumber}${d.phaseNo > 1 ? ` (phase ${d.phaseNo})` : ''}`);
    parts.push(`${BUCKET_LABEL[bucket]}: ${names.join(', ')}`);
  }
  return parts.join('. ');
}

/**
 * One in-app digest per hotel per day: the deliveries due tomorrow, due today
 * or 3 days overdue there, sent to everyone who can receive at that hotel
 * (grn.create). Called by the phase-due sweeper; never throws.
 *
 * The rows carry {hotelId, date, deliveryIds} in additional_data and type
 * PHASE_DUE_DIGEST_TYPE, which is what the sweeper's once-a-day check reads.
 *
 * @param {{hotelId:number, hotelName?:string, date:string,
 *   deliveries:Array<{deliveryId:number, poId:number, poNumber:string,
 *   phaseNo:number, dueDate:string, bucket:'due_tomorrow'|'due_today'|'overdue'}>}} digest
 * @param {{conn?:object}} [opts]
 * @returns {Promise<{sent:boolean, recipients:number}>}
 */
export const notifyPhaseDueDigest = async ({ hotelId, hotelName, date, deliveries = [] } = {}, { conn = db } = {}) => {
  try {
    if (!hotelId || !deliveries.length) return { sent: false, recipients: 0 };
    const userIds = await hotelReceivers(conn, hotelId);
    if (!userIds.length) return { sent: false, recipients: 0 };

    const overdue = deliveries.filter((d) => d.bucket === 'overdue').length;
    const title = `${deliveries.length} deliver${deliveries.length === 1 ? 'y' : 'ies'} to receive${hotelName ? ` at ${hotelName}` : ''}${overdue ? ` (${overdue} overdue)` : ''}`;
    const created = await dispatch({
      userIds,
      category: 'inventory',
      type: PHASE_DUE_DIGEST_TYPE,
      title,
      body: digestBody(deliveries),
      data: { hotelId: Number(hotelId), date, deliveryIds: deliveries.map((d) => d.deliveryId) },
      actionUrl: `/dashboard/buyer/inventory/receive?hotelId=${encodeURIComponent(hotelId)}`,
    });
    return { sent: created.length > 0, recipients: created.length };
  } catch (err) {
    logError(`[inventory] phase-due digest for hotel ${hotelId} failed`, err);
    return { sent: false, recipients: 0 };
  }
};

/** @param ({hotelId, items}) */
export const notifyLowStockDigest = async () => undefined;
