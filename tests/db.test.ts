import { beforeEach, describe, expect, it } from 'vitest';
import {
  addSource,
  clearAll,
  getImport,
  getImportBytes,
  importFile,
  importStats,
  listImports,
  listRuns,
  listVersions,
  saveRun,
  saveVersion,
} from '../src/lib/db';
import { sampleBytes } from './setup';

beforeEach(async () => {
  await clearAll();
});

function input(fileName: string, market: string, receivedFrom: string, receivedAt = '2026-01-01T00:00:00.000Z') {
  return {
    bytes: sampleBytes('big5-monograph.txt'),
    fileName,
    market,
    receivedFrom,
    receivedAt,
  };
}

describe('import deduplication', () => {
  it('merges identical bytes under different file names into one record', async () => {
    const first = await importFile(input('標籤_A.txt', 'TW', 'mailbox-a'));
    expect(first.merged).toBe(false);
    expect(first.sourceCount).toBe(1);

    const second = await importFile(input('label_copy.pdf.txt', 'HK', 'mailbox-b'));
    expect(second.merged).toBe(true);
    expect(second.importId).toBe(first.importId);
    expect(second.sourceCount).toBe(2);

    const imports = await listImports();
    expect(imports).toHaveLength(1);
    expect(imports[0].sources.map((s) => s.fileName)).toEqual(['標籤_A.txt', 'label_copy.pdf.txt']);
    expect(imports[0].sources.map((s) => s.market)).toEqual(['TW', 'HK']);

    // Statistics count the file once, the sources twice.
    const stats = await importStats();
    expect(stats.uniqueFiles).toBe(1);
    expect(stats.totalSources).toBe(2);
    expect(stats.mergedImports).toBe(1);
  });

  it('does not add a duplicate source row for the exact same origin', async () => {
    const first = await importFile(input('a.txt', 'TW', 'box'));
    const again = await importFile(input('a.txt', 'TW', 'box'));
    expect(again.sourceCount).toBe(1);
    const record = await getImport(first.importId);
    expect(record?.sources).toHaveLength(1);
  });

  it('keeps the original bytes content-addressed', async () => {
    const { digest, importId } = await importFile(input('a.txt', 'TW', 'box'));
    const bytes = await getImportBytes(digest);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(sampleBytes('big5-monograph.txt').length);
    expect(await getImport(importId)).not.toBeNull();
  });

  it('adds a late source without changing the byte statistics', async () => {
    const first = await importFile(input('a.txt', 'TW', 'box'));
    const updated = await addSource(first.importId, {
      fileName: 'a_resend.txt',
      market: 'SG',
      receivedFrom: 'vendor',
      receivedAt: '2026-02-01T00:00:00.000Z',
      note: '转发版本',
    });
    expect(updated?.sources).toHaveLength(2);
    const stats = await importStats();
    expect(stats.uniqueFiles).toBe(1);
    expect(stats.totalBytes).toBe(sampleBytes('big5-monograph.txt').length);
  });
});

describe('runs and versions', () => {
  it('stores runs and versions per import', async () => {
    const { importId, digest } = await importFile(input('a.txt', 'TW', 'box'));
    await saveRun({
      id: 'run-1',
      importId,
      digest,
      createdAt: '2026-01-01T00:00:01.000Z',
      bundle: {
        digest,
        byteLength: 1,
        params: {
          enabledEncodings: ['utf-8'],
          tileBytes: 256,
          minSegmentBytes: 256,
          mojibakeRunMinGlyphs: 4,
          confidenceThreshold: 0.6,
          marginThreshold: 0.08,
          maxCandidatesPerSegment: 6,
          includeUtf16: false,
          layoutOrdering: 'geometric',
        },
        uniform: { strategy: 'uniform', segments: [], boundaryReviews: [], metrics: {} as never, elapsedMs: 0, notes: [] },
        segmented: { strategy: 'segmented', segments: [], boundaryReviews: [], metrics: {} as never, elapsedMs: 0, notes: [] },
        recommendedStrategy: 'uniform',
        recommendationRationale: [],
        comparisonRows: [],
        createdAt: '2026-01-01T00:00:01.000Z',
        engine: 'test',
        layout: null,
      },
    });
    expect(await listRuns(importId)).toHaveLength(1);

    await saveVersion({
      id: 'v1',
      importId,
      digest,
      runId: 'run-1',
      parentId: null,
      seq: 1,
      name: '初始版本',
      createdAt: '2026-01-01T00:00:02.000Z',
      strategy: 'segmented',
      state: {
        boundaries: [],
        segments: [],
        symbolResolutions: {},
        notes: [],
        boundaryReviews: [],
        boundaryAcknowledgements: {},
        superseded: [],
        layout: null,
      },
      ops: [],
      superseded: [],
      audit: [],
      stateHash: 'x',
    });
    const versions = await listVersions(importId);
    expect(versions).toHaveLength(1);
    expect(versions[0].name).toBe('初始版本');
  });
});
