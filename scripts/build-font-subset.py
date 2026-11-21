"""Subset the Noto Sans/Serif CJK SC faces to the glyphs ByteLab can show.

The app deliberately ships self-hosted subsets so the review surface renders
identically on machines with no Chinese system font (headless checks, CI, thin
containers). The set covers: every CJK codepoint in the UI source and bundled
samples, the full GB2312 repertoire, the GBK extension rows common in drug
names, and the punctuation/marks used by the placeholder syntax.

Usage:
  python3 -m fontTools.subset NotoSansCJK-Regular.ttc?  (extract first)
  python scripts/build-font-subset.py --sans <NotoSansSC.otf> --serif <NotoSerifSC.otf>

Both source faces are OFL 1.1 (Noto CJK). The output lives in public/fonts/.
"""
import argparse
import glob
import os

PUNCT = set('\\u3000\\u3001\\u3002\\uff0c\\uff0e\\uff1b\\uff1a\\uff01\\uff1f\\u201c\\u201d\\u2018\\u2019'
            '\\uff08\\uff09\\u300a\\u300b\\u3010\\u3011\\u2014\\u2026\\u00b7\\uff05\\u00b1\\u00d7\\u00f7'
            '\\u2264\\u2265\\u2248\\uff5e\\uffe5\\u00b0\\u00b5\\u03a9\\u03b1\\u03b2\\u03b3\\u0394\\u03c0'
            '\\u2192\\u2190\\u2191\\u2193\\u27e6\\u27e7\\u26a0\\u2713\\u2717\\u2013\\u2014')

def collect(roots):
    chars = set(PUNCT)
    for root in roots:
        for p in glob.glob(os.path.join(root, '**', '*.ts'), recursive=True) + \
                 glob.glob(os.path.join(root, '**', '*.tsx'), recursive=True):
            with open(p, encoding='utf-8', errors='ignore') as f:
                chars.update(ch for ch in f.read() if ord(ch) > 0x7f)
    for p in glob.glob('public/samples/*.txt'):
        raw = open(p, 'rb').read()
        for enc in ('utf-8', 'gbk', 'big5', 'cp1252'):
            chars.update(ch for ch in raw.decode(enc, errors='ignore') if ord(ch) > 0x7f)
    # Full GB2312 (6763 hanzi) covers simplified labels; a GBK walk of the
    # 0xA1-0xF7 rows adds the traditional repertoire Big5 documents need,
    # without pulling in the rarely-used extension-A rows.
    for hi in range(0xA1, 0xF8):
        for lo in range(0x40, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode('gbk'))
            except Exception:
                pass
    return {c for c in chars
            if ord(c) > 0x7f and ord(c) <= 0xFFFF and not (0xD800 <= ord(c) <= 0xDFFF)}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sans', required=True)
    ap.add_argument('--serif', help='optional serif face (not shipped by default)')
    args = ap.parse_args()
    chars = collect(['src'])
    unis = ','.join(f'U+{ord(c):04X}' for c in sorted(chars))
    with open('/tmp/bytelab-glyphs.txt', 'w') as f:
        f.write(unis)
    os.makedirs('public/fonts', exist_ok=True)
    for src, out in ((args.sans, 'public/fonts/bytelab-cjk.woff2'),):
        os.system(
            f'{os.sys.executable} -m fontTools.subset {src} '
            f'--unicodes-file=/tmp/bytelab-glyphs.txt --flavor=woff2 '
            f'--output-file={out} --layout-features="" --no-hinting')
        print('wrote', out, os.path.getsize(out), 'bytes', f'({len(chars)} glyphs requested)')

if __name__ == '__main__':
    main()
