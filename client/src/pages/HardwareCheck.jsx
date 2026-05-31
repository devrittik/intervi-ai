import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, TextField, Button, LinearProgress,
  Stack, Chip, Alert, CircularProgress
} from '@mui/material';
import VideocamIcon from '@mui/icons-material/Videocam';
import MicIcon from '@mui/icons-material/Mic';
import FaceIcon from '@mui/icons-material/Face';
import CheckIcon from '@mui/icons-material/CheckCircle';
import { api } from '../utils/api';
import { useFaceDetection } from '../hooks/useFaceDetection';
import { useMediaStore } from '../store/mediaStore';

export default function HardwareCheck() {
  const { token } = useParams();
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const analyserRef = useRef(null);
  const audioCtxRef = useRef(null);
  const rafRef = useRef(null);

  // Stream lives in zustand — not router state. MediaStream isn't structured-cloneable,
  // so React Router would silently drop it on navigation.
  const storedStream = useMediaStore((s) => s.stream);
  const setStream = useMediaStore((s) => s.setStream);
  const setStoredName = useMediaStore((s) => s.setCandidateName);
  const setHardwareReady = useMediaStore((s) => s.setHardwareReady);
  const teardownStore = useMediaStore((s) => s.teardown);

  const [bootError, setBootError] = useState(null);
  const [session, setSession] = useState(null);
  const [cameraOk, setCameraOk] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const proceedingRef = useRef(false);

  /* ----- boot session ----- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/api/sessions/${token}`);
        if (cancelled) return;
        if (data.isLocked || ['done', 'completed', 'processing'].includes(data.status)) {
          navigate(`/interview/${token}/locked`, { replace: true });
          return;
        }
        setSession(data);
        setName(data.candidateName || '');
      } catch (err) {
        const code = err?.response?.status;
        if (code === 404 || code === 410) navigate(`/interview/${token}/locked`, { replace: true });
        else setBootError(err?.response?.data?.error || err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [token, navigate]);

  /* ----- acquire MediaStream ONCE ----- */
  useEffect(() => {
    let cancelled = false;

    const reuse = storedStream && storedStream.getTracks().some((t) => t.readyState === 'live');

    (async () => {
      let stream = null;
      try {
        if (reuse) {
          stream = storedStream;
        } else {
          // If a dead stream lingers in the store, clear it first.
          if (storedStream) teardownStore();
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720 },
            audio: { echoCancellation: true, noiseSuppression: true }
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          setStream(stream);
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // play() returns a promise; we don't await — the onPlaying handler flips videoReady.
          videoRef.current.play().catch(() => {});
        }
        setCameraOk(true);

        /* mic analyser for level bar */
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const loop = () => {
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = sum / data.length;
          setMicLevel(Math.min(100, Math.round((avg / 140) * 100)));
          rafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        setBootError(`camera_or_mic_denied: ${err.message}`);
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch (_) {} }

      // Critical: do NOT stop the stream when navigating into the interview.
      // Only stop it if the user abandoned the hardware check entirely (proceedingRef=false).
      if (!proceedingRef.current) {
        // We still keep the stream in the store so a re-mount of this page can reuse it.
        // The store's teardown() is only called on actual interview completion or hard-exit.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- face detection — gated on videoReady ----- */
  const { modelLoaded, videoReady: vr, faceCount, error: faceErr } = useFaceDetection({
    videoRef,
    videoReady,
    enabled: cameraOk
  });

  const faceOk = modelLoaded && vr && faceCount === 1;
  const readyToStart = cameraOk && videoReady && faceOk && name.trim().length >= 2 && !submitting;

  const handleStart = async () => {
    if (!readyToStart) return;
    setSubmitting(true);
    try {
      await api.post(`/api/sessions/${token}/status`, { status: 'in_progress' });
    } catch (err) {
      if (err?.response?.status === 409) {
        navigate(`/interview/${token}/locked`, { replace: true });
        return;
      }
    }
    setStoredName(name.trim());
    setHardwareReady(true);
    proceedingRef.current = true; // tells cleanup not to stop tracks
    navigate(`/interview/${token}/run`, { replace: true });
  };

  if (bootError) {
    return (
      <Centered>
        <Alert severity="error" sx={{ maxWidth: 480 }}>
          Could not load this interview: {bootError}
        </Alert>
      </Centered>
    );
  }
  if (!session) return <Centered><CircularProgress /></Centered>;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ p: 4, width: '100%', maxWidth: 1024 }}>
        <Typography variant="h4" sx={{ mb: 1 }}>Hardware Check</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          {session.template.title} — {session.template.role}
        </Typography>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.4fr 1fr' }, gap: 3 }}>
          <Box>
            <Box sx={{ position: 'relative', borderRadius: 2, overflow: 'hidden', bgcolor: '#000', aspectRatio: '16/9' }}>
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                onPlaying={() => setVideoReady(true)}
                onLoadedMetadata={() => setVideoReady(true)}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <Chip
                icon={<FaceIcon />}
                color={faceOk ? 'success' : 'warning'}
                label={
                  !videoReady ? 'Starting camera…'
                  : !modelLoaded ? 'Loading face model…'
                  : faceCount == null ? 'Scanning…'
                  : faceCount === 1 ? 'Face detected'
                  : faceCount === 0 ? 'No face detected'
                  : `${faceCount} faces`
                }
                sx={{ position: 'absolute', top: 12, left: 12 }}
              />
            </Box>
            {faceErr && <Alert severity="warning" sx={{ mt: 1 }}>Face model failed to load: {faceErr}</Alert>}
          </Box>

          <Stack spacing={3}>
            <CheckRow icon={<VideocamIcon />} label="Camera" ok={cameraOk && videoReady} />
            <Box>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <MicIcon /> <Typography variant="body2">Microphone level</Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={micLevel}
                color={micLevel > 5 ? 'success' : 'warning'}
                sx={{ height: 10, borderRadius: 5 }}
              />
              <Typography variant="caption" color="text.secondary">Speak to test your mic.</Typography>
            </Box>

            <TextField
              label="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              fullWidth
              autoComplete="name"
            />

            <Button
              variant="contained"
              size="large"
              disabled={!readyToStart}
              onClick={handleStart}
              startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : <CheckIcon />}
            >
              I'm ready — start interview
            </Button>
            <Typography variant="caption" color="text.secondary">
              By starting, you consent to being recorded for hiring evaluation purposes.
            </Typography>
          </Stack>
        </Box>
      </Paper>
    </Box>
  );
}

function Centered({ children }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </Box>
  );
}

function CheckRow({ icon, label, ok }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      {icon}
      <Typography>{label}</Typography>
      <Chip size="small" label={ok ? 'OK' : 'Waiting'} color={ok ? 'success' : 'default'} />
    </Stack>
  );
}
