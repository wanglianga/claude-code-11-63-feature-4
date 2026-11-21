import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileArchive,
  Fingerprint,
  History,
  Package,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';
import type { RepairVersion } from '../types';
import { useStore } from '../lib/util/store';
import { activeVersion, appStore, setView, toast } from '../state/app';
import { downloadText, runExport, selectVersion, verifyActiveVersion } from '../state/actions';
import { exportVersion } from '../lib/export';
import { selectedCandidate, segmentText, summarizeVersion, verifyVersion } from '../lib/repair';
import { encodingLabel } from '../lib/encoding/specs';
import { bytesToHex, formatBytes, formatDateTime, shortHash } from '../lib/util/bytes';
import { getImportBytes } from '../lib/db';
import { Banner, EmptyState, EncodingChip, Panel, StatusChip } from './common';

export function ArchiveView() {
  const state = useStore(appStore, (s) => s);
  const version = activeVersion(state);
  const record = state.imports.find((i) => i.id === state.selectedImportId) ?? null;
  const versions = state.selectedImportId ? state.versions[state.selectedImportId] ?? [] : [];
  const report = state.verification;
  const lastExport = state.lastExport;
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [openSegment, setOpenSegment] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!version) return;
    void getImportBytes(version.digest).then((b) => {
      if (alive) setBytes(b);
    });
    return () => {
      alive = false;
    };
  }, [version]);

  const preview = useMemo(() => {
    if (!version || !record || !bytes) return null;
    return exportVersion(version, record, bytes, { ...state.exportOptions });
  }, [version, record, bytes, state.exportOptions]);

  if (!record) {
    return (
      <div className="content">
        <EmptyState title="尚未选择文件" action={<button className="btn" onClick={() => setView('library')}>回到导入</button>} />
      </div>
    );
  }
  if (!version) {
    return (
      <div className="content">
        <EmptyState
          title="尚无修复版本可归档"
          action={<button className="btn primary" onClick={() => setView('repair')}>创建修复版本</button>}
        >
          修复版本创建后才能查看解码证据、回查原字节范围并导出可复现归档包。
        </EmptyState>
      </div>
    );
  }

  const summary = summarizeVersion(version);
  const localReport = bytes ? verifyVersion({ version, bytes, digest: version.digest }) : null;

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('success', `${label}已复制`);
    } catch {
      toast('warn', '无法访问剪贴板');
    }
  }

  return (
    <div className="content">
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px', alignItems: 'start' }}>
        <div className="vstack" style={{ gap: 14 }}>
          <Panel
            title="归档摘要"
            icon={<Archive size={15} />}
            actions={
              <div className="btn-row">
                <button className="btn sm" onClick={() => void verifyActiveVersion()}>
                  <ShieldCheck size={13} /> 校验
                </button>
                <button className="btn primary sm" onClick={() => void runExport()}>
                  <Package size={13} /> 导出归档包
                </button>
              </div>
            }
          >
            <div className="stat-row" style={{ marginBottom: 12 }}>
              <SummaryStat label="版本" value={`v${version.seq}`} />
              <SummaryStat label="区段" value={version.state.segments.length} />
              <SummaryStat label="字节" value={formatBytes(record.byteLength)} />
              <SummaryStat label="来源" value={record.sources.length} />
            </div>

            {summary.blocked ? (
              <Banner kind="warn">
                <ShieldX size={15} />
                <div>
                  <b>归档未完成：</b>
                  {summary.blockingReasons.join('；')}。导出包会标注这些未完成项。
                </div>
              </Banner>
            ) : (
              <Banner kind="ok">
                <ShieldCheck size={15} />
                <div>所有区段、边界与未决符号已处理，可归档。</div>
              </Banner>
            )}

            <div className="hr" style={{ margin: '12px 0' }} />

            <dl className="kv">
              <dt>文件摘要</dt>
              <dd className="mono">{record.digest}</dd>
              <dt>版本状态哈希</dt>
              <dd className="mono">{version.stateHash}</dd>
              <dt>原始 SHA-256 校验</dt>
              <dd>
                {localReport?.digestMatches ? (
                  <span className="ok-text">一致</span>
                ) : (
                  <span className="danger-text">不一致</span>
                )}
              </dd>
              <dt>区段覆盖</dt>
              <dd>
                {localReport?.segmentsCoverFile ? (
                  <span className="ok-text">完整覆盖 0 → {record.byteLength}</span>
                ) : (
                  <span className="danger-text">{(localReport?.coverageIssues ?? []).join('；')}</span>
                )}
              </dd>
              <dt>导出清单哈希</dt>
              <dd className="mono">
                {preview ? (
                  <CopyLine text={preview.manifestHash} onCopy={() => copy(preview.manifestHash, '清单哈希')} />
                ) : (
                  '计算中…'
                )}
              </dd>
              <dt>ZIP 哈希</dt>
              <dd className="mono">
                {preview ? (
                  <CopyLine text={preview.zipHash} onCopy={() => copy(preview.zipHash, 'ZIP 哈希')} />
                ) : (
                  '计算中…'
                )}
              </dd>
            </dl>

            {report && (
              <div className="hstack" style={{ marginTop: 10, fontSize: 11 }}>
                <span className={report.digestMatches ? 'ok-text' : 'danger-text'}>
                  {report.digestMatches ? '摘要一致' : '摘要不一致'}
                </span>
                <span className="divider-dot" />
                <span className={report.segmentsCoverFile ? 'ok-text' : 'danger-text'}>
                  {report.segmentsCoverFile ? '区段完整' : '区段有缺口'}
                </span>
                <span className="divider-dot" />
                <span className={report.stateHashMatches ? 'ok-text' : 'danger-text'}>
                  {report.stateHashMatches ? '状态哈希一致' : '状态哈希不符'}
                </span>
              </div>
            )}
          </Panel>

          <Panel title="导出内容预览" icon={<FileArchive size={15} />}>
            <div className="vstack" style={{ gap: 10 }}>
              <div className="split-row" style={{ fontSize: 11.5 }}>
                <span className="mono">{preview?.fileNameBase ?? '—'}.zip</span>
                {preview && <span className="chip">{formatBytes(preview.zip.length)}</span>}
                <div className="grow" />
                <button className="btn ghost sm" onClick={() => preview && copy(preview.manifestText, '清单')}>
                  <Copy size={12} /> 复制 manifest
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => preview && downloadText(preview.repairedText, `${preview.fileNameBase}.txt`, 'text/plain')}
                >
                  <Download size={12} /> 纯文本
                </button>
              </div>
              <div className="code-block" style={{ maxHeight: 220, overflowY: 'auto' }}>
                {preview ? preview.evidenceText.slice(0, 2400) : '生成中…'}
              </div>
              <div className="muted" style={{ fontSize: 11 }}>
                归档包含 manifest.json、repaired.txt、evidence.md、README.txt 与 original.bin（可选）。导出为确定性 ZIP：同样的版本重复导出会得到相同字节。
              </div>
            </div>
          </Panel>

          <Panel title="从修复版本回查原字节范围" icon={<Fingerprint size={15} />} flush>
            <div style={{ maxHeight: 460, overflowY: 'auto' }}>
              {version.state.segments.map((seg, i) => {
                const cand = selectedCandidate(seg);
                const open = openSegment === seg.id;
                return (
                  <div key={seg.id} style={{ borderBottom: '1px solid var(--line)' }}>
                    <button
                      className="split-row"
                      style={{
                        width: '100%',
                        background: 'none',
                        border: 'none',
                        padding: '9px 14px',
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                      }}
                      onClick={() => setOpenSegment(open ? null : seg.id)}
                    >
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <span className="mono" style={{ fontSize: 11 }}>#{i + 1}</span>
                      <span className="range-badge">{seg.start}–{seg.end}</span>
                      <EncodingChip encoding={cand?.encoding} short />
                      <span className="muted" style={{ fontSize: 11 }}>{cand?.label}</span>
                      <div className="grow" />
                      <StatusChip status={seg.status} />
                      <span className="mono muted" style={{ fontSize: 11 }}>{seg.confidence.toFixed(2)}</span>
                    </button>
                    {open && (
                      <div style={{ padding: '0 14px 14px 34px' }}>
                        <div className="vstack" style={{ gap: 8 }}>
                          <dl className="kv" style={{ fontSize: 11.5 }}>
                            <dt>解码链</dt>
                            <dd className="mono">
                              {cand?.chain.map((s) => `${s.kind === 'decode' ? 'decode' : 'encode'} ${encodingLabel(s.encoding)}`).join(' → ')}
                            </dd>
                            <dt>字节精确回写</dt>
                            <dd>{cand?.byteExact ? '是' : `否${cand?.byteExactNote ? `（${cand.byteExactNote}）` : ''}`}</dd>
                            <dt>术语命中</dt>
                            <dd>{cand?.score.lexiconHits.join('、') || '—'}</dd>
                            <dt>备用候选</dt>
                            <dd>
                              {seg.candidates
                                .filter((c) => c.id !== seg.selectedCandidateId)
                                .slice(0, 3)
                                .map((c) => `${c.label} (${c.score.score.toFixed(2)})`)
                                .join(' · ') || '—'}
                            </dd>
                          </dl>
                          {bytes && (
                            <HexWindow bytes={bytes} start={seg.start} end={seg.end} />
                          )}
                          {cand && cand.unresolved.length > 0 && (
                            <div>
                              <div className="field-label" style={{ marginBottom: 4 }}>未决符号</div>
                              {cand.unresolved.map((u) => {
                                const res = version.state.symbolResolutions[u.id];
                                return (
                                  <div key={u.id} className="note-line" style={{ justifyContent: 'space-between' }}>
                                    <span className="mono" style={{ fontSize: 10.5 }}>
                                      {u.start}–{u.end} · {u.bytesHex || '—'} · {u.reason}
                                    </span>
                                    <span className={res ? 'chip ok' : 'chip warn'}>
                                      {res ? `已裁决 “${res.text}”` : '未裁决'}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div className="code-block" style={{ maxHeight: 120, overflowY: 'auto' }}>
                            {segmentText(seg, version.state).slice(0, 400)}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>

        <div className="vstack" style={{ gap: 14 }}>
          <Panel title="导出版本" icon={<History size={15} />}>
            <div className="vstack" style={{ gap: 4 }}>
              {versions.map((v) => (
                <VersionChoice
                  key={v.id}
                  version={v}
                  active={v.id === version.id}
                  onSelect={() => selectVersion(v.id)}
                />
              ))}
            </div>
          </Panel>

          <ExportOptionsPanel />

          <Panel title="导出记录" icon={<Download size={15} />}>
            {lastExport ? (
              <div className="vstack" style={{ gap: 6, fontSize: 11.5 }}>
                <div className="mono">{lastExport.fileNameBase}.zip</div>
                <div className="muted">清单哈希 {shortHash(lastExport.manifestHash, 12, 8)}</div>
                <div className="muted">ZIP 哈希 {shortHash(lastExport.zipHash, 12, 8)}</div>
                <button
                  className="btn sm"
                  onClick={() => downloadText(lastExport.manifestText, `${lastExport.fileNameBase}.manifest.json`)}
                >
                  <Download size={12} /> 下载清单
                </button>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 11.5 }}>尚未导出。导出会记录清单与 ZIP 哈希以便复核。</div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="stat-value" style={{ fontSize: 18 }}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function CopyLine({ text, onCopy }: { text: string; onCopy: () => void }) {
  return (
    <span className="hstack" style={{ gap: 6 }}>
      <span className="truncate" style={{ maxWidth: 240 }}>{text}</span>
      <button className="btn ghost sm icon-only" onClick={onCopy} title="复制">
        <Copy size={11} />
      </button>
    </span>
  );
}

function VersionChoice({
  version,
  active,
  onSelect,
}: {
  version: RepairVersion;
  active: boolean;
  onSelect: () => void;
}) {
  const summary = summarizeVersion(version);
  return (
    <button
      className={`nav-item ${active ? 'active' : ''}`}
      onClick={onSelect}
      style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 2 }}
    >
      <span className="hstack" style={{ width: '100%', gap: 6 }}>
        <span style={{ fontWeight: 600 }}>v{version.seq}</span>
        <span className="truncate" style={{ flex: 1 }}>{version.name}</span>
        {summary.blocked ? <span className="chip warn">待处理</span> : <span className="chip ok">就绪</span>}
      </span>
      <span className="muted" style={{ fontSize: 10.5 }}>
        {formatDateTime(version.createdAt)} · {summary.pending} 待裁决 · {summary.unresolvedOpen} 未决符号
      </span>
    </button>
  );
}

function ExportOptionsPanel() {
  const opts = useStore(appStore, (s) => s.exportOptions);
  return (
    <Panel title="导出选项" icon={<Package size={15} />}>
      <div className="vstack" style={{ gap: 8 }}>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={opts.includeOriginalBytes}
            onChange={(e) =>
              appStore.update((s) => ({ ...s, exportOptions: { ...s.exportOptions, includeOriginalBytes: e.target.checked } }))
            }
          />
          <span style={{ fontSize: 11.5 }}>包含原始字节 original.bin</span>
        </label>
        <label className="field">
          <span className="field-label">未决符号的占位样式</span>
          <select
            className="select"
            value={opts.unresolvedPlaceholderStyle}
            onChange={(e) =>
              appStore.update((s) => ({
                ...s,
                exportOptions: {
                  ...s.exportOptions,
                  unresolvedPlaceholderStyle: e.target.value as 'byte-escape' | 'question',
                },
              }))
            }
          >
            <option value="byte-escape">保留字节范围 ⟦…⟧（推荐）</option>
            <option value="question">? 单字符占位</option>
          </select>
        </label>
        <span className="muted" style={{ fontSize: 11 }}>
          两种样式都只在文本中显示占位；原始字节与证据文件始终保留。
        </span>
      </div>
    </Panel>
  );
}

function HexWindow({ bytes, start, end }: { bytes: Uint8Array; start: number; end: number }) {
  const rows: { offset: number; hex: string; ascii: string }[] = [];
  const width = 16;
  const limit = Math.min(end, start + 160);
  for (let off = start; off < limit; off += width) {
    const slice = bytes.subarray(off, Math.min(limit, off + width));
    rows.push({
      offset: off,
      hex: bytesToHex(slice, ' '),
      ascii: Array.from(slice, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join(''),
    });
  }
  return (
    <div className="hexdump" style={{ maxHeight: 150, overflowY: 'auto' }}>
      {rows.map((r) => (
        <div key={r.offset}>
          <span className="off">{String(r.offset).padStart(6, '0')}</span>{'  '}
          <span>{r.hex.padEnd(48, ' ')}</span>{'  '}
          <span className="ascii">{r.ascii}</span>
        </div>
      ))}
      {end - start > 160 && <div className="muted">… 其余 {end - start - 160} 字节省略</div>}
    </div>
  );
}
