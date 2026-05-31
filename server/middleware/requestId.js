const { v4: uuid } = require('uuid');

/**
 * Attaches a unique requestId to every request.
 * - Honors incoming `x-request-id` if the caller already supplied one.
 * - Exposes it back via response header for client-side correlation.
 */
module.exports = function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || uuid();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
};
