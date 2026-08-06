import moment from 'moment-timezone';

export const QUOTE_VISIBILITY_TIMEZONE = 'Asia/Kolkata';

const BID_END_FORMATS = [
  'YYYY-MM-DDTHH:mm:ss',
  'YYYY-MM-DDTHH:mm',
  'YYYY-MM-DD HH:mm:ss',
  'YYYY-MM-DD HH:mm',
  'YYYY-MM-DD',
];

export const getBidEndMomentIst = (raw) => {
  if (raw == null || raw === '') return null;

  if (moment.isMoment(raw)) {
    return raw.clone().tz(QUOTE_VISIBILITY_TIMEZONE);
  }

  if (raw instanceof Date) {
    const parsed = moment(raw);
    return parsed.isValid() ? parsed.tz(QUOTE_VISIBILITY_TIMEZONE) : null;
  }

  const input = String(raw).trim();
  if (!input) return null;

  if (/([+-]\d{2}:?\d{2}|Z)$/i.test(input)) {
    const zoned = moment.parseZone(input);
    return zoned.isValid() ? zoned.tz(QUOTE_VISIBILITY_TIMEZONE) : null;
  }

  const normalized = input.replace(' ', 'T');
  const strict = moment.tz(normalized, BID_END_FORMATS, true, QUOTE_VISIBILITY_TIMEZONE);
  if (strict.isValid()) return strict;

  const loose = moment.tz(normalized, QUOTE_VISIBILITY_TIMEZONE);
  return loose.isValid() ? loose : null;
};

/**
 * "Now" as an IST moment — the JS twin of the SQL idiom
 * `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')` (see IST_NOW /
 * IST_TODAY in app/models/dashboardModel.js).
 *
 * Every naive `timestamp without time zone` column in this schema that the
 * product treats as a wall-clock deadline (`bid_end_date`,
 * `tender_publish_date`, `vendor_clarification_date`, the ARC submission
 * window) stores IST. Comparing one of those against `new Date()` resolves
 * through the NODE PROCESS timezone, which is UTC in production — a 5h30m
 * error. Pair this with `getBidEndMomentIst` instead.
 */
export const istNow = () => moment.tz(QUOTE_VISIBILITY_TIMEZONE);

export const buildQuoteVisibilityMeta = (rfqOrBidEndDate) => {
  const bidEndDate =
    typeof rfqOrBidEndDate === 'object' && rfqOrBidEndDate !== null
      ? rfqOrBidEndDate.bid_end_date
      : rfqOrBidEndDate;

  const deadlineMoment = getBidEndMomentIst(bidEndDate);
  const now = moment.tz(QUOTE_VISIBILITY_TIMEZONE);
  const locked = !!deadlineMoment && !now.isAfter(deadlineMoment);
  const remainingMs = locked ? Math.max(deadlineMoment.diff(now), 0) : 0;

  return {
    locked,
    timezone: QUOTE_VISIBILITY_TIMEZONE,
    deadline: deadlineMoment ? deadlineMoment.format('YYYY-MM-DD HH:mm:ss') : null,
    remainingMs,
    message: locked
      ? 'Quotes will appear after the quote submission deadline passes.'
      : null,
  };
};

export const sanitizeQuoteProductsForLockedState = (products = [], quoteVisibility) =>
  (Array.isArray(products) ? products : []).map((product) => ({
    ...product,
    quotations: [],
    all_vendors: [],
    finalization_history: [],
    last_purchase_rate: null,
    last_quote_rate: null,
    latest_target_price: null,
    quoteVisibility,
  }));

export const createQuoteVisibilityError = (
  quoteVisibility,
  message = 'Quotes are locked until the quote submission deadline has passed in IST.'
) => {
  const error = new Error(message);
  error.statusCode = 423;
  error.quoteVisibility = quoteVisibility;
  return error;
};

export const ensureQuoteVisibilityUnlocked = (
  rfqOrBidEndDate,
  message = 'Quotes are locked until the quote submission deadline has passed in IST.'
) => {
  const quoteVisibility = buildQuoteVisibilityMeta(rfqOrBidEndDate);
  if (quoteVisibility.locked) {
    throw createQuoteVisibilityError(quoteVisibility, message);
  }
  return quoteVisibility;
};
