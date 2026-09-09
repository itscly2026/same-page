"""Rebuild the approved 4.8 s offline-sync homepage WebP preview (Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

OUT = Path(__file__).resolve().parents[2] / 'src/client/assets/home'
OUT.mkdir(parents=True, exist_ok=True)
W, H = 768, 512
BG = (248, 250, 249, 255)
INK = (84, 106, 103, 255)
STAFF = (192, 202, 199, 255)
EDGE = (106, 129, 124, 255)
SHADOW = (226, 232, 230, 255)
BLUE = (28, 131, 229, 255)
BLUE_SOFT = (214, 237, 252, 255)
RED = (227, 69, 97, 255)
ORANGE = (233, 149, 38, 255)
GREEN = (80, 168, 111, 255)
MUTED = (152, 168, 163, 255)
LIGHT = (255, 255, 255, 255)
FONT = ImageFont.truetype('DejaVuSans.ttf', 23)
SMALL = ImageFont.truetype('DejaVuSans.ttf', 16)
TINY = ImageFont.truetype('DejaVuSans.ttf', 14)
FPS = 20
FRAME_COUNT = 94
PAGE_W, PAGE_H = 250.0, 320.0


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease(p):
    p = clamp(p)
    return p * p * (3 - 2 * p)


def lerp(a, b, p):
    return a + (b - a) * p


def mix(c1, c2, p):
    return tuple(round(lerp(a, b, p)) for a, b in zip(c1, c2))


def draw_note(draw, x, y, color=INK, scale=1.0):
    rx, ry = 5.5 * scale, 4 * scale
    draw.ellipse((x-rx, y-ry, x+rx, y+ry), fill=color)
    draw.line((x+rx, y, x+rx, y-26*scale), fill=color, width=max(1, round(2*scale)))


def page_mapper(rect):
    x, y, w, h = rect
    sx, sy = w / PAGE_W, h / PAGE_H
    def map_xy(pt):
        return (x + pt[0] * sx, y + pt[1] * sy)
    return map_xy, sx, sy


def map_points(rect, pts):
    map_xy, _, _ = page_mapper(rect)
    return [map_xy(p) for p in pts]


def draw_score_page(base, rect, score_alpha=1.0, notes_alpha=1.0):
    x, y, w, h = rect
    d = ImageDraw.Draw(base)
    d.rounded_rectangle((x + 8, y + 9, x + w + 8, y + h + 9), radius=12, fill=SHADOW)
    d.rounded_rectangle((x, y, x + w, y + h), radius=12, fill=LIGHT, outline=EDGE, width=2)
    map_xy, sx, sy = page_mapper(rect)
    X = lambda v: map_xy((v, 0))[0]
    Y = lambda v: map_xy((0, v))[1]
    d.text((X(20), Y(16)), 'score.pdf', font=FONT, fill=mix(MUTED, INK, score_alpha))
    d.line((X(20), Y(50), X(230), Y(50)), fill=(225, 230, 228, 255), width=1)
    staff_color = mix((236, 240, 239, 255), STAFF, score_alpha)
    note_color = mix((235, 240, 239, 255), INK, score_alpha)
    note_scale = min(sx, sy) * 0.95
    for row, base_y in enumerate((92, 168, 244)):
        for k in range(5):
            d.line((X(28), Y(base_y + k * 6), X(222), Y(base_y + k * 6)), fill=staff_color, width=1)
        positions = [
            [(64,12),(114,0),(170,18),(214,6)],
            [(58,16),(122,6),(180,14),(218,8)],
            [(76,18),(136,8),(188,20),(220,6)],
        ][row]
        for px, py in positions:
            draw_note(d, X(px), Y(base_y + py), color=note_color, scale=note_scale)
    layer = Image.new('RGBA', (W, H), (0,0,0,0))
    nd = ImageDraw.Draw(layer)
    a = int(255 * notes_alpha)
    existing_green = (GREEN[0], GREEN[1], GREEN[2], a)
    existing_blue = (BLUE[0], BLUE[1], BLUE[2], a)
    pts = map_points(rect, [(152, 206), (196, 190), (214, 176)])
    nd.line(pts, fill=existing_green, width=4, joint='curve')
    nd.polygon([(pts[-1][0], pts[-1][1]), (pts[-1][0]-8, pts[-1][1]-3), (pts[-1][0]-3, pts[-1][1]+7)], fill=existing_green)
    nd.line(map_points(rect, [(58, 286), (58, 306), (92, 306)]), fill=existing_blue, width=4, joint='curve')
    base.alpha_composite(layer)


def draw_tablet(base, x, y, w, h, score_alpha=1.0, notes_alpha=1.0):
    d = ImageDraw.Draw(base)
    d.rounded_rectangle((x + 14, y + 18, x + w + 14, y + h + 18), radius=26, fill=(223, 229, 227, 255))
    d.rounded_rectangle((x, y, x + w, y + h), radius=28, fill=(56, 76, 78, 255))
    d.rounded_rectangle((x + 18, y + 18, x + w - 18, y + h - 18), radius=14, fill=(250, 252, 252, 255))
    screen_x, screen_y = x + 34, y + 30
    screen_w, screen_h = w - 68, h - 60
    page_rect = (screen_x + 20, screen_y + 12, screen_w - 40, screen_h - 24)
    if score_alpha <= 0:
        d.rounded_rectangle((screen_x, screen_y, screen_x + screen_w, screen_y + screen_h), radius=8, fill=(245, 247, 247, 255), outline=(230,234,233,255), width=1)
        for k in range(4):
            yy = screen_y + 52 + k*46
            d.line((screen_x + 40, yy, screen_x + screen_w - 40, yy), fill=(233,237,236,255), width=2)
    else:
        draw_score_page(base, page_rect, score_alpha=score_alpha, notes_alpha=notes_alpha)
    d.ellipse((x + w/2 - 4, y + 8, x + w/2 + 4, y + 16), fill=(103, 120, 122, 255))
    return page_rect


def draw_cloud_panel(base, x, y, w, h, notes_visible=1.0):
    d = ImageDraw.Draw(base)
    d.rounded_rectangle((x + 6, y + 8, x + w + 6, y + h + 8), radius=18, fill=SHADOW)
    d.rounded_rectangle((x, y, x + w, y + h), radius=18, fill=(255,255,255,255), outline=EDGE, width=2)
    d.text((x + 22, y + 16), 'Cloud notes', font=FONT, fill=INK)
    cy = y + 52
    d.ellipse((x + 178, cy, x + 214, cy + 26), fill=BLUE_SOFT, outline=BLUE, width=2)
    d.ellipse((x + 194, cy - 10, x + 232, cy + 20), fill=BLUE_SOFT, outline=BLUE, width=2)
    d.ellipse((x + 215, cy + 2, x + 248, cy + 24), fill=BLUE_SOFT, outline=BLUE, width=2)
    d.rectangle((x + 189, cy + 13, x + 232, cy + 24), fill=BLUE_SOFT)
    d.line((x + 189, cy + 24, x + 232, cy + 24), fill=BLUE, width=2)
    page_rect = (x + 22, y + 74, w - 44, h - 96)
    draw_score_page(base, page_rect, score_alpha=1.0, notes_alpha=notes_visible)
    return page_rect


def partial_points(points, progress):
    progress = clamp(progress)
    if progress <= 0:
        return []
    if progress >= 1:
        return points
    total = len(points)
    keep = max(2, int(round(1 + (total - 1) * progress)))
    return points[:keep]


def draw_mark(base, points, color, progress, width=4, extra=None):
    pts = partial_points(points, progress)
    if len(pts) >= 2:
        d = ImageDraw.Draw(base)
        d.line(pts, fill=color, width=width, joint='curve')
    if extra:
        for pts2, start_progress in extra:
            pp = clamp((progress - start_progress) / max(1e-6, 1 - start_progress))
            ptsx = partial_points(pts2, pp)
            if len(ptsx) >= 2:
                d = ImageDraw.Draw(base)
                d.line(ptsx, fill=color, width=width, joint='curve')


def draw_sync_connection(base, online_strength=1.0, broken_strength=0.0, pulses=()):
    d = ImageDraw.Draw(base)
    x1, y1 = 392, 250
    x2, y2 = 490, 250
    if online_strength > 0:
        col = mix((215,224,222,255), BLUE, online_strength)
        d.line((x1, y1, x2, y2), fill=col, width=5)
        d.polygon([(x2, y2), (x2-15, y2-10), (x2-15, y2+10)], fill=col)
    if broken_strength > 0:
        col = mix((215,224,222,255), MUTED, broken_strength)
        d.line((x1, y1, x1+34, y1), fill=col, width=5)
        d.line((x1+66, y1, x2, y2), fill=col, width=5)
        d.line((x1+41, y1-10, x1+55, y1+10), fill=(RED[0], RED[1], RED[2], int(255*broken_strength)), width=4)
        d.line((x1+55, y1-10, x1+41, y1+10), fill=(RED[0], RED[1], RED[2], int(255*broken_strength)), width=4)
    for p in pulses:
        cx = lerp(x1+8, x2-24, p)
        for dx in (0, 12):
            d.ellipse((cx+dx-4, y1-4, cx+dx+4, y1+4), fill=BLUE)


def draw_stylus(base, x, y, angle=-0.95):
    layer = Image.new('RGBA', (W,H), (0,0,0,0))
    d = ImageDraw.Draw(layer)
    length = 86
    width = 10
    tip = (x, y)
    bx = x + math.cos(angle) * length
    by = y + math.sin(angle) * length
    perp = (math.sin(angle), -math.cos(angle))
    p1 = (tip[0] + perp[0]*width/2, tip[1] + perp[1]*width/2)
    p2 = (tip[0] - perp[0]*width/2, tip[1] - perp[1]*width/2)
    p3 = (bx - perp[0]*width/2, by - perp[1]*width/2)
    p4 = (bx + perp[0]*width/2, by + perp[1]*width/2)
    shadow = [(px+4, py+6) for px,py in (p1,p2,p3,p4)]
    d.polygon(shadow, fill=(213,219,217,180))
    d.polygon([p1,p2,p3,p4], fill=(255,255,255,245), outline=(220,225,224,255))
    d.polygon([p1,p2,(tip[0]-math.cos(angle)*12, tip[1]-math.sin(angle)*12)], fill=(232,236,235,255), outline=(215,219,219,255))
    base.alpha_composite(layer)


def storyboard_state(t):
    score_p = 0.0
    local_existing = 0.0
    mark1_local = mark1_cloud = 0.0
    mark2_local = mark2_cloud = 0.0
    mark3_local = mark3_cloud = 0.0
    online = 1.0
    broken = 0.0
    pulses = []
    stylus = None
    status_text = None
    if t < 0.65:
        pulses = [ease((t-0.08)/0.45)] if t > 0.08 else []
    elif t < 1.15:
        p = ease((t-0.65)/0.50)
        score_p = local_existing = p
        pulses = [clamp((t-0.65)/0.50)]
    else:
        score_p = local_existing = 1.0
        if t < 1.75:
            p = ease((t-1.15)/0.60)
            mark1_local = p
            mark1_cloud = max(0.0, ease((t-1.28)/0.42))
            stylus = ('mark1', p)
        else:
            mark1_local = mark1_cloud = 1.0
            if t < 3.35:
                p_off = ease((t-1.75)/1.60)
                online = 0.0
                broken = 1.0
                mark2_local = clamp(p_off * 1.2)
                mark3_local = clamp((p_off - 0.38) / 0.62)
                stylus = ('mark2', mark2_local) if p_off < 0.65 else ('mark3', mark3_local)
                status_text = 'Offline'
            elif t < 4.15:
                p = ease((t-3.35)/0.80)
                mark2_local = mark3_local = 1.0
                mark2_cloud = clamp(p * 1.25)
                mark3_cloud = clamp((p - 0.32) / 0.68)
                pulses = [clamp(p - 0.02), clamp(p * 0.80)]
                status_text = 'Syncing'
            else:
                mark2_local = mark2_cloud = 1.0
                mark3_local = mark3_cloud = 1.0
    return dict(score_p=score_p, local_existing=local_existing, mark1_local=mark1_local,
                mark1_cloud=mark1_cloud, mark2_local=mark2_local, mark2_cloud=mark2_cloud,
                mark3_local=mark3_local, mark3_cloud=mark3_cloud, online=online, broken=broken,
                pulses=pulses, stylus=stylus, status_text=status_text)


def mark_geometry(rect):
    m1 = map_points(rect, [(48 + j*1.7, 130 - 10*math.sin(j*math.pi/34)) for j in range(35)])
    m2a = map_points(rect, [(162, 214), (218, 198), (164, 186)])
    m2b = map_points(rect, [(172, 228), (222, 228)])
    cx, cy, r = 108, 286, 22
    m3 = map_points(rect, [(cx + r*math.cos(2*math.pi*j/48), cy + r*math.sin(2*math.pi*j/48)) for j in range(49)])
    return m1, m2a, m2b, m3


def render_frame(t):
    state = storyboard_state(t)
    im = Image.new('RGBA', (W,H), BG)
    d = ImageDraw.Draw(im)
    d.text((66, 36), 'Tablet', font=SMALL, fill=MUTED)
    d.text((566, 58), 'Cloud', font=SMALL, fill=MUTED)
    tablet_page = draw_tablet(im, 66, 74, 318, 364, score_alpha=state['score_p'], notes_alpha=state['local_existing'])
    cloud_page = draw_cloud_panel(im, 506, 102, 208, 292, notes_visible=1.0)
    t1, t2a, t2b, t3 = mark_geometry(tablet_page)
    c1, c2a, c2b, c3 = mark_geometry(cloud_page)
    draw_mark(im, t1, RED, state['mark1_local'], width=4)
    draw_mark(im, t2a, ORANGE, state['mark2_local'], width=4, extra=[(t2b, 0.72)])
    draw_mark(im, t3, BLUE, state['mark3_local'], width=4)
    draw_mark(im, c1, RED, state['mark1_cloud'], width=4)
    draw_mark(im, c2a, ORANGE, state['mark2_cloud'], width=4, extra=[(c2b, 0.72)])
    draw_mark(im, c3, BLUE, state['mark3_cloud'], width=4)
    draw_sync_connection(im, online_strength=state['online'], broken_strength=state['broken'], pulses=state['pulses'])
    if state['status_text']:
        chip_text = state['status_text']
        chip_w = 82 if chip_text == 'Offline' else 88
        d.rounded_rectangle((274, 86, 274+chip_w, 114), radius=12, fill=(245,247,247,255), outline=(222,228,226,255), width=2)
        fill = ORANGE if chip_text == 'Offline' else BLUE
        d.ellipse((286, 96, 296, 106), fill=fill)
        d.text((304, 91), chip_text, font=TINY, fill=INK)
    if t < 1.15 and state['score_p'] < 1:
        p = clamp((t-0.1)/0.9)
        ax = lerp(495, 396, p)
        d.line((ax, 126, ax, 154), fill=BLUE, width=4)
        d.polygon([(ax, 154), (ax-10, 140), (ax+10, 140)], fill=BLUE)
    if state['stylus']:
        kind, p = state['stylus']
        if kind == 'mark1':
            pt = partial_points(t1, p)
            if pt:
                tip = pt[-1]
                draw_stylus(im, tip[0]+8, tip[1]-6, angle=-0.95)
        elif kind == 'mark2':
            pt = partial_points(t2a, clamp(p/0.72)) if p < 0.72 else partial_points(t2b, clamp((p-0.72)/0.28))
            if pt:
                tip = pt[-1]
                draw_stylus(im, tip[0]+12, tip[1]-8, angle=-0.75)
        else:
            pt = partial_points(t3, p)
            if pt:
                tip = pt[-1]
                draw_stylus(im, tip[0]+10, tip[1]-4, angle=-1.12)
    d.text((182, 458), 'Keep writing offline — sync when reconnected', font=SMALL, fill=MUTED)
    return im


def main():
    static_im = render_frame(4.6).convert('RGB')
    static_im.save(OUT / 'offline-sync.webp', lossless=True, method=6)
    frames = [render_frame(n / FPS).convert('RGB') for n in range(FRAME_COUNT)]
    frames.append(static_im)
    frames[0].save(
        OUT / 'offline-sync-animation.webp', save_all=True, append_images=frames[1:],
        duration=[50]*FRAME_COUNT + [100], loop=1, lossless=True, method=6,
        minimize_size=True,
    )
    print(OUT / 'offline-sync-animation.webp')


if __name__ == '__main__':
    main()
