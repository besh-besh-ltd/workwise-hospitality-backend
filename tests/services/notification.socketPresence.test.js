// Socket presence is not broadcast.
//
// On every `addNewUser` (each tab's connect) and every disconnect, the server
// used to `io.emit('getOnlineUsers', online_users)` — the id of EVERY online
// user, sent to EVERY connected socket on the server, vendors and other
// tenants included. `register` did the same with `userList` (socket ids →
// self-declared names). No client consumes either event (frontend and
// admin-panel: zero references), so the broadcasts are gone; presence stays
// server-side for message/typing routing.
//
// Asserted on the observable surface: what the server emits to all sockets
// and to rooms other than the caller's own.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import JWT from "jsonwebtoken";
import Cryptr from "cryptr";
import Config from "../../app/config/app.config.js";

const cryptr = new Cryptr(Config.cryptR.secret);

const loginToken = (userId) => {
  const now = Math.round(Date.now() / 1000);
  return JWT.sign(
    { iss: "Des Technico", sub: cryptr.encrypt(String(userId)), name: "T", session: "", user: true,
      ag: cryptr.encrypt("test-agent"), iat: now, exp: now + 3600 },
    Config.jwt.secret
  );
};

const buildHarness = async () => {
  const broadcasts = [];
  const roomEmits = [];
  const middlewares = [];
  const handlers = {};

  jest.unstable_mockModule("socket.io", () => ({
    Server: class {
      use(fn) { middlewares.push(fn); }
      on(event, fn) { handlers[event] = fn; }
      to(room) { return { emit: (event, payload) => roomEmits.push({ room, event, payload }) }; }
      emit(event, payload) { broadcasts.push({ event, payload }); }
    },
  }));
  const { SocketConfig } = await import("../../app/util/socket.js?" + Math.random());
  SocketConfig({});

  let n = 0;
  const connect = async (token) => {
    const listeners = {};
    const socket = {
      id: `sock-${++n}`,
      handshake: { auth: { token }, query: {}, headers: {} },
      rooms: [],
      join(room) { this.rooms.push(room); },
      on(event, fn) { (listeners[event] ||= []).push(fn); },
      emit: () => {},
    };
    for (const mw of middlewares) await new Promise((resolve) => mw(socket, resolve));
    handlers.connection(socket);
    const fire = async (event, ...args) => { for (const fn of listeners[event] || []) await fn(...args); };
    return { socket, fire };
  };
  return { connect, broadcasts, roomEmits };
};

beforeEach(() => {
  jest.resetModules();
});

describe("presence is never broadcast to every socket", () => {
  it("addNewUser joins the caller's own room and broadcasts nothing", async () => {
    const { connect, broadcasts, roomEmits } = await buildHarness();
    const buyerA = await connect(loginToken(80011));   // Company A buyer
    const buyerB = await connect(loginToken(80003));   // Company B admin
    await buyerA.fire("addNewUser");
    await buyerB.fire("addNewUser");

    expect(buyerA.socket.rooms).toEqual(["user:80011", "user:80011"]);
    expect(buyerB.socket.rooms).toEqual(["user:80003", "user:80003"]);
    expect(broadcasts.map((b) => b.event)).not.toContain("getOnlineUsers");
    expect(broadcasts).toEqual([]);
    // Nor smuggled through a room either tenant can see.
    expect(roomEmits.filter((e) => e.event === "getOnlineUsers")).toEqual([]);
  });

  it("disconnect broadcasts nothing", async () => {
    const { connect, broadcasts } = await buildHarness();
    const a = await connect(loginToken(80011));
    await a.fire("addNewUser");
    await a.fire("disconnect");
    expect(broadcasts).toEqual([]);
  });

  it("register (legacy audio-call presence) does not broadcast the socket→name map", async () => {
    const { connect, broadcasts } = await buildHarness();
    const a = await connect(loginToken(80011));
    await a.fire("register", "A1 Proc Buyer");
    await a.fire("disconnect");
    expect(broadcasts.map((b) => b.event)).not.toContain("userList");
  });

  it("direct messages still route to the online recipient only", async () => {
    // online_users is kept server-side for exactly this.
    const { connect, roomEmits } = await buildHarness();
    const a = await connect(loginToken(80011));
    const b = await connect(loginToken(80016));
    await a.fire("addNewUser");
    await b.fire("addNewUser");
    await a.fire("sendMessage", { recipientId: 80016, text: "hi" });
    expect(roomEmits.filter((e) => e.event === "getMessage").map((e) => e.room)).toEqual([b.socket.id]);
  });
});
