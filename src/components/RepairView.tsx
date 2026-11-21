import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  ClipboardList,
  CornerDownRight,
  FileText,
  History,
  Info,
  Layers3,
  MoveHorizontal,
  RotateCcw,
  Scissors,
  ShieldAlert,
  Sparkles,
  Undo2,
} from 'lucide-react';
import type { BoundaryReview, Candidate, RepairVersion, SegmentState } from '../types';
import { useStore } from '../lib/util/store';
import { activeVersion, appStore, setView, toast } from '../state/app';
import {
  acknowledgeReview,
  chooseCandidate,
  moveBoundaryTo,
  resolveSymbol,
  selectVersion,
  startRepairFromBundle,
  undoResolveSymbol,
  verifyActiveVersion,
} from '../state/actions';
import { selectedCandidate, summarizeVersion } from '../lib/repair';
import { encodingLabel } from '../lib/encoding/specs';
import { excerpt, formatBytes } from '../lib/util/bytes';
import { Banner, EmptyState, EncodingChip, Panel, ScoreBar, StatusChip } from './common';
import { SegmentStrip } from './SegmentStrip';
import { SegmentText } from './DocumentText';

type Tab = 'segments' | 'symbols' | 'boundaries' | 'history';

export function RepairView() {
  const state = useStore(appStore, (s) => s);
  const version = activeVersion(state);
  const bundle = state.selectedImportId ? state.bundles[state.selectedImportId] : null;
  const record = state.imports.find((i) => i.id === state.selectedImportId) ?? null;
  const [tab, setTab] = useState<Tab>('segments');
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [symbolTarget, setSymbolTarget] = useState<string | null>(null);

  const current = state.currentState;
  const summary = version ? summarizeVersion(version) : null;

  useEffect(() => {
    if (current && !activeSegmentId) setActiveSegmentId(current.segments[0]?.id ?? null);
  }, [current, activeSegmentId]);

  if (!record) {
    return (
      <div className="content">
        <EmptyState title="尚未选择导入文件" action={<button className="btn" onClick={() => setView('library')}>回到导入</button>}>
          修复工作区需要一个导入记录。请先在导入记录中选择说明书。
        </EmptyState>
      </div>
    );
  }

  if (!bundle) {
    return (
      <div className="content">
        <EmptyState
          title="需要先运行诊断"
          action={<button className="btn primary" onClick={() => setView('diagnose')}>前往诊断</button>}
        >
          修复工作区由诊断结果生成。请先运行诊断，再选择统一解码或分段诊断进入修复。
        </EmptyState>
      </div>
    );
  }

  if (!version || !current) {
    return (
      <div className="content">
        <Panel title="创建修复版本" icon={<Sparkles size={15} />}>
          <p className="muted" style={{ marginTop: 0 }}>
            选择一种策略作为起点。每个修复版本都会保存候选选择、未决符号裁决、边界调整与操作历史，可逐版回放与导出。
          </p>
          <div className="btn-row">
            <button className="btn primary" onClick={() => void startRepairFromBundle('segmented')}>
              <Layers3 size={14} /> 以分段诊断创建修复版本
            </button>
            <button className="btn" onClick={() => void startRepairFromBundle('uniform')}>
              以统一解码创建修复版本
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            建议：{bundle.recommendedStrategy === 'segmented' ? '分段诊断' : '统一解码'}——{bundle.recommendationRationale[0]}
          </div>
        </Panel>
      </div>
    );
  }

  const totalBytes = record.byteLength;
  const activeSegment = current.segments.find((s) => s.id === activeSegmentId) ?? current.segments[0] ?? null;

  return (
    <div className="content" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px 0' }}>
        <div className="split-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="split-row" style={{ gap: 8 }}>
            <span style={{ fontWeight: 640, fontSize: 14 }}>{record.primaryFileName}</span>
            <span className="chip indigo">v{version.seq}</span>
            <span className="chip">{version.strategy === 'segmented' ? '分段诊断' : '统一解码'}</span>
          </div>
          <div className="btn-row">
            <button className="btn sm" onClick={() => void verifyActiveVersion()}>
              <CircleDashed size={13} /> 校验完整性
            </button>
            <button className="btn sm" onClick={() => setView('archive')}>
              <FileText size={13} /> 归档与导出
            </button>
          </div>
        </div>

        {summary && summary.blocked && (
          <Banner kind="warn">
            <ShieldAlert size={15} />
            <div>
              <b>仍有未完成事项：</b>
              {summary.blockingReasons.join('；')}。这些项目会阻止无人工确认的归档。
            </div>
          </Banner>
        )}
        {summary && !summary.blocked && (
          <Banner kind="ok">
            <CheckCircle2 size={15} />
            <div>所有区段与边界均已处理。</div>
          </Banner>
        )}

        <div style={{ marginTop: 12 }}>
          <SegmentStrip
            state={current}
            totalBytes={totalBytes}
            activeId={activeSegment?.id ?? null}
            onSelect={(id) => {
              setActiveSegmentId(id);
              setTab('segments');
            }}
            reviews={current.boundaryReviews}
          />
        </div>

        <div className="split-row" style={{ marginTop: 10, fontSize: 11.5 }}>
          <Legend color="#2f7a5c" label="UTF-8" />
          <Legend color="#4b47a8" label="GBK/GB18030" />
          <Legend color="#a06a10" label="Big5" />
          <Legend color="#a63a2a" label="CP1252/Latin-1" />
          <span className="divider-dot" />
          <span className="muted">斜纹=待裁决</span>
          <div className="grow" />
          <span className="muted">
            {current.segments.length} 区段 · {summary?.unresolvedOpen ?? 0} 未决符号 ·{' '}
            {summary?.unacknowledgedHigh ?? 0} 高风险边界
          </span>
        </div>
      </div>

      <div className="tabs" style={{ marginTop: 14 }}>
        <TabButton active={tab === 'segments'} onClick={() => setTab('segments')} icon={<Layers3 size={14} />} count={current.segments.length}>
          区段与候选
        </TabButton>
        <TabButton active={tab === 'symbols'} onClick={() => setTab('symbols')} icon={<AlertTriangle size={14} />} count={summary?.unresolvedOpen}>
          未决符号
        </TabButton>
        <TabButton
          active={tab === 'boundaries'}
          onClick={() => setTab('boundaries')}
          icon={<ArrowLeftRight size={14} />}
          count={(summary?.unacknowledgedHigh ?? 0) + (summary?.unacknowledgedMedium ?? 0)}
        >
          边界复核
        </TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')} icon={<History size={14} />} count={version.seq}>
          版本与历史
        </TabButton>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', flex: 1, minHeight: 0 }}>
        <div className="tab-scroll" style={{ padding: 18 }}>
          {tab === 'segments' && activeSegment && (
            <SegmentPanel
              state={current}
              activeId={activeSegment.id}
              onFocus={setActiveSegmentId}
              onSymbol={(sym) => {
                setSymbolTarget(sym);
                setTab('symbols');
              }}
            />
          )}
          {tab === 'symbols' && (
            <SymbolsPanel
              state={current}
              target={symbolTarget}
              onTarget={setSymbolTarget}
              onGoSegment={(id) => {
                setActiveSegmentId(id);
                setTab('segments');
              }}
            />
          )}
          {tab === 'boundaries' && (
            <BoundariesPanel state={current} onFocus={(id) => { setActiveSegmentId(id); setTab('segments'); }} />
          )}
          {tab === 'history' && <HistoryPanel version={version} />}
        </div>

        <aside className="tab-scroll" style={{ padding: 16, borderLeft: '1px solid var(--line)', background: 'var(--bg-sunken)' }}>
          <SideRail version={version} summary={summary} onOpenTab={setTab} />
        </aside>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="hstack" style={{ gap: 5 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: 'inline-block' }} />
      <span className="muted">{label}</span>
    </span>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button className={`tab ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      {children}
      {typeof count === 'number' && count > 0 && <span className="count">{count}</span>}
    </button>
  );
}

/* ----------------------------- segments tab ------------------------------ */

function SegmentPanel({
  state,
  activeId,
  onFocus,
  onSymbol,
}: {
  state: NonNullable<ReturnType<typeof appStore.get>['currentState']>;
  activeId: string;
  onFocus: (id: string) => void;
  onSymbol: (symbolId: string) => void;
}) {
  return (
    <div className="vstack" style={{ gap: 16 }}>
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title"><FileText size={15} /> 文档预览</div>
          <div className="grow" />
          <span className="muted" style={{ fontSize: 11 }}>点击区段或符号开始裁决</span>
        </div>
        <div className="panel-body" style={{ maxHeight: 280, overflowY: 'auto', paddingTop: 8 }}>
          {state.segments.map((seg) => (
            <div key={seg.id} id={`doc-${seg.id}`}>
              <SegmentText
                seg={seg}
                state={state}
                dim={seg.id !== activeId}
                onSymbol={(sym) => {
                  onFocus(seg.id);
                  onSymbol(sym);
                }}
                onSelectSegment={onFocus}
              />
            </div>
          ))}
        </div>
      </div>

      {state.segments.map((seg, index) => (
        <SegmentCard
          key={seg.id}
          index={index}
          segment={seg}
          state={state}
          focused={seg.id === activeId}
          onFocus={() => onFocus(seg.id)}
          onSymbol={onSymbol}
        />
      ))}
    </div>
  );
}

function SegmentCard({
  index,
  segment,
  state,
  focused,
  onFocus,
  onSymbol,
}: {
  index: number;
  segment: SegmentState;
  state: NonNullable<ReturnType<typeof appStore.get>['currentState']>;
  focused: boolean;
  onFocus: () => void;
  onSymbol: (symbolId: string) => void;
}) {
  const selected = selectedCandidate(segment);
  const reviews = state.boundaryReviews.filter(
    (r) => r.leftSegmentId === segment.id || r.rightSegmentId === segment.id,
  );
  const blocking = reviews.filter((r) => !r.acknowledged && r.severity !== 'low');
  return (
    <div className={`seg-card ${focused ? 'focus' : ''}`} id={`seg-${segment.id}`}>
      <div className="seg-card-head" onClick={onFocus}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>#{index + 1}</span>
        <EncodingChip encoding={selected?.encoding} />
        <span className="chip square">{segment.kind === 'mojibake' ? '转码区段' : '文本区段'}</span>
        <StatusChip status={segment.status} />
        <span className="mono muted" style={{ fontSize: 11 }}>
          {segment.start}–{segment.end}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>{formatBytes(segment.end - segment.start)}</span>
        <div className="grow" />
        <div className="hstack" style={{ gap: 8 }}>
          <div style={{ width: 70 }}>
            <ScoreBar score={segment.confidence} color={segment.status === 'pending' ? 'var(--warn)' : 'var(--accent)'} />
          </div>
          <span className="mono" style={{ fontSize: 11 }}>{segment.confidence.toFixed(2)}</span>
        </div>
      </div>
      <div className="seg-card-body">
        {blocking.length > 0 && (
          <div className="banner warn" style={{ marginBottom: 8, fontSize: 11 }}>
            <ShieldAlert size={13} />
            <div>
              受相邻边界影响已降级：{blocking.map((r) => r.flags[0]).filter(Boolean).join('；')}
            </div>
          </div>
        )}
        {segment.reasons.length > 0 && (
          <div className="cand-reasons" style={{ marginBottom: 8 }}>
            {segment.reasons.map((r, i) => (
              <span key={i} className="reason-pill">{r}</span>
            ))}
          </div>
        )}
        <div className="vstack" style={{ gap: 2 }}>
          {segment.candidates.map((cand) => (
            <CandidateRow
              key={cand.id}
              candidate={cand}
              selected={cand.id === segment.selectedCandidateId}
              onChoose={() => void chooseCandidate(segment.id, cand.id)}
              onSymbol={onSymbol}
            />
          ))}
        </div>
        {selected && selected.unresolved.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="field-label" style={{ marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
              <AlertTriangle size={12} className="warn-text" /> 未决符号（{selected.unresolved.length}）
            </div>
            {selected.unresolved.map((u) => {
              const res = state.symbolResolutions[u.id];
              return (
                <div key={u.id} className="note-line" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="mono" style={{ fontSize: 10.5 }}>
                    字节 {u.start}–{u.end} · {u.bytesHex || '—'}
                  </span>
                  {res ? (
                    <span className="chip ok">已裁决 “{res.text}”</span>
                  ) : (
                    <button className="btn sm" onClick={() => onSymbol(u.id)}>
                      裁决
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <BoundaryEditor segment={segment} state={state} index={index} />
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  selected,
  onChoose,
  onSymbol,
}: {
  candidate: Candidate;
  selected: boolean;
  onChoose: () => void;
  onSymbol: (symbolId: string) => void;
}) {
  return (
    <div
      className={`cand ${selected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onChoose}
      onKeyDown={(e) => e.key === 'Enter' && onChoose()}
    >
      <div className="cand-score">
        <div className="cand-score-num">{candidate.score.score.toFixed(2)}</div>
        <div className="cand-score-bar">
          <span style={{ width: `${Math.round(candidate.score.score * 100)}%` }} />
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="cand-label">
          {selected ? <CheckCircle2 size={13} className="ok-text" /> : <CircleDashed size={13} className="muted" />}
          {candidate.label}
          <EncodingChip encoding={candidate.encoding} short />
          {candidate.kind === 'repair' && <span className="chip info">还原链</span>}
          {candidate.byteExact ? <span className="chip ok">字节精确</span> : <span className="chip warn">非精确回写</span>}
          {candidate.unresolved.length > 0 && (
            <span className="chip danger">{candidate.unresolved.length} 未决</span>
          )}
        </div>
        <div className="cand-text">{excerpt(candidate.text, 160)}</div>
        <div className="cand-reasons">
          {candidate.score.notes.slice(0, 4).map((n, i) => (
            <span key={i} className="reason-pill">{n}</span>
          ))}
          {candidate.chain.length > 1 && (
            <span className="reason-pill mono">
              {candidate.chain.map((s) => `${s.kind === 'decode' ? '↓' : '↑'}${encodingLabel(s.encoding)}`).join(' ')}
            </span>
          )}
        </div>
      </div>
      {selected && candidate.unresolved.length > 0 && (
        <span style={{ alignSelf: 'center' }}>
          <button
            className="btn ghost sm"
            onClick={(e) => {
              e.stopPropagation();
              onSymbol(candidate.unresolved[0].id);
            }}
          >
            处理符号
          </button>
        </span>
      )}
    </div>
  );
}

function BoundaryEditor({
  segment,
  state,
  index,
}: {
  segment: SegmentState;
  state: NonNullable<ReturnType<typeof appStore.get>['currentState']>;
  index: number;
}) {
  // The boundary after this segment (if not the last) can be moved.
  const isLast = index === state.segments.length - 1;
  const right = state.segments[index + 1];
  const [pos, setPos] = useState(segment.end);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => setPos(segment.end), [segment.end]);
  if (isLast) return null;
  const min = segment.start + 16;
  const max = right ? right.end - 16 : segment.end;
  return (
    <div style={{ marginTop: 10, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
      <button className="btn ghost sm" onClick={() => setOpen((o) => !o)}>
        <Scissors size={12} /> {open ? '收起边界编辑' : '重定义右侧边界'}
      </button>
      {open && (
        <div className="vstack" style={{ gap: 8, marginTop: 8 }}>
          <Banner kind="warn">
            <Info size={13} />
            <div style={{ fontSize: 11 }}>
              移动边界后，原候选选择、符号裁决与边界确认只保留为历史；新的两个范围将重新评估。
              若新范围跨越了编码切换点（例如 GBK 正文与 UTF-8 尾注之间），重新评估很可能得到更多未决符号——这正是工具需要停下等待人工裁决的情形。
            </div>
          </Banner>
          <div className="split-row">
            <span className="muted" style={{ fontSize: 11 }}>新边界</span>
            <input
              className="input mono"
              style={{ width: 110 }}
              type="number"
              min={min}
              max={max}
              value={pos}
              onChange={(e) => setPos(Number(e.target.value))}
            />
            <span className="muted mono" style={{ fontSize: 11 }}>/ 允许 {min}–{max}</span>
          </div>
          <input className="input" placeholder="变更理由（写入操作历史）" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="btn-row">
            <button
              className="btn primary sm"
              onClick={() => {
                if (!note.trim()) {
                  toast('warn', '请填写变更理由');
                  return;
                }
                if (pos < min || pos > max) {
                  toast('warn', '边界超出允许范围');
                  return;
                }
                void moveBoundaryTo(index, pos, note);
                setOpen(false);
              }}
            >
              <MoveHorizontal size={13} /> 应用并重新评估
            </button>
            <button className="btn ghost sm" onClick={() => { setPos(segment.end); setNote(''); }}>重置</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ symbols tab ------------------------------ */

function SymbolsPanel({
  state,
  target,
  onTarget,
  onGoSegment,
}: {
  state: NonNullable<ReturnType<typeof appStore.get>['currentState']>;
  target: string | null;
  onTarget: (id: string | null) => void;
  onGoSegment: (id: string) => void;
}) {
  if (target) {
    for (const seg of state.segments) {
      const cand = selectedCandidate(seg);
      const sym = cand?.unresolved.find((u) => u.id === target);
      if (sym) {
        return (
          <SymbolEditor
            segment={seg}
            symbolId={target}
            state={state}
            onBack={() => onTarget(null)}
            onGoSegment={() => onGoSegment(seg.id)}
          />
        );
      }
    }
  }
  const rows: { seg: SegmentState; symId: string; start: number; end: number; hex: string; reason: string; resolved: boolean }[] = [];
  for (const seg of state.segments) {
    const cand = selectedCandidate(seg);
    for (const u of cand?.unresolved ?? []) {
      rows.push({
        seg,
        symId: u.id,
        start: u.start,
        end: u.end,
        hex: u.bytesHex,
        reason: u.reason,
        resolved: Boolean(state.symbolResolutions[u.id]),
      });
    }
  }
  if (rows.length === 0) {
    return (
      <EmptyState icon={<CheckCircle2 size={20} />} title="没有不可解符号">
        当前版本的所有候选都能完整解码，或未决符号已被处理。工具不会凭常用词删除不可解字节。
      </EmptyState>
    );
  }
  return (
    <div className="vstack" style={{ gap: 8 }}>
      <p className="muted" style={{ marginTop: 0, fontSize: 11.5 }}>
        未决符号代表无法安全解码的连续字节。它们以原样字节范围和占位符保留，必须由人工裁决后才能归档；选择“保留占位符”也不会删除字节。
      </p>
      <div className="panel" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>区段</th>
              <th>字节范围</th>
              <th>原始字节</th>
              <th>原因</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.seg.id}-${r.symId}`}>
                <td className="mono" style={{ fontSize: 11 }}>{r.seg.start}–{r.seg.end}</td>
                <td className="mono" style={{ fontSize: 11 }}>{r.start}–{r.end}</td>
                <td className="mono" style={{ fontSize: 10.5, color: 'var(--danger)' }}>{r.hex || '—'}</td>
                <td style={{ fontSize: 11 }}>{r.reason}</td>
                <td>{r.resolved ? <span className="chip ok">已裁决</span> : <span className="chip warn">未裁决</span>}</td>
                <td>
                  <button className="btn sm" onClick={() => onTarget(r.symId)}>处理</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SymbolEditor({
  segment,
  symbolId,
  state,
  onBack,
  onGoSegment,
}: {
  segment: SegmentState;
  symbolId: string;
  state: NonNullable<ReturnType<typeof appStore.get>['currentState']>;
  onBack: () => void;
  onGoSegment: () => void;
}) {
  const cand = selectedCandidate(segment);
  const sym = cand?.unresolved.find((u) => u.id === symbolId);
  const existing = state.symbolResolutions[symbolId];
  const [text, setText] = useState(existing?.text ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  if (!sym) return null;
  return (
    <div className="vstack" style={{ gap: 12 }}>
      <div className="split-row">
        <button className="btn ghost sm" onClick={onBack}><Undo2 size={13} /> 返回列表</button>
        <button className="btn ghost sm" onClick={onGoSegment}><CornerDownRight size={13} /> 定位区段</button>
      </div>
      <Panel title="裁决不可解符号" icon={<AlertTriangle size={15} />}>
        <div className="vstack" style={{ gap: 10 }}>
          <div className="code-block">
            {`符号:    ${sym.id}\n区段:    ${segment.start}–${segment.end}\n字节:    ${sym.start}–${sym.end}\n原始字节: ${sym.bytesHex || '（无）'}\n原因:    ${sym.reason}`}
          </div>
          <label className="field">
            <span className="field-label">裁决文本</span>
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="按纸质批件补录，例如“（原件缺失）”" />
            <span className="field-hint">裁决会替换导出文本中的占位符，但原始字节和其范围始终保留在记录与证据文件中。</span>
          </label>
          <label className="field">
            <span className="field-label">依据 / 备注</span>
            <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：与 2024-08 纸质批件核对，该处原为“钠”" />
          </label>
          <div className="btn-row">
            <button
              className="btn primary"
              onClick={() => {
                if (!text.trim()) {
                  toast('warn', '请填写裁决文本');
                  return;
                }
                void resolveSymbol(segment.id, symbolId, text.trim(), note.trim());
              }}
            >
              <CheckCircle2 size={14} /> 保存裁决（新版本）
            </button>
            {existing && (
              <button className="btn danger" onClick={() => void undoResolveSymbol(symbolId)}>
                <RotateCcw size={13} /> 撤销裁决
              </button>
            )}
          </div>
          {existing && (
            <span className="muted" style={{ fontSize: 11 }}>
              当前裁决：“{existing.text}” · 版本 {existing.versionId.slice(0, 10)}… · {new Date(existing.decidedAt).toLocaleString('zh-CN')}
            </span>
          )}
        </div>
      </Panel>
    </div>
  );
}

/* ----------------------------- boundaries tab ---------------------------- */

function BoundariesPanel({
  state,
  onFocus,
}: {
  state: NonNullable<ReturnType<typeof appStore.get>['currentState']>;
  onFocus: (segmentId: string) => void;
}) {
  if (state.boundaryReviews.length === 0) {
    return (
      <EmptyState icon={<CheckCircle2 size={20} />} title="没有需要复核的边界">
        相邻区段之间没有检测到药名、剂量单位或括号的断裂风险。
      </EmptyState>
    );
  }
  return (
    <div className="vstack" style={{ gap: 12 }}>
      <p className="muted" style={{ marginTop: 0, fontSize: 11.5 }}>
        当相邻区段采用不同候选后，若药名、剂量单位或括号跨边界断裂，组合置信度会被下调并停在待裁决。确认仅记录人工判断，不会改变解码结果。
      </p>
      {state.boundaryReviews.map((review) => (
        <BoundaryCard key={review.id} review={review} onFocus={onFocus} />
      ))}
    </div>
  );
}

function BoundaryCard({ review, onFocus }: { review: BoundaryReview; onFocus: (id: string) => void }) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div className="panel">
      <div className="panel-head">
        <StatusChip status={review.severity} />
        <span className="mono" style={{ fontSize: 11.5 }}>边界 @ {review.boundary}</span>
        <div className="grow" />
        <span className="mono muted" style={{ fontSize: 11 }}>组合置信度 {review.combinedConfidence.toFixed(2)}</span>
        {review.acknowledged && <span className="chip ok">已确认</span>}
      </div>
      <div className="panel-body">
        <div className="code-block" style={{ marginBottom: 8 }}>
          {`左段末尾 …${review.leftTail}\n右段开头 ${review.rightHead}…`}
        </div>
        <div className="cand-reasons" style={{ marginBottom: 8 }}>
          {review.flags.map((f, i) => (
            <span key={i} className="reason-pill">{f}</span>
          ))}
        </div>
        <div className="split-row">
          <button className="btn ghost sm" onClick={() => onFocus(review.leftSegmentId)}>
            左段 <ChevronRight size={12} />
          </button>
          <button className="btn ghost sm" onClick={() => onFocus(review.rightSegmentId)}>
            右段 <ChevronRight size={12} />
          </button>
          <div className="grow" />
          {review.acknowledged ? (
            <span className="muted" style={{ fontSize: 11 }}>确认说明：{review.acknowledgedNote}</span>
          ) : (
            <button className="btn sm" onClick={() => setOpen((o) => !o)}>
              {open ? '收起' : '确认已人工核对'}
            </button>
          )}
        </div>
        {open && !review.acknowledged && (
          <div className="vstack" style={{ gap: 6, marginTop: 8 }}>
            <input className="input" placeholder="确认说明（必填，会写入版本历史）" value={note} onChange={(e) => setNote(e.target.value)} />
            <button
              className="btn primary sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={async () => {
                // Keep the editor open when the note is missing so the user
                // can add it without losing the panel state.
                if (!note.trim()) {
                  toast('warn', '请填写确认说明', '边界确认必须记录人工判断依据。');
                  return;
                }
                await acknowledgeReview(review.id, note);
                setOpen(false);
              }}
            >
              <CheckCircle2 size={13} /> 记录确认
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ history tab ------------------------------ */

function HistoryPanel({ version }: { version: RepairVersion }) {
  const versions = useStore(appStore, (s) => (s.selectedImportId ? s.versions[s.selectedImportId] ?? [] : []));
  const activeId = useStore(appStore, (s) => (s.selectedImportId ? s.activeVersionByImport[s.selectedImportId] : null));
  return (
    <div className="vstack" style={{ gap: 16 }}>
      <Panel title="操作历史" icon={<History size={15} />}>
        <div className="vstack" style={{ gap: 0 }}>
          {version.audit.map((step, i) => (
            <div key={i} className="note-line" style={{ alignItems: 'center', gap: 10 }}>
              <span className="mono muted" style={{ width: 22 }}>{i + 1}</span>
              <span style={{ flex: 1 }}>{step.description}</span>
              <span className="mono muted" style={{ fontSize: 10 }}>
                {step.textHashAfter.slice(0, 10)}…
              </span>
            </div>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
          每一步都记录操作前后文本哈希；导出清单中可据此回放。
        </div>
      </Panel>

      {version.state.superseded.length > 0 && (
        <Panel title="被取代的历史裁决" icon={<RotateCcw size={15} />}>
          <div className="vstack" style={{ gap: 0 }}>
            {version.state.superseded.map((s) => (
              <div key={s.id} className="note-line" style={{ flexDirection: 'column', gap: 2 }}>
                <span>{s.summary}</span>
                <span className="muted mono" style={{ fontSize: 10 }}>
                  v{s.atSeq} · 区段 {s.segmentRange[0]}–{s.segmentRange[1]}
                  {s.oldCandidateLabel ? ` · 原候选 ${s.oldCandidateLabel}` : ''}
                  {s.note ? ` · ${s.note}` : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            重新定义边界后旧裁决只保留为历史，不参与当前版本。
          </div>
        </Panel>
      )}

      <Panel title="版本链" icon={<ClipboardList size={15} />}>
        <div className="version-rail">
          {versions.map((v) => (
            <div key={v.id} className={`version-item ${v.id === activeId ? 'active' : ''}`}>
              <div className="version-dot" />
              <button onClick={() => selectVersion(v.id)}>
                <div className="version-title">
                  v{v.seq} · {v.name}
                  {v.id === version.id && <span className="chip indigo">当前</span>}
                </div>
                <div className="version-sub">
                  {v.strategy === 'segmented' ? '分段诊断' : '统一解码'} · {new Date(v.createdAt).toLocaleString('zh-CN')}
                </div>
              </button>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* -------------------------------- side rail ------------------------------ */

function SideRail({
  version,
  summary,
  onOpenTab,
}: {
  version: RepairVersion;
  summary: ReturnType<typeof summarizeVersion> | null;
  onOpenTab: (tab: Tab) => void;
}) {
  const unresolvedSegments = version.state.segments.filter((s) => {
    const c = selectedCandidate(s);
    return (c?.unresolved.length ?? 0) > 0;
  });
  return (
    <div className="vstack" style={{ gap: 14 }}>
      <div>
        <div className="field-label" style={{ marginBottom: 6 }}>版本状态</div>
        <div className="vstack" style={{ gap: 6 }}>
          <RailStat label="可归档区段" value={summary?.confident ?? 0} tone="var(--ok)" />
          <RailStat label="建议复核" value={summary?.suggested ?? 0} tone="var(--info)" />
          <RailStat label="待裁决区段" value={summary?.pending ?? 0} tone="var(--warn)" />
          <RailStat label="未裁决符号" value={summary?.unresolvedOpen ?? 0} tone={summary?.unresolvedOpen ? 'var(--danger)' : undefined} />
          <RailStat label="已裁决符号" value={summary?.unresolvedResolved ?? 0} />
          <RailStat label="高风险边界" value={summary?.unacknowledgedHigh ?? 0} tone={summary?.unacknowledgedHigh ? 'var(--danger)' : undefined} />
        </div>
      </div>

      {unresolvedSegments.length > 0 && (
        <div>
          <div className="field-label" style={{ marginBottom: 6 }}>含未决符号的区段</div>
          <div className="vstack" style={{ gap: 3 }}>
            {unresolvedSegments.map((seg) => (
              <button key={seg.id} className="nav-item" style={{ fontSize: 11.5 }} onClick={() => onOpenTab('symbols')}>
                <span className="mono">{seg.start}–{seg.end}</span>
                <div className="grow" />
                <span className="chip danger">{selectedCandidate(seg)?.unresolved.length}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="field-label" style={{ marginBottom: 6 }}>说明</div>
        <p className="muted" style={{ fontSize: 11, margin: 0, lineHeight: 1.6 }}>
          每次选择候选、移动边界或裁决符号都会生成新版本，旧版本保留以便回放与对比。未决内容不会被常用词规则自动删除。
        </p>
      </div>
    </div>
  );
}

function RailStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="split-row" style={{ justifyContent: 'space-between', fontSize: 11.5 }}>
      <span className="secondary">{label}</span>
      <span className="mono" style={{ fontWeight: 620, color: tone }}>{value}</span>
    </div>
  );
}
