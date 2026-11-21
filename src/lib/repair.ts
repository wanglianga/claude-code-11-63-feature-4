import type {
  AnalysisBundle,
  AnalysisParams,
  BoundaryAcknowledgement,
  BoundaryReview,
  Candidate,
  RepairState,
  RepairVersion,
  SegmentAnalysis,
  SegmentState,
  SupersededEntry,
  SymbolResolution,
  VersionOp,
  AuditStep,
  NoteEntry,
} from '../types';
import { analyzeRange } from './analysis/analyze';
import { evaluateBoundaries } from './analysis/boundaries';
import { canonicalJson, excerpt, makeId } from './util/bytes';
import { sha256Hex } from './util/sha256';

/* ------------------------------------------------------------------------ */
/* State construction                                                       */
/* ------------------------------------------------------------------------ */

function segmentFromAnalysis(seg: SegmentAnalysis): SegmentState {
  return {
    id: seg.id,
    start: seg.start,
    end: seg.end,
    kind: seg.kind,
    candidates: seg.candidates,
    selectedCandidateId:
      seg.status === 'confident' || seg.status === 'suggested'
        ? seg.suggestedCandidateId
        : seg.candidates[0]?.id ?? null,
    suggestedCandidateId: seg.suggestedCandidateId,
    analysisConfidence: seg.confidence,
    confidence: seg.confidence,
    analysisStatus: seg.status,
    status: seg.status,
    // The analysis result may already have been reduced for a high-risk
    // boundary. Recover the uncapped value from the winning candidate.
    baseConfidence: seg.baseConfidence ?? seg.confidence,
    baseStatus: seg.baseStatus ?? seg.status,
    reasons: [...seg.reasons],
    boundaryRiskIds: [],
    stale: false,
  };
}

/** Build the initial repair state from the chosen strategy result. */
export function createInitialState(bundle: AnalysisBundle, strategy: 'uniform' | 'segmented'): RepairState {
  const result = strategy === 'uniform' ? bundle.uniform : bundle.segmented;
  const segments = result.segments.map(segmentFromAnalysis);
  const boundaries = segments.slice(0, -1).map((s) => s.end);
  const state: RepairState = {
    boundaries,
    segments,
    symbolResolutions: {},
    notes: [],
    boundaryReviews: result.boundaryReviews.map((r) => ({ ...r })),
    boundaryAcknowledgements: {},
    superseded: [],
  };
  linkBoundaryRisks(state);
  return state;
}

/* ------------------------------------------------------------------------ */
/* Text assembly & evidence                                                 */
/* ------------------------------------------------------------------------ */

export function selectedCandidate(seg: SegmentState): Candidate | null {
  return (
    seg.candidates.find((c) => c.id === seg.selectedCandidateId) ??
    seg.candidates.find((c) => c.id === seg.suggestedCandidateId) ??
    seg.candidates[0] ??
    null
  );
}

/**
 * Render one segment's final text. Unresolved symbols use their human
 * adjudication when present, otherwise a byte-preserving placeholder — a
 * decision is never inferred from word frequency.
 *
 * The candidate's *raw* glyph stream is the source of truth: placeholders in
 * `cand.text` exist only for display, and their length differs from the raw
 * bytes, so walking the placeholder string drifts. Instead we slice the raw
 * decoded text by absolute byte range and insert one symbol per anomaly run.
 */
export function segmentText(seg: SegmentState, state: RepairState, opts: { placeholder?: 'byte-escape' | 'question' } = {}): string {
  const cand = selectedCandidate(seg);
  if (!cand) return '';
  const sorted = [...cand.unresolved].sort((a, b) => a.start - b.start);
  let out = '';
  let symIdx = 0;
  for (const g of cand.glyphs) {
    if (!g.anomaly) {
      out += g.text;
      continue;
    }
    // Emit one placeholder per anomaly run (the run that contains this glyph).
    const sym = sorted[symIdx];
    if (sym && g.start >= sym.start && g.end <= sym.end) {
      if (g.start === sym.start) {
        const adj = state.symbolResolutions[sym.id];
        if (adj) out += adj.text;
        else if (opts.placeholder === 'question') out += '?';
        else out += `⟦${sym.bytesHex || `${sym.end - sym.start} B`}⟧`;
        symIdx++;
      }
    }
  }
  return out;
}

export function stateText(state: RepairState, opts: { placeholder?: 'byte-escape' | 'question' } = {}): string {
  return state.segments.map((s) => segmentText(s, state, opts)).join('');
}

export function stateTextHash(state: RepairState): string {
  return sha256Hex(stateText(state));
}

export function stateHash(state: RepairState): string {
  return sha256Hex(canonicalJson(state));
}

/* ------------------------------------------------------------------------ */
/* Boundary reviews                                                         */
/* ------------------------------------------------------------------------ */

function linkBoundaryRisks(state: RepairState): void {
  for (const seg of state.segments) {
    seg.boundaryRiskIds = [];
    seg.stale = false;
  }
  for (const review of state.boundaryReviews) {
    const ack = state.boundaryAcknowledgements[review.id];
    review.acknowledged = Boolean(ack);
    review.acknowledgedNote = ack?.note ?? '';
    review.acknowledgedVersionId = ack?.versionId ?? null;
    const left = state.segments.find((s) => s.id === review.leftSegmentId);
    const right = state.segments.find((s) => s.id === review.rightSegmentId);
    if (left) left.boundaryRiskIds.push(review.id);
    if (right) right.boundaryRiskIds.push(review.id);
  }
}

/**
 * Recompute boundary reviews for the current selection. A high/medium review
 * that has *not* been explicitly acknowledged pulls both segments back to
 * `pending` and caps their confidence.
 */
export function recomputeBoundaries(state: RepairState, bytes?: Uint8Array): BoundaryReview[] {
  const pairs = [];
  for (let i = 0; i + 1 < state.segments.length; i++) {
    const left = state.segments[i];
    const right = state.segments[i + 1];
    pairs.push({
      boundary: left.end,
      left: toAnalysis(left),
      right: toAnalysis(right),
    });
  }
  void pairs;
  const hasMixed = new Set(state.segments.map((s) => selectedCandidate(s)?.encoding)).size > 1;
  const { reviews } = evaluateForState(state, bytes);
  for (const r of reviews) {
    const prior = state.boundaryReviews.find((x) => x.id === r.id);
    if (prior?.acknowledged) {
      r.acknowledged = true;
      r.acknowledgedNote = prior.acknowledgedNote;
      r.acknowledgedVersionId = prior.acknowledgedVersionId;
    }
  }
  state.boundaryReviews = reviews;
  linkBoundaryRisks(state);
  for (const seg of state.segments) {
    const blocking = reviews.filter(
      (r) =>
        (r.leftSegmentId === seg.id || r.rightSegmentId === seg.id) &&
        !r.acknowledged &&
        (r.severity === 'high' || r.severity === 'medium'),
    );
    if (blocking.length > 0) {
      const capped = Math.min(seg.confidence, ...blocking.map((r) => r.combinedConfidence));
      seg.confidence = Number(capped.toFixed(4));
      seg.status = 'pending';
      for (const r of blocking) {
        const line = `相邻边界 ${r.boundary}：${r.flags[0] ?? '存在断裂风险'}`;
        if (!seg.reasons.includes(line)) seg.reasons.push(line);
      }
    }
  }
  void hasMixed;
  return reviews;
}

function toAnalysis(seg: SegmentState): SegmentAnalysis {
  return {
    id: seg.id,
    start: seg.start,
    end: seg.end,
    kind: seg.kind,
    candidates: seg.candidates,
    suggestedCandidateId: seg.selectedCandidateId ?? seg.suggestedCandidateId ?? '',
    confidence: seg.confidence,
    margin: 0,
    status: seg.status,
    reasons: seg.reasons,
    anomalyBytes: 0,
    suspiciousGlyphs: 0,
    detectedEncoding: selectedCandidate(seg)?.encoding ?? null,
  };
}

/** Evaluate the current state's adjacency with the full boundary rules. */
function evaluateForState(state: RepairState, bytes?: Uint8Array): { reviews: BoundaryReview[] } {
  const pairs = [];
  for (let i = 0; i + 1 < state.segments.length; i++) {
    const left = state.segments[i];
    const right = state.segments[i + 1];
    const lc = left.candidates.find((c) => c.id === left.selectedCandidateId) ?? left.candidates[0];
    const rc = right.candidates.find((c) => c.id === right.selectedCandidateId) ?? right.candidates[0];
    const leftAnalysis: SegmentAnalysis = {
      ...toAnalysis(left),
      suggestedCandidateId: lc?.id ?? '',
      candidates: lc && !left.candidates.includes(lc) ? [...left.candidates, lc] : left.candidates,
      confidence: left.confidence,
      status: left.status,
    };
    const rightAnalysis: SegmentAnalysis = {
      ...toAnalysis(right),
      suggestedCandidateId: rc?.id ?? '',
      candidates: rc && !right.candidates.includes(rc) ? [...right.candidates, rc] : right.candidates,
      confidence: right.confidence,
      status: right.status,
    };
    const boundary = left.end;
    pairs.push({
      boundary,
      left: leftAnalysis,
      right: rightAnalysis,
      rawWindow: bytes
        ? {
            left: bytes.subarray(Math.max(0, boundary - 32), boundary),
            right: bytes.subarray(boundary, Math.min(bytes.length, boundary + 32)),
          }
        : undefined,
    });
  }
  const hasMixed = new Set(state.segments.map((s) => selectedCandidate(s)?.encoding)).size > 1;
  return evaluateBoundaries(pairs, { hasMixedEncodings: hasMixed });
}

/* ------------------------------------------------------------------------ */
/* Version creation                                                         */
/* ------------------------------------------------------------------------ */

export interface CreateVersionInput {
  importId: string;
  digest: string;
  runId: string;
  parent: RepairVersion | null;
  strategy: 'uniform' | 'segmented';
  state: RepairState;
  op: VersionOp;
  name: string;
}

export function buildVersion(input: CreateVersionInput, now = new Date().toISOString()): RepairVersion {
  const { parent, state, op } = input;
  const beforeState = parent?.state ?? null;
  const beforeText = beforeState ? stateText(beforeState) : '';
  const afterText = stateText(state);
  const step: AuditStep = {
    index: (parent?.audit.length ?? 0),
    op,
    description: describeOp(op),
    textHashBefore: beforeState ? stateTextHash(beforeState) : '',
    textHashAfter: stateTextHash(state),
    excerptBefore: excerpt(beforeText, 120),
    excerptAfter: excerpt(afterText, 120),
  };
  const version: Omit<RepairVersion, 'stateHash'> = {
    id: makeId('ver', true),
    importId: input.importId,
    digest: input.digest,
    runId: input.runId,
    parentId: parent?.id ?? null,
    seq: (parent?.seq ?? 0) + 1,
    name: input.name,
    createdAt: now,
    strategy: input.strategy,
    state: cloneState(state),
    ops: [...(parent?.ops ?? []), op],
    superseded: [...(parent?.superseded ?? []), ...(op.type === 'move-boundary' ? op.superseded : [])],
    audit: [...(parent?.audit ?? []), step],
  };
  return { ...version, stateHash: sha256Hex(canonicalJson(version)) };
}

function describeOp(op: VersionOp): string {
  switch (op.type) {
    case 'create':
      return `创建修复版本（${op.strategy === 'uniform' ? '统一解码' : '分段诊断'}）`;
    case 'select-candidate':
      return `区段选择候选：${op.candidateId}`;
    case 'move-boundary':
      return `移动边界 #${op.boundaryIndex}：${op.from} → ${op.to}`;
    case 'resolve-symbol':
      return `裁决不可解符号 ${op.symbolId} → “${op.text}”`;
    case 'clear-symbol':
      return `撤销符号裁决 ${op.symbolId}`;
    case 'acknowledge-boundary':
      return `确认边界风险 ${op.reviewId}（${op.boundary}）`;
    case 'add-note':
      return `备注：${op.text}`;
    default:
      return '操作';
  }
}

function cloneState(state: RepairState): RepairState {
  return JSON.parse(JSON.stringify(state)) as RepairState;
}

/* ------------------------------------------------------------------------ */
/* Operations                                                               */
/* ------------------------------------------------------------------------ */

/** Re-analyse one byte range, keeping the old version's adjudications intact. */
function reanalyzeSegment(
  bytes: Uint8Array,
  start: number,
  end: number,
  kind: 'text' | 'mojibake',
  params: AnalysisParams,
): SegmentState {
  const analysis = analyzeRange(bytes, start, end, kind, params);
  const state = segmentFromAnalysis(analysis);
  return state;
}

export interface MoveBoundaryResult {
  state: RepairState;
  superseded: SupersededEntry[];
  op: Extract<VersionOp, { type: 'move-boundary' }>;
}

/**
 * Redefine a segment boundary.
 *
 * Per the brief: the old adjudications are kept only as history, and the two
 * rebuilt ranges are re-evaluated from scratch (fresh candidates, fresh
 * confidence, fresh boundary reviews). Nothing carries over except the
 * superseded audit entries.
 */
export function moveBoundary(
  state: RepairState,
  bytes: Uint8Array,
  params: AnalysisParams,
  boundaryIndex: number,
  newPosition: number,
  note: string,
  versionId: string,
  seq: number,
): MoveBoundaryResult {
  const next = cloneState(state);
  const left = next.segments[boundaryIndex];
  const right = next.segments[boundaryIndex + 1];
  if (!left || !right) throw new Error('边界索引超出范围');
  const oldPosition = left.end;
  if (newPosition <= left.start || newPosition >= right.end) {
    throw new Error(`新边界 ${newPosition} 必须位于 ${left.start} 与 ${right.end} 之间`);
  }
  // A UTF-8 continuation byte can never start a segment.
  if (newPosition < bytes.length && (bytes[newPosition] & 0xc0) === 0x80) {
    throw new Error('新边界落在多字节序列中间，请选择字符起始位置');
  }

  // Collect adjudications that belong to the replaced ranges.
  const superseded: SupersededEntry[] = [];
  const inRange = (offset: number) =>
    (offset >= left.start && offset < right.end);
  for (const [symbolId, res] of Object.entries(next.symbolResolutions)) {
    if (!inRange(res.start)) continue;
    superseded.push({
      id: makeId('sup', true),
      atVersionId: versionId,
      atSeq: seq,
      kind: 'symbol-resolution',
      segmentRange: [left.start, right.end],
      segmentId: res.start < newPosition ? left.id : right.id,
      summary: `旧裁决 “${res.text}” 只保留为历史（符号 ${symbolId}）`,
      oldSymbolText: res.text,
      note: res.note,
    });
    delete next.symbolResolutions[symbolId];
  }
  for (const seg of [left, right]) {
    const cand = selectedCandidate(seg);
    superseded.push({
      id: makeId('sup', true),
      atVersionId: versionId,
      atSeq: seq,
      kind: 'boundary-move',
      segmentRange: [seg.start, seg.end],
      segmentId: seg.id,
      summary: `区段 ${seg.start}–${seg.end} 因边界重定义被重新评估`,
      oldCandidateLabel: cand?.label,
      oldStatus: seg.status,
      note,
    });
  }
  for (const review of next.boundaryReviews) {
    if (review.leftSegmentId === left.id || review.rightSegmentId === right.id || review.boundary === oldPosition) {
      if (review.acknowledged) {
        superseded.push({
          id: makeId('sup', true),
          atVersionId: versionId,
          atSeq: seq,
          kind: 'boundary-move',
          segmentRange: [left.start, right.end],
          segmentId: review.leftSegmentId,
          summary: `边界确认 “${review.acknowledgedNote || review.id}” 随边界移动失效`,
          oldStatus: 'acknowledged',
          note,
        });
      }
      delete next.boundaryAcknowledgements[review.id];
    }
  }

  // Rebuild both ranges from the original bytes — no inherited candidates.
  const rebuiltLeft = reanalyzeSegment(bytes, left.start, newPosition, left.kind, params);
  const rebuiltRight = reanalyzeSegment(bytes, newPosition, right.end, right.kind, params);
  next.segments.splice(boundaryIndex, 2, rebuiltLeft, rebuiltRight);
  next.boundaries = next.segments.slice(0, -1).map((s) => s.end);
  next.superseded = [...next.superseded, ...superseded];
  recomputeBoundaries(next);

  return {
    state: next,
    superseded,
    op: {
      type: 'move-boundary',
      boundaryIndex,
      from: oldPosition,
      to: newPosition,
      left: rebuiltLeft,
      right: rebuiltRight,
      replacedSegmentIds: [left.id, right.id],
      superseded,
      note,
    },
  };
}

export function selectCandidate(state: RepairState, segmentId: string, candidateId: string): RepairState {
  const next = cloneState(state);
  const seg = next.segments.find((s) => s.id === segmentId);
  if (!seg) throw new Error('区段不存在');
  if (!seg.candidates.some((c) => c.id === candidateId)) throw new Error('候选不存在');
  seg.selectedCandidateId = candidateId;
  // Re-selecting lifts the segment out of an analysis-driven pending state,
  // but boundary conflicts re-apply below.
  seg.status = seg.analysisStatus === 'confident' ? 'confident' : 'suggested';
  seg.confidence = Math.max(seg.confidence, seg.analysisConfidence);
  seg.reasons = [];
  recomputeBoundaries(next);
  return next;
}

export function setSymbolResolution(
  state: RepairState,
  segmentId: string,
  symbolId: string,
  text: string,
  note: string,
  versionId: string,
): RepairState {
  const next = cloneState(state);
  const seg = next.segments.find((s) => s.id === segmentId);
  if (!seg) throw new Error('区段不存在');
  const cand = selectedCandidate(seg);
  const sym = cand?.unresolved.find((u) => u.id === symbolId);
  if (!sym) throw new Error('符号不存在');
  if (text.includes('⟦') || text.includes('⟧')) {
    throw new Error('裁决文本不得包含占位符字符');
  }
  const res: SymbolResolution = {
    symbolId,
    start: sym.start,
    end: sym.end,
    text,
    note,
    versionId,
    decidedAt: new Date().toISOString(),
  };
  next.symbolResolutions[symbolId] = res;
  next.notes.push(...(note ? [{
    id: makeId('note', true),
    target: symbolId,
    text: note,
    createdAt: res.decidedAt,
    versionId,
  }] : []));
  recomputeBoundaries(next);
  return next;
}

export function clearSymbolResolution(state: RepairState, symbolId: string): RepairState {
  const next = cloneState(state);
  delete next.symbolResolutions[symbolId];
  next.notes = next.notes.filter((n) => n.target !== symbolId);
  recomputeBoundaries(next);
  return next;
}

export function acknowledgeBoundary(
  state: RepairState,
  reviewId: string,
  note: string,
  versionId: string,
  bytes?: Uint8Array,
): RepairState {
  const next = cloneState(state);
  const review = next.boundaryReviews.find((r) => r.id === reviewId);
  if (!review) throw new Error('边界复核项不存在');
  const ack: BoundaryAcknowledgement = {
    reviewId,
    boundary: review.boundary,
    note,
    versionId,
    at: new Date().toISOString(),
  };
  next.boundaryAcknowledgements[reviewId] = ack;
  // Reset the two involved segments to their pre-boundary base before
  // re-evaluating, so a verified boundary can lift the pending cap entirely.
  for (const id of [review.leftSegmentId, review.rightSegmentId]) {
    const seg = next.segments.find((s) => s.id === id);
    if (!seg) continue;
    seg.confidence = Math.max(seg.baseConfidence, seg.analysisConfidence);
    seg.status = seg.baseStatus === 'pending' && seg.analysisStatus !== 'pending' ? seg.analysisStatus : seg.baseStatus;
    seg.reasons = seg.reasons.filter((r) => !r.startsWith('相邻边界'));
  }
  recomputeBoundaries(next, bytes);
  return next;
}

export function addNote(state: RepairState, target: string, text: string, versionId: string): RepairState {
  const next = cloneState(state);
  const note: NoteEntry = {
    id: makeId('note', true),
    target,
    text,
    createdAt: new Date().toISOString(),
    versionId,
  };
  next.notes.push(note);
  return next;
}

/* ------------------------------------------------------------------------ */
/* Status summary                                                           */
/* ------------------------------------------------------------------------ */

export interface VersionSummary {
  pending: number;
  suggested: number;
  confident: number;
  unresolvedOpen: number;
  unresolvedResolved: number;
  unacknowledgedHigh: number;
  unacknowledgedMedium: number;
  blocked: boolean;
  blockingReasons: string[];
}

export function summarizeVersion(version: RepairVersion): VersionSummary {
  const state = version.state;
  let pending = 0;
  let suggested = 0;
  let confident = 0;
  let open = 0;
  let resolved = 0;
  for (const seg of state.segments) {
    if (seg.status === 'pending') pending++;
    else if (seg.status === 'suggested') suggested++;
    else confident++;
    const cand = selectedCandidate(seg);
    for (const sym of cand?.unresolved ?? []) {
      if (state.symbolResolutions[sym.id]) resolved++;
      else open++;
    }
  }
  const unacked = state.boundaryReviews.filter((r) => !r.acknowledged);
  const high = unacked.filter((r) => r.severity === 'high').length;
  const medium = unacked.filter((r) => r.severity === 'medium').length;
  const blockingReasons: string[] = [];
  if (high > 0) blockingReasons.push(`${high} 处高风险边界未确认（药名/剂量/括号可能断裂）`);
  if (pending > 0) blockingReasons.push(`${pending} 个区段停在待裁决`);
  if (open > 0) blockingReasons.push(`${open} 个不可解符号未裁决`);
  return {
    pending,
    suggested,
    confident,
    unresolvedOpen: open,
    unresolvedResolved: resolved,
    unacknowledgedHigh: high,
    unacknowledgedMedium: medium,
    blocked: blockingReasons.length > 0,
    blockingReasons,
  };
}

/* ------------------------------------------------------------------------ */
/* Replay                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Re-apply a run of version operations to a fresh initial state and verify the
 * resulting state hash matches. Boundary moves replay from the op's recorded
 * rebuilt segments (which were themselves derived from the original bytes), so
 * replay is deterministic without re-running the analysing heuristics.
 */
export function replayOps(initial: RepairState, ops: VersionOp[], params: AnalysisParams): RepairState {
  let state = cloneState(initial);
  for (const op of ops) {
    state = applyOp(state, op, params);
  }
  return state;
}

function applyOp(state: RepairState, op: VersionOp, params: AnalysisParams): RepairState {
  void params;
  switch (op.type) {
    case 'create':
      return state;
    case 'select-candidate': {
      const next = cloneState(state);
      const seg = next.segments.find((s) => s.id === op.segmentId);
      if (seg) {
        seg.selectedCandidateId = op.candidateId;
        seg.status = 'suggested';
      }
      recomputeBoundaries(next);
      return next;
    }
    case 'move-boundary': {
      const next = cloneState(state);
      const idx = op.boundaryIndex;
      const left = next.segments[idx];
      const right = next.segments[idx + 1];
      if (left && right) {
        next.segments.splice(idx, 2, cloneState({ ...state, segments: [op.left] }).segments[0], cloneState({ ...state, segments: [op.right] }).segments[0]);
        next.boundaries = next.segments.slice(0, -1).map((s) => s.end);
      }
      recomputeBoundaries(next);
      return next;
    }
    case 'resolve-symbol': {
      const next = cloneState(state);
      next.symbolResolutions[op.symbolId] = {
        symbolId: op.symbolId,
        start: op.previous?.start ?? 0,
        end: op.previous?.end ?? 0,
        text: op.text,
        note: op.note,
        versionId: 'replay',
        decidedAt: 'replay',
      };
      return next;
    }
    case 'clear-symbol': {
      const next = cloneState(state);
      delete next.symbolResolutions[op.symbolId];
      return next;
    }
    case 'acknowledge-boundary': {
      const next = cloneState(state);
      next.boundaryAcknowledgements[op.reviewId] = {
        reviewId: op.reviewId,
        boundary: op.boundary,
        note: op.note,
        versionId: 'replay',
        at: 'replay',
      };
      recomputeBoundaries(next);
      return next;
    }
    case 'add-note': {
      const next = cloneState(state);
      next.notes.push({
        id: makeId('note', true),
        target: op.target,
        text: op.text,
        createdAt: 'replay',
        versionId: 'replay',
      });
      return next;
    }
    default:
      return state;
  }
}

/* ------------------------------------------------------------------------ */
/* Verification                                                             */
/* ------------------------------------------------------------------------ */

export interface VerificationInput {
  version: RepairVersion;
  bytes: Uint8Array;
  digest: string;
}

export function verifyVersion({ version, bytes, digest }: VerificationInput): {
  digestMatches: boolean;
  recomputedDigest: string;
  segmentsCoverFile: boolean;
  coverageIssues: string[];
  unresolvedCount: number;
  staleSegments: number;
  highRiskBoundaries: number;
  stateHashMatches: boolean;
} {
  const recomputedDigest = sha256Hex(bytes);
  const issues: string[] = [];
  const segs = version.state.segments;
  if (segs.length > 0) {
    if (segs[0].start !== 0) issues.push(`首段从 ${segs[0].start} 开始，未覆盖文件头`);
    if (segs[segs.length - 1].end !== bytes.length) {
      issues.push(`末段在 ${segs[segs.length - 1].end} 结束，文件长 ${bytes.length}`);
    }
    for (let i = 0; i + 1 < segs.length; i++) {
      if (segs[i].end !== segs[i + 1].start) {
        issues.push(`区段 ${i} 结束于 ${segs[i].end}，但下一段从 ${segs[i + 1].start} 开始`);
      }
    }
  } else {
    issues.push('没有任何区段');
  }
  let unresolved = 0;
  for (const seg of segs) {
    const c = selectedCandidate(seg);
    unresolved += c?.unresolved.length ?? 0;
  }
  const recomputedStateHash = sha256Hex(
    canonicalJson({
      id: version.id,
      importId: version.importId,
      digest: version.digest,
      runId: version.runId,
      parentId: version.parentId,
      seq: version.seq,
      name: version.name,
      createdAt: version.createdAt,
      strategy: version.strategy,
      state: version.state,
      ops: version.ops,
      superseded: version.superseded,
      audit: version.audit,
    }),
  );
  return {
    digestMatches: recomputedDigest === digest,
    recomputedDigest,
    segmentsCoverFile: issues.length === 0,
    coverageIssues: issues,
    unresolvedCount: unresolved,
    staleSegments: segs.filter((s) => s.stale).length,
    highRiskBoundaries: version.state.boundaryReviews.filter((r) => r.severity === 'high' && !r.acknowledged)
      .length,
    stateHashMatches: recomputedStateHash === version.stateHash,
  };
}

