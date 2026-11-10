# SPDX-License-Identifier: AGPL-3.0-only
# BetterOmnis: small buffs to Omnicell PASSIVES only (actives untouched), for Dauntless Forever 1.14.7.
# Each buff changes two numbers from one row of EDITS: the gameplay value and the disc number (player_role_token_table,
# display only), so the disc always says what the game does. Same-size in-place edits, one override pak.
#
# usage: python build.py <extracted Archon/Content dir> <base.json> <out dir>
#   extracted dir: the 12 files below, unpacked from Archon_0-WindowsClient.pak (1.14.7)
#   base.json: their in-pak fingerprints [{file, offset, sha1}] (Lantern refuses to install if the game's pak differs)
import sys, struct, hashlib, json
from pathlib import Path

R = '_shared/blueprints/buffs/playerroles/'
TOKENS = R + 'player_role_token_table.uexp'   # RawNumber (int) per row, shown on the Omnicell disc
TUNING = R + 'player_roles_tuning_table.uexp'
# omnicell, what, gameplay file, offset, format, original, new, disc row offset (in TOKENS), disc original, disc new
EDITS = [
    ('Bastion',    'Shields received',      R + 'bastion/bastion_quarter_health_shield_buff.uexp', 2374, '<f', 0.15, 0.18, 78,   15,  18),
    ('Iceborne',   'Max health',            R + 'iceborne/ce_lowhp_iceborne_buff.uexp',            3114, '<f', 100.0, 125.0, 348, 100, 125),
    ('Discipline', 'Healing penalty',       R + 'discipline/discipline_passive_health_buff.uexp',  899,  '<f', -0.5, -0.45, 843,  50,  45),
    ('Tempest',    'Attack speed',          R + 'windfury/ce_tempest_atkspd_ge.uexp',              969,  '<f', 0.10, 0.15, 1293,  10,  15),
    ('Revenant',   'Lifesteal',             TUNING,                                                303,  '<f', 0.02, 0.03, 2013,   2,   3),
]
PAK = 'zzzzzzzzzzzzzzzz_BetterOmnis_P.pak'

def string(s): b = s.encode() + b'\0'; return struct.pack('<i', len(b)) + b
def pak(files):   # pak v8, uncompressed, same layout as Dauntless Forever's own paks (build_dialogue.py)
    def entry(off, data): return struct.pack('<QQQI', off, len(data), len(data), 0) + hashlib.sha1(data).digest() + struct.pack('<BI', 0, 0)
    b = bytearray(); records = []
    for n, data in sorted(files.items()): off = len(b); e = entry(off, data); b += e + data; records.append((n, e))
    ix = string('../../../Archon/Content/') + struct.pack('<I', len(records)) + b''.join(string(n) + e for n, e in records); off = len(b); b += ix
    return bytes(b) + bytes(17) + struct.pack('<IIQQ', 0x5a6f12e1, 8, off, len(ix)) + hashlib.sha1(ix).digest() + b'Zlib'.ljust(32, b'\0') + bytes(128)

def main(src, base_json, out):
    src, out = Path(src), Path(out)
    base = json.loads(Path(base_json).read_text())
    files = {e['file']: bytearray((src / e['file']).read_bytes()) for e in base}
    def put(f, off, fmt, old, new):
        cur = struct.unpack_from(fmt, files[f], off)[0]
        assert abs(cur - old) < 1e-6, f'{f}@{off}: expected {old}, found {cur} (not the 1.14.7 file?)'
        struct.pack_into(fmt, files[f], off, new)
    for omni, what, f, off, fmt, old, new, doff, dold, dnew in EDITS:
        put(f, off, fmt, old, new)
        put(TOKENS, doff, '<i', dold, dnew)
    data = pak({k: bytes(v) for k, v in files.items()})
    (out / PAK).write_bytes(data)
    manifest = {
        'pak': PAK, 'sha256': hashlib.sha256(data).hexdigest(), 'game': '1.14.7',
        'base': {'pak': 'Archon_0-WindowsClient.pak', 'entries': [{'offset': e['offset'], 'sha1': e['sha1']} for e in base]},
        'buffs': [{'omnicell': o, 'what': w, 'from': dold, 'to': dnew} for o, w, *_r, dold, dnew in EDITS],
    }
    (out / 'betteromnis.json').write_text(json.dumps(manifest, indent=1) + '\n')
    print(PAK, len(data), manifest['sha256'])

if __name__ == '__main__':
    main(*sys.argv[1:4])
