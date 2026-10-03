// SECURITY / PERF — the shared claim-crypto memo (app/helper/claimCrypto.js).
// ----------------------------------------------------------------------------
// cryptr runs a synchronous 100k-iteration pbkdf2 on every encrypt AND decrypt
// (~25 ms of blocked event loop each). Before this change every authenticated
// request paid it twice (jwtUsr: sub + ag), the internal console paid it on
// every request (jwtAdm: sub), the socket handshake paid it again, and every
// profile load paid it once more to mint a fresh `user_key`.
//
// These tests pin, over real HTTP against the real passport strategies:
//   - N requests on one token cost the token's claims ONCE (counted at the
//     pbkdf2 call itself, so no code path can sneak a decrypt past the memo)
//   - a second token is paid for separately (no cross-token sharing)
//   - get_profile serves a stable user_key that still decrypts to the user
//   - a tampered ciphertext is rejected and never cached
// Revocation (user-agent rotation, deleted user) after a memo hit is pinned in
// security.decryptMemo.test.js.

import { describe, it, expect, afterAll, beforeAll, afterEach, jest } from "@jest/globals";
import crypto from "crypto";
import Cryptr from "cryptr";
import Config from "../../app/config/app.config.js";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { loginAsInternalStaff } from "../helpers/auth.js";
import { createEncryptCache } from "../../app/helper/decryptMemo.js";
import { decryptClaim, encryptStable } from "../../app/helper/claimCrypto.js";

const USER = IDS.users.a1_proc_buyer;
const STAFF = IDS.users.companyA_admin;
const TARGET = IDS.users.a1_proc_buyer;
const PROBE = "/api/v1/users/me/departments";

let pbkdf2;
const pbkdf2Calls = () => pbkdf2.mock.calls.length;

beforeAll(() => {
  pbkdf2 = jest.spyOn(crypto, "pbkdf2Sync");
});

afterEach(() => {
  pbkdf2.mockClear();
});

afterAll(async () => {
  pbkdf2.mockRestore();
  await closeDb();
});

describe("createEncryptCache", () => {
  it("returns one ciphertext per plaintext and encrypts it once", () => {
    let n = 0;
    const encrypt = jest.fn((p) => `cipher:${p}:${++n}`);
    const cache = createEncryptCache(encrypt, 10);
    const first = cache("42");
    expect(cache("42")).toBe(first);
    expect(cache(42)).toBe(first); // keyed by the string form
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(cache("43")).not.toBe(first);
    expect(encrypt).toHaveBeenCalledTimes(2);
  });

  it("stays bounded and evicts the least recently used entry", () => {
    const encrypt = jest.fn((p) => `cipher:${p}`);
    const cache = createEncryptCache(encrypt, 2);
    cache("a");
    cache("b");
    cache("a");
    cache("c"); // evicts b
    expect(cache.size()).toBe(2);
    cache("a");
    expect(encrypt).toHaveBeenCalledTimes(3);
    cache("b");
    expect(encrypt).toHaveBeenCalledTimes(4);
  });

  it("never caches a failed encrypt", () => {
    const encrypt = jest.fn(() => {
      throw new Error("boom");
    });
    const cache = createEncryptCache(encrypt, 10);
    expect(() => cache("x")).toThrow("boom");
    expect(() => cache("x")).toThrow("boom");
    expect(cache.size()).toBe(0);
  });
});

describe("claimCrypto against real cryptr", () => {
  it("round-trips and serves the repeat decrypt without pbkdf2", () => {
    const ciphertext = new Cryptr(Config.cryptR.secret).encrypt("98765");
    pbkdf2.mockClear();
    expect(decryptClaim(ciphertext)).toBe("98765");
    expect(pbkdf2Calls()).toBe(1);
    expect(decryptClaim(ciphertext)).toBe("98765");
    expect(pbkdf2Calls()).toBe(1);
  });

  it("rejects a tampered ciphertext every time and never caches it", () => {
    const good = new Cryptr(Config.cryptR.secret).encrypt("98766");
    // Flip one hex digit inside the GCM auth tag (bytes 80..95).
    const pos = 2 * 85;
    const flipped = good[pos] === "0" ? "1" : "0";
    const tampered = good.slice(0, pos) + flipped + good.slice(pos + 1);
    const sizeBefore = decryptClaim.size();
    expect(() => decryptClaim(tampered)).toThrow();
    expect(() => decryptClaim(tampered)).toThrow();
    expect(decryptClaim.size()).toBe(sizeBefore);
  });

  it("encryptStable output decrypts with an independent cryptr instance", () => {
    const key = encryptStable("55555");
    expect(encryptStable("55555")).toBe(key);
    expect(new Cryptr(Config.cryptR.secret).decrypt(key)).toBe("55555");
  });
});

describe("authenticated requests pay for a token's claims once", () => {
  it("jwtUsr: N requests on one token run pbkdf2 exactly twice (sub + ag)", async () => {
    const client = await httpClient(USER); // loginAs encrypts; not counted
    pbkdf2.mockClear();
    for (let i = 0; i < 5; i++) {
      expect((await client.get(PROBE)).status).toBe(200);
    }
    expect(pbkdf2Calls()).toBe(2);
  });

  it("jwtUsr: a second token is decrypted on its own, never shared", async () => {
    const a = await httpClient(USER);
    const b = await httpClient(USER);
    pbkdf2.mockClear();
    expect((await a.get(PROBE)).status).toBe(200);
    expect((await b.get(PROBE)).status).toBe(200);
    expect((await a.get(PROBE)).status).toBe(200);
    expect((await b.get(PROBE)).status).toBe(200);
    expect(pbkdf2Calls()).toBe(4);
  });

  it("jwtAdm: N internal-console requests run pbkdf2 once (sub)", async () => {
    const { user_type: prevStaff } = await db.one(
      "SELECT user_type FROM tbl_users WHERE id = $1",
      [STAFF]
    );
    const { user_type: prevTarget } = await db.one(
      "SELECT user_type FROM tbl_users WHERE id = $1",
      [TARGET]
    );
    await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [STAFF]);
    await db.none("UPDATE tbl_users SET user_type = 2 WHERE id = $1", [TARGET]);
    try {
      const client = await httpClient(null);
      const { headers } = await loginAsInternalStaff(STAFF);
      pbkdf2.mockClear();
      for (let i = 0; i < 3; i++) {
        const res = await client
          .get(`/api/v1/admin/buyer/buyer-details/${TARGET}`)
          .set(headers);
        expect(res.status).toBe(200);
      }
      expect(pbkdf2Calls()).toBe(1);
    } finally {
      await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [STAFF, prevStaff]);
      await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [TARGET, prevTarget]);
    }
  });

  it("get_profile: user_key is stable, valid, and costs no pbkdf2 on repeat", async () => {
    const client = await httpClient(USER);
    const first = await client.get("/api/v1/users/get-profile");
    expect(first.status).toBe(200);
    const key1 = JSON.stringify(first.body).match(/"user_key":"([0-9a-f]+)"/)?.[1];
    expect(key1).toBeTruthy();
    expect(new Cryptr(Config.cryptR.secret).decrypt(key1)).toBe(String(USER));

    pbkdf2.mockClear();
    const second = await client.get("/api/v1/users/get-profile");
    expect(second.status).toBe(200);
    const key2 = JSON.stringify(second.body).match(/"user_key":"([0-9a-f]+)"/)?.[1];
    expect(key2).toBe(key1);
    expect(pbkdf2Calls()).toBe(0);
  });
});
