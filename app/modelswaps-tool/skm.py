# SPDX-License-Identifier: AGPL-3.0-only
# Reader/writer for the export data of a cooked UE4.26 SkeletalMesh, as Dauntless 1.14.7 ships them.
# One function (mesh) describes the layout for both directions, the way UE's own FArchive does, so a mesh that is
# read and written back unchanged is byte for byte the same (selftest). Property tags are kept as raw bytes.
import struct, sys


class Ar:
    def __init__(self, data=None):
        self.rd = data is not None; self.b = data if self.rd else bytearray(); self.o = 0

    def _f(self, fmt, v):
        if self.rd:
            v = struct.unpack_from(fmt, self.b, self.o); self.o += struct.calcsize(fmt)
            return v[0] if len(v) == 1 else list(v)
        self.b += struct.pack(fmt, *(v if isinstance(v, (list, tuple)) else (v,))); return v

    def i32(self, v=None): return self._f('<i', v)
    def u32(self, v=None): return self._f('<I', v)
    def u16(self, v=None): return self._f('<H', v)
    def u8(self, v=None): return self._f('<B', v)
    def f32(self, v=None): return self._f('<f', v)
    def fmt(self, fmt, v=None): return self._f(fmt, v)

    def raw(self, n, v=None):
        if self.rd: v = bytes(self.b[self.o:self.o + n]); assert len(v) == n, 'past the end'; self.o += n; return v
        assert len(v) == n; self.b += v; return v

    def bulk(self, v=None):   # TArray::BulkSerialize: element size, count, bytes
        if self.rd:
            size, n = self.i32(), self.i32(); assert 0 <= size <= 64 and 0 <= n < 1 << 26, ('bulk', size, n, self.o)
            return {'size': size, 'n': n, 'data': self.raw(size * n)}
        self.i32(v['size']); self.i32(v['n']); self.raw(v['size'] * v['n'], v['data']); return v

    def plain(self, size, v=None):   # TArray of fixed-size elements: count, bytes
        n = self.i32(None if self.rd else len(v) // size); assert 0 <= n < 1 << 26, ('plain', n, self.o)
        return self.raw(n * size, v)

    def arr(self, item, v=None):   # TArray of structs
        n = self.i32(None if self.rd else len(v)); assert 0 <= n < 1 << 20, ('array', n, self.o)
        return [item(self, None if self.rd else v[i]) for i in range(n)]


def field(ar, d, key, fn, *a):   # read into d[key] or write d[key]
    d[key] = fn(*a) if ar.rd else fn(*a, d[key]); return d[key]


def tags(ar, names, v=None):   # tagged properties up to and including "None", kept raw
    if not ar.rd: return ar.raw(len(v), v)
    start = ar.o
    while True:
        name = names[ar.i32()]; ar.i32()
        if name == 'None': break
        typ = names[ar.i32()]; ar.i32(); size = ar.i32(); ar.i32()
        ar.o += {'StructProperty': 24, 'BoolProperty': 1, 'ByteProperty': 8, 'EnumProperty': 8, 'ArrayProperty': 8,
                 'SetProperty': 8, 'MapProperty': 16}.get(typ, 0)
        ar.o += 1 + size
    end = ar.o; ar.o = start
    return ar.raw(end - start)


def material(ar, v):
    d = v or {}
    field(ar, d, 'object', ar.i32); field(ar, d, 'slot', ar.fmt, '<II'); field(ar, d, 'imported', ar.i32)
    assert d['imported'] == 0, 'editor material slot name'
    field(ar, d, 'uv', ar.raw, 24); return d


def bone(ar, v):
    d = v or {}; field(ar, d, 'name', ar.fmt, '<II'); field(ar, d, 'parent', ar.i32); return d


def section(ar, v):   # FSkelMeshRenderSection
    d = v or {}
    field(ar, d, 'strip', ar.u16); field(ar, d, 'material', ar.u16); field(ar, d, 'baseIndex', ar.u32)
    field(ar, d, 'numTriangles', ar.u32); field(ar, d, 'recomputeTangent', ar.i32); field(ar, d, 'tangentMask', ar.u8)
    field(ar, d, 'castShadow', ar.i32)
    field(ar, d, 'baseVertex', ar.u32)
    field(ar, d, 'clothMap', ar.arr, lambda a, x: a.raw(64, x))
    field(ar, d, 'boneMap', ar.arr, lambda a, x: a.u16(x))
    field(ar, d, 'numVertices', ar.i32); field(ar, d, 'maxInfluences', ar.i32)
    field(ar, d, 'clothIndex', ar.fmt, '<h'); field(ar, d, 'clothData', ar.raw, 20)
    field(ar, d, 'dupVerts', ar.plain, 4); field(ar, d, 'dupIndex', ar.plain, 8); field(ar, d, 'disabled', ar.i32)
    return d


def lod(ar, v, has_colors):   # FSkeletalMeshLODRenderData
    d = v or {}
    field(ar, d, 'strip', ar.u16); field(ar, d, 'cookedOut', ar.i32); field(ar, d, 'inlined', ar.i32)
    field(ar, d, 'requiredBones', ar.arr, lambda a, x: a.u16(x))
    assert not d['cookedOut'] and d['inlined'] and not d['strip'] & 2, 'LOD is not stored inline'
    field(ar, d, 'sections', ar.arr, section)
    field(ar, d, 'activeBones', ar.arr, lambda a, x: a.u16(x))
    field(ar, d, 'buffersSize', ar.u32)
    field(ar, d, 'strip2', ar.u16)
    field(ar, d, 'indexSize', ar.u8); field(ar, d, 'indices', ar.bulk)
    field(ar, d, 'posStride', ar.u32); field(ar, d, 'posCount', ar.u32); field(ar, d, 'positions', ar.bulk)
    field(ar, d, 'tanStrip', ar.u16); field(ar, d, 'numUVs', ar.u32); field(ar, d, 'tanCount', ar.u32)
    field(ar, d, 'fullUVs', ar.i32); field(ar, d, 'highTangents', ar.i32)
    field(ar, d, 'tangents', ar.bulk); field(ar, d, 'uvs', ar.bulk)
    field(ar, d, 'swStrip', ar.u16); field(ar, d, 'variableBones', ar.i32)
    field(ar, d, 'maxInfluences', ar.u32); field(ar, d, 'numBoneWeights', ar.u32); field(ar, d, 'swCount', ar.u32)
    field(ar, d, 'bones16', ar.i32); field(ar, d, 'weights', ar.bulk)
    field(ar, d, 'lookupStrip', ar.u16); field(ar, d, 'lookupCount', ar.u32); field(ar, d, 'lookup', ar.bulk)
    if has_colors:
        field(ar, d, 'colStrip', ar.u16); field(ar, d, 'colStride', ar.u32); field(ar, d, 'colCount', ar.u32)
        if d['colCount']: field(ar, d, 'colors', ar.bulk)
    if not d['strip2'] & 0x100:   # class flag CDSF_AdjacencyData
        field(ar, d, 'adjSize', ar.u8); field(ar, d, 'adjacency', ar.bulk)
    assert all(s['clothIndex'] < 0 for s in d['sections']), 'cloth sections are not supported'
    field(ar, d, 'profiles', ar.i32); assert d['profiles'] == 0, 'skin weight profiles'
    return d


def mesh(ar, names, v=None, has_colors=False):
    d = v or {}
    field(ar, d, 'tags', tags, ar, names); field(ar, d, 'guid', ar.i32); assert d['guid'] == 0
    field(ar, d, 'strip', ar.u16); field(ar, d, 'bounds', ar.fmt, '<7f')
    field(ar, d, 'materials', ar.arr, material)
    field(ar, d, 'bones', ar.arr, bone)
    field(ar, d, 'pose', ar.arr, lambda a, x: a.fmt('<10f', x))   # rotation xyzw, translation, scale
    field(ar, d, 'boneIndex', ar.arr, lambda a, x: a.fmt('<IIi', x))
    field(ar, d, 'cooked', ar.i32); assert d['cooked'] == 1
    field(ar, d, 'lods', ar.arr, lambda a, x: lod(a, x, has_colors))
    field(ar, d, 'tail', ar.raw, (len(ar.b) - ar.o) if ar.rd else len(d.get('tail', b'')))
    return d


def load(pkg, has_colors=False):   # pkg: upkg.Package of a SkeletalMesh
    e = pkg.exports[0]; names = [n for n, _ in pkg.names]
    return mesh(Ar(bytes(pkg.x[e['start']:e['start'] + e['size']])), names, None, has_colors)


def dump(m, names):
    w = Ar(); mesh(w, names, m, 'colStrip' in m['lods'][0]); return bytes(w.b)


if __name__ == '__main__':   # selftest: skm.py <mesh.uasset>... reads each, writes it back, compares
    import upkg
    for p in sys.argv[1:]:
        k = upkg.Package(open(p, 'rb').read(), open(p[:-6] + 'uexp', 'rb').read())
        e = k.exports[0]; src = bytes(k.x[e['start']:e['start'] + e['size']]); names = [n for n, _ in k.names]
        m = None
        for colors in (False, True):
            try: m = load(k, colors); break
            except (AssertionError, struct.error, IndexError) as ex: err = ex
        if m is None: print('FAIL', p, err); continue
        ok = dump(m, names) == src
        print('ok  ' if ok else 'DIFF', p.replace('\\', '/').rsplit('/', 1)[-1], 'lods', len(m['lods']), 'bones', len(m['bones']),
              'tail', len(m['tail']), [(l['posCount'], l['indices']['n'] // 3, len(l['sections']), l['maxInfluences']) for l in m['lods']])
