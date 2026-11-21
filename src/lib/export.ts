import { zipSync, type Zippable } from 'fflate';
import type {
  ExportBundle,
  ExportOptions,
  ImportRecord,
  RepairVersion,
  SegmentState,
} from '../types';
import { selectedCandidate, segmentText, summarizeVersion } from './repair';
import { utf8Encode, bytesToHex } from './util/bytes';
import { sha256Hex } from './util/sha256';
import { encodingLabel } from './encoding/specs';

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeOriginalBytes: true,
  unresolvedPlaceholderStyle: 'byte-escape',
};

/** Fixed timestamp so two exports of the same version are byte-identical. */
const FIXED_ZIP_MTIME = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

export function exportVersion(
  version: RepairVersion,
  record: ImportRecord,
  originalBytes: Uint8Array,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): ExportBundle {
  const summary = summarizeVersion(version);
  const base = `${sanitize(record.primaryFileName.replace(/\.[^.]+$/, ''))}-v${String(version.seq).padStart(3, '0')}`;

  const repairedText = version.state.segments
    .map((seg) => segmentText(seg, version.state, { placeholder: options.unresolvedPlaceholderStyle }))
    .join('');

  const manifest = buildManifest(version, record, originalBytes, repairedText, summary, options);
  const manifestText = JSON.stringify(manifest, null, 2);
  const evidenceText = buildEvidence(version, originalBytes);
  const layoutText = version.state.layout ? JSON.stringify(version.state.layout, null, 2) : '';
  const readmeText = buildReadme(version, record, summary);

  const files: Zippable = {};
  files[`${base}/manifest.json`] = str(utf8Encode(manifestText));
  files[`${base}/repaired.txt`] = str(utf8Encode(repairedText));
  files[`${base}/evidence.md`] = str(utf8Encode(evidenceText));
  files[`${base}/README.txt`] = str(utf8Encode(readmeText));
  if (version.state.layout) {
    files[`${base}/layout.json`] = str(utf8Encode(layoutText));
  }
  if (options.includeOriginalBytes) {
    files[`${base}/original.bin`] = str(originalBytes);
    files[`${base}/original.sha256`] = str(utf8Encode(`${sha256Hex(originalBytes)}  original.bin\n`));
  }

  const zipped = zipSync(files, { level: 6, mtime: FIXED_ZIP_MTIME });
  return {
    fileNameBase: base,
    manifestText,
    repairedText,
    evidenceText,
    readmeText,
    zip: zipped,
    manifestHash: sha256Hex(manifestText),
    zipHash: sha256Hex(zipped),
  };
}

function str(bytes: Uint8Array): [Uint8Array, { mtime: Date }] {
  return [bytes, { mtime: FIXED_ZIP_MTIME }];
}

function sanitize(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || 'label';
}

function buildManifest(
  version: RepairVersion,
  record: ImportRecord,
  originalBytes: Uint8Array,
  repairedText: string,
  summary: ReturnType<typeof summarizeVersion>,
  options: ExportOptions,
) {
  return {
    format: 'bytelab-repair-manifest/1',
    generatedBy: 'ByteLab (browser-local)',
    engine: 'bytelab-engine/1.0',
    exportOptions: options,
    import: {
      id: record.id,
      digest: record.digest,
      byteLength: record.byteLength,
      primaryFileName: record.primaryFileName,
      firstMarket: record.firstMarket,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      sources: record.sources,
      mergedSourceCount: record.sources.length,
      note: '相同字节摘要的重复导入已合并为来源记录，统计只计一次。',
    },
    version: {
      id: version.id,
      seq: version.seq,
      name: version.name,
      strategy: version.strategy,
      createdAt: version.createdAt,
      parentId: version.parentId,
      stateHash: version.stateHash,
      runId: version.runId,
    },
    integrity: {
      originalSha256: sha256Hex(originalBytes),
      originalByteLength: originalBytes.length,
      repairedUtf8Sha256: sha256Hex(repairedText),
      repairedUtf8Bytes: utf8Encode(repairedText).length,
      segmentsCoverFile:
        version.state.segments.length > 0 &&
        version.state.segments[0].start === 0 &&
        version.state.segments[version.state.segments.length - 1].end === originalBytes.length,
    },
    review: summary,
    segments: version.state.segments.map((seg, index) => segmentEvidence(seg, index, version)),
    boundaryReviews: version.state.boundaryReviews.map((r) => ({
      id: r.id,
      boundary: r.boundary,
      severity: r.severity,
      flags: r.flags,
      combinedConfidence: r.combinedConfidence,
      leftSegmentId: r.leftSegmentId,
      rightSegmentId: r.rightSegmentId,
      leftTail: r.leftTail,
      rightHead: r.rightHead,
      acknowledged: r.acknowledged,
      acknowledgedNote: r.acknowledgedNote,
      acknowledgedVersionId: r.acknowledgedVersionId,
    })),
    symbolResolutions: Object.values(version.state.symbolResolutions),
    notes: version.state.notes,
    superseded: version.superseded,
    layout: version.state.layout
      ? {
          schema: version.state.layout.schema,
          engine: version.state.layout.engine,
          ordering: version.state.layout.ordering,
          metrics: version.state.layout.metrics,
          pages: version.state.layout.pages.map((p) => ({
            id: p.id,
            pageNumber: p.pageNumber,
            pageSize: p.pageSize,
            direction: p.direction,
            columnGutters: p.columnGutters,
            imageDigestSha256: p.imageDigest.sha256,
            blocks: p.blocks.map((b) => ({
              id: b.id,
              pageNumber: b.pageNumber,
              role: b.role,
              section: b.section,
              sectionId: b.sectionId,
              rect: b.rect,
              column: b.column,
              order: b.order,
              spansColumns: b.spansColumns,
              prevBlockId: b.prevBlockId,
              nextBlockId: b.nextBlockId,
              imageDigestSha256: b.imageDigest.sha256,
            })),
          })),
          alignments: version.state.layout.alignments.map((a) => ({
            id: a.id,
            ocrLineId: a.ocrLineId,
            pageId: a.pageId,
            byteRange: a.byteRange,
            segmentId: a.segmentId,
            candidateBlockIds: a.candidateBlockIds,
            overlapScores: a.overlapScores,
            status: a.status,
            flags: a.flags,
            competingLineIds: a.competingLineIds,
          })),
          fields: version.state.layout.fields,
          issues: version.state.layout.issues,
          reviewQueue: version.state.layout.reviewQueue,
          adjudications: Object.values(version.state.layout.adjudications),
          anchorRevisions: version.state.layout.anchorRevisions,
        }
      : null,
    operations: version.ops.map((op, i) => ({
      index: i,
      type: op.type,
      description: version.audit[i]?.description ?? '',
      textHashBefore: version.audit[i]?.textHashBefore ?? '',
      textHashAfter: version.audit[i]?.textHashAfter ?? '',
    })),
  };
}

function segmentEvidence(seg: SegmentState, index: number, version: RepairVersion) {
  const cand = selectedCandidate(seg);
  return {
    index,
    id: seg.id,
    byteRange: [seg.start, seg.end],
    byteLength: seg.end - seg.start,
    kind: seg.kind,
    status: seg.status,
    confidence: seg.confidence,
    analysisConfidence: seg.analysisConfidence,
    reasons: seg.reasons,
    selectedCandidateId: seg.selectedCandidateId,
    selected: cand
      ? {
          label: cand.label,
          kind: cand.kind,
          encoding: cand.encoding,
          encodingLabel: encodingLabel(cand.encoding),
          chain: cand.chain.map((s) => `${s.kind}:${s.encoding}`),
          score: cand.score,
          byteExact: cand.byteExact,
          byteExactNote: cand.byteExactNote ?? '',
          unresolved: cand.unresolved.map((u) => ({
            id: u.id,
            byteRange: [u.start, u.end],
            bytesHex: u.bytesHex,
            reason: u.reason,
            resolution: version.state.symbolResolutions[u.id] ?? null,
          })),
        }
      : null,
    alternatives: seg.candidates
      .filter((c) => c.id !== seg.selectedCandidateId)
      .map((c) => ({
        id: c.id,
        label: c.label,
        encoding: c.encoding,
        score: c.score.score,
        byteExact: c.byteExact,
      })),
  };
}

function buildEvidence(version: RepairVersion, originalBytes: Uint8Array): string {
  const lines: string[] = [];
  lines.push(`# 解码证据 · 修复版本 v${version.seq} (${version.id})`);
  lines.push('');
  lines.push(`- 原始字节数：${originalBytes.length}`);
  lines.push(`- 原始 SHA-256：${sha256Hex(originalBytes)}`);
  lines.push(`- 版本状态 SHA-256：${version.stateHash}`);
  lines.push(`- 策略：${version.strategy === 'uniform' ? '整份文件统一解码' : '按字节区段分段诊断'}`);
  lines.push('');
  lines.push('每个区段记录：字节范围 → 选定候选的解码链 → 评分/证据 → 未决符号与裁决。');
  lines.push('');
  for (let i = 0; i < version.state.segments.length; i++) {
    const seg = version.state.segments[i];
    const cand = selectedCandidate(seg);
    lines.push(`## 区段 ${i} · 字节 ${seg.start}–${seg.end}（${seg.end - seg.start} B）`);
    lines.push(`- 类型：${seg.kind === 'mojibake' ? '疑似转码区段' : '文本区段'}；状态：${seg.status}`);
    lines.push(`- 置信度：${seg.confidence.toFixed(3)}（分析值 ${seg.analysisConfidence.toFixed(3)}）`);
    if (seg.reasons.length) lines.push(`- 触发原因：${seg.reasons.join('；')}`);
    if (cand) {
      lines.push(`- 选定候选：${cand.label}`);
      lines.push(`- 解码链：${cand.chain.map((s) => `${s.kind === 'decode' ? '解码' : '编码'} ${encodingLabel(s.encoding)}`).join(' → ')}`);
      lines.push(`- 评分：${cand.score.score.toFixed(3)}；字节精确回写：${cand.byteExact ? '是' : '否'}${cand.byteExactNote ? `（${cand.byteExactNote}）` : ''}`);
      if (cand.score.lexiconHits.length) lines.push(`- 术语命中：${cand.score.lexiconHits.join('、')}`);
      if (cand.unresolved.length) {
        lines.push('- 未决符号：');
        for (const u of cand.unresolved) {
          const rel = Math.max(0, u.start - seg.start);
          const relEnd = Math.min(seg.end - seg.start, u.end - seg.start);
          const hex = bytesToHex(originalBytes.subarray(seg.start + rel, seg.start + relEnd), ' ');
          const res = version.state.symbolResolutions[u.id];
          lines.push(
            `  - ${u.id} · 字节 ${u.start}–${u.end} · ${hex} · ${u.reason} → ${
              res ? `已裁决 “${res.text}”（${res.note || '无备注'}）` : '未裁决（导出中保留为占位符）'
            }`,
          );
        }
      }
    } else {
      lines.push('- 无可用候选');
    }
    lines.push('');
  }
  if (version.state.superseded.length) {
    lines.push('## 被取代的历史裁决（仅存档，不参与当前版本）');
    for (const s of version.state.superseded) {
      lines.push(`- v${s.atSeq} · 区段 ${s.segmentRange[0]}–${s.segmentRange[1]} · ${s.summary}${s.note ? ` · 备注：${s.note}` : ''}`);
    }
    lines.push('');
  }
  const layout = version.state.layout;
  if (layout) {
    lines.push('## 版面锚点与关键字段定位');
    lines.push(`- 排序规则：${layout.ordering === 'linear' ? '线性（上到下、左到右）' : '几何约束'}；页面 ${layout.metrics.pageCount} · 区块 ${layout.metrics.blockCount} · OCR 行 ${layout.metrics.ocrLineCount}`);
    lines.push(`- 对齐：已对齐 ${layout.metrics.alignedLines} · 重叠待核 ${layout.metrics.ambiguousLines} · 跨列待核 ${layout.metrics.spanningLines} · 未定位 ${layout.metrics.unplacedLines}`);
    lines.push(`- 字段：共 ${layout.metrics.fieldCount}，待核/未定位 ${layout.metrics.fieldsAtRisk}；高风险问题 ${layout.metrics.highRiskIssues}；复核队列待处理 ${layout.metrics.reviewQueueSize}`);
    lines.push('');
    lines.push('### 字段证据（可回查页面区域；裸数字不会被当作剂量）');
    for (const f of layout.fields) {
      lines.push(
        `- [${f.status}] ${f.kind} “${f.text}” · 字节 ${f.byteRange[0]}–${f.byteRange[1]} · 章节「${f.section || '无'}」 · 区域 ${f.blockId ? `p${f.pageNumber}/${f.blockId}` : '无区域'}${f.reasons.length ? ` · ${f.reasons.join('；')}` : ''}`,
      );
    }
    lines.push('');
    lines.push('### 高风险复核与锚点修订');
    for (const q of layout.reviewQueue) {
      lines.push(`- 复核 ${q.id} · ${q.status} · 区块 ${q.blockId ?? '—'} · 问题 ${q.issueIds.join('、')}${q.decisionNote ? ` · 裁决：${q.decisionNote}` : ''}`);
    }
    for (const r of layout.anchorRevisions) {
      lines.push(`- 重裁剪 ${r.blockId}：${r.oldImageDigest.sha256.slice(0, 12)}… → ${r.newImageDigest.sha256.slice(0, 12)}…；旧确认保留 ${r.priorDecisions.length} 条；理由：${r.note}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildReadme(
  version: RepairVersion,
  record: ImportRecord,
  summary: ReturnType<typeof summarizeVersion>,
): string {
  const lines = [
    `ByteLab 修复版本导出 · v${version.seq}`,
    ''.padEnd(40, '='),
    `源文件名：${record.primaryFileName}`,
    `来源记录：${record.sources.length} 条（相同字节摘要已合并）`,
    `策略：${version.strategy === 'uniform' ? '统一解码' : '分段诊断'}`,
    `导出时间：${version.createdAt}`,
    '',
    '包内文件：',
    '  manifest.json  完整机器可读清单（字节范围、候选、评分、边界、操作历史、版面定位）',
    '  repaired.txt   修复后的 UTF-8 文本（未裁决符号以占位符保留）',
    '  evidence.md    人类可读的解码与版面证据，可从修复版本回查原字节与页面区域',
    '  layout.json    版面锚点、OCR 行对齐、字段证据、一致性问题与复核状态（若有版面数据）',
    '  original.bin   原始字节（内容可寻址，可用 SHA-256 校验）',
    '  original.sha256 原始文件摘要',
    '',
    `待裁决区段：${summary.pending}；高风险未确认边界：${summary.unacknowledgedHigh}；未裁决符号：${summary.unresolvedOpen}`,
    summary.blocked
      ? '注意：本次导出仍包含未完成事项，归档前请复核 manifest 中的 review 字段。'
      : '所有区段、边界与符号均已处理。',
    '',
    '工具不会凭常用词自动删除不可解字节；任何缺失都以显式占位符和字节范围记录。',
    '',
    `状态哈希：${version.stateHash}`,
  ];
  return `${lines.join('\n')}\n`;
}

