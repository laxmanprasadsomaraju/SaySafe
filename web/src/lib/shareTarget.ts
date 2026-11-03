/**
 * Android "Share to SaySafe" (Web Share Target, GET). The manifest sends shares to
 * /check/share?title=…&text=…&url=…. We only PREFILL the check box; nothing is submitted.
 * Works only in Chrome on Android after the app is installed. Not supported on iOS.
 */
const KEY = 'ss-shared-text';
const MAX = 8000;

/** Join title/text/url, drop duplicates (Android often puts the URL inside text), strip control characters. */
export function combineSharedParams(p: URLSearchParams): string {
  const parts: string[] = [];
  for (const k of ['title', 'text', 'url']) {
    const v = (p.get(k) ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').trim();
    if (v && !parts.some((x) => x.includes(v))) parts.push(v);
  }
  return parts.join('\n').slice(0, MAX);
}

/** Read a shared message once. Kept in sessionStorage so it survives the sign-in redirect. */
export function takeSharedText(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    if (window.location.pathname === '/check/share') {
      const t = combineSharedParams(new URLSearchParams(window.location.search));
      window.history.replaceState(null, '', '/check');
      if (t) sessionStorage.setItem(KEY, t);
    }
    const t = sessionStorage.getItem(KEY);
    if (t) sessionStorage.removeItem(KEY);
    return t || null;
  } catch {
    return null;
  }
}
