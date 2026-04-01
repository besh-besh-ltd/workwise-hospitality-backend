import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import userModel from '../../models/userModel.js';
import generalModel, {
  createApprovalInstance,
  createApprovalPolicy,
  deleteApprovalPolicy,
  deletePolicySteps,
  getApprovalInstanceDetails,
  getApprovalInstanceById,
  getApprovalPolicies,
  getApprovalPoliciesWithSteps,
  getApprovalPolicyWithSteps,
  insertPolicySteps,
  submitApprovalAction,
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
  recordLifecycleEvent
} from '../../models/generalModel.js';
import { AVAILABLE_HIERARCHY_TYPES, DEPARTMENT_SCOPED_ENTITY_TYPES } from '../../util/constants.js';
import { handleRFQPostApproval, handleRFQRejection } from '../rfq/rfqController.js';
import { handleNegotiationPostApproval } from '../negotiation/negotiationController.js';
import { draftPO, buildAuthoritativePOPayload } from '../po/purchaseOrderController.js';
import { initiatePurchaseOrder } from '../../models/purchaseOrderModel.js';
import rfqModel from '../../models/rfqModel.js';
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
      console.log(error);
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
      console.log(error);
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
        is_department_scoped,
        steps,
        id
      } = req.body;
      const created_by = req.user?.id;

      if (!created_by) {
        return res.status(401).json({ status: 3, message: 'User authentication required' });
      }

      let policy;
      if (id) {
        // Update existing policy
        policy = await updateApprovalPolicy(id, {
          entity_type,
          hospitality_company_id,
          hotel_id,
          department_id,
          process_id,
          is_active,
          is_master,
          is_department_scoped: is_department_scoped !== undefined
            ? is_department_scoped
            : undefined
        });
        if (steps && steps.length > 0) {
          await deletePolicySteps(id);
          await insertPolicySteps(steps, id);
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
        policy = await createApprovalPolicy({
          entity_type,
          hospitality_company_id,
          hotel_id,
          department_id,
          process_id: process_id ? parseInt(process_id) : null,
          created_by,
          is_active,
          is_master: is_master || false,
          is_department_scoped: is_department_scoped !== undefined
            ? is_department_scoped
            : DEPARTMENT_SCOPED_ENTITY_TYPES.includes(entity_type)
        });
        if (steps && steps.length > 0) {
          await insertPolicySteps(steps, policy.id);
        }
      }

      const fullPolicy = await getApprovalPolicyWithSteps(policy.id);
      res.status(id ? 200 : 201).json({ status: 1, data: fullPolicy });
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

      const result = await submitApprovalAction({
        approval_instance_id: parseInt(approval_instance_id),
        approval_instance_step_id: approval_instance_step_id ? parseInt(approval_instance_step_id) : null,
        approver_user_id,
        action,
        comment
      });

      // Handle post-approval/rejection processing based on entity type
      if (result.instance_status === 'APPROVED' || result.instance_status === 'REJECTED') {
        try {
          // Get the approval instance to determine entity type
          const instance = await getApprovalInstanceById(parseInt(approval_instance_id));

          if (instance && ['RFQ', 'TENDER'].includes(instance.entity_type)) {
            if (result.instance_status === 'APPROVED') {
              await handleRFQPostApproval(parseInt(approval_instance_id), approver_user_id);
            } else if (result.instance_status === 'REJECTED') {
              await handleRFQRejection(parseInt(approval_instance_id), approver_user_id, comment);
            }
          }

          // Handle NEGOTIATION post-approval
          if (instance && instance.entity_type === 'NEGOTIATION' && result.instance_status === 'APPROVED') {
            try {
              await handleNegotiationPostApproval(parseInt(approval_instance_id), approver_user_id);
            } catch (negError) {
              console.error('Error in NEGOTIATION post-approval:', negError);
            }
          }

          // Handle NEGOTIATION_QUOTE post-approval — create PO after commercial approval
          if (instance && instance.entity_type === 'NEGOTIATION_QUOTE' && result.instance_status === 'APPROVED') {
            try {
              const metadata = typeof instance.metadata === 'string'
                ? JSON.parse(instance.metadata)
                : (instance.metadata || {});

              if (metadata.po_payload && metadata.po_user) {
                // Path A: PO payload stored by rfqController.finalize
                await db.tx(async (t) => {
                  const authPayload = await buildAuthoritativePOPayload(metadata.po_payload, t);
                  const poResult = await draftPO(authPayload, metadata.po_user, t);

                  const entityType = metadata.is_tender === 1 ? 'TENDER' : 'RFQ';
                  await recordLifecycleEvent({
                    entity_type: entityType,
                    entity_id: metadata.rfq_id,
                    stage: 'NEGOTIATION_QUOTES_APPROVED',
                    action: 'APPROVE',
                    performed_by: approver_user_id,
                    metadata: {
                      approval_instance_id: parseInt(approval_instance_id),
                      rfq_product_id: metadata.rfq_product_id,
                      vendor_id: metadata.vendor_id,
                      quote_id: metadata.quote_id
                    },
                    remarks: comment,
                    txContext: t
                  });
                });
              } else if (metadata.rfq_id && metadata.selected_quotes?.length > 0 && metadata.is_tender !== 1) {
                // Path B: Negotiation flow — construct PO from selected quotes
                const rfqProductId = metadata.rfq_product_id || instance.entity_id;
                const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${metadata.rfq_id}`);
                const rfqData = rfq[0];

                if (rfqData) {
                  await db.tx(async (t) => {
                    // Get the finalization submitter (who initiated the NEGOTIATION_QUOTE approval)
                    const poCreator = await t.oneOrNone('SELECT id, company_id FROM tbl_users WHERE id = $1', [instance.initiated_by]);
                    const poUser = poCreator
                      ? { id: poCreator.id, company_id: poCreator.company_id }
                      : { id: req.user.id, company_id: req.user.company_id };

                    const product = await rfqModel.getRfqProductById(rfqProductId, metadata.rfq_id, t);
                    if (product) {
                      for (const selectedQuote of metadata.selected_quotes) {
                        try {
                          const vendorQuoteItem = await t.oneOrNone(
                            `SELECT qi.quantity, qi.unit, qi.unit_price, qi.id as quote_item_id,
                                    qi.freight_price, qi.freight_mode, qi.package_price, qi.package_mode, qi.tax, qi.tax_mode
                             FROM tbl_quote_items qi
                             JOIN tbl_quotes q ON q.id = qi.quote_id
                             WHERE q.rfq_id = $1 AND qi.product_variant_id = $2 AND qi.variant = $3 AND q.created_by = $4
                             ORDER BY q.timestamp DESC LIMIT 1`,
                            [metadata.rfq_id, product.product_variant_id, product.variant, selectedQuote.vendor_id]
                          );

                          if (vendorQuoteItem) {
                            const negotiationPrice = parseFloat(selectedQuote.quoted_price);
                            const quantity = parseFloat(vendorQuoteItem.quantity) || 1;
                            const totalValue = quantity * negotiationPrice;

                            const poResult = await draftPO({
                              rfq_id: metadata.rfq_id,
                              project_id: rfqData.project_id,
                              total_value: totalValue,
                              quote_item_id: vendorQuoteItem.quote_item_id,
                              product_info: {
                                rfq_product_id: rfqProductId,
                                quantity: vendorQuoteItem.quantity,
                                unit: vendorQuoteItem.unit || 'N/A',
                                unit_price: negotiationPrice,
                                charges_meta: {
                                  freight_price: vendorQuoteItem.freight_price,
                                  freight_mode: vendorQuoteItem.freight_mode,
                                  package_price: vendorQuoteItem.package_price,
                                  package_mode: vendorQuoteItem.package_mode,
                                  tax: vendorQuoteItem.tax,
                                  tax_mode: vendorQuoteItem.tax_mode
                                },
                                finalized_vendor_id: selectedQuote.vendor_id
                              }
                            }, poUser, t);
                          }
                        } catch (poError) {
                          console.error(`Error creating PO for vendor ${selectedQuote.vendor_id}:`, poError);
                        }
                      }
                    }

                    await recordLifecycleEvent({
                      entity_type: 'RFQ',
                      entity_id: metadata.rfq_id,
                      stage: 'NEGOTIATION_QUOTES_APPROVED',
                      action: 'APPROVE',
                      performed_by: approver_user_id,
                      metadata: {
                        approval_instance_id: parseInt(approval_instance_id),
                        rfq_product_id: rfqProductId,
                        quote_ids: metadata.selected_quotes.map(q => q.quote_id),
                        vendor_ids: metadata.selected_quotes.map(q => q.vendor_id)
                      },
                      remarks: comment,
                      txContext: t
                    });
                  });
                }
              }
            } catch (negQuoteError) {
              console.error('Error in NEGOTIATION_QUOTE post-approval (PO creation):', negQuoteError);
            }
          }

          // Handle TECHNICAL rejection - update round status so evaluator can resubmit
          if (instance && instance.entity_type === 'TECHNICAL' && result.instance_status === 'REJECTED') {
            try {
              await rfqModel.updateTechEvalRound(instance.entity_id, {
                status: 'REJECTED',
                completed_at: new Date()
              });
            } catch (techRejErr) {
              console.error('Error updating tech eval round on rejection:', techRejErr);
            }
          }
        } catch (postActionError) {
          // Log but don't fail the response - the approval action itself succeeded
          console.error('Error in post-approval processing:', postActionError);
        }
      }

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
      console.error('getDepartmentPreview error:', err);
      return res.status(err.message.includes('not found') ? 404 : 500).json({
        status: false,
        message: err.message
      });
    }
  },
};

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

