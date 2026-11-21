import type { AnomalyKind, Glyph } from '../../types';
import type { Codec, DecodeResult } from './codec-types';

function suspiciousChar(cp: number): boolean {
  if (cp < 0x20) return cp !== 0x09 && cp !== 0x0a && cp !== 0x0d;
  if (cp >= 0x7f && cp <= 0x9f) return true;
  if (cp >= 0xe000 && cp <= 0xf8ff) return true;
  if (cp === 0xfffd) return true;
  return false;
}

function glyphFromCp(cp: number, start: number, end: number): Glyph {
  const text = String.fromCodePoint(cp);
  return suspiciousChar(cp)
    ? { text, start, end, suspicious: true }
    : { text, start, end };
}

/** Strict UTF-8 decoder producing per-glyph anomaly records. */
export function decodeUtf8(bytes: Uint8Array, baseOffset = 0): DecodeResult {
  const glyphs: Glyph[] = [];
  let i = 0;
  let anomalyBytes = 0;
  let anomalyCount = 0;
  let suspiciousCount = 0;
  let bom: 'utf-8' | undefined;

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = 'utf-8';
    glyphs.push({ text: '﻿', start: baseOffset, end: baseOffset + 3, detail: 'UTF-8 BOM' });
    i = 3;
  }

  const pushAnomaly = (start: number, end: number, anomaly: AnomalyKind, detail: string) => {
    glyphs.push({ text: '', start: start + baseOffset, end: end + baseOffset, anomaly, detail });
    anomalyBytes += end - start;
    anomalyCount++;
  };

  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      glyphs.push(glyphFromCp(b0, i + baseOffset, i + 1 + baseOffset));
      if (suspiciousChar(b0)) suspiciousCount++;
      i++;
      continue;
    }
    let need = 0;
    let cp = 0;
    let minCp = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
      minCp = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      minCp = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      minCp = 0x10000;
    } else {
      // 0x80-0xC1, 0xF5-0xFF can never start a sequence.
      pushAnomaly(i, i + 1, 'invalid-byte', `非法首字节 0x${b0.toString(16).toUpperCase()}`);
      i++;
      continue;
    }

    let j = i + 1;
    let ok = true;
    for (let k = 0; k < need; k++) {
      if (j >= bytes.length) {
        ok = false;
        break;
      }
      const bc = bytes[j];
      if ((bc & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (bc & 0x3f);
      j++;
    }
    if (!ok) {
      const consumed = j - i;
      if (j >= bytes.length) {
        pushAnomaly(i, j, 'truncated-sequence', `UTF-8 序列在文件末尾被截断（缺 ${need - (j - i - 1)} 个续字节）`);
      } else {
        pushAnomaly(i, Math.max(i + 1, j), 'invalid-byte', `UTF-8 续字节非法（0x${bytes[j].toString(16).toUpperCase()}）`);
        // consume the valid prefix only (maximal subpart)
        void consumed;
      }
      i = Math.max(i + 1, j);
      continue;
    }
    const overlong = cp < minCp;
    const surrogate = cp >= 0xd800 && cp <= 0xdfff;
    const tooLarge = cp > 0x10ffff;
    if (overlong || surrogate || tooLarge) {
      const kind: AnomalyKind = 'invalid-byte';
      const detail = overlong
        ? 'UTF-8 过长编码（overlong）'
        : surrogate
          ? 'UTF-8 编码了代理区码点'
          : 'UTF-8 码点超出 U+10FFFF';
      pushAnomaly(i, j, kind, detail);
      i = j;
      continue;
    }
    glyphs.push(glyphFromCp(cp, i + baseOffset, j + baseOffset));
    i = j;
  }

  let text = '';
  for (const g of glyphs) text += g.anomaly ? '' : g.text;
  return { glyphs, text, anomalyBytes, anomalyCount, suspiciousCount, bom };
}

export function encodeUtf8(text: string): { bytes: Uint8Array } | { error: string; index: number } {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let cp = code;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        return { error: `文本位置 ${i} 处存在孤立的高代理 U+${code.toString(16).toUpperCase()}`, index: i };
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return { error: `文本位置 ${i} 处存在孤立的低代理 U+${code.toString(16).toUpperCase()}`, index: i };
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return { bytes: Uint8Array.from(out) };
}

export function decodeUtf16(bytes: Uint8Array, baseOffset: number, littleEndian: boolean): DecodeResult {
  const glyphs: Glyph[] = [];
  let anomalyBytes = 0;
  let anomalyCount = 0;
  let suspiciousCount = 0;
  let i = 0;
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe && littleEndian) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff && !littleEndian))
  ) {
    glyphs.push({
      text: '﻿',
      start: baseOffset,
      end: baseOffset + 2,
      detail: littleEndian ? 'UTF-16LE BOM' : 'UTF-16BE BOM',
    });
    i = 2;
  }
  const pushAnomaly = (start: number, end: number, anomaly: AnomalyKind, detail: string) => {
    glyphs.push({ text: '', start: start + baseOffset, end: end + baseOffset, anomaly, detail });
    anomalyBytes += end - start;
    anomalyCount++;
  };
  while (i < bytes.length) {
    if (i + 1 >= bytes.length) {
      pushAnomaly(i, i + 1, 'odd-length', 'UTF-16 码元在文件末尾只剩 1 字节');
      i++;
      continue;
    }
    const unit = littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 3 < bytes.length) {
        const next = littleEndian ? bytes[i + 2] | (bytes[i + 3] << 8) : (bytes[i + 2] << 8) | bytes[i + 3];
        if (next >= 0xdc00 && next <= 0xdfff) {
          const cp = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
          glyphs.push(glyphFromCp(cp, i + baseOffset, i + 4 + baseOffset));
          i += 4;
          continue;
        }
      }
      pushAnomaly(i, i + 2, 'unpaired-surrogate', '高位代理后缺少低位代理');
      i += 2;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      pushAnomaly(i, i + 2, 'unpaired-surrogate', '孤立的低位代理');
      i += 2;
      continue;
    }
    glyphs.push(glyphFromCp(unit, i + baseOffset, i + 2 + baseOffset));
    if (suspiciousChar(unit)) suspiciousCount++;
    i += 2;
  }
  let text = '';
  for (const g of glyphs) text += g.anomaly ? '' : g.text;
  return { glyphs, text, anomalyBytes, anomalyCount, suspiciousCount };
}

export function encodeUtf16(
  text: string,
  littleEndian: boolean,
): { bytes: Uint8Array } | { error: string; index: number } {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return { error: `文本位置 ${i} 处存在未成对的代理项`, index: i };
      }
      i++;
      const units = [unit, next];
      for (const u of units) {
        if (littleEndian) out.push(u & 0xff, u >> 8);
        else out.push(u >> 8, u & 0xff);
      }
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { error: `文本位置 ${i} 处存在未成对的代理项`, index: i };
    }
    if (littleEndian) out.push(unit & 0xff, unit >> 8);
    else out.push(unit >> 8, unit & 0xff);
  }
  return { bytes: Uint8Array.from(out) };
}

export const utf8Codec: Codec = {
  id: 'utf-8',
  decode: (bytes, baseOffset = 0) => decodeUtf8(bytes, baseOffset),
  encode: encodeUtf8,
};

export const utf16leCodec: Codec = {
  id: 'utf-16le',
  decode: (bytes, baseOffset = 0) => decodeUtf16(bytes, baseOffset, true),
  encode: (text) => encodeUtf16(text, true),
};

export const utf16beCodec: Codec = {
  id: 'utf-16be',
  decode: (bytes, baseOffset = 0) => decodeUtf16(bytes, baseOffset, false),
  encode: (text) => encodeUtf16(text, false),
};
