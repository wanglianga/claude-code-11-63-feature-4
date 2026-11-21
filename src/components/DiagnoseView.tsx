import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Cpu,
  Download,
  FlaskConical,
  Gauge,
  GitCompareArrows,
  RefreshCw,
  Settings2,
  ShieldQuestion,
} from 'lucide-react';
import type { AnalysisBundle, StrategyResult } from '../types';
import { useStore } from '../lib/util/store';
import { appStore, setView, toast } from '../state/app';
import {
  downloadText,
  importSampleFiles,
  runDiagnosis,
  selectImport,
  startRepairFromBundle,
  updateParams,
  resetParams,
} from '../state/actions';
import { ALL_ENCODING_IDS, DEFAULT_PARAMS, ENCODINGS, encodingLabel } from '../lib/encoding/specs';
import { formatBytes, shortHash } from '../lib/util/bytes';
import { fetchSampleBytes, SAMPLE_LIST } from '../samples';
import { Banner, EncodingChip, EmptyState, Panel, ScoreBar, StatusChip } from './common';
import { SegmentStrip } from './SegmentStrip';

export function DiagnoseView() {
  const imports = useStore(appStore, (s) => s.imports);
  const selectedId = useStore(appStore, (s) => s.selectedImportId);
  const record = imports.find((i) => i.id === selectedId) ?? null;
  const bundle = useStore(appStore, (s) => (selectedId ? s.bundles[selectedId] : null) ?? null);
  const analyzing = useStore(appStore, (s) => s.analyzing);
  const stage = useStore(appStore, (s) => s.analysisStage);
  const fraction = useStore(appStore, (s) => s.analysisFraction);
  const lastMs = useStore(appStore, (s) => s.lastAnalysisMs);
  const error = useStore(appStore, (s) => s.analysisError);
  const params = useStore(appStore, (s) => s.params);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (imports.length === 0) return;
    if (!selectedId) void selectImport(imports[0].id);
  }, [imports, selectedId]);

  async function loadSamples() {
    setImporting(true);
    try {
      await importSampleFiles(
        SAMPLE_LIST.map((s) => ({ name: s.name, note: s.note })),
        fetchSampleBytes,
      );
      toast('success', '已导入内置样例', `${SAMPLE_LIST.length} 份说明书已加入导入记录。`);
    } catch (err) {
      toast('error', '样例导入失败', err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  if (imports.length === 0) {
    return (
      <div className="content">
        <Panel title="开始诊断" icon={<FlaskConical size={15} />}>
          <EmptyState
            icon={<FlaskConical size={20} />}
            title="还没有可诊断的文件"
            action={
              <div className="btn-row">
                <button className="btn primary" onClick={loadSamples} disabled={importing}>
                  {importing ? <RefreshCw size={14} className="spin" /> : <Download size={14} />} 导入内置样例
                </button>
                <button className="btn" onClick={() => setView('library')}>
                  前往导入
                </button>
              </div>
            }
          >
            选择一份说明书开始编码诊断，工具会在 Worker 中同时评估统一解码与分段诊断两种策略。
          </EmptyState>
        </Panel>
      </div>
    );
  }

  return (
    <div className="content">
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px', alignItems: 'start' }}>
        <div className="vstack" style={{ gap: 14 }}>
          <Panel
            title={record ? record.primaryFileName : '选择文件'}
            icon={<Cpu size={15} />}
            actions={
              <div className="btn-row">
                {bundle && (
                  <button
                    className="btn sm"
                    onClick={() =>
                      downloadText(bundleJson(bundle), `diagnosis-${record?.digest.slice(0, 8) ?? 'bundle'}.json`)
                    }
                  >
                    <Download size={13} /> 诊断报告
                  </button>
                )}
                <button
                  className="btn primary sm"
                  onClick={() => {
                    if (!selectedId) return;
                    void runDiagnosis(selectedId, params);
                  }}
                  disabled={analyzing}
                >
                  {analyzing ? <RefreshCw size={13} className="spin" /> : <FlaskConical size={13} />}
                  {analyzing ? '诊断中…' : '运行诊断'}
                </button>
              </div>
            }
          >
            {record && (
              <div className="split-row" style={{ marginBottom: 12 }}>
                <span className="mono muted" style={{ fontSize: 11 }}>
                  {shortHash(record.digest, 12, 8)}
                </span>
                <span className="divider-dot" />
                <span className="muted" style={{ fontSize: 11.5 }}>{formatBytes(record.byteLength)}</span>
                <span className="divider-dot" />
                <span className="chip">{record.sources.length} 来源</span>
                {lastMs !== null && <span className="chip ok">Worker {lastMs} ms</span>}
              </div>
            )}

            {analyzing && (
              <div className="vstack" style={{ gap: 6, marginBottom: 12 }}>
                <div className="split-row">
                  <span style={{ fontSize: 12 }}>{stage || '准备中…'}</span>
                  <div className="grow" />
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {Math.round(fraction * 100)}%
                  </span>
                </div>
                <div className="progress">
                  <div className="progress-fill" style={{ width: `${Math.max(4, fraction * 100)}%` }} />
                </div>
                <span className="muted" style={{ fontSize: 11 }}>
                  诊断在 Web Worker 中运行，界面保持可用。
                </span>
              </div>
            )}

            {error && (
              <Banner kind="danger">
                <AlertTriangle size={15} /> <div><b>诊断失败：</b>{error}</div>
              </Banner>
            )}

            {!bundle && !analyzing && (
              <div className="muted" style={{ fontSize: 12 }}>
                尚未运行诊断。点击“运行诊断”在 Worker 中评估两种策略。
              </div>
            )}

            {bundle && <ComparisonTable bundle={bundle} />}
          </Panel>

          {bundle && <SegmentPreview bundle={bundle} />}
        </div>

        <div className="vstack" style={{ gap: 14 }}>
          <Panel title="导入与文件" icon={<Download size={15} />}>
            <div className="vstack" style={{ gap: 6 }}>
              {imports.map((imp) => (
                <button
                  key={imp.id}
                  className={`nav-item ${imp.id === selectedId ? 'active' : ''}`}
                  onClick={() => void selectImport(imp.id)}
                  style={{ fontSize: 12 }}
                >
                  <span className="truncate" style={{ flex: 1 }}>{imp.primaryFileName}</span>
                  <span className="chip">{imp.sources.length}</span>
                </button>
              ))}
              <button className="btn sm" style={{ justifyContent: 'center' }} onClick={loadSamples} disabled={importing}>
                {importing ? <RefreshCw size={13} className="spin" /> : <Download size={13} />} 重新导入样例
              </button>
            </div>
          </Panel>

          <ParamPanel params={params} onUpdate={updateParams} onReset={resetParams} />
        </div>
      </div>
    </div>
  );
}

function bundleJson(bundle: AnalysisBundle): string {
  return JSON.stringify(bundle, null, 2);
}

function ComparisonTable({ bundle }: { bundle: AnalysisBundle }) {
  const strategy = useStore(appStore, (s) => s.activeStrategy);
  return (
    <div className="vstack" style={{ gap: 14 }}>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <StrategyCard result={bundle.uniform} recommended={bundle.recommendedStrategy === 'uniform'} />
        <StrategyCard result={bundle.segmented} recommended={bundle.recommendedStrategy === 'segmented'} />
      </div>

      <div>
        <div className="split-row" style={{ marginBottom: 8 }}>
          <GitCompareArrows size={15} />
          <span style={{ fontWeight: 620 }}>策略对比</span>
          <span className="muted" style={{ fontSize: 11.5 }}>
            统一解码简单，分段诊断能保留混合编码，但代价是更多候选与边界复核。
          </span>
        </div>
        <div className="panel" style={{ overflow: 'hidden' }}>
          <table className="cmp-table">
            <thead>
              <tr>
                <th>指标</th>
                <th>统一解码</th>
                <th>分段诊断</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {bundle.comparisonRows.map((row) => (
                <tr key={row.metric}>
                  <td className="metric">{row.metric}</td>
                  <td className="cmp-uniform">{row.uniform}</td>
                  <td className="cmp-segmented">{row.segmented}</td>
                  <td className="cmp-hint">{row.hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Banner kind={bundle.recommendedStrategy === 'segmented' ? 'info' : 'ok'}>
        <Gauge size={15} />
        <div>
          <b>建议：{bundle.recommendedStrategy === 'segmented' ? '分段诊断' : '统一解码'}。</b>{' '}
          {bundle.recommendationRationale.join(' ')}
        </div>
      </Banner>

      <div className="split-row">
        <button className="btn primary" onClick={() => void startRepairFromBundle('segmented')}>
          <ArrowRight size={14} /> 以分段结果进入修复
        </button>
        <button className="btn" onClick={() => void startRepairFromBundle('uniform')}>
          以统一解码进入修复
        </button>
        <span className="muted" style={{ fontSize: 11.5 }}>
          当前激活策略：{strategy === 'segmented' ? '分段诊断' : '统一解码'}
        </span>
      </div>
    </div>
  );
}

function StrategyCard({ result, recommended }: { result: StrategyResult; recommended: boolean }) {
  const m = result.metrics;
  return (
    <div
      className="panel"
      style={{ borderColor: recommended ? 'var(--accent-line)' : undefined }}
    >
      <div className="panel-head">
        <div className="panel-title">
          {result.strategy === 'uniform' ? '统一解码' : '分段诊断'}
          {recommended && <span className="chip indigo">推荐</span>}
        </div>
        <div className="grow" />
        <span className="mono muted" style={{ fontSize: 11 }}>{result.elapsedMs} ms</span>
      </div>
      <div className="panel-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
          <MiniStat label="区段" value={m.segmentCount} />
          <MiniStat label="编码数" value={m.distinctEncodings} />
          <MiniStat label="待裁决" value={m.pendingSegments} tone={m.pendingSegments > 0 ? 'var(--warn)' : undefined} />
          <MiniStat label="高风险边界" value={m.boundaryHighRisk} tone={m.boundaryHighRisk > 0 ? 'var(--danger)' : undefined} />
        </div>
        <div className="vstack" style={{ gap: 5 }}>
          <div className="split-row">
            <span className="muted" style={{ fontSize: 11 }}>平均置信度</span>
            <div className="grow">
              <ScoreBar score={m.meanConfidence} color={recommended ? 'var(--accent)' : 'var(--text-faint)'} />
            </div>
            <span className="mono" style={{ fontSize: 11 }}>{m.meanConfidence.toFixed(2)}</span>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            不可解符号 {m.unresolvedSymbols} · 复核工作量 {m.reviewLoad}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{ padding: '5px 8px', background: 'var(--bg-inset)', borderRadius: 'var(--radius)' }}>
      <div className="mono" style={{ fontSize: 15, fontWeight: 620, color: tone }}>{value}</div>
      <div className="muted" style={{ fontSize: 10.5 }}>{label}</div>
    </div>
  );
}

function SegmentPreview({ bundle }: { bundle: AnalysisBundle }) {
  const result = bundle.segmented;
  if (result.segments.length === 0) return null;
  return (
    <Panel title="分段预览" icon={<ShieldQuestion size={15} />}>
      <p className="muted" style={{ marginTop: 0, fontSize: 11.5 }}>
        颜色表示该区段选定候选的编码家族；斜纹表示待裁决。进入修复工作区后可逐段切换候选、移动边界并处理未决符号。
      </p>
      <SegmentStrip
        state={{
          boundaries: result.segments.slice(0, -1).map((s) => s.end),
          segments: result.segments.map((s) => ({
            id: s.id,
            start: s.start,
            end: s.end,
            kind: s.kind,
            candidates: s.candidates,
            selectedCandidateId: s.suggestedCandidateId,
            suggestedCandidateId: s.suggestedCandidateId,
            analysisConfidence: s.confidence,
            confidence: s.confidence,
            analysisStatus: s.status,
            status: s.status,
            baseConfidence: s.confidence,
            baseStatus: s.status,
            reasons: s.reasons,
            boundaryRiskIds: [],
            stale: false,
          })),
          symbolResolutions: {},
          notes: [],
          boundaryReviews: result.boundaryReviews,
          boundaryAcknowledgements: {},
          superseded: [],
        }}
        totalBytes={bundle.byteLength}
        activeId={null}
        onSelect={() => setView('repair')}
        reviews={result.boundaryReviews}
      />
      <div className="mini-table-wrap" style={{ marginTop: 12, maxHeight: 260, overflowY: 'auto' }}>
        <table className="mini-table">
          <thead>
            <tr>
              <th>区段</th>
              <th>编码</th>
              <th>状态</th>
              <th className="num">置信度</th>
            </tr>
          </thead>
          <tbody>
            {result.segments.map((s, i) => {
              const best = s.candidates.find((c) => c.id === s.suggestedCandidateId) ?? s.candidates[0];
              return (
                <tr key={s.id}>
                  <td className="mono">#{i + 1} · {s.start}–{s.end}</td>
                  <td><EncodingChip encoding={best?.encoding} short /></td>
                  <td><StatusChip status={s.status} /></td>
                  <td className="num">{s.confidence.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ParamPanel({
  params,
  onUpdate,
  onReset,
}: {
  params: typeof DEFAULT_PARAMS;
  onUpdate: (patch: Partial<typeof DEFAULT_PARAMS>) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const encodings = useMemo(() => ALL_ENCODING_IDS, []);
  return (
    <Panel
      title="诊断参数"
      icon={<Settings2 size={15} />}
      actions={
        <button className="btn ghost sm" onClick={() => setOpen((o) => !o)}>
          {open ? '收起' : '展开'}
        </button>
      }
    >
      {!open && (
        <div className="vstack" style={{ gap: 4, fontSize: 11.5 }}>
          <div className="split-row">
            <span className="muted">瓦片</span>
            <span className="mono">{params.tileBytes} B</span>
          </div>
          <div className="split-row">
            <span className="muted">置信阈值</span>
            <span className="mono">{params.confidenceThreshold.toFixed(2)}</span>
          </div>
          <div className="muted">编码：{params.enabledEncodings.map((e) => encodingLabel(e)).join('、')}</div>
        </div>
      )}
      {open && (
        <div className="vstack" style={{ gap: 10 }}>
          <div>
            <div className="field-label" style={{ marginBottom: 4 }}>候选编码</div>
            <div className="vstack" style={{ gap: 3 }}>
              {encodings.filter((e) => e !== 'utf-16le' && e !== 'utf-16be').map((enc) => (
                <label key={enc} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={params.enabledEncodings.includes(enc)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...params.enabledEncodings, enc]
                        : params.enabledEncodings.filter((x) => x !== enc);
                      onUpdate({ enabledEncodings: next });
                    }}
                  />
                  <span style={{ fontSize: 11.5 }}>{ENCODINGS[enc].label}</span>
                </label>
              ))}
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={params.includeUtf16}
                  onChange={(e) => onUpdate({ includeUtf16: e.target.checked })}
                />
                <span style={{ fontSize: 11.5 }}>包含 UTF-16 变体</span>
              </label>
            </div>
          </div>
          <label className="field">
            <span className="field-label">瓦片大小 <span className="mono">{params.tileBytes} B</span></span>
            <input
              type="range"
              min={128}
              max={2048}
              step={64}
              value={params.tileBytes}
              onChange={(e) => onUpdate({ tileBytes: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span className="field-label">置信度阈值 <span className="mono">{params.confidenceThreshold.toFixed(2)}</span></span>
            <input
              type="range"
              min={0.4}
              max={0.9}
              step={0.02}
              value={params.confidenceThreshold}
              onChange={(e) => onUpdate({ confidenceThreshold: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span className="field-label">候选差阈值 <span className="mono">{params.marginThreshold.toFixed(2)}</span></span>
            <input
              type="range"
              min={0.01}
              max={0.2}
              step={0.01}
              value={params.marginThreshold}
              onChange={(e) => onUpdate({ marginThreshold: Number(e.target.value) })}
            />
          </label>
          <button className="btn ghost sm" onClick={onReset}>恢复默认</button>
        </div>
      )}
    </Panel>
  );
}
