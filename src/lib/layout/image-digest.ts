// Deterministic image summaries.
//
// The workspace never persists page images: a region is represented by a
// coarse 8x8 luminance thumbnail plus a SHA-256 over its normalized cells.
// That is enough to (a) give every block/page a stable "image region"
// reference and (b) detect that a user re-cropped a region, while keeping the
// IndexedDB payload small and fully reproducible.
//
// Real OCR imports may supply an actual grayscale raster; the bundled text
// samples instead get a deterministic synthetic raster derived from geometry
// and glyph content, so the whole pipeline stays testable without binary
// assets.

import type { ImageDigest, Rect } from '../../types';
import { sha256Hex } from '../util/sha256';

const THUMB = 8;

/** Downsample a grayscale raster (rows of 0..255) to the fixed thumbnail grid. */
export function downsample(pixels: number[][], grid = THUMB): number[] {
  const height = pixels.length;
  const width = height > 0 ? pixels[0].length : 0;
  if (height === 0 || width === 0) return new Array(grid * grid).fill(0);
  const out: number[] = [];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * width) / grid);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / grid));
      const y0 = Math.floor((gy * height) / grid);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / grid));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += clampByte(pixels[y][x] ?? 0);
          count++;
        }
      }
      out.push(count === 0 ? 0 : Math.round(sum / count));
    }
  }
  return out;
}

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function digestFromPixels(
  pixels: number[][],
  sourceWidth: number,
  sourceHeight: number,
): ImageDigest {
  const thumbnail = downsample(pixels);
  const cells = thumbnail.length;
  const meanLuminance = Number(
    (thumbnail.reduce((n, v) => n + v, 0) / (cells * 255)).toFixed(4),
  );
  // Normalize before hashing so two equivalent rasters always agree.
  const sha256 = sha256Hex(JSON.stringify({ thumbnail, sourceWidth, sourceHeight }));
  return { sha256, cells, meanLuminance, thumbnail, sourceWidth, sourceHeight };
}

/**
 * Build a deterministic grayscale raster for a region that has no real image.
 * Luminance comes from geometry and the text's code points — the same region
 * always renders the same raster, and changing either the crop rectangle or
 * the text changes the digest. No randomness is used on purpose.
 */
export function synthesizeRaster(rect: Rect, text: string, resolution = 32): number[][] {
  const rows: number[][] = [];
  // A stable per-region base tone keeps different blocks visually distinct.
  let base = (rect.x * 7 + rect.y * 13 + rect.width * 3 + rect.height * 5) % 96;
  for (let y = 0; y < resolution; y++) {
    const row: number[] = [];
    for (let x = 0; x < resolution; x++) {
      const charIndex = (y * resolution + x) % Math.max(1, text.length);
      const code = text.charCodeAt(charIndex) || 32;
      // Glyph "ink": dark where a visible character would sit.
      const ink = code === 32 || code === 10 || code === 13 ? 0 : 48 + (code % 160);
      const positional = ((x * 17 + y * 31 + base) % 24) - 12;
      row.push(clampByte(232 - ink + positional));
    }
    rows.push(row);
    base = (base + 1) % 96;
  }
  return rows;
}

/** Image summary for a synthetic (sample-driven) region. */
export function summarizeSynthetic(rect: Rect, text: string): ImageDigest {
  const pixels = synthesizeRaster(rect, text);
  return digestFromPixels(pixels, Math.round(rect.width), Math.round(rect.height));
}
