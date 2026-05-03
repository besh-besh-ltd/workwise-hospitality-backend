// Email-capture helpers for Wave 2 vendor-flow tests + any future test that
// asserts on outgoing notifications.
//
// USAGE (per-file, top-level — must be BEFORE any await import of the
// production module):
//
//   import { captureApprovalEmails } from "../helpers/emailCapture.js";
//   const approvalEmails = captureApprovalEmails();
//   jest.unstable_mockModule(
//     "../../app/helper/sendEmailFunctions/approvalEmails.js",
//     approvalEmails.factory
//   );
//
// Then inside a test:
//   const calls = approvalEmails.captured.sendVendorRfqNotification;
//   expect(calls.length).toBe(1);
//   expect(calls[0].rfq_id).toBe(rfq_id);
//
// Each `capture<Module>()` call returns:
//   - factory: () => mocked-module-exports — pass to jest.unstable_mockModule
//   - captured: object keyed by exported function name; each value is an
//     array of call-arg objects in chronological order.
//   - reset(): clears all captured arrays in place (use in beforeEach).

// ---------------------------------------------------------------------------
// Generic builder
// ---------------------------------------------------------------------------
function build(exportNames, extras = {}) {
  const captured = Object.fromEntries(exportNames.map((n) => [n, []]));
  const reset = () => exportNames.forEach((n) => (captured[n].length = 0));
  const factory = () => {
    const mod = {};
    for (const n of exportNames) {
      mod[n] = async (args) => {
        captured[n].push(args);
      };
    }
    Object.assign(mod, extras);
    return mod;
  };
  return { captured, reset, factory };
}

// ---------------------------------------------------------------------------
// Module-specific factories. The export list MUST stay in sync with the real
// module — when a new export is added to production, add it here and the
// factory will keep returning a matching surface (no "function is not
// exported" import errors in tests that mock the module).
// ---------------------------------------------------------------------------

export function captureApprovalEmails() {
  return build([
    "sendRfqCreationNotification",
    "sendApprovalStepNotification",
    "sendRfqReadyToPublishNotification",
    "sendRfqPublishedNotification",
    "sendVendorRfqNotification",
    "sendVendorAutoAddedToRfqNotification",
    "sendVendorBulkRfqJoinNotification",
    "sendRfqClosedHeadsUpNotification",
    "sendApprovalCancelledNotification",
    "sendPolicyChangeNotification",
    "sendApproverRemovedNotification",
    "sendApprovalStandsNotification",
    "sendApproverAddedMidFlightNotification",
  ]);
}

export function capturePoEmails() {
  return build([
    "sendPOApprovalCompletionNotification",
    "sendPOAcceptanceRequestEmail",
    "sendPORejectedEmail",
    "sendPOReminderEmail",
    "sendPOInvoiceRaisedEmail",
    "sendPODispatchedEmail",
  ]);
}

// purchaseOrderEmails.js (controllers/po/) — distinct from poEmails.js.
export function capturePurchaseOrderEmails() {
  return build([
    "sendApprovalNotification",
    "sendPONotificationToVendor",
    "sendPOAcceptanceRequestToVendor",
    "sendVendorRejectionNotification",
    "sendPOAcceptedNotificationToTeam",
  ]);
}

export function captureTechEvalEmails() {
  return build([
    "sendTechEvaluationStartedNotification",
    "sendTechEvaluationApprovalRequest",
    "sendTechEvaluationCompletedNotification",
    "sendTechEvaluationDeadlockNotification",
  ]);
}

export function captureNegotiationEmails() {
  return build([
    "sendNegotiationRoundCreatedNotification",
    "sendNegotiationRoundActiveNotification",
    "sendNegotiationRoundEndedNotification",
    "sendNegotiationApprovalRequestNotification",
  ]);
}

export function captureGeneralReminderEmails() {
  return build([
    "sendApprovalReminder",
    "sendDeadlineReminder",
    "sendSubscriptionExpiringSoonReminder",
    "sendSubscriptionExpiredNotification",
  ]);
}

export function captureMilestoneEmails() {
  return build([
    "sendMilestoneDueReminder",
    "sendMilestoneOverdueReminder",
    "sendMilestoneCompletedNotification",
  ]);
}

export function captureTenderFeeEmails() {
  return build([
    "sendTenderFeePaidNotification",
    "sendTenderFeeRefundNotification",
  ]);
}

// WhatsApp helper — separate module, but capture pattern is identical.
export function captureWhatsappNotifications() {
  return build([
    "buyerCreatesRFQNotification",
    "vendorReceivesRFQNotification",
    "buyerSendsPONotification",
    "vendorAcceptsPONotification",
  ]);
}

// ---------------------------------------------------------------------------
// Composite — capture every email module at once. Returns an object whose
// keys are the friendly names below; each value has its own { captured,
// reset, factory }. The caller still needs to `jest.unstable_mockModule` for
// each path it cares about — this just bundles the builders so the test
// file's top section is shorter.
// ---------------------------------------------------------------------------
export function captureAllEmails() {
  return {
    approvalEmails: captureApprovalEmails(),
    poEmails: capturePoEmails(),
    purchaseOrderEmails: capturePurchaseOrderEmails(),
    techEvalEmails: captureTechEvalEmails(),
    negotiationEmails: captureNegotiationEmails(),
    generalReminderEmails: captureGeneralReminderEmails(),
    milestoneEmails: captureMilestoneEmails(),
    tenderFeeEmails: captureTenderFeeEmails(),
    whatsapp: captureWhatsappNotifications(),
  };
}
