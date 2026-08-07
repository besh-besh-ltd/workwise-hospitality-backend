import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import Cryptr from 'cryptr';
import Config from '../config/app.config.js';
import { logger } from './logger.js';

let ioInstance = null;
const cryptr = new Cryptr(Config.cryptR.secret);

/**
 * Pull the user id out of a login JWT, the same way passport's `jwtUsr`
 * strategy does.
 *
 * This is subtle and was wrong: the app's tokens carry `user: true` as a
 * *boolean flag* and keep the real id encrypted in `sub`. Reading
 * `payload.user` therefore yielded `true` for every genuine token, so every
 * socket joined the room literally named `user:true` while `emitToUser(80011)`
 * published to `user:80011`. Nothing ever matched — which is why the real-time
 * channel appeared to work (sockets connected, events emitted) while never
 * delivering anything, and why the unauthenticated `addNewUser` join was the
 * only thing that had ever put a client in the right room.
 *
 * The numeric fallbacks are kept for any non-login token shape.
 */
const resolveUserIdFromPayload = (payload) => {
  if (payload?.sub) {
    try {
      const decrypted = Number(cryptr.decrypt(payload.sub));
      if (Number.isInteger(decrypted) && decrypted > 0) return decrypted;
    } catch (_) {
      // Not an encrypted id — fall through to the numeric shapes below.
    }
  }
  for (const candidate of [payload?.id, payload?.userId, payload?.user]) {
    const n = Number(candidate);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
};

export const getIo = () => ioInstance;

export const emitToUser = (userId, event, payload) => {
  if (!ioInstance || userId == null) return;
  ioInstance.to(`user:${userId}`).emit(event, payload);
};

export const SocketConfig = (SERVER) => {
  // socket.io expects `cors: { origin: [...] }`; a bare array is ignored, so
  // this option silently did nothing and the permissive default applied.
  const io = new Server(SERVER, {
    cors: {
      origin: (
        process.env.SOCKET_CORS_ORIGINS ||
        [process.env.FRONT_END_WEBSITE, 'https://hospitality.letsworkwise.com']
          .filter(Boolean)
          .join(',')
      )
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      credentials: true
    }
  });
  ioInstance = io;
  let online_users = [];
  let users = {}

  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');

    if (!token) return next();

    jwt.verify(token, Config.jwt.secret, (err, payload) => {
      if (err || !payload) return next();
      const uid = resolveUserIdFromPayload(payload);
      if (uid) {
        socket.userId = uid;
        socket.join(`user:${uid}`);
      }
      next();
    });
  });

  io.on('connection', (socket) => {

   // audio call
    socket.on('register', (username) => {
      users[socket.id] = username;
      io.emit('userList', users); // Broadcast updated user list
    });

    socket.on('disconnect', () => {
      logger.debug({ socketId: socket.id }, 'Client disconnected');
      delete users[socket.id];
      io.emit('userList', users); // Broadcast updated user list
    });

    // Handle signaling data
    socket.on('signal', (data) => {
      logger.debug({ data }, 'Signal received');
      io.to(data.to).emit('signal', data);
    });

    // Handle events from clients
    //
    // SECURITY: the room to join comes from the verified handshake token, never
    // from the payload. This used to `socket.join('user:' + userId)` with the
    // client-supplied id, so any connected socket could subscribe to any user's
    // `notification:new` stream simply by naming them.
    socket.on('addNewUser', () => {
      const userId = socket.userId;
      if (userId == null) return;

      !online_users.some((user) => user.userId === userId) &&
        online_users.push({
          userId,
          socketId: socket.id
        });

      socket.join(`user:${userId}`);

      logger.debug({ online_users }, 'Online users updated');
      io.emit('getOnlineUsers', online_users);
    });

    // add new message
    socket.on('sendMessage', (message) => {

      const user = online_users.find((user)=>parseInt(user.userId) === parseInt(message.recipientId))
      if(user){
        io.to(user.socketId).emit('getMessage',message)
        io.to(user.socketId).emit('getNotification',message)
      }
    });

    // Typing
    socket.on('typing', (message) => {

      const user = online_users.find((user)=>parseInt(user.userId) === parseInt(message.recipientId))
      if(user){
        io.to(user.socketId).emit('getTyping',message)
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      online_users = online_users.filter((user) => user.socketId != socket.id);
      io.emit('getOnlineUsers', online_users);
    });
  });
};
