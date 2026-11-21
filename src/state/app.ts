import type {
  AnalysisBundle,
  AnalysisParams,
  ImportRecord,
  ImportStats,
  RepairVersion,
  RepairState,
  VerificationReport,
  ExportBundle,
  VersionOp,
} from '../types';
import { createStore } from '../lib/util/store';
import { DEFAULT_PARAMS } from '../lib/encoding/specs';

export type ViewId = 'library' | 'diagnose' | 'repair' | 'layout' | 'archive';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  title: string;
  detail?: string;
}

export interface AppState {
  view: ViewId;
  sidebarOpen: boolean;
  imports: ImportRecord[];
  stats: ImportStats;
  selectedImportId: string | null;
  params: AnalysisParams;
  analyzing: boolean;
  analysisStage: string;
  analysisFraction: number;
  analysisError: string | null;
  lastAnalysisMs: number | null;
  bundles: Record<string, AnalysisBundle>;
  activeStrategy: 'uniform' | 'segmented';
  versions: Record<string, RepairVersion[]>;
  activeVersionByImport: Record<string, string>;
  currentState: RepairState | null;
  dirty: boolean;
  verification: VerificationReport | null;
  lastExport: ExportBundle | null;
  exportOptions: {
    includeOriginalBytes: boolean;
    unresolvedPlaceholderStyle: 'byte-escape' | 'question';
    };
  toasts: Toast[];
  focusedSegmentId: string | null;
  busy: string | null;
}

export const INITIAL_STATE: AppState = {
  view: 'library',
  sidebarOpen: true,
  imports: [],
  stats: { uniqueFiles: 0, totalSources: 0, mergedImports: 0, totalBytes: 0 },
  selectedImportId: null,
  params: DEFAULT_PARAMS,
  analyzing: false,
  analysisStage: '',
  analysisFraction: 0,
  analysisError: null,
  lastAnalysisMs: null,
  bundles: {},
  activeStrategy: 'segmented',
  versions: {},
  activeVersionByImport: {},
  currentState: null,
  dirty: false,
  verification: null,
  lastExport: null,
  exportOptions: {
    includeOriginalBytes: true,
    unresolvedPlaceholderStyle: 'byte-escape',
  },
  toasts: [],
  focusedSegmentId: null,
  busy: null,
};

export const appStore = createStore<AppState>(INITIAL_STATE);

export function toast(kind: Toast['kind'], title: string, detail?: string): void {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  appStore.update((s) => ({ ...s, toasts: [...s.toasts, { id, kind, title, detail }] }));
  setTimeout(() => {
    appStore.update((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
  }, kind === 'error' ? 9000 : 5000);
}

export function dismissToast(id: string): void {
  appStore.update((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function setView(view: ViewId): void {
  appStore.update((s) => ({ ...s, view }));
}

export function setBusy(label: string | null): void {
  appStore.update((s) => ({ ...s, busy: label }));
}

export function activeVersion(state: AppState): RepairVersion | null {
  const id = state.selectedImportId;
  if (!id) return null;
  const versionId = state.activeVersionByImport[id];
  const list = state.versions[id] ?? [];
  return list.find((v) => v.id === versionId) ?? list[list.length - 1] ?? null;
}

export function selectedImport(state: AppState): ImportRecord | null {
  return state.imports.find((i) => i.id === state.selectedImportId) ?? null;
}

export function currentBundle(state: AppState): AnalysisBundle | null {
  if (!state.selectedImportId) return null;
  return state.bundles[state.selectedImportId] ?? null;
}

export function describeOp(op: VersionOp): string {
  switch (op.type) {
    case 'create':
      return '创建版本';
    case 'select-candidate':
      return '切换候选';
    case 'move-boundary':
      return `移动边界 ${op.from} → ${op.to}`;
    case 'resolve-symbol':
      return `裁决符号 “${op.text}”`;
    case 'clear-symbol':
      return '撤销符号裁决';
    case 'acknowledge-boundary':
      return '确认边界风险';
    case 'recrop-anchor':
      return '重新裁剪版面锚点';
    case 'adjudicate-layout-review':
      return op.decision === 'confirmed' ? '确认版面定位' : '驳回版面定位';
    case 'add-note':
      return '添加备注';
    default:
      return '操作';
  }
}
