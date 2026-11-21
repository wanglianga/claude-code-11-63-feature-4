import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/util/sha256';
import { utf8Encode } from '../src/lib/util/bytes';

describe('sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('handles long input spanning many blocks', () => {
    const data = new Uint8Array(1000).fill(0x61);
    const hex = sha256Hex(data);
    expect(hex).toHaveLength(64);
    expect(sha256Hex(utf8Encode('a'.repeat(1000)))).toBe(hex);
  });
});
