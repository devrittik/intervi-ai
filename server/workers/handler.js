/**
 * Pure job-processing logic — runtime-agnostic.
 *
 * Exported `handleJob(job)` takes the same `job` shape as BullMQ
 * (i.e. `{ id, data: { sessionId }, attemptsMade, opts }`) and is invoked
 * identically by:
 *
 *   - server/workers/processor.js  → BullMQ Worker (long-running Node)
 *   - server/lambda/processor/...  → AWS Lambda (triggered by SQS messages)
 *
 * NO business logic lives in either wrapper. They only:
 *   1. ensure Mongo is connected
 *   2. parse the job payload
 *   3. call handleJob
 *   4. let success/failure propagate to BullMQ retries or SQS visibility timeout
 *
 * This file is the original processor.js body — moved, not edited. FFmpeg
 * merge, Groq scoring, transcript handling, Mongo writes, S3 reads/writes
 * are bit-for-bit identical to the BullMQ-era code.
 */
require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const ffmpeg = require('fluent-ffmpeg');

const { InterviewSession, InterviewTemplate } = require('../models');
const { getObjectStream, putObject, listObjects } = require('../utils/s3');
const logger = require('../utils/logger');

// Use system ffmpeg by default. If you ship a static binary (Lambda layer,
// custom container), set FFMPEG_PATH to its absolute path.
if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);

let groqClient = null;
async function getGroq() {
    if (groqClient) return groqClient;
    const { default: Groq } = await import('groq-sdk').then((m) => ({ default: m.default || m.Groq || m }));
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    return groqClient;
}

async function downloadToFile(s3Key, destPath) {
    const stream = await getObjectStream(s3Key);
    await pipeline(stream, fs.createWriteStream(destPath));
}

/**
 * [BUG-chunks] Merge ordered MediaRecorder webm chunks into a single, seekable .webm.
 *
 * Why we don't use ffmpeg's concat demuxer:
 *   When MediaRecorder is started with start(timeslice), only the very first chunk
 *   contains the EBML/WebM file header + Segment + Tracks elements. Chunks 1..N
 *   are raw Cluster bytes that *continue* the same logical stream — they are NOT
 *   standalone webm files. Passing them to `ffmpeg -f concat` makes ffmpeg try to
 *   demux each as a complete container and it fails with
 *     "EBML header parsing failed" / "Invalid data found when processing input"
 *   leaving only chunk_000 readable and the rest "corrupted" in S3 terms.
 *
 * The correct fix is to byte-concatenate the chunks first (they're designed for
 * exactly this), then run ffmpeg ONCE on the resulting blob to rebuild the
 * Cues index so the output is seekable in the recruiter's <video> player.
 */
async function mergeChunks(chunkPaths, outPath) {
    // 1. Byte-concat all chunks into one .webm. This already plays in most browsers,
    //    but is not seekable because the Cues block is missing.
    const concatPath = `${outPath}.concat.webm`;
    const writeStream = fs.createWriteStream(concatPath);
    for (const p of chunkPaths) {
        await new Promise((resolve, reject) => {
            const r = fs.createReadStream(p);
            r.on('error', reject);
            r.on('end', resolve);
            r.pipe(writeStream, { end: false });
        });
    }
    await new Promise((resolve, reject) => {
        writeStream.end((err) => (err ? reject(err) : resolve()));
    });

    // 2. Remux through ffmpeg to rebuild the Cues index → seekable output.
    //    -c copy keeps it lossless. We DON'T use -f concat anymore.
    await new Promise((resolve, reject) => {
        ffmpeg(concatPath)
            .outputOptions([
                '-c', 'copy',
                '-fflags', '+genpts',     // regenerate timestamps if any clusters are missing them
                '-avoid_negative_ts', 'make_zero'
            ])
            .on('start', (cmd) => console.log('[BUG-chunks][WORKER] ffmpeg remux:', cmd))
            .on('end', resolve)
            .on('error', (err, _stdout, stderr) => {
                console.error('[BUG-chunks][WORKER] ffmpeg remux failed:', err.message, stderr);
                reject(err);
            })
            .save(outPath);
    });

    await fsp.unlink(concatPath).catch(() => { });
}

async function processQuestion({ session, template, questionIndex, log }) {
    const qLog = log.child({ questionIndex });

    // Pull chunk keys from session.uploadedChunks; fallback: list S3 prefix.
    let chunks = session.uploadedChunks
        .filter((c) => c.questionIndex === questionIndex)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);

    if (!chunks.length) {
        const prefix = `${session._id}/${questionIndex}/chunk_`;
        const listed = (await listObjects(prefix)).map((o) => o.Key).sort();
        chunks = listed.map((key, i) => ({ s3Key: key, chunkIndex: i, questionIndex }));
    }

    if (!chunks.length) {
        qLog.warn('no_chunks_for_question');
        return null;
    }

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `q${questionIndex}_`));
    try {
        // [BUG-chunks] Download every chunk and KEEP THEM IN ORIGINAL ORDER. We use
        // chunks[i].chunkIndex (zero-padded) for the local filename so the byte-concat
        // is strictly sequential — out-of-order bytes would corrupt the WebM cluster stream.
        const localPaths = [];
        for (let i = 0; i < chunks.length; i++) {
            const ci = chunks[i].chunkIndex;
            const dest = path.join(tmpDir, `chunk_${String(ci).padStart(3, '0')}.webm`);
            try {
                await downloadToFile(chunks[i].s3Key, dest);
                const stat = await fsp.stat(dest);
                // [BUG-chunks] WebM continuation chunks can be quite small (a few hundred bytes
                // of cluster data). Only drop chunks that are literally empty (size 0) — anything
                // larger may be a valid cluster fragment and dropping it corrupts the timeline.
                if (stat.size === 0) {
                    qLog.warn('skip_zero_byte_chunk', { key: chunks[i].s3Key });
                    continue;
                }
                localPaths.push(dest);
            } catch (err) {
                // Corrupted/missing single chunk — skip it, keep going.
                qLog.warn('chunk_download_failed_skipping', { key: chunks[i].s3Key, err: err.message });
            }
        }

        if (!localPaths.length) {
            qLog.warn('no_usable_chunks_after_download');
            return null;
        }

        // Sort defensively by chunkIndex embedded in the filename (chunk_NNN).
        localPaths.sort();

        const mergedLocal = path.join(tmpDir, 'merged.webm');
        console.log('[BUG-chunks][WORKER] merging', localPaths.length, 'chunks for q', questionIndex);
        await mergeChunks(localPaths, mergedLocal);
        qLog.info('ffmpeg_complete', { inputCount: localPaths.length });

        const mergedKey = `${session._id}/${questionIndex}/merged.webm`;
        const body = await fsp.readFile(mergedLocal);
        await putObject({ key: mergedKey, body, contentType: 'video/webm' });
        qLog.info('merged_uploaded', { mergedKey, size: body.length });

        return { mergedKey };
    } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
}

/**
 * If a per-question aiScore is still missing (e.g. live Groq call failed in browser),
 * compute it server-side from the persisted transcript so the recruiter always sees a score.
 */
async function ensurePerQuestionScore({ session, template, questionIndex, log }) {
    const answer = session.answers.find((a) => a.questionIndex === questionIndex);
    if (!answer) return null;
    if (typeof answer.aiScore === 'number') return null; // already done client-side

    const q = template.questions.find((qq) => qq.index === questionIndex);
    if (!q || !answer.transcript) return null;

    try {
        const groq = await getGroq();
        const completion = await groq.chat.completions.create({
            model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
            messages: [
                {
                    role: 'system',
                    content:
                        'You evaluate interview answers. Reply ONLY as compact JSON: ' +
                        '{"score": <int 0-100>, "feedback": "<exactly two sentences>"}.'
                },
                {
                    role: 'user',
                    content: `Question: ${q.text}\nCandidate answer transcript: ${answer.transcript}\n\nScore 0-100 and give a two-sentence feedback.`
                }
            ],
            temperature: 0.2,
            response_format: { type: 'json_object' }
        });
        const raw = completion.choices?.[0]?.message?.content || '{}';
        const parsed = JSON.parse(raw);
        answer.aiScore = Math.max(0, Math.min(100, Number(parsed.score) || 0));
        answer.aiFeedback = String(parsed.feedback || '').slice(0, 1000);
        log.info('groq_per_question_complete', { questionIndex, score: answer.aiScore });
    } catch (err) {
        log.error('groq_per_question_failed', { questionIndex, err: err.message });
    }
}

async function computeOverall({ session, log }) {
    const scores = session.answers.map((a) => a.aiScore).filter((n) => typeof n === 'number');
    session.overallScore = scores.length
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : null;

    // Always reset to a known shape so the recruiter UI never reads stale arrays.
    session.overallStrengths = [];
    session.overallWeaknesses = [];
    session.overallFeedback = '';

    if (!scores.length) return;

    try {
        const groq = await getGroq();
        const completion = await groq.chat.completions.create({
            model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
            messages: [
                {
                    role: 'system',
                    content:
                        // [polish-summary] Structured JSON so we can render strengths/weaknesses
                        // as separate UI sections instead of a wall of text.
                        'You are a hiring assistant. Summarize a candidate\'s interview for a recruiter. ' +
                        'Reply ONLY as compact JSON with this exact shape:\n' +
                        '{\n' +
                        '  "summary":   "<2-3 neutral sentences>",\n' +
                        '  "strengths": ["<short phrase>", ...],   // up to 3, each ≤ 12 words\n' +
                        '  "weaknesses":["<short phrase>", ...]    // up to 3, each ≤ 12 words\n' +
                        '}\n' +
                        'Rules: be specific (cite topics/skills mentioned), not generic. ' +
                        'If you cannot find 3 real items for a list, return fewer — never pad. ' +
                        'Empty arrays are allowed if no clear signal.'
                },
                {
                    role: 'user',
                    content:
                        'Per-question evaluations:\n' +
                        session.answers
                            .map(
                                (a) =>
                                    `Q${a.questionIndex} (score ${a.aiScore ?? '-'}): ${a.aiFeedback || '(no feedback)'}\n` +
                                    `   transcript: ${(a.transcript || '').slice(0, 600)}`
                            )
                            .join('\n')
                }
            ],
            temperature: 0.3,
            response_format: { type: 'json_object' }
        });

        const raw = completion.choices?.[0]?.message?.content || '{}';
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (_) { parsed = {}; }

        session.overallFeedback = String(parsed.summary || '').slice(0, 1000);
        session.overallStrengths = Array.isArray(parsed.strengths)
            ? parsed.strengths.slice(0, 3).map((s) => String(s).slice(0, 140))
            : [];
        session.overallWeaknesses = Array.isArray(parsed.weaknesses)
            ? parsed.weaknesses.slice(0, 3).map((s) => String(s).slice(0, 140))
            : [];

        log.info('overall_summary_complete', {
            strengthCount: session.overallStrengths.length,
            weaknessCount: session.overallWeaknesses.length
        });
    } catch (err) {
        log.warn('groq_overall_failed', { err: err.message });
    }
}

/**
 * The job entrypoint. Both BullMQ and Lambda call this with the same shape.
 *
 * Throws on unrecoverable failure → BullMQ retries / SQS requeues per its
 * configured policy. Returns normally on success → BullMQ marks completed /
 * Lambda lets SQS auto-delete the message.
 */
async function handleJob(job) {
    const { sessionId } = job.data;
    const log = logger.withCtx({ sessionId, jobId: job.id });
    const startedAt = Date.now();

    // [BUG4] Confirm the worker actually picks the job off the queue.
    console.log('[BUG4][WORKER] >>> job_started', { sessionId, jobId: job.id, attempt: (job.attemptsMade || 0) + 1 });
    log.info('worker_job_started');

    try {
        const session = await InterviewSession.findById(sessionId);
        if (!session) throw new Error('session_not_found');
        const template = await InterviewTemplate.findById(session.templateId);
        if (!template) throw new Error('template_not_found');

        const questionIndexes = [...new Set(session.uploadedChunks.map((c) => c.questionIndex))].sort(
            (a, b) => a - b
        );

        for (const qi of questionIndexes) {
            try {
                const out = await processQuestion({ session, template, questionIndex: qi, log });
                if (out) {
                    const existing = session.answers.find((a) => a.questionIndex === qi);
                    if (existing) existing.mergedVideoKey = out.mergedKey;
                    else
                        session.answers.push({
                            questionIndex: qi,
                            mergedVideoKey: out.mergedKey,
                            transcript: '',
                            aiScore: null,
                            aiFeedback: ''
                        });
                }
                // Per-question Groq is handled live by the Voice Agent proxy ([BUG3b]);
                // this is a safety net for sessions where the live eval failed.
                await ensurePerQuestionScore({ session, template, questionIndex: qi, log });
            } catch (err) {
                console.error('[BUG4][WORKER] question_processing_failed', { sessionId, questionIndex: qi, err: err.message, stack: err.stack });
                log.error('question_processing_failed', { questionIndex: qi, err: err.message });
                // continue — partial completion beats total failure
            }
        }

        await computeOverall({ session, log });
        session.status = 'done';

        // [BUG-validation] Use validateBeforeSave: false here.
        //
        // The worker only ever mutates `answers`, `status`, `overallScore`,
        // `overallFeedback` — it NEVER touches `uploadedChunks`. But Mongoose runs
        // full-document validation on .save() by default, which iterates every
        // existing subdocument. For sessions whose uploadedChunks were persisted
        // before the current schema required `s3Key` (or by an earlier buggy
        // branch), validation throws and aborts the entire job AFTER ffmpeg has
        // already uploaded merged.webm files to S3.
        //
        // Skipping validation on this controlled write path is the surgical fix.
        await session.save({ validateBeforeSave: false });

        console.log('[BUG4][WORKER] <<< job_done', {
            sessionId, jobId: job.id, durationMs: Date.now() - startedAt, overallScore: session.overallScore
        });
        log.info('worker_job_done', {
            durationMs: Date.now() - startedAt,
            overallScore: session.overallScore
        });
        return { ok: true };
    } catch (err) {
        // [BUG4] Any unhandled error → mark session failed (do NOT leave it as "processing").
        console.error('[BUG4][WORKER] !!! job FAILED', {
            sessionId, jobId: job.id, err: err.message, stack: err.stack
        });
        try {
            await InterviewSession.findByIdAndUpdate(sessionId, { $set: { status: 'failed' } });
            console.log('[BUG4][WORKER] session marked as status=failed', { sessionId });
        } catch (e2) {
            console.error('[BUG4][WORKER] failed to mark session as failed', { sessionId, err: e2.message });
        }
        throw err; // let BullMQ record the failure + retry per attempts policy
    }
}

/**
 * Diagnostic check used by both BullMQ and Lambda wrappers at startup.
 * Doesn't throw — just logs so misconfigured environments fail loudly.
 */
function checkFfmpeg() {
    try {
        const { execSync } = require('child_process');
        const out = execSync(
            process.env.FFMPEG_PATH ? `${process.env.FFMPEG_PATH} -version` : 'ffmpeg -version'
        ).toString();
        const firstLine = out.split('\n')[0];
        console.log('[BUG4][WORKER] FFmpeg available:', firstLine);
        return true;
    } catch (err) {
        console.error('[BUG4][WORKER] FFmpeg NOT found — install it (apt install ffmpeg / brew install ffmpeg / Lambda layer). Jobs will fail.');
        return false;
    }
}

module.exports = { handleJob, checkFfmpeg };
