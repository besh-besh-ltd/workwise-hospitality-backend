import { Server } from 'socket.io';

export const SocketConfig = (SERVER) => {
  const io = new Server(SERVER, { cors: ['http://143.110.242.57:8111'] });
  let online_users = [];
  let users = {}

  io.on('connection', (socket) => {

   // audio call
    socket.on('register', (username) => {
      users[socket.id] = username;
      io.emit('userList', users); // Broadcast updated user list
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected', socket.id);
      delete users[socket.id];
      io.emit('userList', users); // Broadcast updated user list
    });

    // Handle signaling data
    socket.on('signal', (data) => {
      console.log('Signal received:', data);
      io.to(data.to).emit('signal', data);
    });

    // Handle events from clients
    socket.on('addNewUser', (userId) => {
      !online_users.some((user) => user.userId === userId) &&
        online_users.push({
          userId,
          socketId: socket.id
        });

      console.log(online_users);
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
