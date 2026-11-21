import type {
  AnalysisBundle,
  AnalysisParams,
  BoundaryReview,
  Candidate,
  SegmentAnalysis,
  SegmentStatus,
  StrategyComparisonRow,
  StrategyMetrics,
  StrategyResult,
} from '../../types';
import { encodingLabel } from '../encoding/specs';
import { buildCandidates } from './candidates';
import { evaluateBoundaries } from './boundaries';
import { segmentFile, type RawSegment } from './segmenter';

export interface AnalysisInput {
  bytes: Uint8Array;
  digest: string;
  params: AnalysisParams;
  now?: string;
}

function summarizeSegment(seg: RawSegment, bytes: Uint8Array, params: AnalysisParams): SegmentAnalysis {
  const slice = bytes.subarray(seg.start, seg.end);
  const candidates = buildCandidates(slice, seg.start, params, seg.kind);
  const best = candidates[0];
  const confidence = best ? best.score.score : 0;
  const margin = best?.score.marginToRunnerUp ?? (best ? 1 : 0);

  const reasons: string[] = [];
  const status = statusFor(best, confidence, margin, params, reasons);

  // Collapse identical direct decodes when the confidence is high and the
  // segment is short, so the review list stays readable.
  const pruned = pruneCandidates(candidates, params);

  return {
    id: `seg-${seg.start}-${seg.end}`,
    start: seg.start,
    end: seg.end,
    kind: seg.kind,
    candidates: pruned,
    suggestedCandidateId: best?.id ?? '',
    confidence: Number(confidence.toFixed(4)),
    margin: Number(margin.toFixed(4)),
    status,
    reasons,
    anomalyBytes: best ? Math.round(best.score.anomalyRatio * slice.length) : slice.length,
    suspiciousGlyphs: best ? Math.round(best.score.suspiciousRatio * Math.max(1, best.glyphs.length)) : 0,
    detectedEncoding: best?.kind === 'direct' ? best.encoding : best?.outerEncoding ?? null,
    // Pre-boundary values; the boundary pass may lower these but acknowledging
    // a review restores the segment to what its own analysis found.
    baseConfidence: Number(confidence.toFixed(4)),
    baseStatus: status,
  };
}

function statusFor(
  best: Candidate | undefined,
  confidence: number,
  margin: number,
  params: AnalysisParams,
  reasons: string[],
): SegmentStatus {
  if (!best) {
    reasons.push('没有任何候选能解码该区段');
    return 'pending';
  }
  if (best.score.anomalyRatio > 0.02) {
    reasons.push(`${(best.score.anomalyRatio * 100).toFixed(1)}% 字节不可解，需人工裁决`);
  }
  if (best.unresolved.length > 0) {
    reasons.push(`${best.unresolved.length} 段不可解字节以占位符保留`);
  }
  if (best.score.mojibakeMarkerCount > 0) {
    reasons.push(`存在 ${best.score.mojibakeMarkerCount} 处乱码特征字符`);
  }
  if (!best.byteExact && best.unresolved.length === 0) {
    reasons.push('候选无法逐字节回写原始字节');
  }
  if (best.kind === 'repair' && confidence < params.confidenceThreshold + 0.08) {
    reasons.push('还原链置信度偏低，建议人工复核');
  }
  const ambiguous = margin < params.marginThreshold && confidence < 0.95;
  if (ambiguous) {
    reasons.push(`前两名候选分值差仅 ${(margin * 100).toFixed(1)} 分`);
  }
  if (confidence < params.confidenceThreshold || ambiguous) {
    return 'pending';
  }
  if (
    best.score.anomalyRatio > 0 ||
    best.unresolved.length > 0 ||
    best.score.mojibakeMarkerCount > 0 ||
    confidence < params.confidenceThreshold + 0.08
  ) {
    return 'suggested';
  }
  return 'confident';
}

function pruneCandidates(list: Candidate[], params: AnalysisParams): Candidate[] {
  const kept: Candidate[] = [];
  const seenText = new Set<string>();
  for (const c of list) {
    if (kept.length >= params.maxCandidatesPerSegment) break;
    const textKey = c.text.slice(0, 400);
    if (seenText.has(textKey) && c.kind === 'direct') continue;
    seenText.add(textKey);
    kept.push(c);
  }
  if (list[0] && !kept.includes(list[0])) kept.unshift(list[0]);
  return kept;
}

function metricsOf(result: Omit<StrategyResult, 'metrics'>): StrategyMetrics {
  const segments = result.segments;
  const encodings = new Set<string>();
  for (const s of segments) {
    const best = s.candidates.find((c) => c.id === s.suggestedCandidateId);
    if (best?.kind === 'direct') encodings.add(best.encoding);
    else if (best?.outerEncoding) encodings.add(best.outerEncoding);
    if (best?.encoding) encodings.add(best.encoding);
  }
  const distinctCandidates = segments.reduce((n, s) => n + s.candidates.length, 0);
  const pendingSegments = segments.filter((s) => s.status === 'pending').length;
  const suggestedSegments = segments.filter((s) => s.status === 'suggested').length;
  const boundaryHighRisk = result.boundaryReviews.filter((b) => b.severity === 'high').length;
  const boundaryMediumRisk = result.boundaryReviews.filter((b) => b.severity === 'medium').length;
  const meanConfidence = segments.length === 0 ? 0 : segments.reduce((n, s) => n + s.confidence, 0) / segments.length;
  const unresolvedSymbols = segments.reduce((n, s) => {
    const best = s.candidates.find((c) => c.id === s.suggestedCandidateId);
    return n + (best?.unresolved.length ?? 0);
  }, 0);
  const anomalyBytes = segments.reduce((n, s) => n + s.anomalyBytes, 0);
  const suspiciousGlyphs = segments.reduce((n, s) => n + s.suspiciousGlyphs, 0);
  return {
    segmentCount: segments.length,
    distinctCandidates,
    distinctEncodings: encodings.size,
    mojibakeSegments: segments.filter((s) => {
      const best = s.candidates.find((c) => c.id === s.suggestedCandidateId);
      return best?.kind === 'repair' || s.kind === 'mojibake';
    }).length,
    anomalyBytes,
    unresolvedSymbols,
    suspiciousGlyphs,
    pendingSegments,
    suggestedSegments,
    boundaryHighRisk,
    boundaryMediumRisk,
    meanConfidence: Number(meanConfidence.toFixed(3)),
    reviewLoad: pendingSegments * 2 + suggestedSegments + boundaryHighRisk * 3 + boundaryMediumRisk,
    retainedMixedEncoding: encodings.size > 1,
  };
}

export function runUniform(bytes: Uint8Array, params: AnalysisParams): StrategyResult {
  const started = performance.now();
  const segment = summarizeSegment(
    { start: 0, end: bytes.length, kind: 'text', hypothesis: 'utf-8', tileCount: 1, score: 0 },
    bytes,
    params,
  );
  const notes = [
    '整份文件只生成一组候选，所有字节共用同一个编码假设。',
    '局部双重转码片段会与正文走同一条错误路径，界面与统计最简单。',
  ];
  const segments = [segment];
  const metrics = metricsOf({ strategy: 'uniform', segments, boundaryReviews: [], elapsedMs: 0, notes });
  return {
    strategy: 'uniform',
    segments,
    boundaryReviews: [],
    metrics,
    elapsedMs: Math.round(performance.now() - started),
    notes,
  };
}

export function runSegmented(bytes: Uint8Array, params: AnalysisParams): StrategyResult {
  const started = performance.now();
  const raw = segmentFile(bytes, params);
  const segments = raw.map((r) => summarizeSegment(r, bytes, params));

  const pairs = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const boundary = segments[i].end;
    pairs.push({
      boundary,
      left: segments[i],
      right: segments[i + 1],
      rawWindow: {
        left: bytes.subarray(Math.max(0, boundary - 32), boundary),
        right: bytes.subarray(boundary, Math.min(bytes.length, boundary + 32)),
      },
    });
  }
  const hasMixedEncodings =
    new Set(segments.map((s) => s.detectedEncoding).filter(Boolean)).size > 1;
  const { reviews, caps } = evaluateBoundaries(pairs, { hasMixedEncodings });

  for (const seg of segments) {
    const cap = caps.get(seg.id);
    if (!cap) continue;
    seg.confidence = Number(Math.min(seg.confidence, cap.confidence).toFixed(4));
    for (const r of cap.reasons) if (!seg.reasons.includes(r)) seg.reasons.push(r);
    seg.status = 'pending';
  }
  for (const rev of reviews) {
    if (rev.severity === 'high' || rev.severity === 'medium') {
      const left = segments.find((s) => s.id === rev.leftSegmentId);
      const right = segments.find((s) => s.id === rev.rightSegmentId);
      if (left && !left.reasons.includes(rev.detail)) left.reasons.push(rev.detail);
      if (right && !right.reasons.includes(rev.detail)) right.reasons.push(rev.detail);
    }
  }

  const notes = [
    `按 ${params.tileBytes} B 瓦片扫描并按假设合并，得到 ${segments.length} 个区段。`,
    '每个区段独立评估候选，因此可以保留 GBK、Big5、UTF-8 混合内容。',
    '区段数量、候选数量和边界复核量会随混合程度上升。',
  ];
  const partial = { strategy: 'segmented' as const, segments, boundaryReviews: reviews, elapsedMs: 0, notes };
  const metrics = metricsOf(partial);
  return { ...partial, metrics, elapsedMs: Math.round(performance.now() - started) };
}

export function compareStrategies(uniform: StrategyResult, segmented: StrategyResult): StrategyComparisonRow[] {
  const f = (n: number, digits = 0) => n.toFixed(digits);
  return [
    {
      metric: '区段数',
      uniform: '1',
      segmented: String(segmented.metrics.segmentCount),
      hint: '分段越多，越能隔离局部损坏，但维护成本越高',
    },
    {
      metric: '候选总数',
      uniform: String(uniform.metrics.distinctCandidates),
      segmented: String(segmented.metrics.distinctCandidates),
      hint: '每个区段独立生成候选，审阅量随区段数增长',
    },
    {
      metric: '识别出的编码数',
      uniform: String(uniform.metrics.distinctEncodings),
      segmented: String(segmented.metrics.distinctEncodings),
      hint: '>1 说明文件确实混合了多种编码',
    },
    {
      metric: '乱码还原区段',
      uniform: String(uniform.metrics.mojibakeSegments),
      segmented: String(segmented.metrics.mojibakeSegments),
      hint: '整份文件统一解码时，局部双重转码只能靠单一候选兜底',
    },
    {
      metric: '待裁决区段',
      uniform: String(uniform.metrics.pendingSegments),
      segmented: String(segmented.metrics.pendingSegments),
      hint: '置信度不足或相邻边界冲突的区段必须停在待裁决',
    },
    {
      metric: '高风险边界',
      uniform: '—',
      segmented: String(segmented.metrics.boundaryHighRisk),
      hint: '药名、剂量单位或括号跨边界断裂',
    },
    {
      metric: '不可解字节（估计）',
      uniform: f(uniform.metrics.anomalyBytes),
      segmented: f(segmented.metrics.anomalyBytes),
      hint: '工具不会凭常用词删除不可解字节，只记录其字节范围',
    },
    {
      metric: '不可解符号占位',
      uniform: String(uniform.metrics.unresolvedSymbols),
      segmented: String(segmented.metrics.unresolvedSymbols),
      hint: '需要人工逐段裁决的占位符数量',
    },
    {
      metric: '平均置信度',
      uniform: f(uniform.metrics.meanConfidence, 2),
      segmented: f(segmented.metrics.meanConfidence, 2),
      hint: '边界冲突会主动拉低组合置信度',
    },
    {
      metric: '复核工作量（加权）',
      uniform: f(uniform.metrics.reviewLoad),
      segmented: f(segmented.metrics.reviewLoad),
      hint: '待裁决×2 + 建议复核 + 高风险×3 + 中风险',
    },
  ];
}

export function recommend(uniform: StrategyResult, segmented: StrategyResult): {
  strategy: 'uniform' | 'segmented';
  rationale: string[];
} {
  const rationale: string[] = [];
  const um = uniform.metrics;
  const sm = segmented.metrics;
  if (sm.distinctEncodings > 1) {
    rationale.push(
      `分段诊断识别出 ${sm.distinctEncodings} 种编码（${[...new Set(segmented.segments.map((s) => encodingLabel(s.detectedEncoding)))].join('、')}），整份文件并非单一编码。`,
    );
  }
  if (sm.mojibakeSegments > um.mojibakeSegments) {
    rationale.push('分段策略把局部双重转码隔离到独立区段，未让同一错误路径覆盖全文。');
  }
  if (sm.anomalyBytes < um.anomalyBytes) {
    rationale.push(
      `分段策略的不可解字节估计更低（${sm.anomalyBytes} vs ${um.anomalyBytes}），说明多数片段在各自的正确编码下可读。`,
    );
  }
  const uniformPending = um.pendingSegments > 0;
  if (uniformPending) if (segmented.metrics.distinctEncodings > 1) rationale.push('统一解码会把受损片段扩散到全文，建议以分段结果为起点。');

  if (sm.distinctEncodings <= 1 && sm.segmentCount <= 2) {
    return {
      strategy: 'uniform',
      rationale: [
        '文件呈现单一编码特征且区段数很少，统一解码即可，界面与复核成本最低。',
        ...rationale,
      ],
    };
  }
  if (sm.reviewLoad > 80 && um.reviewLoad < sm.reviewLoad / 3 && sm.distinctEncodings <= 1) {
    return {
      strategy: 'uniform',
      rationale: [
        '分段策略复核量过高而收益有限，按题目要求应由开发者依据混合程度选择统一解码。',
        ...rationale,
      ],
    };
  }
  rationale.push('两种策略都不自动删除不可解字节，最终仍需人工裁决。');
  return { strategy: 'segmented', rationale };
}

export function runAnalysis(input: AnalysisInput): AnalysisBundle {
  const { bytes, params } = input;
  const uniform = runUniform(bytes, params);
  const segmented = runSegmented(bytes, params);
  const { strategy, rationale } = recommend(uniform, segmented);
  return {
    digest: input.digest,
    byteLength: bytes.length,
    params,
    uniform,
    segmented,
    recommendedStrategy: strategy,
    recommendationRationale: rationale,
    comparisonRows: compareStrategies(uniform, segmented),
    createdAt: input.now ?? new Date().toISOString(),
    engine: 'bytelab-engine/1.0',
  };
}

/** Re-evaluate a freshly drawn boundary inside a repair workspace. */
export function analyzeRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  kind: 'text' | 'mojibake',
  params: AnalysisParams,
): SegmentAnalysis {
  return summarizeSegment(
    { start, end, kind, hypothesis: 'utf-8', tileCount: 1, score: 0 },
    bytes,
    params,
  );
}

/** Recompute boundary reviews for an arbitrary list of segments. */
export function reviewState(
  segments: { id: string; start: number; end: number; kind: 'text' | 'mojibake'; candidates: Candidate[]; suggestedCandidateId: string; confidence: number; status: SegmentStatus; reasons: string[] }[],
  bytes?: Uint8Array,
): BoundaryReview[] {
  const pairs = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const boundary = segments[i].end;
    pairs.push({
      boundary,
      left: segments[i] as SegmentAnalysis,
      right: segments[i + 1] as SegmentAnalysis,
      rawWindow: bytes
        ? {
            left: bytes.subarray(Math.max(0, boundary - 32), boundary),
            right: bytes.subarray(boundary, Math.min(bytes.length, boundary + 32)),
          }
        : undefined,
    });
  }
  const hasMixed = new Set(segments.map((s) => s.candidates.find((c) => c.id === s.suggestedCandidateId)?.encoding)).size > 1;
  return evaluateBoundaries(pairs, { hasMixedEncodings: hasMixed }).reviews;
}
