"""Rebuild the homepage replace-PDF diagram: python scripts/artwork/replace-pdf.py (Pillow)."""
from pathlib import Path
from math import sin, pi
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[2] / "src/client/assets/home"
W, H, SCALE = 768, 512, 2
FONT = ImageFont.truetype("DejaVuSans.ttf", 21 * SCALE)
SMALL = ImageFont.truetype("DejaVuSans.ttf", 15 * SCALE)
INK, STAFF, EDGE, BG = "#4c625d", "#b3bfba", "#78908c", "#f8faf9"
ANN = ["#ab5571", "#b87a35", "#37799c"]


def ease(p):
    p = max(0, min(1, p))
    return p * p * (3 - 2 * p)


def frame(lift, swap, settle, show_arrow=False):
    im = Image.new("RGB", (W * SCALE, H * SCALE), BG)
    d = ImageDraw.Draw(im)

    def point(x, y, u, v):
        return ((x + u) * SCALE, (y + v + u * .38) * SCALE)

    def line(x, y, pts, color, width=1):
        d.line([point(x, y, *p) for p in pts], fill=color, width=max(1, width * SCALE), joint="curve")

    def poly(x, y, pts, fill=None, outline=None, width=1):
        mapped = [point(x, y, *p) for p in pts]
        if fill is not None:
            d.polygon(mapped, fill=fill)
        if outline:
            d.line(mapped + [mapped[0]], fill=outline, width=width * SCALE, joint="curve")

    bx, by = 332, 72
    corners = [(0, 0), (176, 0), (176, 294), (0, 294)]
    slide = ease(swap)
    old_x, new_x = bx - 230 * slide, bx + 230 * (1 - slide)

    def score(x, y, version, alpha=1):
        def mix(hexcolor):
            if alpha >= .999:
                return hexcolor
            a = tuple(int(hexcolor[i:i + 2], 16) for i in (1, 3, 5))
            b = tuple(int(BG[i:i + 2], 16) for i in (1, 3, 5))
            return tuple(round(bi + (ai - bi) * alpha) for ai, bi in zip(a, b))

        poly(x, y, corners, mix("#ffffff"), mix(EDGE), 2)
        px, py = point(x, y, 118, 16)
        d.rounded_rectangle((px, py, px + 42 * SCALE, py + 24 * SCALE), radius=7 * SCALE, fill=mix("#e8efed"))
        d.text((px + 8 * SCALE, py + 2 * SCALE), f"PDF {version}", font=SMALL, fill=mix(INK))
        for row in range(5):
            v = 52 + row * 48
            for staff in range(5):
                line(x, y, [(18, v + staff * 5), (158, v + staff * 5)], mix(STAFF))
            for n in range(6):
                u = 29 + n * 20
                delta = ((n + row) % 3 - 1) * 5
                if version == 2 and row == 2 and n in (2, 3):
                    delta += -9 if n == 2 else 8
                if version == 2 and row == 4 and n == 4:
                    delta -= 10
                vv = v + 10 + delta
                cx, cy = point(x, y, u, vv)
                d.ellipse((cx - 4 * SCALE, cy - 2 * SCALE, cx + 4 * SCALE, cy + 2 * SCALE), fill=mix(INK))
                line(x, y, [(u + 4, vv), (u + 4, vv - 18)], mix(INK))
        if version == 2:
            p1, p2 = point(x, y, 62, 143), point(x, y, 117, 185)
            d.rounded_rectangle((p1[0] - 4 * SCALE, p1[1] - 4 * SCALE, p2[0] + 4 * SCALE, p2[1] + 4 * SCALE), radius=6 * SCALE, outline=mix("#a8bbb6"), width=2 * SCALE)

    if slide < .999:
        score(old_x, by, 1, 1 - max(0, (slide - .35) / .65) * .55)
    if slide > .001:
        score(new_x, by, 2, max(.45, min(1, slide / .55)))

    active_lift = lift * (1 - settle)
    ax, ay = bx - 118 * active_lift, by + 38 * active_lift
    if active_lift > .02:
        poly(ax, ay, corners, None, ANN[2], 2)
        px, py = point(ax, ay, 12, 10)
        d.text((px, py), "Notes", font=FONT, fill=ANN[2])

    marks = [
        (ANN[0], [(28 + j * 2, 88 - 11 * sin(j * pi / 30)) for j in range(31)]),
        (ANN[1], [(63, 169), (119, 154), (68, 146)]),
        (ANN[2], [(97 + 16 * sin(j * 2 * pi / 44), 246 + 15 * sin(j * 2 * pi / 44 + pi / 2)) for j in range(45)]),
    ]
    for color, pts in marks:
        line(ax, ay, pts, color, 3)
    line(ax, ay, [(46, 112), (88, 112)], ANN[0], 3)
    line(ax, ay, [(116, 184), (144, 184)], ANN[1], 3)
    line(ax, ay, [(118, 266), (148, 266)], ANN[2], 3)

    if show_arrow and active_lift > .65 and .08 < swap < .92:
        cx, cy = 228 * SCALE, 322 * SCALE
        d.line((cx - 42 * SCALE, cy, cx + 42 * SCALE, cy), fill=EDGE, width=3 * SCALE)
        d.polygon([(cx + 42 * SCALE, cy), (cx + 29 * SCALE, cy - 8 * SCALE), (cx + 29 * SCALE, cy + 8 * SCALE)], fill=EDGE)
        d.text((cx - 33 * SCALE, cy + 13 * SCALE), "replace", font=SMALL, fill=EDGE)

    return im.resize((576, 384), Image.Resampling.LANCZOS)


frames = []
for n in range(60):
    t = n / 5
    if t < 1.3:
        lift, swap, settle = 0, 0, 0
    elif t < 2.7:
        lift, swap, settle = ease((t - 1.3) / 1.4), 0, 0
    elif t < 4.5:
        lift, swap, settle = 1, ease((t - 2.7) / 1.8), 0
    elif t < 5.3:
        lift, swap, settle = 1, 1, 0
    elif t < 6.7:
        lift, swap, settle = 1, 1, ease((t - 5.3) / 1.4)
    elif t < 8.8:
        lift, swap, settle = 0, 1, 1
    elif t < 9.7:
        lift, swap, settle = ease((t - 8.8) / .9), 1, 0
    elif t < 10.8:
        lift, swap, settle = 1, 1 - ease((t - 9.7) / 1.1), 0
    else:
        lift, swap, settle = 1, 0, ease((t - 10.8) / 1.2)
    frames.append(frame(lift, swap, settle, 2.7 <= t < 4.5))

frame(0, 1, 1).save(OUT / "replace-pdf.webp", quality=90)
palette = frame(1, 1, 0).quantize(colors=40)
gif_frames = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
gif_frames[0].save(OUT / "replace-pdf.gif", save_all=True, append_images=gif_frames[1:], duration=200, loop=0, optimize=True)
print(OUT / "replace-pdf.gif")
