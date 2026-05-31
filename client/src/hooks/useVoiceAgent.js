import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceAgentWsUrl } from '../utils/api';

/**
 * Deepgram Voice Agent V1 client (via our backend proxy).
 *
 *   WSS:   wss://agent.deepgram.com/v1/agent/converse  (proxied)
 *   Init:  { type: "Settings", audio, agent }
 *   Speak: { type: "InjectAgentMessage", content: "..." }   // V1 field
 *
 * [BUG3a] Lifecycle: the socket MUST stay open across the whole interview.
 *         The ONLY path that closes it is the explicit closeAgent() method.
 *         A KeepAlive frame is sent every 8s — Deepgram will drop idle sockets
 *         (~10–12s of no audio + no JSON) which is the actual cause of the
 *         "I didn't get your response" behaviour we were seeing.
 */

const SAMPLE_RATE = 24000;
const KEEPALIVE_INTERVAL_MS = 8000;

export function useVoiceAgent({
  token,
  stream,
  onTranscript,
  onAgentSpeechStart,
  onAgentSpeechEnd,
  onSilenceDetected,
  onOpen,
  onClose,
  onError,
  silenceThresholdMs = 4000
} = {}) {
  const wsRef = useRef(null);
  const micCtxRef = useRef(null);
  const micNodeRef = useRef(null);
  const micSourceRef = useRef(null);
  const playCtxRef = useRef(null);
  const playheadRef = useRef(0);

  const agentSpeakingRef = useRef(false);
  const userSpokeRef = useRef(false);  // set true once UserStartedSpeaking has fired in current Q
  const lastSpeechAtRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const silenceFiredRef = useRef(false);
  const keepAliveTimerRef = useRef(null);

  // [polish-speech-end] An "utterance" has 3 lifecycle signals:
  //   1. pendingSpeechRef  — we sent InjectAgentMessage, waiting for ANY audio to start.
  //   2. agentSpeakingRef  — at least one audio chunk has arrived & is queued/playing.
  //   3. audioDoneSeenRef  — Deepgram sent AgentAudioDone (server-side TTS finished).
  //
  // onAgentSpeechEnd ONLY fires when (2) is true, (3) is true, AND the local
  // playback queue is fully drained. The previous code fired it from each
  // chunk's src.onended whenever the queue briefly emptied between chunks,
  // which made the next question arrive while the previous review's audio was
  // still being streamed — Deepgram then InjectionRefused the next question
  // and it was never spoken.
  const pendingSpeechRef = useRef(false);
  const audioDoneSeenRef = useRef(false);
  const lastSpeakAtRef = useRef(0);
  const speakEndWaitersRef = useRef([]); // resolvers awaiting current utterance to finish

  // [BUG3a] Explicit-close gate. Only closeAgent() sets this true.
  // Without it, React StrictMode's double-mount or any transient re-render
  // would trip the disconnect-on-unmount cleanup and tear down the WS.
  const explicitCloseRef = useRef(false);

  const transcriptRef = useRef('');
  const questionIndexRef = useRef(null);

  const [status, setStatus] = useState('idle'); // idle | connecting | open | closed | error

  /* latest callbacks in refs so we don't churn handlers */
  const cb = useRef({});
  useEffect(() => {
    cb.current = { onTranscript, onAgentSpeechStart, onAgentSpeechEnd, onSilenceDetected, onOpen, onClose, onError };
  }, [onTranscript, onAgentSpeechStart, onAgentSpeechEnd, onSilenceDetected, onOpen, onClose, onError]);

  /* ------------------- send helpers ------------------- */
  const sendJson = useCallback((obj) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }, []);

  const sendBinary = useCallback((buf) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(buf);
  }, []);

  /* ------------------- mic capture ------------------- */
  const startMicCapture = useCallback(async () => {
    if (!stream) return;
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    micCtxRef.current = ctx;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) { } }

    const workletCode = `
      class PcmPump extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (!input || !input[0]) return true;
          const ch = input[0];
          const buf = new Int16Array(ch.length);
          for (let i = 0; i < ch.length; i++) {
            const s = Math.max(-1, Math.min(1, ch[i]));
            buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this.port.postMessage(buf, [buf.buffer]);
          return true;
        }
      }
      registerProcessor('pcm-pump', PcmPump);
    `;
    const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    const src = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const node = new AudioWorkletNode(ctx, 'pcm-pump');
    micSourceRef.current = src;
    micNodeRef.current = node;

    // [BUG-mic] Diagnostic counters so we can verify in console whether frames
    // are actually leaving the browser.
    let framesSent = 0;
    let framesGated = 0;
    let lastReport = Date.now();

    node.port.onmessage = (ev) => {
      if (agentSpeakingRef.current) {
        framesGated++;
      } else {
        sendBinary(ev.data.buffer);
        framesSent++;
      }
      const now = Date.now();
      if (now - lastReport > 3000) {
        // eslint-disable-next-line no-console
        console.log('[BUG-mic] frames last 3s — sent:', framesSent, 'gated(agent speaking):', framesGated,
          'wsState:', wsRef.current?.readyState);
        framesSent = 0;
        framesGated = 0;
        lastReport = now;
      }
    };

    src.connect(node);
    // eslint-disable-next-line no-console
    console.log('[BUG-mic] mic capture started — track=', audioTrack.label, 'muted=', audioTrack.muted,
      'enabled=', audioTrack.enabled, 'readyState=', audioTrack.readyState);
  }, [stream, sendBinary]);

  const stopMicCapture = useCallback(async () => {
    try { micNodeRef.current?.disconnect(); } catch (_) { }
    try { micSourceRef.current?.disconnect(); } catch (_) { }
    micNodeRef.current = null;
    micSourceRef.current = null;
    if (micCtxRef.current) {
      try { await micCtxRef.current.close(); } catch (_) { }
      micCtxRef.current = null;
    }
  }, []);

  /* ------------------- playback ------------------- */
  const ensurePlayCtx = useCallback(() => {
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      playheadRef.current = playCtxRef.current.currentTime;
    }
    return playCtxRef.current;
  }, []);

  /**
   * [polish-speech-end] Finalise the current utterance ONLY when:
   *   - we actually heard audio (agentSpeakingRef = true)
   *   - the server told us TTS is done (audioDoneSeenRef = true)
   *   - the local playback queue is drained (playhead <= currentTime + epsilon)
   *
   * This is called from playPcm16's src.onended AND from AgentAudioDone — last
   * of the two to satisfy all conditions wins. Whoever calls it must already
   * be holding the playback context.
   */
  const maybeFinaliseSpeech = useCallback(() => {
    if (!agentSpeakingRef.current) return;
    if (!audioDoneSeenRef.current) return;

    const ctx = playCtxRef.current;
    if (ctx) {
      const remaining = playheadRef.current - ctx.currentTime;
      if (remaining > 0.05) return; // still draining
    }

    agentSpeakingRef.current = false;
    pendingSpeechRef.current = false;
    audioDoneSeenRef.current = false;
    lastSpeechAtRef.current = userSpokeRef.current ? Date.now() : null;

    // Wake anyone awaiting waitForSpeechEnd() (e.g. finishInterview's goodbye).
    const waiters = speakEndWaitersRef.current.splice(0);
    for (const r of waiters) { try { r(); } catch (_) { } }

    cb.current.onAgentSpeechEnd?.();
  }, []);

  const playPcm16 = useCallback((arrayBuffer) => {
    const ctx = ensurePlayCtx();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) { } }

    const view = new DataView(arrayBuffer);
    const frames = view.byteLength / 2;
    if (frames === 0) return;

    const audioBuf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const ch = audioBuf.getChannelData(0);
    for (let i = 0; i < frames; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    const startAt = Math.max(playheadRef.current, ctx.currentTime + 0.02);
    src.start(startAt);
    playheadRef.current = startAt + audioBuf.duration;

    if (!agentSpeakingRef.current) {
      agentSpeakingRef.current = true;
      pendingSpeechRef.current = false; // audio started — no longer "pending"
      cb.current.onAgentSpeechStart?.();
    }

    // [polish-speech-end] Per-chunk drain check, but it only finalises if
    // AgentAudioDone has ALSO been seen. Otherwise we just keep waiting for
    // more audio. A brief inter-chunk gap no longer triggers a false end.
    src.onended = () => maybeFinaliseSpeech();
  }, [ensurePlayCtx, maybeFinaliseSpeech]);

  /* ------------------- silence detector + stuck-speaking watchdog ------------------- */
  useEffect(() => {
    silenceTimerRef.current = setInterval(() => {
      // [polish-speech-end] Stuck-pending watchdog: we sent an inject but no
      // audio EVER arrived (e.g. InjectionRefused we didn't catch, or upstream
      // dropped). After 6s of nothing, give up and signal end so the phase
      // machine can move on.
      if (pendingSpeechRef.current && !agentSpeakingRef.current) {
        if (Date.now() - lastSpeakAtRef.current > 6000) {
          // eslint-disable-next-line no-console
          console.warn('[polish-speech-end] no audio after 6s of pending — synthesising end');
          pendingSpeechRef.current = false;
          audioDoneSeenRef.current = true;
          agentSpeakingRef.current = true; // trick maybeFinalise into firing once
          maybeFinaliseSpeech();
        }
      }

      // [BUG-mic] Stuck-speaking watchdog. Only fires if BOTH the queue has been
      // empty for >3s (TTS chunks have natural sub-second gaps; don't be twitchy)
      // AND we never received AgentAudioDone. Most of the time the AudioDone path
      // handles this cleanly; this is the safety net.
      if (agentSpeakingRef.current && !audioDoneSeenRef.current) {
        const ctx = playCtxRef.current;
        const drainedFor = ctx ? (ctx.currentTime - playheadRef.current) : 0;
        if (drainedFor > 3.0) {
          // eslint-disable-next-line no-console
          console.warn('[BUG-mic] stuck speaking (no AgentAudioDone after 3s drain) — releasing');
          audioDoneSeenRef.current = true;
          maybeFinaliseSpeech();
        }
      }

      if (agentSpeakingRef.current || pendingSpeechRef.current) return;
      if (!userSpokeRef.current) return;
      if (!lastSpeechAtRef.current) return;
      if (silenceFiredRef.current) return;
      const since = Date.now() - lastSpeechAtRef.current;
      if (since > silenceThresholdMs) {
        silenceFiredRef.current = true;
        cb.current.onSilenceDetected?.(since);
      }
    }, 500);
    return () => clearInterval(silenceTimerRef.current);
  }, [silenceThresholdMs, maybeFinaliseSpeech]);

  /* ------------------- control frame handler ------------------- */
  const handleControl = useCallback((obj) => {
    if (!obj || typeof obj !== 'object') return;

    switch (obj.type) {
      case 'Welcome':
      case 'SettingsApplied':
        break;

      case 'ConversationText': {
        if (obj.role === 'user' && typeof obj.content === 'string') {
          transcriptRef.current = transcriptRef.current
            ? `${transcriptRef.current} ${obj.content}`.trim()
            : obj.content;
          userSpokeRef.current = true;
          lastSpeechAtRef.current = Date.now();
          silenceFiredRef.current = false;
          cb.current.onTranscript?.(transcriptRef.current);
        }
        break;
      }

      case 'UserStartedSpeaking':
        userSpokeRef.current = true;
        silenceFiredRef.current = false;
        lastSpeechAtRef.current = Date.now();
        break;

      case 'AgentStartedSpeaking':
        agentSpeakingRef.current = true;
        cb.current.onAgentSpeechStart?.();
        break;

      case 'AgentAudioDone':
        // [polish-speech-end] Mark server-side TTS as finished. The actual
        // onAgentSpeechEnd fires only when the local playback queue drains AND
        // we've reached this point — see maybeFinaliseSpeech().
        audioDoneSeenRef.current = true;
        // Try immediately (in case the last chunk has already played out)
        // and again after a small grace (in case the last chunk is still queued).
        maybeFinaliseSpeech();
        setTimeout(() => maybeFinaliseSpeech(), 60);
        break;

      case 'InjectionRefused':
        // eslint-disable-next-line no-console
        console.warn('[voice-agent] InjectionRefused:', obj.message);
        break;

      case 'Error':
      case 'Warning':
        // eslint-disable-next-line no-console
        console.warn('[voice-agent]', obj.type, obj);
        if (obj.type === 'Error') cb.current.onError?.(new Error(obj.description || obj.message || 'agent_error'));
        break;

      default:
        break;
    }
  }, [maybeFinaliseSpeech]);

  /* ------------------- connect / close ------------------- */
  const connect = useCallback(async () => {
    if (wsRef.current) return;
    explicitCloseRef.current = false;
    setStatus('connecting');

    const ws = new WebSocket(voiceAgentWsUrl(token));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = async () => {
      setStatus('open');
      // eslint-disable-next-line no-console
      console.log('[BUG3a] voice agent ws OPEN — keeping alive until closeAgent() is called');

      sendJson({
        type: 'Settings',
        audio: {
          input: { encoding: 'linear16', sample_rate: SAMPLE_RATE },
          output: { encoding: 'linear16', sample_rate: SAMPLE_RATE, container: 'none' }
        },
        agent: {
          language: 'en',
          listen: {
            // [polish-transcript] Tuned for interview-style monologues:
            //   - nova-3 = highest-accuracy Deepgram model (still free tier eligible)
            //   - smart_format adds punctuation/capitalization/number formatting
            //   - keyterms biases recognition for common interview/tech vocabulary
            //     (nova-3 'en' only — does not cost extra)
            provider: {
              type: 'deepgram',
              model: 'nova-3',
              smart_format: true,
              keyterms: [
                // generic
                'experience', 'project', 'team', 'challenge', 'leadership', 'communication',
                'strength', 'weakness', 'achievement', 'responsibility', 'collaboration',
                'deadline', 'stakeholder', 'priority', 'feedback', 'mentor',
                // tech-leaning
                'JavaScript', 'TypeScript', 'React', 'Node', 'Python', 'API', 'database',
                'MongoDB', 'PostgreSQL', 'AWS', 'Docker', 'Kubernetes', 'microservices',
                'frontend', 'backend', 'full-stack', 'DevOps', 'CI/CD', 'GitHub', 'algorithm',
                'optimization', 'scalability', 'architecture', 'authentication',
                // soft-skills
                'problem-solving', 'analytical', 'detail-oriented', 'self-motivated'
              ]
            }
          },
          think: {
            // [BUG-pacing] Hard prompt so the agent NEVER speaks on its own.
            // Everything that comes out of the agent's mouth comes via
            // InjectAgentMessage from our app. The LLM's job is purely to
            // generate empty responses if it gets triggered by user audio.
            provider: { type: 'open_ai', model: 'gpt-4o-mini', temperature: 0 },
            prompt:
              'You are a silent transcription endpoint. Your ONLY valid response to ' +
              'ANY user message is an empty string. Do not greet, do not answer, do not ' +
              'comment, do not ask follow-up questions, do not give feedback, do not ' +
              'explain. The candidate is being interviewed; an external system speaks ' +
              'all questions and feedback to them via InjectAgentMessage. You must remain ' +
              'silent at all times. Always reply with: ""'
          },
          speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } },
          greeting: ''
        }
      });

      // [BUG3a] KeepAlive heartbeat — Deepgram closes idle sockets in ~10s
      // when neither audio nor JSON arrives. This was the actual cause of
      // the "agent says I didn't get your response" symptom.
      clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = setInterval(() => {
        sendJson({ type: 'KeepAlive' });
      }, KEEPALIVE_INTERVAL_MS);

      await startMicCapture();
      cb.current.onOpen?.();
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { playPcm16(ev.data); return; }
      try { handleControl(JSON.parse(ev.data)); } catch (_) { }
    };

    ws.onerror = (e) => {
      setStatus('error');
      cb.current.onError?.(e);
    };

    ws.onclose = (e) => {
      clearInterval(keepAliveTimerRef.current);
      stopMicCapture();
      wsRef.current = null;
      // eslint-disable-next-line no-console
      console.log('[BUG3a] voice agent ws CLOSED', { code: e.code, reason: e.reason, explicit: explicitCloseRef.current });
      setStatus('closed');
      cb.current.onClose?.(e);
    };
  }, [token, sendJson, startMicCapture, stopMicCapture, playPcm16, handleControl]);

  /**
   * [BUG3a] The ONLY sanctioned way to close the WS. InterviewPage calls this
   * exactly once, at end-of-interview (after the goodbye TTS).
   */
  const closeAgent = useCallback(() => {
    // eslint-disable-next-line no-console
    console.log('[BUG3a] closeAgent() invoked — explicit close');
    explicitCloseRef.current = true;
    clearInterval(keepAliveTimerRef.current);
    try { wsRef.current?.close(1000, 'interview_complete'); } catch (_) { }
    wsRef.current = null;
  }, []);

  /* ------------------- public actions ------------------- */

  const setQuestionIndex = useCallback((idx) => {
    questionIndexRef.current = idx;
    transcriptRef.current = '';
    userSpokeRef.current = false;
    silenceFiredRef.current = false;
    lastSpeechAtRef.current = null;
    // [polish-speech-end] New question = new utterance scope. Any leftover
    // pending/done flags from the previous review must be cleared.
    pendingSpeechRef.current = false;
    audioDoneSeenRef.current = false;
    sendJson({ type: '__set_question_index', questionIndex: idx });
  }, [sendJson]);

  const speak = useCallback((text) => {
    if (!text) return;
    // [polish-speech-end] Reset speech-end bookkeeping for THIS utterance.
    // Setting pendingSpeechRef = true tells the silence detector to wait —
    // we shouldn't start counting candidate silence while the agent is
    // about to talk. agentSpeakingRef flips true once the first audio chunk
    // actually arrives (see playPcm16).
    pendingSpeechRef.current = true;
    audioDoneSeenRef.current = false;
    lastSpeakAtRef.current = Date.now();
    silenceFiredRef.current = false;
    sendJson({ type: 'InjectAgentMessage', content: text });
  }, [sendJson]);

  const speakQuestion = useCallback((t) => speak(t), [speak]);
  const speakReview = useCallback((t) => speak(t), [speak]);
  const speakGoodbye = useCallback((t) => speak(t), [speak]);

  /**
   * [polish-speech-end] Resolves after the current utterance is fully spoken
   * (both server-side TTS done AND local queue drained). If nothing is in
   * flight, resolves immediately. Used by finishInterview to wait for the
   * goodbye TTS instead of relying on a hardcoded sleep that races the audio.
   *
   * Has a safety timeout so the caller can never wait forever.
   */
  const waitForSpeechEnd = useCallback((timeoutMs = 15000) => {
    return new Promise((resolve) => {
      if (!pendingSpeechRef.current && !agentSpeakingRef.current) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      speakEndWaitersRef.current.push(finish);
      setTimeout(finish, timeoutMs);
    });
  }, []);

  // [BUG3a] Unmount cleanup ONLY closes if the consumer didn't already initiate
  // an explicit close. We DO NOT call ws.close() here — that would close on
  // React StrictMode's dev-mode double-mount and the agent would never speak.
  useEffect(() => () => {
    if (explicitCloseRef.current) {
      stopMicCapture();
    }
    // else: leave the ws + mic capture alive across StrictMode remounts.
  }, [stopMicCapture]);

  return {
    status,
    connect,
    closeAgent,
    setQuestionIndex,
    speakQuestion,
    speakReview,
    speakGoodbye,
    waitForSpeechEnd,
    transcriptRef
  };
}
