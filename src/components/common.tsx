import type { ReactNode } from 'react';
import type { EncodingId } from '../types';
import { ENCODINGS } from '../lib/encoding/specs';

const TONE_CLASS: Record<string, string> = {
  teal: 'teal',
  indigo: 'indigo',
  amber: 'amber',
  rose: 'rose',
  orange: 'orange',
  sky: 'sky',
};

export function EncodingChip({ encoding, short }: { encoding: EncodingId | null | undefined; short?: boolean }) {
  if (!encoding) return <span className="chip">未知</span>;
  const spec = ENCODINGS[encoding];
  const tone = TONE_CLASS[spec.tone] ?? '';
  return (
    <span className={`chip ${tone}`} title={spec.label}>
      {short ? spec.short : spec.label}
    </span>
  );
}

export type StatusKind = 'confident' | 'suggested' | 'pending' | 'high' | 'medium' | 'low';

const STATUS_LABEL: Record<StatusKind, string> = {
  confident: '可归档',
  suggested: '建议复核',
  pending: '待裁决',
  high: '高风险',
  medium: '中风险',
  low: '低风险',
};

const STATUS_CLASS: Record<StatusKind, string> = {
  confident: 'chip ok',
  suggested: 'chip info',
  pending: 'chip warn',
  high: 'chip danger',
  medium: 'chip warn',
  low: 'chip',
};

export function StatusChip({ status }: { status: StatusKind }) {
  return <span className={STATUS_CLASS[status]}>{STATUS_LABEL[status]}</span>;
}

export function ScoreBar({ score, color = 'var(--accent)' }: { score: number; color?: string }) {
  return (
    <div className="meter-bar" aria-hidden>
      <div
        className="meter-fill"
        style={{ width: `${Math.max(2, Math.round(score * 100))}%`, background: color }}
      />
    </div>
  );
}

export function Panel({
  title,
  icon,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`panel ${className ?? ''}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div className="panel-title">
            {icon}
            {title}
          </div>
          <div className="grow" />
          {actions}
        </header>
      )}
      <div className={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div style={{ maxWidth: 420, fontSize: 12 }}>{children}</div>}
      {action}
    </div>
  );
}

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: string }) {
  return (
    <div className="stat">
      <div className="stat-value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Banner({ kind, children }: { kind: 'warn' | 'danger' | 'info' | 'ok'; children: ReactNode }) {
  return <div className={`banner ${kind}`}>{children}</div>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
