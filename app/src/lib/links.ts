/** Returns the URL only if it is a well-formed http(s) or mailto URL; otherwise undefined. */
export function safeUrl(raw: unknown, allowMailto = false): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (allowMailto && /^mailto:/i.test(s)) {
    return /^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(s) ? s : undefined;
  }
  let candidate = s;
  // Bare domains like "stepone.life" or "www.x.com/path" → assume https.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    if (/^[^\s/]+\.[^\s/]+/.test(candidate)) candidate = 'https://' + candidate.replace(/^\/+/, '');
    else return undefined;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (!u.hostname) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function mailtoHref(email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined;
  const e = email.trim();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e)) return undefined;
  return safeUrl('mailto:' + e, true);
}

/** Short display form of a URL: hostname + path without protocol / trailing slash. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return u.hostname.replace(/^www\./, '') + path;
  } catch {
    return url;
  }
}
