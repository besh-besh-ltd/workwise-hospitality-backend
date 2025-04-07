/* eslint-disable no-console */
import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import util from './app/util/index.js';
import { consoleLogData } from './app/helper/common.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { SocketConfig } from './app/util/socket.js';
const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);


// env config
dotenv.config();

// Initialize app
const app = express();
app.use(express.static(path.join(__dirname, '/app/uploads')));
util(app);

// Create server
const server = http.createServer(app);

SocketConfig(server)

/**
 * @description Server listen
 */
const PORT = process.env.PORT || 3200;
server.listen(PORT);
server.on('error', onError);
server.on('listening', onListening);

/**
 * Event listener for HTTP server "error" event.
 */
function onError(error) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  var bind = typeof PORT === 'string' ? 'Pipe ' + PORT : 'Port ' + PORT;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */
function onListening() {
  var addr = server.address();
  var bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
  consoleLogData('Listening on :: ' + bind);
}
