export type CsvValue = string | number | boolean | null | undefined;

/** RFC 4180 escaping + spreadsheet formula-injection guard for text cells. */
export function csvCell(v: CsvValue): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

type DownloadsApi = { save(req: { filename: string; data: string | Blob }): Promise<unknown> };
type HostedClaude = { use?: (name: string) => Promise<unknown> };

/** On a claude.ai-hosted page, file saves go through the viewer's `downloads` capability. */
async function hostedDownloads(): Promise<DownloadsApi | null> {
  const c = (window as unknown as { claude?: HostedClaude }).claude;
  if (!c || typeof c.use !== 'function') return null;
  try {
    const api = (await c.use('downloads')) as DownloadsApi | null;
    return api && typeof api.save === 'function' ? api : null;
  } catch {
    return null;
  }
}

function browserDownload(filename: string, body: string, mime: string): void {
  try {
    const blob = new Blob([body], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // Download not supported (very old browser / sandbox) — the Copy buttons are the fallback.
  }
}

/**
 * Saves a text file. Prepends a BOM for CSV so Excel opens UTF-8 correctly.
 * Uses the host's save dialog when the page is hosted on claude.ai, otherwise a normal browser download.
 * Resolves false only when a hosted save was declined or failed.
 */
export async function downloadText(filename: string, text: string, mime: string): Promise<boolean> {
  const body = mime.startsWith('text/csv') ? '\uFEFF' + text : text;
  const hosted = await hostedDownloads();
  if (hosted) {
    try {
      await hosted.save({ filename, data: body });
      return true;
    } catch {
      return false;
    }
  }
  browserDownload(filename, body, mime);
  return true;
}

export function dateStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Copies text to the clipboard. Used next to every download button because sandboxed
 * hosts (e.g. an embedded/hosted page) can block file downloads silently.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
