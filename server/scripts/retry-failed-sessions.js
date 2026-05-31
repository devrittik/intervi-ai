/**
 * Re-enqueue worker jobs for sessions stuck in status="failed" or "processing".
 *
 * Use this after the [BUG-validation] fix to retry sessions whose merge step
 * succeeded (videos are in S3) but whose final save() blew up on legacy
 * uploadedChunks validation.
 *
 * Usage (from server/ folder):
 *   node scripts/retry-failed-sessions.js               # retry status='failed'
 *   node scripts/retry-failed-sessions.js processing    # also include 'processing'
 *   node scripts/retry-failed-sessions.js <sessionId>   # retry a single session
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
// [queue-driver] Use the abstraction so this script works for both
// QUEUE_DRIVER=bullmq and QUEUE_DRIVER=sqs without modification.
const { publishProcessing, driver } = require('../services/queuePublisher');
const { InterviewSession } = require('../models');

async function main() {
    await connectDB();

    const arg = process.argv[2];
    let query;

    if (arg && mongoose.Types.ObjectId.isValid(arg)) {
        query = { _id: arg };
    } else if (arg === 'processing') {
        query = { status: { $in: ['failed', 'processing'] } };
    } else {
        query = { status: 'failed' };
    }

    const sessions = await InterviewSession.find(query).select('_id status').lean();
    console.log(`Found ${sessions.length} session(s) to retry.`);

    console.log(`Using queue driver: ${driver}`);

    for (const s of sessions) {
        // Reset status so the worker job runs cleanly.
        await InterviewSession.updateOne(
            { _id: s._id },
            { $set: { status: 'processing' } }
        );
        const result = await publishProcessing({ sessionId: s._id.toString() });
        console.log(`  enqueued sessionId=${s._id} via ${result.driver} as id=${result.id} (was status=${s.status})`);
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('retry-failed-sessions failed:', err);
    process.exit(1);
});
