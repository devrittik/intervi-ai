/**
 * Deepgram Voice Agent V1 WebSocket proxy.
 *
 *   client  <--ws-->  /api/voice-agent/:token  <--ws-->  agent.deepgram.com/v1/agent/converse
 *
 * Responsibilities:
 *   1. Validate session token (must exist, not locked, not expired).
 *   2. Open + auth upstream WS (subprotocols=["token", KEY] + Authorization header).
 *   3. Pipe binary audio + JSON control bidirectionally.
 *   4. Sniff `ConversationText` (role: "user") and persist transcripts per-question.
 *
 * [BUG-pacing] We do NOT trigger Groq evaluation from inside the proxy anymore.
 *   Previously this fired ~2s after every user transcript update, which caused the
 *   agent to interrupt mid-answer with feedback after the candidate paused for a
 *   single word. Groq evaluation is now ONLY run when the InterviewPage explicitly
 *   calls POST /api/sessions/:token/answer/review at the end of a question turn
 *   (i.e. after silence / answer-timer). The proxy's job is to keep transcripts
 *   fresh in MongoDB so that REST call has up-to-date content to evaluate.
 */
const WebSocket = require('ws');
const url = require('url');
const { InterviewSession } = require('../models');
const logger = require('../utils/logger');

const DEEPGRAM_AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';

function attachVoiceAgentProxy(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    const parsed = url.parse(req.url || '');
    const m = (parsed.pathname || '').match(/^\/api\/voice-agent\/([^/]+)$/);
    if (!m) return;

    const token = decodeURIComponent(m[1]);

    let session;
    try { session = await InterviewSession.findOne({ token }); }
    catch (err) {
      logger.error('voice_agent_db_error', { err: err.message });
      socket.destroy();
      return;
    }

    if (!session) {
      logger.warn('voice_agent_session_not_found', { token });
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return;
    }
    if (session.isLocked) {
      logger.warn('voice_agent_session_locked', { token });
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n'); socket.destroy(); return;
    }
    if (!process.env.DEEPGRAM_API_KEY) {
      logger.error('voice_agent_missing_key');
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); socket.destroy(); return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      wss.emit('connection', clientWs, req, session, token);
    });
  });

  wss.on('connection', (clientWs, req, session, token) => {
    const sessionIdStr = session._id.toString();
    const log = logger.withCtx({ sessionId: sessionIdStr });
    log.info('voice_agent_client_connected');

    const upstream = new WebSocket(DEEPGRAM_AGENT_URL, ['token', process.env.DEEPGRAM_API_KEY], {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    const state = {
      token,
      questionIndex: null,
      transcriptBuffer: '',
      clientQueue: [],
      upstreamReady: false
    };

    /* --------- client → upstream --------- */
    clientWs.on('message', (msg, isBinary) => {
      if (!isBinary) {
        try {
          const obj = JSON.parse(msg.toString());
          if (obj && obj.type === '__set_question_index' && typeof obj.questionIndex === 'number') {
            // Flush previous question's transcript before switching.
            flushTranscript(state, sessionIdStr).catch(() => { });
            state.questionIndex = obj.questionIndex;
            state.transcriptBuffer = '';
            log.info('voice_agent_question_set', { questionIndex: state.questionIndex });
            return; // don't forward our internal frame upstream
          }
        } catch (_) { /* fall through */ }
      }

      if (state.upstreamReady && upstream.readyState === WebSocket.OPEN) {
        upstream.send(msg, { binary: isBinary });
      } else if (state.clientQueue.length < 200) {
        state.clientQueue.push({ msg, isBinary });
      }
    });

    /* --------- upstream → client + transcript sniff --------- */
    upstream.on('open', () => {
      state.upstreamReady = true;
      log.info('voice_agent_upstream_open');
      for (const f of state.clientQueue) {
        try { upstream.send(f.msg, { binary: f.isBinary }); } catch (_) { }
      }
      state.clientQueue = [];
    });

    upstream.on('message', (msg, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msg, { binary: isBinary });
      }
      if (!isBinary) {
        try { handleUpstreamJson(JSON.parse(msg.toString()), state, sessionIdStr, log); }
        catch (_) { }
      }
    });

    upstream.on('close', async (code, reason) => {
      log.info('voice_agent_upstream_close', { code, reason: reason?.toString() });
      await flushTranscript(state, sessionIdStr).catch(() => { });
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code === 1000 ? 1000 : 1011);
    });
    upstream.on('error', (err) => {
      log.error('voice_agent_upstream_error', { err: err.message });
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream_error');
    });

    clientWs.on('close', async (code) => {
      log.info('voice_agent_client_close', { code });
      await flushTranscript(state, sessionIdStr).catch(() => { });
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });
    clientWs.on('error', (err) => {
      log.error('voice_agent_client_error', { err: err.message });
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });
  });

  logger.info('voice_agent_proxy_attached');
}

function handleUpstreamJson(obj, state, sessionIdStr, log) {
  if (!obj || typeof obj !== 'object') return;

  if (obj.type === 'Error') {
    log.error('voice_agent_upstream_error_frame', { obj });
    return;
  }

  if (obj.type === 'ConversationText' && obj.role === 'user' && typeof obj.content === 'string') {
    if (state.questionIndex === null) return;

    state.transcriptBuffer = state.transcriptBuffer
      ? `${state.transcriptBuffer} ${obj.content}`.trim()
      : obj.content;

    log.info('voice_agent_transcript_received', {
      questionIndex: state.questionIndex,
      length: state.transcriptBuffer.length
    });

    // [BUG-pacing] Persist transcript incrementally so the REST /answer/review call
    // always has the latest content — but DO NOT trigger Groq from here. Groq fires
    // once per question turn from the InterviewPage, after silence is detected.
    persistTranscript(sessionIdStr, state.questionIndex, state.transcriptBuffer).catch((e) =>
      log.error('voice_agent_persist_error', { err: e.message })
    );
  }
}

async function persistTranscript(sessionId, questionIndex, transcript) {
  const r = await InterviewSession.updateOne(
    { _id: sessionId, 'answers.questionIndex': questionIndex },
    { $set: { 'answers.$.transcript': transcript } }
  );
  if (r.matchedCount === 0) {
    await InterviewSession.updateOne(
      { _id: sessionId },
      { $push: { answers: { questionIndex, transcript } } }
    );
  }
}

async function flushTranscript(state, sessionIdStr) {
  if (state.questionIndex !== null && state.transcriptBuffer) {
    await persistTranscript(sessionIdStr, state.questionIndex, state.transcriptBuffer);
  }
}

module.exports = { attachVoiceAgentProxy };
