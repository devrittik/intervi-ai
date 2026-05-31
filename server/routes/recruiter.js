/**
 * Recruiter dashboard API (all JWT-protected).
 *
 *   GET    /api/recruiter/stats                       — aggregate stats for dashboard header
 *   GET    /api/recruiter/sessions                    — list (optional ?status= filter)
 *   GET    /api/recruiter/sessions/:id                — full session detail (incl. presigned URLs)
 *   POST   /api/recruiter/templates                   — create template
 *   GET    /api/recruiter/templates                   — list my templates
 *   POST   /api/recruiter/sessions                    — create interview from template
 */
const express = require('express');
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const {
  InterviewTemplate,
  InterviewSession,
  ProctoringEvent
} = require('../models');
const { presignGet } = require('../utils/s3');
const logger = require('../utils/logger');

const router = express.Router();
router.use(requireAuth);

/* ---------- stats ---------- */
router.get('/stats', async (req, res) => {
  const userId = req.user.id;
  const myTemplateIds = await InterviewTemplate.find({ createdBy: userId }).distinct('_id');

  const [total, completed, inProgress, doneSessions] = await Promise.all([
    InterviewSession.countDocuments({ templateId: { $in: myTemplateIds } }),
    InterviewSession.countDocuments({
      templateId: { $in: myTemplateIds },
      status: { $in: ['completed', 'done', 'processing'] }
    }),
    InterviewSession.countDocuments({ templateId: { $in: myTemplateIds }, status: 'in_progress' }),
    InterviewSession.find({ templateId: { $in: myTemplateIds }, status: 'done' })
      .select('overallScore')
      .lean()
  ]);

  const scores = doneSessions.map((s) => s.overallScore).filter((n) => typeof n === 'number');
  const avgScore = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : null;

  res.json({ total, completed, inProgress, avgScore });
});

/* ---------- list sessions ---------- */
router.get('/sessions', async (req, res) => {
  const userId = req.user.id;
  const myTemplateIds = await InterviewTemplate.find({ createdBy: userId }).distinct('_id');

  const q = { templateId: { $in: myTemplateIds } };
  if (req.query.status && req.query.status !== 'all') q.status = req.query.status;

  const sessions = await InterviewSession.find(q)
    .sort({ createdAt: -1 })
    .limit(200)
    .populate('templateId', 'title role')
    .lean();

  const ids = sessions.map((s) => s._id);
  // flag counts grouped per session
  const flagAgg = await ProctoringEvent.aggregate([
    { $match: { sessionId: { $in: ids } } },
    { $group: { _id: '$sessionId', count: { $sum: 1 } } }
  ]);
  const flagMap = new Map(flagAgg.map((f) => [String(f._id), f.count]));

  res.json(
    sessions.map((s) => ({
      id: s._id,
      candidateName: s.candidateName,
      candidateEmail: s.candidateEmail,
      role: s.templateId?.role,
      templateTitle: s.templateId?.title,
      status: s.status,
      overallScore: s.overallScore,
      flagCount: flagMap.get(String(s._id)) || 0,
      createdAt: s.createdAt,
      token: s.token,
      isLocked: s.isLocked
    }))
  );
});

/* ---------- session detail ---------- */
router.get('/sessions/:id', async (req, res) => {
  const userId = req.user.id;
  const session = await InterviewSession.findById(req.params.id).lean();
  if (!session) return res.status(404).json({ error: 'not_found' });

  const template = await InterviewTemplate.findById(session.templateId).lean();
  if (!template) return res.status(404).json({ error: 'template_missing' });
  if (String(template.createdBy) !== String(userId)) return res.status(403).json({ error: 'forbidden' });

  // Presign merged video URLs for each answer.
  const answers = await Promise.all(
    (session.answers || []).map(async (a) => ({
      ...a,
      videoUrl: a.mergedVideoKey ? await presignGet(a.mergedVideoKey, 3600) : null,
      question: template.questions.find((q) => q.index === a.questionIndex) || null
    }))
  );

  const proctoring = await ProctoringEvent.find({ sessionId: session._id })
    .sort({ timestamp: 1 })
    .lean();

  res.json({
    id: session._id,
    candidateName: session.candidateName,
    candidateEmail: session.candidateEmail,
    status: session.status,
    isLocked: session.isLocked,
    overallScore: session.overallScore,
    overallFeedback: session.overallFeedback,
    overallStrengths: session.overallStrengths || [],
    overallWeaknesses: session.overallWeaknesses || [],
    createdAt: session.createdAt,
    completedAt: session.completedAt,
    token: session.token,
    template: { title: template.title, role: template.role, questions: template.questions },
    answers,
    proctoring
  });
});

/* ---------- templates ---------- */
router.post('/templates', async (req, res) => {
  const { title, role, questions } = req.body || {};
  if (!title || !role || !Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const normalized = questions.map((q, i) => ({
    index: i,
    text: String(q.text || '').trim(),
    thinkingTime: Number(q.thinkingTime) || 15,
    answerTime: Number(q.answerTime) || 90
  }));
  if (normalized.some((q) => !q.text)) return res.status(400).json({ error: 'question_text_required' });

  const tpl = await InterviewTemplate.create({
    createdBy: req.user.id,
    title,
    role,
    questions: normalized
  });
  logger.info('template_created', { userId: req.user.id, templateId: tpl._id.toString() });
  res.json(tpl);
});

router.get('/templates', async (req, res) => {
  const list = await InterviewTemplate.find({ createdBy: req.user.id }).sort({ createdAt: -1 }).lean();
  res.json(list);
});

/* ---------- create interview (issues UUID token / link) ---------- */
router.post('/sessions', async (req, res) => {
  const { templateId, candidateName, candidateEmail, expiresInDays } = req.body || {};
  if (!templateId || !candidateName || !candidateEmail) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const tpl = await InterviewTemplate.findById(templateId);
  if (!tpl) return res.status(404).json({ error: 'template_not_found' });
  if (String(tpl.createdBy) !== String(req.user.id)) return res.status(403).json({ error: 'forbidden' });

  const session = await InterviewSession.create({
    templateId,
    token: uuid(),
    candidateName,
    candidateEmail,
    status: 'pending',
    expiresAt: expiresInDays
      ? new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000)
      : null
  });

  const base = process.env.CLIENT_URL || 'http://localhost:5173';
  logger.info('session_created', { sessionId: session._id.toString(), templateId });

  res.json({
    id: session._id,
    token: session.token,
    link: `${base}/interview/${session.token}`,
    candidateName: session.candidateName,
    candidateEmail: session.candidateEmail,
    status: session.status,
    expiresAt: session.expiresAt
  });
});

module.exports = router;
