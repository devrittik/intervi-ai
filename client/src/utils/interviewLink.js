/**
 * Build the candidate-facing interview URL from a session token.
 *
 * Resolution order:
 *   1. VITE_PUBLIC_INTERVIEW_BASE — explicit override (e.g. https://app.example.com)
 *   2. window.location.origin     — defaults to whatever the recruiter is currently on
 *
 * Returns the full `/interview/:token` URL.
 */
export function buildInterviewLink(token) {
  if (!token) return '';
  const base = import.meta.env.VITE_PUBLIC_INTERVIEW_BASE || window.location.origin;
  return `${base.replace(/\/+$/, '')}/interview/${token}`;
}

/**
 * Copy `text` to the clipboard.
 * Uses the async Clipboard API where available, with an execCommand fallback
 * for older browsers / non-secure contexts.
 *
 * Returns a promise that resolves true on success.
 */
export async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through */ }

  // Fallback for http:// / older browsers.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}
