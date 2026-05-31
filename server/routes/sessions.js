/**
 * Candidate-facing session routes — keyed by UUID token (no auth, but
 * the token itself is the credential and is validated on every call).
 *
 * IMPORTANT: every route validates the token and refuses if isLocked.
 *
 * - GET    /api/sessions/:token          → boot data for the interview page
 * - POST   /api/sessions/:token/status   → status transitions (in_progress, completed)
 * - POST   /api/sessions/:token/answer   → save transcript/score/feedback per question
 * - POST   /api/sessions/:token/proctor  → ingest proctoring events from REST fallback
 */
const express = require('express');
const { InterviewSession, InterviewTemplate, ProctoringEvent } = require('../models');
// [queue-driver] Replaced the direct BullMQ import with the driver-agnostic
// publisher. Same API surface as before — sessions.js neither knows nor cares
// whether the message is going to Upstash Redis or AWS SQS.
const { publishProcessing, driver: QUEUE_DRIVER } = require('../services/queuePublisher');
const logger = require('../utils/logger');

const router = express.Router();

async function loadSession(req, res, next) {
  const { token } = req.params;
  const session = await InterviewSession.findOne({ token });
  if (!session) {
    logger.warn('session_not_found', { requestId: req.requestId, token });
    return res.status(404).json({ error: 'session_not_found' });
  }
  if (session.expiresAt && session.expiresAt < new Date()) {
    return res.status(410).json({ error: 'session_expired' });
  }
  req.session = session;
  next();
}

/* ---------- GET — boot data ---------- */
router.get('/:token', loadSession, async (req, res) => {
  const session = req.session;
  const template = await InterviewTemplate.findById(session.templateId).lean();
  if (!template) return res.status(500).json({ error: 'template_missing' });

  res.json({
    token: session.token,
    isLocked: session.isLocked,
    status: session.status,
    candidateName: session.candidateName,
    currentQuestionIndex: session.currentQuestionIndex,
    answeredQuestions: session.answeredQuestions,
    template: {
      title: template.title,
      role: template.role,
      questions: template.questions.map((q) => ({
        index: q.index,
        text: q.text,
        thinkingTime: q.thinkingTime,
        answerTime: q.answerTime
      }))
    }
  });
});

/* ---------- POST — status change ---------- */
router.post('/:token/status', loadSession, async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['in_progress', 'completed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'bad_status' });

  const s = req.session;

  if (s.isLocked) {
    logger.warn('session_locked_status_change_rejected', { sessionId: s._id.toString() });
    return res.status(409).json({ error: 'session_locked' });
  }

  if (status === 'in_progress') {
    s.status = 'in_progress';
    await s.save();
    logger.info('session_status_changed', { sessionId: s._id.toString(), status });
    return res.json({ ok: true, status: s.status });
  }

  if (status === 'completed') {
    // [BUG4] Confirm we entered the completion branch.
    console.log('[BUG4] /api/sessions/:token/status received status=completed', {
      sessionId: s._id.toString(),
      token: req.params.token
    });

    // Atomic transition: completed + locked together. Idempotent guard via findOneAndUpdate.
    const updated = await InterviewSession.findOneAndUpdate(
      { _id: s._id, isLocked: false },
      {
        $set: {
          status: 'processing', // worker will move it to "done"
          isLocked: true,
          completedAt: new Date()
        }
      },
      { new: true }
    );
    if (!updated) {
      console.warn('[BUG4] status=completed rejected — session already locked', { sessionId: s._id.toString() });
      return res.status(409).json({ error: 'already_locked' });
    }

    logger.info('session_locked', { sessionId: updated._id.toString(), status: updated.status });
    console.log('[BUG4] session locked + status=processing — enqueueing worker job', { sessionId: updated._id.toString() });

    // Enqueue processing job (FFmpeg merge only — Groq is handled live by Voice Agent proxy).
    // The publisher routes to BullMQ or SQS depending on QUEUE_DRIVER.
    let jobId = null;
    try {
      const result = await publishProcessing({ sessionId: updated._id.toString() });
      jobId = result.id;
      console.log('[BUG4] worker job enqueued', {
        sessionId: updated._id.toString(), jobId, driver: result.driver
      });
    } catch (err) {
      console.error('[BUG4] failed to enqueue worker job', {
        sessionId: updated._id.toString(), driver: QUEUE_DRIVER, err: err.message
      });
      // We still return 200 — the lock has been set; an admin can re-enqueue later.
    }

    return res.json({
      ok: true,
      status: updated.status,
      isLocked: true,
      jobId,
      session: {
        id: updated._id,
        status: updated.status,
        isLocked: updated.isLocked,
        completedAt: updated.completedAt
      }
    });
  }
});

/* ---------- POST — save per-question answer (transcript + AI score) ---------- */
router.post('/:token/answer', loadSession, async (req, res) => {
  const s = req.session;
  if (s.isLocked) return res.status(409).json({ error: 'session_locked' });

  const { questionIndex, transcript, aiScore, aiFeedback, spokenReview } = req.body || {};
  if (typeof questionIndex !== 'number') return res.status(400).json({ error: 'bad_questionIndex' });

  const existing = s.answers.find((a) => a.questionIndex === questionIndex);
  if (existing) {
    existing.transcript = transcript ?? existing.transcript;
    existing.aiScore = aiScore ?? existing.aiScore;
    existing.aiFeedback = aiFeedback ?? existing.aiFeedback;
    existing.spokenReview = spokenReview ?? existing.spokenReview;
  } else {
    s.answers.push({
      questionIndex,
      transcript: transcript || '',
      aiScore: aiScore ?? null,
      aiFeedback: aiFeedback || '',
      spokenReview: spokenReview || ''
    });
  }

  if (!s.answeredQuestions.includes(questionIndex)) {
    s.answeredQuestions.push(questionIndex);
  }
  s.currentQuestionIndex = Math.max(s.currentQuestionIndex, questionIndex + 1);
  await s.save();

  logger.info('answer_saved', {
    sessionId: s._id.toString(),
    questionIndex,
    transcriptLen: (transcript || '').length,
    aiScore
  });

  res.json({ ok: true });
});

/* ---------- POST — per-question Groq review (called mid-interview) ---------- */
let _groqClient = null;
async function getGroq() {
  if (_groqClient) return _groqClient;
  const mod = await import('groq-sdk');
  const Groq = mod.default || mod.Groq || mod;
  _groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groqClient;
}

router.post('/:token/answer/review', loadSession, async (req, res) => {
  const s = req.session;
  if (s.isLocked) return res.status(409).json({ error: 'session_locked' });

  const { questionIndex, questionText, transcript } = req.body || {};
  if (typeof questionIndex !== 'number' || !questionText) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  let aiScore = null;
  let aiFeedback = '';
  let spokenReview = '';

  if (!transcript || transcript.trim().length < 3) {
    // [polish-ack] Keep this short too — no transition phrase, the app handles that.
    spokenReview = "Got it.";
    aiFeedback = "No usable transcript captured.";
    aiScore = 0;
  } else {
    // Two parallel Groq calls: score+brief feedback, and spoken review.
    try {
      const groq = await getGroq();
      const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

      const [scoreResp, spokenResp] = await Promise.all([
        groq.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You evaluate interview answers. Reply ONLY as compact JSON: ' +
                '{"score": <int 0-100>, "feedback": "<exactly two sentences>"}.'
            },
            {
              role: 'user',
              content: `Question: ${questionText}\nCandidate answer transcript: ${transcript}\n\nScore 0-100 and give a two-sentence feedback.`
            }
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        }),
        groq.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content:
                // [polish-ack] Mimic a real human interviewer: a quick acknowledgement,
                // optionally one short improvement, then nothing else. No follow-up
                // questions, no "let's move on" filler — the app handles transitions.
                'You are a human interviewer giving a VERY brief verbal acknowledgement ' +
                'after the candidate answers. Strict rules:\n' +
                ' - 1 sentence ideal, 2 sentences MAXIMUM (≤ 15 words total).\n' +
                ' - Start with a brief acknowledgement ("Got it.", "Thanks.", "Makes sense.", "Noted.").\n' +
                ' - Optionally add ONE concrete improvement hint, only if clearly warranted.\n' +
                ' - NEVER ask a follow-up question.\n' +
                ' - NEVER say "let\'s move on", "next question", "next up", or any transition phrase.\n' +
                ' - NEVER restate the question or summarise the answer.\n' +
                ' - Tone: warm, neutral, professional. No exclamation marks.\n' +
                'Reply with the spoken text ONLY — no quotes, no preamble.'
            },
            {
              role: 'user',
              content:
                `Question: ${questionText}\nCandidate answer transcript: ${transcript}\n\n` +
                `Give the acknowledgement now.`
            }
          ],
          temperature: 0.3,
          max_tokens: 60
        })
      ]);

      const parsed = JSON.parse(scoreResp.choices?.[0]?.message?.content || '{}');
      aiScore = Math.max(0, Math.min(100, Number(parsed.score) || 0));
      aiFeedback = String(parsed.feedback || '').slice(0, 1000);
      spokenReview = (spokenResp.choices?.[0]?.message?.content || '').trim();
    } catch (err) {
      logger.error('groq_review_failed', { sessionId: s._id.toString(), err: err.message });
      // [polish-ack] One word — no transition phrase.
      spokenReview = "Got it.";
    }
  }

  // Save onto session.
  const existing = s.answers.find((a) => a.questionIndex === questionIndex);
  if (existing) {
    existing.transcript = transcript || existing.transcript;
    existing.aiScore = aiScore;
    existing.aiFeedback = aiFeedback;
    existing.spokenReview = spokenReview;
  } else {
    s.answers.push({ questionIndex, transcript: transcript || '', aiScore, aiFeedback, spokenReview });
  }
  if (!s.answeredQuestions.includes(questionIndex)) s.answeredQuestions.push(questionIndex);
  s.currentQuestionIndex = Math.max(s.currentQuestionIndex, questionIndex + 1);
  await s.save();

  logger.info('groq_per_question_complete', {
    sessionId: s._id.toString(),
    questionIndex,
    aiScore
  });

  res.json({ aiScore, aiFeedback, spokenReview });
});

/* ---------- POST — REST fallback for proctoring (if socket dies) ---------- */
router.post('/:token/proctor', loadSession, async (req, res) => {
  const s = req.session;
  const { type, questionIndex, metadata } = req.body || {};
  if (!type) return res.status(400).json({ error: 'missing_type' });

  await ProctoringEvent.create({
    sessionId: s._id,
    type,
    questionIndex: typeof questionIndex === 'number' ? questionIndex : null,
    metadata: metadata || {}
  });
  logger.info('proctoring_event_rest', {
    sessionId: s._id.toString(),
    type,
    questionIndex
  });
  res.json({ ok: true });
});

module.exports = router;
