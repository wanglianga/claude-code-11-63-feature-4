import type {
  BoundaryReview,
  BoundarySeverity,
  Candidate,
  EncodingId,
  SegmentAnalysis,
} from '../../types';
import { encodingLabel, isCjkEncoding } from '../encoding/specs';
import { decodeWith } from '../encoding/codecs';

/**
 * Dosage units that must not be split by a segment boundary. Both Chinese and
 * Latin forms are listed because a broken label may mix the two.
 */
export const DOSAGE_UNITS = [
  'mg', 'MG', 'Mg', 'g', 'kg', 'µg', 'μg', 'mcg', 'ng', 'mL', 'ml', 'ML', 'L', 'μL', 'µL',
  'IU', 'iu', 'I.U.', 'mmol', 'mol', 'mEq', 'mOsm', '%', 'ppm',
  '毫克', '微克', '毫升', '升', '克', '千克', '公斤', '国际单位', '单位', '万单位', '毫摩尔',
  '摩尔', '当量', '滴', '片', '粒', '袋', '支', '瓶', '喷', '揿',
];

const OPEN_BRACKETS = new Set(['(', '（', '[', '【', '〔', '《', '〈', '{']);
const CLOSE_BRACKETS = new Set([')', '）', ']', '】', '〕', '》', '〉', '}']);
const BMP_RANGE = /[一-鿿㐀-䶿]/;

export interface BoundaryContext {
  bytes: Uint8Array;
  candidatesForSegment: (segmentId: string) => Candidate | null;
  segmentOfByte: (offset: number) => SegmentAnalysis | null;
}

function textOf(candidate: Candidate | null): string {
  return candidate ? candidate.text : '';
}

/** Last `n` codepoints of a string, handling placeholders as single units. */
export function tailUnits(text: string, n: number): string[] {
  const units: string[] = [];
  let i = text.length;
  while (i > 0 && units.length < n) {
    if (text[i - 1] === '⟧') {
      const open = text.lastIndexOf('⟦', i - 1);
      if (open >= 0) {
        units.unshift(text.slice(open, i));
        i = open;
        continue;
      }
    }
    const cp = text.codePointAt(i - 1);
    // step back over surrogate pairs
    let step = 1;
    if (cp !== undefined && cp > 0xffff) {
      // i-1 is a low surrogate? find high surrogate
      if (i - 2 >= 0) step = 2;
    }
    const u = text.slice(i - step, i);
    units.unshift(u);
    i -= step;
  }
  return units;
}

export function headUnits(text: string, n: number): string[] {
  const units: string[] = [];
  let i = 0;
  while (i < text.length && units.length < n) {
    if (text[i] === '⟦') {
      const close = text.indexOf('⟧', i + 1);
      if (close >= 0) {
        units.push(text.slice(i, close + 1));
        i = close + 1;
        continue;
      }
    }
    const cp = text.codePointAt(i) ?? 0;
    const step = cp > 0xffff ? 2 : 1;
    units.push(text.slice(i, i + step));
    i += step;
  }
  return units;
}

function isDigit(ch: string): boolean {
  return /^[0-9]$/.test(ch);
}

/** Detect a dosage unit straddling the join `left + right`. */
export function detectUnitFracture(leftTail: string, rightHead: string): string | null {
  for (const unit of DOSAGE_UNITS) {
    if (unit.length < 2) continue;
    for (let cut = 1; cut < unit.length; cut++) {
      const a = unit.slice(0, cut);
      const b = unit.slice(cut);
      if (leftTail.endsWith(a) && rightHead.startsWith(b)) {
        const before = leftTail.slice(0, leftTail.length - a.length);
        const prev = before.slice(-1);
        // A dosage unit is plausible when it follows a number, whitespace, a
        // separator or the end of the left tail ("10 m|g", "0.5 毫|克", "m|g").
        if (prev === '' || isDigit(prev) || /\s/.test(prev) || prev === '/' || prev === '×' || prev === '～' || prev === '~') {
          return `剂量单位 “${unit}” 被边界拆分为 “${a}” + “${b}”`;
        }
      }
    }
  }
  // Composite units ("mg/kg", "mL/min", "IU/kg"): the cut may fall on the
  // slash, leaving "m" on the left and "/kg" on the right. Check whether the
  // joined tail forms a known composite unit.
  if (rightHead.startsWith('/') && /[A-Za-zµμ]$/.test(leftTail)) {
    const leftSide = leftTail.match(/([A-Za-zµμ]{1,3})$/)?.[1];
    const rightSide = rightHead.match(/^\/(kg|min|h|d|m2|mL|L|g|mg|µg|μg)/)?.[1];
    if (leftSide && rightSide) {
      return `复合剂量单位 “${leftSide}/${rightSide}” 被边界拆分为 “${leftSide}” + “/${rightSide}”`;
    }
  }
  return null;
}

/** Detect a bracket opened on one side and not closed on the other. */
export function detectBracketFracture(leftTail: string, rightHead: string): string | null {
  let depth = 0;
  let firstOpen = '';
  for (const ch of leftTail) {
    if (OPEN_BRACKETS.has(ch)) {
      depth++;
      if (!firstOpen) firstOpen = ch;
    } else if (CLOSE_BRACKETS.has(ch)) {
      depth = Math.max(0, depth - 1);
    }
  }
  if (depth > 0) {
    let closed = false;
    for (const ch of rightHead) {
      if (CLOSE_BRACKETS.has(ch)) {
        closed = true;
        break;
      }
      if (OPEN_BRACKETS.has(ch)) break;
    }
    if (!closed) {
      return `左段末尾的括号 “${firstOpen}” 在右段开头没有闭合`;
    }
    return `括号 “${firstOpen}” 跨越区段边界`;
  }
  // Right segment starts with a closing bracket that has no opener nearby.
  const first = rightHead.trimStart()[0];
  if (first && CLOSE_BRACKETS.has(first)) {
    let hasOpenLeft = false;
    for (const ch of leftTail) if (OPEN_BRACKETS.has(ch)) hasOpenLeft = true;
    if (!hasOpenLeft) return `右段以闭括号 “${first}” 开头，但左段没有对应的开括号`;
  }
  return null;
}

/**
 * Heuristic drug-name continuity: if the join `leftEnd + rightStart` reads as
 * part of a pharmaceutical term or a run of Han characters, the split is
 * suspicious. Uses the lexicon but never deletes anything.
 */
export function detectTermFracture(leftTail: string, rightHead: string, hasTermJoiner: boolean): string | null {
  const l = leftTail.slice(-1);
  const r = rightHead.slice(0, 1);
  if (!l || !r) return null;
  if (BMP_RANGE.test(l) && BMP_RANGE.test(r)) {
    // Han-Han split: common at paragraph breaks, suspicious inside a word.
    const leftHanRun = countTrailingHan(leftTail);
    const rightHanRun = countLeadingHan(rightHead);
    if (leftHanRun >= 1 && rightHanRun >= 1) {
      return `汉字连续体 “${leftTail.slice(-Math.min(3, leftHanRun))}” | “${rightHead.slice(0, Math.min(3, rightHanRun))}” 被边界切开，药名可能断裂`;
    }
  }
  if (/[A-Za-z]$/.test(l) && /[A-Za-z]/.test(r)) {
    const leftRun = countTrailingAscii(leftTail);
    const rightRun = countLeadingAscii(rightHead);
    if (leftRun >= 1 && rightRun >= 1 && hasTermJoiner) {
      return `拉丁字母词 “…” 被边界切断（左 ${leftRun} 字母 / 右 ${rightRun} 字母）`;
    }
  }
  if (isDigit(l) && isDigit(r)) {
    return `数字被边界切断（左 ${l} / 右 ${r}），剂量数值可能不完整`;
  }
  if (isDigit(l) && /[A-Za-zµμ%]/.test(r)) {
    return `数字与单位字母 “${l}” | “${r}” 被边界拆开`;
  }
  return null;
}

function countTrailingHan(s: string): number {
  let n = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (BMP_RANGE.test(s[i])) n++;
    else break;
  }
  return n;
}

function countLeadingHan(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (BMP_RANGE.test(s[i])) n++;
    else break;
  }
  return n;
}

function countTrailingAscii(s: string): number {
  let n = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (/[A-Za-z]/.test(s[i])) n++;
    else break;
  }
  return n;
}

function countLeadingAscii(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (/[A-Za-z]/.test(s[i])) n++;
    else break;
  }
  return n;
}

export interface BoundaryInput {
  boundary: number;
  left: SegmentAnalysis;
  right: SegmentAnalysis;
  /** Optional: bytes on both sides of the cut, used to cross-check units. */
  rawWindow?: { left: Uint8Array; right: Uint8Array };
}

/**
 * Evaluate every adjacency. Any detected fracture caps the combined
 * confidence and forces both segments into `pending`, so the run stops for
 * human adjudication instead of silently publishing a hyphenated drug name or
 * a split "mg".
 */
export function evaluateBoundaries(
  pairs: BoundaryInput[],
  context: { hasMixedEncodings: boolean },
): { reviews: BoundaryReview[]; caps: Map<string, { confidence: number; reasons: string[] }> } {
  const reviews: BoundaryReview[] = [];
  const caps = new Map<string, { confidence: number; reasons: string[] }>();

  const capFor = (id: string, conf: number, reason: string) => {
    const cur = caps.get(id) ?? { confidence: 1, reasons: [] };
    cur.confidence = Math.min(cur.confidence, conf);
    cur.reasons.push(reason);
    caps.set(id, cur);
  };

  for (const pair of pairs) {
    const leftCand = pair.left.candidates.find((c) => c.id === pair.left.suggestedCandidateId) ?? null;
    const rightCand = pair.right.candidates.find((c) => c.id === pair.right.suggestedCandidateId) ?? null;
    const leftText = textOf(leftCand);
    const rightText = textOf(rightCand);
    const leftTail = tailUnits(leftText, 6).join('');
    const rightHead = headUnits(rightText, 6).join('');

    const flags: string[] = [];
    let severity: BoundarySeverity = 'low';
    const hasTermJoiner = /[A-Za-z0-9]/.test(leftTail.slice(-2) + rightHead.slice(0, 2)) || BMP_RANGE.test(leftTail.slice(-1) + rightHead.slice(0, 1));

    // 1. Different candidate encodings on each side.
    const leftEnc = leftCand?.encoding;
    const rightEnc = rightCand?.encoding;
    const encodingChanged = leftEnc && rightEnc && leftEnc !== rightEnc;
    if (encodingChanged) {
      flags.push(`相邻候选编码不同：${encodingLabel(leftEnc)} / ${encodingLabel(rightEnc)}`);
      severity = 'medium';
    }
    if (context.hasMixedEncodings) severity = severity === 'low' ? 'low' : severity;

    // 2. Mid-text break: either side does not end/start at a natural boundary.
    const leftEndsMidLine = leftText.length > 0 && !/[\s\n\r。；;！!？?]$/.test(leftText);
    const rightStartsMidLine = rightText.length > 0 && !/^[\s\n\r]/.test(rightText);
    if (leftEndsMidLine && rightStartsMidLine && leftTail && rightHead) {
      flags.push('边界两侧均为连续正文（无换行/标点）');
      if (severity === 'low') severity = 'medium';
    }

    // 3. Term / unit / bracket fractures.
    const unit = detectUnitFracture(leftTail, rightHead);
    if (unit) {
      flags.push(unit);
      severity = 'high';
    }
    const bracket = detectBracketFracture(leftTail, rightHead);
    if (bracket) {
      flags.push(bracket);
      severity = 'high';
    }
    const term = detectTermFracture(leftTail, rightHead, hasTermJoiner);
    if (term) {
      flags.push(term);
      if (severity !== 'high') severity = 'medium';
    }

    // 3b. Raw-byte unit check: two repair candidates can both render a clean
    // "mg" on their own side while the original bytes cut the unit ("m|g").
    const rawUnit = detectRawUnitFracture(pair.rawWindow);
    if (rawUnit) {
      flags.push(rawUnit);
      severity = 'high';
    }

    // 4. Re-encoding hazard: a multi-byte sequence was split at the cut.
    const hazardGlyph = leftCand?.glyphs[leftCand.glyphs.length - 1];
    if (hazardGlyph && hazardGlyph.anomaly === 'truncated-sequence') {
      flags.push('左段末尾为截断的多字节序列');
      severity = 'high';
    }
    const rightFirst = rightCand?.glyphs[0];
    if (rightFirst && rightFirst.anomaly === 'unassigned-sequence') {
      flags.push('右段开头即出现未分配序列，可能因边界切分导致');
      if (severity !== 'high') severity = 'medium';
    }

    // 5. Both sides unresolved symbols adjacent to the cut.
    if (leftCand?.unresolved.some((u) => u.end === pair.boundary) || rightCand?.unresolved.some((u) => u.start === pair.boundary)) {
      flags.push('边界紧邻不可解字节占位符');
      if (severity === 'low') severity = 'medium';
    }

    if (flags.length === 0) continue;

    const highCount = severity === 'high' ? 1 : 0;
    const base = (pair.left.confidence + pair.right.confidence) / 2;
    const penalty = severity === 'high' ? 0.45 : severity === 'medium' ? 0.22 : 0.08;
    const combined = Math.max(0, Math.min(1, base - penalty - highCount * 0.05));

    const review: BoundaryReview = {
      id: `bnd-${pair.boundary}-${pair.left.id}-${pair.right.id}`,
      boundary: pair.boundary,
      leftSegmentId: pair.left.id,
      rightSegmentId: pair.right.id,
      severity,
      flags,
      detail:
        `左段末尾 “…${leftTail}” ↔ 右段开头 “${rightHead}…”` +
        (encodingChanged ? '；两侧候选编码不一致' : ''),
      combinedConfidence: Number(combined.toFixed(3)),
      leftTail,
      rightHead,
      acknowledged: false,
      acknowledgedNote: '',
      acknowledgedVersionId: null,
    };
    reviews.push(review);

    if (severity === 'high') {
      capFor(pair.left.id, combined, '相邻边界存在高风险的药名/剂量/括号断裂');
      capFor(pair.right.id, combined, '相邻边界存在高风险的药名/剂量/括号断裂');
    } else if (severity === 'medium') {
      capFor(pair.left.id, Math.min(pair.left.confidence, combined), '相邻边界存在中风险断裂特征');
      capFor(pair.right.id, Math.min(pair.right.confidence, combined), '相邻边界存在中风险断裂特征');
    }
  }

  return { reviews, caps };
}

/**
 * Re-decode a small window on each side of the cut with GBK and UTF-8 and ask
 * whether a dosage unit spans the boundary in the raw text. Catches cases the
 * per-side candidate texts hide (each side "repairs" the half unit away).
 */
export function detectRawUnitFracture(
  window: { left: Uint8Array; right: Uint8Array } | undefined,
): string | null {
  if (!window) return null;
  // Mixed-encoding boundaries mean neither side is guaranteed to decode with a
  // single codec. Try each codec per side and keep every ASCII fragment that
  // represents the *tail* of the left bytes or the *head* of the right bytes.
  const leftTexts: string[] = [];
  const rightTexts: string[] = [];
  for (const enc of ['gb18030', 'utf-8'] as const) {
    const l = decodeText(window.left, enc, true);
    const r = decodeText(window.right, enc, false);
    if (l) leftTexts.push(l);
    if (r) rightTexts.push(r);
  }
  // Also read both sides with the *other* encoding: when the cut sits inside a
  // unit, the byte right before it is ASCII for GBK but mid-sequence for UTF-8
  // (and vice versa).
  for (const enc of ['gb18030', 'utf-8'] as const) {
    const l = decodeAsciiRun(window.left, enc, true);
    const r = decodeAsciiRun(window.right, enc, false);
    if (l) leftTexts.push(l);
    if (r) rightTexts.push(r);
  }
  for (const left of leftTexts) {
    for (const right of rightTexts) {
      const lt = tailUnits(left, 10).join('');
      const rh = headUnits(right, 10).join('');
      const flag = detectUnitFracture(lt, rh);
      if (flag) return `原始字节层面的${flag}`;
    }
  }
  return null;
}

function decodeText(bytes: Uint8Array, encoding: 'gb18030' | 'utf-8', fromEnd: boolean): string | null {
  try {
    if (encoding === 'utf-8') {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    const decoded = decodeWith('gb18030', bytes).text;
    // A GBK read of UTF-8 bytes yields plausible shapes; only accept the
    // fragment adjacent to the cut when it is clean of replacement noise.
    return decoded;
  } catch {
    if (!fromEnd) return null;
    // Try a shorter window from the cut side so one bad byte further away
    // does not hide a readable "10 m" tail.
    for (let take = bytes.length - 1; take >= Math.max(2, bytes.length - 8); take--) {
      const slice = fromEnd ? bytes.subarray(bytes.length - take) : bytes.subarray(0, take);
      try {
        if (encoding === 'utf-8') return new TextDecoder('utf-8', { fatal: true }).decode(slice);
        return decodeWith('gb18030', slice).text;
      } catch {
        continue;
      }
    }
    return null;
  }
}

/** Decode only the contiguous ASCII run adjacent to the cut. */
function decodeAsciiRun(bytes: Uint8Array, _enc: 'gb18030' | 'utf-8', fromEnd: boolean): string | null {
  if (fromEnd) {
    let i = bytes.length - 1;
    while (i >= 0 && bytes[i] >= 0x80) i--;
    const start = Math.max(i - 9, 0);
    // Require the run to start after a decade of non-ASCII text so we do not
    // mistake stray ASCII letters for a unit.
    const text = new TextDecoder('ascii').decode(bytes.subarray(start, bytes.length));
    return text || null;
  }
  let i = 0;
  while (i < bytes.length && bytes[i] >= 0x80) i++;
  const text = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, i + 9)));
  return text || null;
}

/** True when either candidate family implies a multi-byte sequence split. */
export function crossFamilySplit(left: EncodingId | undefined, right: EncodingId | undefined): boolean {
  if (!left || !right) return false;
  if (left === right) return false;
  return isCjkEncoding(left) || isCjkEncoding(right) || left === 'utf-8' || right === 'utf-8';
}
