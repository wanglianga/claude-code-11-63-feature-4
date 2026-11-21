import type { EncodingId } from '../../types';
import type { Codec } from './codec-types';
import { gb18030Codec, big5Codec } from './cjk';
import { utf8Codec, utf16leCodec, utf16beCodec } from './unicode';
import { windows1252Codec, latin1Codec } from './singleByte';

const registry: Record<EncodingId, Codec> = {
  'utf-8': utf8Codec,
  gb18030: gb18030Codec,
  big5: big5Codec,
  'windows-1252': windows1252Codec,
  'iso-8859-1': latin1Codec,
  'utf-16le': utf16leCodec,
  'utf-16be': utf16beCodec,
};

const cache = new Map<EncodingId, Codec>();

export function getCodec(encoding: EncodingId): Codec {
  const existing = cache.get(encoding);
  if (existing) return existing;
  const codec = registry[encoding];
  cache.set(encoding, codec);
  return codec;
}

export function decodeWith(encoding: EncodingId, bytes: Uint8Array, baseOffset = 0) {
  return getCodec(encoding).decode(bytes, baseOffset);
}

export function encodeWith(encoding: EncodingId, text: string) {
  return getCodec(encoding).encode(text);
}

export type { Codec, DecodeResult, EncodeResult } from './codec-types';
