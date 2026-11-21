import type { Glyph } from '../../types';
import type { Codec, DecodeResult, EncodeResult } from './codec-types';

// Windows-1252 is defined by a fixed table. Browsers implement it fully, but
// some Node/ICU builds alias it to ISO-8859-1 for 0x80–0x9F, which would
// silently break mojibake detection (0x93 must decode to “, not a control).
// We therefore ship the table explicitly.

const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

export function cp1252ToChar(byte: number): string {
  if (byte < 0x80 || byte >= 0xa0) return String.fromCharCode(byte);
  const cp = CP1252_HIGH[byte];
  // 0x81, 0x8D, 0x8F, 0x90, 0x9D are unassigned in CP1252; keep byte identity
  // so nothing is silently lost.
  return cp === undefined ? String.fromCharCode(byte) : String.fromCodePoint(cp);
}

let rev: Map<number, number> | null = null;

export function cp1252Reverse(): Map<number, number> {
  if (rev) return rev;
  const map = new Map<number, number>();
  for (let b = 0; b < 256; b++) {
    const cp = cp1252ToChar(b).codePointAt(0) ?? 0;
    if (!map.has(cp)) map.set(cp, b);
  }
  rev = map;
  return map;
}

function suspiciousCp(cp: number): boolean {
  if (cp < 0x20) return cp !== 0x09 && cp !== 0x0a && cp !== 0x0d;
  if (cp >= 0x7f && cp <= 0x9f) return true;
  return false;
}

function makeSingleByteCodec(encoding: 'windows-1252' | 'iso-8859-1'): Codec {
  const decode = (bytes: Uint8Array, baseOffset = 0): DecodeResult => {
    const glyphs: Glyph[] = [];
    let suspiciousCount = 0;
    let text = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const ch = encoding === 'windows-1252' ? cp1252ToChar(b) : String.fromCharCode(b);
      const cp = ch.codePointAt(0) ?? 0;
      const susp = suspiciousCp(cp);
      if (susp) suspiciousCount++;
      text += ch;
      glyphs.push({
        text: ch,
        start: i + baseOffset,
        end: i + 1 + baseOffset,
        ...(susp ? { suspicious: true } : {}),
      });
    }
    return { glyphs, text, anomalyBytes: 0, anomalyCount: 0, suspiciousCount };
  };
  const encode = (text: string): EncodeResult => {
    const table = cp1252Reverse();
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i) ?? 0;
      if (cp > 0xffff) {
        return { error: `${encoding.toUpperCase()} 无法编码 U+${cp.toString(16).toUpperCase()}`, index: i };
      }
      let b: number | undefined;
      if (encoding === 'windows-1252') b = table.get(cp);
      else b = cp <= 0xff ? cp : undefined;
      if (b === undefined) {
        return { error: `字符 U+${cp.toString(16).toUpperCase()} 在 ${encoding.toUpperCase()} 中不可编码`, index: i };
      }
      out.push(b);
    }
    return { bytes: Uint8Array.from(out) };
  };
  return { id: encoding, decode, encode };
}

export const windows1252Codec = makeSingleByteCodec('windows-1252');
export const latin1Codec = makeSingleByteCodec('iso-8859-1');
