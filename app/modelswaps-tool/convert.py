# SPDX-License-Identifier: AGPL-3.0-only
# Model Swaps converter: a character model file -> a library entry Lantern can install.
#   python convert.py <model.gltf|.glb> --id roxas --name "Roxas" --game "Kingdom Hearts" --out <library dir>
#                     [--author ..] [--description ..] [--source url] [--license ..] [--landmarks file.json]
#                     [--paks <game Paks dir>] [--oodle <oo2core_9_win64.dll>] [--cache <dir>]
# Writes <library dir>/<id>/: LanternModel_<id>_P.pak, model.json, preview.png. Prints one JSON line at the end
# ({"ok":true,...} or {"ok":false,"error":"..."}), which is what Lantern's panel reads.
# Supported input: glTF 2.0 (.gltf with its files, or .glb), rigged or not, standing upright in a T-pose or A-pose.
import argparse, hashlib, json, os, re, struct, sys, time, traceback
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build, fit, gltf, pakex, render, skm, upkg

TOOL = 1   # raise when the built files change, so Lantern can ask for a rebuild
GAME = '1.14.7'


def string(s): b = s.encode() + b'\0'; return struct.pack('<i', len(b)) + b
def pak(files):   # pak v8, uncompressed: the layout Dauntless Forever's own paks use (same writer as BetterOmnis)
    def entry(off, data): return struct.pack('<QQQI', off, len(data), len(data), 0) + hashlib.sha1(data).digest() + struct.pack('<BI', 0, 0)
    b = bytearray(); records = []
    for n, data in sorted(files.items()): off = len(b); e = entry(off, data); b += e + data; records.append((n, e))
    ix = string('../../../Archon/Content/') + struct.pack('<I', len(records)) + b''.join(string(n) + e for n, e in records); off = len(b); b += ix
    return bytes(b) + bytes(17) + struct.pack('<IIQQ', 0x5a6f12e1, 8, off, len(ix)) + hashlib.sha1(ix).digest() + b'Zlib'.ljust(32, b'\0') + bytes(128)


def templates(cache, paks, oodle):   # the Dauntless packages the character's files are copied from
    cache = Path(cache); want = [t + ext for t in build.TEMPLATES for ext in ('.uasset', '.uexp')]
    if all((cache / w).exists() for w in want): return cache
    if not oodle or not os.path.exists(oodle): raise fit.Unfit('the game files could not be read: no Oodle library (oo2core_9_win64.dll) was given')
    pakex.OODLE = oodle; left = set(want)
    for p in sorted(Path(paks).glob('Archon_*.pak')):
        try: files, enc, _ = pakex.index(str(p))
        except Exception: continue
        for w in list(left):
            k = 'Archon/Content/' + w
            if k in files:
                (cache / w).parent.mkdir(parents=True, exist_ok=True); (cache / w).write_bytes(pakex.read(str(p), pakex.entry(enc, files[k]))); left.discard(w)
        if not left: break
    if left: raise fit.Unfit('this game version is missing files the converter needs (%s)' % sorted(left)[0])
    return cache


def run(a):
    cid = a.id
    if not re.fullmatch(r'[a-z0-9_]{1,32}', cid): raise fit.Unfit('the id may only have lower-case letters, digits and _ (32 at most)')
    if Path(a.model).suffix.lower() not in ('.gltf', '.glb'): raise fit.Unfit('only glTF files (.gltf, .glb) are supported for now')
    src = templates(a.cache, a.paks, a.oodle)
    k = upkg.Package((src / (build.T_MESH + '.uasset')).read_bytes(), (src / (build.T_MESH + '.uexp')).read_bytes())
    slayer = fit.Slayer(k, skm.load(k))
    try: model = gltf.load(a.model)
    except fit.Unfit: raise
    except Exception as ex: raise fit.Unfit('the model file could not be read (%s)' % (str(ex) or type(ex).__name__))
    given = json.loads(Path(a.landmarks).read_text()) if a.landmarks else None
    notes = []
    if model['joints']: notes.append('The model has its own skeleton; it is bound by shape for now, so its own skin weights are not used.')
    else: notes.append('The model had no skeleton: it was bound to the Slayer automatically from its shape.')
    parts, info = fit.bind(model['parts'], slayer, given, log=lambda s: print(s, file=sys.stderr))
    files, stats, _ = build.character(src, cid, parts, slayer)
    notes += ['Hands and head are rigid: fingers and face do not animate.', 'Hair and cloth do not move on their own.']
    if any(q.get('alpha') == 'BLEND' for q in parts): notes.append('See-through parts are drawn as cut-outs (no soft transparency).')
    out = Path(a.out) / cid; out.mkdir(parents=True, exist_ok=True)
    pak_name = 'LanternModel_%s_P.pak' % cid; data = pak(files)
    tmp = out / (pak_name + '.tmp'); tmp.write_bytes(data); os.replace(tmp, out / pak_name)
    render.draw(fit.pose(parts, slayer, {}), (384, 512), 'front').save(out / 'preview.png')
    meta = {'id': cid, 'name': a.name or cid, 'game': a.game or '', 'author': a.author or '', 'description': a.description or '',
            'source': a.source or '', 'license': a.license or '', 'pak': pak_name, 'pakSha256': hashlib.sha256(data).hexdigest(),
            'pakSize': len(data), 'preview': 'preview.png', 'mesh': '/Game/%s%s/%s.%s' % (build.ROOT, cid, cid, cid), 'scale': info['scale'], 'height': info['height'],
            'compatibility': {'status': 'ok', 'notes': notes}, 'stats': stats, 'fit': info, 'tool': TOOL, 'gameVersion': GAME,
            'built': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    (out / 'model.json').write_text(json.dumps(meta, indent=1), encoding='utf-8')
    return {'ok': True, 'id': cid, 'dir': str(out), 'stats': stats, 'scale': info['scale'], 'height': info['height']}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('model'); ap.add_argument('--id', required=True); ap.add_argument('--out', required=True)
    for o in ('name', 'game', 'author', 'description', 'source', 'license', 'landmarks'): ap.add_argument('--' + o)
    ap.add_argument('--paks', default=pakex.PAKS); ap.add_argument('--oodle', default=pakex.OODLE)
    ap.add_argument('--cache', default=str(Path(os.environ.get('LOCALAPPDATA', '.')) / 'DFTrainer' / 'modelswaps-cache'))
    a = ap.parse_args()
    try: res = run(a)
    except (fit.Unfit, ValueError) as ex: res = {'ok': False, 'error': str(ex)}
    except Exception as ex: traceback.print_exc(); res = {'ok': False, 'error': 'the converter failed: %s' % (str(ex) or type(ex).__name__)}
    print(json.dumps(res)); sys.exit(0 if res['ok'] else 1)
