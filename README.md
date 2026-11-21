# ByteLab — 药品说明书编码诊断与可逆修复（纯浏览器本地运行）

ByteLab 用于药品进口企业对电子说明书做内部标签比对和药事归档。它把来自不同市场、混杂
UTF-8 / GBK / Big5、甚至被邮件客户端二次转码过的说明书，整理为**可检索、可复核、可回放**的
文本资料。

所有处理都在浏览器本地完成：原始字节、诊断结果与修复版本保存在 IndexedDB，编码诊断在
Web Worker 中执行，**没有任何字节或文本会离开这台机器**。

## 功能概览

- **导入与来源合并**：相同字节摘要（SHA-256）被不同文件名重复导入时，会合并为同一条记录的
  多个来源，统计只计一次。
- **双策略诊断**：同时在 Worker 中评估「整份文件统一解码」与「按字节区段分段诊断」，并给出
  区段数、候选数、识别编码数、待裁决项、高风险边界与加权重复核工作量的对比。
- **分段候选与证据**：每个连续字节区段独立生成候选（直接解码 + 乱码还原链），记录评分、命中的
  药名/术语、字节精确回写状态与每处异常的确切字节范围。
- **可回放修复版本**：候选切换、未决符号裁决、边界重定义、边界风险确认都会生成新版本，附带
  操作历史、文本哈希与可复现导出。
- **边界断裂守卫**：相邻区段采用不同候选后，若药名、剂量单位（含 `mg/kg` 这类复合单位）或括号
  跨边界断裂，会下调组合置信度并**停在待裁决**。
- **不删除不可解字节**：任何无法安全解码的连续字节都以原字节范围 + 占位符保留，必须人工裁决。
- **确定性导出**：ZIP 归档包包含 manifest、修复文本、解码证据、README、原始字节；同一版本重复
  导出得到逐字节相同的结果。

## 快速开始（Docker，一键启动）

```bash
docker compose up --build
# 打开 http://localhost:8080
```

或直接使用 Dockerfile：

```bash
docker build -t bytelab .
docker run --rm -p 8080:80 bytelab
```

## 本地开发

运行时已预装在容器中，使用固定入口即可：

```bash
npm install                 # 已配置镜像源
npm run dev                 # 开发服务器 http://localhost:5173
npm run build               # 生产构建（含类型检查）
npm run preview             # 预览生产构建
npm test                    # 单元/引擎测试（Vitest）
```

> npm/pip/Maven/Go 镜像源已在本环境配置；无需另装语言运行时。

## 验证方式（可复现）

### 1. 自动化测试

```bash
npm test
```

覆盖编解码器（UTF-8 / GBK / Big5 / CP1252 / GB18030 四字节）、SHA-256 参考向量、分段与策略
对比、边界断裂检测（单位 / 括号 / 术语 / 复合单位）、导入去重、边界重定义与裁决历史、版本回放、
确定性导出与占位符渲染。

### 2. 内置样例（无需准备文件）

在「编码诊断」页点击「导入内置样例」，会加载 6 份本地样例：

| 文件 | 覆盖场景 |
| --- | --- |
| `mixed-encoded-label.txt` | GBK 正文 + Big5 不良反应段 + UTF-8 尾注 |
| `mojibake-mail-forward.txt` | 邮件客户端双重转码 + 损坏切片 |
| `big5-monograph.txt` | 纯 Big5 繁体说明书 |
| `gbk-dosage-table.txt` | GBK 剂量表 + 截断双字节 |
| `utf8-with-bad-bytes.txt` | UTF-8 + BOM 与少量非法/截断字节 |
| `boundary-fracture.txt` | 剂量单位 `mg/kg` 恰好跨在 GBK/UTF-8 切换边界上 |

推荐的端到端验证路径：

1. 「导入内置样例」→ 选择 `mixed-encoded-label.txt` →「运行诊断」。
   - 预期：分段诊断识别出 GBK / Big5 / UTF-8，推荐分段策略；对比表中「识别出的编码数」由 1 变为 3。
2. 「以分段结果进入修复」→ 逐段切换候选、处理未决符号、重定义边界。
   - 边界断裂样例会显示高风险边界，两段停在待裁决，组合置信度被下调。
   - 重定义边界后，旧裁决出现在「版本与历史」的「被取代的历史裁决」中，新范围重新评估。
3. 「归档与导出」→「导出归档包」，解压检查：
   - `manifest.json` 含每段字节范围、候选链、评分、未裁决符号与操作哈希；
   - `repaired.txt` 中未裁决处为 `⟦…⟧` 占位符，已裁决处为人工文本；
   - 再次导出，ZIP 哈希不变。

### 3. 浏览器端检查（开发时）

```bash
npm run dev
# 打开 http://localhost:5173，按上面的路径操作
```

## 重新生成静态资产（可选）

```bash
python3 scripts/generate-samples.py          # 重新生成 public/samples/*
python3 scripts/generate-encoding-tables.py  # 重新编译 GBK/Big5/GB18030 表
python3 scripts/generate-lexicon.py          # 重新生成词库（需 jieba/opencc）
python3 scripts/build-font-subset.py --sans <NotoSansSC.otf>  # 重新生成字体子集
```

## 项目结构

```
src/
  lib/
    encoding/       编解码器（严格 UTF-8、GBK/Big5/GB18030、CP1252、UTF-16）
    analysis/       分段、候选生成、评分、边界分析、策略对比
    util/           SHA-256、字节工具、外部 store
    db.ts           IndexedDB 导入 / 运行 / 版本
    repair.ts       修复状态、边界重定义、裁决、回放、校验
    export.ts       确定性 ZIP 导出与清单
    analysis-worker.ts / workers/  Worker 协议与入口
  components/       React 界面（导入、诊断、修复、归档）
  state/            全局状态与操作
  styles/           设计系统与组件样式
public/samples/     内置样例与 manifest
scripts/            样例/表/词库/字体的可复现生成脚本
tests/              引擎与持久化测试
```

## 依赖说明

- 运行时不依赖任何服务端；Docker 镜像只提供静态文件（nginx）。
- 编码表由 Python codecs 预编译为静态资产，保证浏览器 / Worker / 测试行为一致。
- 内置 CJK 字体子集来自 Noto Sans CJK SC（OFL 1.1），见 `public/fonts/LICENSE.txt`。

## 已知边界

- 若原始字节已因有损转码（如 `?` 替换）丢失字符，工具会把它作为不可解片段保留，无法“凭常用词”
  恢复——这是有意为之。
- 修复版本按内容寻址保存原始字节，删除导入记录时若仍有其它导入引用同一摘要，字节会被保留。
