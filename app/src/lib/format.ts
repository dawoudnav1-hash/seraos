export const DASH = '—';

export function formatRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return DASH;
  const pct = rate * 100;
  return (pct >= 10 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)) + '%';
}

export function formatInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return n.toLocaleString('en-AU');
}

const dateFmt = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const shortFmt = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' });

export function formatDate(t: number | null | undefined): string {
  if (t == null || !Number.isFinite(t)) return DASH;
  return dateFmt.format(new Date(t));
}
export function formatDateTime(t: number | null | undefined): string {
  if (t == null || !Number.isFinite(t)) return DASH;
  return dateTimeFmt.format(new Date(t));
}
export function formatShortDate(t: number): string {
  return shortFmt.format(new Date(t));
}

/** "3d ago", "just now" etc. */
export function relativeTime(t: number | null | undefined, now = Date.now()): string {
  if (t == null || !Number.isFinite(t)) return DASH;
  const diff = now - t;
  const abs = Math.abs(diff);
  const m = 60_000,
    h = 60 * m,
    d = 24 * h;
  const fut = diff < 0;
  const f = (v: number, u: string) => (fut ? `in ${v}${u}` : `${v}${u} ago`);
  if (abs < m) return 'just now';
  if (abs < h) return f(Math.floor(abs / m), 'm');
  if (abs < d) return f(Math.floor(abs / h), 'h');
  if (abs < 30 * d) return f(Math.floor(abs / d), 'd');
  return formatDate(t);
}

export function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0]!)[0] ?? '';
  const second = parts.length > 1 ? (Array.from(parts[parts.length - 1]!)[0] ?? '') : '';
  return (first + second).toUpperCase() || '?';
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}
