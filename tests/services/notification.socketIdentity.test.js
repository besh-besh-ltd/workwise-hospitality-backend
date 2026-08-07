// Socket room identity.
//
// The defect this guards, found by watching a real browser: the handshake
// middleware resolved the user as `payload.user || payload.id || payload.userId`.
// This app's login tokens carry `user: true` as a *boolean flag* and keep the
// real id encrypted in `sub` (see passport's `jwtUsr` strategy). So `uid`
// evaluated to `true` for every genuine token and each socket joined a room
// literally named `user:true`, while `emitToUser(80011, ...)` published to
// `user:80011`.
//
// Nothing ever matched. Sockets connected, events were emitted, and not one was
// delivered — measured in the browser as a 26-second lag, i.e. the 30s poll
// picking it up rather than the socket. It also explains why the
// unauthenticated `addNewUser` join existed at all: it was the only path that
// ever put a client in the right room, and it trusted a client-supplied id.
//
// These assert on the room a socket is placed in, which is the observable
// contract `emitToUser` depends on.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import JWT from "jsonwebtoken";
import Cryptr from "cryptr";
import Config from "../../app/config/app.config.js";

const cryptr = new Cryptr(Config.cryptR.secret);

// Minimal socket.io double: we only need the handshake middleware and to record
// which rooms a socket joins.
const buildHarness = async () => {
  const joined = [];
  const middlewares = [];
  const handlers = {};

  jest.unstable_mockModule("socket.io", () => ({
    Server: class {
      constructor() {
        this.sockets = { adapter: { rooms: new Map() } };
      }
      use(fn) {
        middlewares.push(fn);
      }
      on(event, fn) {
        handlers[event] = fn;
      }
      to() {
        return { emit: () => {} };
      }
      emit() {}
    },
  }));

  const { SocketConfig } = await import("../../app/util/socket.js?" + Math.random());
  SocketConfig({});

  const connect = async (token) => {
    const socket = {
      id: "sock-1",
      handshake: { auth: { token }, query: {}, headers: {} },
      join: (room) => joined.push(room),
      on: () => {},
      emit: () => {},
    };
    for (const mw of middlewares) {
      await new Promise((resolve) => mw(socket, resolve));
    }
    return socket;
  };

  return { connect, joined, handlers };
};

const loginToken = (userId, { userAgent = "test-agent" } = {}) => {
  const now = Math.round(Date.now() / 1000);
  return JWT.sign(
    {
      iss: "Des Technico",
      sub: cryptr.encrypt(String(userId)),
      name: "Test User",
      session: "",
      user: true, // a FLAG, not the id — this is the whole bug
      ag: cryptr.encrypt(userAgent),
      iat: now,
      exp: now + 3600,
    },
    Config.jwt.secret
  );
};

beforeEach(() => {
  jest.resetModules();
});

describe("the room a socket joins", () => {
  it("is the real user id, decrypted from sub", async () => {
    const { connect, joined } = await buildHarness();
    await connect(loginToken(80011));

    expect(joined).toContain("user:80011");
  });

  it("is never the literal string 'user:true'", async () => {
    // The exact failure: `payload.user` is boolean true on every login token.
    const { connect, joined } = await buildHarness();
    await connect(loginToken(80011));

    expect(joined).not.toContain("user:true");
  });

  it("puts two different users in two different rooms", async () => {
    const { connect, joined } = await buildHarness();
    await connect(loginToken(80011));
    await connect(loginToken(80016));

    // The bug collapsed every user into one shared room, so this is the
    // assertion that would have caught a cross-tenant broadcast.
    expect(joined).toEqual(["user:80011", "user:80016"]);
    expect(new Set(joined).size).toBe(2);
  });

  it("joins nothing when the token is missing or forged", async () => {
    const { connect, joined } = await buildHarness();
    await connect(undefined);
    await connect("not-a-jwt");
    await connect(JWT.sign({ sub: cryptr.encrypt("80011") }, "the-wrong-secret"));

    expect(joined).toEqual([]);
  });
});

describe("addNewUser cannot be used to join someone else's room", () => {
  it("ignores the client-supplied id and uses the verified one", async () => {
    // This handler used to `socket.join('user:' + userId)` straight from the
    // payload, so any connected client could subscribe to any user's stream.
    const { connect, joined, handlers } = await buildHarness();
    const socket = await connect(loginToken(80011));

    const registered = {};
    socket.on = (event, fn) => {
      registered[event] = fn;
    };
    handlers.connection(socket);

    joined.length = 0;
    registered.addNewUser(80016); // attacker names a different user

    expect(joined).not.toContain("user:80016");
    expect(joined).toEqual(["user:80011"]);
  });

  it("joins nothing at all for an unauthenticated socket", async () => {
    const { connect, joined, handlers } = await buildHarness();
    const socket = await connect(undefined);

    const registered = {};
    socket.on = (event, fn) => {
      registered[event] = fn;
    };
    handlers.connection(socket);

    joined.length = 0;
    registered.addNewUser(80016);

    expect(joined).toEqual([]);
  });
});
