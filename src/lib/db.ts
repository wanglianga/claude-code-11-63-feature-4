import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AnalysisRun,
  ImportRecord,
  RepairVersion,
  SourceRecord,
  ImportOutcome,
  ImportInput,
  ImportStats,
} from '../types';
import { sha256Hex } from './util/sha256';
import { canonicalJson, makeId } from './util/bytes';

export const DB_NAME = 'bytelab';
export const DB_VERSION = 1;

interface ByteLabDB extends DBSchema {
  imports: {
    key: string;
    value: ImportRecord;
    indexes: { 'by-digest': string };
  };
  blobs: {
    key: string;
    value: { digest: string; bytes: Uint8Array };
  };
  runs: {
    key: string;
    value: AnalysisRun;
    indexes: { 'by-import': string };
  };
  versions: {
    key: string;
    value: RepairVersion;
    indexes: { 'by-import': string };
  };
}

let dbPromise: Promise<IDBPDatabase<ByteLabDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<ByteLabDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ByteLabDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('imports')) {
          const store = db.createObjectStore('imports', { keyPath: 'id' });
          store.createIndex('by-digest', 'digest', { unique: true });
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'digest' });
        }
        if (!db.objectStoreNames.contains('runs')) {
          const store = db.createObjectStore('runs', { keyPath: 'id' });
          store.createIndex('by-import', 'importId');
        }
        if (!db.objectStoreNames.contains('versions')) {
          const store = db.createObjectStore('versions', { keyPath: 'id' });
          store.createIndex('by-import', 'importId');
        }
      },
      blocking() {
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

/** Test-only reset so each suite starts from a clean database. */
export async function resetDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
  }
  dbPromise = null;
}

export async function clearAll(): Promise<void> {
  const db = await getDb();
  await Promise.all(
    (['imports', 'blobs', 'runs', 'versions'] as const).map((s) => db.clear(s)),
  );
}

export function digestOf(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Import a file. Identical bytes are merged into the existing record: a new
 * source row is appended (fileName / market / sender / receivedAt) but the
 * digest, blob and any existing statistics are reused, so a file forwarded
 * three times shows three sources and counts once.
 */
export async function importFile(input: ImportInput): Promise<ImportOutcome> {
  const db = await getDb();
  const digest = digestOf(input.bytes);
  const existing = await db.getFromIndex('imports', 'by-digest', digest);
  const receivedAt = input.receivedAt || nowIso();
  const timestamp = nowIso();

  if (existing) {
    const duplicateSource = existing.sources.some(
      (s) =>
        s.fileName === input.fileName &&
        s.market === input.market &&
        s.receivedFrom === input.receivedFrom &&
        s.receivedAt === receivedAt,
    );
    if (!duplicateSource) {
      const source: SourceRecord = {
        id: makeId('src', true),
        fileName: input.fileName,
        market: input.market,
        receivedFrom: input.receivedFrom,
        receivedAt,
        importedAt: timestamp,
        note: input.note ?? '',
      };
      const updated: ImportRecord = {
        ...existing,
        sources: [...existing.sources, source],
        updatedAt: timestamp,
      };
      await db.put('imports', updated);
      return {
        importId: updated.id,
        digest,
        merged: true,
        sourceFileName: input.fileName,
        sourceCount: updated.sources.length,
        import: updated,
      };
    }
    return {
      importId: existing.id,
      digest,
      merged: true,
      sourceFileName: input.fileName,
      sourceCount: existing.sources.length,
      import: existing,
    };
  }

  const source: SourceRecord = {
    id: makeId('src', true),
    fileName: input.fileName,
    market: input.market,
    receivedFrom: input.receivedFrom,
    receivedAt,
    importedAt: timestamp,
    note: input.note ?? '',
  };
  const record: ImportRecord = {
    id: makeId('imp', true),
    digest,
    byteLength: input.bytes.length,
    primaryFileName: input.fileName,
    firstMarket: input.market,
    createdAt: timestamp,
    updatedAt: timestamp,
    sources: [source],
    note: '',
  };
  const tx = db.transaction(['imports', 'blobs'], 'readwrite');
  await tx.objectStore('imports').put(record);
  await tx.objectStore('blobs').put({ digest, bytes: input.bytes });
  await tx.done;
  return {
    importId: record.id,
    digest,
    merged: false,
    sourceFileName: input.fileName,
    sourceCount: 1,
    import: record,
  };
}

export async function listImports(): Promise<ImportRecord[]> {
  const db = await getDb();
  const all = await db.getAll('imports');
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getImport(id: string): Promise<ImportRecord | null> {
  const db = await getDb();
  return (await db.get('imports', id)) ?? null;
}

export async function getImportBytes(digest: string): Promise<Uint8Array | null> {
  const db = await getDb();
  const row = await db.get('blobs', digest);
  return row ? row.bytes : null;
}

export async function importStats(): Promise<ImportStats> {
  const records = await listImports();
  const totalSources = records.reduce((n, r) => n + r.sources.length, 0);
  return {
    uniqueFiles: records.length,
    totalSources,
    mergedImports: totalSources - records.length,
    totalBytes: records.reduce((n, r) => n + r.byteLength, 0),
  };
}

export async function addSource(
  importId: string,
  input: Omit<ImportInput, 'bytes'>,
): Promise<ImportRecord | null> {
  const db = await getDb();
  const existing = await db.get('imports', importId);
  if (!existing) return null;
  const source: SourceRecord = {
    id: makeId('src', true),
    fileName: input.fileName,
    market: input.market,
    receivedFrom: input.receivedFrom,
    receivedAt: input.receivedAt || nowIso(),
    importedAt: nowIso(),
    note: input.note ?? '',
  };
  const updated: ImportRecord = {
    ...existing,
    sources: [...existing.sources, source],
    updatedAt: nowIso(),
  };
  await db.put('imports', updated);
  return updated;
}

export async function deleteImport(id: string): Promise<void> {
  const db = await getDb();
  const record = await db.get('imports', id);
  if (!record) return;
  const tx = db.transaction(['imports', 'blobs', 'runs', 'versions'], 'readwrite');
  const runs = await tx.objectStore('runs').index('by-import').getAll(id);
  const versions = await tx.objectStore('versions').index('by-import').getAll(id);
  for (const r of runs) await tx.objectStore('runs').delete(r.id);
  for (const v of versions) await tx.objectStore('versions').delete(v.id);
  await tx.objectStore('imports').delete(id);
  await tx.done;
  // The blob is content-addressed; only remove it when no import uses it.
  const remaining = await db.getAll('imports');
  if (!remaining.some((r) => r.digest === record.digest)) {
    await db.delete('blobs', record.digest);
  }
}

/* -------------------------------- runs ---------------------------------- */

export async function saveRun(run: AnalysisRun): Promise<void> {
  const db = await getDb();
  await db.put('runs', run);
}

export async function listRuns(importId: string): Promise<AnalysisRun[]> {
  const db = await getDb();
  const runs = await db.getAllFromIndex('runs', 'by-import', importId);
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function latestRun(importId: string): Promise<AnalysisRun | null> {
  const runs = await listRuns(importId);
  return runs[0] ?? null;
}

export async function deleteRun(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('runs', id);
}

/* ------------------------------- versions -------------------------------- */

export async function saveVersion(version: RepairVersion): Promise<void> {
  const db = await getDb();
  await db.put('versions', version);
}

export async function listVersions(importId: string): Promise<RepairVersion[]> {
  const db = await getDb();
  const versions = await db.getAllFromIndex('versions', 'by-import', importId);
  return versions.sort((a, b) => a.seq - b.seq);
}

export async function getVersion(id: string): Promise<RepairVersion | null> {
  const db = await getDb();
  return (await db.get('versions', id)) ?? null;
}

export async function deleteVersion(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('versions', id);
}

/** Content hash of a repair version state, excluding the hash itself. */
export function versionStateHash(version: Omit<RepairVersion, 'stateHash'>): string {
  return sha256Hex(canonicalJson(version));
}

export async function exportDatabase(): Promise<{
  imports: ImportRecord[];
  runs: AnalysisRun[];
  versions: RepairVersion[];
}> {
  const db = await getDb();
  return {
    imports: await db.getAll('imports'),
    runs: await db.getAll('runs'),
    versions: await db.getAll('versions'),
  };
}
