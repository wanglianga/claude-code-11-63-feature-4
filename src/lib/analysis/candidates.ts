import type {
  AnalysisParams,
  Candidate,
  CandidateScore,
  ChainStep,
  EncodingId,
  Glyph,
  UnresolvedSymbol,
} from '../../types';
import { getCodec } from '../encoding/codecs';
import { encodingLabel, isSingleByteEncoding } from '../encoding/specs';
import { encodeCharIn } from '../encoding/cjk';
import { bytesToHex } from '../util/bytes';
import { getLexicon, type Lexicon } from './lexicon';
import { measureLexicon, measureText } from './scoring';
export interface DecodedSegment {
  glyphs: Glyph[];
  text: string;
  anomalyBytes: number;
  anomalyCount: number;
  suspiciousCount: number;
}

/** Decode bytes with an encoding, keeping absolute glyph offsets. */
export function decodeSegment(encoding: EncodingId, bytes: Uint8Array, baseOffset: number): DecodedSegment {
  const res = getCodec(encoding).decode(bytes, baseOffset);
  return {
    glyphs: res.glyphs,
    text: res.text,
    anomalyBytes: res.anomalyBytes,
    anomalyCount: res.anomalyCount,
    suspiciousCount: res.suspiciousCount,
  };
}

function groupUnresolved(
  glyphs: Glyph[],
  startOfSegment: number,
  encoding: EncodingId,
  bytes?: Uint8Array,
): UnresolvedSymbol[] {
  const runs: UnresolvedSymbol[] = [];
  let cur: { start: number; end: number; count: number; reason: string } | null = null;
  let lastEnd = startOfSegment;
  const finish = (run: { start: number; end: number; count: number; reason: string }): UnresolvedSymbol => ({
    id: `sym-${run.start}-${run.end}`,
    start: run.start,
    end: run.end,
    bytesHex: bytes ? bytesToHex(bytes.subarray(run.start - startOfSegment, run.end - startOfSegment), ' ') : '',
    reason: `${encodingLabel(encoding)}：${run.reason}${run.count > 1 ? `（${run.count} 处连续异常）` : ''}`,
  });
  for (const g of glyphs) {
    if (g.anomaly) {
      if (cur && g.start === lastEnd) {
        cur.end = g.end;
        cur.count++;
      } else {
        if (cur) runs.push(finish(cur));
        cur = { start: g.start, end: g.end, count: 1, reason: g.detail ?? g.anomaly };
      }
      lastEnd = g.end;
    } else {
      if (cur) {
        runs.push(finish(cur));
        cur = null;
      }
      lastEnd = g.end;
    }
  }
  if (cur) runs.push(finish(cur));
  return runs;
}

/** Render text with ⟦n⟧ placeholders where bytes could not be decoded. */
export function renderCandidateText(glyphs: Glyph[], startOfSegment: number): string {
  let out = '';
  let cursor = startOfSegment;
  let i = 0;
  while (i < glyphs.length) {
    const g = glyphs[i];
    if (g.anomaly) {
      let j = i;
      let runStart = g.start;
      let runEnd = g.end;
      while (j + 1 < glyphs.length && glyphs[j + 1].anomaly && glyphs[j + 1].start === runEnd) {
        j++;
        runEnd = glyphs[j].end;
      }
      out += `⟦${runEnd - runStart}⟧`;
      cursor = runEnd;
      i = j + 1;
      continue;
    }
    void cursor;
    out += g.text;
    cursor = g.end;
    i++;
  }
  return out;
}

interface RepairFailure {
  at: number;
  reason: string;
}

/**
 * Rebuild the pre-transcode byte stream glyph by glyph. Working at glyph
 * granularity keeps an unreadable slice local instead of destroying the whole
 * segment.
 */
function rebuildBytes(
  glyphs: Glyph[],
  pivotA: EncodingId,
  pivotB: EncodingId,
  targetUtf8: boolean,
): { bytes: Uint8Array; failures: RepairFailure[] } {
  const out: number[] = [];
  const failures: RepairFailure[] = [];
  const codecs: EncodingId[] = pivotB === pivotA ? [pivotA] : [pivotA, pivotB];

  const options = (g: Glyph): Uint8Array[] => {
    if (g.anomaly) return [];
    const cp = g.text.codePointAt(0) ?? 0;
    const results: Uint8Array[] = [];
    for (const c of codecs) {
      const enc = encodeCharIn(c, cp);
      if (enc) results.push(enc);
    }
    return results;
  };

  /** A glyph that re-encodes to exactly one byte in [lo,hi]. */
  const singleByteIn = (g: Glyph, lo: number, hi: number): number | null => {
    for (const b of options(g)) {
      if (b.length === 1 && b[0] >= lo && b[0] <= hi) return b[0];
    }
    return null;
  };

  const utf8Len = (lead: number): number => {
    if (lead >= 0xc2 && lead <= 0xdf) return 2;
    if (lead >= 0xe0 && lead <= 0xef) return 3;
    if (lead >= 0xf0 && lead <= 0xf4) return 4;
    return 0;
  };

  let i = 0;
  while (i < glyphs.length) {
    const g = glyphs[i];
    const cands = options(g);
    if (cands.length === 0) {
      failures.push({
        at: g.start,
        reason: g.anomaly ? `无法回写异常字节（${g.detail ?? g.anomaly}）` : `字符 ${g.text} 在 ${codecs.map(encodingLabel).join('/')} 中无对应字节`,
      });
      i++;
      continue;
    }

    if (targetUtf8) {
      // Prefer interpreting this glyph as a UTF-8 lead byte and pulling the
      // continuation bytes from the following glyphs.
      const lead = singleByteIn(g, 0xc2, 0xf4);
      if (lead !== null) {
        const need = utf8Len(lead) - 1;
        const collected: number[] = [lead];
        let j = i + 1;
        let ok = true;
        for (let k = 0; k < need; k++) {
          if (j >= glyphs.length) {
            ok = false;
            break;
          }
          const cont = singleByteIn(glyphs[j], 0x80, 0xbf);
          if (cont === null) {
            ok = false;
            break;
          }
          collected.push(cont);
          j++;
        }
        if (ok) {
          out.push(...collected);
          i = j;
          continue;
        }
        failures.push({
          at: g.start,
          reason: `UTF-8 首字节 0x${lead.toString(16).toUpperCase()} 的续字节无法还原`,
        });
        i++;
        continue;
      }
      // Plain ASCII byte (or unmappable non-ASCII) → keep as-is when < 0x80.
      const ascii = singleByteIn(g, 0x00, 0x7f);
      if (ascii !== null) {
        out.push(ascii);
        i++;
        continue;
      }
    }

    out.push(...cands[0]);
    i++;
  }
  return { bytes: Uint8Array.from(out), failures };
}

interface ScoreInput {
  q: ReturnType<typeof measureText>;
  glyphs: Glyph[];
  segmentBytes: number;
  /** Bytes the interpretation could not account for at all. */
  lostBytes: number;
  layers: number;
  unresolvedCount: number;
}

function scoreOf(input: ScoreInput, lx: Lexicon): CandidateScore {
  const { q, glyphs, segmentBytes, lostBytes, layers, unresolvedCount } = input;
  const sample = glyphs.length > 4000 ? glyphs.slice(0, 4000) : glyphs;
  // Unknown characters repeat heavily in CJK text; memoise the normalised Han
  // sequence so the lexicon pass stays linear in distinct characters.
  const lex = measureLexicon(sample, lx);
  const anomalyRatio = segmentBytes === 0 ? 0 : q.controlCount / Math.max(1, segmentBytes);
  // For a repair chain, the rebuilt stream is legitimately shorter than the
  // mojibake it replaces; only genuinely unaccounted bytes count as lost.
  const coverage = segmentBytes === 0 ? 1 : Math.max(0, Math.min(1, 1 - lostBytes / segmentBytes));

  const lexiconBonus = lex.coverage * 0.11;
  const termBonus = Math.min(0.05, lex.termHits.length * 0.006);
  const layerPenalty = Math.min(0.1, (layers - 1) * 0.018);
  const markerPenalty = Math.min(0.34, q.markerDensity * 0.55);

  // Content preservation dominates: a repair that throws away half the bytes
  // must never outrank a direct decode that keeps them.
  const preservation = 0.24 * coverage - 0.42 * (1 - coverage);
  const raw =
    0.33 * (1 - anomalyRatio) +
    0.24 * q.goodRatio +
    preservation +
    lexiconBonus +
    termBonus -
    markerPenalty -
    layerPenalty;
  let score = Math.max(0, Math.min(1, raw));

  const cjkChars = [...sample].filter((c) => {
    const cp = c.text?.codePointAt(0) ?? 0;
    return cp >= 0x4e00 && cp <= 0x9fff;
  }).length;
  const notes: string[] = [];
  if (coverage < 0.995) notes.push(`仅覆盖 ${(coverage * 100).toFixed(0)}% 原始字节`);
  if (anomalyRatio > 0) notes.push(`${(anomalyRatio * 100).toFixed(1)}% 字节无法解码`);
  if (q.markerCount > 0) notes.push(`命中 ${q.markerCount} 处乱码特征字符`);
  if (lex.termHits.length) notes.push(`药名/术语命中 ${lex.termHits.length} 个`);
  if (q.cjkRare > 0 && q.cjkRare > q.cjkCommon * 1.5) notes.push('生僻字明显多于常用字');
  if (unresolvedCount > 0) notes.push(`${unresolvedCount} 段不可解字节保留`);
  if (layers > 1) notes.push(`经过 ${layers} 层还原`);

  // A segment whose raw bytes are mostly high bytes but whose "text" is nearly
  // all ASCII is almost certainly a failed interpretation, not a good decode.
  let highBytes = 0;
  for (const g of glyphs) {
    if (g.anomaly) continue;
  }
  void highBytes;
  if (cjkChars === 0 && q.controlCount === 0) {
    // Direct single-byte decodes of CJK data produce Latin noise, not zero CJK.
    if (q.latinExtCount > 0 && q.latinExtCount > glyphs.length * 0.4) score *= 0.62;
  }
  return {
    score: Number(Math.max(0, Math.min(1, score)).toFixed(4)),
    anomalyRatio,
    anomalyBytes: q.controlCount,
    suspiciousRatio: q.suspiciousRatio,
    mojibakeMarkerCount: q.markerCount,
    goodRatio: q.goodRatio,
    lexiconHits: lex.termHits,
    relativeLexiconBonus: lexiconBonus + termBonus,
    layerPenalty,
    notes,
  };
}

const ENCODING_BONUS: Partial<Record<EncodingId, number>> = {
  'utf-8': 0.02,
  gb18030: 0.012,
  big5: 0.01,
};

export function candidateEncodingsOf(params: AnalysisParams): EncodingId[] {
  const base: EncodingId[] = params.enabledEncodings.filter((e) => e !== 'utf-16le' && e !== 'utf-16be');
  if (params.includeUtf16) {
    base.push('utf-16le');
    base.push('utf-16be');
  }
  return base;
}

/** Pick the sub-range most likely to carry transcoding evidence. */
function suspiciousWindow(bytes: Uint8Array, size: number): { start: number; end: number } {
  if (bytes.length <= size) return { start: 0, end: bytes.length };
  const buckets = 16;
  const bucketLen = Math.ceil(bytes.length / buckets);
  let bestIdx = 0;
  let bestScore = -1;
  for (let b = 0; b < buckets; b++) {
    const s = b * bucketLen;
    const e = Math.min(bytes.length, s + bucketLen);
    let high = 0;
    let pairs = 0;
    for (let i = s; i < e; i++) {
      if (bytes[i] >= 0x80) {
        high++;
        if (i + 1 < e && bytes[i + 1] >= 0x40 && bytes[i + 1] <= 0xfe) {
          pairs++;
          i++;
        }
      }
    }
    const score = high > 0 ? pairs / Math.max(1, high) : 0;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = b;
    }
  }
  const center = bestIdx * bucketLen + Math.floor(bucketLen / 2);
  const start = Math.max(0, Math.min(bytes.length - size, center - Math.floor(size / 2)));
  // Align to a safe break when possible.
  const aligned = nearestSafe(bytes, start, start + size);
  return { start: aligned, end: Math.min(bytes.length, aligned + size) };
}

function nearestSafe(bytes: Uint8Array, start: number, limit: number): number {
  for (let i = start; i < Math.min(limit, bytes.length); i++) {
    if (i === 0 || bytes[i - 1] === 0x0a || bytes[i - 1] === 0x0d) return i;
  }
  // Fall back to a UTF-8 lead boundary inside the window.
  for (let i = start; i < Math.min(limit, bytes.length); i++) {
    if ((bytes[i] & 0xc0) !== 0x80) return i;
  }
  return start;
}

/**
 * Build the candidate set for a byte range:
 *   direct decodes for every enabled encoding, plus mojibake repair chains
 *   gated on the segment being flagged as transcoded or suspicious.
 * Unreadable bytes are never dropped: they become explicit unresolved symbols.
 */
export function buildCandidates(
  bytes: Uint8Array,
  baseOffset: number,
  params: AnalysisParams,
  segmentKind: 'text' | 'mojibake' | 'tile-clean',
): Candidate[] {
  const lx = getLexicon();
  const list: Candidate[] = [];
  const encodings = candidateEncodingsOf(params);
  const seen = new Set<string>();

  const add = (args: {
    label: string;
    chain: ChainStep[];
    glyphs: Glyph[];
    unresolved: UnresolvedSymbol[];
    byteExact: boolean;
    lostBytes: number;
    kind: 'direct' | 'repair';
    outerEncoding?: EncodingId;
    pivotEncoding?: EncodingId;
    byteExactNote?: string;
  }) => {
    const key = `${args.chain.map((s) => `${s.kind}:${s.encoding}`).join('>')}|${args.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (args.glyphs.length === 0) return;
    const q = measureText(args.glyphs, lx);
    const finalEnc = args.chain[args.chain.length - 1].encoding;
    const score = scoreOf(
      {
        q,
        glyphs: args.glyphs,
        segmentBytes: bytes.length,
        lostBytes: args.lostBytes,
        layers: args.chain.length,
        unresolvedCount: args.unresolved.length,
      },
      lx,
    );
    score.score = Number(Math.min(1, score.score + (ENCODING_BONUS[finalEnc] ?? 0)).toFixed(4));
    const id = `cand-${baseOffset}-${list.length}-${slug(args.chain)}`;
    list.push({
      id,
      label: args.label,
      kind: args.kind,
      chain: args.chain,
      encoding: finalEnc,
      outerEncoding: args.outerEncoding,
      pivotEncoding: args.pivotEncoding,
      glyphs: args.glyphs,
      text: renderCandidateText(args.glyphs, baseOffset),
      unresolved: args.unresolved,
      score,
      byteExact: args.byteExact,
      byteExactNote: args.byteExactNote,
    });
  };

  // 1. Direct decodes.
  for (const enc of encodings) {
    const dec = decodeSegment(enc, bytes, baseOffset);
    if (dec.glyphs.length === 0) continue;
    const unresolved = groupUnresolved(dec.glyphs, baseOffset, enc, bytes);
    let exact = true;
    let note: string | undefined;
    if (unresolved.length > 0) {
      exact = false;
      note = '存在不可解字节，无法逐字节回写';
    } else {
      const recomposed: number[] = [];
      for (const g of dec.glyphs) {
        const b = encodeCharIn(enc, g.text.codePointAt(0) ?? 0);
        if (!b) {
          exact = false;
          note = `字符 ${g.text} 无法回写为 ${encodingLabel(enc)}`;
          break;
        }
        recomposed.push(...b);
      }
      if (exact) {
        if (recomposed.length !== bytes.length) exact = false;
        else for (let i = 0; i < bytes.length; i++) if (recomposed[i] !== bytes[i]) exact = false;
      }
      if (!exact && !note) note = '重新编码后与原始字节不一致';
    }
    add({
      label: `${encodingLabel(enc)} 直接解码`,
      chain: [{ kind: 'decode', encoding: enc }],
      glyphs: dec.glyphs,
      unresolved,
      byteExact: exact,
      byteExactNote: note,
      lostBytes: 0,
      kind: 'direct',
    });
  }

  // 2. Repairs. Run them for segments flagged as transcoded, or when the best
  //    direct decode leaves anomalies / mojibake markers. The outer decode may
  //    itself be UTF-8 — a mail client that saved mojibake as UTF-8 leaves a
  //    perfectly valid UTF-8 file whose *content* is a Latin-1 misreading.
  const bestDirect = list.reduce<Candidate | null>(
    (a, b) => (!a || b.score.score > a.score.score ? b : a),
    null,
  );
  const looksTranscoded =
    bestDirect !== null &&
    (bestDirect.score.mojibakeMarkerCount > 0 || bestDirect.score.anomalyRatio > 0.005);
  const shouldRepair =
    segmentKind === 'mojibake' ||
    (segmentKind === 'text' && bytes.length <= 16384) ||
    looksTranscoded;

  if (shouldRepair) {
    // Repair searches are exhaustive in the pivot × target space, so cap the
    // range they run on. For long segments a *window* around the most
    // suspicious region is enough to identify the transcode path; the final
    // selected candidate is rebuilt over the whole segment by the caller.
    const MAX_REPAIR_BYTES = 768;
    let repairBytes = bytes;
    let repairBase = baseOffset;
    if (bytes.length > MAX_REPAIR_BYTES) {
      const win = suspiciousWindow(bytes, MAX_REPAIR_BYTES);
      repairBytes = bytes.subarray(win.start, win.end);
      repairBase = baseOffset + win.start;
    }
    for (const outer of encodings) {
      const outerDec = decodeSegment(outer, repairBytes, repairBase);
      if (outerDec.glyphs.length === 0) continue;
      if (outerDec.anomalyBytes / Math.max(1, repairBytes.length) > 0.05) continue;
      for (const r of repairAttempts(outerDec.glyphs, repairBase, repairBytes, outer, params, encodings)) {
        add({
          label: r.label,
          chain: r.chain,
          glyphs: r.glyphs,
          unresolved: r.unresolved,
          byteExact: r.byteExact && bytes.length <= MAX_REPAIR_BYTES,
          byteExactNote:
            bytes.length > MAX_REPAIR_BYTES
              ? `仅在前 ${MAX_REPAIR_BYTES} B 可疑窗口内验证还原链；长区段需按窗口复核`
              : r.note,
          lostBytes: r.lostBytes,
          kind: 'repair',
          outerEncoding: outer,
          pivotEncoding: r.pivot,
        });
      }
    }
  }

  list.sort((a, b) => b.score.score - a.score.score);
  // Drop candidates whose final text is identical to a higher-ranked one: a
  // repair that reproduces the same characters adds review noise, not signal.
  const byText = new Map<string, Candidate>();
  for (const c of list) {
    if (!byText.has(c.text)) byText.set(c.text, c);
  }
  const unique = [...byText.values()].sort((a, b) => b.score.score - a.score.score);
  // Record the gap to the next *distinct* reading: identical-text candidates
  // are duplicates, not competing interpretations.
  for (let i = 0; i < unique.length; i++) {
    const next = unique[i + 1];
    unique[i].score.marginToRunnerUp = next ? Number((unique[i].score.score - next.score.score).toFixed(4)) : 1;
  }
  const directOnes = unique.filter((c) => c.kind === 'direct');
  const kept = unique.slice(0, Math.max(1, params.maxCandidatesPerSegment));
  for (const d of directOnes) if (!kept.includes(d)) kept.push(d);
  kept.sort((a, b) => b.score.score - a.score.score);
  return kept;
}

function slug(chain: ChainStep[]): string {
  return chain
    .map((s) => (s.kind === 'decode' ? `d${short(s.encoding)}` : `e${short(s.encoding)}`))
    .join('');
}

function short(enc: EncodingId): string {
  const map: Record<EncodingId, string> = {
    'utf-8': 'u',
    gb18030: 'g',
    big5: 'b',
    'windows-1252': 'w',
    'iso-8859-1': 'l',
    'utf-16le': 'e',
    'utf-16be': 'E',
  };
  return map[enc];
}

interface RepairAttempt {
  label: string;
  chain: ChainStep[];
  pivot: EncodingId;
  glyphs: Glyph[];
  unresolved: UnresolvedSymbol[];
  byteExact: boolean;
  lostBytes: number;
  note?: string;
}

/**
 * Validate a repair candidate: the rebuilt stream must decode cleanly in the
 * target encoding, cover most of the original bytes, and every glyph must be
 * writable back through the pivot (no silent losses).
 */
function repairAttempts(
  outerGlyphs: Glyph[],
  baseOffset: number,
  original: Uint8Array,
  outer: EncodingId,
  params: AnalysisParams,
  allEncodings: EncodingId[],
): RepairAttempt[] {
  const attempts: RepairAttempt[] = [];
  // The pivot is the codec the mail client used to *produce* the bytes. For a
  // UTF-8 → CP1252 → GBK round trip the pivot is CP1252; for a GBK → Big5 →
  // Big5 path it is GBK; for legacy DOS/mac paths it may be Latin-1.
  const preferred: EncodingId[] = ['windows-1252', 'iso-8859-1', 'gb18030', 'big5'];
  const pivots = preferred.filter((p) => p !== outer);
  const seen = new Set<string>();

  const consider = (pivot: EncodingId, target: EncodingId, targetUtf8: boolean) => {
    const { bytes: rebuilt, failures } = rebuildBytes(outerGlyphs, outer, pivot, targetUtf8);
    if (rebuilt.length === 0) return;
    const key = `${target}:${bytesToHex(rebuilt)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const totalGlyphs = outerGlyphs.length;
    // Byte accounting: the outer decode consumed `original.length` bytes; what
    // it could not interpret (anomaly glyphs) is genuinely lost. A successful
    // repair may legitimately be shorter than the mojibake it replaces.
    let outerLost = 0;
    for (const g of outerGlyphs) if (g.anomaly) outerLost += g.end - g.start;
    const failureLoss = failures.reduce((n, f) => {
      const g = outerGlyphs.find((x) => x.start === f.at);
      return n + (g ? g.end - g.start : 1);
    }, 0);
    const lostBytes = Math.min(original.length, outerLost + failureLoss);
    const fidelity = totalGlyphs === 0 ? 0 : 1 - failures.length / totalGlyphs;
    if (fidelity < 0.9) return;
    const dec = getCodec(target).decode(rebuilt, baseOffset);
    if (dec.anomalyBytes / Math.max(1, rebuilt.length) > 0.02) return;
    if (dec.text.trim().length === 0) return;
    const unresolved = groupUnresolved(dec.glyphs, baseOffset, target, rebuilt);
    const replacements = (dec.text.match(/\?/g) ?? []).length;
    const lossless = failures.length === 0 && unresolved.length === 0 && lostBytes === 0;
    const notes: string[] = [];
    if (failures.length > 0) notes.push(`${failures.length} 处无法无损回写：${failures[0].reason}`);
    if (lostBytes > 0) notes.push(`外层解码已丢失 ${lostBytes} 字节（原始损坏，非还原引入）`);
    if (replacements > 0) notes.push(`含 ${replacements} 个“?”替换符`);
    attempts.push({
      label:
        target === 'utf-8'
          ? `${encodingLabel(outer)}→${encodingLabel(pivot)}→UTF-8 还原`
          : `${encodingLabel(outer)}→${encodingLabel(pivot)}→${encodingLabel(target)} 还原`,
      chain: [
        { kind: 'decode', encoding: outer },
        { kind: 'encode', encoding: pivot },
        { kind: 'decode', encoding: target },
      ],
      pivot,
      glyphs: dec.glyphs,
      unresolved,
      byteExact: lossless,
      lostBytes,
      note: notes.length ? notes.join('；') : undefined,
    });
  };

  for (const pivot of pivots) {
    consider(pivot, 'utf-8', true);
    if (!isSingleByteEncoding(outer)) {
      for (const alt of allEncodings) {
        if (alt !== 'gb18030' && alt !== 'big5') continue;
        if (alt === outer || alt === pivot) continue;
        consider(pivot, alt, false);
      }
    }
  }
  return attempts.slice(0, params.maxCandidatesPerSegment * 2);
}

