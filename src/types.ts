// Shared domain types for the ByteLab label workspace.
// Everything here must be structured-clone friendly: it crosses the
// WebWorker boundary and is persisted into IndexedDB as-is.

export type EncodingId =
  | 'utf-8'
  | 'gb18030'
  | 'big5'
  | 'windows-1252'
  | 'iso-8859-1'
  | 'utf-16le'
  | 'utf-16be';

export type AnomalyKind =
  | 'invalid-byte'
  | 'truncated-sequence'
  | 'unassigned-sequence'
  | 'unpaired-surrogate'
  | 'odd-length';

export interface Glyph {
  /** Decoded text. Empty string for an anomaly glyph. */
  text: string;
  /** Absolute offset in the original file. */
  start: number;
  end: number;
  anomaly?: AnomalyKind;
  detail?: string;
  /** Decoded but semantically doubtful (controls, private use, U+FFFD). */
  suspicious?: boolean;
}

export type ChainStepKind = 'decode' | 'encode';

export interface ChainStep {
  kind: ChainStepKind;
  encoding: EncodingId;
}

export interface UnresolvedSymbol {
  /** Stable id derived from the byte range, e.g. "symbol@12-14". */
  id: string;
  start: number;
  end: number;
  bytesHex: string;
  reason: string;
}

export interface CandidateScore {
  score: number;
  anomalyRatio: number;
  anomalyBytes: number;
  suspiciousRatio: number;
  mojibakeMarkerCount: number;
  goodRatio: number;
  lexiconHits: string[];
  relativeLexiconBonus: number;
  layerPenalty: number;
  /** Gap to the next distinct candidate's score; drives the ambiguity gate. */
  marginToRunnerUp?: number;
  notes: string[];
}

export interface Candidate {
  id: string;
  label: string;
  kind: 'direct' | 'repair';
  chain: ChainStep[];
  /** Final decoding encoding (used to interpret the candidate text). */
  encoding: EncodingId;
  outerEncoding?: EncodingId;
  pivotEncoding?: EncodingId;
  glyphs: Glyph[];
  /** Human readable text with ⟦81 20⟧ placeholders for unresolved runs. */
  text: string;
  unresolved: UnresolvedSymbol[];
  score: CandidateScore;
  /** True when re-encoding every glyph reproduces the source bytes exactly. */
  byteExact: boolean;
  byteExactNote?: string;
}

export type SegmentStatus = 'confident' | 'suggested' | 'pending';

export interface SegmentAnalysis {
  id: string;
  start: number;
  end: number;
  kind: 'text' | 'mojibake';
  candidates: Candidate[];
  /** Best candidate according to score, even when pending. */
  suggestedCandidateId: string;
  /** Best score; kept even for pending segments for display. */
  confidence: number;
  margin: number;
  status: SegmentStatus;
  reasons: string[];
  anomalyBytes: number;
  suspiciousGlyphs: number;
  /** Detected encoding label of the winning direct decode. */
  detectedEncoding: EncodingId | null;
  /** Status/confidence before any boundary cap (analysis-only view). */
  baseConfidence?: number;
  baseStatus?: SegmentStatus;
}

export type BoundarySeverity = 'high' | 'medium' | 'low';

export interface BoundaryReview {
  id: string;
  boundary: number;
  leftSegmentId: string;
  rightSegmentId: string;
  severity: BoundarySeverity;
  flags: string[];
  detail: string;
  combinedConfidence: number;
  leftTail: string;
  rightHead: string;
  /** Explicit human acknowledgement; never set automatically. */
  acknowledged: boolean;
  acknowledgedNote: string;
  acknowledgedVersionId: string | null;
}

export interface StrategyMetrics {
  segmentCount: number;
  distinctCandidates: number;
  distinctEncodings: number;
  mojibakeSegments: number;
  anomalyBytes: number;
  unresolvedSymbols: number;
  suspiciousGlyphs: number;
  pendingSegments: number;
  suggestedSegments: number;
  boundaryHighRisk: number;
  boundaryMediumRisk: number;
  meanConfidence: number;
  reviewLoad: number;
  retainedMixedEncoding: boolean;
}

export interface StrategyResult {
  strategy: 'uniform' | 'segmented';
  segments: SegmentAnalysis[];
  boundaryReviews: BoundaryReview[];
  metrics: StrategyMetrics;
  elapsedMs: number;
  notes: string[];
}

export interface AnalysisParams {
  enabledEncodings: EncodingId[];
  tileBytes: number;
  minSegmentBytes: number;
  mojibakeRunMinGlyphs: number;
  confidenceThreshold: number;
  marginThreshold: number;
  maxCandidatesPerSegment: number;
  includeUtf16: boolean;
}

export interface StrategyComparisonRow {
  metric: string;
  uniform: string;
  segmented: string;
  hint: string;
}

export interface AnalysisBundle {
  digest: string;
  byteLength: number;
  params: AnalysisParams;
  uniform: StrategyResult;
  segmented: StrategyResult;
  recommendedStrategy: 'uniform' | 'segmented';
  recommendationRationale: string[];
  comparisonRows: StrategyComparisonRow[];
  createdAt: string;
  engine: string;
}

/* ------------------------------- imports -------------------------------- */

export interface SourceRecord {
  id: string;
  fileName: string;
  market: string;
  receivedFrom: string;
  receivedAt: string;
  importedAt: string;
  note: string;
}

export interface ImportRecord {
  id: string;
  digest: string;
  byteLength: number;
  primaryFileName: string;
  firstMarket: string;
  createdAt: string;
  updatedAt: string;
  sources: SourceRecord[];
  note: string;
}

export interface ImportStats {
  uniqueFiles: number;
  totalSources: number;
  mergedImports: number;
  totalBytes: number;
}

export interface ImportInput {
  bytes: Uint8Array;
  fileName: string;
  market: string;
  receivedFrom: string;
  receivedAt: string;
  note?: string;
}

export interface ImportOutcome {
  importId: string;
  digest: string;
  merged: boolean;
  sourceFileName: string;
  /** Total sources after the operation. */
  sourceCount: number;
  import: ImportRecord;
}

/* ------------------------------ analysis run ----------------------------- */

export interface AnalysisRun {
  id: string;
  importId: string;
  digest: string;
  bundle: AnalysisBundle;
  createdAt: string;
}

/* ---------------------------- repair versions ---------------------------- */

export interface SymbolResolution {
  symbolId: string;
  start: number;
  end: number;
  text: string;
  note: string;
  versionId: string;
  decidedAt: string;
}

export interface NoteEntry {
  id: string;
  target: string;
  text: string;
  createdAt: string;
  versionId: string;
}

export interface SegmentState {
  id: string;
  start: number;
  end: number;
  kind: 'text' | 'mojibake';
  candidates: Candidate[];
  selectedCandidateId: string | null;
  suggestedCandidateId: string | null;
  /** Confidence carried from analysis. */
  analysisConfidence: number;
  /** Effective confidence after boundary effects. */
  confidence: number;
  analysisStatus: SegmentStatus;
  /** Effective status after boundary effects. */
  status: SegmentStatus;
  /** Confidence/status before any boundary cap, to restore on acknowledgement. */
  baseConfidence: number;
  baseStatus: SegmentStatus;
  reasons: string[];
  boundaryRiskIds: string[];
  stale: boolean;
}

export interface SupersededEntry {
  id: string;
  atVersionId: string;
  atSeq: number;
  kind: 'boundary-move' | 'segment-reselect' | 'symbol-resolution' | 'symbol-cleared';
  segmentRange: [number, number];
  segmentId: string;
  summary: string;
  oldCandidateLabel?: string;
  oldSymbolText?: string;
  oldStatus?: string;
  note: string;
}

export interface BoundaryAcknowledgement {
  reviewId: string;
  boundary: number;
  note: string;
  versionId: string;
  at: string;
}

export interface RepairState {
  boundaries: number[];
  segments: SegmentState[];
  symbolResolutions: Record<string, SymbolResolution>;
  notes: NoteEntry[];
  boundaryReviews: BoundaryReview[];
  boundaryAcknowledgements: Record<string, BoundaryAcknowledgement>;
  superseded: SupersededEntry[];
}

export interface AuditStep {
  index: number;
  op: VersionOp;
  description: string;
  /** Text concatenation digest before/after this op (truncated excerpt too). */
  textHashBefore: string;
  textHashAfter: string;
  excerptBefore: string;
  excerptAfter: string;
}

export type VersionOp =
  | {
      type: 'create';
      strategy: 'uniform' | 'segmented';
      summary: string;
    }
  | {
      type: 'select-candidate';
      segmentId: string;
      candidateId: string;
      previousCandidateId: string | null;
    }
  | {
      type: 'move-boundary';
      boundaryIndex: number;
      from: number;
      to: number;
      left: SegmentState;
      right: SegmentState;
      /** Segments replaced by the two rebuilt ones (for audit and replay). */
      replacedSegmentIds: string[];
      superseded: SupersededEntry[];
      note: string;
    }
  | {
      type: 'resolve-symbol';
      symbolId: string;
      text: string;
      note: string;
      previous: SymbolResolution | null;
      segmentId: string;
    }
  | {
      type: 'clear-symbol';
      symbolId: string;
      previous: SymbolResolution | null;
      segmentId: string;
    }
  | {
      type: 'acknowledge-boundary';
      reviewId: string;
      boundary: number;
      note: string;
      previous: BoundaryAcknowledgement | null;
    }
  | {
      type: 'add-note';
      target: string;
      text: string;
    };

export interface RepairVersion {
  id: string;
  importId: string;
  digest: string;
  runId: string;
  parentId: string | null;
  seq: number;
  name: string;
  createdAt: string;
  strategy: 'uniform' | 'segmented';
  state: RepairState;
  ops: VersionOp[];
  superseded: SupersededEntry[];
  audit: AuditStep[];
  /** SHA-256 over canonical JSON of the state (excluding this field). */
  stateHash: string;
}

export interface VerificationReport {
  digestMatches: boolean;
  recomputedDigest: string;
  stateHashMatches: boolean;
  segmentsCoverFile: boolean;
  boundaryIntegrity: string[];
  unresolvedCount: number;
  staleSegments: number;
  highRiskBoundaries: number;
  exportHash: string;
  exportHashReproducible: boolean;
}

export interface ExportBundle {
  fileNameBase: string;
  manifestText: string;
  repairedText: string;
  evidenceText: string;
  readmeText: string;
  zip: Uint8Array;
  manifestHash: string;
  zipHash: string;
}

export interface ExportOptions {
  includeOriginalBytes: boolean;
  unresolvedPlaceholderStyle: 'byte-escape' | 'question';
}
