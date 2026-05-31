/**
 * BullMQ runner for the processing queue.
 *
 * Used when QUEUE_DRIVER=bullmq (dev default). This file is just the
 * BullMQ-specific wiring; ALL business logic lives in ./handler.js and is
 * shared verbatim with the Lambda wrapper at server/lambda/processor/index.js.
 *
 * Run with:  npm run worker        (or:  node server/workers/processor.js)
 */
require('dotenv').config();

const { Worker } = require('bullmq');
const { buildConnection, QUEUE_NAME } = require('../config/queue');
const { connectDB } = require('../config/db');
const { InterviewSession } = require('../models');
const logger = require('../utils/logger');
const { handleJob, checkFfmpeg } = require('./handler');

async function start() {
  checkFfmpeg();
  await connectDB();

  const connection = buildConnection();

  const worker = new Worker(QUEUE_NAME, handleJob, {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY) || 2,
    lockDuration: 5 * 60 * 1000
  });

  worker.on('failed', async (job, err) => {
    logger.error('worker_job_failed', { jobId: job?.id, err: err.message });
    if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
      try {
        await InterviewSession.findByIdAndUpdate(job.data.sessionId, { $set: { status: 'failed' } });
      } catch (_) { }
    }
  });

  worker.on('ready', () => logger.info('worker_ready', { queue: QUEUE_NAME, driver: 'bullmq' }));
  worker.on('error', (err) => logger.error('worker_error', { err: err.message }));

  process.on('SIGTERM', async () => {
    logger.info('worker_shutdown_signal');
    await worker.close();
    process.exit(0);
  });
}

start().catch((err) => {
  logger.error('worker_boot_error', { err: err.message, stack: err.stack });
  process.exit(1);
});
