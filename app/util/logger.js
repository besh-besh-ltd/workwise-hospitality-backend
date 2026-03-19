import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const isDev = ['development', 'uat'].includes(process.env.NODE_ENV);

// Map Pino numeric levels to OTel SeverityNumber
const pinoLevelToOTel = {
  10: SeverityNumber.TRACE,   // trace
  20: SeverityNumber.DEBUG,   // debug
  30: SeverityNumber.INFO,    // info
  40: SeverityNumber.WARN,    // warn
  50: SeverityNumber.ERROR,   // error
  60: SeverityNumber.FATAL,   // fatal
};

const pinoLevelToName = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/**
 * Writable stream that forwards every Pino log record to the
 * OTel Logs SDK — the same role @opentelemetry/winston-transport
 * played for Winston.  Runs in-process (no worker thread), so the
 * OTel LoggerProvider registered by sdk.start() is always reachable.
 */
class OTelStream extends Writable {
  constructor() {
    super();
    this._otelLogger = logs.getLogger('pino');
  }

  _write(chunk, _encoding, callback) {
    try {
      const record = JSON.parse(chunk.toString());
      const { level, time, msg, pid, hostname, ...attributes } = record;

      this._otelLogger.emit({
        severityNumber: pinoLevelToOTel[level] ?? SeverityNumber.INFO,
        severityText: pinoLevelToName[level] ?? 'INFO',
        body: msg,
        timestamp: time ? new Date(time) : undefined,
        attributes,
      });
    } catch {
      // Don't break logging if OTel emission fails
    }
    callback();
  }
}

const cleanIP = (req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '-';
  return ip.replace(/^::ffff:/, '');
};

const getPath = (req) => {
  const url = req.originalUrl || req.url || '/';
  return url.split('?')[0];
};

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  timestamp: pino.stdTimeFunctions.isoTime,
}, pino.multistream([
  { level: 0, stream: process.stdout },
  { level: 0, stream: new OTelStream() },
]));

const httpLogger = pinoHttp({
  logger,
  autoLogging: true,
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res, responseTime) => {
    const ip = cleanIP(req);
    return `${req.method} ${getPath(req)} (${res.statusCode}) / ${Math.round(responseTime)}ms / IP: ${ip}`;
  },
  customErrorMessage: (req, res, err) => {
    const ip = cleanIP(req);
    return `${req.method} ${getPath(req)} (${res.statusCode}) / IP: ${ip} - ${err.message}`;
  },
  serializers: {
    req: (req) => isDev ? {
      method: req.method,
      query: Object.keys(req.query || {}).length ? req.query : undefined,
    } : undefined,
    res: () => undefined,
  },
});

export { logger, httpLogger };
