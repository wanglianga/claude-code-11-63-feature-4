import { useEffect, useState } from 'react';
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Database,
  FlaskConical,
  HardDrive,
  HelpCircle,
  Library,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useStore } from '../lib/util/store';
import { activeVersion, appStore, dismissToast, setView, type ViewId } from '../state/app';
import { refreshLibrary, resetWorkspace } from '../state/actions';
import { formatBytes } from '../lib/util/bytes';
import { LibraryView } from './LibraryView';
import { DiagnoseView } from './DiagnoseView';
import { RepairView } from './RepairView';
import { ArchiveView } from './ArchiveView';
import { summarizeVersion } from '../lib/repair';

const NAV: { id: ViewId; label: string; icon: React.ReactNode; step: string }[] = [
  { id: 'library', label: '导入记录', icon: <Library size={16} />, step: '01' },
  { id: 'diagnose', label: '编码诊断', icon: <FlaskConical size={16} />, step: '02' },
  { id: 'repair', label: '修复工作区', icon: <Wrench size={16} />, step: '03' },
  { id: 'archive', label: '归档与导出', icon: <Archive size={16} />, step: '04' },
];

export function App() {
  const view = useStore(appStore, (s) => s.view);
  const stats = useStore(appStore, (s) => s.stats);
  const imports = useStore(appStore, (s) => s.imports);
  const busy = useStore(appStore, (s) => s.busy);
  const selectedId = useStore(appStore, (s) => s.selectedImportId);
  const bundles = useStore(appStore, (s) => s.bundles);
  const versions = useStore(appStore, (s) => s.versions);
  const [collapsed, setCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    void refreshLibrary();
  }, []);

  const selected = imports.find((i) => i.id === selectedId);
  const version = activeVersion(appStore.get());
  const summary = version ? summarizeVersion(version) : null;

  return (
    <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand-mark">BL</div>
          {!collapsed && (
            <div className="brand-text">
              <span className="brand-name">ByteLab</span>
              <span className="brand-sub">药品说明书编码归档</span>
            </div>
          )}
          <div className="grow" />
          <button className="btn ghost sm icon-only" onClick={() => setCollapsed((c) => !c)} title={collapsed ? '展开' : '收起'}>
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        <div className="sidebar-nav">
          {!collapsed && <div className="nav-label">工作流</div>}
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => setView(item.id)}
              title={item.label}
            >
              <span className="icon">{item.icon}</span>
              {!collapsed && (
                <>
                  <span className="label">{item.label}</span>
                  {item.id === 'library' && imports.length > 0 && <span className="nav-badge">{imports.length}</span>}
                  {item.id === 'repair' && summary && (
                    <span className="nav-badge">{summary.pending + summary.unresolvedOpen}</span>
                  )}
                  {item.id === 'archive' && version && (
                    <span className="nav-badge">v{version.seq}</span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>

        {!collapsed && (
          <div className="sidebar-body">
            <div className="nav-label">当前文件</div>
            {selected ? (
              <div className="panel" style={{ boxShadow: 'none', background: 'var(--bg-elevated)' }}>
                <div className="panel-body" style={{ padding: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }} className="truncate">
                    {selected.primaryFileName}
                  </div>
                  <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>
                    {formatBytes(selected.byteLength)} · {selected.sources.length} 来源
                  </div>
                  <div className="muted mono" style={{ fontSize: 10, marginTop: 4 }}>
                    {selected.digest.slice(0, 16)}…
                  </div>
                  <div className="hstack" style={{ gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
                    {bundles[selected.id] && <span className="chip info">已诊断</span>}
                    {(versions[selected.id]?.length ?? 0) > 0 && (
                      <span className="chip indigo">{versions[selected.id].length} 版本</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 11, padding: '4px 8px' }}>
                尚未选择文件
              </div>
            )}

            <div className="nav-label" style={{ marginTop: 14 }}>工作区</div>
            <div className="vstack" style={{ gap: 4 }}>
              <div className="hstack" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--text-secondary)' }}>
                <Database size={12} className="muted" />
                唯一文件 {stats.uniqueFiles}
              </div>
              <div className="hstack" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--text-secondary)' }}>
                <HardDrive size={12} className="muted" />
                {formatBytes(stats.totalBytes)}
              </div>
            </div>

            <button
              className="btn ghost sm"
              style={{ marginTop: 12, width: '100%', justifyContent: 'flex-start' }}
              onClick={() => {
                if (window.confirm('确定清空本地全部数据？导入记录、诊断结果与修复版本都会被删除，且不可恢复。')) {
                  void resetWorkspace();
                }
              }}
            >
              <Trash2 size={13} /> 清空本地数据
            </button>
          </div>
        )}

        <div className="sidebar-foot">
          <span className="local-badge">
            <ShieldCheck size={12} /> 仅在浏览器本地运行
          </span>
          {!collapsed && <span>字节与文本不会上传到任何服务器</span>}
          <button className="btn ghost sm" style={{ justifyContent: 'flex-start', paddingLeft: 0 }} onClick={() => setHelpOpen(true)}>
            <HelpCircle size={12} /> 使用说明
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="topbar-title">{NAV.find((n) => n.id === view)?.label}</div>
          </div>
          <div className="topbar-spacer" />
          {selected && (
            <span className="topbar-sub truncate" style={{ maxWidth: 320 }}>
              {selected.primaryFileName}
            </span>
          )}
          {version && (
            <button className="btn sm" onClick={() => setView('archive')}>
              <Archive size={13} /> v{version.seq}
            </button>
          )}
        </header>

        {busy && (
          <div style={{ padding: '6px 22px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--accent-line)', fontSize: 11.5 }}>
            {busy}…
          </div>
        )}

        <div className={`content ${view === 'repair' ? 'flush' : ''}`} style={view === 'repair' ? { padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } : undefined}>
          {view === 'library' && <LibraryView />}
          {view === 'diagnose' && <DiagnoseView />}
          {view === 'repair' && <RepairView />}
          {view === 'archive' && <ArchiveView />}
        </div>
      </main>

      <Toasts />
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function Toasts() {
  const toasts = useStore(appStore, (s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div style={{ minWidth: 0 }}>
            <div className="toast-title">{t.title}</div>
            {t.detail && <div className="toast-detail">{t.detail}</div>}
          </div>
          <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="关闭">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(33,31,27,0.36)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 300,
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{ maxWidth: 640, width: '100%', maxHeight: '84vh', overflowY: 'auto', boxShadow: 'var(--shadow-lg)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <div className="panel-title"><HelpCircle size={16} /> 使用说明</div>
          <div className="grow" />
          <button className="btn ghost sm" onClick={onClose}>关闭</button>
        </div>
        <div className="panel-body">
          <ol style={{ paddingLeft: 18, margin: 0, fontSize: 12.5, lineHeight: 1.85 }}>
            <li>
              <b>导入</b>：选择 UTF-8 / GBK / Big5 说明书文件，也支持一次导入多份。相同字节摘要被不同文件名重复导入时，会合并来源记录，不会重复生成统计。原始字节保存于 IndexedDB。
            </li>
            <li>
              <b>诊断</b>：在 Worker 中同时评估“整份文件统一解码”和“按字节区段分段诊断”两种策略，并对比区段数、候选数、编码数、待裁决项和复核工作量。
            </li>
            <li>
              <b>修复</b>：逐段切换候选、处理未决符号、重定义边界。相邻区段采用不同候选后若药名/剂量单位/括号跨边界断裂，会降低组合置信度并停在待裁决。
            </li>
            <li>
              <b>版本</b>：每次操作生成新版本，旧裁决只在边界重定义后保留为历史。可从修复版本回查原字节范围与解码证据。
            </li>
            <li>
              <b>归档导出</b>：导出确定性 ZIP（manifest、修复文本、证据、README、原始字节），可复现校验哈希。
            </li>
          </ol>
          <div className="hr" style={{ margin: '14px 0' }} />
          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            工具不会凭常用词自动删除不可解字节。任何无法安全解码的连续字节都会以原样字节范围和占位符保留，直到人工裁决。
          </div>
        </div>
      </div>
    </div>
  );
}
