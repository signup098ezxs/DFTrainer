# SPDX-License-Identifier: AGPL-3.0-only
# Minimal rewriter for cooked, unversioned-off UE4.26 packages (.uasset + .uexp), as Dauntless 1.14.7 ships them.
# It can add names to the name map, rename a name, and replace one export's bytes. Everything after the name map moves
# by the same amount, so every header offset after it and each export's SerialOffset is moved with it; nothing else is
# re-serialised. Checked: an unchanged package is written back byte for byte (selftest).
import struct


def fstr(b, o):
    n = struct.unpack_from('<i', b, o)[0]; o += 4
    if n < 0: return b[o:o - 2 * n - 2].decode('utf-16le'), o - 2 * n
    return (b[o:o + n - 1].decode('latin-1') if n else ''), o + n


def _crc_tables():
    refl, dep = [], []
    for i in range(256):
        c = i
        for _ in range(8): c = (c >> 1) ^ 0xEDB88320 if c & 1 else c >> 1
        refl.append(c)
        c = i << 24
        for _ in range(8): c = ((c << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if c & 0x80000000 else (c << 1) & 0xFFFFFFFF
        dep.append(c)
    return refl, dep
CRC, CRC_DEP = _crc_tables()


def name_hashes(s):   # FNameEntrySerialized: (Strihash_DEPRECATED, StrCrc32) & 0xFFFF, as UE4.26 saves them
    h = 0
    for ch in s.upper().encode('latin-1'): h = ((h >> 8) & 0x00FFFFFF) ^ CRC_DEP[(h ^ ch) & 0xFF]
    c = 0xFFFFFFFF
    for ch in s.encode('latin-1'):
        for byte in (ch, 0, 0, 0): c = (c >> 8) ^ CRC[(c ^ byte) & 0xFF]   # each TCHAR is 4 bytes
    return h & 0xFFFF, (~c) & 0xFFFF


class Package:
    def __init__(self, uasset: bytes, uexp: bytes):
        self.u, self.x = bytearray(uasset), bytearray(uexp)
        u = self.u
        assert u[:4] == bytes.fromhex('c1832a9e') and struct.unpack_from('<i', u, 4)[0] == -7, 'not a UE4 package'
        assert struct.unpack_from('<i', u, 20)[0] == 0, 'custom versions not supported'
        self.f = {}   # summary field -> offset in the .uasset
        o = 24; self.f['TotalHeaderSize'] = o
        _, o = fstr(u, 28); flags = struct.unpack_from('<I', u, o)[0]; o += 4
        assert flags & 0x80000000, 'only cooked (FilterEditorOnly) packages'
        for k in ('NameCount', 'NameOffset', 'GatherCount', 'GatherOffset', 'ExportCount', 'ExportOffset', 'ImportCount',
                  'ImportOffset', 'DependsOffset', 'SoftPkgCount', 'SoftPkgOffset', 'SearchableNamesOffset', 'ThumbnailOffset'):
            self.f[k] = o; o += 4
        o += 16; gens = struct.unpack_from('<i', u, o)[0]; o += 4
        self.f['LastGenNameCount'] = o + 8 * (gens - 1) + 4; o += 8 * gens
        for _ in range(2): o += 10; _, o = fstr(u, o)
        o += 4; assert struct.unpack_from('<i', u, o)[0] == 0, 'compressed chunks'; o += 8
        n = struct.unpack_from('<i', u, o)[0]; o += 4
        for _ in range(n): _, o = fstr(u, o)
        self.f['AssetRegistryDataOffset'] = o; self.f['BulkDataStartOffset'] = o + 4; self.f['WorldTileInfoDataOffset'] = o + 12
        n = struct.unpack_from('<i', u, o + 16)[0]; o += 20 + 4 * n
        self.f['PreloadDependencyCount'] = o; self.f['PreloadDependencyOffset'] = o + 4
        assert o + 8 == self.get('NameOffset'), 'name map does not follow the summary'
        assert self.get('BulkDataStartOffset', '<q') == len(u) + len(self.x) - 4, 'bulk data not at the end'
        self.names, o = [], self.get('NameOffset')
        for _ in range(self.get('NameCount')): s, o = fstr(u, o); self.names.append((s, u[o:o + 4])); o += 4
        self.names_end = o
        self.exports = []
        for i in range(self.get('ExportCount')):
            at = self.get('ExportOffset') + 104 * i
            size, off = struct.unpack_from('<qq', u, at + 28)
            self.exports.append({'at': at, 'start': off - len(u), 'size': size, 'pair': struct.unpack_from('<II', u, at + 16)})

    def get(self, k, fmt='<i'): return struct.unpack_from(fmt, self.u, self.f[k])[0]
    def name_at(self, pair): i, n = pair; return self.names[i][0] + ('_%d' % (n - 1) if n else '')
    def index(self, s):
        for i, (n, _) in enumerate(self.names):
            if n == s: return i
        return -1

    def add_name(self, s):
        i = self.index(s)
        if i >= 0: return i
        self.names.append((s, None)); return len(self.names) - 1

    def rename(self, old, new):
        i = self.index(old); assert i >= 0, old; assert self.index(new) < 0, new
        self.names[i] = (new, None)

    def export(self, name):
        return next(e for e in self.exports if self.name_at(e['pair']) == name)

    def set_export(self, e, data):   # e: an export from export() or exports
        self.x[e['start']:e['start'] + e['size']] = data
        d = len(data) - e['size']; e['size'] = len(data)
        for o in self.exports:
            if o['start'] > e['start']: o['start'] += d

    def write(self):
        names = bytearray()
        for s, h in self.names:
            b = s.encode('latin-1') + b'\0'
            names += struct.pack('<i', len(b)) + b + (h if h is not None else struct.pack('<HH', *name_hashes(s)))
        old = self.u
        d = len(names) - (self.names_end - self.get('NameOffset'))
        u = bytearray(old[:self.get('NameOffset')]) + names + old[self.names_end:]
        put = lambda k, v, fmt='<i': struct.pack_into(fmt, u, self.f[k], v)
        for k in ('TotalHeaderSize', 'GatherOffset', 'ExportOffset', 'ImportOffset', 'DependsOffset', 'SoftPkgOffset',
                  'SearchableNamesOffset', 'ThumbnailOffset', 'AssetRegistryDataOffset', 'WorldTileInfoDataOffset', 'PreloadDependencyOffset'):
            v = self.get(k)
            if v: put(k, v + d)
        put('NameCount', len(self.names)); put('LastGenNameCount', len(self.names))
        for e in self.exports:
            at = e['at'] + d
            struct.pack_into('<qq', u, at + 28, e['size'], len(u) + e['start'])
        struct.pack_into('<q', u, self.f['BulkDataStartOffset'], len(u) + len(self.x) - 4)
        return bytes(u), bytes(self.x)


# tagged property helpers (cooked, no unversioned properties)
def float_tag(pkg, name, value):
    # Name, Type (FNames), Size, ArrayIndex, HasPropertyGuid, value
    return struct.pack('<IIIIii', pkg.add_name(name), 0, pkg.add_name('FloatProperty'), 0, 4, 0) + b'\0' + struct.pack('<f', value)


def selftest(uasset, uexp):
    p = Package(uasset, uexp); a, b = p.write()
    assert a == uasset and b == uexp, 'round trip changed the package'
    for s, h in p.names: assert h == struct.pack('<HH', *name_hashes(s)), ('hash', s, h.hex(), name_hashes(s))
    return True
