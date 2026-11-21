// OCR line → layout block aligner.
//
// Two mappings are produced for every OCR line:
//   1. a byte mapping: the line's text is located in the *decoded reference*
//      (the suggested/selected candidate glyph streams), giving an absolute
//      source-byte range and the segment that owns it;
//   2. a region mapping: the line rectangle is overlaid on the page blocks,
//      producing overlap-scored candidate blocks.
//
// The aligner never force-snaps. Two blocks competing for one line, or a line
// crossing a column gutter, stay open as overlap/spanning cases for the review
// queue — exactly the high-risk localizations the brief calls out.

import type {
  Candidate,
  LayoutBlock,
  LineAlignment,
  OcrLine,
  PageLayout,
  Rect,
} from '../../types';
import { crossesAnyGutter, iou, overlapFraction } from './geometry';

/* ------------------------- decoded reference text ------------------------ */

export interface ReferenceSegment {
  id: string;
  start: number;
  end: number;
  candidate: Candidate | null;
}

export interface ReferenceText {
  text: string;
  /** Per-character absolute byte span. */
  spans: Array<[number, number]>;
  segments: ReferenceSegment[];
}

/**
 * Walk the winning candidate glyph streams. Anomaly glyphs contribute no
 * readable text (they survive as byte placeholders elsewhere), so the
 * reference only contains decodable characters plus original newlines.
 */
export function buildReference(segments: ReferenceSegment[]): ReferenceText {
  let text = '';
  const spans: Array<[number, number]> = [];
  for (const seg of segments) {
    const cand = seg.candidate;
    if (!cand) continue;
    for (const g of cand.glyphs) {
      if (g.anomaly || !g.text) continue;
      text += g.text;
      for (let i = 0; i < g.text.length; i++) spans.push([g.start, g.end]);
    }
  }
  return { text, spans, segments };
}

interface NormIndex {
  normalized: string;
  /** normalized char index → index in the original reference text. */
  map: number[];
}

function normalize(s: string): NormIndex {
  let normalized = '';
  const map: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        normalized += ' ';
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    normalized += ch;
    map.push(i);
    lastWasSpace = false;
  }
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    map.pop();
  }
  return { normalized, map };
}

export interface TextLocation {
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
  found: boolean;
}

const NOT_FOUND: TextLocation = {
  charStart: 0,
  charEnd: 0,
  byteStart: 0,
  byteEnd: 0,
  found: false,
};

/** Locate `needle` inside the reference, whitespace-insensitive. */
export function locateText(ref: ReferenceText, needle: string): TextLocation {
  const hay = normalize(ref.text);
  const target = normalize(needle).normalized;
  if (!target) return NOT_FOUND;
  const idx = hay.normalized.indexOf(target);
  if (idx < 0) return locateLoosely(hay, target, ref);
  const startChar = hay.map[idx];
  const endChar = hay.map[idx + target.length - 1] + 1;
  return {
    charStart: startChar,
    charEnd: endChar,
    byteStart: ref.spans[startChar]?.[0] ?? 0,
    byteEnd: ref.spans[endChar - 1]?.[1] ?? 0,
    found: true,
  };
}

/**
 * Fallback for OCR lines whose text drifts from the decoded text: require the
 * first and last non-space token to match in order, and take the span between
 * them. Deterministic, no scoring randomness.
 */
function locateLoosely(hay: NormIndex, target: string, ref: ReferenceText): TextLocation {
  const tokens = target.split(' ').filter(Boolean);
  if (tokens.length < 2) return NOT_FOUND;
  const first = hay.normalized.indexOf(tokens[0]);
  const last = hay.normalized.lastIndexOf(tokens[tokens.length - 1]);
  if (first < 0 || last <= first) return NOT_FOUND;
  const startChar = hay.map[first];
  const endChar = hay.map[last + tokens[tokens.length - 1].length - 1] + 1;
  return {
    charStart: startChar,
    charEnd: endChar,
    byteStart: ref.spans[startChar]?.[0] ?? 0,
    byteEnd: ref.spans[endChar - 1]?.[1] ?? 0,
    found: true,
  };
}

/** Narrow a line-level byte range to a matched substring when possible. */
export function refineRange(ref: ReferenceText, fallback: [number, number], match: string): [number, number] {
  const loc = locateText(ref, match);
  if (!loc.found) return fallback;
  if (loc.byteStart >= fallback[0] && loc.byteEnd <= fallback[1]) {
    return [loc.byteStart, loc.byteEnd];
  }
  return fallback;
}

/* ------------------------------ region mapping --------------------------- */

interface RegionMatch {
  block: LayoutBlock;
  blockId: string;
  score: number;
}

function matchBlocks(rect: Rect, blocks: LayoutBlock[]): RegionMatch[] {
  return blocks
    .map((block) => ({ block, blockId: block.id, score: overlapFraction(rect, block.rect) }))
    .filter((m) => m.score > 0.05)
    // Ties prefer the smallest containing block: a full-width table and the
    // right-column paragraph can both cover a line, but the smaller block is
    // the more specific owner.
    .sort((a, b) => b.score - a.score || a.block.rect.width * a.block.rect.height - b.block.rect.width * b.block.rect.height || a.blockId.localeCompare(b.blockId));
}

const ALIGN_MARGIN = 0.15;
const ALIGN_MIN = 0.5;
const CONTENTION_IOU = 0.55;

/** True when `outer` geometrically contains `inner` (with a small tolerance). */
function encloses(outer: LayoutBlock | null | undefined, inner: LayoutBlock | null | undefined): boolean {
  if (!outer || !inner) return false;
  const t = 4;
  return (
    inner.rect.x >= outer.rect.x - t &&
    inner.rect.y >= outer.rect.y - t &&
    inner.rect.x + inner.rect.width <= outer.rect.x + outer.rect.width + t &&
    inner.rect.y + inner.rect.height <= outer.rect.y + outer.rect.height + t
  );
}

/**
 * Align every OCR line. `byteRangeOf` decouples byte mapping from this module
 * so the same geometry rules run at analysis time and after repair edits.
 */
export function alignLines(
  pages: PageLayout[],
  lines: OcrLine[],
  byteRangeOf: (line: OcrLine) => TextLocation,
  segmentIdOf: (loc: TextLocation) => string | null,
): LineAlignment[] {
  const blocksByPage = new Map<string, LayoutBlock[]>();
  const guttersByPage = new Map<string, number[]>();
  for (const page of pages) {
    blocksByPage.set(page.id, page.blocks);
    guttersByPage.set(page.id, page.columnGutters);
  }

  // Region contention: two OCR lines claiming the same pixels.
  const contentions = new Map<string, Set<string>>();
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      if (a.pageId !== b.pageId) continue;
      const sameRegion = iou(a.rect, b.rect) >= CONTENTION_IOU || a.duplicateOf === b.id || b.duplicateOf === a.id;
      if (!sameRegion) continue;
      if (!contentions.has(a.id)) contentions.set(a.id, new Set());
      if (!contentions.has(b.id)) contentions.set(b.id, new Set());
      contentions.get(a.id)!.add(b.id);
      contentions.get(b.id)!.add(a.id);
    }
  }

  return lines.map((line): LineAlignment => {
    const blocks = blocksByPage.get(line.pageId) ?? [];
    const gutters = guttersByPage.get(line.pageId) ?? [];
    const loc = byteRangeOf(line);
    const byteRange: [number, number] = loc.found ? [loc.byteStart, loc.byteEnd] : [0, 0];
    const matches = matchBlocks(line.rect, blocks);
    const candidateBlockIds = matches.map((m) => m.blockId);
    const overlapScores: Record<string, number> = {};
    for (const m of matches) overlapScores[m.blockId] = Number(m.score.toFixed(3));

    const flags: string[] = [];
    const competing = [...(contentions.get(line.id) ?? [])];
    const geometricallySpanning = crossesAnyGutter(line.rect, gutters);
    // A line that crosses the gutter is fine when a block designed to span
    // columns (table, footnote, full-width title/paragraph) fully contains it.
    const bestMatch = matches[0];
    const bestBlock = bestMatch?.block ?? null;
    const containedBySpanningBlock =
      geometricallySpanning && Boolean(bestBlock?.spansColumns) && (bestMatch?.score ?? 0) >= ALIGN_MIN;
    const spanning = geometricallySpanning && !containedBySpanningBlock;
    let status: LineAlignment['status'];

    if (!loc.found) {
      status = 'unplaced';
      flags.push('OCR 行文本无法在修复后的字节流中定位');
    } else if (spanning) {
      status = 'spans-columns';
      flags.push('OCR 行跨越栏间分隔线，单个区块无法完整容纳该行');
    } else if (competing.length > 0) {
      status = 'ambiguous-overlap';
      flags.push(`与其它 OCR 行竞争同一图像区域：${competing.join('、')}`);
    } else if (matches.length === 0 || matches[0].score < 0.25) {
      status = 'unplaced';
      flags.push('行坐标与任何区块的重叠面积均不足 25%');
    } else if (
      matches.length > 1 &&
      // Only treat the runner-up as a real competitor when it is not a
      // larger enclosing block of the best match.
      !encloses(matches[1].block, bestBlock) &&
      matches[0].score - matches[1].score < ALIGN_MARGIN
    ) {
      status = 'ambiguous-overlap';
      flags.push(
        `候选区块重叠分接近（${matches[0].blockId}=${matches[0].score.toFixed(2)} / ${matches[1].blockId}=${matches[1].score.toFixed(2)}）`,
      );
    } else if (matches[0].score < ALIGN_MIN) {
      status = 'ambiguous-overlap';
      flags.push(`最佳区块仅覆盖行区域的 ${(matches[0].score * 100).toFixed(0)}%，证据不足`);
    } else {
      status = 'aligned';
    }

    return {
      id: `align-${line.id}`,
      ocrLineId: line.id,
      pageId: line.pageId,
      byteRange,
      segmentId: loc.found ? segmentIdOf(loc) : null,
      candidateBlockIds,
      overlapScores,
      status,
      flags,
      competingLineIds: competing,
    };
  });
}
