import { useRef, useCallback } from 'react';

/**
 * Per-question MediaRecorder wrapper.
 *
 * - Reuses the SAME MediaStream across questions (passed in) — never re-calls getUserMedia.
 * - Recorder is stopped+recreated per question.
 * - Chunks are emitted every 5s and handed to `onChunk(blob, chunkIndex)`.
 *
 * [BUG1] stopRecording() MUST NOT touch stream tracks. Stopping the tracks here
 *        would kill the camera feed for every subsequent question (and for the
 *        Voice Agent mic capture). The tracks are owned by HardwareCheck (zustand
 *        store) and are only stopped at end-of-interview from InterviewPage.
 */
export function useMediaRecorder() {
  const recorderRef = useRef(null);
  const chunkIndexRef = useRef(0);
  const isRecordingRef = useRef(false);

  const start = useCallback((stream, { timeslice = 5000, onChunk }) => {
    if (!stream) throw new Error('useMediaRecorder.start: stream required');
    if (recorderRef.current) {
      try { recorderRef.current.stop(); } catch (_) { }
    }

    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    const mime = candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';

    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunkIndexRef.current = 0;
    isRecordingRef.current = true;

    rec.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      const idx = chunkIndexRef.current++;
      try { onChunk?.(ev.data, idx); } catch (_) { }
    };

    rec.onerror = (e) => {
      // eslint-disable-next-line no-console
      console.error('[MediaRecorder] error', e);
    };

    rec.start(timeslice);
    recorderRef.current = rec;
  }, []);

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state === 'inactive') return;

    // eslint-disable-next-line no-console
    console.log('[BUG1] useMediaRecorder.stop — stopping MediaRecorder only, NOT touching stream tracks');

    // [BUG-tail] Force MediaRecorder to flush its in-memory buffer as one more
    // dataavailable event BEFORE we stop. Without this, every chunk that has
    // accumulated since the last 5s timeslice tick (0–5s of the answer's tail)
    // is silently discarded — including the very last words the candidate said.
    //
    // requestData() synchronously fires `ondataavailable` with whatever bytes
    // are currently buffered, then resets the buffer. We then wait a tick so
    // the handler can enqueue the upload before we call stop().
    try {
      if (typeof rec.requestData === 'function' && rec.state === 'recording') {
        // eslint-disable-next-line no-console
        console.log('[BUG-tail] requestData() — flushing final buffered bytes before stop');
        rec.requestData();
        // Yield to the event loop so ondataavailable handler runs before stop().
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[BUG-tail] requestData() failed (non-fatal):', e.message);
    }

    await new Promise((resolve) => {
      rec.onstop = () => resolve();
      try { rec.stop(); } catch (_) { resolve(); }
    });
    isRecordingRef.current = false;
    recorderRef.current = null;

    // [BUG1] Intentionally NOT calling stream.getTracks().forEach(t => t.stop()).
    // The stream is shared across questions + the Voice Agent mic capture.
  }, []);

  return { start, stop, isRecordingRef };
}
