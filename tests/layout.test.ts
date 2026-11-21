import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../src/lib/analysis/analyze';
import { DEFAULT_PARAMS } from '../src/lib/encoding/specs';
import { sampleBytes } from './setup';
import {
  adjudicateQueueItem,
  parseLayoutDocument,
  buildPages,
  geometricOrder,
  linearOrder,
  referenceSegmentsFromAnalysis,
  runLayout,
  structureTextFromSegments,
} from '../src/lib/layout';
import { findBareNumbers } from '../src/lib/layout/fields';
import { buildReference } from '../src/lib/layout/aligner';
import {
  adjudicateLayoutReview,
  buildVersion,
  createInitialState,
  recropLayoutAnchor,
  replayOps,
  selectCandidate,
  summarizeVersion,
} from '../src/lib/repair';
import { exportVersion } from '../src/lib/export';
import { sha256Hex } from '../src/lib/util/sha256';
import type { AnalysisBundle, ImportRecord, LayoutModel, RepairVersion } from '../src/types';

const NOW = '2026-01-01T00:00:00.000Z';

function analyzeLayout(name = 'layout-complex-page.txt'): AnalysisBundle {
  const bytes = sampleBytes(name);
  return runAnalysis({ bytes, digest: sha256Hex(bytes), params: DEFAULT_PARAMS, now: NOW });
}

function layoutOf(bundle: AnalysisBundle): LayoutModel {
  if (!bundle.layout) throw new Error('bundle.layout 缺失');
  return bundle.layout;
}

describe('page parser', () => {
  it('keeps page number, block geometry, direction and an image digest', () => {
    const model = layoutOf(analyzeLayout());
    expect(model.pages).toHaveLength(1);
    const page = model.pages[0];
    expect(page.pageNumber).toBe(1);
    expect(page.direction).toBe('ltr');
    expect(page.pageSize).toEqual({ width: 800, height: 1120 });
    expect(page.columnGutters).toEqual([400]);
    const table = page.blocks.find((b) => b.id === 'B4')!;
    expect(table.role).toBe('table');
    expect(table.rect).toEqual({ x: 60, y: 372, width: 680, height: 150 });
    expect(table.imageDigest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(table.imageDigest.thumbnail).toHaveLength(64);
    expect(table.imageDigest.meanLuminance).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: identical geometry+text yields identical digests', () => {
    const bytes = sampleBytes('layout-complex-page.txt');
    const text = new TextDecoder().decode(bytes);
    const parsed = parseLayoutDocument(text);
    const a = buildPages(parsed, 'geometric');
    const b = buildPages(parsed, 'geometric');
    expect(a[0].blocks[0].imageDigest.sha256).toBe(b[0].blocks[0].imageDigest.sha256);
    expect(a[0].imageDigest.sha256).toBe(b[0].imageDigest.sha256);
  });

  it('falls back to one page/block for a plain (non-annotated) document', () => {
    const bytes = sampleBytes('big5-monograph.txt');
    const bundle = runAnalysis({ bytes, digest: 'x', params: DEFAULT_PARAMS, now: NOW });
    const model = layoutOf(bundle);
    expect(model.pages.length).toBeGreaterThanOrEqual(1);
    expect(model.pages[0].blocks.length).toBeGreaterThanOrEqual(1);
    expect(model.ocrLines.length).toBeGreaterThan(0);
  });
});

describe('reading order: linear vs geometric', () => {
  it('linear scan interleaves the right column before the left column finishes', () => {
    const bytes = sampleBytes('layout-complex-page.txt');
    const parsed = parseLayoutDocument(new TextDecoder().decode(bytes));
    const linear = buildPages(parsed, 'linear')[0].blocks;
    const geometric = buildPages(parsed, 'geometric')[0].blocks;
    const linearIds = linear.map((b) => b.id);
    const geometricIds = geometric.map((b) => b.id);
    // B6 (right column, y=104) is pulled ahead of B3 (left column, y=138)
    // under the naive top-to-bottom rule.
    expect(linearIds.indexOf('B6')).toBeLessThan(linearIds.indexOf('B3'));
    // Geometric ordering finishes the left column (B2,B3) before B6.
    expect(geometricIds.indexOf('B3')).toBeLessThan(geometricIds.indexOf('B6'));
    expect(geometricIds.indexOf('B2')).toBeLessThan(geometricIds.indexOf('B6'));
    // Predecessor/successor links are maintained only in the geometric model.
    const b3 = geometric.find((b) => b.id === 'B3')!;
    expect(b3.nextBlockId).toBe('B6');
  });

  it('exposes both ordering helpers directly', () => {
    const blocks = [
      { id: 'a', rect: { x: 420, y: 10, width: 10, height: 10 } },
      { id: 'b', rect: { x: 60, y: 20, width: 10, height: 10 } },
    ];
    expect(linearOrder(blocks)).toEqual(['a', 'b']);
    expect(
      geometricOrder(
        blocks.map((b) => ({ ...b, spansColumns: false })),
        [400],
      ),
    ).toEqual(['b', 'a']);
  });
});

describe('OCR line alignment', () => {
  it('stops competing duplicate rows at overlap review instead of snapping', () => {
    const model = layoutOf(analyzeLayout());
    const l5 = model.alignments.find((a) => a.ocrLineId === 'L5')!;
    const dup = model.alignments.find((a) => a.ocrLineId === 'L5dup')!;
    expect(l5.status).toBe('ambiguous-overlap');
    expect(dup.status).toBe('ambiguous-overlap');
    expect(l5.competingLineIds).toContain('L5dup');
    expect(model.ocrLines.find((l) => l.id === 'L5dup')!.duplicateOf).toBe('L5');
  });

  it('stops a gutter-crossing line with no spanning parent at column review', () => {
    const model = layoutOf(analyzeLayout());
    const l20 = model.alignments.find((a) => a.ocrLineId === 'L20')!;
    expect(l20.status).toBe('spans-columns');
  });

  it('aligns table/footnote rows to their full-width spanning blocks', () => {
    const model = layoutOf(analyzeLayout());
    for (const id of ['L6', 'L7', 'L9', 'L17']) {
      const a = model.alignments.find((x) => x.ocrLineId === id)!;
      expect(a.status).toBe('aligned');
    }
  });

  it('flags two distinct OCR rows contending for one image region', () => {
    const model = layoutOf(analyzeLayout());
    const l18 = model.alignments.find((a) => a.ocrLineId === 'L18')!;
    const l19 = model.alignments.find((a) => a.ocrLineId === 'L19')!;
    expect(l18.status).toBe('ambiguous-overlap');
    expect(l19.status).toBe('ambiguous-overlap');
    expect(l18.competingLineIds).toContain('L19');
  });

  it('maps every aligned line to an absolute repaired byte range and segment', () => {
    const model = layoutOf(analyzeLayout());
    const aligned = model.alignments.filter((a) => a.status === 'aligned');
    expect(aligned.length).toBeGreaterThan(0);
    for (const a of aligned) {
      expect(a.byteRange[1]).toBeGreaterThan(a.byteRange[0]);
      expect(a.segmentId).toBeTruthy();
    }
  });
});

describe('key field extraction', () => {
  it('extracts dosage only with an attached unit and a backing region', () => {
    const model = layoutOf(analyzeLayout());
    const dosage = model.fields.find((f) => f.kind === 'dosage' && f.text.includes('10 mg'))!;
    expect(dosage).toBeDefined();
    expect(dosage.numericValue).toBe(10);
    expect(dosage.unit).toBe('mg');
    expect(dosage.blockId).toBeTruthy();
    expect(dosage.pageNumber).toBe(1);
    expect(dosage.adjacentText.length).toBeGreaterThan(0);
  });

  it('extracts frequency, unit, negation and population fields', () => {
    const model = layoutOf(analyzeLayout());
    expect(model.fields.some((f) => f.kind === 'frequency' && f.text.includes('每日一次'))).toBe(true);
    expect(model.fields.some((f) => f.kind === 'unit' && f.text === '片')).toBe(true);
    expect(model.fields.some((f) => f.kind === 'contraindication-negation' && f.text.includes('不得'))).toBe(true);
    expect(model.fields.some((f) => f.kind === 'population' && f.text.includes('儿童'))).toBe(true);
  });

  it('never promotes a bare number to a dosage', () => {
    const bundle = analyzeLayout();
    const model = layoutOf(bundle);
    // The "见3类人群" number 3 has no unit: it must not appear as a dosage.
    expect(model.fields.filter((f) => f.kind === 'dosage').every((f) => f.unit !== null)).toBe(true);
    expect(model.fields.some((f) => f.kind === 'dosage' && f.numericValue === 3 && f.unit === null)).toBe(false);
    // It is reported separately as a bare-number issue, not silently dropped.
    expect(model.issues.some((i) => i.code === 'bare-number-dosage')).toBe(true);
  });

  it('findBareNumbers ignores directive coordinates outside OCR lines', () => {
    const bundle = analyzeLayout();
    const segs = referenceSegmentsFromAnalysis(bundle.segmented.segments);
    const ref = buildReference(segs);
    const bare = findBareNumbers(ref);
    // Every reported bare number must be content text, never an @@block/@@ocr
    // coordinate line.
    for (const b of bare) {
      expect(b.sentence).not.toContain('@@');
    }
  });
});

describe('consistency checker', () => {
  it('refuses to join a negation and a dosage coming from different sections', () => {
    const model = layoutOf(analyzeLayout());
    const cross = model.issues.filter((i) => i.code === 'cross-section-negation');
    expect(cross.length).toBeGreaterThan(0);
    expect(cross.every((i) => i.severity === 'high')).toBe(true);
    const evidence = cross.flatMap((i) => i.evidence).join(' ');
    expect(evidence).toContain('禁忌');
    expect(evidence).toContain('用法用量');
    const neg = model.fields.find((f) => f.text.includes('不得用于肌内注射'))!;
    expect(neg.status).not.toBe('verified');
  });

  it('flags a dosage sitting inside a footnote block', () => {
    const model = layoutOf(analyzeLayout());
    const issue = model.issues.find((i) => i.code === 'footnote-dosage')!;
    expect(issue.severity).toBe('high');
    const field = model.fields.find((f) => f.id === issue.fieldId)!;
    expect(field.status).not.toBe('verified');
  });

  it('admits only high-risk localizations to the review queue', () => {
    const model = layoutOf(analyzeLayout());
    expect(model.reviewQueue.length).toBeGreaterThan(0);
    expect(model.reviewQueue.every((q) => q.severity === 'high')).toBe(true);
    // Medium-severity signals (duplicate row, bare number) never enqueue.
    const queuedIssueIds = new Set(model.reviewQueue.flatMap((q) => q.issueIds));
    for (const i of model.issues.filter((x) => x.severity !== 'high')) {
      expect(queuedIssueIds.has(i.id)).toBe(false);
    }
  });
});

describe('anchor re-crop', () => {
  it('revalidates fields against the new anchor and marks them stale', () => {
    const bundle = analyzeLayout();
    const state = createInitialState(bundle, 'segmented');
    const before = state.layout!;
    const l1FieldBefore = before.fields.find((f) => f.ocrLineId === 'L1' && f.kind === 'dosage')!;
    expect(l1FieldBefore.blockId).toBe('B3');
    const result = recropLayoutAnchor(state, {
      pageId: 'page-1',
      blockId: 'B3',
      newRect: { x: 60, y: 138, width: 290, height: 210 },
      note: '人工重新裁剪左栏边界',
      versionId: 'v-test',
      seq: 2,
      now: NOW,
    });
    const after = result.state.layout!;
    expect(after.anchorRevisions).toHaveLength(1);
    const revision = after.anchorRevisions[0];
    expect(revision.oldRect.width).toBe(300);
    expect(revision.newRect.width).toBe(290);
    expect(revision.oldImageDigest.sha256).not.toBe(revision.newImageDigest.sha256);
    expect(after.issues.some((i) => i.code === 'anchor-stale')).toBe(true);
  });

  it('keeps an old confirmation as history and returns the item to the queue', () => {
    const bundle = analyzeLayout();
    let state = createInitialState(bundle, 'segmented');
    const queueId = state.layout!.reviewQueue.find((q) => q.blockId === 'B8')!.id;
    const adjudicated = adjudicateLayoutReview(state, queueId, 'confirmed', '人工核对扫描行 A', 'v-test', NOW);
    state = adjudicated.state;
    expect(state.layout!.reviewQueue.find((q) => q.id === queueId)!.status).toBe('confirmed');

    const result = recropLayoutAnchor(state, {
      pageId: 'page-1',
      blockId: 'B8',
      newRect: { x: 60, y: 640, width: 680, height: 110 },
      note: '重新裁剪跨栏段落',
      versionId: 'v-test2',
      seq: 3,
      now: NOW,
    });
    const after = result.state.layout!;
    const reopened = after.reviewQueue.find((q) => q.id === queueId)!;
    expect(reopened.status).toBe('queued');
    const revision = after.anchorRevisions[after.anchorRevisions.length - 1];
    expect(revision.priorDecisions.some((d) => d.queueId === queueId && d.decision === 'confirmed')).toBe(true);
    expect(revision.invalidatedQueueIds).toContain(queueId);
    // The historical adjudication itself is retained append-only.
    expect(after.adjudications[queueId]?.note).toBe('人工核对扫描行 A');
  });

  it('replays recrop and adjudication operations deterministically', () => {
    const bundle = analyzeLayout();
    const initial = createInitialState(bundle, 'segmented');
    const queueId = initial.layout!.reviewQueue[0].id;
    const r1 = adjudicateLayoutReview(initial, queueId, 'rejected', '回放驳回', 'v2', NOW);
    const r2 = recropLayoutAnchor(r1.state, {
      pageId: 'page-1',
      blockId: 'B3',
      newRect: { x: 60, y: 138, width: 280, height: 200 },
      note: '回放裁剪',
      versionId: 'v3',
      seq: 3,
      now: NOW,
    });
    const replayed = replayOps(initial, [r1.op, r2.op], DEFAULT_PARAMS);
    expect(replayed.layout!.reviewQueue.find((q) => q.id === queueId)?.status).toBe('rejected');
    expect(replayed.layout!.anchorRevisions).toHaveLength(1);
    expect(replayed.layout!.anchorRevisions[0].newRect.width).toBe(280);
  });

  it('keeps anchor history when a candidate is re-selected after a re-crop', () => {
    const bundle = analyzeLayout();
    const state = createInitialState(bundle, 'segmented');
    const recropped = recropLayoutAnchor(state, {
      pageId: 'page-1',
      blockId: 'B3',
      newRect: { x: 60, y: 138, width: 285, height: 205 },
      note: '先裁剪',
      versionId: 'v2',
      seq: 2,
      now: NOW,
    }).state;
    expect(recropped.layout!.anchorRevisions).toHaveLength(1);

    // A later candidate switch re-assembles the layout model; the anchor
    // revision captured above must survive rather than be overwritten.
    const seg = recropped.segments[0];
    const alternative = seg.candidates.find((c) => c.id !== seg.selectedCandidateId);
    if (alternative) {
      const switched = selectCandidate(recropped, seg.id, alternative.id);
      expect(switched.layout!.anchorRevisions).toHaveLength(1);
      expect(switched.layout!.anchorRevisions[0].newRect.width).toBe(285);
    }
  });
});

describe('review queue and version summary', () => {
  it('counts open layout reviews as blocking work', () => {
    const bundle = analyzeLayout();
    const state = createInitialState(bundle, 'segmented');
    const summary = summarizeVersion({ state } as RepairVersion);
    expect(summary.layoutQueueOpen).toBeGreaterThan(0);
    expect(summary.blockingReasons.join(' ')).toContain('版面定位');
  });

  it('clears a queue item through the engine adjudicator', () => {
    const bundle = analyzeLayout();
    const model = layoutOf(bundle);
    const target = model.reviewQueue[0];
    const decided = adjudicateQueueItem(model, target.id, 'confirmed', '核对无误', 'v1', NOW);
    expect(decided.reviewQueue.find((q) => q.id === target.id)!.status).toBe('confirmed');
    expect(decided.metrics.reviewQueueSize).toBe(model.reviewQueue.length - 1);
  });
});

describe('end-to-end model shape', () => {
  it('exposes page localization, field evidence and review status together', () => {
    const model = layoutOf(analyzeLayout());
    expect(model.schema).toBe('bytelab-layout/1');
    expect(model.metrics.twoColumnPages).toBe(1);
    expect(model.metrics.tableBlocks).toBeGreaterThan(0);
    expect(model.metrics.footnoteBlocks).toBeGreaterThan(0);
    expect(model.metrics.duplicateOcrLines).toBe(1);
    expect(model.metrics.spanningLines).toBe(1);
    // Every field can trace back to a page region or is explicitly at-risk.
    for (const f of model.fields) {
      if (f.status === 'verified') {
        expect(f.blockId).toBeTruthy();
        expect(f.pageId).toBeTruthy();
      }
    }
  });

  it('rebuilds an equivalent model through the public runLayout entry point', () => {
    const bundle = analyzeLayout();
    const segs = referenceSegmentsFromAnalysis(bundle.segmented.segments);
    const model = runLayout({
      text: structureTextFromSegments(segs),
      segments: segs,
      ordering: 'geometric',
      now: NOW,
    });
    expect(model.pages).toHaveLength(1);
    expect(model.alignments.length).toBe(bundle.layout!.alignments.length);
    expect(model.ocrLines).toHaveLength(bundle.layout!.ocrLines.length);
  });
});

describe('layout export evidence', () => {
  const exportRecord = (bundle: AnalysisBundle): ImportRecord => ({
    id: 'imp-layout',
    digest: bundle.digest,
    byteLength: bundle.byteLength,
    primaryFileName: 'layout-complex-page.txt',
    firstMarket: 'CN',
    createdAt: NOW,
    updatedAt: NOW,
    sources: [
      {
        id: 'src-layout',
        fileName: 'layout-complex-page.txt',
        market: 'CN',
        receivedFrom: 'scan',
        receivedAt: NOW,
        importedAt: NOW,
        note: '',
      },
    ],
    note: '',
  });

  function buildRepairVersion(bundle: AnalysisBundle): RepairVersion {
    const state = createInitialState(bundle, 'segmented');
    return buildVersion({
      importId: 'imp-layout',
      digest: bundle.digest,
      runId: 'run-1',
      parent: null,
      strategy: 'segmented',
      state,
      op: { type: 'create', strategy: 'segmented', summary: '版面定位测试' },
      name: 'v1 版面定位',
    }, NOW);
  }

  it('includes page localization, field evidence and review status in the manifest', () => {
    const bundle = analyzeLayout();
    const version = buildRepairVersion(bundle);
    const exported = exportVersion(version, exportRecord(bundle), sampleBytes('layout-complex-page.txt'));
    const manifest = JSON.parse(exported.manifestText);
    expect(manifest.layout).toBeTruthy();
    expect(manifest.layout.schema).toBe('bytelab-layout/1');
    expect(manifest.layout.pages[0].blocks.length).toBeGreaterThan(0);
    expect(manifest.layout.alignments.length).toBeGreaterThan(0);
    expect(manifest.layout.fields.length).toBeGreaterThan(0);
    // Block coordinates and image digest are preserved.
    const table = manifest.layout.pages[0].blocks.find((b: { id: string }) => b.id === 'B4');
    expect(table.rect).toEqual({ x: 60, y: 372, width: 680, height: 150 });
    expect(table.imageDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    // Only high-risk items are in the queue.
    expect(manifest.layout.reviewQueue.every((q: { severity: string }) => q.severity === 'high')).toBe(true);
  });

  it('writes a layout.json and a layout section in evidence.md', () => {
    const bundle = analyzeLayout();
    const version = buildRepairVersion(bundle);
    const exported = exportVersion(version, exportRecord(bundle), sampleBytes('layout-complex-page.txt'));
    expect(exported.evidenceText).toContain('版面锚点与关键字段定位');
    expect(exported.evidenceText).toContain('字段证据');
    expect(exported.evidenceText).toContain('高风险复核与锚点修订');
    expect(exported.readmeText).toContain('layout.json');
    // The zip must contain the extra layout evidence file (filename is stored
    // uncompressed in the zip local header).
    const zipText = new TextDecoder().decode(exported.zip);
    expect(zipText).toContain('layout.json');
  });

  it('keeps the export reproducible across runs', () => {
    const bundle = analyzeLayout();
    const record = exportRecord(bundle);
    const raw = sampleBytes('layout-complex-page.txt');
    const version = buildRepairVersion(bundle);
    const a = exportVersion(version, record, raw);
    const b = exportVersion(version, record, raw);
    expect(a.zipHash).toBe(b.zipHash);
    expect(a.manifestHash).toBe(b.manifestHash);
  });
});
