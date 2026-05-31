/**
 * Queue publisher — a single, driver-agnostic API for enqueueing processing jobs.
 *
 *   publishProcessing({ sessionId }) → { driver, id }
 *
 * Driver is selected at process start from `QUEUE_DRIVER`:
 *
 *   bullmq (default)  → BullMQ.add('process-session', { sessionId }) into Upstash Redis
 *   sqs               → AWS SQS SendMessage to AWS_SQS_QUEUE_URL
 *
 * Both drivers are loaded lazily so a Lambda/SQS deployment never tries to
 * require ioredis/bullmq, and a Redis-only dev box never tries to require the
 * AWS SDK. This keeps cold-start time + bundle size minimal in each environment.
 *
 * Consumers (BullMQ worker / Lambda handler) call workers/handler.js#handleJob
 * directly with the same `{ id, data, attemptsMade }` shape, so business logic
 * is identical regardless of driver.
 */
const logger = require('../utils/logger');

const DRIVER = (process.env.QUEUE_DRIVER || 'bullmq').toLowerCase();
const VALID = ['bullmq', 'sqs'];
if (!VALID.includes(DRIVER)) {
    throw new Error(`Unsupported QUEUE_DRIVER="${DRIVER}". Use one of: ${VALID.join(', ')}`);
}

/* ----------------------- BullMQ driver ----------------------- */

let _bullPublish = null;
function bullPublisher() {
    if (_bullPublish) return _bullPublish;
    // Require lazily so SQS-only deployments don't need ioredis/bullmq installed.
    const { getProcessingQueue } = require('../config/queue');
    const queue = getProcessingQueue();

    _bullPublish = async ({ sessionId }) => {
        const job = await queue.add(
            'process-session',
            { sessionId },
            {
                attempts: 5,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 500,
                removeOnFail: 1000
            }
        );
        return { driver: 'bullmq', id: job.id };
    };
    return _bullPublish;
}

/* ----------------------- SQS driver ----------------------- */

let _sqsPublish = null;
function sqsPublisher() {
    if (_sqsPublish) return _sqsPublish;

    const queueUrl = process.env.AWS_SQS_QUEUE_URL;
    if (!queueUrl) {
        throw new Error('AWS_SQS_QUEUE_URL is required when QUEUE_DRIVER=sqs');
    }

    // Lazy-load the AWS SDK so the BullMQ-only path doesn't pay the import cost.
    // eslint-disable-next-line global-require
    const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

    const region =
        process.env.AWS_SQS_REGION ||
        process.env.AWS_REGION ||
        (() => {
            // Best-effort parse: https://sqs.<region>.amazonaws.com/<acct>/<name>
            const m = queueUrl.match(/^https:\/\/sqs\.([^.]+)\.amazonaws\.com/);
            return m ? m[1] : undefined;
        })();

    const client = new SQSClient({
        region,
        credentials:
            process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
                ? {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                }
                : undefined // fall through to default credential chain (IAM role, profile, etc.)
    });

    // FIFO queues require MessageGroupId + MessageDeduplicationId. We auto-detect
    // by suffix so the same code works for standard and FIFO queues.
    const isFifo = queueUrl.endsWith('.fifo');

    _sqsPublish = async ({ sessionId }) => {
        const params = {
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({ sessionId })
        };
        if (isFifo) {
            // Group by sessionId so jobs for the same session never run in parallel;
            // dedupe on sessionId so accidental double-publishes don't double-process.
            params.MessageGroupId = String(sessionId);
            params.MessageDeduplicationId = String(sessionId);
        }
        const out = await client.send(new SendMessageCommand(params));
        return { driver: 'sqs', id: out.MessageId };
    };
    return _sqsPublish;
}

/* ----------------------- public API ----------------------- */

/**
 * Enqueue a processing job for the given session.
 *
 * @param {{ sessionId: string }} payload
 * @returns {Promise<{ driver: 'bullmq'|'sqs', id: string }>}
 */
async function publishProcessing(payload) {
    if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId) {
        throw new Error('publishProcessing: sessionId (string) is required');
    }

    const publisher = DRIVER === 'sqs' ? sqsPublisher() : bullPublisher();
    const result = await publisher(payload);

    logger.info('queue_publish', {
        driver: result.driver,
        id: result.id,
        sessionId: payload.sessionId
    });
    return result;
}

module.exports = {
    publishProcessing,
    driver: DRIVER
};
