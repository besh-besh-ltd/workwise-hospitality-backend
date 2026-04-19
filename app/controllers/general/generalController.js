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
  getDepartmentSubGraphPreview
} from '../../models/generalModel.js';
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

      let policy;
      let propagationResult = null;
      if (id) {
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

          const updatedPolicy = await updateApprovalPolicy(id, {
            entity_type,
            hospitality_company_id,
            hotel_id,
            department_id,
            process_id,
            is_active,
            is_master
          }, t);

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
        if (!entity_type || !hospitality_company_id) {
          return res.status(400).json({
            status: 3,
            message: 'entity_type and hospitality_company_id are required'
          });
        }

        // Validate entity_type
        const validEntityTypes = ['RFQ', 'TENDER', 'NEGOTIATION', 'PO', 'INDENT', 'TECHNICAL', 'ARC', 'NEGOTIATION_QUOTE'];
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
            hospitality_company_id,
            hotel_id,
            department_id,
            process_id: process_id ? parseInt(process_id) : null,
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
      const filters = {
        hospitality_company_id: hospitality_company_id ? parseInt(hospitality_company_id) : undefined,
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

      if (!entity_type || !entity_id || !hospitality_company_id) {
        return res.status(400).json({
          status: 3,
          message: 'entity_type, entity_id, and hospitality_company_id are required'
        });
      }

      const result = await createApprovalInstance({
        entity_type,
        entity_id: parseInt(entity_id),
        hospitality_company_id: parseInt(hospitality_company_id),
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
      const data = await getApprovalInstancesByEntity(entity_type, parseInt(entity_id));
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
      const history = await getInstanceChangeHistoryService(instanceId);
      return res.json({ status: 1, data: history });
    } catch (err) {
      logError('getInstanceChangeHistory error', err);
      return res.status(400).json({ status: 3, message: err.message || 'Failed to get change history' });
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
      const { include_inactive, process_type } = req.query;
      const { company_id } = req.user;

      const data = await getApprovalProcesses({
        company_id: company_id ? parseInt(company_id) : undefined,
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

