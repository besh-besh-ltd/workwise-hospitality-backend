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

// Remarks are untrusted text going into HTML mail: escape all five HTML
// metacharacters first, then turn line breaks (CRLF, CR or LF) into <br>.
export const escapeHtmlMultiline = (text) => {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r\n|\r|\n/g, '<br>');
};

// The detail-list row shared by the approval-step and internal round emails.
export const creatorRemarksRowHtml = (remarks) => {
  if (typeof remarks !== 'string' || remarks.trim().length === 0) return '';
  return `<li style="padding:4px 0;"><strong>Creator's remarks:</strong> ${escapeHtmlMultiline(remarks)}</li>`;
};

// One plain-text line for the in-app notification: whitespace collapsed and cut
// to `max` characters (code points, so emoji are never split) with an ellipsis.
export const creatorRemarksPreview = (remarks, max = 140) => {
  if (typeof remarks !== 'string') return '';
  const line = remarks.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : line;
};
