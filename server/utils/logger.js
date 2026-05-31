/**
 * Winston logger.
 * - Dev: colorized console.
 * - Prod: JSON one-line-per-log for log aggregators (CloudWatch / Loki / Datadog).
 * - Every log line is structured; callers pass an object (sessionId, requestId, etc).
 */
const winston = require('winston');

const isProd = process.env.NODE_ENV === 'production';

const baseFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true })
);

const devFormat = winston.format.combine(
  baseFormat,
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const m = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} ${message}${m}`;
  })
);

const prodFormat = winston.format.combine(baseFormat, winston.format.json());

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: isProd ? prodFormat : devFormat,
  transports: [new winston.transports.Console()]
});

/**
 * Create a child logger pre-bound with context (requestId/sessionId/etc).
 * Usage: const log = logger.child({ requestId, sessionId });
 */
logger.withCtx = (ctx) => logger.child(ctx);

module.exports = logger;
