import type { Glyph } from '../../types';
import type { Lexicon } from './lexicon';
import { normalizeChar } from './lexicon';

export type CharClass =
  | 'ascii-printable'
  | 'whitespace'
  | 'cjk-common'
  | 'cjk-rare'
  | 'latin-ext'
  | 'punct'
  | 'control'
  | 'private-use'
  | 'replacement'
  | 'other';

const CJK_PUNCT = new Set(
  '，。、；：？！“”‘’（）《》〈〉【】—…·％‰℃±×÷≤≥≈～￥'.split(''),
);

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

export function classifyChar(ch: string, rank: Map<string, number>): CharClass {
  if (ch === '') return 'other';
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0xfffd) return 'replacement';
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20) return 'whitespace';
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 'control';
  if (cp >= 0xe000 && cp <= 0xf8ff) return 'private-use';
  if (cp < 0x80) return ASCII_PUNCT.test(ch) ? 'punct' : 'ascii-printable';
  if (CJK_PUNCT.has(ch)) return 'punct';
  if (cp >= 0x4e00 && cp <= 0x9fff) {
    if (rank.has(ch)) return 'cjk-common';
    return 'cjk-rare';
  }
  if ((cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2ebef)) return 'cjk-rare';
  if (cp >= 0x3000 && cp <= 0x303f) return 'punct';
  if (cp >= 0xff00 && cp <= 0xffef) return 'punct';
  if (cp >= 0xa0 && cp <= 0x24f) return 'latin-ext';
  if (cp >= 0x2000 && cp <= 0x206f) return 'punct';
  return 'other';
}

const WEIGHTS: Record<CharClass, number> = {
  'ascii-printable': 1,
  whitespace: 1,
  'cjk-common': 1,
  'cjk-rare': 0.32,
  'latin-ext': 0.05,
  punct: 0.8,
  control: 0,
  'private-use': 0,
  replacement: 0,
  other: 0.25,
};

export interface TextQuality {
  glyphCount: number;
  goodRatio: number;
  suspiciousGlyphs: number;
  suspiciousRatio: number;
  latinExtCount: number;
  cjkCommon: number;
  cjkRare: number;
  controlCount: number;
  markerCount: number;
  markerDensity: number;
  classCounts: Record<CharClass, number>;
}

/**
 * Characters that are highly diagnostic of a UTF-8 byte stream that was read
 * with a single-byte codec. They occur in dense pairs around CJK payloads.
 */
const MOJIBAKE_SINGLE = new Set(
  'ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ'.split(''),
);

const MOJIBAKE_EXTRAS = new Set(
  '–—‘’“”•…€‚„†‡ˆ‰‹›™¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿'.split(''),
);

/** Sequences typical of UTF-8 bytes read as Big5/GBK (rare Hanzi + 锛/銆/鈥). */
const CJK_MOJIBAKE_HINTS = new Set('銆鈥鍙嶅簲锛銆璁娉鎶鍝'.split(''));

export function measureText(glyphs: Glyph[], lx: Lexicon): TextQuality {
  const classCounts: Record<CharClass, number> = {
    'ascii-printable': 0,
    whitespace: 0,
    'cjk-common': 0,
    'cjk-rare': 0,
    'latin-ext': 0,
    punct: 0,
    control: 0,
    'private-use': 0,
    replacement: 0,
    other: 0,
  };
  let weighted = 0;
  let total = 0;
  let suspicious = 0;
  let markers = 0;
  let latinExt = 0;
  let controls = 0;
  let prevExt = false;
  for (const g of glyphs) {
    if (g.anomaly) {
      total++;
      controls++;
      suspicious++;
      prevExt = false;
      continue;
    }
    total++;
    const cls = classifyChar(g.text, lx.rank);
    classCounts[cls]++;
    const w = WEIGHTS[cls];
    weighted += g.suspicious ? Math.min(w, 0.2) : w;
    if (g.suspicious || cls === 'control' || cls === 'private-use' || cls === 'replacement') suspicious++;
    if (cls === 'latin-ext') {
      latinExt++;
      const ch = g.text;
      if (MOJIBAKE_SINGLE.has(ch) || MOJIBAKE_EXTRAS.has(ch)) {
        markers += prevExt ? 2 : 1;
      }
      prevExt = true;
    } else if (cls === 'cjk-rare') {
      prevExt = false;
      if (CJK_MOJIBAKE_HINTS.has(g.text)) markers += 2;
    } else {
      prevExt = false;
      if (cls === 'control') controls++;
    }
  }
  return {
    glyphCount: total,
    goodRatio: total === 0 ? 1 : Math.min(1, weighted / total),
    suspiciousGlyphs: suspicious,
    suspiciousRatio: total === 0 ? 0 : suspicious / total,
    latinExtCount: latinExt,
    cjkCommon: classCounts['cjk-common'],
    cjkRare: classCounts['cjk-rare'],
    controlCount: controls,
    markerCount: markers,
    markerDensity: total === 0 ? 0 : markers / total,
    classCounts,
  };
}

export interface LexiconCoverage {
  termHits: string[];
  vocabHits: number;
  cjkChars: number;
  coverage: number;
}

/**
 * Fraction of Han characters covered by pharmaceutical terms or dictionary
 * words. Traditional variants are normalised through the OpenCC cross map, so
 * a correctly decoded Big5 fragment scores just as well as a GBK one.
 *
 * Results are memoised: candidate scoring runs the same decoded sequence
 * through this check for each repair chain, and damaged CJK is repetitive.
 */
const coverageCache = new Map<string, LexiconCoverage>();
const COVERAGE_CACHE_LIMIT = 400;

export function measureLexicon(glyphs: Glyph[], lx: Lexicon): LexiconCoverage {
  let text = '';
  for (const g of glyphs) {
    if (g.anomaly) text += ' ';
    else text += normalizeChar(lx, g.text);
  }
  if (text.length > 20000) text = text.slice(0, 20000);
  const cached = coverageCache.get(text);
  if (cached) return cached;
  const result = computeCoverage(text, lx);
  if (coverageCache.size >= COVERAGE_CACHE_LIMIT) coverageCache.clear();
  coverageCache.set(text, result);
  return result;
}

export const measureLexiconCached = measureLexicon;

function computeCoverage(text: string, lx: Lexicon): LexiconCoverage {
  const cjkChars = [...text].filter((c) => c >= '\u4e00' && c <= '\u9fff').length;
  if (cjkChars === 0) return { termHits: [], vocabHits: 0, cjkChars: 0, coverage: 0 };
  const covered = new Uint8Array(text.length);
  const termHits: string[] = [];
  for (const term of lx.terms) {
    let idx = text.indexOf(term);
    while (idx >= 0) {
      let fresh = 0;
      for (let k = idx; k < idx + term.length; k++) {
        if (!covered[k]) {
          covered[k] = 1;
          fresh++;
        }
      }
      if (fresh > 0 && termHits.length <= 24) termHits.push(term);
      idx = text.indexOf(term, idx + 1);
      if (termHits.length > 24) break;
    }
  }
  let coveredCount = 0;
  for (let i = 0; i < text.length; i++) if (covered[i]) coveredCount++;
  let vocabHits = 0;
  for (let i = 0; i + 1 < text.length; i++) {
    if (covered[i]) continue;
    const a = text[i];
    const b = text[i + 1];
    if (a < '一' || a > '鿿' || b < '一' || b > '鿿') continue;
    if (lx.vocab.has(a + b)) {
      covered[i] = 1;
      covered[i + 1] = 1;
      coveredCount += 2;
      vocabHits++;
    }
  }
  return {
    termHits: [...new Set(termHits)].slice(0, 24),
    vocabHits,
    cjkChars,
    coverage: Math.min(1, coveredCount / cjkChars),
  };
}
