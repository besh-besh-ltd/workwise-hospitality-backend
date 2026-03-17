import { createLogger, format, transports } from 'winston';
import expressWinston from 'express-winston';
import 'winston-daily-rotate-file';
import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport';

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
    }),
    new OpenTelemetryTransportV3(),
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

/**
 * @lastUpdated 13-06-2025 mukul jatav
 * @description use to create dynamic meta, not not able to create then throw error and create static meta
 */
// Safe and resilient express-winston logger configuration
const winstonLogger = expressWinston.logger({
  winstonInstance: logger,
  statusLevels: true,
  dynamicMeta: (req, res) => {
    const meta = {};
    const httpRequest = {};

    try {
      if (req && typeof req === 'object') {
        meta.httpRequest = httpRequest;

        httpRequest.requestMethod = req.method || 'UNKNOWN';

        try {
          const host = req.get?.('host') || 'unknown-host';
          const url = req.originalUrl || '';
          const protocol = req.protocol || 'http';
          httpRequest.requestUrl = `${protocol}://${host}${url}`;
        } catch {
          httpRequest.requestUrl = 'unknown';
        }

        httpRequest.body = req.body || {};
        httpRequest.protocol = `HTTP/${req.httpVersion || '1.1'}`;

        if (typeof req.ip === 'string') {
          httpRequest.remoteIp = req.ip.includes(':')
            ? req.ip.substring(req.ip.lastIndexOf(':') + 1)
            : req.ip;
        } else {
          httpRequest.remoteIp = 'unknown';
        }

        httpRequest.requestSize = req?.socket?.bytesRead || 0;
        httpRequest.userAgent = req.get?.('User-Agent') || 'unknown';
        httpRequest.referrer = req.get?.('Referrer') || 'unknown';
      }

      if (res && typeof res === 'object') {
        meta.httpRequest = httpRequest;
        httpRequest.status = res.statusCode || 500;

        if (typeof res.responseTime === 'number') {
          httpRequest.latency = {
            seconds: Math.floor(res.responseTime / 1000),
            nanos: (res.responseTime % 1000) * 1_000_000,
          };
        }

        if (res.body) {
          httpRequest.body = res.body;
          try {
            httpRequest.responseSize =
              typeof res.body === 'object'
                ? JSON.stringify(res.body).length
                : String(res.body).length;
          } catch {
            httpRequest.responseSize = 0;
          }
        }
      }
    } catch (err) {
      meta.error = 'Failed to generate dynamicMeta';
      meta.errorMessage = err.message;
      meta.stack = err.stack;
    }

    return meta;
  },
});

// Internal errors will be logged
const myFormat = format.printf(({ level, meta, timestamp }) => {
  return `${timestamp} ${level}: ${meta?.message}`;
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
