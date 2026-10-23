# Draws the DF Trainer icon (aether hexagon + bolt) and writes launcher/icon.ico: 32-bit images for 16-128 px,
# PNG for 256 px, the way Windows expects. Run once; the .ico is kept in the repo.
import io, struct, sys
from PIL import Image, ImageDraw, ImageFilter

S = 1024
def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    c = S / 2
    def hexpts(r):
        import math
        return [(c + r * math.cos(math.radians(a)), c + r * math.sin(math.radians(a))) for a in range(-90, 270, 60)]
    # glow
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).polygon(hexpts(S * 0.44), fill=(60, 235, 255, 150))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.035))
    img.alpha_composite(glow)
    d = ImageDraw.Draw(img)
    d.polygon(hexpts(S * 0.455), fill=(60, 235, 255, 255))            # rim
    d.polygon(hexpts(S * 0.405), fill=(9, 18, 25, 255))               # body
    d.polygon(hexpts(S * 0.35), outline=(14, 143, 163, 255), width=int(S * 0.012))
    # bolt (same shape as the panel's logo, viewBox 120)
    k = S / 120
    bolt = [(66, 28), (40, 66), (57, 66), (52, 92), (80, 52), (62, 52)]
    bglow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(bglow).polygon([(x * k, y * k) for x, y in bolt], fill=(60, 235, 255, 200))
    img.alpha_composite(bglow.filter(ImageFilter.GaussianBlur(S * 0.02)))
    ImageDraw.Draw(img).polygon([(x * k, y * k) for x, y in bolt], fill=(150, 248, 255, 255))
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
