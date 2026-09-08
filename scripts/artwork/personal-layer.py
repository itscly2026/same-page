"""Rebuild the homepage diagram: python scripts/artwork/personal-layer.py (Pillow)."""
from pathlib import Path
from math import sin, pi
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[2] / 'src/client/assets/home'
W, H, SCALE = 768, 512, 2
COLORS = ['#ab5571', '#b87a35', '#8061a0', '#37799c', '#557c53', '#014653']
LABELS = ['B', 'T', 'A', 'S', 'E', 'Me']
FONT = ImageFont.truetype('DejaVuSans.ttf', 24 * SCALE)

def frame(spread, selection, personal):
    im = Image.new('RGB', (W*SCALE, H*SCALE), '#f8faf9')
    d = ImageDraw.Draw(im)
    def point(x, y, u, v): return ((x+u)*SCALE, (y+v+u*.38)*SCALE)
    def line(x, y, pts, color, width=1):
        d.line([point(x,y,*p) for p in pts], fill=color, width=width*SCALE, joint='curve')
    # The source score remains visible; annotation planes carry only marks.
    bx, by = 290+spread*270, 65-spread*42
    corners = [(0,0),(140,0),(140,280),(0,280),(0,0)]
    d.polygon([point(bx,by,*p) for p in corners], fill='#ffffff')
    line(bx,by,corners,'#78908c',2)
    for row in range(5):
        v=48+row*49
        for staff in range(5): line(bx,by,[(15,v+staff*5),(126,v+staff*5)],'#b3bfba')
        for n in range(5):
            u=25+n*21; vv=v+10+((n+row)%3-1)*5
            px,py=point(bx,by,u,vv)
            d.ellipse((px-4*SCALE,py-2*SCALE,px+4*SCALE,py+2*SCALE),fill='#4c625d')
            line(bx,by,[(u+4,vv),(u+4,vv-18)],'#4c625d')
    for i,(color,label) in enumerate(zip(COLORS,LABELS)):
        amount = personal if label == 'Me' else 1
        if label in ('B', 'A', 'S'):
            rgb = tuple(int(color[j:j+2],16) for j in (1,3,5))
            color = tuple(round(c+(220-c)*selection) for c in rgb)
        if amount<=0: continue
        if selection >= 1 and label in ('B', 'A', 'S') and spread < .02: continue
        x=bx-spread*(i+1)*70; y=by+spread*(i+1)*22
        if spread>.02:
            line(x,y,corners,color,2)
            # Labels move with their planes, disappearing when overlaid.
            if spread>.3:
                px,py=point(x,y,8,6)
                d.text((px,py),label,font=FONT,fill=color)
                if label == 'Me':
                    # Lock: personal notes are private by default.
                    line(x,y,[(105,18),(105,10),(108,6),(114,6),(117,10),(117,18)],color,2)
                    line(x,y,[(102,18),(120,18),(120,34),(102,34),(102,18)],color,2)
                elif label in ('B','A','S') and selection > .5:
                    line(x,y,[(103,13),(120,30)],color,2)
        if label == 'Me':
            # A little hand-drawn smile, revealed stroke by stroke.
            strokes = [
                [(66+25*sin(j*2*pi/64),218-25*sin(j*2*pi/64+pi/2)) for j in range(65)],
                [(57,211),(57,215)],
                [(75,211),(75,215)],
                [(55+j,223+7*sin(j*pi/22)) for j in range(23)],
            ]
            for stroke_index, pts in enumerate(strokes):
                progress = max(0, min(1, amount*4-stroke_index))
                if progress > 0:
                    line(x,y,pts[:max(2,round(1+(len(pts)-1)*progress))],color,3)
            continue
        v=42+i*37
        # Distinct, musically familiar pen marks on different systems.
        if i in (0,2,4):
            pts=[(25+j*2,v-8-12*sin(j*pi/35)) for j in range(36)]
        elif i==1: pts=[(38,v+30),(102,v+17),(38,v+7)]
        else: pts=[(50+18*sin(j*2*pi/48),v+8+17*sin(j*2*pi/48+pi/2)) for j in range(49)]
        # Draw two separate strokes per layer, one after the other.
        first = min(1, amount * 2)
        line(x,y,pts[:max(2,int(len(pts)*first))],color,3)
        second = max(0, amount * 2 - 1)
        if second > 0:
            line(x,y,[(82,v+30),(82+30*second,v+30)],color,3)
    return im.resize((W,H),Image.Resampling.LANCZOS)


# All shared marks -> choose E/T -> draw a private smiley -> overlay.
frames=[]
for n in range(130):
    t=n/10
    if t<2: spread,selection,personal=1,0,0
    elif t<3: spread,selection,personal=1,t-2,0
    elif t<4: spread,selection,personal=1,1,0
    elif t<6: spread,selection,personal=1,1,(t-4)/2
    elif t<7: spread,selection,personal=1,1,1
    elif t<8.5:
        p=(t-7)/1.5; spread,selection,personal=1-p*p*(3-2*p),1,1
    elif t<10.5: spread,selection,personal=0,1,1
    elif t<12:
        p=(t-10.5)/1.5; spread,selection,personal=p*p*(3-2*p),1,1
    else: spread,selection,personal=1,13-t,13-t
    frames.append(frame(spread,selection,personal))
frame(1,1,1).save(OUT/'personal-layer.webp',quality=90)
palette=frame(1,0,1).quantize(colors=96)
frames=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in frames]
frames[0].save(OUT/'personal-layer.gif',save_all=True,append_images=frames[1:],duration=100,loop=0,optimize=True)
