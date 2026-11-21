import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Crop,
  History,
  Layers3,
  Map as MapIcon,
  MapPin,
  Rows3,
  ShieldAlert,
  Sparkles,
  Table2,
  XCircle,
} from 'lucide-react';
import type {
  AlignmentStatus,
  ConsistencyIssue,
  FieldKind,
  FieldStatus,
  LayoutBlock,
  LayoutModel,
  LayoutReviewItem,
  OrderingMode,
  Rect,
} from '../types';
import { useStore } from '../lib/util/store';
import { activeVersion, appStore, setView, toast } from '../state/app';
import { adjudicateLayout, recropAnchor } from '../state/actions';
import { reorderLayout } from '../lib/layout/engine';
import { shortHash } from '../lib/util/bytes';
import { Banner, EmptyState, Panel, StatusChip } from './common';

type Tab = 'canvas' | 'alignments' | 'fields' | 'issues' | 'queue' | 'history';

const FIELD_KIND_LABEL: Record<FieldKind, string> = {
  dosage: '剂量',
  frequency: '频次',
  unit: '单位',
  'contraindication-negation': '禁忌否定语',
  population: '适用人群',
};

const FIELD_STATUS_LABEL: Record<FieldStatus, string> = {
  verified: '已验证',
  'at-risk': '待核',
  unplaced: '未定位',
};

const ALIGN_STATUS_LABEL: Record<AlignmentStatus, string> = {
  aligned: '已对齐',
  'ambiguous-overlap': '重叠待核',
  'spans-columns': '跨列待核',
  unplaced: '未定位',
};

const ISSUE_LABEL: Record<ConsistencyIssue['code'], string> = {
  'cross-section-negation': '跨章节否定语',
  'field-region-mismatch': '字段缺少区域',
  'bare-number-dosage': '裸数字非剂量',
  'duplicate-ocr-line': 'OCR 重复行',
  'line-region-contention': '行区域竞争',
  'line-spans-columns': '行跨两列',
  'footnote-dosage': '脚注剂量',
  'table-cell-drift': '表格归属漂移',
  'anchor-stale': '锚点已变更',
};

const ROLE_TONE: Record<string, string> = {
  title: '#3d3a8c',
  heading: '#2f7a5c',
  paragraph: '#6b6657',
  column: '#4b47a8',
  table: '#a06a10',
  'table-row': '#a06a10',
  'table-cell': '#a06a10',
  footnote: '#9c2a1d',
  caption: '#1e5b78',
  header: '#6b6657',
  footer: '#6b6657',
  unknown: '#8a8375',
};

export function LayoutView() {
  const state = useStore(appStore, (s) => s);
  const version = activeVersion(state);
  const bundle = state.selectedImportId ? state.bundles[state.selectedImportId] : null;
  const record = state.imports.find((i) => i.id === state.selectedImportId) ?? null;
  const [tab, setTab] = useState<Tab>('canvas');
  const [ordering, setOrdering] = useState<OrderingMode>('geometric');
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [recropBlock, setRecropBlock] = useState<LayoutBlock | null>(null);

  const baseModel = version?.state.layout ?? bundle?.layout ?? null;
  const readOnly = !version;
  // Ordering is a view-only reordering over the immutable stored model.
  const model: LayoutModel | null = useMemo(
    () => (baseModel ? reorderLayout(baseModel, ordering) : null),
    [baseModel, ordering],
  );

  if (!record) {
    return (
      <div className="content">
        <EmptyState title="尚未选择导入文件" action={<button className="btn" onClick={() => setView('library')}>回到导入</button>}>
          版面定位需要一个导入记录。
        </EmptyState>
      </div>
    );
  }
  if (!model) {
    return (
      <div className="content">
        <Panel title="版面定位" icon={<MapIcon size={15} />}>
          <EmptyState
            title="尚无版面数据"
            action={
              <div className="btn-row">
                <button className="btn primary" onClick={() => setView('diagnose')}>运行诊断</button>
                <button className="btn" onClick={() => setView('repair')}>创建修复版本</button>
              </div>
            }
          >
            诊断会解析页面锚点（页码、区块坐标、阅读方向、图像摘要），并把 OCR 行与修复字节区段对齐。
          </EmptyState>
        </Panel>
      </div>
    );
  }

  const m = model.metrics;
  const openQueue = model.reviewQueue.filter((q) => q.status === 'queued').length;
  const selectedPage = model.pages[0];
  const selectedBlock =
    selectedPage.blocks.find((b) => b.id === selectedBlockId) ?? selectedPage.blocks[0] ?? null;

  return (
    <div className="content">
      <div className="vstack" style={{ gap: 14 }}>
        <Panel
          title={`版面锚点与字段定位 · ${record.primaryFileName}`}
          icon={<MapIcon size={15} />}
          actions={
            <div className="hstack" style={{ gap: 8 }}>
              <div className="seg-toggle">
                <button className={ordering === 'linear' ? 'active' : ''} onClick={() => setOrdering('linear')}>
                  线性排序（上→下/左→右）
                </button>
                <button className={ordering === 'geometric' ? 'active' : ''} onClick={() => setOrdering('geometric')}>
                  几何约束排序
                </button>
              </div>
            </div>
          }
        >
          {readOnly && (
            <Banner kind="info">
              <AlertTriangle size={15} />
              <div>当前为只读预览（尚未创建修复版本）。复核裁决与重新裁剪需要先进入修复工作区建立版本。</div>
            </Banner>
          )}
          <div className="stat-row" style={{ marginTop: 10 }}>
            <Metric label="页面" value={m.pageCount} />
            <Metric label="区块" value={m.blockCount} />
            <Metric label="OCR 行" value={m.ocrLineCount} />
            <Metric label="重复行" value={m.duplicateOcrLines} tone={m.duplicateOcrLines ? 'var(--warn)' : undefined} />
            <Metric label="跨列待核" value={m.spanningLines} tone={m.spanningLines ? 'var(--danger)' : undefined} />
            <Metric label="重叠待核" value={m.ambiguousLines} tone={m.ambiguousLines ? 'var(--danger)' : undefined} />
            <Metric label="字段" value={m.fieldCount} />
            <Metric label="待核字段" value={m.fieldsAtRisk} tone={m.fieldsAtRisk ? 'var(--warn)' : undefined} />
            <Metric label="复核队列" value={openQueue} tone={openQueue ? 'var(--danger)' : 'var(--ok)'} />
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            双栏页 {m.twoColumnPages} · 表格区块 {m.tableBlocks} · 脚注区块 {m.footnoteBlocks} · 排序规则：
            {ordering === 'linear' ? '固定上到下、左到右（双栏/表格可能误排）' : '区块几何与阅读顺序约束（求解栏间歧义）'}
          </div>
        </Panel>

        <div className="tabs">
          <TabButton active={tab === 'canvas'} onClick={() => setTab('canvas')} icon={<Layers3 size={14} />}>页面区块</TabButton>
          <TabButton active={tab === 'alignments'} onClick={() => setTab('alignments')} icon={<Rows3 size={14} />} count={m.ambiguousLines + m.spanningLines}>行对齐</TabButton>
          <TabButton active={tab === 'fields'} onClick={() => setTab('fields')} icon={<MapPin size={14} />} count={m.fieldsAtRisk}>字段证据</TabButton>
          <TabButton active={tab === 'issues'} onClick={() => setTab('issues')} icon={<ShieldAlert size={14} />} count={model.issues.length}>一致性问题</TabButton>
          <TabButton active={tab === 'queue'} onClick={() => setTab('queue')} icon={<AlertTriangle size={14} />} count={openQueue}>复核队列</TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')} icon={<History size={14} />} count={model.anchorRevisions.length}>锚点历史</TabButton>
        </div>

        {tab === 'canvas' && (
          <CanvasPanel
            model={model}
            selectedBlockId={selectedBlock?.id ?? null}
            onSelect={setSelectedBlockId}
            onRecrop={readOnly ? undefined : setRecropBlock}
          />
        )}
        {tab === 'alignments' && <AlignmentsPanel model={model} />}
        {tab === 'fields' && <FieldsPanel model={model} />}
        {tab === 'issues' && <IssuesPanel model={model} />}
        {tab === 'queue' && (
          <QueuePanel model={model} readOnly={readOnly} onGo={() => setTab('fields')} />
        )}
        {tab === 'history' && <HistoryPanel model={model} />}
      </div>

      {recropBlock && (
        <RecropDialog
          block={recropBlock}
          onClose={() => setRecropBlock(null)}
          onSubmit={(rect, note) => {
            void recropAnchor(recropBlock.pageId, recropBlock.id, rect, note).then(() => {
              setRecropBlock(null);
              setTab('queue');
            });
          }}
        />
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{ padding: '6px 10px', background: 'var(--bg-inset)', borderRadius: 'var(--radius)', minWidth: 74 }}>
      <div className="mono" style={{ fontSize: 16, fontWeight: 640, color: tone }}>{value}</div>
      <div className="muted" style={{ fontSize: 10.5 }}>{label}</div>
    </div>
  );
}

function TabButton({ active, onClick, icon, count, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; count?: number; children: React.ReactNode }) {
  return (
    <button className={`tab ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      {children}
      {typeof count === 'number' && count > 0 && <span className="count">{count}</span>}
    </button>
  );
}

/* -------------------------------- canvas --------------------------------- */

function CanvasPanel({
  model,
  selectedBlockId,
  onSelect,
  onRecrop,
}: {
  model: LayoutModel;
  selectedBlockId: string | null;
  onSelect: (id: string) => void;
  onRecrop?: (block: LayoutBlock) => void;
}) {
  const page = model.pages[0];
  const blocksById = new Map(page.blocks.map((b) => [b.id, b]));
  const linesByPage = model.ocrLines.filter((l) => l.pageId === page.id);
  const alignByLine = new Map(model.alignments.map((a) => [a.ocrLineId, a]));
  const block = selectedBlockId ? blocksById.get(selectedBlockId) ?? null : null;
  const pct = (v: number, dim: number) => `${(v / dim) * 100}%`;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 320px', alignItems: 'start' }}>
      <Panel title={`第 ${page.pageNumber} 页 · ${page.pageSize.width}×${page.pageSize.height} · 方向 ${page.direction.toUpperCase()}`} icon={<Layers3 size={15} />}>
        <div className="page-canvas" style={{ aspectRatio: `${page.pageSize.width} / ${page.pageSize.height}` }}>
          {page.columnGutters.map((g, i) => (
            <div key={i} className="column-gutter" style={{ left: pct(g, page.pageSize.width) }} />
          ))}
          {page.blocks.map((b) => (
            <button
              key={b.id}
              className={`layout-block ${b.id === selectedBlockId ? 'selected' : ''}`}
              style={{
                left: pct(b.rect.x, page.pageSize.width),
                top: pct(b.rect.y, page.pageSize.height),
                width: pct(b.rect.width, page.pageSize.width),
                height: pct(b.rect.height, page.pageSize.height),
                borderColor: ROLE_TONE[b.role] ?? 'var(--line-strong)',
              }}
              onClick={() => onSelect(b.id)}
              title={`${b.id} · ${b.role}${b.section ? ` · ${b.section}` : ''}`}
            >
              <span className="layout-block-label" style={{ background: ROLE_TONE[b.role] ?? 'var(--text-faint)' }}>
                {b.id} · {b.role}
              </span>
            </button>
          ))}
          {linesByPage.map((l) => {
            const alignment = alignByLine.get(l.id);
            const tone =
              alignment?.status === 'aligned' ? 'var(--ok)' : alignment?.status === 'unplaced' ? 'var(--text-faint)' : 'var(--danger)';
            return (
              <div
                key={l.id}
                className="ocr-line"
                style={{
                  left: pct(l.rect.x, page.pageSize.width),
                  top: pct(l.rect.y, page.pageSize.height),
                  width: pct(l.rect.width, page.pageSize.width),
                  height: pct(l.rect.height, page.pageSize.height),
                  outlineColor: tone,
                }}
                title={`${l.id} · ${ALIGN_STATUS_LABEL[alignment?.status ?? 'unplaced']}`}
              />
            );
          })}
        </div>
        <div className="hstack" style={{ gap: 12, marginTop: 10, flexWrap: 'wrap', fontSize: 11 }}>
          <Legend tone="var(--ok)" label="已对齐 OCR 行" />
          <Legend tone="var(--danger)" label="重叠/跨列待核" />
          <Legend tone="var(--text-faint)" label="未定位" />
          <span className="muted">点击区块查看坐标、图像摘要并可重新裁剪。</span>
        </div>
      </Panel>

      <Panel title={block ? `区块 ${block.id}` : '区块详情'} icon={<Table2 size={15} />}>
        {!block ? (
          <div className="muted" style={{ fontSize: 12 }}>请在左侧选择一个区块。</div>
        ) : (
          <div className="vstack" style={{ gap: 10 }}>
            <DetailRow k="角色" v={block.role} />
            <DetailRow k="章节" v={block.section || '（无章节标题）'} />
            <DetailRow k="页码" v={String(block.pageNumber)} />
            <DetailRow k="列" v={block.column < 0 ? '跨栏' : String(block.column)} />
            <DetailRow k="阅读序" v={String(block.order)} />
            <DetailRow k="坐标" v={`${block.rect.x}, ${block.rect.y} · ${block.rect.width}×${block.rect.height}`} mono />
            <DetailRow k="前驱/后继" v={`${block.prevBlockId ?? '—'} → ${block.nextBlockId ?? '—'}`} mono />
            <div>
              <div className="field-label">图像摘要（8×8 亮度）</div>
              <ThumbnailGrid values={block.imageDigest.thumbnail} />
              <div className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>
                sha256 {shortHash(block.imageDigest.sha256, 12, 8)} · 均值 {block.imageDigest.meanLuminance}
              </div>
            </div>
            {onRecrop && (
              <button className="btn primary sm" onClick={() => onRecrop(block)}>
                <Crop size={13} /> 重新裁剪该区域
              </button>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="hstack" style={{ gap: 5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, border: `2px solid ${tone}`, display: 'inline-block' }} />
      <span className="muted">{label}</span>
    </span>
  );
}

function DetailRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="split-row" style={{ fontSize: 11.5 }}>
      <span className="muted">{k}</span>
      <span className={mono ? 'mono' : ''} style={{ textAlign: 'right' }}>{v}</span>
    </div>
  );
}

function ThumbnailGrid({ values }: { values: number[] }) {
  return (
    <div className="thumb-grid">
      {values.map((v, i) => (
        <span key={i} style={{ background: `rgb(${v},${v},${v})` }} />
      ))}
    </div>
  );
}

/* ------------------------------- alignments ------------------------------ */

function AlignmentsPanel({ model }: { model: LayoutModel }) {
  const linesById = new Map(model.ocrLines.map((l) => [l.id, l]));
  const rows = model.alignments;
  if (rows.length === 0) return <EmptyState title="没有行对齐数据" />;
  return (
    <Panel title="OCR 行 → 区块对齐" icon={<Rows3 size={15} />}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>OCR 行</th><th>文本</th><th>字节区段</th><th>候选区块（重叠分）</th><th>状态</th></tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const line = linesById.get(a.ocrLineId);
              return (
                <tr key={a.id} className={a.status === 'aligned' ? '' : 'row-warn'}>
                  <td className="mono" style={{ fontSize: 11 }}>{a.ocrLineId}{line?.duplicateOf ? ` ↔ ${line.duplicateOf}` : ''}</td>
                  <td style={{ maxWidth: 260 }}>{line?.text}</td>
                  <td className="mono" style={{ fontSize: 10.5 }}>{a.byteRange[0]}–{a.byteRange[1]}{a.segmentId ? ` · ${a.segmentId}` : ''}</td>
                  <td className="mono" style={{ fontSize: 10.5 }}>
                    {a.candidateBlockIds.map((id) => `${id}(${a.overlapScores[id]?.toFixed(2)})`).join('、') || '—'}
                  </td>
                  <td>
                    <StatusPill status={a.status} label={ALIGN_STATUS_LABEL[a.status]} />
                    {a.flags.length > 0 && <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>{a.flags.join('；')}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* --------------------------------- fields -------------------------------- */

function FieldsPanel({ model }: { model: LayoutModel }) {
  const [kind, setKind] = useState<FieldKind | 'all'>('all');
  const rows = model.fields.filter((f) => kind === 'all' || f.kind === kind);
  const kinds: FieldKind[] = ['dosage', 'frequency', 'unit', 'contraindication-negation', 'population'];
  return (
    <Panel
      title="关键字段证据（数字必须带单位且有页面区域背书）"
      icon={<MapPin size={15} />}
      actions={
        <select className="input" style={{ width: 150 }} value={kind} onChange={(e) => setKind(e.target.value as FieldKind | 'all')}>
          <option value="all">全部字段</option>
          {kinds.map((k) => <option key={k} value={k}>{FIELD_KIND_LABEL[k]}</option>)}
        </select>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>类型</th><th>字段文本</th><th>数值/单位</th><th>章节</th><th>页面区域</th><th>邻接文本</th><th>状态</th></tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} className={f.status === 'verified' ? '' : 'row-warn'}>
                <td>{FIELD_KIND_LABEL[f.kind]}</td>
                <td style={{ maxWidth: 200 }}>{f.text}</td>
                <td className="mono" style={{ fontSize: 10.5 }}>{f.numericValue ?? '—'}{f.unit ? ` ${f.unit}` : ''}</td>
                <td style={{ fontSize: 11 }}>{f.section || '—'}</td>
                <td className="mono" style={{ fontSize: 10.5 }}>
                  {f.blockId ? `p${f.pageNumber} · ${f.blockId}` : '无区域'}
                  {f.ocrLineId ? <div className="muted">{f.ocrLineId}</div> : null}
                </td>
                <td style={{ maxWidth: 240, fontSize: 11 }} className="muted">{f.adjacentText}</td>
                <td>
                  <StatusPill status={f.status} label={FIELD_STATUS_LABEL[f.status]} />
                  {f.reasons.length > 0 && <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>{f.reasons.join('；')}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* --------------------------------- issues -------------------------------- */

function IssuesPanel({ model }: { model: LayoutModel }) {
  return (
    <Panel title="一致性校验（邻接文本 / 章节归属 / 图像区域）" icon={<ShieldAlert size={15} />}>
      <div className="vstack" style={{ gap: 8 }}>
        {model.issues.map((i) => (
          <div key={i.id} className={`issue-card sev-${i.severity}`}>
            <div className="split-row">
              <span className="chip">{ISSUE_LABEL[i.code]}</span>
              <StatusChip status={i.severity} />
              <span className="mono muted" style={{ fontSize: 10.5 }}>
                {i.pageNumber ? `p${i.pageNumber} · ` : ''}{i.blockId ?? i.alignmentId ?? i.fieldId ?? ''}
              </span>
            </div>
            <div style={{ fontSize: 12, marginTop: 4 }}>{i.message}</div>
            {i.evidence.length > 0 && (
              <div className="code-block" style={{ marginTop: 6, fontSize: 10.5 }}>
                {i.evidence.map((e, idx) => <div key={idx}>· {e}</div>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* --------------------------------- queue --------------------------------- */

function QueuePanel({ model, readOnly, onGo }: { model: LayoutModel; readOnly: boolean; onGo: () => void }) {
  const issuesById = new Map(model.issues.map((i) => [i.id, i]));
  if (model.reviewQueue.length === 0) {
    return <EmptyState icon={<CheckCircle2 size={20} />} title="复核队列为空">只有高风险定位会进入复核队列；当前没有待处理项。</EmptyState>;
  }
  return (
    <Panel title="复核队列（仅接收高风险定位）" icon={<AlertTriangle size={15} />}>
      <div className="vstack" style={{ gap: 10 }}>
        {model.reviewQueue.map((q) => (
          <QueueCard key={q.id} item={q} model={model} issuesById={issuesById} readOnly={readOnly} onGo={onGo} />
        ))}
      </div>
    </Panel>
  );
}

function QueueCard({
  item,
  model,
  issuesById,
  readOnly,
  onGo,
}: {
  item: LayoutReviewItem;
  model: LayoutModel;
  issuesById: Map<string, ConsistencyIssue>;
  readOnly: boolean;
  onGo: () => void;
}) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const field = item.fieldId ? model.fields.find((f) => f.id === item.fieldId) ?? null : null;
  return (
    <div className={`issue-card sev-high ${item.status === 'queued' ? '' : 'resolved'}`}>
      <div className="split-row">
        <span className="mono" style={{ fontSize: 11 }}>{item.id}</span>
        <span className="chip danger">高风险</span>
        {item.status === 'queued' ? <span className="chip warn">待复核</span> : <span className="chip ok">{item.status === 'confirmed' ? '已确认' : '已驳回'}</span>}
        {item.pageId && <span className="mono muted" style={{ fontSize: 10.5 }}>{item.blockId ?? ''}</span>}
      </div>
      {field && (
        <div style={{ fontSize: 12, marginTop: 4 }}>
          {FIELD_KIND_LABEL[field.kind]}：<b>{field.text}</b>
          <span className="muted">（{field.section || '无章节'} · 邻接：{field.adjacentText}）</span>
        </div>
      )}
      <div className="cand-reasons" style={{ marginTop: 6 }}>
        {item.issueIds.map((id) => {
          const issue = issuesById.get(id);
          return issue ? <span key={id} className="reason-pill">{ISSUE_LABEL[issue.code]}</span> : null;
        })}
      </div>
      {item.decisionNote && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>裁决说明：{item.decisionNote}</div>}
      {!readOnly && item.status === 'queued' && (
        <>
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setOpen((o) => !o)}>
            {open ? '收起' : '人工复核'}
          </button>
          {open && (
            <div className="vstack" style={{ gap: 6, marginTop: 8 }}>
              <textarea className="textarea" placeholder="复核依据（必填，写入版本历史）" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="btn-row">
                <button
                  className="btn primary sm"
                  onClick={() => {
                    if (!note.trim()) return toast('warn', '请填写复核依据');
                    void adjudicateLayout(item.id, 'confirmed', note.trim()).then(() => { setOpen(false); setNote(''); onGo(); });
                  }}
                >
                  <CheckCircle2 size={13} /> 确认定位
                </button>
                <button
                  className="btn danger sm"
                  onClick={() => {
                    if (!note.trim()) return toast('warn', '请填写复核依据');
                    void adjudicateLayout(item.id, 'rejected', note.trim()).then(() => { setOpen(false); setNote(''); });
                  }}
                >
                  <XCircle size={13} /> 驳回定位
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------- history -------------------------------- */

function HistoryPanel({ model }: { model: LayoutModel }) {
  if (model.anchorRevisions.length === 0) {
    return <EmptyState icon={<Crop size={20} />} title="尚无锚点修订">重新裁剪页面区域后，旧确认会作为历史证据保留在这里，新锚点必须重新校验。</EmptyState>;
  }
  return (
    <Panel title="锚点修订历史（旧确认仅作历史证据）" icon={<History size={15} />}>
      <div className="vstack" style={{ gap: 10 }}>
        {model.anchorRevisions.map((r) => (
          <div key={r.id} className="issue-card sev-medium">
            <div className="split-row">
              <span className="mono" style={{ fontSize: 11 }}>{r.blockId} · {r.pageId}</span>
              <span className="mono muted" style={{ fontSize: 10.5 }}>{r.createdAt}</span>
            </div>
            <div className="mono" style={{ fontSize: 11, marginTop: 4 }}>
              坐标 {r.oldRect.x},{r.oldRect.y} {r.oldRect.width}×{r.oldRect.height} → {r.newRect.x},{r.newRect.y} {r.newRect.width}×{r.newRect.height}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>理由：{r.note}</div>
            <div className="muted" style={{ fontSize: 10.5, marginTop: 4 }}>
              图像摘要 {shortHash(r.oldImageDigest.sha256, 10, 6)} → {shortHash(r.newImageDigest.sha256, 10, 6)}
            </div>
            {r.priorDecisions.length > 0 && (
              <div className="code-block" style={{ marginTop: 6, fontSize: 10.5 }}>
                {r.priorDecisions.map((d) => (
                  <div key={d.queueId}>· 旧确认 {d.queueId}（{d.decision === 'confirmed' ? '确认' : '驳回'}）：{d.note}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ------------------------------- recrop ---------------------------------- */

function RecropDialog({
  block,
  onClose,
  onSubmit,
}: {
  block: LayoutBlock;
  onClose: () => void;
  onSubmit: (rect: Rect, note: string) => void;
}) {
  const [rect, setRect] = useState<Rect>({ ...block.rect });
  const [note, setNote] = useState('');
  const set = (key: keyof Rect, v: number) => setRect((r) => ({ ...r, [key]: v }));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="panel modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title"><Crop size={16} /> 重新裁剪区块 {block.id}</div>
          <div className="grow" />
          <button className="btn ghost sm" onClick={onClose}>关闭</button>
        </div>
        <div className="panel-body">
          <Banner kind="warn">
            <AlertTriangle size={13} />
            <div style={{ fontSize: 11.5 }}>
              重新裁剪后，旧几何与图像摘要、此前的人工确认都只保留为历史证据；依赖该锚点的对齐与字段会重新校验，相关复核项重新入队。
            </div>
          </Banner>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
            {(['x', 'y', 'width', 'height'] as const).map((key) => (
              <label className="field" key={key}>
                <span className="field-label">{key}</span>
                <input className="input mono" type="number" value={rect[key]} onChange={(e) => set(key, Number(e.target.value))} />
              </label>
            ))}
          </div>
          <label className="field" style={{ marginTop: 10 }}>
            <span className="field-label">裁剪理由（必填）</span>
            <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：纸质件扫描偏移，左栏右边界应内缩 10px" />
          </label>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button
              className="btn primary"
              onClick={() => {
                if (!note.trim()) return toast('warn', '请填写裁剪理由');
                if (rect.width <= 0 || rect.height <= 0) return toast('warn', '宽高必须为正数');
                onSubmit(rect, note.trim());
              }}
            >
              <Sparkles size={14} /> 应用并重新校验
            </button>
            <button className="btn ghost" onClick={onClose}>取消</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ small pills ------------------------------ */

function StatusPill({ status, label }: { status: string; label: string }) {
  const cls =
    status === 'aligned' || status === 'verified'
      ? 'chip ok'
      : status === 'unplaced'
        ? 'chip'
        : 'chip danger';
  return <span className={cls}>{label}</span>;
}
