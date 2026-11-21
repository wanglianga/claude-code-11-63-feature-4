// Consistency checker and review-queue builder.
//
// Every field is checked along three axes named in the brief: its adjacent
// text, its section attribution and its image region. The checker never
// rewrites text — it downgrades field status, records evidence snippets and
// raises issues. Only high-risk localizations enter the review queue.

import type {
  ConsistencyIssue,
  ConsistencyIssueCode,
  FieldEvidence,
  IssueSeverity,
  LayoutBlock,
  LayoutReviewItem,
  LineAlignment,
  OcrLine,
  PageLayout,
} from '../../types';
import { findBareNumbers } from './fields';
import type { ReferenceText } from './aligner';

let issueSeq = 0;

function issue(
  code: ConsistencyIssueCode,
  severity: IssueSeverity,
  parts: {
    fieldId?: string | null;
    alignmentId?: string | null;
    blockId?: string | null;
    pageNumber?: number | null;
    message: string;
    evidence: string[];
  },
): ConsistencyIssue {
  issueSeq++;
  const base = parts.fieldId ?? parts.alignmentId ?? parts.blockId ?? `n${issueSeq}`;
  return {
    id: `issue-${code}-${base}`,
    code,
    severity,
    fieldId: parts.fieldId ?? null,
    alignmentId: parts.alignmentId ?? null,
    blockId: parts.blockId ?? null,
    pageNumber: parts.pageNumber ?? null,
    message: parts.message,
    evidence: parts.evidence,
  };
}

/** Reset deterministic issue counters; called by the layout engine per run. */
export function resetIssueCounters(): void {
  issueSeq = 0;
}

export interface ConsistencyInput {
  ref: ReferenceText;
  pages: PageLayout[];
  lines: OcrLine[];
  alignments: LineAlignment[];
  fields: FieldEvidence[];
  /** Block ids whose image digest changed after a re-crop. */
  staleBlockIds?: Set<string>;
  now: string;
}

export function checkConsistency(input: ConsistencyInput): {
  issues: ConsistencyIssue[];
  fields: FieldEvidence[];
  queue: LayoutReviewItem[];
} {
  const { ref, pages, lines, alignments, fields } = input;
  const staleBlockIds = input.staleBlockIds ?? new Set<string>();
  const issues: ConsistencyIssue[] = [];
  const blocksById = new Map<string, LayoutBlock>();
  const linesById = new Map<string, OcrLine>();
  const alignByLine = new Map<string, LineAlignment>();
  for (const p of pages) for (const b of p.blocks) blocksById.set(b.id, b);
  for (const l of lines) linesById.set(l.id, l);
  for (const a of alignments) alignByLine.set(a.ocrLineId, a);

  const downgraded = new Map<string, string[]>();
  const mark = (field: FieldEvidence, reason: string) => {
    const list = downgraded.get(field.id) ?? [];
    list.push(reason);
    downgraded.set(field.id, list);
  };

  /* 1. Alignment geometry issues (contention, spanning, duplicates). ------- */
  for (const alignment of alignments) {
    const line = linesById.get(alignment.ocrLineId);
    const blockId = alignment.candidateBlockIds[0] ?? null;
    const pageNumber = line?.pageNumber ?? null;
    if (line?.duplicateOf) {
      issues.push(
        issue('duplicate-ocr-line', 'medium', {
          alignmentId: alignment.id,
          blockId,
          pageNumber,
          message: `OCR 行 ${line.id} 与 ${line.duplicateOf} 文本重复（扫描重复行），定位证据需人工确认`,
          evidence: [line.text],
        }),
      );
    }
    if (alignment.status === 'spans-columns') {
      issues.push(
        issue('line-spans-columns', 'high', {
          alignmentId: alignment.id,
          blockId,
          pageNumber,
          message: `OCR 行 ${line?.id ?? ''} 跨越两列，对齐停在跨列待核，未强行归入任一区块`,
          evidence: alignment.flags,
        }),
      );
    }
    if (alignment.status === 'ambiguous-overlap') {
      issues.push(
        issue('line-region-contention', 'high', {
          alignmentId: alignment.id,
          blockId,
          pageNumber,
          message: `OCR 行 ${line?.id ?? ''} 的图像区域存在竞争或重叠分接近，对齐停在重叠待核`,
          evidence: alignment.flags,
        }),
      );
    }
  }

  /* 2. Per-field checks: adjacency, section attribution, image region. ----- */
  for (const field of fields) {
    const block = field.blockId ? blocksById.get(field.blockId) ?? null : null;

    // 2a. Image region must exist for anything that looks numeric/clinical.
    if (!block && field.kind !== 'population') {
      mark(field, '字段缺少可回查的页面图像区域');
      issues.push(
        issue('field-region-mismatch', field.kind === 'dosage' ? 'high' : 'medium', {
          fieldId: field.id,
          alignmentId: field.ocrLineId ? `align-${field.ocrLineId}` : null,
          pageNumber: field.pageNumber,
          message: `字段“${field.text}”无法回查到页面区域，不能作为定位证据`,
          evidence: [field.adjacentText],
        }),
      );
    }

    // 2b. Dosage inside a footnote block is high risk: footnotes frequently
    // belong to a different clause than the table cell they annotate.
    if (block && block.role === 'footnote' && field.kind === 'dosage') {
      mark(field, '剂量出现在脚注区块，可能不属于相邻表格单元格');
      issues.push(
        issue('footnote-dosage', 'high', {
          fieldId: field.id,
          blockId: block.id,
          pageNumber: block.pageNumber,
          message: `剂量“${field.text}”位于脚注区块 ${block.id}，须确认其归属的表格单元格`,
          evidence: [field.adjacentText, block.section || '脚注'],
        }),
      );
    }

    // 2c. Table-cell drift: a field aligned to a table block while its text
    // sits under a different section heading.
    if (block && (block.role === 'table' || block.role === 'table-cell') && field.section) {
      const textSection = latestSection(ref, field.byteRange);
      if (textSection && block.section && block.section !== textSection) {
        mark(field, `表格区块章节 ${block.section} 与文本章节 ${textSection} 不一致`);
        issues.push(
          issue('table-cell-drift', 'high', {
            fieldId: field.id,
            blockId: block.id,
            pageNumber: block.pageNumber,
            message: `表格字段“${field.text}”的区块归属章节与文本章节漂移`,
            evidence: [`区块章节：${block.section}`, `文本章节：${textSection}`],
          }),
        );
      }
    }

    // 2d. Stale anchor after a re-crop.
    if (block && staleBlockIds.has(block.id)) {
      mark(field, '页面区域已重新裁剪，旧定位证据失效，须重新校验');
      issues.push(
        issue('anchor-stale', 'high', {
          fieldId: field.id,
          blockId: block.id,
          pageNumber: block.pageNumber,
          message: `字段“${field.text}”依赖的锚点 ${block.id} 已被重新裁剪`,
          evidence: [field.adjacentText],
        }),
      );
    }
  }

  /* 3. Cross-section negation guard. --------------------------------------- */
  // A negation phrase may only govern clauses from its own section. Negation
  // and dosage are treated as one clause when their OCR lines are adjacent on
  // the same page (the repaired stream keeps no trustworthy sentence breaks
  // once OCR rows are mis-ordered). When the two then resolve to blocks under
  // different sections, the checker refuses to join them into one
  // contraindication and raises a high-risk issue.
  const lineOrder = new Map<string, { pageId: string; order: number }>();
  for (const p of pages) {
    const pageLines = lines
      .filter((l) => l.pageId === p.id)
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    pageLines.forEach((l, i) => lineOrder.set(l.id, { pageId: p.id, order: i }));
  }
  const areAdjacent = (aId: string | null, bId: string | null): boolean => {
    if (!aId || !bId) return false;
    const a = lineOrder.get(aId);
    const b = lineOrder.get(bId);
    if (!a || !b || a.pageId !== b.pageId) return false;
    return Math.abs(a.order - b.order) <= 3;
  };

  const negations = fields.filter((f) => f.kind === 'contraindication-negation');
  const dosages = fields.filter((f) => f.kind === 'dosage');
  for (const neg of negations) {
    for (const dose of dosages) {
      if (!areAdjacent(neg.ocrLineId, dose.ocrLineId)) continue;
      const negBlock = neg.blockId ? blocksById.get(neg.blockId) ?? null : null;
      const doseBlock = dose.blockId ? blocksById.get(dose.blockId) ?? null : null;
      if (negBlock && doseBlock && negBlock.sectionId !== doseBlock.sectionId) {
        mark(neg, `否定语与剂量值分属不同章节（${negBlock.section} / ${doseBlock.section}），禁止拼成同一句禁忌`);
        mark(dose, '剂量值被跨章节否定语引用，禁忌组合不成立');
        issues.push(
          issue('cross-section-negation', 'high', {
            fieldId: neg.id,
            blockId: negBlock.id,
            pageNumber: neg.pageNumber,
            message: `否定语“${neg.text}”与剂量“${dose.text}”来自不同章节，不得拼成同一句禁忌`,
            evidence: [
              `否定语章节：${negBlock.section}（区块 ${negBlock.id}）`,
              `剂量章节：${doseBlock.section}（区块 ${doseBlock.id}）`,
              `邻接文本：${neg.adjacentText} ｜ ${dose.adjacentText}`,
            ],
          }),
        );
      }
    }
  }

  /* 4. Bare numbers in dosage contexts — never accepted as dosages. -------- */
  // Only consider numbers that actually belong to an OCR line; layout
  // directive numbers (coordinates, page numbers) are not document content.
  const lineIntervals = alignments
    .filter((a) => a.byteRange[1] > a.byteRange[0])
    .map((a) => a.byteRange)
    .sort((a, b) => a[0] - b[0]);
  for (const bare of findBareNumbers(ref)) {
    const bs = ref.spans[bare.charStart]?.[0] ?? 0;
    const be = ref.spans[Math.min(bare.charEnd - 1, ref.spans.length - 1)]?.[1] ?? 0;
    const inOcrLine = lineIntervals.some(([s, e]) => bs < e && be > s);
    if (!inOcrLine) continue;
    issues.push(
      issue('bare-number-dosage', 'medium', {
        message: `剂量语境中的数字“${bare.text.match(/\d+(?:\.\d+)?/)?.[0] ?? bare.text}”没有附带单位，不直接视为剂量`,
        evidence: [bare.sentence],
        pageNumber: null,
        fieldId: null,
      }),
    );
  }

  // Apply downgrades.
  const outFields = fields.map((f) => {
    const extra = downgraded.get(f.id);
    if (!extra) return f;
    const reasons = [...f.reasons];
    for (const r of extra) if (!reasons.includes(r)) reasons.push(r);
    return { ...f, status: 'at-risk' as const, reasons };
  });

  const queue = buildQueue(issues, outFields, alignments, input.now);
  return { issues, fields: outFields, queue };
}

function buildQueue(
  issues: ConsistencyIssue[],
  fields: FieldEvidence[],
  alignments: LineAlignment[],
  now: string,
): LayoutReviewItem[] {
  const high = issues.filter((i) => i.severity === 'high');
  // Group issues that point at the same field/alignment/block so one queue
  // item covers one localization decision.
  const groups = new Map<string, ConsistencyIssue[]>();
  for (const i of high) {
    const key = i.fieldId ?? i.alignmentId ?? i.blockId ?? i.id;
    const list = groups.get(key) ?? [];
    list.push(i);
    groups.set(key, list);
  }
  const queue: LayoutReviewItem[] = [];
  for (const [key, list] of groups) {
    const first = list[0];
    const field = first.fieldId ? fields.find((f) => f.id === first.fieldId) ?? null : null;
    const alignment = first.alignmentId ? alignments.find((a) => a.id === first.alignmentId) ?? null : null;
    queue.push({
      id: `queue-${key}`,
      severity: 'high',
      issueIds: list.map((i) => i.id),
      fieldId: first.fieldId,
      alignmentId: first.alignmentId,
      pageId: field?.pageId ?? alignment?.pageId ?? null,
      blockId: first.blockId ?? field?.blockId ?? alignment?.candidateBlockIds[0] ?? null,
      status: 'queued',
      createdAt: now,
      decidedAt: null,
      decisionNote: '',
      imageDigestSha: null,
    });
  }
  return queue;
}

/* ------------------------------- helpers -------------------------------- */

/** Map an absolute byte range back to the reference-text character range. */
function charRangeOf(ref: ReferenceText, byteRange: [number, number]): [number, number] {
  let start = -1;
  let end = -1;
  for (let i = 0; i < ref.spans.length; i++) {
    const [bs, be] = ref.spans[i];
    if (start < 0 && be > byteRange[0] && bs < byteRange[1]) start = i;
    if (bs < byteRange[1] && be > byteRange[0]) end = i + 1;
  }
  if (start < 0) return [0, 0];
  return [start, Math.max(start + 1, end)];
}

function latestSection(ref: ReferenceText, byteRange: [number, number]): string {
  const [charIndex] = charRangeOf(ref, byteRange);
  const headings = [...ref.text.slice(0, charIndex).matchAll(/【([^】]+)】/g)];
  return headings.length ? headings[headings.length - 1][1] : '';
}
