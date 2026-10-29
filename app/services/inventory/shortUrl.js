/**
 * Short link printed on QR labels and sent in notifications: /s/<t>/<id>.
 * The base is FRONT_END_WEBSITE, the frontend origin variable the rest of the
 * backend uses (notificationLinks.toAbsoluteUrl, .env). FRONT_BASE_URL is the
 * older alias some email code still reads.
 */
const DEFAULT_BASE = 'https://hospitality.letsworkwise.com';

export const shortUrl = (t, id) => {
  const base = (process.env.FRONT_END_WEBSITE || process.env.FRONT_BASE_URL || DEFAULT_BASE)
    .replace(/\/+$/, '');
  return `${base}/s/${t}/${id}`;
};
