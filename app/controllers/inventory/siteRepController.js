import { sendInventoryError } from '../../services/inventory/errors.js';
import { revokeSiteRepTokens } from '../../services/inventory/siteRepService.js';

/**
 * POST /api/v1/inventory/po/:poId/site-rep/revoke   body: { tokenId? }
 *
 * Revokes the PO's live site-rep receiving links (one when tokenId is given,
 * else all). 404 when the caller cannot see the PO, 403 without grn.create at
 * the link's hotel. Idempotent: nothing live answers 200 with revoked 0.
 */
export const revokeSiteRep = async (req, res) => {
  let out;
  try {
    out = await revokeSiteRepTokens(req.user, { poId: req.params.poId, tokenId: req.body?.tokenId ?? null });
  } catch (err) {
    return sendInventoryError(res, err);
  }

  res.locals.activityDetail = {
    scope: {
      hospitalityCompanyId: out.companyId,
      hotelId: out.hotelIds.length === 1 ? out.hotelIds[0] : null,
      entityLabel: out.poNumber,
    },
    metadata: { revoked: out.revoked, token_ids: out.tokenIds },
  };
  return res.json({
    status: 1,
    message: out.revoked ? 'The receiving link has been revoked.' : 'There was no active receiving link to revoke.',
    data: { poId: out.poId, revoked: out.revoked, tokenIds: out.tokenIds },
  });
};
