/**
 * AWS Lambda entrypoint for the processing queue.
 *
 * Trigger: SQS event source mapping on the processing queue.
 * Concurrency: configured at the queue / event source mapping level.
 *
 *   event.Records[i].body         → JSON-encoded { sessionId }
 *   event.Records[i].messageId    → used as the job id passed to handleJob
 *   event.Records[i].attributes.ApproximateReceiveCount → used for attemptsMade
 *
 * Failure semantics:
 *   - Throw to fail the entire batch (SQS will redeliver after visibility
 *     timeout; after maxReceiveCount tries, the message goes to the DLQ).
 *   - Return `{ batchItemFailures: [...] }` to fail only specific messages —
 *     useful when batchSize > 1. We default to batchSize=1 in template.yaml to
 *     keep the failure model simple, but the code handles both cases.
 *
 * Cold-start optimisation:
 *   - connectDB() is awaited once and the result is cached in module scope.
 *     Warm invocations reuse the existing Mongoose connection.
 *   - handler.js side-effects (ffmpeg.setFfmpegPath etc.) run once at module load.
 */

// IMPORTANT: paths are written assuming the build script copies the server/
// source into the Lambda bundle so this file sits next to `models/`, `config/`,
// `utils/`, `workers/`. See server/lambda/build.sh.
const { connectDB } = require('../../config/db');
const { handleJob, checkFfmpeg } = require('../../workers/handler');
const logger = require('../../utils/logger');

// One-time cold-start work — both promises are awaited inside handler() so we
// don't crash module load if Mongo is briefly unreachable at init time.
let _dbReadyPromise = null;
function ensureDb() {
    if (!_dbReadyPromise) _dbReadyPromise = connectDB();
    return _dbReadyPromise;
}

// FFmpeg presence check — logs once. If you're using a Lambda layer, set
// FFMPEG_PATH env to /opt/bin/ffmpeg (the layer's binary path).
checkFfmpeg();

exports.handler = async (event) => {
    await ensureDb();

    const records = Array.isArray(event?.Records) ? event.Records : [];
    if (!records.length) {
        logger.warn('lambda_invoked_without_records');
        return { batchItemFailures: [] };
    }

    logger.info('lambda_batch_received', { count: records.length });

    const failures = [];

    for (const record of records) {
        let body;
        try {
            body = JSON.parse(record.body || '{}');
        } catch (err) {
            // Malformed message — fail it permanently. Returning it in
            // batchItemFailures sends it back to SQS, but with a parse error it'll
            // just hit the DLQ after maxReceiveCount. Mark and move on.
            logger.error('lambda_message_parse_error', {
                messageId: record.messageId, err: err.message, raw: record.body
            });
            failures.push({ itemIdentifier: record.messageId });
            continue;
        }

        const attemptsMade = Math.max(
            0,
            Number(record?.attributes?.ApproximateReceiveCount || 1) - 1
        );

        // Shape matches BullMQ's `job` so handler.js works identically.
        const job = {
            id: record.messageId,
            data: body,
            attemptsMade,
            opts: {}
        };

        try {
            await handleJob(job);
        } catch (err) {
            logger.error('lambda_job_failed', {
                messageId: record.messageId,
                sessionId: body?.sessionId,
                attemptsMade,
                err: err.message
            });
            // Mark THIS message as failed so SQS retries only it, not the whole batch.
            // (Requires reportBatchItemFailures: true on the event source mapping.)
            failures.push({ itemIdentifier: record.messageId });
        }
    }

    return { batchItemFailures: failures };
};
