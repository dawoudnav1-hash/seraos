import { Fragment, useId, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { formatDate } from '../lib/format';
import { displayUrl, safeUrl } from '../lib/links';
import { CATEGORY_LABEL, CLAIM_CATEGORIES, RESEARCH_STATUS_LABEL, SOURCE_TYPE_LABEL, sourceNumbers } from '../lib/research';
import type { Dossier, ResearchClaim, ResearchSourceType } from '../types';
import { useModal } from './dialog';
import { Badge, Icon, LinkedInLink } from './ui';

const STATUS_TONE: Record<Dossier['status'], string> = { complete: 'ok', thin: 'caution', identity_unconfirmed: 'warn' };

const TYPE_ICON: Record<ResearchSourceType, 'globe' | 'linkedin' | 'mail' | 'user' | 'calendar' | 'link' | 'eye'> = {
  website: 'globe',
  blog: 'link',
  podcast: 'eye',
  video: 'eye',
  linkedin: 'linkedin',
  facebook: 'user',
  instagram: 'user',
  news: 'calendar',
  job: 'user',
  directory: 'link',
  registry: 'link',
  other: 'link',
};

/** "[1][2]" citation links for a claim, each opening the source in a new tab. */
export function Citations({ claim, dossier, numbers }: { claim: ResearchClaim; dossier: Dossier; numbers: Map<string, number> }) {
  return (
    <span className="citations">
      {claim.sourceIds.map((sid) => {
        const src = dossier.sources.find((s) => s.id === sid);
        const n = numbers.get(sid);
        const url = safeUrl(src?.url);
        if (!src || n == null) return null;
        const label = `Source ${n}: ${src.title ?? src.publisher ?? displayUrl(src.url)}`;
        return url ? (
          <a key={sid} className="cite" href={url} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
            [{n}]
          </a>
        ) : (
          <span key={sid} className="cite" title={label}>
            [{n}]
          </span>
        );
      })}
    </span>
  );
}

/** "C2 C5" buttons that scroll to the claims inside the panel (no hash change, so routing is untouched). */
function ClaimRefs({ ids, scope }: { ids: readonly string[]; scope: string }) {
  if (!ids.length) return null;
  const go = (id: string) => {
    const el = document.getElementById(`${scope}-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1200);
  };
  return (
    <span className="claim-refs">
      {ids.map((id) => (
        <button key={id} type="button" className="claim-ref" onClick={() => go(id)} title={`Show claim ${id}`}>
          {id}
        </button>
      ))}
    </span>
  );
}

export function ResearchPanel({ dossier, accountName, onClose }: { dossier: Dossier; accountName: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const scope = useId().replace(/:/g, '');
  useModal(ref, true, onClose, closeRef);
  const numbers = useMemo(() => sourceNumbers(dossier), [dossier]);
  const groups = useMemo(
    () => CLAIM_CATEGORIES.map((cat) => [cat, dossier.claims.filter((c) => c.category === cat)] as const).filter(([, list]) => list.length),
    [dossier],
  );
  const researched = dossier.researchedAt ? Date.parse(dossier.researchedAt) : NaN;

  return createPortal(
    <div className="modal-backdrop panel-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="side-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} data-testid="research-panel">
        <header className="side-panel-head">
          <div>
            <div className="eyebrow">Research dossier</div>
            <h2 id={titleId}>{dossier.accountName ?? accountName}</h2>
            <div className="badges">
              <Badge tone={STATUS_TONE[dossier.status]}>{RESEARCH_STATUS_LABEL[dossier.status]}</Badge>
              <span className="muted small">
                Researched {Number.isFinite(researched) ? formatDate(researched) : 'date unknown'} · {dossier.claims.length} claims · {dossier.sources.length} sources
              </span>
            </div>
          </div>
          <button type="button" className="icon-btn panel-close" onClick={onClose} ref={closeRef} aria-label="Close research" data-testid="research-close">
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="side-panel-body">
          {dossier.summary && (
            <section className="rp-section">
              <h3>Summary</h3>
              <p className="rp-summary">{dossier.summary}</p>
            </section>
          )}

          {dossier.people.length > 0 && (
            <section className="rp-section">
              <h3>People</h3>
              <ul className="rp-people">
                {dossier.people.map((p, i) => (
                  <li key={i}>
                    <span className="name">{p.name}</span>
                    {p.title && <span className="muted"> · {p.title}</span>}
                    {p.linkedin && <LinkedInLink href={p.linkedin} name={p.name} />}
                    <ClaimRefs ids={p.claimIds} scope={scope} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {dossier.hooks.length > 0 && (
            <section className="rp-section">
              <h3>Hooks</h3>
              <ol className="rp-hooks">
                {dossier.hooks.map((h, i) => (
                  <li key={i}>
                    <span>{h.text}</span> <ClaimRefs ids={h.claimIds} scope={scope} />
                  </li>
                ))}
              </ol>
            </section>
          )}

          {dossier.risks.length > 0 && (
            <section className="rp-section">
              <h3>Risks</h3>
              <ul className="rp-risks">
                {dossier.risks.map((r, i) => (
                  <li key={i} className="flag flag-warn" role="note">
                    <Icon name="alert" size={13} />
                    <span>
                      {r.text} <ClaimRefs ids={r.claimIds} scope={scope} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rp-section">
            <h3>Claims ({dossier.claims.length})</h3>
            {groups.length === 0 && <p className="muted">No sourced claims.</p>}
            {groups.map(([cat, list]) => (
              <div key={cat} className="rp-claim-group">
                <h4>{CATEGORY_LABEL[cat]}</h4>
                <ul className="rp-claims">
                  {list.map((c) => (
                    <li key={c.id} id={`${scope}-${c.id}`} className="rp-claim" data-testid="research-claim">
                      <div className="rp-claim-text">
                        <span className="claim-id">{c.id}</span> {c.text} <Citations claim={c} dossier={dossier} numbers={numbers} />
                      </div>
                      {c.quote && <blockquote className="rp-quote">“{c.quote}”</blockquote>}
                      <div className="rp-claim-meta muted small">
                        {c.date ?? 'undated'} · {c.confidence} confidence
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <section className="rp-section">
            <h3>Sources ({dossier.sources.length})</h3>
            <ol className="rp-sources" data-testid="research-sources">
              {dossier.sources.map((s) => {
                const url = safeUrl(s.url);
                return (
                  <li key={s.id} value={numbers.get(s.id)}>
                    <span className={`src-type src-${s.type}`} title={SOURCE_TYPE_LABEL[s.type]}>
                      <Icon name={TYPE_ICON[s.type]} size={12} /> {SOURCE_TYPE_LABEL[s.type]}
                    </span>
                    <div className="rp-source-main">
                      <span className="rp-source-title">{s.title ?? displayUrl(s.url)}</span>
                      <span className="muted small">
                        {[s.publisher, s.date ?? undefined].filter(Boolean).join(' · ')}
                        {(s.publisher || s.date) && ' · '}
                        {url ? (
                          <a href={url} target="_blank" rel="noopener noreferrer">
                            {displayUrl(url)}
                          </a>
                        ) : (
                          s.url
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <details className="rp-section rp-method">
            <summary>
              Method — {dossier.gaps.length} gap{dossier.gaps.length === 1 ? '' : 's'}, {dossier.searches.length} search{dossier.searches.length === 1 ? '' : 'es'}
            </summary>
            {dossier.gaps.length > 0 && (
              <>
                <h4>Gaps</h4>
                <ul className="rp-gaps">
                  {dossier.gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </>
            )}
            {dossier.searches.length > 0 && (
              <>
                <h4>Searches</h4>
                <table className="mini-table rp-searches">
                  <thead>
                    <tr>
                      <th scope="col">Query</th>
                      <th scope="col" className="num">
                        Results
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dossier.searches.map((s, i) => (
                      <Fragment key={i}>
                        <tr>
                          <td>{s.query}</td>
                          <td className="num">{s.results}</td>
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </details>
        </div>
      </div>
    </div>,
    document.body,
  );
}
