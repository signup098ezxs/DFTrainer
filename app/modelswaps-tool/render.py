# SPDX-License-Identifier: AGPL-3.0-only
# Small software renderer (numpy + Pillow) for Model Swaps: the library's preview image and the converter's check
# pictures. Orthographic, z-buffered, flat-lit, textured or coloured per vertex. Dauntless space (Z up, faces +Y).
import io
import numpy as np
from PIL import Image


def draw(parts, size=(512, 768), view='front', bg=(24, 26, 32, 255), bounds=None):
    """parts: [{P (n,3), I (m,3), UV (n,2) or None, image (bytes) or None, color (n,3) or None}] -> PIL image"""
    W, H = size; allp = np.concatenate([p['P'] for p in parts])
    lo, hi = bounds if bounds else (allp.min(0), allp.max(0))
    ax = {'front': (0, 1, -1.0), 'back': (0, 1, 1.0), 'side': (1, 0, 1.0)}[view]   # screen x axis, depth axis, depth sign
    sx = -1.0 if view in ('front',) else 1.0   # seen from the front the character's left is on screen right
    span = max(hi[ax[0]] - lo[ax[0]], (hi[2] - lo[2]) * W / H, 1e-6) * 1.08
    cx, cz = (hi[ax[0]] + lo[ax[0]]) / 2, (hi[2] + lo[2]) / 2
    zb = np.full((H, W), np.inf); out = np.zeros((H, W, 3)) + np.array(bg[:3]); light = np.array([0.3, -0.6, 0.74])
    if view == 'back': light = light * [1, -1, 1]
    if view == 'side': light = np.array([-0.6, 0.3, 0.74])
    for p in parts:
        P = p['P']; X = (sx * (P[:, ax[0]] - cx) / span + 0.5) * W; Y = (0.5 - (P[:, 2] - cz) / span * W / H) * H
        D = P[:, ax[1]] * ax[2]
        tex = None
        if p.get('image') is not None:
            try: tex = np.asarray(Image.open(io.BytesIO(p['image'])).convert('RGBA'), float)
            except Exception: tex = None
        for tri in p['I']:
            a, b, c = tri; x0, x1 = int(max(min(X[a], X[b], X[c]), 0)), int(min(max(X[a], X[b], X[c]) + 1, W))
            y0, y1 = int(max(min(Y[a], Y[b], Y[c]), 0)), int(min(max(Y[a], Y[b], Y[c]) + 1, H))
            if x0 >= x1 or y0 >= y1: continue
            den = (Y[b] - Y[c]) * (X[a] - X[c]) + (X[c] - X[b]) * (Y[a] - Y[c])
            if abs(den) < 1e-12: continue
            gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
            w0 = ((Y[b] - Y[c]) * (gx - X[c]) + (X[c] - X[b]) * (gy - Y[c])) / den
            w1 = ((Y[c] - Y[a]) * (gx - X[c]) + (X[a] - X[c]) * (gy - Y[c])) / den; w2 = 1 - w0 - w1
            d = w0 * D[a] + w1 * D[b] + w2 * D[c]
            m = (w0 >= 0) & (w1 >= 0) & (w2 >= 0) & (d < zb[y0:y1, x0:x1])
            if not m.any(): continue
            n = np.cross(P[b] - P[a], P[c] - P[a]); n = n / max(np.linalg.norm(n), 1e-9)
            shade = 0.45 + 0.55 * abs(float(n @ light))
            if tex is not None and p.get('UV') is not None:
                uv = w0[..., None] * p['UV'][a] + w1[..., None] * p['UV'][b] + w2[..., None] * p['UV'][c]
                tx = (np.floor((uv[..., 0] % 1.0) * tex.shape[1]).astype(int)) % tex.shape[1]
                ty = (np.floor((uv[..., 1] % 1.0) * tex.shape[0]).astype(int)) % tex.shape[0]
                col = tex[ty, tx]; m &= col[..., 3] > 96; col = col[..., :3]
            elif p.get('color') is not None:
                col = w0[..., None] * p['color'][a] + w1[..., None] * p['color'][b] + w2[..., None] * p['color'][c]
            else: col = np.full(gx.shape + (3,), 190.0)
            zb[y0:y1, x0:x1][m] = d[m]; out[y0:y1, x0:x1][m] = (col * shade)[m]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def sheet(parts, path, views=('front', 'side', 'back'), size=(400, 640)):
    ims = [draw(parts, size, v) for v in views]; s = Image.new('RGB', (size[0] * len(ims), size[1]))
    for i, im in enumerate(ims): s.paste(im, (i * size[0], 0))
    s.save(path); return path
