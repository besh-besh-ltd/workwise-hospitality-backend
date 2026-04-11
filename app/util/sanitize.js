const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'pass', 'secret', 'token', 'jwt',
  'authorization', 'cookie', 'credit_card', 'card_number',
  'cvv', 'cvc', 'ssn', 'otp', 'pin',
  'api_key', 'apikey', 'api_secret',
  'access_token', 'refresh_token',
  'private_key', 'secret_key',
]);

const MAX_STRING_LENGTH = 1024;
const MAX_BODY_SIZE = 8192; // 8KB
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 20;
const REDACTED = '[REDACTED]';

export function sanitizeObject(obj, depth = 0) {
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') {
    if (typeof obj === 'string' && obj.length > MAX_STRING_LENGTH) {
      return obj.substring(0, MAX_STRING_LENGTH) + `...[truncated ${obj.length - MAX_STRING_LENGTH} chars]`;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    const sliced = obj.slice(0, MAX_ARRAY_ITEMS);
    const result = sliced.map(item => sanitizeObject(item, depth + 1));
    if (obj.length > MAX_ARRAY_ITEMS) {
      result.push(`...[${obj.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return result;
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = REDACTED;
    } else {
      sanitized[key] = sanitizeObject(value, depth + 1);
    }
  }
  return sanitized;
}

export function sanitizeBody(body) {
  if (!body) return undefined;
  const sanitized = sanitizeObject(body);
  const serialized = JSON.stringify(sanitized);
  if (serialized && serialized.length > MAX_BODY_SIZE) {
    return serialized.substring(0, MAX_BODY_SIZE) + '...[truncated]';
  }
  return sanitized;
}
