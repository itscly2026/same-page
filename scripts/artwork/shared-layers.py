"""Rebuild the homepage diagram: python scripts/artwork/shared-layers.py (Pillow)."""
from pathlib import Path
from math import sin, pi
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[2] / 'src/client/assets/home'
W, H, SCALE = 768, 512, 2
COLORS = ['#557c53', '#37799c', '#8061a0', '#b87a35', '#ab5571']
LABELS = ['E', 'S', 'A', 'T', 'B']
FONT = ImageFont.truetype('DejaVuSans.ttf', 24 * SCALE)

def frame(spread, reveal):
    im = Image.new('RGB', (W*SCALE, H*SCALE), '#f8faf9')
    d = ImageDraw.Draw(im)
    def point(x, y, u, v): return ((x+u)*SCALE, (y+v+u*.38)*SCALE)
    def line(x, y, pts, color, width=1):
        d.line([point(x,y,*p) for p in pts], fill=color, width=width*SCALE, joint='curve')
    # The source score remains visible; annotation planes carry only marks.
    bx, by = 290+spread*240, 65-spread*42
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
        amount=max(0,min(1,reveal-i))
        if amount<=0: continue
        x=bx-spread*(i+1)*84; y=by+spread*(i+1)*27
        if spread>.02:
            line(x,y,corners,color,2)
            # Labels move with their planes, disappearing when overlaid.
            if spread>.3:
                px,py=point(x,y,8,6)
                d.text((px,py),label,font=FONT,fill=color)
        v=48+i*49
        # Distinct, musically familiar pen marks on different systems.
        if i in (0,2,4):
            pts=[(25+j*2,v-8-12*sin(j*pi/35)) for j in range(36)]
        elif i==1: pts=[(38,v+30),(102,v+17),(38,v+7)]
        else: pts=[(50+18*sin(j*2*pi/48),v+8+17*sin(j*2*pi/48+pi/2)) for j in range(49)]
        line(x,y,pts[:max(2,int(len(pts)*amount))],color,3)
    return im.resize((W,H),Image.Resampling.LANCZOS)

frames=[]
# Blank score; spread layers appear one at a time; merge, hold, then reopen.
for n in range(110):
    t=n/10
    if t<1: spread,reveal=1,0
    elif t<4: spread,reveal=1,(t-1)/3*5
    elif t<5: spread,reveal=1,5
    elif t<6.5:
        p=(t-5)/1.5; spread,reveal=1-(p*p*(3-2*p)),5
    elif t<9: spread,reveal=0,5
    elif t<10.5:
        p=(t-9)/1.5; spread,reveal=p*p*(3-2*p),5
    else: spread,reveal=1,5*(11-t)/.5
    frames.append(frame(spread,reveal))
# A shared palette prevents flicker between frames.
palette=frame(1,5).quantize(colors=96)
frames=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in frames]
frames[0].save(OUT/'shared-layers.gif',save_all=True,append_images=frames[1:],duration=100,loop=0,optimize=True)
print(OUT/'shared-layers.gif')
