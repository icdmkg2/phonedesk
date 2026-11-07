"""Draws installer/phonedesk.ico (same design as public/phone/icon.svg), sharp at every size."""
import os
from PIL import Image, ImageDraw

def draw(size):
    ss = 8  # supersample, then downscale for clean edges
    S = size * ss
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = S / 96.0
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=22 * u, fill=(14, 15, 18, 255))
    # Thicker lines at tray sizes so the screen outline doesn't vanish.
    stroke = max(5 * u, 1.7 * ss) if size <= 24 else 5 * u
    d.rounded_rectangle([16 * u, 28 * u, 80 * u, 68 * u], radius=8 * u, outline=(91, 140, 255, 255), width=int(round(stroke)))
    d.polygon([(42 * u, 39 * u), (42 * u, 57 * u), (56 * u, 48 * u)], fill=(242, 243, 245, 255))
    return im.resize((size, size), Image.LANCZOS)

out = os.path.join(os.path.dirname(__file__), "..", "installer", "phonedesk.ico")
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
imgs = [draw(s) for s in sizes]
imgs[-1].save(out, format="ICO", sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
print("wrote", os.path.abspath(out))
