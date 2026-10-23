// Creator remarks: an optional internal note the person opening a negotiation
// round leaves for the approvers. Never shown to vendors.

export const CREATOR_REMARKS_MAX = 1000;

export const normalizeCreatorRemarks = (value) => {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, message: 'Remarks must be text.' };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > CREATOR_REMARKS_MAX) {
    return { ok: false, message: `Remarks can be at most ${CREATOR_REMARKS_MAX} characters.` };
  }
  return { ok: true, value: trimmed };
};

// Fields that exist for approvers only. Every vendor-facing round payload must
// pass through this before it leaves the server.
export const stripInternalRoundFields = (round) => {
  if (Array.isArray(round)) return round.map(stripInternalRoundFields);
  if (!round || typeof round !== 'object') return round;
  const { creator_remarks, ...rest } = round; // eslint-disable-line no-unused-vars
  return rest;
};
