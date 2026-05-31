import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { backendOrigin } from '../utils/api';

/**
 * Wires up:
 *   - Socket.IO connection (joins session room)
 *   - Browser proctoring listeners (visibilitychange, blur, fullscreen, copy/paste)
 *   - Track-ended listeners for camera/mic disconnect
 *
 * All events go through socket.emit('proctoring_event', {...}).
 * `currentQuestionIndexRef` is a ref so we can tag events with the active question without re-binding listeners.
 */
export function useProctoring({ token, stream, currentQuestionIndexRef, enabled = true }) {
  const socketRef = useRef(null);

  useEffect(() => {
    if (!enabled || !token) return;

    const socket = io(backendOrigin(), {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join_session', { token });
    });
    socket.on('reconnect', () => {
      socket.emit('join_session', { token });
      emit('RECONNECT');
    });

    const emit = (type, metadata) => {
      try {
        socket.emit('proctoring_event', {
          type,
          questionIndex: currentQuestionIndexRef?.current ?? null,
          metadata: metadata || {}
        });
      } catch (_) { /* ignore */ }
    };

    /* ---- browser listeners ---- */
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') emit('TAB_SWITCH');
    };
    const onBlur = () => emit('WINDOW_BLUR');
    const onFsChange = () => {
      if (!document.fullscreenElement) emit('FULLSCREEN_EXIT');
    };
    const onCopy = () => emit('COPY_PASTE', { kind: 'copy' });
    const onPaste = () => emit('COPY_PASTE', { kind: 'paste' });

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);

    /* ---- track-ended listeners (camera/mic unplug or revoked permission) ---- */
    const unbindTracks = [];
    if (stream) {
      stream.getTracks().forEach((track) => {
        const handler = () => {
          if (track.kind === 'video') emit('CAMERA_DISCONNECT', { label: track.label });
          else if (track.kind === 'audio') emit('MIC_DISCONNECT', { label: track.label });
        };
        track.addEventListener('ended', handler);
        unbindTracks.push(() => track.removeEventListener('ended', handler));
      });
    }

    // Expose emit on the socket for one-off external calls (rare, but handy).
    socket.emitProctoring = emit;

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
      unbindTracks.forEach((f) => f());
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, stream, enabled, currentQuestionIndexRef]);

  return { socketRef };
}
