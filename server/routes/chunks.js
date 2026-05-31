/**
 * Chunk ingestion endpoint.
 *
 * Frontend MediaRecorder fires every 5s with a Blob — we POST it here as multipart/form-data.
 *
 *   field: file        (the binary chunk)
 *   field: questionIndex (number)
 *   field: chunkIndex    (number)
 *
 * Determinism:
 *   key = `${sessionId}/${questionIndex}/chunk_${zeroPad3(chunkIndex)}.webm`
 *
 * Guards:
 *   - reject if session locked / not found
 *   - reject if chunk size < 100 bytes (empty chunk guard)
 *   - idempotent — re-uploading same (questionIndex, chunkIndex) overwrites S3 + updates Mongo entry
 */
const express = require('express');
const multer = require('multer');
const { InterviewSession } = require('../models');
const { putObject } = require('../utils/s3');
const logger = require('../utils/logger');

const router = express.Router();

const MAX_BYTES = Number(process.env.CHUNK_MAX_BYTES) || 20 * 1024 * 1024; // 20MB hard ceiling
// [BUG-chunks] Was 100. MediaRecorder continuation chunks (chunk_001+) can be
// legitimately small (a few hundred bytes of Cluster data) during quiet moments.
// Dropping them as "empty" was causing gaps in the merged video. Only reject
// truly zero-byte uploads.
const MIN_BYTES = 1;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES }
});

function pad3(n) {
  return String(n).padStart(3, '0');
}

router.post('/:token', upload.single('file'), async (req, res) => {
  const { token } = req.params;
  const file = req.file;
  const questionIndex = Number(req.body.questionIndex);
  const chunkIndex = Number(req.body.chunkIndex);

  if (!file) return res.status(400).json({ error: 'missing_file' });
  if (Number.isNaN(questionIndex) || Number.isNaN(chunkIndex)) {
    return res.status(400).json({ error: 'bad_indices' });
  }

  // Empty chunk guard — drop silently with 204 so client doesn't retry forever.
  if (file.size < MIN_BYTES) {
    logger.info('chunk_skipped_empty', { token, questionIndex, chunkIndex, size: file.size });
    return res.status(204).end();
  }

  const session = await InterviewSession.findOne({ token });
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.isLocked) return res.status(409).json({ error: 'session_locked' });

  const s3Key = `${session._id.toString()}/${questionIndex}/chunk_${pad3(chunkIndex)}.webm`;

  try {
    await putObject({
      key: s3Key,
      body: file.buffer,
      contentType: file.mimetype || 'video/webm'
    });
  } catch (err) {
    logger.error('chunk_upload_failed', {
      token,
      questionIndex,
      chunkIndex,
      err: err.message
    });
    return res.status(502).json({ error: 'upload_failed' });
  }

  // Upsert the chunk reference on the session (idempotent on (questionIndex, chunkIndex)).
  const existingIdx = session.uploadedChunks.findIndex(
    (c) => c.questionIndex === questionIndex && c.chunkIndex === chunkIndex
  );
  if (existingIdx >= 0) {
    session.uploadedChunks[existingIdx].s3Key = s3Key;
    session.uploadedChunks[existingIdx].size = file.size;
    session.uploadedChunks[existingIdx].uploadedAt = new Date();
  } else {
    session.uploadedChunks.push({
      questionIndex,
      chunkIndex,
      s3Key,
      size: file.size,
      uploadedAt: new Date()
    });
  }
  await session.save();

  logger.info('chunk_uploaded', {
    sessionId: session._id.toString(),
    questionIndex,
    chunkIndex,
    size: file.size,
    s3Key
  });

  res.json({ ok: true, s3Key });
});

module.exports = router;
