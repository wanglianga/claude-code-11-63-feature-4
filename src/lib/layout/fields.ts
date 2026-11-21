// Key-field extractor.
//
// Five field kinds are recognized from the *repaired* text: dosage,
// frequency, unit, contraindication negation and target population. A bare
// number is never promoted to a dosage — a dosage requires an attached unit
// and a page region. Suspicious bare numbers inside dosage sections are
// reported separately as `bare-number-dosage` consistency issues instead.

import type {
  FieldEvidence,
  FieldKind,
  FieldStatus,
  LayoutBlock,
  LineAlignment,
  OcrLine,
} from '../../types';
import type { ReferenceText } from './aligner';

/** Units, including composite per-weight / per-time forms. */
export const FIELD_UNITS = [
  'mg/kg', 'mg／kg', 'mL/min', 'ml/min', 'IU/kg', 'mg/m2', 'mg/m²',
  'mmol/mol', 'mOsm/kg',
  'mg', 'MG', 'μg', 'µg', 'mcg', 'ng', 'g', 'kg', 'mL', 'ml', 'ML', 'L',
  'μL', 'µL', 'IU', 'I.U.', 'mmol', 'mol', 'mEq', 'mOsm', '%', 'ppm',
  '毫克', '微克', '毫升', '升', '克', '千克', '公斤', '国际单位', '万单位',
  '毫摩尔', '摩尔', '当量', '滴', '片', '粒', '袋', '支', '瓶', '喷', '揿',
];

const NUMBER = String.raw`\d+(?:\.\d+)?(?:\s*[～~至\-–—]\s*\d+(?:\.\d+)?)?`;
const UNIT_ALT = FIELD_UNITS.sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const DOSAGE_RE = new RegExp(String.raw`(?:每次|每次剂量|剂量[：:]?\s*|起始剂量[：:]?\s*|维持剂量[：:]?\s*)?(${NUMBER})\s*(${UNIT_ALT})(?![a-zA-Z])`, 'g');
const BARE_NUMBER_RE = new RegExp(String.raw`(?:剂量|用量|给药|服)\D{0,6}?(${NUMBER})(?![\d.])`, 'g');

const FREQUENCY_PATTERNS: RegExp[] = [
  /每\s*[日天周]\s*[一二两三四五六七八九十\d]+\s*次/g,
  /每\s*\d+(?:\.\d+)?\s*(?:小时|小時|个小时|個小時|h|hr|分钟|分鐘|min)\s*(?:[一二两三四五六七八九十\d]+\s*次)?/g,
  /分\s*[一二两三四五六七八九十\d]+\s*次(?:给药|給藥)?/g,
  /\b(?:qd|bid|tid|qid|q\d+h|prn)\b/gi,
  /(?:一次|两次|兩次|三次|四次)(?:或[一二两三四五六七八九十\d]+次)?(?:给药|給藥|服用)?/g,
];

const NEGATION_PATTERNS: RegExp[] = [
  /(?:不得|不可|不能|禁止|严禁|嚴禁|切勿|禁用|忌用|慎用|不建议|不建議|不宜)[^，。；;\n\r]{0,24}/g,
];

const POPULATION_PATTERNS: RegExp[] = [
  /\d+\s*岁(?:以上|以下)?(?:儿童|兒童|成人|青少年)?/g,
  /(?:成人|成年人|儿童|兒童|婴幼儿|嬰幼兒|小儿|小兒|新生儿|新生兒|早产儿|早產兒|青少年)/g,
  /老年(?:人|患者)?/g,
  /孕妇|孕婦|哺乳期妇女|哺乳期婦女|备孕妇女|備孕婦女/g,
  /肾功能不全(?:患者)?|肝功能(?:不全|损害|損害)(?:患者)?/g,
  /(?:对|對)[^，。；\n]{0,12}?过敏者|過敏者/g,
  /哺乳期|妊娠期/g,
];

const SENTENCE_BREAK = /[。；;\n\r]/;

export interface FieldContext {
  ref: ReferenceText;
  linesById: Map<string, OcrLine>;
  blocksById: Map<string, LayoutBlock>;
  alignmentByLine: Map<string, LineAlignment>;
  /** Char index → OCR line id, derived from byte ranges. */
  lineAtChar: (charIndex: number) => string | null;
}

interface RawMatch {
  kind: FieldKind;
  text: string;
  charStart: number;
  charEnd: number;
  numericValue: number | null;
  unit: string | null;
}

function firstNumber(text: string): number | null {
  const m = text.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function collect(regex: RegExp, text: string, kind: FieldKind, pick: (m: RegExpMatchArray) => { numericValue: number | null; unit: string | null }): RawMatch[] {
  const out: RawMatch[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = regex.exec(text)) && guard++ < 500) {
    if (m.index === regex.lastIndex) regex.lastIndex++;
    const { numericValue, unit } = pick(m);
    out.push({
      kind,
      text: m[0].trim(),
      charStart: m.index,
      charEnd: m.index + m[0].length,
      numericValue,
      unit,
    });
  }
  return out;
}

function overlaps(matches: RawMatch[], start: number, end: number): boolean {
  return matches.some((m) => start < m.charEnd && end > m.charStart);
}

function sectionAtText(ref: ReferenceText, charIndex: number): { section: string; sectionId: string } {
  const before = ref.text.slice(0, charIndex);
  const headings = [...before.matchAll(/【([^】]+)】/g)];
  const last = headings[headings.length - 1];
  if (!last) return { section: '', sectionId: 'sec:root' };
  return { section: last[1], sectionId: `sec:${last[1]}` };
}

/**
 * Extract fields. `verified` means the field has a region-backed aligned line;
 * everything else is `at-risk` (or `unplaced` when no line can be found at
 * all). The consistency checker may downgrade but never silently upgrades.
 */
export function extractFields(ctx: FieldContext): FieldEvidence[] {
  const text = ctx.ref.text;
  const raw: RawMatch[] = [];

  for (const m of collect(DOSAGE_RE, text, 'dosage', (m) => ({ numericValue: firstNumber(m[1] ?? m[0]), unit: m[2] ?? null }))) {
    raw.push(m);
  }
  // Units standing on their own (e.g. a table header "剂量（mg）"). Latin
  // letter boundaries keep single-letter units like g/L out of words such as
  // "eGFR"; CJK units are unaffected because their neighbours are not A-Z.
  // Single-letter Latin units (g, L) are deliberately excluded here — they
  // are only meaningful inside a full dosage expression handled above.
  const standaloneUnitRe = new RegExp(`(?<![A-Za-z])(?:${UNIT_ALT})(?![A-Za-z])`, 'g');
  for (const m of collect(standaloneUnitRe, text, 'unit', () => ({ numericValue: null, unit: null }))) {
    const isSingleLatinLetter = /^[A-Za-z]$/.test(m.text);
    if (isSingleLatinLetter) continue;
    if (!overlaps(raw, m.charStart, m.charEnd)) raw.push({ ...m, unit: m.text });
  }
  for (const re of FREQUENCY_PATTERNS) {
    for (const m of collect(re, text, 'frequency', (mm) => ({ numericValue: firstNumber(mm[0]), unit: null }))) {
      if (!overlaps(raw, m.charStart, m.charEnd)) raw.push(m);
    }
  }
  for (const re of NEGATION_PATTERNS) {
    for (const m of collect(re, text, 'contraindication-negation', () => ({ numericValue: null, unit: null }))) {
      if (!overlaps(raw, m.charStart, m.charEnd)) raw.push(m);
    }
  }
  for (const re of POPULATION_PATTERNS) {
    for (const m of collect(re, text, 'population', () => ({ numericValue: null, unit: null }))) {
      if (!overlaps(raw, m.charStart, m.charEnd)) raw.push(m);
    }
  }

  raw.sort((a, b) => a.charStart - b.charStart);

  return raw.map((m): FieldEvidence => {
    const spanStart = ctx.ref.spans[m.charStart]?.[0] ?? 0;
    const spanEnd = ctx.ref.spans[Math.min(m.charEnd - 1, ctx.ref.spans.length - 1)]?.[1] ?? 0;
    const lineId = ctx.lineAtChar(m.charStart);
    const line = lineId ? ctx.linesById.get(lineId) ?? null : null;
    const alignment = lineId ? ctx.alignmentByLine.get(lineId) ?? null : null;
    const blockId = alignment && alignment.status === 'aligned' ? alignment.candidateBlockIds[0] ?? null : null;
    const block = blockId ? ctx.blocksById.get(blockId) ?? null : null;
    const textSection = sectionAtText(ctx.ref, m.charStart);

    const reasons: string[] = [];
    let status: FieldStatus = 'verified';
    if (!line) {
      status = 'unplaced';
      reasons.push('字段文本无法回查到任何 OCR 行');
    } else if (!alignment || alignment.status === 'unplaced') {
      status = 'unplaced';
      reasons.push('对应 OCR 行未对齐到页面区块');
    } else if (alignment.status !== 'aligned') {
      status = 'at-risk';
      reasons.push(...alignment.flags);
    }
    if (m.kind === 'dosage' && !m.unit) {
      // Defensive: DOSAGE_RE always binds a unit; keep the invariant explicit.
      status = status === 'verified' ? 'at-risk' : status;
      reasons.push('数字缺少附带单位，不能直接视为剂量');
    }
    if (block && textSection.section && block.section && block.section !== textSection.section) {
      status = status === 'verified' ? 'at-risk' : status;
      reasons.push(`版面章节（${block.section}）与文本章节（${textSection.section}）不一致`);
    }

    const windowStart = Math.max(0, m.charStart - 24);
    const windowEnd = Math.min(text.length, m.charEnd + 24);
    return {
      // Content-addressed: stable across re-crops and re-validation runs.
      id: `field-${m.kind}@${spanStart}-${spanEnd}`,
      kind: m.kind,
      text: m.text,
      numericValue: m.numericValue,
      unit: m.unit,
      byteRange: [spanStart, spanEnd],
      ocrLineId: lineId,
      blockId: block?.id ?? null,
      pageId: block?.pageId ?? line?.pageId ?? null,
      pageNumber: block?.pageNumber ?? line?.pageNumber ?? null,
      section: block?.section || textSection.section,
      sectionId: block?.sectionId || textSection.sectionId,
      adjacentText: text.slice(windowStart, windowEnd).replace(/\s+/g, ' ').trim(),
      status,
      reasons,
    };
  });
}

/**
 * Bare numbers in dosage contexts without an attached unit. They are returned
 * as issues, never as dosage fields — the brief's hard rule. Layout directive
 * lines (@@block / @@ocr coordinates, the layout header) are infrastructure,
 * not document content, and are skipped.
 */
export function findBareNumbers(ref: ReferenceText): Array<{ charStart: number; charEnd: number; text: string; sentence: string }> {
  const out: Array<{ charStart: number; charEnd: number; text: string; sentence: string }> = [];
  BARE_NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_NUMBER_RE.exec(ref.text))) {
    const after = ref.text.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (new RegExp(`^\\s*(?:${UNIT_ALT})`).test(after)) continue; // unit follows → real dosage
    const sentenceStart = searchSentenceStart(ref.text, m.index);
    const sentenceEnd = searchSentenceEnd(ref.text, m.index);
    const sentence = ref.text.slice(sentenceStart, sentenceEnd).trim();
    if (sentence.includes('@@') || sentence.includes('bytelab-layout')) continue;
    out.push({
      charStart: m.index,
      charEnd: m.index + m[0].length,
      text: m[0],
      sentence,
    });
  }
  return out;
}

export function searchSentenceStart(text: string, index: number): number {
  const before = text.slice(0, index);
  const breaks = [...before.matchAll(new RegExp(SENTENCE_BREAK, 'g'))];
  return breaks.length ? (breaks[breaks.length - 1].index ?? 0) + 1 : 0;
}

export function searchSentenceEnd(text: string, index: number): number {
  const rest = text.slice(index);
  const m = rest.match(new RegExp(SENTENCE_BREAK));
  return m ? index + m.index! : text.length;
}
