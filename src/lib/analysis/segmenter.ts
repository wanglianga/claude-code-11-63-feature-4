import type { AnalysisParams, Candidate, EncodingId } from '../../types';
import { encodingLabel } from '../encoding/specs';
import { buildCandidates } from './candidates';

export interface TileHypothesis {
  start: number;
  end: number;
  encoding: EncodingId;
  kind: 'text' | 'mojibake';
  score: number;
  markerBytes: number;
  anomalyBytes: number;
  candidate: Candidate;
}

/** Bytes that are safe to cut before for UTF-8, GBK and Big5 alike. */
function isSafeBreak(bytes: Uint8Array, p: number): boolean {
  if (p <= 0 || p >= bytes.length) return true;
  const b = bytes[p];
  if (b >= 0x80) return false;
  if (b === 0x0a || b === 0x0d || b === 0x20 || b === 0x09) return true;
  return b < 0x40;
}

function nearestSafeBreak(bytes: Uint8Array, nominal: number, radius: number): number {
  if (nominal <= 0) return 0;
  if (nominal >= bytes.length) return bytes.length;
  // Prefer the nearest line start within the correction radius. A wider
  // search would let a boundary drift across a whole paragraph, so the
  // detector's own estimate wins beyond `radius` bytes.
  let bestLine = -1;
  for (let d = 0; d <= radius; d++) {
    const left = nominal - d;
    if (left > 0 && left < bytes.length && (bytes[left - 1] === 0x0a || bytes[left - 1] === 0x0d)) {
      bestLine = left;
      break;
    }
    const right = nominal + d;
    if (right < bytes.length && right > 0 && (bytes[right - 1] === 0x0a || bytes[right - 1] === 0x0d)) {
      bestLine = right;
      break;
    }
  }
  if (bestLine >= 0) return bestLine;
  for (let d = 0; d <= radius; d++) {
    const right = nominal + d;
    if (right < bytes.length && isSafeBreak(bytes, right)) return right;
    const left = nominal - d;
    if (left > 0 && isSafeBreak(bytes, left)) return left;
  }
  for (let d = 0; d <= radius; d++) {
    const right = nominal + d;
    if (right < bytes.length && (bytes[right] & 0xc0) !== 0x80) return right;
    const left = nominal - d;
    if (left > 0 && (bytes[left] & 0xc0) !== 0x80) return left;
  }
  return nominal;
}

/**
 * Fast, lexicon-free pre-screen for a tile. Returns true when the bytes look
 * like a clean single-encoding text stream, in which case the caller can skip
 * the full candidate search (direct decode + repairs).
 */
function obviousTextEncoding(bytes: Uint8Array): EncodingId | null {
  let ascii = 0;
  let high = 0;
  let utf8Multi = 0;
  let gbkPairs = 0;
  let big5Pairs = 0;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      if (b === 0x09 || b === 0x0a || b === 0x0d || b >= 0x20) ascii++;
      i++;
      continue;
    }
    high++;
    const b1 = bytes[i + 1];
    if (b1 === undefined) return null;
    if (b >= 0xc2 && b <= 0xdf) {
      if ((b1 & 0xc0) === 0x80) {
        utf8Multi++;
        i += 2;
        continue;
      }
      return null;
    }
    if (b >= 0xe0 && b <= 0xef) {
      const b2 = bytes[i + 2];
      if (b2 !== undefined && (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80) {
        utf8Multi++;
        i += 3;
        continue;
      }
      return null;
    }
    if (b >= 0xf0 && b <= 0xf4) {
      const b2 = bytes[i + 2];
      const b3 = bytes[i + 3];
      if (b2 !== undefined && b3 !== undefined && (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80) {
        utf8Multi++;
        i += 4;
        continue;
      }
      return null;
    }
    // Two-byte CJK lead.
    if (b >= 0x81 && b <= 0xfe) {
      if (b1 !== 0x7f && b1 >= 0x40 && b1 <= 0xfe) {
        gbkPairs++;
        if (b1 >= 0xa1) big5Pairs++;
        i += 2;
        continue;
      }
      return null;
    }
    return null;
  }
  if (high === 0) return 'utf-8';
  // UTF-8 is unambiguous once a multi-byte sequence validates; the tile is
  // clean if nearly every high byte formed a sequence.
  if (utf8Multi > 0 && gbkPairs === 0) return 'utf-8';
  if (utf8Multi > 0 && utf8Multi * 2 >= gbkPairs) return null; // genuinely ambiguous
  if (gbkPairs === 0) return null;
  // A high proportion of big5-only trail bytes is a weak but useful signal.
  if (big5Pairs / Math.max(1, gbkPairs) > 0.75 && ascii + high > 0) return null;
  return null;
}

/**
 * Classify a tile. The winning candidate's *kind* decides the hypothesis:
 * a repair chain that reconstructs a full UTF-8 reading means the bytes were
 * transcoded; a direct decode means they are already in their final form.
 */
function classifyTile(bytes: Uint8Array, start: number, end: number, params: AnalysisParams): TileHypothesis {
  const slice = bytes.subarray(start, end);
  // Clean tiles get a single direct decode; only suspicious tiles pay for the
  // full repair search. This keeps 200 KB files responsive in the worker.
  const clean = obviousTextEncoding(slice);
  const candidates = clean
    ? buildCandidates(slice, start, { ...params, maxCandidatesPerSegment: 2 }, 'tile-clean')
    : buildCandidates(slice, start, params, 'text');
  const best = candidates[0];
  if (!best) throw new Error(`区段 ${start}-${end} 没有可用候选`);
  const markerBytes = Math.round(best.score.mojibakeMarkerCount * 1.5);
  const looksMojibake = best.kind === 'repair' && best.score.score >= 0.6;
  return {
    start,
    end,
    encoding: best.encoding,
    kind: looksMojibake ? 'mojibake' : 'text',
    score: best.score.score,
    markerBytes,
    anomalyBytes: Math.round(best.score.anomalyRatio * slice.length),
    candidate: best,
  };
}

export interface RawSegment {
  start: number;
  end: number;
  kind: 'text' | 'mojibake';
  hypothesis: EncodingId;
  tileCount: number;
  score: number;
}

/**
 * Try splitting an anomalous run into two parts at candidate positions and
 * keep the split when it clearly improves the mean candidate score. This is
 * what recovers [GBK line][Big5 paragraph] inside a single 256-byte tile.
 */
function refineRun(bytes: Uint8Array, run: TileHypothesis, params: AnalysisParams, depth = 0): TileHypothesis[] {
  const span = run.end - run.start;
  if (span < 192 || depth > 2) return [{ ...run }];
  const whole = classifyTile(bytes, run.start, run.end, params);
  const base = whole.score;
  const step = Math.max(4, Math.floor(span / 48));
  const margin = Math.min(24, Math.floor(span / 10));
  let best: { p: number; score: number; l: TileHypothesis; r: TileHypothesis } | null = null;
  for (let p = run.start + margin; p <= run.end - margin; p += step) {
    if (p > 0 && p < bytes.length && (bytes[p] & 0xc0) === 0x80) continue;
    if (p > 0 && p < bytes.length && bytes[p] >= 0x80 && bytes[p - 1] >= 0x80) continue;
    const l = classifyTile(bytes, run.start, p, params);
    const r = classifyTile(bytes, p, run.end, params);
    // Weight by the smaller side so a split cannot "win" merely by giving a
    // huge clean block to one side and a tiny one to the other.
    const score = (l.score * (p - run.start) + r.score * (run.end - p)) / span;
    // Prefer boundaries at line starts when scores tie within a small window;
    // otherwise the optimiser wanders between equivalent byte positions.
    const atLineStart = p > 0 && (bytes[p - 1] === 0x0a || bytes[p - 1] === 0x0d);
    const tiebreak = atLineStart ? 0.006 : 0;
    const adjusted = score + tiebreak;
    if (!best || adjusted > best.score) best = { p, score: adjusted, l, r };
  }
  if (!best || best.score < base + 0.006) return [{ ...run }];
  // Recurse so a run may hold two switches (e.g. GBK → Big5 → UTF-8).
  const leftPieces = refineRun(bytes, best.l, params, depth + 1);
  const rightPieces = refineRun(bytes, best.r, params, depth + 1);
  const pieces = [...leftPieces, ...rightPieces];
  // Keep genuine switches apart but collapse neighbours that agree.
  const consolidated: TileHypothesis[] = [];
  for (const p of pieces) {
    const last = consolidated[consolidated.length - 1];
    if (last && last.encoding === p.encoding && last.kind === p.kind) last.end = p.end;
    else consolidated.push({ ...p });
  }
  return consolidated;
}

/**
 * Tile the file, classify each tile, merge runs of the same hypothesis, then
 * snap boundaries to newline / low-ASCII positions so a multi-byte sequence is
 * never split. Adjacent runs of different hypotheses stay separate — that is
 * exactly the information segmented diagnosis is meant to preserve.
 */
export function segmentFile(bytes: Uint8Array, params: AnalysisParams): RawSegment[] {
  const len = bytes.length;
  if (len === 0) return [];
  // Classification uses a finer tile than the user-facing knob so a boundary
  // between, say, a Big5 block and a UTF-8 footer is found within a few dozen
  // bytes instead of at the next 512-byte landmark.
  const tile = Math.max(64, Math.min(4096, params.tileBytes, 256));
  const tiles: TileHypothesis[] = [];
  for (let start = 0; start < len; start += tile) {
    tiles.push(classifyTile(bytes, start, Math.min(len, start + tile), params));
  }

  // Smooth a lone outlier tile: only flip it when both neighbours agree *and*
  // the tile is short relative to them. A genuine two-tile footer must survive.
  for (let i = 1; i + 1 < tiles.length; i++) {
    const prev = tiles[i - 1];
    const cur = tiles[i];
    const next = tiles[i + 1];
    const shortEnough = cur.end - cur.start < Math.min(prev.end - prev.start, next.end - next.start);
    if (
      prev.encoding === next.encoding &&
      prev.kind === next.kind &&
      cur.encoding !== prev.encoding &&
      shortEnough &&
      Math.abs(cur.score - prev.score) < 0.12
    ) {
      cur.encoding = prev.encoding;
      cur.kind = prev.kind;
      cur.score = prev.score;
    }
  }

  const merged: TileHypothesis[] = [];
  for (const t of tiles) {
    const last = merged[merged.length - 1];
    if (last && last.encoding === t.encoding && last.kind === t.kind && last.end === t.start) {
      last.end = t.end;
      last.markerBytes += t.markerBytes;
      last.anomalyBytes += t.anomalyBytes;
    } else {
      merged.push({ ...t });
    }
  }

  // Demote a run to its own single tile when it is a lone frontier: a merged
  // run whose interior tiles disagree is evidence the merge was too eager.
  // (Cheap guard that prevents [Big5 …][UTF-8 footer] collapsing into Big5.)

  // Split refinement: a tile that straddles an encoding switch merges the two
  // sides into one hypothesis. Re-test the promising cut points with the full
  // candidate scorer, restricted to segments whose best decode still reports
  // anomalies (clean segments gain nothing and cost a lot).
  const refined: TileHypothesis[] = [];
  const refinedBoundaries = new Set<number>();
  // Refinement re-runs the full candidate search at several cut points, so it
  // is budgeted: only runs that still show anomalies qualify, and a file-wide
  // cap keeps very large mixed files interactive.
  const budget = { left: 28 };
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i];
    const span = m.end - m.start;
    // A run is worth refining if its winning candidate still leaves anomalies,
    // shows mojibake markers, or is a repair chain (transcoded evidence).
    const candidateRatio = m.candidate?.score.anomalyRatio ?? 0;
    const markers = m.candidate?.score.mojibakeMarkerCount ?? 0;
    const repairable = m.candidate?.kind === 'repair';
    const anomalous = m.anomalyBytes > 4 || candidateRatio > 0.005 || markers > 0 || repairable;
    // A run must be wide enough to hold two meaningful pieces. For small files
    // one tile already spans most of the document, so the gate is byte-based.
    if (span < 96 || !anomalous || budget.left <= 0) {
      refined.push({ ...m });
      continue;
    }
    budget.left--;
    const pieces = refineRun(bytes, m, params);
    if (pieces.length > 1) {
      for (let k = 1; k < pieces.length; k++) refinedBoundaries.add(pieces[k].start);
    }
    refined.push(...pieces);
  }

  const segments: RawSegment[] = [];
  let cursor = 0;
  for (let i = 0; i < refined.length; i++) {
    const m = refined[i];
    let end = m.end;
    if (i < refined.length - 1) {
      // A boundary produced by refinement already sits at the highest-scoring
      // split point; re-snapping it to the previous newline would undo that.
      if (!refinedBoundaries.has(end)) {
        const snapped = nearestSafeBreak(bytes, end, Math.max(16, Math.floor(tile / 2)));
        if (snapped > cursor && snapped < len) end = snapped;
      }
    } else {
      end = len;
    }
    if (end <= cursor) continue;
    segments.push({
      start: cursor,
      end,
      kind: m.kind,
      hypothesis: m.encoding,
      tileCount: Math.max(1, Math.round((m.end - m.start) / tile)),
      score: m.score,
    });
    cursor = end;
  }

  // Merge undersized segments into a neighbour — but only into one with the
  // same hypothesis, so a short UTF-8 footer after a Big5 block survives as
  // its own reviewable segment. Truly tiny fragments (<48 B) may join any
  // neighbour of the same kind.
  const minBytes = Math.max(16, params.minSegmentBytes);
  let pass = true;
  while (pass && segments.length > 1) {
    pass = false;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.end - s.start >= minBytes) continue;
      const left = segments[i - 1];
      const right = segments[i + 1];
      if (!left && !right) break;
      const neighbours = [left, right].filter((x): x is RawSegment => Boolean(x));
      const same = neighbours.filter((c) => c.kind === s.kind && c.hypothesis === s.hypothesis);
      const tiny = s.end - s.start < 48;
      const options = same.length > 0 ? same : tiny ? neighbours.filter((c) => c.kind === s.kind) : [];
      if (options.length === 0) continue;
      const target = options.reduce((a, b) => (Math.abs(a.score - s.score) <= Math.abs(b.score - s.score) ? a : b));
      if (target === left) {
        left.end = s.end;
        left.tileCount += s.tileCount;
      } else {
        right!.start = s.start;
        right!.tileCount += s.tileCount;
      }
      segments.splice(i, 1);
      pass = true;
      break;
    }
  }
  // Merge neighbours that ended up with the same hypothesis.
  const out: RawSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.hypothesis === s.hypothesis && last.kind === s.kind) {
      last.end = s.end;
      last.tileCount += s.tileCount;
    } else {
      out.push({ ...s });
    }
  }

  if (out.length === 0) {
    out.push({ start: 0, end: len, kind: 'text', hypothesis: 'utf-8', tileCount: 1, score: 0 });
  }
  return out;
}

export function describeHypothesis(seg: RawSegment): string {
  return seg.kind === 'mojibake'
    ? `${encodingLabel(seg.hypothesis)} 乱码区段`
    : `${encodingLabel(seg.hypothesis)} 文本区段`;
}
