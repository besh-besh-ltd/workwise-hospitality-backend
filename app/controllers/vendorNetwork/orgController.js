// Vendor Networks: org-level endpoints (spec §4.1, §5).

import Config from "../../config/app.config.js";
import userModel from "../../models/userModel.js";
import jwtHelper from "../../helper/jwtHelper.js";
import { encryptStable } from "../../helper/claimCrypto.js";
import { resolveActingContext } from "../../services/vendorNetwork/actingContext.js";
import { logger } from "../../util/logger.js";

/** A positive int4 from a number or a digit string, else null. */
function parseVendorId(value) {
  const n = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/**
 * POST /vendor-network/switch-entity { entity_vendor_id }
 *
 * The body id is only a target. Whether the caller may act for it is decided by
 * the same resolver jwtUsr runs, recomputed from the PERSON (never the entity
 * the current token happens to act as), so a switch can never widen access.
 */
export async function switchEntity(req, res) {
  try {
    const target = parseVendorId(req.body?.entity_vendor_id);
    if (target === null) {
      return res.status(400).json({ status: 0, message: "entity_vendor_id is required" });
    }

    const personId = req.user.network?.actor_user_id ?? req.user.id;
    const [person] = await userModel.user_detail_check(personId);
    const ctx = person ? await resolveActingContext(person, target) : null;
    if (!ctx || Number(ctx.entityRow.id) !== target) {
      return res.status(403).json({ status: 0, message: "You cannot act for this entity" });
    }

    // Same `sub`/`ag` as a fresh login of this person, so jwtUsr's ag check holds.
    const token = jwtHelper.signAccessTokenUser({
      user_id: encryptStable(String(person.id)),
      name: person.name,
      user_agent: encryptStable(String(person.user_agent)),
      sessions: "",
      ent: encryptStable(String(target)),
    });
    return res.status(200).json({
      status: 1,
      message: "Switched entity",
      data: { token, acting_entity_id: target },
    });
  } catch (error) {
    logger.error({ err: error.message }, "vendor-network switchEntity failed");
    return res.status(400).json({ status: 3, message: Config.errorText.value });
  }
}

export default { switchEntity };
