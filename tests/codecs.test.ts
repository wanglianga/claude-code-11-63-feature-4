import { describe, expect, it } from 'vitest';
import { decodeUtf8, encodeUtf8 } from '../src/lib/encoding/unicode';
import { decodeWith, encodeWith } from '../src/lib/encoding/codecs';
import { utf8Encode } from '../src/lib/util/bytes';

describe('UTF-8 codec', () => {
  it('decodes valid text with exact byte offsets', () => {
    const bytes = utf8Encode('阿莫西林 0.5\nmg');
    const res = decodeUtf8(bytes);
    expect(res.text).toBe('阿莫西林 0.5\nmg');
    expect(res.anomalyCount).toBe(0);
    const first = res.glyphs[0];
    expect(first.start).toBe(0);
    expect(first.end).toBe(3);
    expect(res.glyphs[res.glyphs.length - 1].end).toBe(bytes.length);
  });

  it('records invalid and truncated sequences instead of deleting them', () => {
    const bytes = Uint8Array.from([0x41, 0xff, 0x42, 0xc3]);
    const res = decodeUtf8(bytes);
    expect(res.text).toBe('AB');
    expect(res.anomalyCount).toBe(2);
    const anomalies = res.glyphs.filter((g) => g.anomaly);
    expect(anomalies.map((a) => [a.start, a.end, a.anomaly])).toEqual([
      [1, 2, 'invalid-byte'],
      [3, 4, 'truncated-sequence'],
    ]);
  });

  it('rejects overlong encodings and surrogates', () => {
    const overlong = Uint8Array.from([0xc0, 0xaf]);
    expect(decodeUtf8(overlong).anomalyCount).toBeGreaterThan(0);
    const surrogate = Uint8Array.from([0xed, 0xa0, 0x80]);
    expect(decodeUtf8(surrogate).anomalyCount).toBe(1);
  });

  it('round-trips through the encoder', () => {
    const text = '头孢曲松钠 1.0 g\n【适应症】';
    const enc = encodeUtf8(text);
    if ('error' in enc) throw new Error(enc.error);
    expect(new TextDecoder().decode(enc.bytes)).toBe(text);
  });
});

describe('CJK codecs', () => {
  it('decodes GBK with correct offsets', () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x41]);
    const res = decodeWith('gb18030', bytes);
    expect(res.text).toBe('中文A');
    expect(res.anomalyCount).toBe(0);
    expect(res.glyphs[0]).toMatchObject({ start: 0, end: 2 });
    expect(res.glyphs[2]).toMatchObject({ start: 4, end: 5 });
  });

  it('decodes Big5 and reports unassigned pairs locally', () => {
    // 0xA4A4 = 中, 0xA5BF = 正 (Big5), 0xFF = invalid lead.
    const bytes = new Uint8Array([0xa4, 0xa4, 0xff, 0xa5, 0xbf]);
    const res = decodeWith('big5', bytes);
    expect(res.text).toBe('中正');
    expect(res.anomalyCount).toBe(1);
    expect(res.glyphs[1]).toMatchObject({ start: 2, end: 3, anomaly: 'invalid-byte' });
    expect(res.glyphs[2]).toMatchObject({ start: 3, end: 5 });
  });

  it('round-trips GBK text byte for byte', () => {
    const text = '注射用头孢曲松钠';
    const expected = Uint8Array.from([
      0xd7, 0xa2, 0xc9, 0xe4, 0xd3, 0xc3, 0xcd, 0xb7, 0xe6, 0xdf, 0xc7, 0xfa, 0xcb, 0xc9, 0xc4, 0xc6,
    ]);
    const enc = encodeWith('gb18030', text);
    if ('error' in enc) throw new Error(enc.error);
    expect(Array.from(enc.bytes)).toEqual(Array.from(expected));
    const dec = decodeWith('gb18030', expected);
    expect(dec.text).toBe(text);
    expect(dec.anomalyCount).toBe(0);
  });

  it('handles GB18030 four-byte characters', () => {
    const enc = encodeWith('gb18030', '𠀀');
    if ('error' in enc) throw new Error(enc.error);
    expect(enc.bytes).toHaveLength(4);
    expect(decodeWith('gb18030', enc.bytes).text).toBe('𠀀');
  });

  it('marks single-byte encodings without anomalies', () => {
    const res = decodeWith('windows-1252', Uint8Array.from([0x93, 0x41, 0x94]));
    expect(res.text).toBe('“A”');
    expect(res.anomalyCount).toBe(0);
  });
});
