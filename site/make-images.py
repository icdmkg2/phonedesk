"""Web-sized copies of the screenshots the home page shows (site/img/*.webp, committed).

The changelog keeps the full PNGs from docs/changelog. Run after adding a screenshot to index.html:
    python3 site/make-images.py
Each picture gets two widths (for srcset); index.html then uses
    <img src="img/<name>-1200.webp" srcset="img/<name>-640.webp 640w, img/<name>-1200.webp 1200w" sizes="...">
"""
import os
import re
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'img')
WIDTHS = (640, 1200)


def name_of(src):
    # shots/1.8.0/phone-now-playing.png -> 1.8.0-phone-now-playing
    return src.replace('shots/', '').replace('/', '-').rsplit('.', 1)[0]


def main():
    html = open(os.path.join(HERE, 'index.html'), encoding='utf-8').read()
    srcs = sorted(set(re.findall(r'(?:src|data-src)="(shots/[^"]+\.png)"', html)) | set(re.findall(r'data-shot="(shots/[^"]+\.png)"', html)))
    os.makedirs(OUT, exist_ok=True)
    for src in srcs:
        im = Image.open(os.path.join(ROOT, 'docs', 'changelog', src[len('shots/'):])).convert('RGB')
        for w in WIDTHS:
            h = round(im.height * w / im.width)
            out = os.path.join(OUT, f'{name_of(src)}-{w}.webp')
            im.resize((w, h), Image.LANCZOS).save(out, 'WEBP', quality=82, method=6)
        print(src)


if __name__ == '__main__':
    main()
