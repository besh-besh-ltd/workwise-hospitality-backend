import { createLogger, format, transports } from 'winston';
import expressWinston from 'express-winston';
import 'winston-daily-rotate-file';

const logger = createLogger({
  transports: [
    new transports.Console({
      format: format.combine(format.json())
    }),
    new transports.DailyRotateFile({
      level: 'warn',
      filename: './app/storage/logs/logsWarnings.log',
      maxFiles: 10
    }),
    new transports.DailyRotateFile({
      level: 'error',
      filename: './app/storage/logs/logsErrors.log',
      maxFiles: 10
    })
  ],
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.json(),
    format.metadata()
    //format.prettyPrint()
  ),
  responseWhitelist: ['body'],
  requestWhitelist: ['body'],
  exitOnError: false
});

// Normal errors and warnings will be logged
const winstonLogger = expressWinston.logger({
  winstonInstance: logger,
  statusLevels: true,
  dynamicMeta: (req, res) => {
    const httpRequest = {};
    const meta = {};
    if (req) {
      meta.httpRequest = httpRequest;
      httpRequest.requestMethod = req.method;
      httpRequest.requestUrl = `${req.protocol}://${req.get('host')}${
        req.originalUrl
      }`;
      httpRequest.body = req.body;
      httpRequest.protocol = `HTTP/${req.httpVersion}`;
      // httpRequest.remoteIp = req.ip // this includes both ipv6 and ipv4 addresses separated by ':'
      httpRequest.remoteIp =
        req.ip.indexOf(':') >= 0
          ? req.ip.substring(req.ip.lastIndexOf(':') + 1)
          : req.ip; // just ipv4
      httpRequest.requestSize = req.socket.bytesRead;
      httpRequest.userAgent = req.get('User-Agent');
      httpRequest.referrer = req.get('Referrer');
    }

    if (res) {
      meta.httpRequest = httpRequest;
      httpRequest.status = res.statusCode;
      httpRequest.latency = {
        seconds: Math.floor(res.responseTime / 1000),
        nanos: (res.responseTime % 1000) * 1000000
      };
      if (res.body) {
        httpRequest.body = res.body;
        if (typeof res.body === 'object') {
          httpRequest.responseSize = JSON.stringify(res.body).length;
        } else if (typeof res.body === 'string') {
          httpRequest.responseSize = res.body.length;
        }
      }
    }
    return meta;
  }
});

// Internal errors will be logged
const myFormat = format.printf(({ level, meta, timestamp }) => {
  return `${timestamp} ${level}: ${meta.message}`;
});

const winstonInternalErrorLogger = expressWinston.errorLogger({
  transports: [
    new transports.File({
      filename: './app/storage/logs/logsInternalErrors.log'
    })
  ],
  format: format.combine(
    format.json(),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    myFormat
  )
});

export { winstonLogger, winstonInternalErrorLogger, logger };
