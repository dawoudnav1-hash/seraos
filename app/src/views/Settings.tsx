import { useRef, useState, type ChangeEvent } from 'react';
import { ConfirmDialog, Icon } from '../components/ui';
import { dateStamp, downloadText } from '../lib/csv';
import { parseImport } from '../lib/events';
import { formatDateTime, formatInt } from '../lib/format';
import { useAppData } from '../state/AppData';

export function Settings() {
  const { accounts, outreach, manualEvents, generatedEvents, importManualEvents, clearManualEvents, storageOk, warnings, toast } = useAppData();
  const [confirmClear, setConfirmClear] = useState(false);
  const [importMsg, setImportMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const contacts = accounts.reduce((n, a) => n + a.contacts.length, 0);
  const generatedAt = outreach.generatedAt ? Date.parse(outreach.generatedAt) : NaN;

  const exportJson = () => {
    const payload = { exportedAt: new Date().toISOString(), app: 'seraos-prospects', events: manualEvents };
    downloadText(`seraos-manual-events-${dateStamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setImportMsg({ tone: 'error', text: 'File is larger than 20 MB — refusing to import.' });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportMsg({ tone: 'error', text: 'Could not read the file.' });
      return;
    }
    const parsed = parseImport(text);
    if (parsed.error) {
      setImportMsg({ tone: 'error', text: parsed.error });
      return;
    }
    const { added, skipped } = importManualEvents(parsed.events);
    const parts = [`Imported ${added} event${added === 1 ? '' : 's'}.`];
    if (skipped) parts.push(`${skipped} already present (same id) skipped.`);
    if (parsed.rejected) parts.push(`${parsed.rejected} invalid entr${parsed.rejected === 1 ? 'y' : 'ies'} rejected.`);
    setImportMsg({ tone: 'ok', text: parts.join(' ') });
  };

  return (
    <div className="page settings">
      <div className="page-head">
        <div>
          <h1>Data & settings</h1>
          <p className="page-sub">Manual events live only in this browser. Export them regularly to keep a backup.</p>
        </div>
      </div>

      {!storageOk && (
        <p className="note note-warn" role="alert">
          <Icon name="alert" size={12} /> Browser storage is unavailable (private mode or blocked). Events you log will be lost on reload — export them before
          closing the tab.
        </p>
      )}
      {warnings.length > 0 && (
        <div className="note note-warn" role="alert">
          <Icon name="alert" size={12} />
          <div>
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        </div>
      )}

      <div className="grid-2">
        <section className="card">
          <header className="card-head">
            <h2>Manual events</h2>
            <span className="muted small" data-testid="manual-count">
              {formatInt(manualEvents.length)} stored
            </span>
          </header>
          <div className="card-body settings-actions">
            <div className="setting">
              <div>
                <div className="strong">Export</div>
                <div className="muted small">Download every manually logged event as JSON.</div>
              </div>
              <button type="button" className="btn" onClick={exportJson} disabled={!manualEvents.length} data-testid="export-json">
                <Icon name="download" /> Export JSON
              </button>
            </div>
            <div className="setting">
              <div>
                <div className="strong">Import</div>
                <div className="muted small">Merge events from a JSON export. Entries are validated; ids already present are skipped.</div>
              </div>
              <button type="button" className="btn" onClick={() => fileRef.current?.click()} data-testid="import-json">
                <Icon name="upload" /> Import JSON
              </button>
              <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFile} data-testid="import-file" />
            </div>
            {importMsg && (
              <p className={'note ' + (importMsg.tone === 'error' ? 'note-warn' : 'note-ok')} role="status" data-testid="import-msg">
                {importMsg.text}
              </p>
            )}
            <div className="setting">
              <div>
                <div className="strong">Clear</div>
                <div className="muted small">Delete all manual events from this browser. Generated data is not affected.</div>
              </div>
              <button type="button" className="btn btn-danger-outline" onClick={() => setConfirmClear(true)} disabled={!manualEvents.length} data-testid="clear-manual">
                <Icon name="trash" /> Clear…
              </button>
            </div>
          </div>
        </section>

        <section className="card">
          <header className="card-head">
            <h2>Generated data</h2>
          </header>
          <div className="card-body">
            <dl className="coverage">
              <div>
                <dt>Generated at</dt>
                <dd data-testid="generated-at">{Number.isFinite(generatedAt) ? formatDateTime(generatedAt) : outreach.generatedAt ?? 'unknown'}</dd>
              </div>
              <div>
                <dt>Accounts</dt>
                <dd>{formatInt(accounts.length)}</dd>
              </div>
              <div>
                <dt>Contacts</dt>
                <dd>{formatInt(contacts)}</dd>
              </div>
              <div>
                <dt>Outreach events (generated)</dt>
                <dd>{formatInt(generatedEvents.length)}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>

      <section className="card">
        <header className="card-head">
          <h2>Outreach sources</h2>
        </header>
        <div className="card-body">
          {outreach.sources.length ? (
            <ul className="source-notes">
              {outreach.sources.map((s, i) => (
                <li key={i}>
                  <div className="strong">{s.name}</div>
                  <div className="muted">{s.detail}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No source notes in outreach.json.</p>
          )}
          <p className="muted small">
            Data is produced by <code>pipeline/build_data.py</code> into <code>app/src/data/</code> and bundled into this page at build time.
          </p>
        </div>
      </section>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all manual events?"
        body={
          <>
            This permanently deletes {formatInt(manualEvents.length)} manually logged event{manualEvents.length === 1 ? '' : 's'} from this browser. Export them
            first if you might need them.
          </>
        }
        confirmLabel="Delete events"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          clearManualEvents();
          setConfirmClear(false);
          toast({ message: 'All manual events cleared.' });
        }}
      />
    </div>
  );
}
