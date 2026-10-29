"""يبني أيقونة التطبيق من صورة الزجاجة: build/icon.png + build/icon.ico

الصورة الأصلية زجاجة على خلفية فاتحة، والأيقونة تحتاج مربعاً مقروءاً في 16 بكسل،
لذلك تُزال الخلفية الفاتحة بمفتاح لوني ثم تُركَّب الزجاجة على تدرّج أزرق بنفس لون
ترويسة الطباعة، مع هامش وحواف دائرية.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
SIDE = 1024
OUT.mkdir(parents=True, exist_ok=True)

img = Image.open(SRC).convert('RGBA')
W, H = img.size
print('source', SRC.name, img.size, 'corner=', img.getpixel((2, 2)))

# 1) مفتاح لوني: البكسلات الفاتحة جداً تصبح شفافة (خلفية الصورة الأصلية بيضاء/رمادية)
px = img.load()
TOL = 236
for y in range(H):
    for x in range(W):
        r, g, b, a = px[x, y]
        if a == 0:
            continue
        if r >= TOL and g >= TOL and b >= TOL:
            px[x, y] = (r, g, b, 0)

# 2) قصّ على حدود الزجاجة نفسها حتى لا نحمل فراغاً زائداً
bbox = img.getbbox()
bottle = img.crop(bbox)
print('cropped bottle', bottle.size)

# 3) خلفية متدرجة بحواف دائرية
grad = Image.new('RGBA', (SIDE, SIDE), (0, 0, 0, 0))
top, bottom = (30, 58, 138), (52, 110, 200)
for y in range(SIDE):
    t = y / (SIDE - 1)
    col = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    ImageDraw.Draw(grad).line([(0, y), (SIDE, y)], fill=col)
mask = Image.new('L', (SIDE, SIDE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIDE - 1, SIDE - 1], radius=int(SIDE * 0.19), fill=255)
grad.putalpha(mask)

# 4) تركيب الزجاجة بارتفاع 82% من الأيقونة مع ظل ناعم تحتها
target_h = int(SIDE * 0.82)
scale = target_h / bottle.height
bottle_r = bottle.resize((max(1, int(bottle.width * scale)), target_h), Image.LANCZOS)
shadow = Image.new('RGBA', (SIDE, SIDE), (0, 0, 0, 0))
sh = int(target_h * 0.045)
ImageDraw.Draw(shadow).ellipse(
    [(SIDE - bottle_r.width) / 2, SIDE * 0.90 - sh, (SIDE + bottle_r.width) / 2, SIDE * 0.90 + sh],
    fill=(0, 0, 0, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(sh / 2))
canvas = Image.alpha_composite(grad, shadow)
canvas.paste(bottle_r, ((SIDE - bottle_r.width) // 2, int(SIDE * 0.09)), bottle_r)

flat = canvas.convert('RGB')
flat.resize((1024, 1024), Image.LANCZOS).save(OUT / 'icon.png', optimize=True)
canvas.save(OUT / 'icon-1024.png', optimize=True)

canvas.resize((256, 256), Image.LANCZOS).save(
    OUT / 'icon.ico', format='ICO', sizes=[(s, s) for s in (256, 128, 64, 48, 32, 16)])

prev = OUT / 'icon-preview'
prev.mkdir(exist_ok=True)
for s in (16, 32, 48, 256):
    flat.resize((s, s), Image.LANCZOS).save(prev / f'icon-{s}.png')
for f in ('icon.png', 'icon-1024.png', 'icon.ico'):
    print(f, (OUT / f).stat().st_size, 'bytes')
