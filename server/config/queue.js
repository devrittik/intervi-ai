/**
 * BullMQ queue + Redis connection (Upstash compatible).
 *
 * IMPORTANT: This module is now *lazy*. Importing it does NOT connect to Redis.
 * That matters because when QUEUE_DRIVER=sqs (Lambda, or local SQS mode) we
 * don't want the API process to crash because REDIS_URL isn't set.
 *
 * Use:
 *   const { getProcessingQueue, QUEUE_NAME } = require('./config/queue');
 *   const q = getProcessingQueue();              // connects on first call
 *
 * The BullMQ worker (server/workers/processor.js) still imports buildConnection()
 * directly because it always needs Redis when it's running.
 *
 * Upstash requires TLS (`rediss://`) — ioredis handles that from the URL.
 */
const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const logger = require('../utils/logger');

const QUEUE_NAME = 'interview-processing';

let _connection = null;
let _processingQueue = null;
let _queueEvents = null;

function buildConnection() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required for the BullMQ driver');
  // BullMQ requires maxRetriesPerRequest: null and enableReadyCheck: false
  // on connections used by Worker. Reusing the same options for the publisher
  // is fine.
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false
  });
}

function getSharedConnection() {
  if (_connection) return _connection;
  _connection = buildConnection();
  _connection.on('error', (err) => logger.error('redis_error', { err: err.message }));
  _connection.on('connect', () => logger.info('redis_connected'));
  return _connection;
}

/**
 * Lazily construct + return the publisher-side Queue handle. Safe to call many
 * times — same instance is reused.
 */
function getProcessingQueue() {
  if (_processingQueue) return _processingQueue;
  _processingQueue = new Queue(QUEUE_NAME, { connection: getSharedConnection() });

  // Wire QueueEvents once for observability. Uses its own connection per BullMQ docs.
  if (!_queueEvents) {
    _queueEvents = new QueueEvents(QUEUE_NAME, { connection: buildConnection() });
    _queueEvents.on('completed', ({ jobId }) => logger.info('queue_job_completed', { jobId }));
    _queueEvents.on('failed', ({ jobId, failedReason }) =>
      logger.error('queue_job_failed', { jobId, failedReason })
    );
  }
  return _processingQueue;
}

module.exports = {
  QUEUE_NAME,
  buildConnection,
  getProcessingQueue
};
