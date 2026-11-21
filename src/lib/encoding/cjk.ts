import type { AnomalyKind, EncodingId, Glyph } from '../../types';
import type { Codec, DecodeResult, EncodeResult } from './codec-types';
import { cp1252Reverse, cp1252ToChar } from './singleByte';
import {
  BIG5_TABLE_B64,
  GBK_TABLE_B64,
  GB_FOUR_BYTE_RANGES,
  TWO_BYTE_LEAD_MAX,
  TWO_BYTE_LEAD_MIN,
  TWO_BYTE_TRAIL_GAP,
  TWO_BYTE_TRAIL_MAX,
  TWO_BYTE_TRAIL_MIN,
} from './tables-data';

// All CJK tables are compiled into tables-data.ts (see
// scripts/generate-encoding-tables.py) so the browser, the worker and the
// test runner agree on every slot regardless of the host ICU build.

interface TwoByteTable {
  /** cp for (lead,trail), or 0 when the slot is unassigned. */
  slots: Uint16Array;
  reverse: Map<number, number>;
  leadCount: number;
  trailCount: number;
  trails: number[];
}

const TRAILS: number[] = [];
for (let t = TWO_BYTE_TRAIL_MIN; t <= TWO_BYTE_TRAIL_MAX; t++) if (t !== TWO_BYTE_TRAIL_GAP) TRAILS.push(t);
const LEADS: number[] = [];
for (let l = TWO_BYTE_LEAD_MIN; l <= TWO_BYTE_LEAD_MAX; l++) LEADS.push(l);

function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback for tests.
  const buf = (globalThis as unknown as { Buffer: typeof Buffer }).Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function buildTwoByteTable(b64: string): TwoByteTable {
  const raw = decodeBase64(b64);
  const slots = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const reverse = new Map<number, number>();
  for (let li = 0; li < LEADS.length; li++) {
    for (let ti = 0; ti < TRAILS.length; ti++) {
      const cp = slots[li * TRAILS.length + ti];
      if (cp === 0) continue;
      const key = (LEADS[li] << 8) | TRAILS[ti];
      const existing = reverse.get(cp);
      // Keep the smallest byte pair as canonical (matches common encoders).
      if (existing === undefined || key < existing) reverse.set(cp, key);
    }
  }
  return { slots, reverse, leadCount: LEADS.length, trailCount: TRAILS.length, trails: TRAILS };
}

let gbkTable: TwoByteTable | null = null;
let big5Table: TwoByteTable | null = null;

function tableFor(encoding: EncodingId): TwoByteTable {
  if (encoding === 'gb18030') {
    if (!gbkTable) gbkTable = buildTwoByteTable(GBK_TABLE_B64);
    return gbkTable;
  }
  if (!big5Table) big5Table = buildTwoByteTable(BIG5_TABLE_B64);
  return big5Table;
}

function lookup(table: TwoByteTable, lead: number, trail: number): number {
  const li = lead - TWO_BYTE_LEAD_MIN;
  const ti = table.trails.indexOf(trail);
  if (li < 0 || li >= table.leadCount || ti < 0) return 0;
  return table.slots[li * table.trailCount + ti];
}

// GB18030 4-byte lookup: ranges of contiguous pointer → codepoint runs.
let fourByteRanges: ReadonlyArray<readonly [number, number]> = GB_FOUR_BYTE_RANGES;

function fourByteCodePoint(pointer: number): number | null {
  // Binary search over range starts.
  let lo = 0;
  let hi = fourByteRanges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, cp] = fourByteRanges[mid];
    if (pointer < start) hi = mid - 1;
    else {
      const next = fourByteRanges[mid + 1];
      if (next && pointer >= next[0]) lo = mid + 1;
      else {
        const value = cp + (pointer - start);
        // A gap between this range and the next is possible for unassigned
        // pointers; the encoder never produces them, so accept the linear run.
        return value;
      }
    }
  }
  return null;
}

/** Reverse lookup for GB18030 4-byte forms (used by the encoder). */
function fourBytePointerFor(cp: number): number | null {
  for (let i = 0; i < fourByteRanges.length; i++) {
    const [start, base] = fourByteRanges[i];
    const next = fourByteRanges[i + 1];
    const end = next ? next[0] : Number.MAX_SAFE_INTEGER;
    if (cp >= base && (next === undefined || cp < next[1] || (cp - base < end - start))) {
      const pointer = start + (cp - base);
      if (next === undefined || pointer < next[0]) return pointer;
    }
  }
  // Fallback for the supplementary plane mapping.
  if (cp >= 0x10000) {
    const pointer = 189000 + (cp - 0x10000);
    if (pointer <= 1237575) return pointer;
  }
  return null;
}

export function encodedPairBytes(key: number): Uint8Array {
  return Uint8Array.of((key >> 8) & 0xff, key & 0xff);
}

export function fourByteFromPointer(pointer: number): Uint8Array {
  const b1 = Math.floor(pointer / 12600) + 0x81;
  const b2 = Math.floor((pointer % 12600) / 1260) + 0x30;
  const b3 = Math.floor((pointer % 1260) / 10) + 0x81;
  const b4 = (pointer % 10) + 0x30;
  return Uint8Array.of(b1, b2, b3, b4);
}

export function pointerFromFourByte(b1: number, b2: number, b3: number, b4: number): number {
  return (b1 - 0x81) * 12600 + (b2 - 0x30) * 1260 + (b3 - 0x81) * 10 + (b4 - 0x30);
}

function suspiciousCp(cp: number): boolean {
  if (cp < 0x20) return cp !== 0x09 && cp !== 0x0a && cp !== 0x0d;
  if (cp >= 0x7f && cp <= 0x9f) return true;
  if (cp >= 0xe000 && cp <= 0xf8ff) return true;
  if (cp === 0xfffd) return true;
  return false;
}

function makeDecode(encoding: EncodingId): (bytes: Uint8Array, baseOffset?: number) => DecodeResult {
  return (bytes, baseOffset = 0) => {
    const table = tableFor(encoding);
    const glyphs: Glyph[] = [];
    let anomalyBytes = 0;
    let anomalyCount = 0;
    let suspiciousCount = 0;
    let i = 0;
    const pushAnomaly = (start: number, end: number, anomaly: AnomalyKind, detail: string) => {
      glyphs.push({ text: '', start: start + baseOffset, end: end + baseOffset, anomaly, detail });
      anomalyBytes += end - start;
      anomalyCount++;
    };
    while (i < bytes.length) {
      const b0 = bytes[i];
      if (b0 < 0x80) {
        const susp = suspiciousCp(b0);
        if (susp) suspiciousCount++;
        glyphs.push({
          text: String.fromCharCode(b0),
          start: i + baseOffset,
          end: i + 1 + baseOffset,
          ...(susp ? { suspicious: true } : {}),
        });
        i++;
        continue;
      }
      // GB18030 reserves the Euro sign at 0xA2E3 in its GBK-compatible row;
      // the compiled GBK table already carries it from the source codec.
      if (b0 === 0xff) {
        pushAnomaly(i, i + 1, 'invalid-byte', `${encoding.toUpperCase()} 中 0xFF 不是合法字节`);
        i++;
        continue;
      }
      if (b0 === 0x80) {
        pushAnomaly(i, i + 1, 'invalid-byte', `${encoding.toUpperCase()} 中 0x80 通常为非法单字节`);
        i++;
        continue;
      }
      if (i + 1 >= bytes.length) {
        pushAnomaly(i, i + 1, 'truncated-sequence', `末尾只剩 1 个双字节序列的首字节 0x${b0.toString(16).toUpperCase()}`);
        i++;
        continue;
      }
      const b1 = bytes[i + 1];
      const cp = lookup(table, b0, b1);
      if (cp !== 0) {
        const ch = String.fromCharCode(cp);
        const susp = suspiciousCp(cp);
        if (susp) suspiciousCount++;
        glyphs.push({
          text: ch,
          start: i + baseOffset,
          end: i + 2 + baseOffset,
          ...(susp ? { suspicious: true } : {}),
        });
        i += 2;
        continue;
      }
      if (
        encoding === 'gb18030' &&
        b1 >= 0x30 &&
        b1 <= 0x39 &&
        i + 3 < bytes.length &&
        bytes[i + 2] >= 0x81 &&
        bytes[i + 2] <= 0xfe &&
        bytes[i + 3] >= 0x30 &&
        bytes[i + 3] <= 0x39
      ) {
        const pointer = pointerFromFourByte(b0, b1, bytes[i + 2], bytes[i + 3]);
        const cp4 = fourByteCodePoint(pointer);
        if (cp4 !== null) {
          glyphs.push({ text: String.fromCodePoint(cp4), start: i + baseOffset, end: i + 4 + baseOffset });
          i += 4;
          continue;
        }
      }
      if (encoding === 'gb18030' && b1 >= 0x30 && b1 <= 0x39) {
        pushAnomaly(i, Math.min(i + 2, bytes.length), 'unassigned-sequence', 'GB18030 四字节序列不完整或未分配');
        i += 2;
        continue;
      }
      pushAnomaly(
        i,
        i + 1,
        'unassigned-sequence',
        `未分配的双字节序列 0x${b0.toString(16).toUpperCase()} 0x${b1.toString(16).toUpperCase()}`,
      );
      i++;
    }
    let text = '';
    for (const g of glyphs) text += g.anomaly ? '' : g.text;
    return { glyphs, text, anomalyBytes, anomalyCount, suspiciousCount };
  };
}

function makeEncode(encoding: EncodingId): (text: string) => EncodeResult {
  return (text) => {
    const table = tableFor(encoding);
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
          return { error: `${encoding.toUpperCase()} 无法编码孤立代理 U+${code.toString(16).toUpperCase()}`, index: i };
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return { error: `${encoding.toUpperCase()} 无法编码孤立代理 U+${code.toString(16).toUpperCase()}`, index: i };
      }
      if (cp < 0x80) {
        out.push(cp);
        continue;
      }
      const key = table.reverse.get(cp);
      if (key !== undefined) {
        out.push((key >> 8) & 0xff, key & 0xff);
        continue;
      }
      if (encoding === 'gb18030') {
        const pointer = fourBytePointerFor(cp);
        if (pointer !== null) {
          const b = fourByteFromPointer(pointer);
          out.push(b[0], b[1], b[2], b[3]);
          continue;
        }
      }
      return {
        error: `字符 U+${cp.toString(16).toUpperCase()} 在 ${encoding.toUpperCase()} 中不可编码`,
        index: i,
      };
    }
    return { bytes: Uint8Array.from(out) };
  };
}

export const gb18030Codec: Codec = {
  id: 'gb18030',
  decode: makeDecode('gb18030'),
  encode: makeEncode('gb18030'),
};

export const big5Codec: Codec = {
  id: 'big5',
  decode: makeDecode('big5'),
  encode: makeEncode('big5'),
};

/** Canonical byte pair for a character in an encoding (used by mojibake repair). */
export function encodeCharIn(encoding: EncodingId, cp: number): Uint8Array | null {
  if (encoding === 'utf-8') {
    if (cp < 0x80) return Uint8Array.of(cp);
    if (cp < 0x800) return Uint8Array.of(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    if (cp < 0x10000)
      return Uint8Array.of(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    return Uint8Array.of(
      0xf0 | (cp >> 18),
      0x80 | ((cp >> 12) & 0x3f),
      0x80 | ((cp >> 6) & 0x3f),
      0x80 | (cp & 0x3f),
    );
  }
  if (encoding === 'utf-16le') {
    return cp >= 0x10000
      ? Uint8Array.of(...utf16Surrogates(cp).flatMap((u) => [u & 0xff, u >> 8]))
      : Uint8Array.of(cp & 0xff, cp >> 8);
  }
  if (encoding === 'utf-16be') {
    return cp >= 0x10000
      ? Uint8Array.of(...utf16Surrogates(cp).flatMap((u) => [u >> 8, u & 0xff]))
      : Uint8Array.of(cp >> 8, cp & 0xff);
  }
  if (encoding === 'windows-1252') {
    const b = cp1252Reverse().get(cp);
    return b === undefined ? null : Uint8Array.of(b);
  }
  if (encoding === 'iso-8859-1') {
    return cp <= 0xff ? Uint8Array.of(cp) : null;
  }
  const table = tableFor(encoding);
  if (cp < 0x80) return Uint8Array.of(cp);
  const key = table.reverse.get(cp);
  if (key !== undefined) return encodedPairBytes(key);
  if (encoding === 'gb18030') {
    const pointer = fourBytePointerFor(cp);
    if (pointer !== null) return fourByteFromPointer(pointer);
  }
  return null;
}

function utf16Surrogates(cp: number): [number, number] {
  const v = cp - 0x10000;
  return [0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)];
}

export { cp1252ToChar };
