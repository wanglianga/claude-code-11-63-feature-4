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
  /** Layout block ordering: geometric constraints or naive linear scan. */
  layoutOrdering: OrderingMode;
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
  /** Layout anchors, OCR alignment and key-field evidence for this document. */
  layout: LayoutModel | null;
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
  kind:
    | 'boundary-move'
    | 'segment-reselect'
    | 'symbol-resolution'
    | 'symbol-cleared'
    | 'anchor-recrop'
    | 'field-adjudication'
    | 'layout-review';
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
  /**
   * Layout snapshot for this repair version. Mutations (re-crop, layout review
   * adjudication) clone the model so every version keeps the evidence it was
   * decided against. Anchor revisions live on the model itself as the single
   * source of truth.
   */
  layout: LayoutModel | null;
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
    }
  | {
      type: 'recrop-anchor';
      pageId: string;
      blockId: string;
      revisionId: string;
      newRect: Rect;
      oldImageDigest: string;
      newImageDigest: string;
      superseded: SupersededEntry[];
      note: string;
    }
  | {
      type: 'adjudicate-layout-review';
      queueId: string;
      decision: 'confirmed' | 'rejected';
      note: string;
      previous: LayoutAdjudication | null;
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

/* ======================================================================== */
/* Layout anchors & key-field localization                                  */
/*                                                                          */
/* OCR line order need not match the visual reading order: two-column       */
/* layouts, footnotes and tables can move dosage numbers, units or negation */
/* words into neighbouring sentences. These types model a *layout layer*    */
/* that sits beside the byte-level repair model: pages → blocks with        */
/* geometry → OCR lines aligned to repaired byte ranges → key fields with   */
/* region evidence → consistency checks → a high-risk-only review queue.    */
/* All types are structured-clone friendly (worker + IndexedDB).           */
/* ======================================================================== */

/** Reading direction recorded by the page parser. */
export type ReadingDirection = 'ltr' | 'rtl' | 'ttb';

/** How the parser ordered the blocks. */
export type OrderingMode = 'linear' | 'geometric';

/** Semantic role of a layout block, used for section-attribution checks. */
export type BlockRole =
  | 'title'
  | 'heading'
  | 'paragraph'
  | 'column'
  | 'table'
  | 'table-row'
  | 'table-cell'
  | 'footnote'
  | 'caption'
  | 'header'
  | 'footer'
  | 'unknown';

/** Rectangle in page pixels (origin top-left). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Deterministic perceptual summary of the page/region image. The tool never
 * stores page images inside the browser database; this digest plus the
 * geometry is enough to detect that a user re-cropped a region.
 */
export interface ImageDigest {
  /** SHA-256 over the normalized pixel summary rows. */
  sha256: string;
  /** Number of summary cells the hash was computed from. */
  cells: number;
  /** Average luminance 0..1, kept as a cheap human-readable check. */
  meanLuminance: number;
  /** Coarse 8x8 luminance grid (row-major, 0..255). */
  thumbnail: number[];
  /** Width/height of the source region in pixels. */
  sourceWidth: number;
  sourceHeight: number;
}

/** A layout block: page number, geometry, direction and image summary. */
export interface LayoutBlock {
  id: string;
  pageId: string;
  /** 1-based printed page number. */
  pageNumber: number;
  role: BlockRole;
  /** Heading text when the block is (or belongs under) a section heading. */
  section: string;
  /** Section identifier shared by blocks under the same 【…】 heading. */
  sectionId: string;
  rect: Rect;
  /** 0-based column index when the parser detected multi-column flow. */
  column: number;
  direction: ReadingDirection;
  /** Reading-order index inside the page; differs between ordering modes. */
  order: number;
  imageDigest: ImageDigest;
  /** True when geometry spans more than one detected column. */
  spansColumns: boolean;
  /** Block ids geometrically constrained as predecessors/successors. */
  prevBlockId: string | null;
  nextBlockId: string | null;
}

export interface PageLayout {
  id: string;
  /** 1-based page number. */
  pageNumber: number;
  pageSize: { width: number; height: number };
  direction: ReadingDirection;
  blocks: LayoutBlock[];
  /** X coordinates treated as column gutters by the parser. */
  columnGutters: number[];
  imageDigest: ImageDigest;
  /** Ordering actually applied to `blocks[].order`. */
  ordering: OrderingMode;
}

/** One OCR text line with its page region and source confidence. */
export interface OcrLine {
  id: string;
  pageId: string;
  pageNumber: number;
  /** OCR-provided line geometry on the page. */
  rect: Rect;
  text: string;
  /** Raw OCR confidence 0..1. */
  ocrConfidence: number;
  /** Set when another OCR line has identical text (duplicate scan row). */
  duplicateOf: string | null;
}

export type AlignmentStatus =
  | 'aligned'
  | 'ambiguous-overlap'
  | 'spans-columns'
  | 'unplaced';

/**
 * Mapping of one OCR line (and the repaired byte range it corresponds to) to
 * candidate layout blocks. Multiple candidates with similar overlap stay
 * open as `ambiguous-overlap`; a line whose rect crosses a column gutter is
 * `spans-columns`. Nothing is force-snapped in those cases.
 */
export interface LineAlignment {
  id: string;
  ocrLineId: string;
  pageId: string;
  /** Absolute byte range in the source file this line was matched to. */
  byteRange: [number, number];
  /** Segment id owning those bytes in the repair state. */
  segmentId: string | null;
  /** Candidate block ids ordered by overlap score, best first. */
  candidateBlockIds: string[];
  /** Per-candidate overlap fraction of the OCR rect inside the block. */
  overlapScores: Record<string, number>;
  status: AlignmentStatus;
  /** Human-readable reasons for any non-aligned status. */
  flags: string[];
  /** Set when two OCR lines compete for the same image region. */
  competingLineIds: string[];
}

export type FieldKind =
  | 'dosage'
  | 'frequency'
  | 'unit'
  | 'contraindication-negation'
  | 'population';

export type FieldStatus = 'verified' | 'at-risk' | 'unplaced';

/**
 * A key field extracted from repaired text. A field is only accepted as a
 * dosage when the number is attached to a unit and backed by a page region;
 * a bare number in plain text is recorded as `at-risk` and never promoted.
 */
export interface FieldEvidence {
  id: string;
  kind: FieldKind;
  /** Matched surface text, e.g. "10 mg/kg" or "不得用于肌内注射". */
  text: string;
  /** Numeric value for dosage/frequency, null otherwise. */
  numericValue: number | null;
  /** Unit surface text when present ("mg", "mg/kg", "毫升", …). */
  unit: string | null;
  /** Absolute byte range of the match in the repaired stream. */
  byteRange: [number, number];
  /** OCR line that supplied the text. */
  ocrLineId: string | null;
  /** Block the OCR line aligned to (null when unplaced/ambiguous). */
  blockId: string | null;
  pageId: string | null;
  pageNumber: number | null;
  /** Section heading the field text sits under. */
  section: string;
  sectionId: string;
  /** Immediate neighbouring text window used by the consistency checker. */
  adjacentText: string;
  status: FieldStatus;
  reasons: string[];
}

export type IssueSeverity = 'high' | 'medium' | 'low';

export type ConsistencyIssueCode =
  | 'cross-section-negation'
  | 'field-region-mismatch'
  | 'bare-number-dosage'
  | 'duplicate-ocr-line'
  | 'line-region-contention'
  | 'line-spans-columns'
  | 'footnote-dosage'
  | 'table-cell-drift'
  | 'anchor-stale';

export interface ConsistencyIssue {
  id: string;
  code: ConsistencyIssueCode;
  severity: IssueSeverity;
  fieldId: string | null;
  alignmentId: string | null;
  blockId: string | null;
  pageNumber: number | null;
  message: string;
  /** Evidence snippets quoted from distinct blocks/sections. */
  evidence: string[];
}

/** A queue entry — only high-risk localizations are enqueued. */
export interface LayoutReviewItem {
  id: string;
  severity: IssueSeverity;
  issueIds: string[];
  fieldId: string | null;
  alignmentId: string | null;
  pageId: string | null;
  blockId: string | null;
  status: 'queued' | 'confirmed' | 'rejected';
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string;
  /** Image digest the queue item was raised against. */
  imageDigestSha: string | null;
}

export interface LayoutAdjudication {
  queueId: string;
  decision: 'confirmed' | 'rejected';
  note: string;
  versionId: string;
  at: string;
  imageDigestSha: string | null;
}

/**
 * A user re-crop of a page region. The old confirmation is retained as
 * historical evidence; every alignment/field touching the new geometry must
 * be re-validated and cannot silently keep its old status.
 */
export interface AnchorRevision {
  id: string;
  pageId: string;
  blockId: string;
  /** Old/new geometry and image summaries. */
  oldRect: Rect;
  newRect: Rect;
  oldImageDigest: ImageDigest;
  newImageDigest: ImageDigest;
  note: string;
  createdAt: string;
  versionId: string;
  /** Queue items whose prior confirmation was invalidated by this recrop. */
  invalidatedQueueIds: string[];
  /** Prior human decisions retained as historical evidence (not re-applied). */
  priorDecisions: Array<{
    queueId: string;
    decision: 'confirmed' | 'rejected';
    note: string;
    at: string;
  }>;
}

/** Everything the layout layer produces for one document. */
export interface LayoutModel {
  schema: 'bytelab-layout/1';
  engine: string;
  createdAt: string;
  ordering: OrderingMode;
  pages: PageLayout[];
  ocrLines: OcrLine[];
  alignments: LineAlignment[];
  fields: FieldEvidence[];
  issues: ConsistencyIssue[];
  reviewQueue: LayoutReviewItem[];
  /** Map of queueId → adjudication, mirrored into RepairState on save. */
  adjudications: Record<string, LayoutAdjudication>;
  anchorRevisions: AnchorRevision[];
  metrics: LayoutMetrics;
}

export interface LayoutMetrics {
  pageCount: number;
  blockCount: number;
  ocrLineCount: number;
  duplicateOcrLines: number;
  alignedLines: number;
  ambiguousLines: number;
  spanningLines: number;
  unplacedLines: number;
  fieldCount: number;
  fieldsAtRisk: number;
  highRiskIssues: number;
  reviewQueueSize: number;
  twoColumnPages: number;
  tableBlocks: number;
  footnoteBlocks: number;
}
