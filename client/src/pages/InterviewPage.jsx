import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Stack, LinearProgress, Chip, CircularProgress, Alert, Button
} from '@mui/material';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { api } from '../utils/api';
import { useMediaRecorder } from '../hooks/useMediaRecorder';
import { useProctoring } from '../hooks/useProctoring';
import { useFaceDetection } from '../hooks/useFaceDetection';
import { useVoiceAgent } from '../hooks/useVoiceAgent';
import { useMediaStore } from '../store/mediaStore';

const PHASES = {
  SPEAKING_QUESTION: 'speaking-question',
  THINKING: 'thinking',
  ANSWERING: 'answering',
  UPLOADING: 'uploading',
  REVIEWING: 'reviewing',
  TRANSITIONING: 'transitioning'
};

export default function InterviewPage() {
  const { token } = useParams();
  const navigate = useNavigate();

  const stream = useMediaStore((s) => s.stream);
  const candidateName = useMediaStore((s) => s.candidateName);
  const hardwareReady = useMediaStore((s) => s.hardwareReady);
  const teardownMedia = useMediaStore((s) => s.teardown);

  const videoRef = useRef(null);
  const streamRef = useRef(stream);
  useEffect(() => { streamRef.current = stream; }, [stream]);

  /* ----- [BUG1] callback ref for <video> -----
   *
   * Why a callback ref instead of useRef + useEffect?
   *
   * The page early-returns <CircularProgress /> until `session` loads. That
   * means on first render the <video> element is NOT in the DOM, so
   * videoRef.current is null. A useEffect with deps [stream, questionIndex]
   * runs once on mount with null videoRef, returns early, and never re-fires
   * when the video element actually mounts later — because none of its
   * dependencies changed. Result: srcObject is never bound for Q0, the video
   * stays black, onPlaying never fires, videoReady stays false, face-api sees
   * a black frame, and FACE_ABSENT fires forever.
   *
   * Callback refs fire the instant React mounts/unmounts the element, so we
   * bind srcObject at exactly the right time.
   */
  const setVideoEl = useCallback((el) => {
    videoRef.current = el;
    if (!el) return;
    const s = streamRef.current;
    if (!s) return;
    const tracks = s.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted ? 'muted' : 'unmuted'}`);
    // eslint-disable-next-line no-console
    console.log('[BUG1] callback ref attaching srcObject — tracks=', tracks);
    if (el.srcObject !== s) el.srcObject = s;
    el.play().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[BUG1] video.play() rejected:', err.message);
    });
  }, []);

  const questionsRef = useRef([]);
  const currentQRef = useRef(0);
  const transcriptRef = useRef('');
  const phaseRef = useRef(null);
  const phaseTimerRef = useRef(null);
  const speakStartedRef = useRef(false);
  const answeringStartRef = useRef(null);
  const finishedRef = useRef(false);

  const [session, setSession] = useState(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [phase, setPhase] = useState(PHASES.SPEAKING_QUESTION);
  const [timeLeft, setTimeLeft] = useState(0);
  const [videoReady, setVideoReady] = useState(false);
  const [error, setError] = useState(null);
  const [liveTranscript, setLiveTranscript] = useState('');

  // [BUG2] Visible warning overlay state — auto-dismisses after 3s.
  const [faceWarning, setFaceWarning] = useState(null); // string | null
  const warningTimerRef = useRef(null);

  const phaseRefUpdate = (p) => { phaseRef.current = p; setPhase(p); };

  /* ----- boot guards ----- */
  useEffect(() => {
    if (!hardwareReady || !stream || !stream.getTracks().some((t) => t.readyState === 'live')) {
      navigate(`/interview/${token}`, { replace: true });
      return;
    }
    (async () => {
      try {
        const { data } = await api.get(`/api/sessions/${token}`);
        if (data.isLocked || data.status === 'done') {
          navigate(`/interview/${token}/locked`, { replace: true });
          return;
        }
        setSession(data);
        questionsRef.current = [...data.template.questions].sort((a, b) => a.index - b.index);
        const startIdx = Math.min(data.currentQuestionIndex || 0, questionsRef.current.length - 1);
        setQuestionIndex(startIdx);
        currentQRef.current = startIdx;
      } catch (err) {
        setError(err?.response?.data?.error || err.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- [BUG1] re-attach srcObject on question change -----
   *
   * The callback ref above handles the FIRST mount. This effect handles every
   * subsequent question — between questions we stop + recreate the MediaRecorder,
   * which on some browsers (Chrome especially) detaches the frame pipeline from
   * the <video> srcObject even though the track is still live. Re-binding +
   * calling play() restores the preview.
   */
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    // eslint-disable-next-line no-console
    console.log('[BUG1] (re)attaching srcObject — q=', questionIndex, 'tracks=',
      stream.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted ? 'muted' : 'unmuted'}`));
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[BUG1] video.play() rejected on q change:', err.message);
    });
  }, [stream, questionIndex]);

  /* ----- proctoring socket ----- */
  const { socketRef } = useProctoring({
    token,
    stream,
    currentQuestionIndexRef: currentQRef,
    enabled: !!stream
  });

  /* ----- [BUG2] face detection during the interview ----- */
  const showFaceWarning = useCallback((message) => {
    setFaceWarning(message);
    clearTimeout(warningTimerRef.current);
    warningTimerRef.current = setTimeout(() => setFaceWarning(null), 3000);
  }, []);

  useFaceDetection({
    videoRef,
    videoReady,
    enabled: !!stream && !!session,
    onFaceAbsentForSeconds: () => {
      // eslint-disable-next-line no-console
      console.log('[BUG2] FACE_ABSENT — emitting socket proctoring_event + showing overlay');
      socketRef?.current?.emit('proctoring_event', {
        type: 'FACE_ABSENT',
        questionIndex: currentQRef.current
      });
      // REST fallback for durability.
      api.post(`/api/sessions/${token}/proctor`, {
        type: 'FACE_ABSENT', questionIndex: currentQRef.current
      }).catch(() => { });
      showFaceWarning('Face not detected — please stay in frame');
    },
    onMultipleFaces: () => {
      // eslint-disable-next-line no-console
      console.log('[BUG2] MULTIPLE_FACES — emitting socket proctoring_event + showing overlay');
      socketRef?.current?.emit('proctoring_event', {
        type: 'MULTIPLE_FACES',
        questionIndex: currentQRef.current
      });
      api.post(`/api/sessions/${token}/proctor`, {
        type: 'MULTIPLE_FACES', questionIndex: currentQRef.current
      }).catch(() => { });
      showFaceWarning('Multiple faces detected — please be alone on camera');
    }
  });

  useEffect(() => () => clearTimeout(warningTimerRef.current), []);

  /* ----- media recorder ----- */
  const { start: startRecording, stop: stopRecording } = useMediaRecorder();

  const uploadChunk = useCallback(async (blob, chunkIndex) => {
    // [BUG-chunks] Was: blob.size < 100. MediaRecorder continuation chunks
    // are often only a few hundred bytes when the candidate is quiet; dropping
    // them caused the byte-concatenated WebM to have missing clusters.
    if (!blob || blob.size === 0) return;
    const fd = new FormData();
    fd.append('file', blob, `chunk_${chunkIndex}.webm`);
    fd.append('questionIndex', String(currentQRef.current));
    fd.append('chunkIndex', String(chunkIndex));
    try {
      await api.post(`/api/chunks/${token}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
    } catch (_) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await api.post(`/api/chunks/${token}`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
      } catch (e2) {
        // eslint-disable-next-line no-console
        console.warn('chunk_upload_failed_after_retry', e2.message);
      }
    }
  }, [token]);

  /* ----- voice agent ----- */
  const onAgentSpeechEnd = useCallback(() => {
    const cur = phaseRef.current;
    if (cur === PHASES.SPEAKING_QUESTION) enterThinkingPhase();
    else if (cur === PHASES.REVIEWING) enterTransitionPhase();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* [BUG-pacing] Don't snap to "answer complete" the moment the candidate
   * pauses for a single word. Require:
   *   - we're actually in ANSWERING phase
   *   - the candidate has been talking for at least 15s (was 5s)
   * The silence threshold itself (passed to useVoiceAgent below) is now 8s
   * instead of 4s, so a thoughtful pause to breathe doesn't end the answer.
   */
  const onSilenceDetected = useCallback(() => {
    if (phaseRef.current !== PHASES.ANSWERING) return;
    const elapsed = Date.now() - (answeringStartRef.current || 0);
    if (elapsed < 15000) return;
    // eslint-disable-next-line no-console
    console.log('[BUG-pacing] silence threshold met after', Math.round(elapsed / 1000), 's of answering — finishing answer');
    finishAnswer({ reason: 'silence' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onTranscript = useCallback((text) => {
    transcriptRef.current = text;
    setLiveTranscript(text);
  }, []);

  const voiceAgent = useVoiceAgent({
    token,
    stream,
    onTranscript,
    onAgentSpeechEnd,
    onSilenceDetected,
    silenceThresholdMs: 8000, // [BUG-pacing] was 4000 — too aggressive, agent kept interrupting
    onError: (e) => {
      // eslint-disable-next-line no-console
      console.error('[voice-agent] error', e);
      setError(`Voice agent: ${e?.message || 'connection_error'}`);
    }
  });

  // Connect once session + stream are ready.
  useEffect(() => {
    if (session && stream && voiceAgent.status === 'idle') {
      voiceAgent.connect();
    }
  }, [session, stream, voiceAgent]);

  // First question after agent is open.
  useEffect(() => {
    if (voiceAgent.status === 'open' && session && !speakStartedRef.current) {
      speakStartedRef.current = true;
      setTimeout(() => askQuestion(questionIndex), 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceAgent.status, session]);

  /* ----- phase logic ----- */
  const askQuestion = useCallback((qIdx) => {
    const q = questionsRef.current[qIdx];
    if (!q) return;
    currentQRef.current = qIdx;
    setQuestionIndex(qIdx);
    transcriptRef.current = '';
    setLiveTranscript('');
    phaseRefUpdate(PHASES.SPEAKING_QUESTION);

    voiceAgent.setQuestionIndex(qIdx);
    voiceAgent.speakQuestion(q.text);
  }, [voiceAgent]);

  const enterThinkingPhase = useCallback(() => {
    const q = questionsRef.current[currentQRef.current];
    if (!q) return;
    phaseRefUpdate(PHASES.THINKING);
    let remaining = q.thinkingTime;
    setTimeLeft(remaining);
    clearInterval(phaseTimerRef.current);
    phaseTimerRef.current = setInterval(() => {
      remaining -= 1;
      setTimeLeft(remaining);
      if (remaining <= 0) {
        clearInterval(phaseTimerRef.current);
        enterAnsweringPhase();
      }
    }, 1000);
  }, []);

  const enterAnsweringPhase = useCallback(() => {
    const q = questionsRef.current[currentQRef.current];
    if (!q) return;
    phaseRefUpdate(PHASES.ANSWERING);
    answeringStartRef.current = Date.now();

    startRecording(streamRef.current, {
      timeslice: 5000,
      onChunk: (blob, idx) => uploadChunk(blob, idx)
    });

    let remaining = q.answerTime;
    setTimeLeft(remaining);
    clearInterval(phaseTimerRef.current);
    phaseTimerRef.current = setInterval(() => {
      remaining -= 1;
      setTimeLeft(remaining);
      if (remaining <= 0) {
        clearInterval(phaseTimerRef.current);
        finishAnswer({ reason: 'timer' });
      }
    }, 1000);
  }, [startRecording, uploadChunk]);

  const finishAnswer = useCallback(async () => {
    clearInterval(phaseTimerRef.current);
    phaseRefUpdate(PHASES.UPLOADING);

    await stopRecording();
    await new Promise((r) => setTimeout(r, 2000));

    const q = questionsRef.current[currentQRef.current];
    const transcript = transcriptRef.current || '';
    try {
      await api.post(`/api/sessions/${token}/answer`, {
        questionIndex: currentQRef.current,
        transcript
      });
    } catch (_) { }

    phaseRefUpdate(PHASES.REVIEWING);

    // The backend WS proxy may have already produced a spoken review (BUG3b path).
    // We still call this REST endpoint as a fallback / authoritative result.
    let review;
    try {
      const { data } = await api.post(`/api/sessions/${token}/answer/review`, {
        questionIndex: currentQRef.current,
        questionText: q.text,
        transcript
      });
      review = data;
    } catch (_) {
      // [polish-ack] Short fallback — app advances on its own.
      review = { spokenReview: "Got it." };
    }

    voiceAgent.speakReview(review.spokenReview || "Got it.");
  }, [stopRecording, token, voiceAgent]);

  const enterTransitionPhase = useCallback(() => {
    phaseRefUpdate(PHASES.TRANSITIONING);
    setTimeout(() => {
      const nextIdx = currentQRef.current + 1;
      if (nextIdx >= questionsRef.current.length) finishInterview();
      else askQuestion(nextIdx);
    }, 1000);
  }, [askQuestion]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishInterview = useCallback(async () => {
    if (finishedRef.current) return;
    finishedRef.current = true;

    // [polish-speech-end] Ask the agent to speak the goodbye AND actually wait
    // for the audio to finish playing before we tear anything down. The old
    // hardcoded setTimeout(6500) often fired BEFORE the audio even started
    // playing (Groq/Deepgram round-trip + TTS streaming easily exceeds 6.5s
    // for longer goodbye messages), so the goodbye was cut off mid-word or
    // never heard at all.
    voiceAgent.speakGoodbye(
      `Thank you for completing this interview${candidateName ? `, ${candidateName}` : ''}. We'll be in touch soon. Good luck!`
    );
    try {
      await voiceAgent.waitForSpeechEnd(15000);
    } catch (_) { /* timeout-safe, never throws */ }
    // tiny grace so the last audio buffer's tail fully reaches the speakers
    await new Promise((r) => setTimeout(r, 250));

    // eslint-disable-next-line no-console
    console.log('[BUG4] >> POST /api/sessions/:token/status { status: "completed" }');
    try {
      const resp = await api.post(`/api/sessions/${token}/status`, { status: 'completed' });
      // eslint-disable-next-line no-console
      console.log('[BUG4] << status update OK', resp.status, resp.data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[BUG4] !! status update FAILED', e?.response?.status, e?.response?.data || e.message);
    }

    // [BUG3a] Explicit close — the ONLY sanctioned path that tears down the WS.
    try { voiceAgent.closeAgent(); } catch (_) { }

    // [BUG1] End-of-interview is the ONLY place we stop the stream tracks.
    try {
      // eslint-disable-next-line no-console
      console.log('[BUG1] interview end — stopping all stream tracks');
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch (_) { }

    teardownMedia();
    navigate(`/interview/${token}/done`, { replace: true });
  }, [voiceAgent, token, candidateName, navigate, teardownMedia]);

  useEffect(() => () => { clearInterval(phaseTimerRef.current); }, []);

  /* ----- UI ----- */
  const currentQ = questionsRef.current[questionIndex];
  const totalQ = questionsRef.current.length;

  if (error) return (
    <Centered>
      <Alert severity="error" sx={{ maxWidth: 480 }}>{error}</Alert>
      <Button sx={{ mt: 2 }} onClick={() => navigate(`/interview/${token}`)}>Go back</Button>
    </Centered>
  );
  if (!session || !currentQ) return <Centered><CircularProgress /></Centered>;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar
        candidateName={candidateName || session.candidateName}
        questionIndex={questionIndex}
        totalQ={totalQ}
        voiceStatus={voiceAgent.status}
      />

      <Box sx={{
        flex: 1, display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '1fr 1.4fr' }, gap: 2, p: 2
      }}>
        <Paper sx={{ p: 2 }}>
          <Box sx={{ position: 'relative', borderRadius: 2, overflow: 'hidden', bgcolor: '#000', aspectRatio: '16/9' }}>
            <video
              ref={setVideoEl}
              muted
              playsInline
              autoPlay
              onPlaying={() => {
                // eslint-disable-next-line no-console
                console.log('[BUG1] <video> onPlaying — videoReady=true');
                setVideoReady(true);
              }}
              onCanPlay={() => {
                if (!videoReady) {
                  // eslint-disable-next-line no-console
                  console.log('[BUG1] <video> onCanPlay — videoReady=true');
                  setVideoReady(true);
                }
              }}
              onLoadedMetadata={() => {
                // eslint-disable-next-line no-console
                console.log('[BUG1] <video> onLoadedMetadata');
              }}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            {phase === PHASES.ANSWERING && (
              <Chip icon={<FiberManualRecordIcon sx={{ color: '#ef4444 !important' }} />}
                label="RECORDING" size="small"
                sx={{ position: 'absolute', top: 12, left: 12, bgcolor: 'rgba(0,0,0,0.6)' }} />
            )}
            {phase === PHASES.SPEAKING_QUESTION && (
              <Chip icon={<RecordVoiceOverIcon />}
                label="AI is speaking" size="small"
                sx={{ position: 'absolute', top: 12, left: 12, bgcolor: 'rgba(0,0,0,0.6)' }} />
            )}

            {/* [BUG2] visible warning overlay, auto-dismissed after 3s */}
            {faceWarning && (
              <Alert
                severity="warning"
                icon={<WarningAmberIcon />}
                sx={{
                  position: 'absolute',
                  left: 12, right: 12, bottom: 12,
                  bgcolor: 'rgba(180, 83, 9, 0.92)',
                  color: '#fff',
                  '& .MuiAlert-icon': { color: '#fff' }
                }}
              >
                {faceWarning}
              </Alert>
            )}
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Voice Agent: {voiceAgent.status} · Video: {videoReady ? 'ready' : 'loading'}
          </Typography>
        </Paper>

        <Paper sx={{ p: 4, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="overline" color="text.secondary">
              Question {questionIndex + 1} of {totalQ}
            </Typography>
            <Typography variant="h4" sx={{ mt: 1, mb: 3 }}>{currentQ.text}</Typography>

            <PhaseDisplay
              phase={phase}
              timeLeft={timeLeft}
              question={currentQ}
              liveTranscript={liveTranscript}
            />
          </Box>

          <Stack direction="row" spacing={1} sx={{ mt: 4 }}>
            {questionsRef.current.map((_, i) => (
              <Box key={i} sx={{
                flex: 1, height: 4, borderRadius: 2,
                bgcolor: i < questionIndex ? 'success.main' : i === questionIndex ? 'primary.main' : 'rgba(255,255,255,0.1)'
              }} />
            ))}
          </Stack>
        </Paper>
      </Box>
    </Box>
  );
}

function PhaseDisplay({ phase, timeLeft, question, liveTranscript }) {
  if (phase === PHASES.SPEAKING_QUESTION) return <Info label="AI Interviewer is asking the question…" />;
  if (phase === PHASES.THINKING) return (
    <Stack spacing={1}>
      <Info label={`Take a moment to think — ${timeLeft}s`} />
      <LinearProgress variant="determinate" value={((question.thinkingTime - timeLeft) / question.thinkingTime) * 100} />
    </Stack>
  );
  if (phase === PHASES.ANSWERING) return (
    <Stack spacing={2}>
      <Info label={`Answer now — ${timeLeft}s remaining`} accent />
      <LinearProgress variant="determinate" color="error" value={((question.answerTime - timeLeft) / question.answerTime) * 100} />
      {liveTranscript && (
        <Paper variant="outlined" sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.02)' }}>
          <Typography variant="caption" color="text.secondary">Live transcript</Typography>
          <Typography variant="body2">{liveTranscript}</Typography>
        </Paper>
      )}
    </Stack>
  );
  if (phase === PHASES.UPLOADING) return <Info label="Uploading your answer…" loading />;
  if (phase === PHASES.REVIEWING) return <Info label="Reviewing your answer…" loading />;
  if (phase === PHASES.TRANSITIONING) return <Info label="Next question coming up…" loading />;
  return null;
}

function Info({ label, loading, accent }) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center">
      {loading && <CircularProgress size={18} />}
      <Typography variant="subtitle1" color={accent ? 'error' : 'text.primary'}>{label}</Typography>
    </Stack>
  );
}

function TopBar({ candidateName, questionIndex, totalQ, voiceStatus }) {
  return (
    <Box sx={{
      px: 3, py: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      borderBottom: '1px solid rgba(255,255,255,0.06)'
    }}>
      <Typography variant="h6">AI Video Interview</Typography>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="body2" color="text.secondary">
          {candidateName} • Question {questionIndex + 1}/{totalQ}
        </Typography>
        <Chip size="small" label={voiceStatus} color={voiceStatus === 'open' ? 'success' : 'default'} />
      </Stack>
    </Box>
  );
}

function Centered({ children }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
      {children}
    </Box>
  );
}
