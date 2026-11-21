import type { AnalysisParams, EncodingId } from '../../types';

export interface EncodingSpec {
  id: EncodingId;
  label: string;
  short: string;
  family: 'unicode' | 'cjk' | 'single-byte';
  asciiSuperset: boolean;
  /** Used in the segment label chips. */
  tone: string;
}

export const ENCODINGS: Record<EncodingId, EncodingSpec> = {
  'utf-8': {
    id: 'utf-8',
    label: 'UTF-8',
    short: 'UTF-8',
    family: 'unicode',
    asciiSuperset: true,
    tone: 'teal',
  },
  gb18030: {
    id: 'gb18030',
    label: 'GB18030 / GBK',
    short: 'GBK',
    family: 'cjk',
    asciiSuperset: true,
    tone: 'indigo',
  },
  big5: {
    id: 'big5',
    label: 'Big5',
    short: 'Big5',
    family: 'cjk',
    asciiSuperset: true,
    tone: 'amber',
  },
  'windows-1252': {
    id: 'windows-1252',
    label: 'Windows-1252',
    short: 'CP1252',
    family: 'single-byte',
    asciiSuperset: true,
    tone: 'rose',
  },
  'iso-8859-1': {
    id: 'iso-8859-1',
    label: 'ISO-8859-1',
    short: 'Latin-1',
    family: 'single-byte',
    asciiSuperset: true,
    tone: 'orange',
  },
  'utf-16le': {
    id: 'utf-16le',
    label: 'UTF-16 LE',
    short: 'UTF-16LE',
    family: 'unicode',
    asciiSuperset: false,
    tone: 'sky',
  },
  'utf-16be': {
    id: 'utf-16be',
    label: 'UTF-16 BE',
    short: 'UTF-16BE',
    family: 'unicode',
    asciiSuperset: false,
    tone: 'sky',
  },
};

export const ALL_ENCODING_IDS = Object.keys(ENCODINGS) as EncodingId[];

export const DEFAULT_PARAMS: AnalysisParams = {
  enabledEncodings: ['utf-8', 'gb18030', 'big5', 'windows-1252', 'iso-8859-1'],
  tileBytes: 512,
  minSegmentBytes: 256,
  mojibakeRunMinGlyphs: 4,
  confidenceThreshold: 0.62,
  marginThreshold: 0.08,
  maxCandidatesPerSegment: 6,
  includeUtf16: false,
};

export function candidateEncodings(params: AnalysisParams): EncodingId[] {
  const base = params.enabledEncodings.filter((e) => e !== 'utf-16le' && e !== 'utf-16be');
  return params.includeUtf16
    ? [...base, 'utf-16le' as EncodingId, 'utf-16be' as EncodingId]
    : base;
}

export function isCjkEncoding(enc: EncodingId | undefined): boolean {
  return enc === 'gb18030' || enc === 'big5';
}

export function isSingleByteEncoding(enc: EncodingId | undefined): boolean {
  return enc === 'windows-1252' || enc === 'iso-8859-1';
}

export function encodingLabel(enc: EncodingId | undefined | null): string {
  if (!enc) return '未知';
  return ENCODINGS[enc]?.short ?? enc;
}
