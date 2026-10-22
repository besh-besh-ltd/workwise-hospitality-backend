// Time-limited links to files we stored in S3.
//
// The rest of the codebase hands out the object URL the upload returned
// (`file.location`). Send-back attachments are internal evidence (site
// photos, quotes, the approver's questions), so the thread links to them with
// a signed GET that expires instead.
//
// @aws-sdk/s3-request-presigner is not a dependency, so this signs the query
// string itself: AWS Signature Version 4, query-parameter form, UNSIGNED-PAYLOAD,
// host the only signed header. Checked against AWS's published example in
// tests/services/po.sendBack.signedUrl.test.js.
//
// Only objects in our own bucket are signed. Anything else (another bucket, a
// URL we cannot parse, missing credentials) comes back as stored, so a link
// never disappears because it could not be signed.

import crypto from 'node:crypto';
import { logError } from '../../helper/common.js';

export const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

// RFC 3986: encodeURIComponent leaves !'()* alone; SigV4 does not.
const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

/**
 * Bucket, region, key and host of a virtual-hosted S3 object URL
 * (https://<bucket>.s3[.<region>].amazonaws.com/<key>), or null.
 */
export function parseS3ObjectUrl(fileUrl) {
  let url;
  try {
    url = new URL(String(fileUrl));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const m = url.hostname.match(/^(.+?)\.s3(?:[.-]([a-z0-9-]+))?\.amazonaws\.com$/);
  if (!m) return null;
  let key;
  try {
    key = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  if (!key) return null;
  return { bucket: m[1], region: m[2] || 'us-east-1', key, host: url.hostname };
}

/**
 * A presigned GET URL for one object.
 *
 * @param {{bucket:string, region:string, key:string, host:string}} object
 * @param {{accessKeyId:string, secretAccessKey:string, sessionToken?:string}} credentials
 * @param {{expiresIn?:number, now?:Date}} [opts]
 */
export function presignS3GetUrl(object, credentials, { expiresIn = SIGNED_URL_TTL_SECONDS, now = new Date() } = {}) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${object.region}/s3/aws4_request`;

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  if (credentials.sessionToken) params['X-Amz-Security-Token'] = credentials.sessionToken;
  const query = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join('&');
  const path = `/${object.key.split('/').map(enc).join('/')}`;

  const canonicalRequest = ['GET', path, query, `host:${object.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, object.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `https://${object.host}${path}?${query}&X-Amz-Signature=${signature}`;
}

/**
 * A fresh signed link to a file we stored, or the stored URL when it is not
 * ours to sign. Never throws.
 */
export function signedFileUrl(fileUrl) {
  try {
    const object = parseS3ObjectUrl(fileUrl);
    const bucket = process.env.AWS_S3_BUCKET;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!object || !bucket || object.bucket !== bucket || !accessKeyId || !secretAccessKey) return fileUrl;
    return presignS3GetUrl(object, { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN });
  } catch (err) {
    logError('signedFileUrl failed', err);
    return fileUrl;
  }
}
