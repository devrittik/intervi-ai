const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

/**
 * JWT auth middleware for recruiter routes.
 * Token comes from Authorization: Bearer <jwt>.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (err) {
    logger.warn('auth_invalid_token', { requestId: req.requestId, reason: err.message });
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

module.exports = { requireAuth, signToken };
