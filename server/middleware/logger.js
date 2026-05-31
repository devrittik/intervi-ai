const logger = require('../utils/logger');

/**
 * HTTP access logger. Logs method/path/status/duration/requestId.
 * Skips noisy heartbeat/health routes.
 */
module.exports = function httpLogger(req, res, next) {
  const start = Date.now();
  const skip = req.path === '/health' || req.path === '/api/health';

  res.on('finish', () => {
    if (skip) return;
    const durationMs = Date.now() - start;
    const log = logger.withCtx({ requestId: req.requestId });
    const meta = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
      ip: req.ip
    };
    if (res.statusCode >= 500) log.error('http_request', meta);
    else if (res.statusCode >= 400) log.warn('http_request', meta);
    else log.info('http_request', meta);
  });

  next();
};
