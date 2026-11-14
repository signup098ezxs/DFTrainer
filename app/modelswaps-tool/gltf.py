# SPDX-License-Identifier: AGPL-3.0-only
# glTF 2.0 / GLB reader for the Model Swaps converter: triangle meshes with their world transform applied, optional skin,
# base colour texture per material. Output is in Dauntless space: centimetres, Z up, character faces +Y, its left is +X.
import json, os, struct, base64
import numpy as np

CT = {5120: 'i1', 5121: 'u1', 5122: '<i2', 5123: '<u2', 5125: '<u4', 5126: '<f4'}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def _quat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


class Gltf:
    def __init__(self, path):
        self.dir = os.path.dirname(os.path.abspath(path)); raw = open(path, 'rb').read(); self.glb = None
        if raw[:4] == b'glTF':
            n, = struct.unpack_from('<I', raw, 12); self.j = json.loads(raw[20:20 + n]); o = 20 + n
            if o < len(raw): m, = struct.unpack_from('<I', raw, o); self.glb = raw[o + 8:o + 8 + m]
        else: self.j = json.loads(raw.decode('utf-8-sig'))
        self.bufs = {}

    def _uri(self, uri):
        if uri.startswith('data:'): return base64.b64decode(uri.split(',', 1)[1])
        p = os.path.normpath(os.path.join(self.dir, uri.replace('%20', ' ')))
        assert p.startswith(self.dir), 'file outside the model folder: ' + uri   # a model must not reach other files
        return open(p, 'rb').read()

    def buf(self, i):
        if i not in self.bufs:
            b = self.j['buffers'][i]; self.bufs[i] = self._uri(b['uri']) if 'uri' in b else self.glb
        return self.bufs[i]

    def acc(self, i):
        a = self.j['accessors'][i]; assert 'sparse' not in a, 'sparse accessors are not supported'
        v = self.j['bufferViews'][a['bufferView']]; dt = np.dtype(CT[a['componentType']]); nc = NC[a['type']]
        o = v.get('byteOffset', 0) + a.get('byteOffset', 0); stride = v.get('byteStride') or dt.itemsize * nc
        b = self.buf(v['buffer']); n = a['count']
        assert o + stride * (n - 1) + dt.itemsize * nc <= len(b), 'accessor runs past its buffer'
        out = np.ndarray((n, nc), dt, b, o, (stride, dt.itemsize)).astype(np.float64 if dt.kind == 'f' else np.int64)
        if a.get('normalized'): out = out / {1: 255.0, 2: 65535.0}[dt.itemsize] if dt.kind == 'u' else np.maximum(out / {1: 127.0, 2: 32767.0}[dt.itemsize], -1)
        return out

    def image(self, mat):   # bytes of the base colour image, or None
        t = self.j['materials'][mat].get('pbrMetallicRoughness', {}).get('baseColorTexture') if mat is not None else None
        if not t: return None
        im = self.j['images'][self.j['textures'][t['index']]['source']]
        if 'uri' in im: return self._uri(im['uri'])
        v = self.j['bufferViews'][im['bufferView']]; o = v.get('byteOffset', 0); return self.buf(v['buffer'])[o:o + v['byteLength']]

    def world(self):   # node index -> 4x4 world matrix
        nodes = self.j.get('nodes', []); out = {}
        def local(n):
            if 'matrix' in n: return np.array(n['matrix'], float).reshape(4, 4).T
            m = np.eye(4); m[:3, :3] = _quat(n.get('rotation', [0, 0, 0, 1])) * np.array(n.get('scale', [1, 1, 1]))
            m[:3, 3] = n.get('translation', [0, 0, 0]); return m
        def walk(i, parent, depth=0):
            assert depth < 256 and i not in out, 'node tree is not a tree'
            out[i] = parent @ local(nodes[i])
            for c in nodes[i].get('children', []): walk(c, out[i], depth + 1)
        scene = self.j['scenes'][self.j.get('scene', 0)] if self.j.get('scenes') else {'nodes': list(range(len(nodes)))}
        for r in scene['nodes']: walk(r, np.eye(4))
        return out


TO_UE = np.array([[100.0, 0, 0], [0, 0, 100.0], [0, 100.0, 0]])   # glTF (x left, y up, z front, metres) -> Dauntless cm


def load(path):
    """-> {'parts': [{P, N, UV, I, material, name, alpha, image, J, W}], 'joints': [{name, parent, pos}] or None}"""
    g = Gltf(path); world = g.world(); parts = []; skin = None
    for ni, node in enumerate(g.j.get('nodes', [])):
        if 'mesh' not in node or ni not in world: continue
        m = world[ni]; R = TO_UE @ m[:3, :3]; t = TO_UE @ m[:3, 3]
        skinned = 'skin' in node
        if skinned and skin is None: skin = node['skin']
        for prim in g.j['meshes'][node['mesh']]['primitives']:
            if prim.get('mode', 4) != 4: continue
            at = prim['attributes']; P = g.acc(at['POSITION'])
            I = g.acc(prim['indices']).reshape(-1) if 'indices' in prim else np.arange(len(P))
            assert len(I) % 3 == 0 and (len(I) == 0 or (I.min() >= 0 and I.max() < len(P))), 'bad triangle indices'
            d = {'P': P, 'I': I.reshape(-1, 3), 'N': g.acc(at['NORMAL']) if 'NORMAL' in at else None,
                 'UV': g.acc(at['TEXCOORD_0']) if 'TEXCOORD_0' in at else np.zeros((len(P), 2)), 'J': None, 'W': None,
                 'material': prim.get('material'), 'name': 'material', 'alpha': 'OPAQUE', 'double': False}
            if d['material'] is not None:
                mt = g.j['materials'][d['material']]; d['double'] = bool(mt.get('doubleSided')); d['name'] = mt.get('name', 'material%d' % d['material']); d['alpha'] = mt.get('alphaMode', 'OPAQUE')
            d['image'] = g.image(d['material'])
            if skinned and 'JOINTS_0' in at and node['skin'] == skin:
                d['J'] = g.acc(at['JOINTS_0']).astype(int); d['W'] = g.acc(at['WEIGHTS_0']).astype(float)
            else:   # a skinned mesh ignores its node transform (glTF rule); an unskinned one uses it
                d['P'] = P @ m[:3, :3].T + m[:3, 3]
                if d['N'] is not None: d['N'] = d['N'] @ np.linalg.inv(m[:3, :3])
            d['P'] = d['P'] @ TO_UE.T
            if d['N'] is not None:
                n = d['N'] @ (TO_UE.T / 100.0); d['N'] = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
            assert np.isfinite(d['P']).all(), 'mesh has broken (non-finite) positions'
            parts.append(d)
    assert parts, 'no triangle mesh in this file'
    joints = None
    if skin is not None:
        s = g.j['skins'][skin]; nodes = g.j['nodes']; parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
        joints = [{'name': nodes[j].get('name', 'joint%d' % k), 'parent': s['joints'].index(parent[j]) if parent.get(j) in s['joints'] else -1,
                   'pos': TO_UE @ world[j][:3, 3]} for k, j in enumerate(s['joints'])]
    return {'parts': parts, 'joints': joints}
