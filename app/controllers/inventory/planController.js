import db from '../../config/dbConn.js';
import { sendInventoryError } from '../../services/inventory/errors.js';
import {
  getDeliveries,
  savePlan,
  patchDueDate,
  planChangeFollowUp,
  runPlanChangeFollowUp,
  poActivityScope,
} from '../../services/inventory/planService.js';

// The buyer's Deliveries tab on a PO (contract: "Delivery plan and
// short-close"). Each handler runs its service in one transaction, answers
// after it commits, and runs side effects (vendor notice, PDF rewrite) after
// that. Errors map through sendInventoryError (404 out of scope, 403 without
// the PO initiate grant, 409 LOCKED, 400 VALIDATION).

/** GET /inventory/po/:poId/deliveries */
export const getPoDeliveries = async (req, res) => {
  let data;
  try {
    data = await db.tx((t) => getDeliveries(t, req.user, req.params.poId));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  return res.json({ status: 1, message: 'Delivery plan', data });
};

/** Run one plan edit: change, payload, follow-up and activity scope in one transaction. */
async function editPlan(req, res, change, message) {
  let out;
  try {
    out = await db.tx(async (t) => {
      const data = await change(t);
      const followUp = await planChangeFollowUp(t, data.poId, req.user?.id);
      const scope = await poActivityScope(t, data.poId);
      return { data, followUp, scope };
    });
  } catch (err) {
    return sendInventoryError(res, err);
  }
  res.locals.activityDetail = {
    scope: out.scope,
    metadata: { poId: out.data.poId, deliveryCount: out.data.deliveries.length },
  };
  await runPlanChangeFollowUp(out.followUp);
  return res.json({ status: 1, message, data: out.data });
}

/** PUT /inventory/po/:poId/deliveries  {deliveries:[…]} */
export const savePoDeliveryPlan = (req, res) =>
  editPlan(req, res, (t) => savePlan(t, req.user, req.params.poId, req.body?.deliveries), 'Delivery plan saved');

/** PATCH /inventory/po/:poId/deliveries/:deliveryId  {dueDate} */
export const patchDeliveryDueDate = (req, res) =>
  editPlan(
    req,
    res,
    (t) => patchDueDate(t, req.user, req.params.poId, req.params.deliveryId, req.body?.dueDate ?? null),
    'Delivery date updated'
  );
