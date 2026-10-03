/**
 * Process-wide cryptr instance for the per-request auth paths, behind one
 * shared bounded memo.
 *
 * cryptr runs a synchronous 100k-iteration pbkdf2 on EVERY encrypt and
 * decrypt (~25 ms of blocked event loop each). Every authenticated request
 * decrypts the token's `sub` (and, for jwtUsr, `ag`) claims, and the socket
 * handshake decrypts `sub` again. One memo shared by all of those sites means
 * a token is paid for once per process, not once per site per request.
 *
 * What is cached is only the pure ciphertext -> plaintext mapping. The auth
 * decision itself (JWT signature + expiry, user lookup, deactivation, the
 * user-agent match) still runs against the database on every request.
 */
import Cryptr from 'cryptr';
import Config from '../config/app.config.js';
import { createDecryptMemo, createEncryptCache } from './decryptMemo.js';

const cryptr = new Cryptr(Config.cryptR.secret);

/** Memoised `cryptr.decrypt`. Throws (and caches nothing) on a bad ciphertext. */
export const decryptClaim = createDecryptMemo((ciphertext) => cryptr.decrypt(ciphertext));

/**
 * Stable ciphertext for a plaintext (e.g. get_profile's `user_key`).
 *
 * cryptr output is salted, so every encrypt is different but every one of
 * them decrypts to the same value. The frontend treats `user_key` as an
 * opaque string it hands back to /hospitality-subscription-payment, which
 * decrypts it, so re-serving an earlier valid ciphertext is equivalent and
 * skips a pbkdf2 per profile load. The value carries no expiry of its own, so
 * caching it does not extend any lifetime.
 */
export const encryptStable = createEncryptCache((plaintext) => cryptr.encrypt(plaintext));
