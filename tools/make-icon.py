# Draws the Lantern Client icon (the weapon emblem in its hexagon, tools/icon.svg) and writes launcher/icon.ico: 32-bit
# images for 16-128 px, PNG for 256 px, the way Windows expects. Run once; the .ico is kept in the repo.
# Needs Pillow and Playwright (Chromium) to rasterise the SVG.
import io, os, struct, sys
from PIL import Image, ImageFilter

S = 1024
def draw():
    from playwright.sync_api import sync_playwright
    svg = open(os.path.join(os.path.dirname(__file__), "icon.svg")).read()
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": S, "height": S})
        pg.set_content(f'<body style="margin:0;background:transparent">{svg.replace("<svg ", f"<svg width={S} height={S} ", 1)}</body>')
        art = Image.open(io.BytesIO(pg.screenshot(omit_background=True))).convert("RGBA")
        b.close()
    # soft aether glow behind the art, kept inside the icon's edges
    glow = Image.new("RGBA", (S, S), (60, 235, 255, 0))
    glow.putalpha(art.getchannel("A").point(lambda a: a * 110 // 255))
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(S * 0.02)))
    img.alpha_composite(art)
    return img

def dib(im):
    w, h = im.size
    px = im.tobytes("raw", "BGRA")
    rows = [px[y * w * 4:(y + 1) * w * 4] for y in range(h)][::-1]
    mask_row = ((w + 31) // 32) * 4
    head = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4 + mask_row * h, 0, 0, 0, 0)
    return head + b"".join(rows) + b"\0" * (mask_row * h)

big = draw()
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
images = []
for s in sizes:
    im = big.resize((s, s), Image.LANCZOS)
    if s == 256:
        b = io.BytesIO(); im.save(b, "PNG"); images.append((s, b.getvalue()))
    else:
        images.append((s, dib(im)))
out = struct.pack("<HHH", 0, 1, len(images))
off = 6 + 16 * len(images)
for s, data in images:
    out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), off)
    off += len(data)
out += b"".join(d for _, d in images)
open(sys.argv[1] if len(sys.argv) > 1 else "launcher/icon.ico", "wb").write(out)
big.resize((256, 256), Image.LANCZOS).save(sys.argv[2] if len(sys.argv) > 2 else "/tmp/icon-preview.png")
print("icon written", len(out), "bytes")
