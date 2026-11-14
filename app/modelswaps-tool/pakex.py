# SPDX-License-Identifier: AGPL-3.0-only
"""Reader for the game's own paks (pak v11, index not encrypted, Oodle data). Read-only.
Oodle is not shipped with the game: point OODLE at an oo2core_9_win64.dll you own (any game that ships one).
usage: pakex.py list <outfile>            - write every path of every pak
       pakex.py get <outdir> <substr>...  - extract files whose path contains any substr
"""
import struct, sys, os, glob, ctypes

PAKS = os.environ.get('DAUNTLESS_PAKS', r'C:\Games\Dauntless_1.14.7\Archon\Content\Paks')
OODLE = os.environ.get('OODLE_DLL', '')

def fstr(b, o):
    n, = struct.unpack_from('<i', b, o); o += 4
    if n >= 0: return b[o:o+n-1].decode('latin1') if n else '', o + n
    return b[o:o-2*n-2].decode('utf-16le'), o - 2*n

def index(path):
    with open(path, 'rb') as f:
        f.seek(-221, 2); ft = f.read(221)
        magic, ver, ioff, isz = struct.unpack_from('<IIqq', ft, 17)
        assert magic == 0x5A6F12E1, hex(magic)
        methods = [ft[61+i*32:93+i*32].split(b'\0')[0].decode() for i in range(5)]
        f.seek(ioff); b = f.read(isz)
        mount, o = fstr(b, 0)
        n, seed = struct.unpack_from('<iQ', b, o); o += 12
        has, = struct.unpack_from('<I', b, o); o += 4
        if has: o += 36
        has, = struct.unpack_from('<I', b, o); o += 4
        doff, dsz = struct.unpack_from('<qq', b, o); o += 36
        esz, = struct.unpack_from('<i', b, o); o += 4
        enc = b[o:o+esz]
        f.seek(doff); d = f.read(dsz)
    out = {}; o = 0
    nd, = struct.unpack_from('<i', d, o); o += 4
    for _ in range(nd):
        dn, o = fstr(d, o); nf, = struct.unpack_from('<i', d, o); o += 4
        for _ in range(nf):
            fn, o = fstr(d, o); eo, = struct.unpack_from('<i', d, o); o += 4
            out[(mount + dn + fn).replace('../../../', '').replace('//', '/')] = eo
    return out, enc, methods

def entry(enc, o):
    fl, = struct.unpack_from('<I', enc, o); o += 4
    bs = fl & 0x3f
    if bs == 0x3f: bs, = struct.unpack_from('<I', enc, o); o += 4
    else: bs <<= 11
    nb = (fl >> 6) & 0xffff; encd = (fl >> 22) & 1; meth = (fl >> 23) & 0x3f
    def rd(bit):
        nonlocal o
        if fl & bit: v, = struct.unpack_from('<I', enc, o); o += 4
        else: v, = struct.unpack_from('<q', enc, o); o += 8
        return v
    off = rd(1 << 31); usz = rd(1 << 30); csz = rd(1 << 29) if meth else usz
    hdr = 8+8+8+4+20 + ((4 + 16*nb) if meth else 0) + 1 + 4
    if nb == 1 and not encd: blocks = [csz]
    else: blocks = list(struct.unpack_from('<%dI' % nb, enc, o))
    return dict(off=off, usz=usz, csz=csz, meth=meth, bs=bs, blocks=blocks, hdr=hdr, enc=encd)

_oo = None
def oodle(src, n):
    global _oo
    if _oo is None: _oo = ctypes.CDLL(OODLE)
    dst = ctypes.create_string_buffer(n)
    r = _oo.OodleLZ_Decompress(src, len(src), dst, n, 1, 0, 0, None, None, None, None, None, 0, 3)
    assert r == n, (r, n)
    return dst.raw

def read(pakpath, e):
    with open(pakpath, 'rb') as f:
        f.seek(e['off'] + e['hdr'])
        if not e['meth']: return f.read(e['usz'])
        out = b''; left = e['usz']
        for c in e['blocks']:
            n = min(e['bs'], left); raw = f.read(c)
            out += raw if c == n else oodle(raw, n); left -= n
        return out

if __name__ == '__main__':
    cmd = sys.argv[1]
    paks = sorted(glob.glob(os.path.join(PAKS, '*.pak')))
    if cmd == 'list':
        with open(sys.argv[2], 'w', encoding='utf-8') as w:
            for p in paks:
                try: files, enc, m = index(p)
                except Exception as ex: print('skip', os.path.basename(p), ex); continue
                for k, eo in files.items():
                    w.write('%s\t%s\t%d\n' % (os.path.basename(p), k, entry(enc, eo)['usz']))
    elif cmd == 'get':
        outdir, subs = sys.argv[2], [s.lower() for s in sys.argv[3:]]
        for p in paks:
            try: files, enc, m = index(p)
            except Exception: continue
            for k, eo in files.items():
                if any(s in k.lower() for s in subs):
                    dst = os.path.join(outdir, k.replace('/', os.sep)); os.makedirs(os.path.dirname(dst), exist_ok=True)
                    open(dst, 'wb').write(read(p, entry(enc, eo))); print(k)
