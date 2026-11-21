export interface SampleSpec {
  name: string;
  note: string;
  blurb: string;
}

export const SAMPLE_LIST: SampleSpec[] = [
  {
    name: 'mixed-encoded-label.txt',
    note: 'GBK 正文 + Big5 不良反应段 + UTF-8 尾注',
    blurb: '三种编码并存；适合对比统一解码与分段诊断。',
  },
  {
    name: 'mojibake-mail-forward.txt',
    note: '邮件客户端双重转码 + 损坏切片',
    blurb: 'UTF-8 内容被当作 Windows-1252 再存回，局部还原链可恢复正文。',
  },
  {
    name: 'big5-monograph.txt',
    note: '纯 Big5 繁体说明书',
    blurb: '验证繁简词库交叉识别及逐字节可回写。',
  },
  {
    name: 'gbk-dosage-table.txt',
    note: 'GBK 剂量表，含截断双字节',
    blurb: '剂量表与括号临近，边界变更会直接影响药名/剂量完整性。',
  },
  {
    name: 'utf8-with-bad-bytes.txt',
    note: 'UTF-8 + BOM 与少量非法/截断字节',
    blurb: '验证“不凭常用词删除不可解字节”，缺失以占位符保留。',
  },
  {
    name: 'boundary-fracture.txt',
    note: '剂量单位跨在 GBK/UTF-8 切换边界上',
    blurb: '两侧各自可读，只有边界检测能发现药名/单位断裂，并降级为待裁决。',
  },
];

export async function fetchSampleBytes(name: string): Promise<Uint8Array> {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}`);
  if (!res.ok) throw new Error(`无法加载样例 ${name}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
