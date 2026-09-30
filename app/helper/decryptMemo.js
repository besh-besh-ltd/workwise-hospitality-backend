/**
 * Bounded memo for deterministic decryption of JWT claims.
 *
 * cryptr derives its key with a synchronous pbkdf2 on every decrypt (~28 ms),
 * and the jwtUsr strategy decrypts two claims (`sub`, `ag`) on every
 * authenticated request — ~55 ms of blocked event loop per call, which capped
 * one backend process at ~15 authenticated requests/s under load.
 *
 * Only the ciphertext → plaintext step is memoised. It is a pure function of
 * the ciphertext string, so a hit can never return another user's value.
 * Every authorisation decision (expiry, user lookup, user-agent match) still
 * runs on every request against the database.
 *
 * Map keeps insertion order, so re-inserting on a hit and deleting the first
 * key on overflow gives an LRU without a dependency.
 */
export const DEFAULT_DECRYPT_MEMO_SIZE = 5000;

export function createDecryptMemo(decrypt, max = DEFAULT_DECRYPT_MEMO_SIZE) {
  const cache = new Map();

  const memoDecrypt = (ciphertext) => {
    if (typeof ciphertext !== 'string') return decrypt(ciphertext);
    if (cache.has(ciphertext)) {
      const value = cache.get(ciphertext);
      cache.delete(ciphertext);
      cache.set(ciphertext, value);
      return value;
    }
    // A failed decrypt throws and is deliberately not cached.
    const value = decrypt(ciphertext);
    cache.set(ciphertext, value);
    if (cache.size > max) cache.delete(cache.keys().next().value);
    return value;
  };

  memoDecrypt.size = () => cache.size;
  memoDecrypt.clear = () => cache.clear();
  return memoDecrypt;
}
