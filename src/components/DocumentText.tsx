import { Fragment, useMemo } from 'react';
import type { RepairState, SegmentState } from '../types';
import { selectedCandidate } from '../lib/repair';

type Part = { kind: 'text'; text: string } | { kind: 'sym'; text: string; symbolId: string; resolved: boolean };

/**
 * Render one segment's text from the candidate's glyph stream, replacing each
 * anomaly run with a clickable placeholder. Rendering from glyphs (not the
 * display string) keeps text and symbols aligned when some are resolved.
 */
export function SegmentText({
  seg,
  state,
  onSymbol,
  onSelectSegment,
  dim,
}: {
  seg: SegmentState;
  state: RepairState;
  onSymbol?: (symbolId: string) => void;
  onSelectSegment?: (id: string) => void;
  dim?: boolean;
}) {
  const cand = selectedCandidate(seg);
  const parts = useMemo<Part[]>(() => {
    if (!cand) return [{ kind: 'text', text: '（无候选）' }];
    const out: Part[] = [];
    const sorted = [...cand.unresolved].sort((a, b) => a.start - b.start);
    let symIdx = 0;
    let buffer = '';
    for (const g of cand.glyphs) {
      if (!g.anomaly) {
        buffer += g.text;
        continue;
      }
      const sym = sorted[symIdx];
      if (!sym || g.start < sym.start || g.end > sym.end) continue;
      if (g.start !== sym.start) continue;
      if (buffer) {
        out.push({ kind: 'text', text: buffer });
        buffer = '';
      }
      const res = state.symbolResolutions[sym.id];
      out.push({
        kind: 'sym',
        text: res ? res.text : `⟦${sym.bytesHex || `${sym.end - sym.start} B`}⟧`,
        symbolId: sym.id,
        resolved: Boolean(res),
      });
      symIdx++;
    }
    if (buffer) out.push({ kind: 'text', text: buffer });
    return out;
  }, [cand, state.symbolResolutions]);

  if (!cand) return <span className="muted">（无候选）</span>;

  return (
    <span
      className="doc-text"
      style={dim ? { opacity: 0.72 } : undefined}
      onClick={() => onSelectSegment?.(seg.id)}
    >
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          <span
            key={i}
            className={`sym ${p.resolved ? 'resolved' : ''}`}
            role="button"
            tabIndex={0}
            title={p.resolved ? '已人工裁决' : '不可解字节：点击裁决'}
            onClick={(e) => {
              e.stopPropagation();
              onSymbol?.(p.symbolId);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSymbol?.(p.symbolId);
            }}
          >
            {p.text}
          </span>
        ),
      )}
    </span>
  );
}

/** Whole-document preview from the current repair state. */
export function DocumentPreview({
  state,
  onSymbol,
  onSelectSegment,
}: {
  state: RepairState;
  onSymbol?: (symbolId: string) => void;
  onSelectSegment?: (id: string) => void;
}) {
  return (
    <div>
      {state.segments.map((seg, i) => (
        <Fragment key={seg.id}>
          {i > 0 && (
            <div
              style={{
                borderTop: '1px dashed var(--line)',
                margin: '10px 0',
                fontSize: 10,
                color: 'var(--text-faint)',
                paddingTop: 3,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span className="mono">边界 {seg.start}</span>
              <span>区段 {i + 1}</span>
            </div>
          )}
          <SegmentText seg={seg} state={state} onSymbol={onSymbol} onSelectSegment={onSelectSegment} />
        </Fragment>
      ))}
    </div>
  );
}
