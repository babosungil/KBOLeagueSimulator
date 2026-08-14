#!/usr/bin/env python3
"""
번들 폰트 재생성 스크립트.

www/assets/fonts/*.woff2 를 처음부터 다시 만든다.
선수 데이터(CSV)가 바뀌어 새로운 한글 음절이 등장하면 다시 실행할 것.

    pip install fonttools brotli
    python tools/build-fonts.py

서브셋 기준
  · 한글 : KS X 1001 상용 2350자 + 프로젝트 소스/CSV에 실제로 등장하는 문자
  · 라틴 : ASCII + Latin-1 + 상용 문장부호
  · 이모지는 제외한다 (시스템 이모지 폰트가 처리)

굵기는 400·700 2종만 만든다. 자세한 이유는 www/css/fonts.css 주석 참고.
"""
import glob
import os
import sys
import tempfile
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WWW = os.path.join(ROOT, 'www')
OUT = os.path.join(WWW, 'assets', 'fonts')
GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl'

# (원본 URL, 가변폰트 여부, 출력 이름)
SOURCES = [
    (f'{GF}/notosanskr/NotoSansKR%5Bwght%5D.ttf',      True,  'NotoSansKR'),
    (f'{GF}/blackhansans/BlackHanSans-Regular.ttf',    False, 'BlackHanSans'),
    (f'{GF}/bebasneue/BebasNeue-Regular.ttf',          False, 'BebasNeue'),
    (f'{GF}/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf', True, 'JetBrainsMono'),
]
# 라틴 전용 폰트는 한글 서브셋을 넣지 않는다
LATIN_ONLY = {'BebasNeue', 'JetBrainsMono'}


def is_ksx1001(ch):
    """KS X 1001 상용 한글 2350자에 속하는지."""
    try:
        b = ch.encode('euc_kr')
    except Exception:
        return False
    return len(b) == 2 and 0xA1 <= b[0] <= 0xFE and 0xA1 <= b[1] <= 0xFE


def build_charset():
    latin  = {chr(c) for c in range(0x20, 0x7F)}
    latin |= {chr(c) for c in range(0xA0, 0x100)}
    latin |= set('‘’“”–—…·•→←↑↓×÷≤≥±°')

    hangul = {chr(cp) for cp in range(0xAC00, 0xD7A4) if is_ksx1001(chr(cp))}
    hangul |= set('※★☆○●△▲▽▼□■◇◆')

    # 실제 소스/데이터에 등장하는 문자 (선수 이름 포함)
    found = set()
    for pat in ('index.html', 'css/*.css', 'js/*.js', 'data/**/*.csv'):
        for p in glob.glob(os.path.join(WWW, pat), recursive=True):
            try:
                found |= set(open(p, encoding='utf-8', errors='ignore').read())
            except OSError:
                pass
    # 이모지·기호 영역은 시스템 폰트가 담당하므로 제외
    found = {c for c in found if ord(c) < 0x2500 and c.isprintable()}

    return latin, hangul | found | latin


def make(font, out_path, text):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    opts.notdef_outline = True
    opts.desubroutinize = True
    opts.drop_tables += ['DSIG']
    s = subset.Subsetter(options=opts)
    s.populate(text=text)
    s.subset(font)
    font.flavor = 'woff2'
    font.save(out_path)
    return os.path.getsize(out_path)


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    print(f'  다운로드 {url.rsplit("/", 1)[-1]}')
    urllib.request.urlretrieve(url, dest)
    return dest


def main():
    os.makedirs(OUT, exist_ok=True)
    latin_set, full_set = build_charset()
    latin_text, full_text = ''.join(sorted(latin_set)), ''.join(sorted(full_set))
    print(f'서브셋 대상: 한글 포함 {len(full_set)}자 / 라틴 전용 {len(latin_set)}자\n')

    tmp = tempfile.mkdtemp(prefix='kbofonts-')
    total = 0
    for url, is_vf, name in SOURCES:
        src = fetch(url, os.path.join(tmp, name + '.ttf'))
        text = latin_text if name in LATIN_ONLY else full_text
        weights = ((400, 'Regular'), (700, 'Bold')) if is_vf else ((400, 'Regular'),)
        for wght, tag in weights:
            font = TTFont(src)
            if is_vf:
                font = instancer.instantiateVariableFont(
                    font, {'wght': wght}, updateFontNames=False)
            dest = os.path.join(OUT, f'{name}-{tag}.woff2')
            size = make(font, dest, text)
            total += size
            print(f'  {name}-{tag:8} {size / 1024:7.0f} KB')

    print(f'\n합계 {total / 1024:.0f} KB ({total / 1024 / 1024:.2f} MB)')


if __name__ == '__main__':
    sys.exit(main())
