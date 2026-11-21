import type {
  AnalysisParams,
  ImportInput,
  ImportRecord,
  RepairState,
  Rect,
  VersionOp,
} from '../types';
import {
  clearAll,
  deleteImport as dbDeleteImport,
  getImportBytes,
  importFile,
  importStats,
  listImports,
  listVersions,
  saveRun,
  saveVersion,
} from '../lib/db';
import { analyzeInWorker } from '../lib/analysis-worker';
import { DEFAULT_PARAMS } from '../lib/encoding/specs';
import {
  buildVersion,
  createInitialState,
  moveBoundary,
  selectCandidate,
  setSymbolResolution,
  clearSymbolResolution,
  acknowledgeBoundary,
  addNote as addNoteState,
  recropLayoutAnchor,
  adjudicateLayoutReview,
} from '../lib/repair';
import { exportVersion, DEFAULT_EXPORT_OPTIONS } from '../lib/export';
import { verifyVersion } from '../lib/repair';
import { setBusy, toast, appStore, activeVersion, selectedImport } from './app';
import { makeId } from '../lib/util/bytes';

let activeJob: { cancel: () => void } | null = null;

export async function refreshLibrary(): Promise<void> {
  const [imports, stats] = await Promise.all([listImports(), importStats()]);
  appStore.update((s) => ({ ...s, imports, stats }));
}

export async function importFiles(inputs: ImportInput[]): Promise<ImportRecord[]> {
  const results: ImportRecord[] = [];
  for (const input of inputs) {
    const outcome = await importFile(input);
    results.push(outcome.import);
    if (outcome.merged) {
      const sources = outcome.sourceCount;
      toast(
        'info',
        `已合并重复来源：${input.fileName}`,
        `字节摘要与已导入文件相同，现共 ${sources} 条来源记录；统计不会重复计数。`,
      );
    } else {
      toast('success', `已导入 ${input.fileName}`, `${input.bytes.length} 字节 · SHA-256 ${outcome.digest.slice(0, 12)}…`);
    }
  }
  await refreshLibrary();
  const first = results[0];
  if (first) {
    appStore.update((s) => ({
      ...s,
      selectedImportId: first.id,
      view: s.view === 'library' ? 'diagnose' : s.view,
    }));
  }
  return results;
}

export async function importSampleFiles(
  files: { name: string; note: string }[],
  fetcher: (name: string) => Promise<Uint8Array>,
): Promise<void> {
  setBusy('导入本地样例');
  try {
    const inputs: ImportInput[] = [];
    for (const f of files) {
      const bytes = await fetcher(f.name);
      inputs.push({
        bytes,
        fileName: f.name,
        market: marketFromName(f.name),
        receivedFrom: 'bundled sample',
        receivedAt: new Date().toISOString(),
        note: f.note,
      });
    }
    await importFiles(inputs);
  } finally {
    setBusy(null);
  }
}

function marketFromName(name: string): string {
  if (name.includes('big5')) return 'TW';
  if (name.includes('mixed')) return 'CN/HK';
  if (name.includes('gbk')) return 'CN';
  if (name.includes('mojibake')) return 'CN (forwarded)';
  return 'LOCAL';
}

export async function selectImport(id: string): Promise<void> {
  appStore.update((s) => ({ ...s, selectedImportId: id, verification: null, focusedSegmentId: null }));
  // Load prior versions if not in memory.
  const state = appStore.get();
  if (!state.versions[id]) {
    const versions = await listVersions(id);
    appStore.update((s) => ({
      ...s,
      versions: { ...s.versions, [id]: versions },
      activeVersionByImport: {
        ...s.activeVersionByImport,
        [id]: s.activeVersionByImport[id] ?? versions[versions.length - 1]?.id ?? '',
      },
    }));
  }
  const version = activeVersion(appStore.get());
  appStore.update((s) => ({ ...s, currentState: version ? version.state : null, dirty: false }));
}

export async function runDiagnosis(importId: string, params: AnalysisParams): Promise<void> {
  const record = appStore.get().imports.find((i) => i.id === importId);
  if (!record) return;
  const bytes = await getImportBytes(record.digest);
  if (!bytes) {
    toast('error', '原始字节缺失', '无法从 IndexedDB 读取该摘要的原始数据。');
    return;
  }
  activeJob?.cancel();
  appStore.update((s) => ({
    ...s,
    analyzing: true,
    analysisError: null,
    analysisStage: 'starting',
    analysisFraction: 0,
    view: 'diagnose',
  }));
  const job = analyzeInWorker(bytes, record.digest, params, {
    onProgress: (stage, fraction, detail) => {
      appStore.update((s) => ({ ...s, analysisStage: detail ?? stage, analysisFraction: fraction }));
    },
  });
  activeJob = job;
  try {
    const { bundle, elapsedMs } = await job.promise;
    const runId = makeId('run', true);
    await saveRun({ id: runId, importId, digest: record.digest, bundle, createdAt: new Date().toISOString() });
    appStore.update((s) => ({
      ...s,
      bundles: { ...s.bundles, [importId]: bundle },
      analyzing: false,
      analysisFraction: 1,
      lastAnalysisMs: elapsedMs,
      currentState: s.currentState && !s.dirty ? s.currentState : s.currentState,
    }));
    toast(
      'success',
      '诊断完成',
      `Worker 用时 ${elapsedMs} ms · 统一 ${bundle.uniform.metrics.segmentCount} 段 / 分段 ${bundle.segmented.metrics.segmentCount} 段`,
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    appStore.update((s) => ({
      ...s,
      analyzing: false,
      analysisError: err instanceof Error ? err.message : String(err),
    }));
    toast('error', '诊断失败', err instanceof Error ? err.message : String(err));
  } finally {
    if (activeJob === job) activeJob = null;
  }
}

export async function startRepairFromBundle(strategy: 'uniform' | 'segmented'): Promise<void> {
  const state = appStore.get();
  const importId = state.selectedImportId;
  if (!importId) return;
  const bundle = state.bundles[importId];
  if (!bundle) {
    toast('warn', '尚无诊断结果', '请先运行诊断。');
    return;
  }
  setBusy('创建修复工作区');
  try {
    const repairState = createInitialState(bundle, strategy);
    const existing = state.versions[importId] ?? [];
    const parent = existing[existing.length - 1] ?? null;
    const op: VersionOp = { type: 'create', strategy, summary: '从诊断结果创建' };
    const version = buildVersion({
      importId,
      digest: bundle.digest,
      runId: 'latest',
      parent,
      strategy,
      state: repairState,
      op,
      name: parent ? `v${(parent.seq + 1)} ${strategy === 'uniform' ? '统一解码' : '分段诊断'}` : 'v1 初始修复版本',
    });
    await saveVersion(version);
    appStore.update((s) => ({
      ...s,
      versions: { ...s.versions, [importId]: [...(s.versions[importId] ?? []), version] },
      activeVersionByImport: { ...s.activeVersionByImport, [importId]: version.id },
      currentState: version.state,
      activeStrategy: strategy,
      dirty: false,
      view: 'repair',
    }));
    toast('success', '已建立修复版本', `${version.name} · ${repairState.segments.length} 个区段`);
  } finally {
    setBusy(null);
  }
}

async function persistVersion(op: VersionOp, name: string, mutate: (base: RepairState) => RepairState | { state: RepairState; op: VersionOp }): Promise<void> {
  const state = appStore.get();
  const importId = state.selectedImportId;
  const bundle = state.bundles[importId ?? ''];
  if (!importId || !state.currentState) return;
  const parentList = state.versions[importId] ?? [];
  const parent = parentList[parentList.length - 1] ?? null;
  const base = parent ? parent.state : state.currentState;
  const outcome = mutate(base);
  const newState = 'state' in outcome ? outcome.state : outcome;
  const finalOp = 'state' in outcome ? outcome.op : op;
  const version = buildVersion({
    importId,
    digest: bundle?.digest ?? selectedImport(state)?.digest ?? '',
    runId: 'latest',
    parent,
    strategy: parent?.strategy ?? state.activeStrategy,
    state: newState,
    op: finalOp,
    name,
  });
  await saveVersion(version);
  appStore.update((s) => ({
    ...s,
    versions: { ...s.versions, [importId]: [...(s.versions[importId] ?? []), version] },
    activeVersionByImport: { ...s.activeVersionByImport, [importId]: version.id },
    currentState: version.state,
    dirty: false,
    verification: null,
  }));
}

export async function chooseCandidate(segmentId: string, candidateId: string): Promise<void> {
  const state = appStore.get();
  const seg = state.currentState?.segments.find((s) => s.id === segmentId);
  if (!seg || seg.selectedCandidateId === candidateId) return;
  const candidateLabel = seg.candidates.find((c) => c.id === candidateId)?.label ?? candidateId;
  await persistVersion(
    { type: 'select-candidate', segmentId, candidateId, previousCandidateId: seg.selectedCandidateId },
    `切换到 ${candidateLabel}`,
    (base) => selectCandidate(base, segmentId, candidateId),
  );
  toast('success', '候选已切换', candidateLabel);
}

export async function moveBoundaryTo(boundaryIndex: number, newPosition: number, note: string): Promise<void> {
  const state = appStore.get();
  const importId = state.selectedImportId;
  if (!importId || !state.currentState) return;
  const record = state.imports.find((i) => i.id === importId);
  const bytes = record ? await getImportBytes(record.digest) : null;
  if (!bytes) {
    toast('error', '无法读取原始字节');
    return;
  }
  const parentList = state.versions[importId] ?? [];
  const parent = parentList[parentList.length - 1] ?? null;
  const seq = (parent?.seq ?? 0) + 1;
  const versionId = makeId('pending', true);
  try {
    const result = moveBoundary(
      state.currentState,
      bytes,
      state.params,
      boundaryIndex,
      newPosition,
      note,
      versionId,
      seq,
    );
    await persistVersion(result.op, `边界重定义 #${boundaryIndex + 1}`, () => ({ state: result.state, op: result.op }));
    toast(
      'info',
      '边界已重定义',
      `原裁决保留为历史（${result.superseded.length} 条），新范围已重新评估。`,
    );
  } catch (err) {
    toast('error', '边界移动失败', err instanceof Error ? err.message : String(err));
  }
}

export async function resolveSymbol(segmentId: string, symbolId: string, text: string, note: string): Promise<void> {
  const state = appStore.get();
  const seg = state.currentState?.segments.find((s) => s.id === segmentId);
  const sym = seg?.candidates.find((c) => c.id === seg.selectedCandidateId)?.unresolved.find((u) => u.id === symbolId);
  await persistVersion(
    {
      type: 'resolve-symbol',
      symbolId,
      text,
      note,
      previous: null,
      segmentId,
    },
    `裁决符号 ${symbolId}`,
    (base) => setSymbolResolution(base, segmentId, symbolId, text, note, 'pending'),
  );
  void sym;
  toast('success', '符号已裁决', `“${text}” 已写入当前版本`);
}

export async function undoResolveSymbol(symbolId: string): Promise<void> {
  await persistVersion(
    { type: 'clear-symbol', symbolId, previous: null, segmentId: '' },
    `撤销裁决 ${symbolId}`,
    (base) => clearSymbolResolution(base, symbolId),
  );
}

export async function acknowledgeReview(reviewId: string, note: string): Promise<void> {
  if (!note.trim()) {
    toast('warn', '请填写确认说明', '边界确认必须记录人工判断依据。');
    return;
  }
  const state = appStore.get();
  const review = state.currentState?.boundaryReviews.find((r) => r.id === reviewId);
  if (!review) return;
  const record = state.imports.find((i) => i.id === state.selectedImportId);
  const bytes = record ? (await getImportBytes(record.digest)) ?? undefined : undefined;
  const previous = state.currentState?.boundaryAcknowledgements[reviewId] ?? null;
  await persistVersion(
    {
      type: 'acknowledge-boundary',
      reviewId,
      boundary: review.boundary,
      note,
      previous,
    },
    `确认边界风险 ${reviewId}`,
    (base) => acknowledgeBoundary(base, reviewId, note, 'pending', bytes ?? undefined),
  );
  toast('success', '边界风险已确认', note);
}

export async function addNote(target: string, text: string): Promise<void> {
  if (!text.trim()) return;
  await persistVersion(
    { type: 'add-note', target, text },
    `备注 ${target}`,
    (base) => addNoteState(base, target, text, 'pending'),
  );
  toast('success', '备注已记录');
}

/** Re-crop a page region; old confirmations stay as history, anchors revalidate. */
export async function recropAnchor(
  pageId: string,
  blockId: string,
  newRect: Rect,
  note: string,
): Promise<void> {
  if (!note.trim()) {
    toast('warn', '请填写重新裁剪理由', '重新裁剪必须记录人工依据。');
    return;
  }
  const state = appStore.get();
  const importId = state.selectedImportId;
  if (!importId || !state.currentState?.layout) return;
  const parentList = state.versions[importId] ?? [];
  const parent = parentList[parentList.length - 1] ?? null;
  const seq = (parent?.seq ?? 0) + 1;
  const versionId = makeId('pending', true);
  try {
    const result = recropLayoutAnchor(state.currentState, {
      pageId,
      blockId,
      newRect,
      note,
      versionId,
      seq,
    });
    await persistVersion(result.op, `重新裁剪锚点 ${blockId}`, () => ({ state: result.state, op: result.op }));
    const openCount = result.state.layout?.reviewQueue.filter((q) => q.status === 'queued').length ?? 0;
    toast('info', '锚点已重新裁剪', `旧确认保留为历史证据；受影响定位已重新校验，当前 ${openCount} 项在复核队列。`);
  } catch (err) {
    toast('error', '重新裁剪失败', err instanceof Error ? err.message : String(err));
  }
}

/** Confirm or reject a high-risk layout review item. */
export async function adjudicateLayout(
  queueId: string,
  decision: 'confirmed' | 'rejected',
  note: string,
): Promise<void> {
  if (!note.trim()) {
    toast('warn', '请填写裁决说明', '版面复核必须记录人工判断依据。');
    return;
  }
  const state = appStore.get();
  if (!state.currentState?.layout) return;
  try {
    const result = adjudicateLayoutReview(state.currentState, queueId, decision, note, makeId('pending', true));
    await persistVersion(
      result.op,
      decision === 'confirmed' ? `确认版面定位 ${queueId}` : `驳回版面定位 ${queueId}`,
      () => ({ state: result.state, op: result.op }),
    );
    toast('success', decision === 'confirmed' ? '版面定位已确认' : '版面定位已驳回', note);
  } catch (err) {
    toast('error', '版面复核裁决失败', err instanceof Error ? err.message : String(err));
  }
}

export function updateParams(patch: Partial<AnalysisParams>): void {
  appStore.update((s) => ({ ...s, params: { ...s.params, ...patch } }));
}

export function resetParams(): void {
  appStore.update((s) => ({ ...s, params: DEFAULT_PARAMS }));
}

export function selectVersion(versionId: string): void {
  const state = appStore.get();
  const importId = state.selectedImportId;
  if (!importId) return;
  const version = (state.versions[importId] ?? []).find((v) => v.id === versionId);
  if (!version) return;
  appStore.update((s) => ({
    ...s,
    activeVersionByImport: { ...s.activeVersionByImport, [importId]: versionId },
    currentState: version.state,
    dirty: false,
    verification: null,
  }));
}

export async function verifyActiveVersion(): Promise<void> {
  const state = appStore.get();
  const version = activeVersion(state);
  const importId = state.selectedImportId;
  if (!version || !importId) return;
  const bytes = await getImportBytes(version.digest);
  if (!bytes) {
    toast('error', '无法读取原始字节');
    return;
  }
  const report = verifyVersion({ version, bytes, digest: version.digest });
  appStore.update((s) => ({
    ...s,
    verification: {
      ...report,
      boundaryIntegrity: report.coverageIssues,
      exportHash: '',
      exportHashReproducible: true,
    },
  }));
  toast(
    report.digestMatches && report.segmentsCoverFile && report.stateHashMatches ? 'success' : 'warn',
    '校验完成',
    `${report.digestMatches ? '摘要一致' : '摘要不一致'} · ${report.segmentsCoverFile ? '区段完整覆盖' : '区段存在缺口'}`,
  );
}

export async function runExport(): Promise<void> {
  const state = appStore.get();
  const version = activeVersion(state);
  const importId = state.selectedImportId;
  if (!version || !importId) return;
  const record = state.imports.find((i) => i.id === importId);
  if (!record) return;
  const bytes = await getImportBytes(version.digest);
  if (!bytes) {
    toast('error', '无法读取原始字节');
    return;
  }
  const bundle = exportVersion(version, record, bytes, {
    ...DEFAULT_EXPORT_OPTIONS,
    ...state.exportOptions,
  });
  appStore.update((s) => ({ ...s, lastExport: bundle }));
  downloadBytes(bundle.zip, `${bundle.fileNameBase}.zip`);
  toast('success', '导出完成', `${bundle.fileNameBase}.zip · 清单 SHA-256 ${bundle.manifestHash.slice(0, 12)}…`);
}

export function downloadBytes(data: Uint8Array, fileName: string): void {
  const blob = new Blob([data as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, fileName: string, mime = 'application/json'): void {
  downloadBytes(new TextEncoder().encode(text), fileName);
  void mime;
}

export async function removeImport(id: string): Promise<void> {
  await dbDeleteImport(id);
  await refreshLibrary();
  appStore.update((s) => {
    const versions = { ...s.versions };
    delete versions[id];
    const bundles = { ...s.bundles };
    delete bundles[id];
    return {
      ...s,
      versions,
      bundles,
      selectedImportId: s.selectedImportId === id ? null : s.selectedImportId,
      currentState: s.selectedImportId === id ? null : s.currentState,
      view: s.selectedImportId === id ? 'library' : s.view,
    };
  });
  toast('info', '已删除导入记录');
}

export async function resetWorkspace(): Promise<void> {
  await clearAll();
  appStore.update((s) => ({
    ...s,
    imports: [],
    stats: { uniqueFiles: 0, totalSources: 0, mergedImports: 0, totalBytes: 0 },
    selectedImportId: null,
    bundles: {},
    versions: {},
    activeVersionByImport: {},
    currentState: null,
    verification: null,
    lastExport: null,
    view: 'library',
  }));
  toast('info', '本地数据已清空', 'IndexedDB 中的导入、诊断与修复版本均已删除。');
}

