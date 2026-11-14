# SPDX-License-Identifier: AGPL-3.0-only
# Builds the game files of one Model Swaps character: a SkeletalMesh on the Dauntless player skeleton, one material
# instance and its textures, all under /Game/Lantern/ModelSwaps/<id>/ (new paths: no game asset is overridden).
# Each file is a copy of a Dauntless 1.14.7 package of the same kind with its names and data replaced, so the engine
# reads exactly the layout it ships with. Templates come from the user's own game paks (see convert.py).
import hashlib, io, math, struct, sys
from pathlib import Path
import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parent))
import upkg, skm

T_MESH = 'Character/Player/player_male/male_basic_skin_00'
T_MESH_MAT = ('/Game/Character/Player/player_male/Materials/p_male_body_mi', 'p_male_body_mi')
T_MIC = 'CharacterProps/armour/ranger/Materials/armour_ranger_chest_00_mi'
T_TEX = 'CharacterProps/armour/ranger/Textures/armour_ranger_chest_00_c'        # sRGB colour
T_TEX_LIN = 'CharacterProps/armour/ranger/Textures/armour_ranger_chest_00_msro'  # linear data
TEMPLATES = [T_MESH, T_MIC, T_TEX, T_TEX_LIN]
ROOT = 'Lantern/ModelSwaps/'


def _pkg(src, rel): return upkg.Package((src / (rel + '.uasset')).read_bytes(), (src / (rel + '.uexp')).read_bytes())


def _retitle(p, old_rel, new_rel):   # the package's own path and object name, and a package GUID of its own
    p.rename('/Game/' + old_rel, '/Game/' + new_rel); p.rename(old_rel.rsplit('/', 1)[1], new_rel.rsplit('/', 1)[1])
    p.u[93:109] = hashlib.md5(new_rel.encode()).digest()


def _imports(p):   # [(class, object name, outer index)]; import i is object index -(i + 1)
    o, n = p.get('ImportOffset'), p.get('ImportCount'); out = []
    for i in range(n):
        _, _, cn, _, outer, on, onn = struct.unpack_from('<IIIIiII', p.u, o + 28 * i)
        out.append((p.names[cn][0], p.name_at((on, onn)), outer))
    return out


def _tags_end(p, b):   # offset just after the closing None of an export's tagged properties
    return len(skm.tags(skm.Ar(b), [n for n, _ in p.names]))


# ---- texture ----------------------------------------------------------------------------------------------------
def texture(src, rel, image, linear=False):
    """image: PIL RGBA, power-of-two sides. Uncompressed BGRA, every mip stored in the file (no .ubulk)."""
    w, h = image.size; assert w & (w - 1) == 0 and h & (h - 1) == 0 and w <= 4096 and h <= 4096, 'texture size'
    t = T_TEX_LIN if linear else T_TEX; p = _pkg(src, t); _retitle(p, t, rel)
    e = p.exports[0]; b = bytes(p.x[e['start']:e['start'] + e['size']]); te = _tags_end(p, b)
    tags = bytearray(b[:te]); names = [n for n, _ in p.names]
    at = tags.find(struct.pack('<II', names.index('ImportedSize'), 0)); assert at >= 0
    at = tags.find(struct.pack('<II', names.index('IntPoint'), 0), at) + 8 + 16 + 1; struct.pack_into('<ii', tags, at, w, h)
    assert b[te:te + 12] == bytes.fromhex('00000000 01000100 01000000'), 'texture header'
    pf = p.add_name('PF_B8G8R8A8'); none = p.index('None'); mips = []
    im = image
    while True:
        mips.append((im.size, np.asarray(im, np.uint8)[:, :, [2, 1, 0, 3]].tobytes()))
        if im.size == (1, 1): break
        im = im.resize((max(im.size[0] // 2, 1), max(im.size[1] // 2, 1)), Image.BOX)

    def body(header):   # header: size of the .uasset; inline bulk data records its own place in the file
        o = bytearray(tags) + b[te:te + 12] + struct.pack('<II', pf, 0) + bytes(8)
        skip_at = len(o) - 8
        s = b'PF_B8G8R8A8\0'; o += struct.pack('<iiIi', w, h, 1, len(s)) + s + struct.pack('<ii', 0, len(mips))
        for (mw, mh), data in mips:
            o += struct.pack('<iIii', 1, 0x48, len(data), len(data)); o += struct.pack('<q', header + len(o) + 8) + data
            o += struct.pack('<iii', mw, mh, 1)
        o += struct.pack('<i', 0); struct.pack_into('<q', o, skip_at, header + len(o))
        return bytes(o) + struct.pack('<II', none, 0)
    p.set_export(e, body(0)); u, _ = p.write(); p.set_export(e, body(len(u)))
    return p.write()


def atlas(parts, limit=2048):
    """One texture for every part. -> (PIL RGBA atlas, [per part: function uv -> atlas uv])"""
    PAD = 8; cells = []
    for q in parts:
        uv = q['UV']; u0 = np.floor(uv.min(0) + 1e-6); span = np.maximum(np.ceil(uv.max(0) - 1e-6) - u0, 1).astype(int)
        if span.max() > 4: raise ValueError('texture repeats more than 4 times across "%s"' % q['name'])
        try: im = Image.open(io.BytesIO(q['image'])).convert('RGBA') if q.get('image') else Image.new('RGBA', (8, 8), (200, 200, 200, 255))
        except Exception: raise ValueError('a texture of "%s" could not be read' % q['name'])
        if q.get('alpha', 'OPAQUE') == 'OPAQUE': im.putalpha(255)
        im = im.resize((min(im.size[0], 1024), min(im.size[1], 1024)), Image.LANCZOS) if max(im.size) > 1024 else im
        a = np.tile(np.asarray(im), (span[1], span[0], 1)); cells.append({'a': a, 'u0': u0, 'span': span})
    for scale in (1, 0.5, 0.25, 0.125):   # shelf packing; shrink everything until it fits
        size = None
        for side in (256, 512, 1024, 2048, 4096):
            if side > limit: break
            x = y = row = 0; pos = []
            for c in sorted(range(len(cells)), key=lambda i: -cells[i]['a'].shape[0]):
                ch, cw = (max(int(d * scale), 4) + 2 * PAD for d in cells[c]['a'].shape[:2])
                if x + cw > side: x = 0; y += row; row = 0
                pos.append((c, x, y, cw, ch)); x += cw; row = max(row, ch)
            if all(px + cw <= side for _, px, _, cw, _ in pos) and y + row <= side: size = side; break
        if size: break
    if not size: raise ValueError('the textures do not fit in one %d px atlas' % limit)
    high = 4
    while high < y + row: high *= 2   # only as tall as the rows need
    size = np.array([size, high], float)
    out = Image.new('RGBA', (int(size[0]), high), (128, 128, 128, 255)); fns = [None] * len(cells)
    for c, x, y, cw, ch in pos:
        a = cells[c]['a']
        if scale != 1: a = np.asarray(Image.fromarray(a).resize((cw - 2 * PAD, ch - 2 * PAD), Image.LANCZOS))
        out.paste(Image.fromarray(np.pad(a, ((PAD, PAD), (PAD, PAD), (0, 0)), mode='wrap')), (x, y))   # wrapped border: no seams in mips
        org = np.array([x + PAD, y + PAD], float); dim = np.array([cw - 2 * PAD, ch - 2 * PAD], float)
        fns[c] = (lambda uv, c=c, org=org, dim=dim: (org + (uv - cells[c]['u0']) / cells[c]['span'] * dim) / size)
    return out, fns


# ---- material instance --------------------------------------------------------------------------------------------
def material(src, rel, colour_rel, data_rel):
    p = _pkg(src, T_MIC); _retitle(p, T_MIC, rel); imp = _imports(p)
    for old, new in ((T_TEX, colour_rel), (T_TEX_LIN, data_rel)):
        p.rename('/Game/' + old, '/Game/' + new); p.rename(old.rsplit('/', 1)[1], new.rsplit('/', 1)[1])
    idx = lambda name: -1 - next(i for i, (c, n, _) in enumerate(imp) if c == 'Texture2D' and n == name)
    e = p.exports[0]; b = bytearray(p.x[e['start']:e['start'] + e['size']]); names = [n for n, _ in p.names]
    # the other texture slots get engine constants this material already imports
    for param, was, to in (('Dye Mask', 'armour_ranger_chest_00_dmk', 'black_no_sRGB'), ('Normal', 'armour_ranger_chest_00_n', 'BaseFlattenNormalMap'),
                           ('normal_details', 'armour_ranger_chest_00_n_detail', 'BaseFlattenNormalMap')):
        at = b.find(struct.pack('<II', names.index(param), 0)); assert at >= 0, param
        v = at + 111; assert struct.unpack_from('<i', b, v)[0] == idx(was), 'material layout: ' + param
        struct.pack_into('<i', b, v, idx(to))
    p.set_export(e, bytes(b)); return p.write()


# ---- mesh ---------------------------------------------------------------------------------------------------------
def _pack_normal(n, w):   # FPackedNormal: 4 signed bytes
    return np.c_[np.clip(np.round(n * 127), -127, 127), np.full(len(n), w)].astype(np.int8)


def mesh(src, rel, mat_rel, parts, slayer, uvfn):
    """parts: bound parts (fit.bind). One section, one material; the same geometry in all four LOD slots."""
    P, N, UV, Wt, I = [], [], [], [], []; base = 0
    for q, fn in zip(parts, uvfn):
        p_, uv, wt, idx = q['P'], fn(q['UV']), q['Wt'], q['I']
        n = q['N']
        if n is None:   # no normals in the file: area-weighted face normals
            fnm = np.cross(p_[idx[:, 1]] - p_[idx[:, 0]], p_[idx[:, 2]] - p_[idx[:, 0]]); n = np.zeros_like(p_)
            for k in range(3): np.add.at(n, idx[:, k], fnm)
            n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        fnm = np.cross(p_[idx[:, 1]] - p_[idx[:, 0]], p_[idx[:, 2]] - p_[idx[:, 0]])
        if np.sign((fnm * n[idx[:, 0]]).sum()) != slayer.winding: idx = idx[:, ::-1]   # the game's triangle order
        sets = [(p_, n, idx)] + ([(p_, -n, idx[:, ::-1])] if q.get('double', True) else [])   # back faces as real triangles
        for sp, sn, si in sets:
            P.append(sp); N.append(sn); UV.append(uv); Wt.append(wt); I.append(si + base); base += len(sp)
    P, N, UV, Wt, I = np.concatenate(P), np.concatenate(N), np.concatenate(UV), np.concatenate(Wt), np.concatenate(I)
    nv = len(P); assert nv < 1 << 24
    used = np.nonzero(Wt.sum(0) > 0)[0]; assert len(used) <= 255, 'too many bones in one section'
    remap = np.zeros(Wt.shape[1], int); remap[used] = np.arange(len(used))
    order = np.argsort(-Wt, axis=1)[:, :4]; w = np.take_along_axis(Wt, order, 1); w /= w.sum(1, keepdims=True)
    wb = np.floor(w * 255).astype(int); wb[:, 0] += 255 - wb.sum(1)   # bytes that add up to exactly 255
    bones = np.where(wb > 0, remap[order], 0)
    weights = np.c_[bones, wb].astype(np.uint8).tobytes()
    up = np.where(np.abs(N[:, 2:3]) < 0.9, [[0.0, 0.0, 1.0]], [[1.0, 0.0, 0.0]]); tx = np.cross(up, N); tx /= np.maximum(np.linalg.norm(tx, axis=1, keepdims=True), 1e-9)
    tangents = np.c_[_pack_normal(tx, 0), _pack_normal(N, 127)].tobytes()
    active = set()
    for bidx in used:
        while bidx >= 0 and bidx not in active: active.add(int(bidx)); bidx = slayer.parent[bidx]
    big = nv > 65535

    p = _pkg(src, T_MESH); _retitle(p, T_MESH, rel)
    p.rename(T_MESH_MAT[0], '/Game/' + mat_rel); p.rename(T_MESH_MAT[1], mat_rel.rsplit('/', 1)[1])
    m = skm.load(p); assert len(m['materials']) == 1
    for l in m['lods']:
        was = sum(len(l[k]['data']) for k in ('indices', 'positions', 'tangents', 'uvs', 'weights'))
        extra = l['buffersSize'] - was   # whatever else the game counts stays as it was
        s = l['sections'][0]; l['sections'] = [s]
        s.update(material=0, baseIndex=0, numTriangles=len(I), baseVertex=0, boneMap=[int(x) for x in used], numVertices=nv,
                 maxInfluences=4, dupVerts=b'', dupIndex=bytes(8 * nv), clothMap=[])
        l['activeBones'] = sorted(active)
        l['indexSize'] = 4 if big else 2
        l['indices'] = {'size': 4 if big else 2, 'n': I.size, 'data': I.astype('<u4' if big else '<u2').tobytes()}
        l['posCount'] = l['tanCount'] = l['swCount'] = nv
        l['positions'] = {'size': 12, 'n': nv, 'data': P.astype('<f4').tobytes()}
        l['numUVs'] = 1; l['fullUVs'] = 0; l['highTangents'] = 0
        l['tangents'] = {'size': 8, 'n': nv, 'data': tangents}
        l['uvs'] = {'size': 4, 'n': nv, 'data': UV.astype('<f2').tobytes()}
        l['variableBones'] = 0; l['maxInfluences'] = 4; l['numBoneWeights'] = nv * 4; l['bones16'] = 0
        l['weights'] = {'size': 1, 'n': nv * 8, 'data': weights}
        l['buffersSize'] = extra + sum(len(l[k]['data']) for k in ('indices', 'positions', 'tangents', 'uvs', 'weights'))
    lo, hi = P.min(0), P.max(0); c, ext = (lo + hi) / 2, (hi - lo) / 2 + 2.0
    m['bounds'] = [float(x) for x in (*c, *ext, np.linalg.norm(ext))]
    e = p.exports[0]; p.set_export(e, skm.dump(m, [n for n, _ in p.names]))
    return p.write(), {'vertices': nv, 'triangles': int(len(I)), 'bones': len(used)}


def character(src, cid, parts, slayer):
    """-> ({path under Archon/Content: bytes}, stats). cid: lower-case letters, digits, underscore."""
    base = ROOT + cid + '/'; rel = lambda s: base + cid + s
    img, uvfn = atlas(parts)
    flat = Image.new('RGBA', (4, 4), (0, 96, 255, 255))   # MSRO: no metal, some specular, fully rough, no occlusion
    files = {}
    def put(r, pair): files[r + '.uasset'], files[r + '.uexp'] = pair
    put(rel('_c'), texture(src, rel('_c'), img)); put(rel('_msro'), texture(src, rel('_msro'), flat, linear=True))
    put(rel('_mi'), material(src, rel('_mi'), rel('_c'), rel('_msro')))
    pair, stats = mesh(src, rel(''), rel('_mi'), parts, slayer, uvfn); put(rel(''), pair)
    stats['atlas'] = img.size[0]
    return files, stats, img
