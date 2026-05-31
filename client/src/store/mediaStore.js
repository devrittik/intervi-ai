import { create } from 'zustand';

/**
 * In-memory store for the live MediaStream + interview-scoped context.
 *
 * Why a store and not router state?
 * - React Router persists location.state in window.history.state via structured cloning.
 *   MediaStream / MediaStreamTrack are NOT structured-cloneable, so the stream gets
 *   dropped silently on navigation — that's why the video preview went blank on the
 *   interview page. Holding the stream in a module-scoped zustand store keeps the same
 *   reference alive across route transitions.
 * - Not persisted to localStorage — we explicitly want this gone on full reload.
 */
export const useMediaStore = create((set, get) => ({
  stream: null,
  candidateName: '',
  hardwareReady: false,

  setStream: (stream) => set({ stream }),
  setCandidateName: (candidateName) => set({ candidateName }),
  setHardwareReady: (hardwareReady) => set({ hardwareReady }),

  /**
   * Fully tear down: stop tracks + clear store.
   * Call this on interview completion or hard-exit.
   */
  teardown: () => {
    const { stream } = get();
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
    }
    set({ stream: null, candidateName: '', hardwareReady: false });
  }
}));
