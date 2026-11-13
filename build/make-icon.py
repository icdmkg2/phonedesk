"""Draws installer/phonedesk.ico and the phone's PNG icons: logo C1 ("Dock").
A dark tile with a white monitor outline, and a blue phone overlapping its corner. Small sizes use their own
simpler drawing (thicker lines, a bigger phone) so the icon stays crisp in the tray."""
import os
from PIL import Image, ImageDraw

INK_TOP, INK_BOTTOM = (38, 41, 50), (12, 13, 17)
BLUE_A, BLUE_B = (107, 140, 255), (58, 63, 214)
WHITE = (255, 255, 255, 255)
INK = (12, 13, 17, 255)

# On a 64 grid: monitor rect, stroke, stand (x0, x1, y), phone rect, phone radius, cut-out width.
LARGE = dict(mon=(9, 15, 43, 38), mon_r=4.5, w=3.4, stand=(20, 32, 45), phone=(37.5, 25, 56, 54), phone_r=5, cut=3.2)
SMALL = dict(mon=(7, 13, 43, 38), mon_r=4.5, w=5.2, stand=(18, 31, 46), phone=(35, 23, 57.5, 56), phone_r=5.5, cut=4)


def gradient(size, a, b, diagonal):
    g = Image.new("RGBA", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = ((x + y) / (2.0 * (size - 1))) if diagonal else (y / float(size - 1))
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
    return g


def draw(size):
    d_ = SMALL if size <= 24 else LARGE
    ss = 4 if size >= 128 else 8
    S = size * ss
    u = S / 64.0
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # the tile: a dark vertical gradient in a rounded square
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=15 * u, fill=255)
    im.paste(gradient(S, INK_TOP, INK_BOTTOM, False), (0, 0), mask)
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = d_["mon"]
    w = d_["w"] * u
    d.rounded_rectangle([x0 * u, y0 * u, x1 * u, y1 * u], radius=d_["mon_r"] * u, outline=WHITE, width=int(round(w)))
    sx0, sx1, sy = d_["stand"]
    d.rounded_rectangle([sx0 * u, (sy - d_["w"] / 2) * u, sx1 * u, (sy + d_["w"] / 2) * u], radius=w / 2, fill=WHITE)
    # the phone: an ink cut-out, then the blue gradient inside it
    px0, py0, px1, py1 = d_["phone"]
    c = d_["cut"] / 2
    d.rounded_rectangle([(px0 - c) * u, (py0 - c) * u, (px1 + c) * u, (py1 + c) * u], radius=(d_["phone_r"] + c) * u, fill=INK)
    pm = Image.new("L", (S, S), 0)
    ImageDraw.Draw(pm).rounded_rectangle([(px0 + c) * u, (py0 + c) * u, (px1 - c) * u, (py1 - c) * u], radius=max(1, d_["phone_r"] - c) * u, fill=255)
    im.paste(gradient(S, BLUE_A, BLUE_B, True), (0, 0), pm)
    return im.resize((size, size), Image.LANCZOS)


here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "..", "installer", "phonedesk.ico")
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
imgs = [draw(s) for s in sizes]
imgs[-1].save(out, format="ICO", sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
# PNGs for the phone's home-screen icon and the Android app's launcher icon.
for s in (192, 512):
    draw(s).save(os.path.join(here, "..", "public", "phone", "icon-%d.png" % s))
print("wrote", os.path.abspath(out))
