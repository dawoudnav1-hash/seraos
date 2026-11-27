import { useEffect, useRef, useState } from 'react';
import { formatInt, formatShortDate } from '../lib/format';
import type { FunnelStage, WeekBucket } from '../lib/stats';

export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

/**
 * Grouped weekly bars: left bar = messages sent, right bar = replies; each stacked by channel
 * (email bottom, LinkedIn top). Replies are hatched so sent/replies never rely on position alone.
 */
export function WeeklyChart({ weeks }: { weeks: WeekBucket[] }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const pad = { l: 32, r: 8, t: 12, b: 26 };
  const innerW = Math.max(0, width - pad.l - pad.r);
  const innerH = height - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...weeks.map((w) => Math.max(w.sentEmail + w.sentLinkedin, w.repliesEmail + w.repliesLinkedin))));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max].filter((t) => Number.isInteger(t));
  const slot = weeks.length ? innerW / weeks.length : 0;
  const barW = Math.max(2, Math.min(18, (slot - 6) / 2));
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(weeks.length / Math.max(1, Math.floor(innerW / 64))));
  const hovered = hover != null ? weeks[hover] : undefined;

  const seg = (x: number, v0: number, v1: number, cls: string, key: string) => {
    if (v1 <= v0) return null;
    const top = y(v1);
    const bottom = y(v0);
    // 1px surface gap between stacked segments
    const h = Math.max(1, bottom - top - (v0 > 0 ? 1 : 0));
    return <rect key={key} className={cls} x={x} y={top} width={barW} height={h} rx={v0 === 0 ? 1.5 : 0} />;
  };

  return (
    <div className="chart" ref={ref}>
      {width > 0 && weeks.length > 0 && (
        <svg width={width} height={height} role="img" aria-label="Weekly messages sent and replies by channel">
          <defs>
            <pattern id="hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
              <rect width="4" height="4" className="hatch-bg" />
              <line x1="0" y1="0" x2="0" y2="4" className="hatch-line" strokeWidth="2" />
            </pattern>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
              <text className="axis-label" x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          {weeks.map((w, i) => {
            const cx = pad.l + slot * i + slot / 2;
            const xs = cx - barW - 1;
            const xr = cx + 1;
            const sentTotal = w.sentEmail + w.sentLinkedin;
            const repTotal = w.repliesEmail + w.repliesLinkedin;
            return (
              <g key={w.weekStart} className={hover === i ? 'week hovered' : 'week'}>
                {hover === i && <rect className="hover-band" x={pad.l + slot * i} y={pad.t} width={slot} height={innerH} />}
                {seg(xs, 0, w.sentEmail, 'bar email', 's-e')}
                {seg(xs, w.sentEmail, sentTotal, 'bar linkedin', 's-l')}
                {seg(xr, 0, w.repliesEmail, 'bar email reply', 'r-e')}
                {seg(xr, w.repliesEmail, repTotal, 'bar linkedin reply', 'r-l')}
                {i % labelEvery === 0 && (
                  <text className="axis-label" x={cx} y={height - 8} textAnchor="middle">
                    {formatShortDate(w.weekStart)}
                  </text>
                )}
                <rect
                  className="hit"
                  x={pad.l + slot * i}
                  y={pad.t}
                  width={slot}
                  height={innerH}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                >
                  <title>
                    {`Week of ${formatShortDate(w.weekStart)}: ${sentTotal} sent (${w.sentEmail} email, ${w.sentLinkedin} LinkedIn), ${repTotal} replies (${w.repliesEmail} email, ${w.repliesLinkedin} LinkedIn)`}
                  </title>
                </rect>
              </g>
            );
          })}
          <line className="axis-line" x1={pad.l} x2={width - pad.r} y1={y(0)} y2={y(0)} />
        </svg>
      )}
      {weeks.length === 0 && <div className="chart-empty">No dated events in this range.</div>}
      <div className="chart-foot">
        <div className="legend" aria-hidden="true">
          <span>
            <i className="sw email" /> Email
          </span>
          <span>
            <i className="sw linkedin" /> LinkedIn
          </span>
          <span className="legend-sep" />
          <span>
            <i className="sw solid" /> Sent
          </span>
          <span>
            <i className="sw hatched" /> Replies
          </span>
        </div>
        <div className="chart-readout" aria-live="polite">
          {hovered ? (
            <>
              <b>Week of {formatShortDate(hovered.weekStart)}</b> · Sent {hovered.sentEmail + hovered.sentLinkedin} ({hovered.sentEmail} email,{' '}
              {hovered.sentLinkedin} LinkedIn) · Replies {hovered.repliesEmail + hovered.repliesLinkedin}
            </>
          ) : (
            <span className="muted">Hover a week for details · weeks start Monday (UTC)</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function Funnel({ stages }: { stages: FunnelStage[] }) {
  const top = Math.max(1, stages[0]?.count ?? 0);
  return (
    <ol className="funnel">
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1]!.count : null;
        const conv = prev != null && prev > 0 ? Math.round((s.count / prev) * 100) + '%' : prev != null ? '—' : '';
        const pct = (s.count / top) * 100;
        return (
          <li key={s.key} data-testid={`funnel-${s.key}`}>
            <div className="funnel-label">
              <span>{s.label}</span>
              <span className="funnel-num">{formatInt(s.count)}</span>
            </div>
            <div className="funnel-track">
              <div className={`funnel-bar step-${i}`} style={{ width: `${s.count > 0 ? Math.max(0.8, pct) : 0}%` }} />
            </div>
            {i > 0 && <div className="funnel-conv" title="Conversion from previous stage">{conv}</div>}
          </li>
        );
      })}
    </ol>
  );
}

export function Meter({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="meter" aria-hidden="true">
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}
