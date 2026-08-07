import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import Config from '../config/app.config.js';
import { logger } from './logger.js';

let ioInstance = null;

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
      const uid = payload.user || payload.id || payload.userId;
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
