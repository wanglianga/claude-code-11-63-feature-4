"""Generate the bundled sample label files.

Each sample exercises a different failure mode described in the brief:
  1. mixed-encoded-label.txt   – GBK body + Big5 adverse-reaction block + UTF-8 footer
  2. mojibake-mail-forward.txt – a UTF-8 paragraph that a mail client re-encoded
                                 to GBK bytes and back, plus a corrupt slice
  3. big5-monograph.txt        – pure Big5 label (traditional Chinese)
  4. gbk-dosage-table.txt      – GBK dosage table with a truncated multi-byte
                                 sequence and split bracket on purpose
  5. utf8-with-bad-bytes.txt   – UTF-8 text with a few invalid bytes and a
                                 UTF-8 BOM, to show "do not delete" behaviour

Run:  python3 scripts/generate-samples.py
"""
import os
import hashlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'samples')
os.makedirs(OUT, exist_ok=True)

MANIFEST = []

# WHATWG windows-1252: unmapped 0x81/0x8D/0x8F/0x90/0x9D map to the C1
# controls with the same value, so every byte round-trips. Python's cp1252
# codec refuses those slots, so we do it explicitly.
CP1252_HIGH = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
    0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
    0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’',
    0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
    0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ',
    0x9e: 'ž', 0x9f: 'Ÿ',
}

def whatwg_cp1252_decode(data: bytes) -> str:
    return ''.join(CP1252_HIGH.get(b, chr(b)) for b in data)

def emit(name, data: bytes, note: str):
    path = os.path.join(OUT, name)
    with open(path, 'wb') as f:
        f.write(data)
    MANIFEST.append((name, len(data), hashlib.sha256(data).hexdigest(), note))
    print(f'{name:32s} {len(data):6d} B  sha256={hashlib.sha256(data).hexdigest()[:16]}…')

# ---------------------------------------------------------------- sample 1
gbk_body = """注射用头孢曲松钠 电子说明书
通用名称：注射用头孢曲松钠
商品名称：罗氏芬
英文名称：Ceftriaxone Sodium for Injection
规格：1.0 g（按头孢曲松计）
贮藏：遮光，密闭，在阴凉干燥处保存。
批准文号：国药准字H10983036
生产企业：上海罗氏制药有限公司

【适应症】
用于敏感致病菌所致的呼吸道感染、泌尿道感染、皮肤软组织感染、
骨和关节感染、败血症、脑膜炎、腹膜炎及淋病等。

【用法用量】
成人及12岁以上儿童：每次1～2 g，每日一次，静脉滴注，滴注时间不少于30分钟。
儿童：按体重每日50～80 mg/kg，分一次或两次给药。
肾功能不全患者：每日剂量不超过2 g，无需调整给药间隔。
""".encode('gbk')

big5_block = """【不良反應】
常見：腹瀉、噁心、嘔吐、皮疹、注射部位疼痛。
少見：頭痛、眩暈、發熱、肝功能異常、白血球減少。
罕見：過敏性休克、嚴重皮膚不良反應（史蒂文斯－強生症候群）、
偽膜性結腸炎、膽囊假性結石。
若出現呼吸困難、顏面水腫或全身性皮疹，應立即停藥並就醫。
""".encode('big5')

utf8_footer = """
【注意事项】
用药前应详细询问过敏史。对头孢菌素类过敏者禁用。
与氨基糖苷类药物合用可能增加肾毒性，需监测肾功能。
本品与含钙溶液存在配伍禁忌，新生儿禁用含钙输液。
请将本品置于儿童不能接触的地方。
""".encode('utf-8')

mixed = b'-- bytelab-sample: mixed-market label (GBK body, Big5 AE block, UTF-8 footer)\r\n' + gbk_body + b'\r\n' + big5_block + b'\r\n' + utf8_footer
emit('mixed-encoded-label.txt', mixed,
     'GBK 正文 + Big5 不良反应段 + UTF-8 尾注，用于演示分段诊断保留混合编码')

# ---------------------------------------------------------------- sample 2
good_utf8 = """【警告】
本品仅用于静脉滴注，不得用于肌内注射。
严重肝功能损害患者禁用。用药期间应定期监测凝血功能。
与其他抗凝药物合用时，出血风险显著增加，须调整剂量。
"""
# The classic mail-client failure: the client read the UTF-8 bytes as
# Windows-1252 and then saved the resulting text as UTF-8 again. The file is
# valid UTF-8, but its content is mojibake ("é–…å‘Š" style). Because CP1252
# round-trips every byte (including the unassigned 0x81/0x8D/0x8F/0x90/0x9D
# slots, which become C1 controls), this path is fully reversible.
mojibake_text = whatwg_cp1252_decode(good_utf8.encode('utf-8'))
damaged = mojibake_text.encode('utf-8')

extra = """【药物相互作用】
与华法林合用可延长凝血酶原时间。
与阿司匹林、氯吡格雷合用增加出血风险。
"""
# A corrupt slice in a *different* encoding: genuine GBK with one truncated
# multi-byte sequence, so the repair chain and the "keep the bytes" rule both
# get exercised in the same file.
extra_gbk = extra.encode('gbk')
mail = (
    b'-- bytelab-sample: mail-forwarded label (double transcode + corrupt slice)\r\n'
    + damaged
    + b'\r\n'
    + extra_gbk[:18]
    + b'\x81'
    + extra_gbk[19:]
    + b'\r\n'
    + '【剂量调整】\r\n'.encode('gbk')
    + '轻度肝功能损害：每次 10 mg，每日一次。'.encode('gbk')
    + b'\r\n'
)
emit('mojibake-mail-forward.txt', mail,
     '邮件客户端双重转码后的 UTF-8 段 + 中央损坏字节，演示可逆还原与不可解占位')

# ---------------------------------------------------------------- sample 3
big5_doc = """藥品說明書（繁體中文）
藥品名稱：阿托伐他汀鈣片
英文名稱：Atorvastatin Calcium Tablets
規格：20 mg
許可證字號：衛署藥輸字第 024512 號
製造廠：輝瑞大藥廠股份有限公司

【適應症】
高膽固醇血症、高三酸甘油酯血症、混合型血脂異常。
原發性高膽固醇血症患者，在飲食控制無效時使用。

【用法與用量】
成人起始劑量每日 10 至 20 mg，晚間口服。
劑量調整間隔應為 4 週以上，最大劑量每日 80 mg。
腎功能不全患者無需調整劑量。

【不良反應】
常見：肌肉痠痛、頭痛、腹瀉、便秘、鼻咽炎。
嚴重：橫紋肌溶解、肝酵素上升、過敏性皮疹。
如出現不明原因的肌肉疼痛或無力，應立即就醫檢查肌酸磷化酵素。
""".encode('big5')
emit('big5-monograph.txt', big5_doc,
     '纯 Big5 繁体说明书，用于验证繁简词库交叉识别与逐字节可回写')

# ---------------------------------------------------------------- sample 4
gbk_table = """药品名称：盐酸二甲双胍缓释片
规格：0.5 g × 30 片
贮藏：密封，在干燥处保存。

【用法用量表】
| 人群 | 起始剂量 | 维持剂量 | 给药频次 |
| 成人 | 0.5 g | 1.0～2.0 g | 每日一次，晚餐时服 |
| 老年患者 | 0.25 g | 0.5～1.0 g | 每日一次 |
| 肾功能不全 | 不用 | 按 eGFR 调整 | 见注意事项 |

【禁忌】
1. 中重度肾功能不全（eGFR<45 mL/min/1.73m2）患者禁用。
2. 急性或慢性代谢性酸中毒，包括糖尿病酮症酸中毒。
3. 严重感染、脱水、休克、缺氧状态禁用。

【警告】
乳酸酸中毒罕见但可致命。出现不明原因的肌痛、呼吸困难、
嗜睡或腹痛时，应立即停药并检测血乳酸浓度。
""".encode('gbk')
# Split a dosage unit across the intended boundary and truncate a sequence:
# replace one full-width paren with a broken byte so the boundary check fires.
idx = gbk_table.find('（按'.encode('gbk'))
if idx < 0:
    idx = gbk_table.find('（'.encode('gbk'))
gbk_table = gbk_table[:idx] + '（按'.encode('gbk')[:1] + b'\xB0' + gbk_table[idx + 2:]
emit('gbk-dosage-table.txt', gbk_table,
     'GBK 剂量表，含截断双字节与剂量/括号边界，演示边界断裂必须停在待裁决')

# ---------------------------------------------------------------- sample 5
utf8_bad = (
    b'\xef\xbb\xbf'  # UTF-8 BOM
    + """【电子说明书 · 存档副本】
药品名称：阿莫西林克拉维酸钾片
规格：0.457 g（阿莫西林 0.4 g 与克拉维酸 57 mg）
""".encode('utf-8')
    + b'\n'
    + '【适应症】用于敏感菌所致的上呼吸道感染、下呼吸道感染、泌尿系统感染。\n'.encode('utf-8')
    + b'\n\xc3'  # truncated 2-byte UTF-8 sequence
    + '用药期间如出现严重腹泻，应考虑伪膜性肠炎。'.encode('utf-8')
    + b'\n'
    + b'\xff\xfe'  # stray invalid bytes (e.g. from a botched export)
    + '对青霉素类过敏者禁用，用药前须做皮肤试验。\n'.encode('utf-8')
    + '孕妇及哺乳期妇女慎用，需权衡利弊。\n'.encode('utf-8')
    + b'\xf0\x9f'  # truncated 4-byte emoji
    + '剂量：成人每次 0.625 g，每 8 小时一次。\n'.encode('utf-8')
)
emit('utf8-with-bad-bytes.txt', utf8_bad,
     'UTF-8 + BOM 与少量非法/截断字节，验证“不凭常用词删除不可解字节”')

# ---------------------------------------------------------------- sample 6
# A dosage unit deliberately split across an encoding switch: "10 m" (GBK)
# then "g/kg" (UTF-8). Each side decodes cleanly, so only the boundary check
# can catch the fracture.
# The GBK half ends at "...10 m" and the UTF-8 half starts with "g/kg". Both
# halves decode without a single bad byte, and "mg" only breaks across the cut.
left = (
    "【剂量】\n"
    "成人：每次 1.0 g，每日一次，静脉滴注。\n"
    "儿童：按体重每次 10 m"
).encode('gbk')
right = (
    "g/kg，每日一次，滴注时间不少于 30 分钟。\n"
    "肾功能不全：每次 0.5 mg，每日一次。\n"
).encode('utf-8')
emit('boundary-fracture.txt',
     b'-- bytelab-sample: boundary fracture (unit split across a transcode boundary)\r\n' + left + right,
     '剂量单位“mg/kg”跨在 GBK/UTF-8 切换边界上，验证组合置信度下调与待裁决')

# ---------------------------------------------------------------- sample 7
# A layout-annotated OCR page exercising every localization hazard in the
# brief: two columns, a spanning table, footnotes, a duplicated OCR row, two
# rows contending for the same image region, one line crossing the column
# gutter, a negation token whose clause lives in a different section than the
# adjacent dosage, and a bare number that must never be promoted to a dosage.
# Directives are ASCII; content is UTF-8 so every OCR line stays readable.
layout_lines = [
    '-- bytelab-layout:v1 pages=1 width=800 height=1120 direction=ltr --',
    '@@page n=1',
    '@@block id=B1 role=title col=0 section= x=60 y=40 w=680 h=44',
    '@@ocr id=L0 x=60 y=46 w=680 h=32 conf=0.97',
    '阿托伐他汀钙片电子说明书（扫描归档版 · 第1页）',
    '@@block id=B2 role=heading col=0 section=用法用量 x=60 y=104 w=300 h=28',
    '@@ocr id=Lh1 x=60 y=106 w=300 h=24 conf=0.96',
    '【用法用量】',
    '@@block id=B3 role=column col=0 section=用法用量 x=60 y=138 w=300 h=210',
    '@@ocr id=L1 x=64 y=150 w=292 h=24 conf=0.96',
    '成人及12岁以上儿童：每次10 mg，每日一次，口服。',
    '@@ocr id=L2 x=64 y=178 w=292 h=24 conf=0.95',
    '儿童按体重给药，单次0.5 g，分两次服用。',
    '@@ocr id=L3 x=64 y=206 w=292 h=24 conf=0.94',
    '给药方案见3类人群调整，餐后服用。',
    '@@ocr id=L4 x=64 y=234 w=292 h=24 conf=0.95',
    '肾功能不全患者无需调整给药间隔。',
    '@@block id=B4 role=table col=0 section=用法用量 x=60 y=372 w=680 h=150',
    '@@ocr id=L5 x=64 y=388 w=672 h=24 conf=0.93',
    '| 人群 | 起始剂量 | 维持剂量 | 给药频次 |',
    '@@ocr id=L5dup x=66 y=390 w=670 h=24 conf=0.81 dup=L5',
    '| 人群 | 起始剂量 | 维持剂量 | 给药频次 |',
    '@@ocr id=L6 x=64 y=418 w=672 h=24 conf=0.95',
    '| 成人 | 0.5 g | 1.0～2.0 g | 每日一次 |',
    '@@ocr id=L7 x=64 y=446 w=672 h=24 conf=0.94',
    '| 老年患者 | 0.25 g | 0.5 g | 每日一次 |',
    '@@ocr id=L8 x=64 y=474 w=672 h=24 conf=0.92',
    '| 肾功能不全 | 不用 | 按eGFR调整 | 见注意事项 |',
    '@@block id=B5 role=footnote col=0 section=注意事项 x=60 y=548 w=680 h=64',
    '@@ocr id=L9 x=64 y=558 w=672 h=22 conf=0.9',
    '注1：老年患者起始剂量可减至0.25 g，具体遵医嘱。',
    '@@ocr id=L10 x=64 y=584 w=672 h=22 conf=0.9',
    '注2：本表剂量以活性成分计，不含辅料重量。',
    '@@block id=B6 role=column col=1 section=禁忌 x=420 y=104 w=320 h=240',
    '@@ocr id=L11 x=424 y=106 w=312 h=24 conf=0.96',
    '【禁忌】',
    '@@ocr id=L12 x=424 y=134 w=312 h=24 conf=0.95',
    '对本品活性成分过敏者禁用。',
    '@@ocr id=L13 x=424 y=162 w=312 h=24 conf=0.95',
    '不得用于肌内注射，仅可静脉滴注。',
    '@@ocr id=L14 x=424 y=190 w=312 h=24 conf=0.94',
    '严重肝肾功能不全者禁用，单次剂量不得超过0.25 g。',
    '@@block id=B7 role=column col=1 section=注意事项 x=420 y=372 w=320 h=120',
    '@@ocr id=L15 x=424 y=384 w=312 h=24 conf=0.95',
    '【注意事项】',
    '@@ocr id=L16 x=424 y=412 w=312 h=24 conf=0.94',
    '用药期间应监测肾功能与凝血功能。',
    '@@block id=B8 role=paragraph col=0 section=注意事项 x=60 y=640 w=680 h=120',
    '@@ocr id=L17 x=64 y=664 w=672 h=24 conf=0.9',
    '本页跨栏提示：剂量调整须结合左右两栏阅读。',
    '@@ocr id=L18 x=420 y=700 w=320 h=24 conf=0.9',
    '（扫描行A）肝功能异常者慎用。',
    '@@ocr id=L19 x=422 y=701 w=318 h=24 conf=0.88',
    '（扫描行B）肝功能异常者需减量。',
    '@@ocr id=L20 x=300 y=262 w=220 h=24 conf=0.86',
    '（跨栏行）本页内容分左右两栏排列，请按栏阅读。',
]
layout_sample = ('\r\n'.join(layout_lines) + '\r\n').encode('utf-8')
emit('layout-complex-page.txt', layout_sample,
     '双栏/表格/脚注/OCR重复行/否定词跨列/行竞争/跨栏行的版面定位样例')

with open(os.path.join(OUT, 'manifest.txt'), 'w', encoding='utf-8') as f:
    f.write('# ByteLab sample labels — generated by scripts/generate-samples.py\n')
    for name, size, digest, note in MANIFEST:
        f.write(f'{name}\t{size}\t{digest}\t{note}\n')
print('manifest written')
