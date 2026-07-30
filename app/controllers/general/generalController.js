import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import userModel from '../../models/userModel.js';
import generalModel, {
  createApprovalInstance,
  createApprovalPolicy,
  deleteApprovalPolicy,
  deletePolicySteps,
  getApprovalInstanceDetails,
  getApprovalPolicies,
  getApprovalPoliciesWithSteps,
  getApprovalPolicyWithSteps,
  insertPolicySteps,
  updateApprovalPolicy,
  findBestMatchingPolicy,
  getApprovalInstancesByEntity,
  cancelApprovalInstance,
  getPendingApprovalsForUser,
  getPendingApprovalCountsByEntityType,
  createApprovalProcess,
  getApprovalProcesses,
  updateApprovalProcess,
  deleteApprovalProcess,
  getDepartmentSubGraphPreview,
  checkIfUserIsFinalApprover,
  getApprovalPolicyTenant,
  getApprovalInstanceTenant,
  getApprovalProcessTenant
} from '../../models/generalModel.js';
import { resolveHospitalityCompanyScope } from '../../helper/arc_v2/resolveHospitalityCompany.js';
import { executeApprovalAction } from '../../services/approvalActionService.js';
import {
  snapshotPolicySteps,
  computePolicyStepDiff,
  propagatePolicyChangeToInstances,
  handleAutoCompletedInstances,
  getPendingInstancesForPolicy,
  getInstanceChangeHistory as getInstanceChangeHistoryService,
  simulateApproverImpact,
  dispatchPropagationEmails
} from '../../services/approvalPropagationService.js';
import { AVAILABLE_HIERARCHY_TYPES } from '../../util/constants.js';
import { initiatePurchaseOrder } from '../../models/purchaseOrderModel.js';
import db from '../../config/dbConn.js';

const generalController = {
  getStates: async (req, res, next) => {
    try {
      const country_id = req.params.id;

      if (!country_id) {
        return res
          .status(400)
          .json({
            status: 0,
            message: 'country_id is required'
          })
          .end();
      }

      const states = await generalModel.getCountryStates(country_id);

      res
        .status(200)
        .json({
          status: 1,
          data: states
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getCities: async (req, res, next) => {
    const state_id = req.params.id;

    if (!state_id) {
      return res
        .status(400)
        .json({
          status: 0,
          message: 'state_id is required'
        })
        .end();
    }

    try {
      const cities = await generalModel.getCities(state_id);
      res
        .status(200)
        .json({
          status: 1,
          data: cities
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getCountries: async (req, res, next) => {
    // const state_id = req.params.id;
    try {
      const cities = await generalModel.getCountries();
      res
        .status(200)
        .json({
          status: 1,
          data: cities
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getCountryCodes: async (req, res, next) => {
    try {
      const countr_codes = await generalModel.getCountryCode();
      res.status(200).json({
        status: 1,
        data: countr_codes
      });
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getHierarchies: async (req, res) => {
    try {
      const { type } = req.query;
      const { company_id } = req.user;

      const hierarchies = await generalModel.getHierarchies(type, company_id);
      return res.json({
        status: 1,
        data: hierarchies
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      });
    }
  },
  getUserHierarchies: async (req, res) => {
    try {
      const { type, project_id, currentUserOnly = false } = req.query;
      const { id, company_id } = req.user;

      // Check if user's company is hospitality
      const company = await userModel.getCompanyDetail(id);
      const isHospitality = company && company[0] &&
        (company[0].is_hospitality === 1 || company[0].is_hospitality === '1');

      // For hospitality users, skip legacy hierarchy - use new approval workflow
      if (isHospitality) {
        return res.json({
          status: 1,
          use_legacy_hierarchy: false,
          data: null
        });
      }

      // For non-hospitality users, return legacy hierarchies
      const hierarchies = await generalModel.getUserHierarchies(type, company_id, id, project_id, currentUserOnly);
      return res.json({
        status: 1,
        use_legacy_hierarchy: true,
        data: hierarchies
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      });
    }
  },
  createHierarchy: async (req, res) => {
    try {
      const { type, approvers } = req.body;
      const { id, company_id } = req.user;

      // const doesExist = await generalModel.doesHierarchyExist(type, company_id, approvers[0]);
      // if (doesExist) {
      //   return res.status(400).json({
      //     status: 2,
      //     message: `A Hierarchy already exist for type \`${type}\` with given initial user!`
      //   });
      // }

      const createdHierarchy = await generalModel.createHierarchy(
        type,
        approvers,
        company_id,
        id
      );
      if (createdHierarchy) return res.status(201).end();

      return res.status(400).json({
        status: 3,
        message:
          'Something went wrong while saving the hierarchy in the database, please try again!'
      });
    } catch (error) {
      logError(error);
      return res
        .status(400)
        .json({
          status: 3,
          message: error.message ?? Config.errorText.value,
          error
        })
        .end();
    }
  },
  updateHierarchy: async (req, res) => {
    try {
      const { hierarchy_id, type, approvers, removableApprovers } = req.body;
      const { company_id } = req.user;

      const updated = await generalModel.updateHierarchy(
        type,
        approvers,
        removableApprovers,
        company_id,
        hierarchy_id
      );

      if (updated) return res.status(200).end();

      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while updating the hierarchy.'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      }).end();
    }
  },
  deleteHierarchy: async (req, res) => {
  try {
    const { id } = req.params;
    const { type } = req.query;
    const { company_id } = req.user;

    const deleted = await generalModel.deleteHierarchy(id, company_id, type);

    if (deleted) return res.status(200).end();

    return res.status(400).json({
      status: 3,
      message: 'Something went wrong while deleting the hierarchy.'
    });
  } catch (error) {
    return res.status(400).json({
      status: 3,
      message: error.message,
      error
    }).end();
  }
},
  mapHierarchyToProject: async (req, res) => {
    try {
      const { hierarchy_id, hierarchy_type, project_id } = req.body;
      const { id, company_id } = req.user;

      const updated = await generalModel.mapHierarchyToProject(
        hierarchy_id,
        hierarchy_type,
        project_id,
        company_id,
        id
      );

      if (updated) return res.status(200).end();

      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while mapping hierarchy to project'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      }).end();
    }
  },
  setDefaultHierarchy: async (req, res) => {
    try {
      const { hierarchy_id, hierarchy_type } = req.body;
      const { id, company_id } = req.user;

      const updated = await generalModel.setDefaultHierarchy(
        hierarchy_id,
        hierarchy_type,
        company_id,
        id
      );

      if (updated) return res.status(200).end();

      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while setting hierarchy as default'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      }).end();
    }
  },
  getHierarchyTypes: async (req, res) => {
    try {
      const result = await generalModel.getHierarchyTypes();
      return res.json({
        status: 1,
        data: result,
      })
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      }).end();
    }
  }
};


// --- Hospitality Approval Engine Controllers Start ---

// ===========================================================================
// Tenant scope for the approval endpoints.
// ---------------------------------------------------------------------------
// Every handler below derives its company scope from req.user via these two
// helpers. A client-supplied `hospitality_company_id` may only NARROW the
// result; it can never widen it.
// ===========================================================================

/**
 * Companies this request may read approval config for.
 *   null      → super admin (user_type 8): every company.
 *   number[]  → exactly these companies ([] = no access).
 *
 * resolveHospitalityCompanyScope() reads tbl_hospitality_user_mappings and
 * already refuses client widening for non-admins. Two active production
 * buyers (358, 407) carry RBAC role scopes but no hospitality mapping row, so
 * we union in tbl_user_role_scopes.company_id — still derived entirely from
 * req.user, and it keeps those users from losing their own tenant's policies.
 */
async function resolveApprovalCompanyScope(req) {
  // Memoised per request: several handlers below need the scope more than once
  // (guard + mutation-target resolution) and it costs two queries to build.
  if (req.__approvalCompanyScope !== undefined) return req.__approvalCompanyScope;

  const scope = await computeApprovalCompanyScope(req);
  req.__approvalCompanyScope = scope;
  return scope;
}

async function computeApprovalCompanyScope(req) {
  const mapped = await resolveHospitalityCompanyScope(req);
  if (mapped === null) return null; // super admin (user_type 8)

  const scoped = (await db.any(
    `SELECT DISTINCT company_id
       FROM tbl_user_role_scopes
      WHERE user_id = $1 AND company_id IS NOT NULL`,
    [req.user?.id || null]
  )).map((r) => Number(r.company_id));

  // Hospitality admins (user_type 7) own every business unit under their OWN
  // parent buyer company and carry NEITHER a hospitality mapping NOR an RBAC
  // role scope — verified in production: all three user_type-7 users have zero
  // rows in both tables. Without this union the scope collapses to [] for the
  // only role that may reach the Approval Wizard (POST /policies is acl([7])),
  // so it could neither list nor save a single policy.
  //
  // tbl_users.company_id is loaded from the DB by the jwtUsr strategy, so this
  // is still derived entirely from req.user — never from a header or the body.
  // It is the same tenancy edge hospitalityController.js enforces everywhere as
  // `record.buyer_company_id !== company.id`.
  let administered = [];
  if (Number(req.user?.user_type) === 7 && req.user?.company_id) {
    administered = (await db.any(
      `SELECT id
         FROM tbl_hospitality_companies
        WHERE buyer_company_id = $1
          AND COALESCE(is_deleted, 0) = 0`,
      [Number(req.user.company_id)]
    )).map((r) => Number(r.id));
  }

  return [...new Set([...(mapped || []), ...scoped, ...administered])];
}

/** True when `companyId` is inside the request's server-derived scope. */
function inCompanyScope(scopeIds, companyId) {
  if (scopeIds === null) return true; // super admin
  if (companyId === null || companyId === undefined) return false;
  return scopeIds.includes(Number(companyId));
}

/**
 * Resolve a policy id to its owning company and 404 when it belongs to another
 * tenant. Returns the policy tenant row, or null after the response is sent.
 */
async function guardPolicyTenant(req, res, policyId) {
  const scopeIds = await resolveApprovalCompanyScope(req);
  const tenant = await getApprovalPolicyTenant(policyId);
  if (!tenant || !inCompanyScope(scopeIds, tenant.hospitality_company_id)) {
    res.status(404).json({ status: 2, message: 'Policy not found' });
    return null;
  }
  return tenant;
}

/** Same as guardPolicyTenant, for approval instances. */
async function guardInstanceTenant(req, res, instanceId) {
  const scopeIds = await resolveApprovalCompanyScope(req);
  const tenant = await getApprovalInstanceTenant(instanceId);
  if (!tenant || !inCompanyScope(scopeIds, tenant.hospitality_company_id)) {
    res.status(404).json({ status: 2, message: 'Approval instance not found' });
    return null;
  }
  return tenant;
}

/**
 * Same as guardPolicyTenant, for approval PROCESSES.
 *
 * Processes hang off the PARENT buyer company (tbl_approval_processes.company_id
 * -> tbl_company.id), not off a hospitality company — createProcess already
 * derives it as req.user.company_id and never accepts it from the body. The
 * update/delete siblings matched on `WHERE id = $1` alone, so an admin in one
 * tenant could rename or deactivate another tenant's procurement process and
 * silently break every policy routed through it.
 */
async function guardProcessTenant(req, res, processId) {
  const proc = await getApprovalProcessTenant(processId);
  const notFound = () => {
    res.status(404).json({ status: 2, message: 'Process not found' });
    return null;
  };
  if (!proc) return notFound();

  // Super admin (user_type 8) acts across every company. Kept explicit rather
  // than as a gap in the logic — note it is unreachable over HTTP here because
  // these routes are acl([7]), and production has zero user_type-8 users.
  if (Number(req.user?.user_type) === 8) return proc;

  const ownCompanyId = req.user?.company_id ? Number(req.user.company_id) : null;
  if (ownCompanyId === null || Number(proc.company_id) !== ownCompanyId) return notFound();
  return proc;
}

/**
 * The hospitality company a MUTATION must be written into.
 *
 * The body may only ever NARROW to a company the caller already owns; it can
 * never widen. Returns the company id, or null once the response has been sent.
 */
async function resolveMutationCompany(req, res, requestedRaw, notFoundMessage) {
  const scopeIds = await resolveApprovalCompanyScope(req);
  const hasRequest = requestedRaw !== undefined && requestedRaw !== null && requestedRaw !== '';
  const requested = hasRequest ? parseInt(requestedRaw, 10) : null;

  // Super admin (user_type 8): scopeIds === null means "every company". Spelled
  // out deliberately so the bypass survives future edits to inCompanyScope.
  if (scopeIds === null) {
    if (requested === null || !Number.isFinite(requested)) {
      res.status(400).json({ status: 3, message: 'hospitality_company_id is required' });
      return null;
    }
    return requested;
  }

  if (requested !== null) {
    if (!Number.isFinite(requested) || !inCompanyScope(scopeIds, requested)) {
      // 404, not 403 — same convention as the read fixes, so a probing caller
      // cannot tell "exists but not yours" from "does not exist".
      res.status(404).json({ status: 2, message: notFoundMessage });
      return null;
    }
    return requested;
  }

  // Nothing supplied → derive it. Unambiguous only when the caller owns exactly
  // one company; with several we ask rather than guess, and with none we refuse.
  if (scopeIds.length === 1) return scopeIds[0];
  if (scopeIds.length === 0) {
    res.status(404).json({ status: 2, message: notFoundMessage });
    return null;
  }
  res.status(400).json({ status: 3, message: 'hospitality_company_id is required' });
  return null;
}

const hospitalityApprovalController = {
  /**
   * Create or Update an approval policy with steps
   * POST /hospitality/approval/policies
   */
  async upsertApprovalPolicy(req, res) {
    try {
      const {
        entity_type,
        hospitality_company_id,
        hotel_id,
        department_id,
        process_id,
        is_active,
        is_master,
        steps,
        id,
        confirmed_approval_impact
      } = req.body;
      const created_by = req.user?.id;

      if (!created_by) {
        return res.status(401).json({ status: 3, message: 'User authentication required' });
      }

      // ARC is process-free BY DESIGN: ARC entities carry process_id = NULL, so
      // findBestMatchingPolicyTx reduces to `process_id IS NULL` for them. An ARC
      // policy saved with a non-NULL process could NEVER match → silent 400 at
      // publish/eval time. Force process_id = NULL for every ARC entity type
      // server-side, regardless of what the client sent.
      const isArcEntity = typeof entity_type === 'string' && (entity_type === 'ARC' || entity_type.startsWith('ARC_'));
      const effectiveProcessId = isArcEntity ? null : process_id;

      let policy;
      let propagationResult = null;
      if (id) {
        // ── PHASE 0: TENANT GATE ──
        // SECURITY (P0, cross-tenant WRITE): the update branch previously took
        // the caller's `id` and rewrote the policy row AND every one of its
        // steps with no tenant check at all — i.e. company A could redirect who
        // approves company B's spend to approvers of its own choosing. The gate
        // has to run BEFORE Phase 1/2 as well, because snapshotPolicySteps() and
        // getPendingInstancesForPolicy() read the victim's approver chain and
        // echo their pending RFQ/PO identifiers back in the impact warning.
        const scopeIds = await resolveApprovalCompanyScope(req);
        const tenant = await guardPolicyTenant(req, res, parseInt(id));
        if (!tenant) return;

        // The tenant is pinned to the row that actually exists. A body-supplied
        // company may only move the policy WITHIN the caller's own scope;
        // anything else is a cross-tenant move and 404s like the read paths.
        let effectiveCompanyId = Number(tenant.hospitality_company_id);
        if (hospitality_company_id !== undefined && hospitality_company_id !== null && hospitality_company_id !== '') {
          const requestedCompanyId = parseInt(hospitality_company_id, 10);
          if (!Number.isFinite(requestedCompanyId) || !inCompanyScope(scopeIds, requestedCompanyId)) {
            return res.status(404).json({ status: 2, message: 'Policy not found' });
          }
          effectiveCompanyId = requestedCompanyId;
        }

        logger.info(`[PolicyUpdate] Starting update for policy ${id}, steps provided: ${!!(steps && steps.length > 0)}, step count: ${steps?.length || 0}, confirmed_approval_impact: ${!!confirmed_approval_impact}`);

        // ── PHASE 1: Snapshot old steps BEFORE any mutations ──
        let oldSteps = [];
        if (steps && steps.length > 0) {
          oldSteps = await snapshotPolicySteps(id);
          logger.info(`[PolicyUpdate] Old steps snapshot: ${oldSteps.length} steps, IDs: [${oldSteps.map(s => s.id).join(',')}], orders: [${oldSteps.map(s => s.step_order).join(',')}]`);
        }

        // ── PHASE 2: Pre-flight impact check ──
        // Compute diff against the proposed steps BEFORE applying any DB changes,
        // so we can warn the admin if PENDING instances would be affected.
        if (oldSteps.length > 0 && steps && steps.length > 0) {
          const previewDiff = computePolicyStepDiff(oldSteps, steps);
          logger.info(`[PolicyUpdate] Pre-flight diff: ${previewDiff.length} changes — ${JSON.stringify(previewDiff.map(d => ({ type: d.type, step_order: d.step_order, sourceChanged: d.sourceChanged, ruleChanged: d.ruleChanged })))}`);

          if (previewDiff.length > 0 && !confirmed_approval_impact) {
            const pendingInstances = await getPendingInstancesForPolicy(id);
            logger.info(`[PolicyUpdate] Pre-flight pending instances for policy ${id}: ${pendingInstances.length}`);

            if (pendingInstances.length > 0) {
              const instances = pendingInstances.map(inst => {
                const metadata = typeof inst.metadata === 'string' ? JSON.parse(inst.metadata) : inst.metadata;
                return {
                  id: inst.id,
                  entity_type: inst.entity_type,
                  entity_id: inst.entity_id,
                  current_step: inst.current_step,
                  total_steps: parseInt(inst.total_steps),
                  entity_identifier: metadata?.rfq_number || metadata?.rfq_no || metadata?.po_number || `ID-${inst.entity_id}`,
                  created_at: inst.created_at
                };
              });

              const diff_summary = {
                steps_added: previewDiff.filter(d => d.type === 'STEP_ADDED').map(d => d.step_order),
                steps_removed: previewDiff.filter(d => d.type === 'STEP_REMOVED').map(d => d.step_order),
                steps_modified: previewDiff
                  .filter(d => d.type === 'STEP_MODIFIED')
                  .map(d => ({ step_order: d.step_order, sourceChanged: d.sourceChanged, ruleChanged: d.ruleChanged }))
              };

              logger.info(`[PolicyUpdate] Returning APPROVAL_IMPACT_WARNING for policy ${id} (${pendingInstances.length} pending) — save aborted`);
              return res.status(200).json({
                status: 0,
                code: 'APPROVAL_IMPACT_WARNING',
                message: 'This policy change will affect pending approvals. Confirmation required.',
                data: {
                  policy_id: id,
                  entity_type,
                  pending_count: pendingInstances.length,
                  instances,
                  diff_summary
                }
              });
            }
          }
        }

        // ── PHASE 3 + 4 (atomic): policy mutation + propagation in one tx ──
        // - SELECT ... FOR UPDATE on the policy row at the start serializes
        //   concurrent saves of the same policy (no more deadlocks from two
        //   admins or a double-clicked save fighting for tbl_approval_policy_steps).
        // - If propagation throws, the policy mutation rolls back too, so we
        //   never leave a half-applied state ("policy saved but propagation failed").
        const txResult = await db.tx(async t => {
          // Acquire row-level lock on the policy. Any concurrent save against
          // the same policy will block here until this tx commits/rolls back.
          await t.oneOrNone('SELECT id FROM tbl_approval_policies WHERE id = $1 FOR UPDATE', [id]);

          // Only patch columns the client actually sent. updateApprovalPolicy
          // keys off hasOwnProperty, and pg-promise renders `undefined` as
          // NULL — so passing every key unconditionally wrote NULL for each
          // omitted field. On the three NOT NULL columns (entity_type,
          // hospitality_company_id, is_master) that turned into a hard 400 on
          // every save from the legacy Approval Hierarchy page, whose payload
          // carries neither is_master nor process_id; the undefined process_id
          // additionally tripped the "Process does not belong to this company"
          // validation. Same class of defect as the saveRfqDraft data loss.
          const patch = { hospitality_company_id: effectiveCompanyId };
          if (entity_type !== undefined) patch.entity_type = entity_type;
          if (hotel_id !== undefined) patch.hotel_id = hotel_id;
          if (department_id !== undefined) patch.department_id = department_id;
          if (is_active !== undefined) patch.is_active = is_active;
          if (is_master !== undefined) patch.is_master = is_master;
          // ARC stays process-free by design: force NULL whenever the entity
          // type says ARC, otherwise only touch process_id if it was sent.
          if (isArcEntity) patch.process_id = null;
          else if (process_id !== undefined) patch.process_id = effectiveProcessId;

          const updatedPolicy = await updateApprovalPolicy(id, patch, t);

          let newSteps = [];
          if (steps && steps.length > 0) {
            await deletePolicySteps(id, t);
            newSteps = await insertPolicySteps(steps, id, t);
          }

          // PHASE 4: Compute diff against the steps we just wrote, propagate.
          logger.info(`[PolicyUpdate] Checking diff: oldSteps=${oldSteps.length}, newSteps=${newSteps.length}`);
          let propResult = null;
          if (oldSteps.length > 0 && newSteps.length > 0) {
            const diff = computePolicyStepDiff(oldSteps, newSteps);
            logger.info(`[PolicyUpdate] Diff result: ${diff.length} changes — ${JSON.stringify(diff.map(d => ({ type: d.type, step_order: d.step_order, sourceChanged: d.sourceChanged, ruleChanged: d.ruleChanged })))}`);

            if (diff.length > 0) {
              // Re-read the policy inside the tx to get the up-to-date row.
              const fullPolicy = await t.oneOrNone('SELECT * FROM tbl_approval_policies WHERE id = $1', [id]);

              propResult = await propagatePolicyChangeToInstances({
                policyId: id, diff, changedBy: created_by, policy: fullPolicy, t
              });
              logger.info(`[PolicyUpdate] Propagation result: ${JSON.stringify({ affected: propResult?.instancesAffected, added: propResult?.totalApproversAdded, removed: propResult?.totalApproversRemoved, autoCompleted: propResult?.instancesAutoCompleted })}`);
            }
          } else {
            logger.info(`[PolicyUpdate] Skipped diff — oldSteps.length=${oldSteps.length}, newSteps.length=${newSteps.length}`);
          }

          return { policy: updatedPolicy, propagationResult: propResult };
        });

        policy = txResult.policy;
        propagationResult = txResult.propagationResult;

        // Fire post-approval handlers for auto-completed instances (after tx commits)
        if (propagationResult?.autoCompletedInstanceIds?.length > 0) {
          handleAutoCompletedInstances(propagationResult.autoCompletedInstanceIds, created_by, 'policy_change');
        }

        // Send email notifications (fire-and-forget, after tx commits)
        if (propagationResult?._emailData) {
          dispatchPropagationEmails(propagationResult._emailData, created_by, 'policy_change');
        }
      } else {
        // Create new policy
        if (!entity_type) {
          return res.status(400).json({
            status: 3,
            message: 'entity_type and hospitality_company_id are required'
          });
        }

        // SECURITY (P0, cross-tenant WRITE): hospitality_company_id came
        // straight off the body, so a policy could be planted inside another
        // tenant's approval config. Server-derive it; the body may only narrow
        // to a company the caller already owns.
        const createCompanyId = await resolveMutationCompany(
          req, res, hospitality_company_id, 'Policy not found'
        );
        if (createCompanyId === null) return;

        // Validate entity_type. Includes the process-free ARC (Rate Contract)
        // v2 stage types so the admin wizard can create per-stage ARC policies.
        const validEntityTypes = [
          'RFQ', 'TENDER', 'NEGOTIATION', 'PO', 'INDENT', 'TECHNICAL', 'ARC', 'NEGOTIATION_QUOTE',
          'ARC_TECH', 'ARC_NEGOTIATION', 'ARC_COMMITTEE', 'ARC_AMENDMENT', 'ARC_PUBLISH',
        ];
        if (!validEntityTypes.includes(entity_type)) {
          return res.status(400).json({
            status: 3,
            message: `Invalid entity_type. Must be one of: ${validEntityTypes.join(', ')}`
          });
        }
        // Atomic create: policy row + steps in one tx, so a step-insert failure
        // doesn't leave an orphan policy behind.
        policy = await db.tx(async t => {
          const newPolicy = await createApprovalPolicy({
            entity_type,
            hospitality_company_id: createCompanyId,
            hotel_id,
            department_id,
            process_id: effectiveProcessId ? parseInt(effectiveProcessId) : null,
            created_by,
            is_active,
            is_master: is_master || false
          }, t);
          if (steps && steps.length > 0) {
            await insertPolicySteps(steps, newPolicy.id, t);
          }
          return newPolicy;
        });
      }

      const fullPolicy = await getApprovalPolicyWithSteps(policy.id);
      const response = { status: 1, data: fullPolicy };
      if (propagationResult && propagationResult.instancesAffected > 0) {
        response.propagation = {
          instances_affected: propagationResult.instancesAffected,
          total_approvers_added: propagationResult.totalApproversAdded,
          total_approvers_removed: propagationResult.totalApproversRemoved,
          instances_auto_completed: propagationResult.instancesAutoCompleted,
          details: propagationResult.details
        };
      }
      res.status(id ? 200 : 201).json(response);
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message || e?.detail || 'Failed to save approval policy' });
    }
  },

  /**
   * Get approval policies with filtering
   * GET /hospitality/approval/policies
   */
  async getApprovalPolicies(req, res) {
    try {
      const { hospitality_company_id, hotel_id, department_id, entity_type, process_id, include_inactive, include } = req.query;

      // SECURITY: the company scope is SERVER-DERIVED and mandatory. Previously
      // the model seeded its WHERE with 'TRUE' and applied the company filter
      // only when the client happened to send the query param, so dropping the
      // param dumped every tenant's policies. The client-sent id below is now
      // only a narrowing facet (the Approval Wizard always sends the BU it is
      // editing) and is discarded when it falls outside the user's own scope.
      const scopeIds = await resolveApprovalCompanyScope(req);
      const requested = hospitality_company_id ? parseInt(hospitality_company_id) : undefined;
      const narrow = requested !== undefined && inCompanyScope(scopeIds, requested)
        ? requested
        : undefined;

      const filters = {
        hospitality_company_ids: scopeIds,
        hospitality_company_id: narrow,
        hotel_id: hotel_id ? parseInt(hotel_id) : undefined,
        department_id: department_id ? parseInt(department_id) : undefined,
        entity_type,
        process_id: process_id ? parseInt(process_id) : undefined,
        include_inactive: include_inactive === 'true'
      };
      const data = include === 'steps'
        ? await getApprovalPoliciesWithSteps(filters)
        : await getApprovalPolicies(filters);
      res.json({ status: 1, data });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Get a single policy with its steps
   * GET /hospitality/approval/policies/:id
   */
  async getApprovalPolicy(req, res) {
    try {
      const { id } = req.params;
      // SECURITY: getApprovalPolicyWithSteps matches on `WHERE p.id = $1` only.
      // Resolve the owning tenant first and 404 on a cross-tenant id.
      if (!(await guardPolicyTenant(req, res, parseInt(id)))) return;
      const data = await getApprovalPolicyWithSteps(parseInt(id));
      res.json({ status: 1, data });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Soft delete a policy
   * DELETE /hospitality/approval/policies/:id
   */
  async deleteApprovalPolicy(req, res) {
    try {
      // SECURITY: same missing-tenant-column defect as the read endpoints, but
      // destructive — a cross-tenant id would deactivate another company's
      // approval policy.
      if (!(await guardPolicyTenant(req, res, parseInt(req.params.id)))) return;
      await deleteApprovalPolicy(parseInt(req.params.id));
      res.json({ status: 1, message: 'Policy deactivated successfully' });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Submit an entity for approval
   * Creates an approval instance with auto-detected or specified policy
   * POST /hospitality/approval/submit
   */
  async submitApproval(req, res) {
    try {
      const {
        entity_type,
        entity_id,
        hospitality_company_id,
        hotel_id,
        department_id,
        process_id,
        approval_policy_id,
        metadata
      } = req.body;
      const initiated_by = req.user?.id;

      if (!initiated_by) {
        return res.status(401).json({ status: 3, message: 'User authentication required' });
      }

      if (!entity_type || !entity_id) {
        return res.status(400).json({
          status: 3,
          message: 'entity_type, entity_id, and hospitality_company_id are required'
        });
      }

      // SECURITY (P0, cross-tenant WRITE): hospitality_company_id was taken
      // from the request body, so a caller could open an approval instance
      // inside another tenant — binding that tenant's approvers to an entity
      // they do not own. The company is now server-derived from req.user; a
      // body value that disagrees with the caller's scope is refused outright
      // (404, matching the read paths) rather than silently honoured.
      const companyId = await resolveMutationCompany(
        req, res, hospitality_company_id, 'No approval policy found for this scope'
      );
      if (companyId === null) return;

      const result = await createApprovalInstance({
        entity_type,
        entity_id: parseInt(entity_id),
        hospitality_company_id: companyId,
        hotel_id: hotel_id ? parseInt(hotel_id) : null,
        department_id: department_id ? parseInt(department_id) : null,
        process_id: process_id ? parseInt(process_id) : null,
        approval_policy_id: approval_policy_id ? parseInt(approval_policy_id) : null,
        initiated_by,
        metadata: metadata || {}
      });

      res.status(201).json({ status: 1, data: result });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Get approval instance details
   * GET /hospitality/approval/instance/:id
   */
  async getApprovalInstance(req, res) {
    try {
      const { id } = req.params;
      const user_id = req.user?.id;
      // SECURITY: getApprovalInstanceDetails matches on `WHERE i.id = $1` and
      // returns approver names + emails plus company/hotel names. Guard at the
      // HTTP boundary (the model function is shared with ARC/MR/PO/negotiation
      // flows that already scope their own entity).
      if (!(await guardInstanceTenant(req, res, parseInt(id)))) return;
      const data = await getApprovalInstanceDetails(parseInt(id), user_id);
      res.json({ status: 1, data });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Submit an approval action (APPROVE/REJECT)
   * POST /hospitality/approval/action
   */
  async submitApprovalAction(req, res) {
    try {
      const { approval_instance_id, approval_instance_step_id, action, comment } = req.body;
      const approver_user_id = req.user?.id;

      if (!approver_user_id) {
        return res.status(401).json({ status: 3, message: 'User authentication required' });
      }

      if (!approval_instance_id || !action) {
        return res.status(400).json({
          status: 3,
          message: 'approval_instance_id and action are required'
        });
      }

      // executeApprovalAction wraps submitApprovalAction and centrally dispatches
      // entity-specific post-approval handlers (RFQ, TENDER, TECHNICAL, PO, ARC,
      // NEGOTIATION, NEGOTIATION_QUOTE) via the registry in approvalActionService.
      // This replaces the long if/else chain that previously lived here, which had
      // gaps (notably: missing TECHNICAL APPROVE, missing PO and ARC entirely).
      const result = await executeApprovalAction({
        approval_instance_id: parseInt(approval_instance_id),
        approval_instance_step_id: approval_instance_step_id ? parseInt(approval_instance_step_id) : null,
        approver_user_id,
        action,
        comment
      });

      res.json({ status: 1, data: result });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Cancel a pending approval instance
   * POST /hospitality/approval/cancel
   */
  async cancelApproval(req, res) {
    try {
      const { instance_id, reason } = req.body;
      const cancelled_by = req.user?.id;

      if (!cancelled_by) {
        return res.status(401).json({ status: 3, message: 'User authentication required' });
      }

      if (!instance_id) {
        return res.status(400).json({ status: 3, message: 'instance_id is required' });
      }

      // SECURITY (P0, cross-tenant WRITE): cancelApprovalInstance matches on
      // `WHERE id = $1` only, and this route carried no acl() either — so any
      // authenticated user could walk sequential ids and CANCEL another
      // tenant's pending approvals (3,846 instances / 361 pending in prod),
      // stalling their procurement without leaving an obvious trace.
      if (!(await guardInstanceTenant(req, res, parseInt(instance_id)))) return;

      const result = await cancelApprovalInstance(parseInt(instance_id), cancelled_by, reason);
      res.json({ status: 1, data: result });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Get pending approvals for the current user
   * GET /hospitality/approval/pending
   */
  async getPendingApprovals(req, res) {
    try {
      const user_id = req.user?.id;
      const { hospitality_company_id, hotel_id, entity_type } = req.query;

      if (!user_id) {
        return res.status(401).json({ status: 3, message: 'User authentication required' });
      }

      const data = await getPendingApprovalsForUser(user_id, {
        hospitality_company_id: hospitality_company_id ? parseInt(hospitality_company_id) : undefined,
        hotel_id: hotel_id ? parseInt(hotel_id) : undefined,
        entity_type
      });

      res.json({ status: 1, data });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Get pending approval counts grouped by entity type for nav indicators
   * GET /hospitality/approval/pending/counts
   */
  async getPendingApprovalCounts(req, res) {
    try {
      const user_id = req.user?.id;
      const { hospitality_company_id, hotel_id } = req.query;

      if (!user_id) {
        return res.status(401).json({ status: 3, message: 'User authentication required' });
      }

      const data = await getPendingApprovalCountsByEntityType(user_id, {
        hospitality_company_id: hospitality_company_id ? parseInt(hospitality_company_id) : undefined,
        hotel_id: hotel_id ? parseInt(hotel_id) : undefined,
      });

      res.json({ status: 1, data });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Get approval instances for an entity
   * GET /hospitality/approval/entity/:entity_type/:entity_id
   */
  async getEntityApprovals(req, res) {
    try {
      const { entity_type, entity_id } = req.params;
      // SECURITY: this route had no acl() at all (vendors reached it) and no
      // tenant column in the WHERE. The role gate now lives on the route; here
      // we drop any instance outside the caller's server-derived company scope.
      const scopeIds = await resolveApprovalCompanyScope(req);
      const rows = await getApprovalInstancesByEntity(entity_type, parseInt(entity_id));
      const data = (rows || []).filter((r) => inCompanyScope(scopeIds, r.hospitality_company_id));
      res.json({ status: 1, data });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Find the best matching policy for a scope
   * GET /hospitality/approval/policies/match
   */
  async findMatchingPolicy(req, res) {
    try {
      const { entity_type, hospitality_company_id, hotel_id, department_id, process_id } = req.query;

      if (!entity_type || !hospitality_company_id) {
        return res.status(400).json({
          status: 3,
          message: 'entity_type and hospitality_company_id are required'
        });
      }

      // SECURITY: hospitality_company_id came straight off req.query on a route
      // that had no acl() whatsoever. The role gate now lives on the route;
      // here the requested company must be inside the caller's own scope.
      const scopeIds = await resolveApprovalCompanyScope(req);
      if (!inCompanyScope(scopeIds, parseInt(hospitality_company_id))) {
        return res.status(404).json({ status: 2, message: 'No matching policy found' });
      }

      const policy = await findBestMatchingPolicy({
        entity_type,
        hospitality_company_id: parseInt(hospitality_company_id),
        hotel_id: hotel_id ? parseInt(hotel_id) : null,
        department_id: department_id ? parseInt(department_id) : null,
        process_id: process_id ? parseInt(process_id) : null
      });

      if (!policy) {
        return res.status(404).json({ status: 2, message: 'No matching policy found' });
      }

      const fullPolicy = await getApprovalPolicyWithSteps(policy.id);
      res.json({ status: 1, data: fullPolicy });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  getDepartmentPreview: async (req, res) => {
    try {
      const { id } = req.params;
      const { hospitality_company_id, hotel_id } = req.query;

      // SECURITY: policy id was unscoped (`WHERE id = $1`).
      if (!(await guardPolicyTenant(req, res, parseInt(id)))) return;

      const result = await getDepartmentSubGraphPreview(
        parseInt(id),
        hospitality_company_id ? parseInt(hospitality_company_id) : null,
        hotel_id ? parseInt(hotel_id) : null
      );

      return res.json({ status: true, data: result });
    } catch (err) {
      logError('getDepartmentPreview error', err);
      return res.status(err.message.includes('not found') ? 404 : 500).json({
        status: false,
        message: err.message
      });
    }
  },

  /**
   * Get pending instances that would be affected by a policy change.
   * GET /hospitality/approval/policies/:id/pending-impact
   */
  async getPendingImpact(req, res) {
    try {
      const policyId = parseInt(req.params.id);
      logger.info(`[PendingImpact] Called with policyId=${policyId}, params=${JSON.stringify(req.params)}`);
      if (!policyId || isNaN(policyId)) {
        return res.status(400).json({ status: 3, message: 'Invalid policy ID' });
      }
      // SECURITY: policy id was unscoped (`WHERE id = $1`); the payload leaks
      // RFQ/PO identifiers from whichever tenant owns the policy.
      if (!(await guardPolicyTenant(req, res, policyId))) return;
      const instances = await getPendingInstancesForPolicy(policyId);
      logger.info(`[PendingImpact] Found ${instances.length} pending instances for policy ${policyId}`);

      const data = instances.map(inst => {
        const metadata = typeof inst.metadata === 'string' ? JSON.parse(inst.metadata) : inst.metadata;
        return {
          id: inst.id,
          entity_type: inst.entity_type,
          entity_id: inst.entity_id,
          current_step: inst.current_step,
          total_steps: parseInt(inst.total_steps),
          entity_identifier: metadata?.rfq_number || metadata?.rfq_no || metadata?.po_number || `ID-${inst.entity_id}`,
          created_at: inst.created_at
        };
      });

      return res.json({ status: 1, data: { pending_count: data.length, instances: data } });
    } catch (err) {
      logError('getPendingImpact error', err);
      return res.status(400).json({ status: 3, message: err.message || 'Failed to get pending impact' });
    }
  },

  /**
   * Get change history for an approval instance.
   * GET /hospitality/approval/instance/:id/change-history
   */
  async getInstanceChangeHistory(req, res) {
    try {
      const instanceId = parseInt(req.params.id);
      // SECURITY: instance id was unscoped (`WHERE i.id = $1`).
      if (!(await guardInstanceTenant(req, res, instanceId))) return;
      const history = await getInstanceChangeHistoryService(instanceId);
      return res.json({ status: 1, data: history });
    } catch (err) {
      logError('getInstanceChangeHistory error', err);
      return res.status(400).json({ status: 3, message: err.message || 'Failed to get change history' });
    }
  },

  /**
   * Predict whether the calling user would be the FINAL approver of an
   * about-to-be-created approval instance for `entity_type`, given the
   * RFQ's hospitality scope. Used by the QC finalize flow to gate the
   * merge-PO prompt: only the final approver should be asked "merge into
   * existing draft or start a new one?" because their action is what
   * actually drafts the PO. Non-final approvers shouldn't see the prompt —
   * the question naturally rolls up to whoever closes the chain.
   *
   * Two ways to call:
   *   (a) ?entity_type=NEGOTIATION_QUOTE&rfq_id=123 (preferred; the
   *       endpoint derives hospitality_company_id / hotel_id /
   *       department_id / process_id from the RFQ — same scope the
   *       NEGOTIATION_QUOTE instance would actually be created with).
   *   (b) ?entity_type=...&hospitality_company_id=...&hotel_id=...&
   *        department_id=...&process_id=... (manual scope).
   *
   * Without process_id the policy lookup defaults to process-agnostic
   * matching, which is wrong when the RFQ uses a specific procurement
   * process — that's exactly why finalize-time auto-approvals were
   * silently skipping the merge prompt.
   */
  async willBeFinalApprover(req, res) {
    try {
      const entity_type = String(req.query.entity_type || '').trim();
      if (!entity_type) {
        return res.status(400).json({ status: 0, message: 'entity_type is required' });
      }
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ status: 3, message: 'Unauthorized' });
      }

      let hospitality_company_id = req.query.hospitality_company_id
        ? parseInt(req.query.hospitality_company_id) : null;
      let hotel_id = req.query.hotel_id ? parseInt(req.query.hotel_id) : null;
      let department_id = req.query.department_id
        ? parseInt(req.query.department_id) : null;
      let process_id = req.query.process_id ? parseInt(req.query.process_id) : null;

      // If rfq_id is supplied, derive scope from the RFQ so the policy
      // resolver matches exactly what createApprovalInstance will use at
      // submit time. This is the most reliable path because the FE doesn't
      // need to know (or guess) every scope dimension.
      const rfq_id = req.query.rfq_id ? parseInt(req.query.rfq_id) : null;
      if (rfq_id) {
        const rfq = await db.oneOrNone(
          `SELECT id, hospitality_company_id, hotel_id, department_id, process_id
             FROM tbl_rfq WHERE id = $1`,
          [rfq_id]
        );
        if (!rfq) {
          return res.status(404).json({ status: 2, message: 'RFQ not found' });
        }
        hospitality_company_id = rfq.hospitality_company_id || hospitality_company_id;
        hotel_id = rfq.hotel_id ?? hotel_id;
        department_id = rfq.department_id ?? department_id;
        process_id = rfq.process_id ?? process_id;
      }

      if (!hospitality_company_id) {
        return res.status(400).json({ status: 0, message: 'hospitality_company_id (or rfq_id) is required' });
      }

      const willBeFinal = await checkIfUserIsFinalApprover(
        userId,
        entity_type,
        hospitality_company_id,
        hotel_id,
        department_id,
        null,
        process_id
      );
      return res.json({
        status: 1,
        data: {
          willBeFinal: !!willBeFinal,
          // Surface the resolved scope so the FE (and logs) can sanity-check
          // what was actually probed.
          resolved_scope: {
            hospitality_company_id,
            hotel_id,
            department_id,
            process_id,
          },
        },
      });
    } catch (err) {
      logError('willBeFinalApprover error', err);
      return res.status(400).json({ status: 3, message: err.message || 'Failed to check final approver status' });
    }
  },
};

// Note: the per-controller `_sendPropagationEmails` helper that used to live
// here was hoisted into approvalPropagationService.js as `dispatchPropagationEmails`
// so usersController and hospitalityController can call it after their
// membership-change propagations too. The behaviour is identical.

/**
 * Process Management Controller
 * Handles CRUD operations for approval processes (universal business domains)
 */
const processController = {
  /**
   * Create a new approval process
   * POST /api/v1/general/hospitality/approval/processes
   */
  async createProcess(req, res) {
    try {
      const { name, description, process_type } = req.body;
      const created_by = req.user?.id;
      const company_id = req.user.company_id;

      if (!company_id || !name || !created_by) {
        return res.status(400).json({
          status: 3,
          message: 'company_id and name are required'
        });
      }

      const process = await createApprovalProcess({
        company_id: parseInt(company_id),
        name,
        description,
        created_by,
        process_type: process_type || 'RFQ'
      });

      res.status(201).json({ status: 1, data: process });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Get all processes with optional filtering
   * GET /api/v1/general/hospitality/approval/processes
   */
  async getProcesses(req, res) {
    try {
      const { include_inactive, process_type, company_id: queryCompanyId } = req.query;
      const { company_id, user_type } = req.user;

      // Hospitality admins (user_type=7) configuring scope for users in OTHER
      // companies need to pass company_id explicitly. For everyone else, default
      // to their own parent company (current self-service behavior).
      const effectiveCompanyId = (queryCompanyId && Number(user_type) === 7)
        ? parseInt(queryCompanyId, 10)
        : (company_id ? parseInt(company_id) : undefined);

      const data = await getApprovalProcesses({
        company_id: effectiveCompanyId,
        include_inactive: include_inactive === 'true',
        process_type: process_type || null
      });

      res.json({ status: 1, data });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Update a process
   * PUT /api/v1/general/hospitality/approval/processes/:id
   */
  async updateProcess(req, res) {
    try {
      const { id } = req.params;
      const { name, description, is_active, process_type } = req.body;

      // SECURITY: tbl_approval_processes was mutable by id across tenants.
      if (!(await guardProcessTenant(req, res, parseInt(id)))) return;

      const patch = {};
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.description = description;
      if (is_active !== undefined) patch.is_active = is_active;
      if (process_type !== undefined) patch.process_type = process_type;

      const data = await updateApprovalProcess(parseInt(id), patch);

      if (!data) {
        return res.status(404).json({ status: 2, message: 'Process not found' });
      }

      res.json({ status: 1, data });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  },

  /**
   * Delete (soft delete) a process
   * DELETE /api/v1/general/hospitality/approval/processes/:id
   */
  async deleteProcess(req, res) {
    try {
      const { id } = req.params;
      // SECURITY: same cross-tenant hole as updateProcess, but destructive —
      // deactivating a process silently unroutes every policy hanging off it.
      if (!(await guardProcessTenant(req, res, parseInt(id)))) return;
      await deleteApprovalProcess(parseInt(id));
      res.json({ status: 1, message: 'Process deactivated successfully' });
    } catch (e) {
      logError(e);
      res.status(400).json({ status: 3, message: e.message });
    }
  }
};

export { hospitalityApprovalController, processController };
export default generalController;

