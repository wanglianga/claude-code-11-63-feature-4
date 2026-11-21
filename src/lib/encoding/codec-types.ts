import type { EncodingId, Glyph } from '../../types';

export interface DecodeResult {
  glyphs: Glyph[];
  text: string;
  anomalyBytes: number;
  anomalyCount: number;
  suspiciousCount: number;
  bom?: 'utf-8' | 'utf-16le' | 'utf-16be';
}

export type EncodeResult = { bytes: Uint8Array } | { error: string; index: number };

export interface Codec {
  id: EncodingId;
  decode(bytes: Uint8Array, baseOffset?: number): DecodeResult;
  encode(text: string): EncodeResult;
}
