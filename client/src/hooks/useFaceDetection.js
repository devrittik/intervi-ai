import { useEffect, useRef, useState } from 'react';
import * as faceapi from 'face-api.js';

/**
 * Runs TinyFaceDetector on a <video> element every `intervalMs`.
 *
 * Props:
 *   - videoRef:         ref to a live <video> element
 *   - videoReady:       caller-provided boolean ("the <video> is actually playing").
 *                       Set this from the <video onPlaying> handler. We will *still*
 *                       guard internally on videoWidth > 0 + readyState >= 2, but
 *                       gating on this flag prevents pointless tinyFaceDetector calls
 *                       while the stream is still attaching, which otherwise spam
 *                       face-api with "InvalidStateError: source is empty" errors.
 *   - enabled:          master kill-switch (e.g. interview phase)
 *   - intervalMs:       detection tick (default 1500ms per spec)
 *   - absentThresholdMs:fire onFaceAbsentForSeconds after this many ms of 0 faces
 *
 * Returns:
 *   { ready, modelLoaded, videoReady (echoed), faceCount, error }
 */
export function useFaceDetection({
  videoRef,
  videoReady = false,
  enabled = true,
  intervalMs = 1500,
  absentThresholdMs = 3000,
  onFaceAbsentForSeconds,
  onMultipleFaces
} = {}) {
  const [modelLoaded, setModelLoaded] = useState(false);
  const [faceCount, setFaceCount] = useState(null);
  const [error, setError] = useState(null);

  const absentSinceRef = useRef(null);
  const absentFiredRef = useRef(false);
  const multiFiredRef = useRef(false);

  // Keep latest callbacks in refs so the detector interval doesn't re-bind every render.
  const absentCbRef = useRef(onFaceAbsentForSeconds);
  const multiCbRef = useRef(onMultipleFaces);
  useEffect(() => { absentCbRef.current = onFaceAbsentForSeconds; }, [onFaceAbsentForSeconds]);
  useEffect(() => { multiCbRef.current = onMultipleFaces; }, [onMultipleFaces]);

  /* Load model weights once. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!faceapi.nets.tinyFaceDetector.isLoaded) {
          await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
        }
        if (!cancelled) setModelLoaded(true);
      } catch (err) {
        if (!cancelled) setError(err.message || 'face_model_load_failed');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* Detection loop — gated on modelLoaded + enabled + videoReady. */
  useEffect(() => {
    if (!modelLoaded || !enabled || !videoReady || !videoRef?.current) return;
    let timer = null;
    let cancelled = false;

    const tick = async () => {
      const video = videoRef.current;
      if (!video) return;
      // Double-check the element actually has frames — guards against the corner case
      // where the track ended but `videoReady` is stale.
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

      try {
        const detections = await faceapi.detectAllFaces(
          video,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
        );
        if (cancelled) return;
        const n = detections.length;
        setFaceCount(n);

        if (n === 0) {
          if (absentSinceRef.current == null) absentSinceRef.current = Date.now();
          const dur = Date.now() - absentSinceRef.current;
          if (dur > absentThresholdMs && !absentFiredRef.current) {
            absentFiredRef.current = true;
            absentCbRef.current?.(Math.round(dur / 1000));
          }
        } else {
          absentSinceRef.current = null;
          absentFiredRef.current = false;
        }

        if (n >= 2) {
          if (!multiFiredRef.current) {
            multiFiredRef.current = true;
            multiCbRef.current?.(n);
          }
        } else {
          multiFiredRef.current = false;
        }
      } catch (_) { /* swallow per-frame errors — they'll often be transient */ }
    };

    // Run once immediately so the UI doesn't sit on "Loading…" for 1.5s.
    tick();
    timer = setInterval(tick, intervalMs);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [modelLoaded, enabled, videoReady, videoRef, intervalMs, absentThresholdMs]);

  return {
    ready: modelLoaded && videoReady,
    modelLoaded,
    videoReady,
    faceCount,
    error
  };
}
