import pino from 'pino';
import pinoHttp from 'pino-http';

const isDev = ['development', 'uat'].includes(process.env.NODE_ENV);

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
  transport: isDev ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname,trace_id,span_id,trace_flags',
    }
  } : undefined,
});

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
