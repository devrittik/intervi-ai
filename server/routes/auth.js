/**
 * Recruiter auth — register + login.
 * Public; rate-limited by upstream proxy in production.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { signToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'missing_fields' });
  if (String(password).length < 8) return res.status(400).json({ error: 'weak_password' });

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    logger.warn('auth_register_duplicate', { requestId: req.requestId, email });
    return res.status(409).json({ error: 'email_in_use' });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = await User.create({ email: email.toLowerCase(), password: hash, name, role: 'recruiter' });
  const token = signToken(user);
  logger.info('auth_register', { requestId: req.requestId, email: user.email });
  res.json({ token, user: { id: user._id, email: user.email, name: user.name, role: user.role } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });

  const user = await User.findOne({ email: String(email).toLowerCase() });
  if (!user) {
    logger.warn('auth_login_no_user', { requestId: req.requestId, email });
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    logger.warn('auth_login_bad_password', { requestId: req.requestId, email });
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const token = signToken(user);
  logger.info('auth_login', { requestId: req.requestId, email: user.email });
  res.json({ token, user: { id: user._id, email: user.email, name: user.name, role: user.role } });
});

module.exports = router;
