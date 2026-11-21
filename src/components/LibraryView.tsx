import { useRef } from 'react';
import { FileUp, FolderOpen, Layers, ShieldCheck } from 'lucide-react';
import { useStore } from '../lib/util/store';
import { appStore, setView } from '../state/app';
import { importFiles, selectImport } from '../state/actions';
import { formatBytes, formatDateTime, relativeTime, shortHash } from '../lib/util/bytes';
import { EmptyState, Panel, Stat } from './common';
import { SAMPLE_LIST } from '../samples';

export function LibraryView() {
  const imports = useStore(appStore, (s) => s.imports);
  const stats = useStore(appStore, (s) => s.stats);
  const selectedId = useStore(appStore, (s) => s.selectedImportId);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    const inputs = [];
    for (const file of Array.from(files)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      inputs.push({
        bytes,
        fileName: file.name,
        market: '未标注',
        receivedFrom: '本地选择',
        receivedAt: new Date().toISOString(),
      });
    }
    await importFiles(inputs);
    if (fileRef.current) fileRef.current.value = '';
    if (dirRef.current) dirRef.current.value = '';
  }

  return (
    <div className="content">
      <div className="stat-row" style={{ marginBottom: 16 }}>
        <Stat value={stats.uniqueFiles} label="唯一文件（按字节摘要）" />
        <Stat value={stats.totalSources} label="接收来源记录" />
        <Stat value={stats.mergedImports} label="合并的重复导入" tone="var(--accent)" />
        <Stat value={formatBytes(stats.totalBytes)} label="原始字节总量" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 300px', alignItems: 'start' }}>
        <Panel
          title="导入记录"
          icon={<Layers size={15} />}
          flush
          actions={
            <div className="btn-row">
              <button className="btn primary sm" onClick={() => fileRef.current?.click()}>
                <FileUp size={13} /> 导入文件
              </button>
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
              <input
                ref={dirRef}
                type="file"
                // @ts-expect-error non-standard but supported in Chromium
                webkitdirectory=""
                multiple
                hidden
                onChange={(e) => handleFiles(e.target.files)}
              />
              <button className="btn sm" onClick={() => setView('archive')}>
                归档视图
              </button>
            </div>
          }
        >
          {imports.length === 0 ? (
            <EmptyState
              icon={<FolderOpen size={20} />}
              title="尚未导入任何说明书"
              action={
                <button className="btn primary sm" onClick={() => fileRef.current?.click()}>
                  <FileUp size={13} /> 选择文件
                </button>
              }
            >
              全部处理都在浏览器本地完成。导入后可按字节摘要合并重复来源，原始字节保存于 IndexedDB。
            </EmptyState>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>文件名 / 来源</th>
                    <th>市场</th>
                    <th className="num">字节</th>
                    <th>摘要</th>
                    <th>来源数</th>
                    <th>最近更新</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((imp) => (
                    <tr
                      key={imp.id}
                      className={selectedId === imp.id ? 'selected' : ''}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        void selectImport(imp.id);
                        setView('diagnose');
                      }}
                    >
                      <td>
                        <div style={{ fontWeight: 550 }}>{imp.primaryFileName}</div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {imp.sources.length > 1
                            ? `${imp.sources.length} 个来源已合并`
                            : imp.sources[0]?.receivedFrom || '—'}
                        </div>
                      </td>
                      <td>
                        <span className="chip">{imp.firstMarket}</span>
                      </td>
                      <td className="num">{formatBytes(imp.byteLength)}</td>
                      <td className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {shortHash(imp.digest, 8, 6)}
                      </td>
                      <td>
                        {imp.sources.length > 1 ? (
                          <span className="chip info">{imp.sources.length} 来源</span>
                        ) : (
                          <span className="chip">1 来源</span>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: 11 }}>
                        {relativeTime(imp.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="vstack">
          <Panel title="本地样例" icon={<FolderOpen size={15} />}>
            <p className="muted" style={{ marginTop: 0, fontSize: 11.5 }}>
              内置 5 份药品说明书样例，覆盖混合编码、邮件双重转码、纯 Big5 与损坏字节。
              一键导入即可在诊断页对比策略。
            </p>
            <div className="vstack" style={{ gap: 4 }}>
              {SAMPLE_LIST.map((s) => (
                <div key={s.name} style={{ fontSize: 11.5 }}>
                  <div className="mono" style={{ color: 'var(--text-secondary)' }}>
                    {s.name}
                  </div>
                  <div className="muted" style={{ fontSize: 10.5 }}>
                    {s.note}
                  </div>
                </div>
              ))}
            </div>
            <button
              className="btn sm"
              style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
              onClick={() => setView('diagnose')}
            >
              前往诊断页导入
            </button>
          </Panel>

          <Panel title="本地与隐私" icon={<ShieldCheck size={15} />}>
            <div className="vstack" style={{ fontSize: 11.5, color: 'var(--text-secondary)', gap: 6 }}>
              <div>The file contents never leave this browser.</div>
              <div>原始字节、诊断结果与修复版本均保存在 IndexedDB；诊断在 Web Worker 中执行，不阻塞界面。</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                {formatDateTime(new Date().toISOString())}
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
