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
  const io = new Server(SERVER, { cors: ['https://letsworkwise.com'] });
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
    socket.on('addNewUser', (userId) => {
      !online_users.some((user) => user.userId === userId) &&
        online_users.push({
          userId,
          socketId: socket.id
        });

      if (userId != null) {
        socket.join(`user:${userId}`);
      }

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
