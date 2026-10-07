// SECURITY — the jwtUsr claim-decrypt memo (app/helper/decryptMemo.js).
// ----------------------------------------------------------------------------
// cryptr's decrypt runs a synchronous pbkdf2 (~28 ms) and the jwtUsr strategy
// decrypted two claims on every authenticated request, which capped one backend
// process at ~15 authenticated requests/s. The fix memoises ONLY the pure
// ciphertext → plaintext step. These tests pin that:
//   - a ciphertext is decrypted once, then served from the memo
//   - two ciphertexts never share an entry, and the memo stays bounded
//   - a failed decrypt is never cached
//   - authorisation still runs per request: a token whose user-agent no longer
//     matches, or whose user was deleted, is rejected even after a memo hit

import { describe, it, expect, afterAll, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { createDecryptMemo } from "../../app/helper/decryptMemo.js";

const USER = IDS.users.a1_proc_buyer;
const PROBE = "/api/v1/users/me/departments";

afterAll(async () => {
  await closeDb();
});

describe("createDecryptMemo", () => {
  it("decrypts a ciphertext once and serves repeats from the memo", () => {
    const decrypt = jest.fn((c) => `plain:${c}`);
    const memo = createDecryptMemo(decrypt, 10);
    expect(memo("abc")).toBe("plain:abc");
    expect(memo("abc")).toBe("plain:abc");
    expect(memo("abc")).toBe("plain:abc");
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it("keeps different ciphertexts isolated", () => {
    const decrypt = jest.fn((c) => `plain:${c}`);
    const memo = createDecryptMemo(decrypt, 10);
    expect(memo("user-1")).toBe("plain:user-1");
    expect(memo("user-2")).toBe("plain:user-2");
    expect(memo("user-1")).toBe("plain:user-1");
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it("stays bounded and evicts the least recently used entry", () => {
    const decrypt = jest.fn((c) => `plain:${c}`);
    const memo = createDecryptMemo(decrypt, 2);
    memo("a");
    memo("b");
    memo("a"); // a is now most recent
    memo("c"); // evicts b
    expect(memo.size()).toBe(2);
    memo("a");
    expect(decrypt).toHaveBeenCalledTimes(3);
    memo("b");
    expect(decrypt).toHaveBeenCalledTimes(4);
  });

  it("never caches a failed decrypt", () => {
    const decrypt = jest.fn(() => {
      throw new Error("bad ciphertext");
    });
    const memo = createDecryptMemo(decrypt, 10);
    expect(() => memo("junk")).toThrow("bad ciphertext");
    expect(() => memo("junk")).toThrow("bad ciphertext");
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(memo.size()).toBe(0);
  });
});

describe("jwtUsr still authorises every request after a memo hit", () => {
  it("rejects the same token once the user's stored user-agent changes", async () => {
    const client = await httpClient(USER);
    expect((await client.get(PROBE)).status).toBe(200);
    expect((await client.get(PROBE)).status).toBe(200); // memo hit

    await db.none(`UPDATE tbl_users SET user_agent = 'rotated-agent' WHERE id = $1`, [USER]);
    try {
      expect((await client.get(PROBE)).status).toBe(401);
    } finally {
      await db.none(`UPDATE tbl_users SET user_agent = 'jest-test-agent' WHERE id = $1`, [USER]);
    }
    expect((await client.get(PROBE)).status).toBe(200);
  });

  it("rejects the same token once the user is deleted", async () => {
    const client = await httpClient(USER);
    expect((await client.get(PROBE)).status).toBe(200);

    await db.none(`UPDATE tbl_users SET is_deleted = 1 WHERE id = $1`, [USER]);
    try {
      expect((await client.get(PROBE)).status).toBe(401);
    } finally {
      await db.none(`UPDATE tbl_users SET is_deleted = 0 WHERE id = $1`, [USER]);
    }
  });
});
