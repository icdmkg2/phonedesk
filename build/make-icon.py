"""Draws installer/phonedesk.ico: icon A ("Live screen").
A blue tile with a dark landscape screen showing a level meter. Small sizes use their own simplified
drawing (3 thicker bars) so the icon stays crisp in the tray."""
import os
from PIL import Image, ImageDraw

BLUE = (91, 140, 255, 255)
DARK = (11, 12, 15, 255)
WHITE = (242, 243, 245, 255)

# Each design: (tile radius, screen rect, screen radius, [bars: x, y, w, h, color]) on a 64 grid.
LARGE = (15, (9, 18, 55, 46), 6.5, [
    (16, 35, 4.5, 4, BLUE), (23.5, 28, 4.5, 11, BLUE), (31, 23.5, 4.5, 15.5, WHITE),
    (38.5, 27, 4.5, 12, BLUE), (46, 32, 4.5, 7, BLUE)])
MEDIUM = (15, (8, 17, 56, 47), 7, [
    (20, 30, 6, 10, BLUE), (29, 24, 6, 16, WHITE), (38, 28, 6, 12, BLUE)])
SMALL = (14, (7, 16, 57, 48), 8, [
    (19, 30, 8, 10, BLUE), (28, 22, 8, 18, WHITE), (37, 27, 8, 13, BLUE)])


def draw(size):
    design = LARGE if size >= 48 else MEDIUM if size >= 24 else SMALL
    tile_r, screen, screen_r, bars = design
    ss = 8
    S = size * ss
    u = S / 64.0
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=tile_r * u, fill=BLUE)
    x0, y0, x1, y1 = screen
    d.rounded_rectangle([x0 * u, y0 * u, x1 * u, y1 * u], radius=screen_r * u, fill=DARK)
    for x, y, w, h, c in bars:
        d.rounded_rectangle([x * u, y * u, (x + w) * u, (y + h) * u], radius=min(w, h) * 0.33 * u, fill=c)
    return im.resize((size, size), Image.LANCZOS)


here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "..", "installer", "phonedesk.ico")
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
imgs = [draw(s) for s in sizes]
imgs[-1].save(out, format="ICO", sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
# PNGs for the phone's home-screen icon (browsers want raster icons for "Add to Home screen").
for s in (192, 512):
    draw(s).save(os.path.join(here, "..", "public", "phone", "icon-%d.png" % s))
print("wrote", os.path.abspath(out))
