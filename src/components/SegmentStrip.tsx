import type { BoundaryReview, RepairState, SegmentState } from '../types';
import { selectedCandidate } from '../lib/repair';
import { ENCODINGS } from '../lib/encoding/specs';
import { formatBytes } from '../lib/util/bytes';

const FAMILY_COLOR: Record<string, string> = {
  'utf-8': '#2f7a5c',
  gb18030: '#4b47a8',
  big5: '#a06a10',
  'windows-1252': '#a63a2a',
  'iso-8859-1': '#b8622a',
  'utf-16le': '#2a6a8a',
  'utf-16be': '#2a6a8a',
};

const PENDING_HATCH = 'repeating-linear-gradient(135deg, rgba(255,255,255,0.35) 0 3px, transparent 3px 6px)';

/**
 * Proportional band showing how the file is cut into segments, coloured by
 * the selected candidate's encoding family. Pending segments are hatched so
 * unreviewed regions stand out at a glance.
 */
export function SegmentStrip({
  state,
  totalBytes,
  activeId,
  onSelect,
  reviews,
}: {
  state: RepairState;
  totalBytes: number;
  activeId: string | null;
  onSelect: (id: string) => void;
  reviews: BoundaryReview[];
}) {
  return (
    <div>
      <div className="seg-strip" role="list" aria-label="字节区段分布">
        {state.segments.map((seg) => {
          const cand = selectedCandidate(seg);
          const color = cand ? FAMILY_COLOR[cand.encoding] ?? '#5a554b' : '#8a8375';
          const pct = totalBytes === 0 ? 0 : ((seg.end - seg.start) / totalBytes) * 100;
          const risky = reviews.some(
            (r) => (r.leftSegmentId === seg.id || r.rightSegmentId === seg.id) && !r.acknowledged && r.severity !== 'low',
          );
          const label = cand ? ENCODINGS[cand.encoding].short : '?';
          return (
            <button
              key={seg.id}
              role="listitem"
              className={`seg-band ${activeId === seg.id ? 'active' : ''} tooltip`}
              style={{
                width: `${Math.max(pct, 0.6)}%`,
                background: seg.status === 'pending' ? `${color}` : color,
                backgroundImage: seg.status === 'pending' ? PENDING_HATCH : undefined,
                opacity: seg.status === 'pending' ? 0.82 : 1,
              }}
              onClick={() => onSelect(seg.id)}
              data-tip={`${seg.start}–${seg.end} · ${formatBytes(seg.end - seg.start)}\n${label} · ${statusWord(seg.status)}${risky ? '\n⚠ 边界存在断裂风险' : ''}`}
              aria-label={`区段 ${seg.start} 到 ${seg.end}，${label}`}
            >
              {pct > 7 ? `${label}${seg.status === 'pending' ? ' ⚠' : ''}` : ''}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }} className="mono muted">
        <span>0</span>
        <span>{formatBytes(totalBytes)}</span>
      </div>
    </div>
  );
}

function statusWord(status: SegmentState['status']): string {
  return status === 'confident' ? '可归档' : status === 'suggested' ? '建议复核' : '待裁决';
}

export const ENCODING_COLOR = FAMILY_COLOR;
