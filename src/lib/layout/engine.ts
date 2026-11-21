// Layout engine: orchestrates parsing, ordering, alignment, field extraction,
// consistency validation and metric roll-up into one LayoutModel.
//
// Two entry points:
//   runLayout()        – parse the (possibly annotated) byte stream fresh;
//   assembleModel()    – re-run alignment/validation over existing pages, used
//                        after candidate changes or an anchor re-crop.
// Adjudications survive re-runs by content-addressed queue id, except queue
// items whose anchor was re-cropped — those are deliberately returned to the
// open queue.

import type {
  LayoutBlock,
  LayoutMetrics,
  LayoutModel,
  OcrLine,
  OrderingMode,
  PageLayout,
  SegmentAnalysis,
  SegmentState,
} from '../../types';
import {
  buildPages,
  parseLayoutDocument,
  toOcrLines,
  type ParsedDocument,
} from './document';
import { columnOf, crossesAnyGutter, geometricOrder, linearOrder, overlapFraction } from './geometry';
import {
  alignLines,
  buildReference,
  locateText,
  type ReferenceSegment,
  type ReferenceText,
  type TextLocation,
} from './aligner';
import { extractFields } from './fields';
import { checkConsistency, resetIssueCounters } from './consistency';
import { summarizeSynthetic } from './image-digest';

export const LAYOUT_ENGINE = 'bytelab-layout-engine/1.0';

export interface SegmentLike {
  id: string;
  start: number;
  end: number;
  candidate: ReferenceSegment['candidate'];
}

export function referenceSegmentsFromAnalysis(segments: SegmentAnalysis[]): ReferenceSegment[] {
  return segments.map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    candidate: s.candidates.find((c) => c.id === s.suggestedCandidateId) ?? s.candidates[0] ?? null,
  }));
}

export function referenceSegmentsFromState(segments: SegmentState[]): ReferenceSegment[] {
  return segments.map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    candidate:
      s.candidates.find((c) => c.id === s.selectedCandidateId) ??
      s.candidates.find((c) => c.id === s.suggestedCandidateId) ??
      s.candidates[0] ??
      null,
  }));
}

export interface AssembleOptions {
  now: string;
  ordering: OrderingMode;
  prior?: LayoutModel | null;
  staleBlockIds?: Set<string>;
}

/** Build the char→OCR-line lookup used by the field extractor. */
function buildLineAtChar(ref: ReferenceText, model: { ocrLines: OcrLine[]; byteRangeByLine: Map<string, [number, number]> }) {
  const ordered = [...model.byteRangeByLine.entries()]
    .map(([lineId, range]) => ({ lineId, range }))
    .filter((e) => e.range[1] > e.range[0])
    .sort((a, b) => a.range[0] - b.range[0]);
  return (charIndex: number): string | null => {
    const span = ref.spans[charIndex];
    if (!span) return null;
    const hit = ordered.find((e) => span[0] >= e.range[0] && span[1] <= e.range[1] + 1);
    return hit?.lineId ?? ordered.find((e) => span[0] < e.range[1] && span[1] > e.range[0])?.lineId ?? null;
  };
}

/**
 * Re-run the alignment/validation pipeline over concrete pages. Pure with
 * respect to its inputs; the caller decides what geometry changed.
 */
export function assembleModel(
  pages: PageLayout[],
  ocrLines: OcrLine[],
  segments: ReferenceSegment[],
  opts: AssembleOptions,
): LayoutModel {
  resetIssueCounters();
  const ref = buildReference(segments);
  const blocksById = new Map<string, LayoutBlock>();
  for (const p of pages) for (const b of p.blocks) blocksById.set(b.id, b);
  const linesById = new Map(ocrLines.map((l) => [l.id, l]));

  const byteRangeOf = (line: OcrLine): TextLocation => locateText(ref, line.text);
  const segmentIdOf = (loc: TextLocation): string | null =>
    segments.find((s) => loc.byteStart >= s.start && loc.byteStart < s.end)?.id ?? null;

  const alignments = alignLines(pages, ocrLines, byteRangeOf, segmentIdOf);
  const alignmentByLine = new Map(alignments.map((a) => [a.ocrLineId, a]));
  const byteRangeByLine = new Map<string, [number, number]>();
  for (const a of alignments) byteRangeByLine.set(a.ocrLineId, a.byteRange);

  const lineAtChar = buildLineAtChar(ref, { ocrLines, byteRangeByLine });

  const fields = extractFields({
    ref,
    linesById,
    blocksById,
    alignmentByLine,
    lineAtChar,
  });

  const stale = opts.staleBlockIds ?? new Set<string>();
  const { issues, fields: checkedFields, queue: freshQueue } = checkConsistency({
    ref,
    pages,
    lines: ocrLines,
    alignments,
    fields,
    staleBlockIds: stale,
    now: opts.now,
  });

  // Preserve every human decision ever made as append-only history. A prior
  // decision is only applied to the live queue status when its anchor was not
  // re-cropped; stale items reopen while the old decision stays in the map.
  const adjudications: LayoutModel['adjudications'] = { ...(opts.prior?.adjudications ?? {}) };
  const queue = freshQueue.map((item) => {
    const priorDecision = opts.prior?.adjudications[item.id];
    if (!priorDecision || stale.has(item.blockId ?? '')) return item;
    return {
      ...item,
      status: priorDecision.decision,
      decidedAt: priorDecision.at,
      decisionNote: priorDecision.note,
      imageDigestSha: priorDecision.imageDigestSha,
    };
  });

  return {
    schema: 'bytelab-layout/1',
    engine: LAYOUT_ENGINE,
    createdAt: opts.now,
    ordering: opts.ordering,
    pages,
    ocrLines,
    alignments,
    fields: checkedFields,
    issues,
    reviewQueue: queue,
    adjudications,
    anchorRevisions: opts.prior?.anchorRevisions ?? [],
    metrics: computeMetrics(pages, ocrLines, alignments, checkedFields, issues, queue),
  };
}

export interface RunLayoutInput {
  /**
   * Decoded document text (directives are ASCII, OCR text is the repaired
   * glyph stream). Callers pass per-segment decoded text rather than raw bytes
   * so GBK/Big5 documents keep readable OCR lines while the layout directives
   * survive unchanged.
   */
  text: string;
  segments: ReferenceSegment[];
  ordering: OrderingMode;
  now: string;
}

/** Concatenate the winning candidate glyph streams into one structure text. */
export function structureTextFromSegments(segments: ReferenceSegment[]): string {
  let out = '';
  for (const seg of segments) {
    const cand = seg.candidate;
    if (!cand) continue;
    for (const g of cand.glyphs) {
      if (g.anomaly) continue;
      out += g.text;
    }
  }
  return out;
}

/** Full parse + assemble from a decoded text stream. */
export function runLayout(input: RunLayoutInput): LayoutModel {
  const parsed: ParsedDocument = parseLayoutDocument(input.text);
  const pages = buildPages(parsed, input.ordering);
  const ocrLines = toOcrLines(parsed);
  return assembleModel(pages, ocrLines, input.segments, {
    now: input.now,
    ordering: input.ordering,
  });
}

/**
 * Re-crop a block inside an existing model: replace geometry + image summary,
 * then re-validate every alignment and field against the new anchor. The old
 * geometry, digest and prior decisions are returned on the revision record.
 */
export function recropAnchor(
  model: LayoutModel,
  segments: ReferenceSegment[],
  req: {
    pageId: string;
    blockId: string;
    newRect: LayoutModel['pages'][number]['blocks'][number]['rect'];
    note: string;
    versionId: string;
    now: string;
  },
): LayoutModel {
  const page = model.pages.find((p) => p.id === req.pageId);
  const block = page?.blocks.find((b) => b.id === req.blockId);
  if (!page || !block) throw new Error('重新裁剪的页面区块不存在');

  // Block text is re-derived geometrically from the OCR lines sitting inside
  // the old crop, so the new image summary stays deterministic without any
  // extra caller-supplied content.
  const blockText = model.ocrLines
    .filter((l) => l.pageId === page.id && overlapFraction(l.rect, block.rect) > 0.5)
    .map((l) => l.text)
    .join('\n');
  const newDigest = summarizeSynthetic(req.newRect, blockText || block.section);
  const staleBlockIds = new Set<string>([block.id]);

  // Snapshot invalidation bookkeeping before mutating geometry.
  const affected = model.reviewQueue.filter((q) => q.blockId === block.id);
  const priorDecisions = affected
    .map((q) => model.adjudications[q.id])
    .filter(Boolean)
    .map((d) => ({ queueId: d!.queueId, decision: d!.decision, note: d!.note, at: d!.at }));

  const revision = {
    id: `anchor-${block.id}@${req.now}`,
    pageId: req.pageId,
    blockId: req.blockId,
    oldRect: { ...block.rect },
    newRect: { ...req.newRect },
    oldImageDigest: { ...block.imageDigest },
    newImageDigest: newDigest,
    note: req.note,
    createdAt: req.now,
    versionId: req.versionId,
    invalidatedQueueIds: affected.map((q) => q.id),
    priorDecisions,
  };

  // Deep-ish clone of pages, then replace the one block's geometry/digest.
  const pages: PageLayout[] = model.pages.map((p) => ({
    ...p,
    blocks: p.blocks.map((b) => {
      if (b.id !== block.id) return b;
      const spansColumns = crossesAnyGutter(req.newRect, p.columnGutters);
      return {
        ...b,
        rect: { ...req.newRect },
        imageDigest: newDigest,
        spansColumns,
        column: spansColumns ? -1 : columnOf(req.newRect, p.columnGutters),
      };
    }),
  }));

  // assembleModel inherits prior anchor revisions via `prior`; the new
  // revision for this crop is appended afterwards.
  const assembled = assembleModel(pages, model.ocrLines, segments, {
    now: req.now,
    ordering: model.ordering,
    prior: model,
    staleBlockIds,
  });
  return { ...assembled, anchorRevisions: [...model.anchorRevisions, revision] };
}

/**
 * Switch reading order without re-parsing or re-aligning. Only the block
 * order/links and page ordering marker change; geometry, image digests,
 * alignments, fields and review status are untouched.
 */
export function reorderLayout(model: LayoutModel, ordering: OrderingMode): LayoutModel {
  const pages = model.pages.map((page): PageLayout => {
    const ids =
      ordering === 'linear'
        ? linearOrder(page.blocks)
        : geometricOrder(
            page.blocks.map((b) => ({ id: b.id, rect: b.rect, spansColumns: b.spansColumns })),
            page.columnGutters,
          );
    const blocks = page.blocks
      .map((b) => {
        const order = ids.indexOf(b.id);
        return {
          ...b,
          order,
          prevBlockId: order > 0 ? ids[order - 1] : null,
          nextBlockId: order < ids.length - 1 ? ids[order + 1] : null,
        };
      })
      .sort((a, b) => a.order - b.order);
    return { ...page, blocks, ordering };
  });
  return { ...model, pages, ordering };
}

/** Record a human decision on a review-queue item. */
export function adjudicateQueueItem(
  model: LayoutModel,
  queueId: string,
  decision: 'confirmed' | 'rejected',
  note: string,
  versionId: string,
  now: string,
): LayoutModel {
  const item = model.reviewQueue.find((q) => q.id === queueId);
  if (!item) throw new Error('复核队列项不存在');
  const block = item.blockId
    ? model.pages.flatMap((p) => p.blocks).find((b) => b.id === item.blockId)
    : null;
  const adjudication = {
    queueId,
    decision,
    note,
    versionId,
    at: now,
    imageDigestSha: block?.imageDigest.sha256 ?? item.imageDigestSha,
  };
  const reviewQueue = model.reviewQueue.map((q) =>
    q.id === queueId
      ? { ...q, status: decision, decidedAt: now, decisionNote: note, imageDigestSha: adjudication.imageDigestSha }
      : q,
  );
  return {
    ...model,
    reviewQueue,
    adjudications: { ...model.adjudications, [queueId]: adjudication },
    metrics: {
      ...model.metrics,
      reviewQueueSize: reviewQueue.filter((q) => q.status === 'queued').length,
    },
  };
}

function computeMetrics(
  pages: PageLayout[],
  ocrLines: OcrLine[],
  alignments: LayoutModel['alignments'],
  fields: LayoutModel['fields'],
  issues: LayoutModel['issues'],
  queue: LayoutModel['reviewQueue'],
): LayoutMetrics {
  const blocks = pages.flatMap((p) => p.blocks);
  return {
    pageCount: pages.length,
    blockCount: blocks.length,
    ocrLineCount: ocrLines.length,
    duplicateOcrLines: ocrLines.filter((l) => l.duplicateOf).length,
    alignedLines: alignments.filter((a) => a.status === 'aligned').length,
    ambiguousLines: alignments.filter((a) => a.status === 'ambiguous-overlap').length,
    spanningLines: alignments.filter((a) => a.status === 'spans-columns').length,
    unplacedLines: alignments.filter((a) => a.status === 'unplaced').length,
    fieldCount: fields.length,
    fieldsAtRisk: fields.filter((f) => f.status !== 'verified').length,
    highRiskIssues: issues.filter((i) => i.severity === 'high').length,
    reviewQueueSize: queue.filter((q) => q.status === 'queued').length,
    twoColumnPages: pages.filter((p) => p.columnGutters.length > 0).length,
    tableBlocks: blocks.filter((b) => b.role === 'table' || b.role === 'table-row' || b.role === 'table-cell').length,
    footnoteBlocks: blocks.filter((b) => b.role === 'footnote').length,
  };
}
