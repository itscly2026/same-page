"""Rebuild the 2D homepage replace-PDF animation (Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[2] / "src/client/assets/home"
W, H = 768, 512
BG = (248, 250, 249, 255)
INK = (84, 106, 103, 255)
STAFF = (192, 202, 199, 255)
EDGE = (106, 129, 124, 255)
BLUE = (28, 131, 229, 255)
BLUE_NOTE = (47, 125, 168, 255)
RED = (227, 69, 97, 255)
ORANGE = (233, 149, 38, 255)
MUTED = (144, 162, 158, 255)
FONT = ImageFont.truetype("DejaVuSans.ttf", 23)
SMALL = ImageFont.truetype("DejaVuSans.ttf", 15)


def ease(p):
    p = max(0.0, min(1.0, p))
    return p * p * (3 - 2 * p)


def draw_note(d, x, y, color=INK, scale=1.0):
    rx, ry = 6 * scale, 4 * scale
    d.ellipse((x - rx, y - ry, x + rx, y + ry), fill=color)
    d.line((x + rx, y, x + rx, y - 28 * scale), fill=color, width=max(1, round(2 * scale)))


def draw_sharp(d, x, y, color=INK, scale=1.0):
    width = max(1, round(2 * scale))
    d.line((x - 5 * scale, y - 15 * scale, x - 5 * scale, y + 15 * scale), fill=color, width=width)
    d.line((x + 5 * scale, y - 17 * scale, x + 5 * scale, y + 13 * scale), fill=color, width=width)
    d.line((x - 10 * scale, y - 4 * scale, x + 10 * scale, y - 8 * scale), fill=color, width=max(1, round(3 * scale)))
    d.line((x - 10 * scale, y + 7 * scale, x + 10 * scale, y + 3 * scale), fill=color, width=max(1, round(3 * scale)))


def staff(d, x1, y, x2):
    for k in range(5):
        d.line((x1, y + k * 6, x2, y + k * 6), fill=STAFF, width=1)


def draw_page(d, x, y, label, version):
    pw, ph = 250, 352
    d.rounded_rectangle((x + 6, y + 7, x + pw + 6, y + ph + 7), radius=9, fill=(230, 235, 233, 255))
    d.rounded_rectangle((x, y, x + pw, y + ph), radius=9, fill=(255, 255, 255, 255), outline=EDGE, width=2)
    d.text((x + 18, y + 14), label, font=FONT, fill=INK)
    d.line((x + 18, y + 48, x + pw - 18, y + 48), fill=(222, 227, 225, 255), width=1)

    for row, sy in enumerate((104, 194, 284)):
        staff(d, x + 28, y + sy, x + pw - 24)
        if row == 0:
            draw_note(d, x + 92, y + sy + 12)
            draw_note(d, x + 174, y + sy + 6)
        elif row == 1:
            draw_note(d, x + 84, y + sy + 16)
            # The only score edit: same note becomes a clearly marked sharp in v2.
            if version == 1:
                draw_note(d, x + 176, y + sy + 12, color=ORANGE, scale=1.45)
            else:
                draw_sharp(d, x + 150, y + sy + 10, color=BLUE_NOTE, scale=1.12)
                draw_note(d, x + 180, y + sy + 12, color=BLUE_NOTE, scale=1.5)
        else:
            draw_note(d, x + 104, y + sy + 18)
            draw_note(d, x + 190, y + sy + 8)


def notes_layer(x, y, alpha=1.0):
    w, h = 222, 268
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    a = int(255 * alpha)
    d.rounded_rectangle(
        (x, y, x + w, y + h),
        radius=8,
        fill=(224, 242, 249, int(64 * alpha)),
        outline=(BLUE[0], BLUE[1], BLUE[2], a),
        width=3,
    )
    # Put the label below the PDF filename area so the two never collide.
    d.text((x + 14, y + 14), "Notes", font=FONT, fill=(BLUE[0], BLUE[1], BLUE[2], a))
    d.arc((x + 24, y + 80, x + 92, y + 124), 200, 340, fill=(RED[0], RED[1], RED[2], a), width=4)
    d.line((x + 38, y + 134, x + 96, y + 151), fill=(RED[0], RED[1], RED[2], a), width=4)
    d.line((x + 48, y + 184, x + 108, y + 220, x + 52, y + 221), fill=(ORANGE[0], ORANGE[1], ORANGE[2], a), width=4, joint="curve")
    d.ellipse((x + 144, y + 198, x + 184, y + 238), outline=(BLUE[0], BLUE[1], BLUE[2], a), width=4)
    return layer


def frame(t):
    im = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(im)
    left_x, right_x, top_y = 70, 448, 70

    draw_page(d, left_x, top_y, "final.pdf", 1)
    draw_page(d, right_x, top_y, "final_v2.pdf", 2)

    d.line((344, 246, 410, 246), fill=EDGE, width=4)
    d.polygon([(410, 246), (394, 236), (394, 256)], fill=EDGE)
    d.text((347, 267), "copy notes", font=SMALL, fill=EDGE)

    if t < 1.4:
        p = 0.0
    elif t < 4.4:
        p = ease((t - 1.4) / 3.0)
    else:
        p = 1.0

    start_x, end_x = left_x + 14, right_x + 14
    nx = round(start_x + (end_x - start_x) * p)
    ny = top_y + 62

    if 1.55 < t < 4.25:
        for trailing, alpha in ((0.08, 0.12), (0.16, 0.07)):
            ghost_p = max(0.0, p - trailing)
            gx = round(start_x + (end_x - start_x) * ghost_p)
            im.alpha_composite(notes_layer(gx, ny, alpha))

    im.alpha_composite(notes_layer(nx, ny))
    return im.convert("RGB")


frames = [frame(n / 10) for n in range(64)]
frames[0].save(
    OUT / "replace-pdf-animation.webp",
    save_all=True,
    append_images=frames[1:],
    duration=100,
    loop=0,
    quality=84,
    method=6,
)
frames[-1].save(OUT / "replace-pdf.webp", quality=90, method=6)
print(OUT / "replace-pdf-animation.webp")
