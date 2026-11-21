// Geometry primitives for the layout layer.
//
// All coordinates are page pixels with a top-left origin. The helpers here are
// pure and deterministic so the same input produces the same ordering in the
// worker, the page and the test suite.

import type { Rect } from '../../types';

export interface Box extends Rect {}

export function rectArea(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Fraction of `inner` covered by `outer` (0..1), area based. */
export function overlapFraction(inner: Rect, outer: Rect): number {
  const area = rectArea(inner);
  if (area === 0) return 0;
  const hit = intersection(inner, outer);
  return hit ? rectArea(hit) / area : 0;
}

/** Intersection over union — symmetric similarity for region contention. */
export function iou(a: Rect, b: Rect): number {
  const hit = intersection(a, b);
  if (!hit) return 0;
  const union = rectArea(a) + rectArea(b) - rectArea(hit);
  return union === 0 ? 0 : rectArea(hit) / union;
}

/** Horizontal gap between two rectangles; zero/negative when they overlap in x. */
export function horizontalGap(a: Rect, b: Rect): number {
  return Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
}

/** Vertical gap; zero/negative when their y spans touch or overlap. */
export function verticalGap(a: Rect, b: Rect): number {
  return Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
}

/**
 * True when a rect crosses a column gutter: meaningful width on both sides of
 * the gutter line. A mere touch (a few px) does not count, so a line sitting
 * entirely inside one column is never flagged.
 */
export function crossesGutter(r: Rect, gutterX: number, tolerance = 6): boolean {
  const leftWidth = gutterX - r.x;
  const rightWidth = r.x + r.width - gutterX;
  return leftWidth > tolerance && rightWidth > tolerance;
}

export function crossesAnyGutter(r: Rect, gutters: number[], tolerance = 6): boolean {
  return gutters.some((g) => crossesGutter(r, g, tolerance));
}

/** Which column band a rect's center falls into. */
export function columnOf(r: Rect, gutters: number[]): number {
  const center = r.x + r.width / 2;
  let col = 0;
  for (const g of gutters) {
    if (center > g) col++;
    else break;
  }
  return col;
}

/**
 * Linear order: strict top-to-bottom, then left-to-right. This is the fast,
 * deliberately naive rule from the brief — two-column pages and tables get
 * mis-ordered because column membership is ignored.
 */
export function linearOrder(blocks: { id: string; rect: Rect }[]): string[] {
  return [...blocks]
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id.localeCompare(b.id))
    .map((b) => b.id);
}

/**
 * Geometric reading order: column first (left gutter band before right), then
 * top-to-bottom inside each band, with explicit predecessor/successor links.
 * Full-width blocks (headings, tables spanning columns) are placed at their
 * vertical position across the whole page, so a table between the columns is
 * read once, at the right height, instead of being split into the column flow.
 */
export function geometricOrder(
  blocks: { id: string; rect: Rect; spansColumns: boolean }[],
  gutters: number[],
): string[] {
  const ranked = blocks.map((b) => ({
    id: b.id,
    col: b.spansColumns ? -1 : columnOf(b.rect, gutters),
    y: b.rect.y,
    x: b.rect.x,
  }));
  ranked.sort((a, b) => {
    // Spanning blocks interleave by vertical position against everything.
    if (a.col === -1 || b.col === -1) {
      if (a.y !== b.y) return a.y - b.y;
      if (a.col !== b.col) return a.col === -1 ? -1 : 1;
      return a.x - b.x || a.id.localeCompare(b.id);
    }
    return a.col - b.col || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
  });
  return ranked.map((r) => r.id);
}
