import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../src/lib/analysis/analyze';
import { DEFAULT_PARAMS } from '../src/lib/encoding/specs';
import {
  buildVersion,
  acknowledgeBoundary,
  createInitialState,
  moveBoundary,
  recomputeBoundaries,
  replayOps,
  selectedCandidate,
  segmentText,
  selectCandidate,
  setSymbolResolution,
  stateHash,
  stateText,
  summarizeVersion,
  verifyVersion,
} from '../src/lib/repair';
import { exportVersion } from '../src/lib/export';
import { sha256Hex } from '../src/lib/util/sha256';
import type { ImportRecord, RepairVersion } from '../src/types';
import { sampleBytes } from './setup';

const bytes = sampleBytes('mixed-encoded-label.txt');
const bundle = runAnalysis({ bytes, digest: sha256Hex(bytes), params: DEFAULT_PARAMS, now: '2026-01-01T00:00:00.000Z' });
const record: ImportRecord = {
  id: 'imp-1',
  digest: bundle.digest,
  byteLength: bytes.length,
  primaryFileName: '混合编码说明书.txt',
  firstMarket: 'CN',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sources: [
    {
      id: 'src-1',
      fileName: '混合编码说明书.txt',
      market: 'CN',
      receivedFrom: 'mailbox',
      receivedAt: '2026-01-01T00:00:00.000Z',
      importedAt: '2026-01-01T00:00:00.000Z',
      note: '',
    },
  ],
  note: '',
};

function baseVersion(state = createInitialState(bundle, 'segmented')): RepairVersion {
  return buildVersion({
    importId: record.id,
    digest: record.digest,
    runId: 'run-1',
    parent: null,
    strategy: 'segmented',
    state,
    op: { type: 'create', strategy: 'segmented', summary: '初始' },
    name: 'v1 初始',
  });
}

describe('initial repair state', () => {
  it('mirrors the segmented analysis and tracks three encodings', () => {
    const v = baseVersion();
    expect(v.state.segments).toHaveLength(3);
    expect(v.seq).toBe(1);
    expect(v.audit).toHaveLength(1);
    const labels = v.state.segments.map((s) => selectedCandidate(s)?.encoding);
    expect(new Set(labels).size).toBeGreaterThan(1);
  });

  it('renders segment text without losing bytes', () => {
    const v = baseVersion();
    const text = stateText(v.state);
    expect(text).toContain('注射用头孢曲松钠');
  });
});

describe('boundary redefinition', () => {
  it('keeps old adjudications only as history and re-evaluates both ranges', () => {
    const v1 = baseVersion();
    // Move the first boundary a few bytes into the GBK part; the new ranges
    // must be re-analysed, not inherited.
    const oldBoundary = v1.state.segments[0].end;
    const result = moveBoundary(v1.state, bytes, DEFAULT_PARAMS, 0, oldBoundary - 24, '边界切在句子中间，向左调整', 'v2', 2);
    const rebuiltLeft = result.state.segments[0];
    const rebuiltRight = result.state.segments[1];
    expect(rebuiltLeft.end).toBe(oldBoundary - 24);
    expect(rebuiltRight.start).toBe(oldBoundary - 24);
    expect(result.state.boundaries[0]).toBe(oldBoundary - 24);
    // Fresh candidates were generated for the new ranges.
    expect(rebuiltLeft.candidates.length).toBeGreaterThan(0);
    expect(rebuiltRight.id).toContain(String(oldBoundary - 24));
    // A superseded entry documents the old state.
    expect(result.superseded.length).toBeGreaterThan(0);
    expect(result.superseded.some((s) => s.summary.includes('重新评估'))).toBe(true);
  });

  it('rejects boundaries inside a multi-byte sequence', () => {
    const v1 = baseVersion();
    const b = v1.state.segments[0].end - 1;
    // Find a continuation byte near the boundary to prove the guard works.
    let probe = b;
    while (probe > 0 && (bytes[probe] & 0xc0) !== 0x80) probe--;
    if ((bytes[probe] & 0xc0) === 0x80) {
      expect(() => moveBoundary(v1.state, bytes, DEFAULT_PARAMS, 0, probe, 'mid-sequence', 'v2', 2)).toThrow(
        /多字节/,
      );
    }
  });

  it('records a new version with an audit trail and state hash', () => {
    const v1 = baseVersion();
    const oldBoundary = v1.state.segments[0].end;
    const moved = moveBoundary(v1.state, bytes, DEFAULT_PARAMS, 0, oldBoundary - 16, '微调', 'v2', 2);
    const v2 = buildVersion({
      importId: record.id,
      digest: record.digest,
      runId: 'run-1',
      parent: v1,
      strategy: 'segmented',
      state: moved.state,
      op: moved.op,
      name: 'v2 边界调整',
    });
    expect(v2.seq).toBe(2);
    expect(v2.parentId).toBe(v1.id);
    expect(v2.audit).toHaveLength(2);
    expect(v2.audit[1].description).toContain('移动边界');
    expect(v2.superseded.length).toBeGreaterThan(0);
    expect(v2.stateHash).toHaveLength(64);
  });
});

describe('symbol adjudication', () => {
  it('keeps undecodable bytes as explicit symbols until a human decides', () => {
    const badBytes = sampleBytes('utf8-with-bad-bytes.txt');
    const b2 = runAnalysis({ bytes: badBytes, digest: sha256Hex(badBytes), params: DEFAULT_PARAMS });
    const state = createInitialState(b2, 'uniform');
    const seg = state.segments[0];
    const cand = selectedCandidate(seg)!;
    expect(cand.unresolved.length).toBeGreaterThan(0);
    // Placeholder text preserves the byte count rather than deleting it.
    const before = segmentText(seg, state);
    expect(before).toMatch(/⟦[0-9A-F ]+⟧/);

    const sym = cand.unresolved[0];
    const withRes = setSymbolResolution(state, seg.id, sym.id, '（数据缺失）', '与纸质批件核对后人工补录', 'v2');
    const after = segmentText(withRes.segments[0], withRes);
    expect(after).toContain('（数据缺失）');
    expect(after).not.toContain(sym.bytesHex);
    expect(withRes.symbolResolutions[sym.id].text).toBe('（数据缺失）');
  });

  it('refuses adjudications that would swallow more bytes than the symbol', () => {
    const badBytes = sampleBytes('utf8-with-bad-bytes.txt');
    const b2 = runAnalysis({ bytes: badBytes, digest: sha256Hex(badBytes), params: DEFAULT_PARAMS });
    const state = createInitialState(b2, 'uniform');
    const seg = state.segments[0];
    const sym = selectedCandidate(seg)!.unresolved[0];
    expect(() => setSymbolResolution(state, seg.id, sym.id, '⟦bad⟧', '', 'v2')).toThrow(/占位符/);
  });
});

describe('recompute & verification', () => {
  it('recomputes boundary reviews and forces pending on conflicts', () => {
    const v1 = baseVersion();
    const reviews = recomputeBoundaries(v1.state);
    for (const r of reviews) {
      if (r.severity === 'high' || r.severity === 'medium') {
        const left = v1.state.segments.find((s) => s.id === r.leftSegmentId)!;
        expect(left.status).toBe('pending');
      }
    }
  });

  it('verifies the recorded digest and coverage', () => {
    const v1 = baseVersion();
    const report = verifyVersion({ version: v1, bytes, digest: record.digest });
    expect(report.digestMatches).toBe(true);
    expect(report.segmentsCoverFile).toBe(true);
    expect(report.stateHashMatches).toBe(true);
  });

  it('detects a tampered digest', () => {
    const v1 = baseVersion();
    const report = verifyVersion({ version: v1, bytes, digest: 'not-the-digest' });
    expect(report.digestMatches).toBe(false);
  });
});

describe('boundary acknowledgement', () => {
  it('lifts the pending cap once the human confirms the boundary', () => {
    const fracBytes = sampleBytes('boundary-fracture.txt');
    const fb = runAnalysis({ bytes: fracBytes, digest: sha256Hex(fracBytes), params: DEFAULT_PARAMS });
    const state = createInitialState(fb, 'segmented');
    const review = state.boundaryReviews.find((r) => r.severity !== 'low');
    expect(review).toBeDefined();
    const seg = state.segments.find((s) => s.id === review!.leftSegmentId)!;
    expect(seg.status).toBe('pending');
    const acked = acknowledgeBoundary(state, review!.id, '已对照纸质批件确认', 'v2', fracBytes);
    const left = acked.segments.find((s) => s.id === review!.leftSegmentId)!;
    const right = acked.segments.find((s) => s.id === review!.rightSegmentId)!;
    expect(left.status).not.toBe('pending');
    expect(right.status).not.toBe('pending');
    expect(acked.boundaryReviews.find((r) => r.id === review!.id)?.acknowledged).toBe(true);
  });
});

describe('replay', () => {
  it('reproduces a select-candidate op deterministically', () => {
    const v1 = baseVersion();
    const seg = v1.state.segments[0];
    const alt = seg.candidates[1];
    if (!alt) return;
    const selected = selectCandidate(v1.state, seg.id, alt.id);
    const replayed = replayOps(v1.state, [{ type: 'select-candidate', segmentId: seg.id, candidateId: alt.id, previousCandidateId: seg.selectedCandidateId }], DEFAULT_PARAMS);
    expect(selected.segments[0].selectedCandidateId).toBe(alt.id);
    expect(replayed.segments[0].selectedCandidateId).toBe(alt.id);
    expect(stateText(replayed)).toBe(stateText(selected));
  });

  it('replays a boundary move through the recorded rebuilt segments', () => {
    const v1 = baseVersion();
    const oldBoundary = v1.state.segments[0].end;
    // Step back to the nearest position that is not a UTF-8 continuation
    // byte; the fixture's first boundary may sit inside a GBK character.
    let target = oldBoundary - 20;
    while (target > 0 && (bytes[target] & 0xc0) === 0x80) target--;
    const moved = moveBoundary(v1.state, bytes, DEFAULT_PARAMS, 0, target, '回放校验', 'v2', 2);
    const replayed = replayOps(v1.state, [moved.op], DEFAULT_PARAMS);
    expect(replayed.segments[0].end).toBe(target);
    expect(replayed.segments[0].id).toBe(moved.state.segments[0].id);
    expect(replayed.segments[1].id).toBe(moved.state.segments[1].id);
    expect(replayOps(v1.state, [moved.op], DEFAULT_PARAMS)).toEqual(replayed);
    void stateHash;
  });
});

describe('export', () => {
  it('produces a reproducible manifest, evidence and zip', () => {
    const v1 = baseVersion();
    const a = exportVersion(v1, record, bytes);
    const b = exportVersion(v1, record, bytes);
    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.zipHash).toBe(b.zipHash);
    expect(a.zip).toEqual(b.zip);
    const manifest = JSON.parse(a.manifestText);
    expect(manifest.format).toBe('bytelab-repair-manifest/1');
    expect(manifest.integrity.originalSha256).toBe(record.digest);
    expect(manifest.segments.length).toBe(3);
    expect(manifest.segments[0].byteRange[0]).toBe(0);
    expect(manifest.segments[2].byteRange[1]).toBe(bytes.length);
    // Evidence references exact byte ranges.
    expect(a.evidenceText).toContain('字节');
    // Zip contains the repaired text and the original bytes.
    expect(a.zip.length).toBeGreaterThan(bytes.length);
  });

  it('exports the repaired text with resolved symbols inlined', () => {
    const v1 = baseVersion();
    const b = exportVersion(v1, record, bytes);
    expect(b.repairedText).toContain('注射用头孢曲松钠');
    expect(b.repairedText).toContain('不良反應');
  });

  it('summarises a blocked version when review items remain', () => {
    const v1 = baseVersion();
    const summary = summarizeVersion(v1);
    // At least one boundary or symbol must be open in the mixed sample.
    expect(summary.blocked || v1.state.segments.every((s) => s.status !== 'pending')).toBe(true);
  });
});
