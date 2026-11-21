// Page parser.
//
// Inputs are OCR-style text documents. A document may carry explicit layout
// annotations (the bundled complex-page sample does); without them the parser
// degrades to a single page with one full-width block so every imported file
// still gets a layout model.
//
// Annotation grammar (one directive per line):
//   -- bytelab-layout:v1 pages=N width=W height=H direction=ltr --
//   @@page n=1
//   @@block id=B1 role=column col=0 section=【用法用量】 x=70 y=120 w=300 h=260
//   @@ocr id=L1 x=70 y=150 w=290 h=22 conf=0.98 dup=L0
//   <the next plain line is that OCR line's text>
//
// The parser only structures the document. Reading order, image summaries and
// geometric constraints are attached afterwards by buildPages().

import type {
  BlockRole,
  ImageDigest,
  LayoutBlock,
  OcrLine,
  OrderingMode,
  PageLayout,
  ReadingDirection,
  Rect,
} from '../../types';
import { columnOf, crossesAnyGutter, geometricOrder, linearOrder } from './geometry';
import { summarizeSynthetic } from './image-digest';

const LAYOUT_HEADER = 'bytelab-layout:v1';
const ROLES: BlockRole[] = [
  'title', 'heading', 'paragraph', 'column', 'table', 'table-row', 'table-cell',
  'footnote', 'caption', 'header', 'footer', 'unknown',
];

export interface RawBlock {
  id: string;
  pageNumber: number;
  role: BlockRole;
  section: string;
  col: number;
  rect: Rect;
}

export interface RawOcrLine {
  id: string;
  pageNumber: number;
  rect: Rect;
  conf: number;
  duplicateOf: string | null;
  text: string;
  /** Block currently open when the line was parsed; a hint, not authority. */
  blockHint: string | null;
}

export interface ParsedPage {
  pageNumber: number;
  width: number;
  height: number;
  direction: ReadingDirection;
  blocks: RawBlock[];
  lines: RawOcrLine[];
}

export interface ParsedDocument {
  hasAnnotations: boolean;
  direction: ReadingDirection;
  pages: ParsedPage[];
}

function parseAttrs(token: string): Record<string, string> {
  const out: Record<string, string> = {};
  // section=… may contain CJK brackets but never spaces in our samples.
  for (const part of token.trim().split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

function num(attrs: Record<string, string>, key: string, fallback = 0): number {
  const v = Number(attrs[key]);
  return Number.isFinite(v) ? v : fallback;
}

function rectFrom(attrs: Record<string, string>): Rect {
  return {
    x: num(attrs, 'x'),
    y: num(attrs, 'y'),
    width: num(attrs, 'w'),
    height: num(attrs, 'h'),
  };
}

/** Lossy structural decode: directives are ASCII, text keeps what it can. */
export function decodeStructure(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Parse a layout-annotated (or plain) OCR document. */
export function parseLayoutDocument(text: string): ParsedDocument {
  const lines = text.split(/\r?\n/);
  const header = lines.find((l) => l.includes(LAYOUT_HEADER));
  const hasAnnotations = Boolean(header);
  const headerAttrs = header ? parseAttrs(header) : {};
  const direction: ReadingDirection =
    headerAttrs.direction === 'rtl' ? 'rtl' : headerAttrs.direction === 'ttb' ? 'ttb' : 'ltr';
  const defaultWidth = num(headerAttrs, 'width', 800);
  const defaultHeight = num(headerAttrs, 'height', 1120);

  if (!hasAnnotations) return fallbackDocument(lines, defaultWidth, defaultHeight, direction);

  const pages: ParsedPage[] = [];
  let page: ParsedPage | null = null;
  let currentBlock: RawBlock | null = null;
  let pendingOcr: RawOcrLine | null = null;
  let autoSeq = 0;

  const ensurePage = (n: number): ParsedPage => {
    if (page && page.pageNumber === n) return page;
    page = {
      pageNumber: n,
      width: defaultWidth,
      height: defaultHeight,
      direction,
      blocks: [],
      lines: [],
    };
    pages.push(page);
    currentBlock = null;
    pendingOcr = null;
    return page;
  };

  for (const raw of lines) {
    const line = raw;
    if (line.includes(LAYOUT_HEADER)) continue;
    if (line.startsWith('@@page')) {
      ensurePage(num(parseAttrs(line), 'n', pages.length + 1));
      continue;
    }
    if (line.startsWith('@@block')) {
      if (!page) ensurePage(1);
      const a = parseAttrs(line);
      const role = (ROLES as string[]).includes(a.role ?? '') ? (a.role as BlockRole) : 'unknown';
      currentBlock = {
        id: a.id ?? `B${page!.blocks.length + 1}`,
        pageNumber: page!.pageNumber,
        role,
        section: a.section ?? '',
        col: num(a, 'col', 0),
        rect: rectFrom(a),
      };
      page!.blocks.push(currentBlock);
      pendingOcr = null;
      continue;
    }
    if (line.startsWith('@@ocr')) {
      if (!page) ensurePage(1);
      const a = parseAttrs(line);
      pendingOcr = {
        id: a.id ?? `L${page!.lines.length + 1}`,
        pageNumber: page!.pageNumber,
        rect: rectFrom(a),
        conf: Math.min(1, Math.max(0, num(a, 'conf', 0.9))),
        duplicateOf: a.dup ?? null,
        text: '',
        blockHint: currentBlock?.id ?? null,
      };
      page!.lines.push(pendingOcr);
      continue;
    }
    if (line.trim() === '') continue;
    if (pendingOcr) {
      pendingOcr.text = line;
      pendingOcr = null;
      continue;
    }
    if (!page) ensurePage(1);
    // Plain line without an explicit @@ocr: auto-place inside the open block.
    const index = autoSeq++;
    const y = 80 + index * 24;
    page!.lines.push({
      id: `auto-${page!.pageNumber}-${index}`,
      pageNumber: page!.pageNumber,
      rect: { x: 56, y, width: page!.width - 112, height: 22 },
      conf: 0.9,
      duplicateOf: null,
      text: line,
      blockHint: currentBlock?.id ?? null,
    });
  }

  if (pages.length === 0) return fallbackDocument(lines, defaultWidth, defaultHeight, direction);
  return { hasAnnotations, direction, pages };
}

/** Plain file: one page, one full-width block, lines auto-arranged. */
function fallbackDocument(
  lines: string[],
  width: number,
  height: number,
  direction: ReadingDirection,
): ParsedDocument {
  const blocks: RawBlock[] = [
    {
      id: 'B1',
      pageNumber: 1,
      role: 'paragraph',
      section: '',
      col: 0,
      rect: { x: 40, y: 40, width: width - 80, height: height - 80 },
    },
  ];
  const ocrLines: RawOcrLine[] = [];
  let seq = 0;
  for (const text of lines) {
    if (text.trim() === '' || text.includes(LAYOUT_HEADER)) continue;
    ocrLines.push({
      id: `L${seq + 1}`,
      pageNumber: 1,
      rect: { x: 56, y: 70 + seq * 24, width: width - 112, height: 22 },
      conf: 0.9,
      duplicateOf: null,
      text,
      blockHint: 'B1',
    });
    seq++;
  }
  return {
    hasAnnotations: false,
    direction,
    pages: [
      { pageNumber: 1, width, height, direction, blocks, lines: ocrLines },
    ],
  };
}

/** Detect column gutters from block geometry; at most one gutter per page. */
function detectGutters(page: ParsedPage): number[] {
  const col0 = page.blocks.filter((b) => b.col === 0);
  const col1 = page.blocks.filter((b) => b.col >= 1);
  if (col1.length === 0) return [];
  const rightEdgeLeft = Math.max(...col0.map((b) => b.rect.x + b.rect.width));
  const leftEdgeRight = Math.min(...col1.map((b) => b.rect.x));
  if (leftEdgeRight > rightEdgeLeft) return [Math.round((rightEdgeLeft + leftEdgeRight) / 2)];
  return [Math.round(page.width / 2)];
}

const sectionIds = new Map<string, string>();

function sectionIdOf(section: string): string {
  if (!section) return 'sec:root';
  const known = sectionIds.get(section);
  if (known) return known;
  const id = `sec:${sectionIds.size + 1}`;
  sectionIds.set(section, id);
  return id;
}

/** Reset the section-id table; used by tests and re-runs. */
export function resetSectionIds(): void {
  sectionIds.clear();
}

function blockText(page: ParsedPage, blockId: string): string {
  return page.lines.filter((l) => l.blockHint === blockId).map((l) => l.text).join('\n');
}

/**
 * Turn parsed pages into ordered PageLayout objects. `ordering` selects the
 * fast linear rule (top-bottom, left-right; mis-orders columns and tables) or
 * the geometric rule (column constraints + predecessor/successor links).
 */
export function buildPages(parsed: ParsedDocument, ordering: OrderingMode): PageLayout[] {
  resetSectionIds();
  return parsed.pages.map((page): PageLayout => {
    const gutters = detectGutters(page);
    const prelim = page.blocks.map((b) => ({
      ...b,
      spansColumns: gutters.length > 0 && crossesAnyGutter(b.rect, gutters),
    }));
    const orderIds =
      ordering === 'linear'
        ? linearOrder(prelim)
        : geometricOrder(
            prelim.map((b) => ({ id: b.id, rect: b.rect, spansColumns: b.spansColumns })),
            gutters,
          );

    const blocks: LayoutBlock[] = [];
    for (const b of prelim) {
      const order = orderIds.indexOf(b.id);
      const digest: ImageDigest = summarizeSynthetic(b.rect, blockText(page, b.id) || b.section);
      blocks.push({
        id: b.id,
        pageId: `page-${page.pageNumber}`,
        pageNumber: page.pageNumber,
        role: b.role,
        section: b.section,
        sectionId: sectionIdOf(b.section),
        rect: b.rect,
        column: b.spansColumns ? -1 : columnOf(b.rect, gutters),
        direction: page.direction,
        order,
        imageDigest: digest,
        spansColumns: b.spansColumns,
        prevBlockId: order > 0 ? orderIds[order - 1] : null,
        nextBlockId: order < orderIds.length - 1 ? orderIds[order + 1] : null,
      });
    }
    blocks.sort((a, b) => a.order - b.order);

    const pageDigest = summarizeSynthetic(
      { x: 0, y: 0, width: page.width, height: page.height },
      page.lines.map((l) => l.text).join('\n'),
    );
    return {
      id: `page-${page.pageNumber}`,
      pageNumber: page.pageNumber,
      pageSize: { width: page.width, height: page.height },
      direction: page.direction,
      blocks,
      columnGutters: gutters,
      imageDigest: pageDigest,
      ordering,
    };
  });
}

export function toOcrLines(parsed: ParsedDocument): OcrLine[] {
  const out: OcrLine[] = [];
  for (const page of parsed.pages) {
    for (const l of page.lines) {
      out.push({
        id: l.id,
        pageId: `page-${l.pageNumber}`,
        pageNumber: l.pageNumber,
        rect: l.rect,
        text: l.text,
        ocrConfidence: l.conf,
        duplicateOf: l.duplicateOf,
      });
    }
  }
  return out;
}
