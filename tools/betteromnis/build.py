# SPDX-License-Identifier: AGPL-3.0-only
# BetterOmnis: buffs to Omnicell PASSIVES only (actives untouched), for Dauntless Forever 1.14.7. One override pak.
# 1. EDITS: same-size number edits. Each changes the gameplay value and the disc number (player_role_token_table,
#    display only) together, so the disc always says what the game does.
# 2. Revenant "Blood Ward": a new passive line. A copy of the Iceborne cell's low-health buff
#    (ce_iceborne_low50_defense_buff: below 50% health, incoming damage divided by 1 + magnitude, and a heal of 4/6/8% of
#    damage dealt at magnitude 0.20/0.25/0.30) under a new name, with its strength fixed at 0.30 in its defaults (cells
#    set it per rank; an Omnicell buff never gets a rank). The Iceborne cell itself is not changed. Revenant's catalog row
#    lists the copy in its Buffs (the list Bastion uses for its passives), and its disc text gets the new line as plain
#    English text (culture-invariant), so Game.locres (overridden by DF) is left alone.
#
# usage: python build.py <extracted Archon/Content dir> <base.json> <out dir>
#   extracted dir: the files in base.json, unpacked from the game's paks (1.14.7)
#   base.json: their in-pak fingerprints [{file, pak?, offset, sha1}] (Lantern refuses to install if a game pak differs)
import sys, struct, hashlib, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import upkg

R = '_shared/blueprints/buffs/playerroles/'
TOKENS = R + 'player_role_token_table.uexp'   # RawNumber (int) per row, shown on the Omnicell disc
TUNING = R + 'player_roles_tuning_table.uexp'
BASE_PAK = 'Archon_0-WindowsClient.pak'
# omnicell, what, gameplay file, offset, format, original, new, disc row offset (in TOKENS), disc original, disc new
EDITS = [
    ('Bastion',    'Shields received',      R + 'bastion/bastion_quarter_health_shield_buff.uexp', 2374, '<f', 0.15, 0.18, 78,   15,  18),
    ('Iceborne',   'Max health',            R + 'iceborne/ce_lowhp_iceborne_buff.uexp',            3114, '<f', 100.0, 125.0, 348, 100, 125),
    ('Discipline', 'Healing penalty',       R + 'discipline/discipline_passive_health_buff.uexp',  899,  '<f', -0.5, -0.45, 843,  50,  45),
    ('Tempest',    'Attack speed',          R + 'windfury/ce_tempest_atkspd_ge.uexp',              969,  '<f', 0.10, 0.15, 1293,  10,  15),
    ('Revenant',   'Lifesteal',             TUNING,                                                303,  '<f', 0.02, 0.05, 2013,   2,   5),
]
# Blood Ward
WARD_SRC = '_shared/blueprints/cells/Content/Iceborne/ce_iceborne_low50_defense_buff'
WARD = R + 'darkness/darkness_blood_ward_buff'
WARD_MAGNITUDE = 0.30   # rank 6 (the buff compares it with 0.3f exactly): damage taken / 1.3 (about 23% less), heal 8%
CATALOG = 'Gameplay/Backend/Catalogs/Gear_Catalogs/player_role_catalog'
ROW = 'PR_DARKNESS'
PASSIVE = ('+[DARKNESS_LIFESTEAL]% Lifesteal\r\n'
           '<bold>Blood Ward:</> Below 50% Health, take 23% less damage and gain +8% Lifesteal.\r\n'
           '<bold>Revenant State:</> Prevents all healing for [DARKNESS_FORMDURATION]s. When Revenant State ends, recover '
           '[DARKNESS_HOTAMOUNT] Health over [DARKNESS_HOTDURATION]s for each Void Energy you have.')
PASSIVE_WAS = 'PR_DARKNESS|Passive Description'
PAK = 'zzzzzzzzzzzzzzzz_BetterOmnis_P.pak'

def string(s): b = s.encode() + b'\0'; return struct.pack('<i', len(b)) + b
def pak(files):   # pak v8, uncompressed, same layout as Dauntless Forever's own paks (build_dialogue.py)
    def entry(off, data): return struct.pack('<QQQI', off, len(data), len(data), 0) + hashlib.sha1(data).digest() + struct.pack('<BI', 0, 0)
    b = bytearray(); records = []
    for n, data in sorted(files.items()): off = len(b); e = entry(off, data); b += e + data; records.append((n, e))
    ix = string('../../../Archon/Content/') + struct.pack('<I', len(records)) + b''.join(string(n) + e for n, e in records); off = len(b); b += ix
    return bytes(b) + bytes(17) + struct.pack('<IIQQ', 0x5a6f12e1, 8, off, len(ix)) + hashlib.sha1(ix).digest() + b'Zlib'.ljust(32, b'\0') + bytes(128)

def props(pkg, b, o):
    """tagged properties from o: ([(name, type, tag_start, size_at, value_start, value_end)], offset after the None)"""
    out = []
    while True:
        start = o; name = pkg.name_at(struct.unpack_from('<II', b, o)); o += 8
        if name == 'None': return out, o
        typ = pkg.name_at(struct.unpack_from('<II', b, o)); o += 8
        size_at = o; size = struct.unpack_from('<i', b, o)[0]; o += 8
        if typ == 'StructProperty': o += 24
        elif typ in ('ArrayProperty', 'SetProperty', 'ByteProperty', 'EnumProperty'): o += 8
        elif typ == 'MapProperty': o += 16
        elif typ == 'BoolProperty': o += 1
        if b[o]: o += 16
        o += 1
        out.append((name, typ, start, size_at, o, o + size))
        o += size

def blood_ward(src):
    """the copy of the Iceborne low-health buff, renamed, with its strength set in its defaults"""
    p = upkg.Package((src / (WARD_SRC + '.uasset')).read_bytes(), (src / (WARD_SRC + '.uexp')).read_bytes())
    old, new = WARD_SRC.rsplit('/', 1)[1], WARD.rsplit('/', 1)[1]
    for a, b in [('/Game/' + WARD_SRC, '/Game/' + WARD), (old + '_C', new + '_C'), ('Default__' + old + '_C', 'Default__' + new + '_C'),
                 ('ExecuteUbergraph_' + old, 'ExecuteUbergraph_' + new)]:
        p.rename(a, b)
    assert not any(old in n for n, _ in p.names), 'a name still has the old buff name'
    p.u[93:109] = hashlib.md5(WARD.encode()).digest()   # its own package GUID
    cdo = p.export('Default__' + new + '_C')
    b = bytes(p.x[cdo['start']:cdo['start'] + cdo['size']])
    found = [t[0] for t in props(p, b, 0)[0]]
    assert 'CellEffectMagnitude' not in found and 'ManualMagnitudeAdjustment' in found, found
    end = cdo['size'] - 8   # the closing None
    assert p.name_at(struct.unpack_from('<II', b, end)) == 'None'
    p.set_export(cdo, b[:end] + upkg.float_tag(p, 'CellEffectMagnitude', WARD_MAGNITUDE) + b[end:])
    return p.write()

def catalog(src):
    """Revenant's row: Blood Ward in its Buffs, and the passive text with the new line"""
    p = upkg.Package((src / (CATALOG + '.uasset')).read_bytes(), (src / (CATALOG + '.uexp')).read_bytes())
    path = '/Game/' + WARD + '.' + WARD.rsplit('/', 1)[1] + '_C'
    ref = p.add_name(path); p.add_name('/Game/' + WARD)   # object path, and package path as the cooker lists them
    e = p.exports[0]; b = bytearray(p.x[e['start']:e['start'] + e['size']])
    _, o = props(p, b, 0)   # the DataTable's own properties
    o += 4                  # then an int, then the rows: FName + properties each
    row = None
    rows = struct.unpack_from('<i', b, o)[0]; o += 4
    for _ in range(rows):
        name = p.name_at(struct.unpack_from('<II', b, o)); o += 8
        found, o = props(p, b, o)
        if name == ROW: row = found; break
    assert row, ROW
    t = {x[0]: x for x in row}
    _, typ, _, size_at, vs, ve = t['Buffs']
    assert typ == 'ArrayProperty' and struct.unpack_from('<i', b, vs)[0] == 0 and ve - vs == 4, 'Revenant already has Buffs'
    _, ttyp, _, tsize_at, ts, te = t['PassiveDescription']
    assert ttyp == 'TextProperty' and upkg.fstr(b, ts + 5 + 8)[0] == PASSIVE_WAS, 'passive text is not the one expected'
    text = struct.pack('<IbI', 2, -1, 1) + string(PASSIVE)   # flags CultureInvariant, history None, has string
    # later edit first, so the earlier offsets still hold
    assert ts > ve
    b[ts:te] = text; struct.pack_into('<i', b, tsize_at, len(text))
    b[ve:ve] = struct.pack('<II', ref, 0) + struct.pack('<i', 0)   # FSoftObjectPath: asset FName, empty sub path
    struct.pack_into('<i', b, vs, 1); struct.pack_into('<i', b, size_at, 4 + 12)
    p.set_export(e, bytes(b))
    return p.write()

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
    for f in (WARD_SRC + '.uasset', WARD_SRC + '.uexp'): del files[f]   # read only to make the copy: the cell stays as it is
    files[WARD + '.uasset'], files[WARD + '.uexp'] = blood_ward(src)
    files[CATALOG + '.uasset'], files[CATALOG + '.uexp'] = catalog(src)
    data = pak({k: bytes(v) for k, v in files.items()})
    (out / PAK).write_bytes(data)
    entries = [{'offset': e['offset'], 'sha1': e['sha1'], **({'pak': e['pak']} if e.get('pak') else {})} for e in base]
    manifest = {
        'pak': PAK, 'sha256': hashlib.sha256(data).hexdigest(), 'game': '1.14.7',
        'base': {'pak': BASE_PAK, 'entries': entries},
        'buffs': [{'omnicell': o, 'what': w, 'from': dold, 'to': dnew} for o, w, *_r, dold, dnew in EDITS]
                 + [{'omnicell': 'Revenant', 'what': 'new Blood Ward passive (below 50% health: 23% less damage taken, +8% lifesteal)', 'from': None, 'to': None}],
    }
    (out / 'betteromnis.json').write_text(json.dumps(manifest, indent=1) + '\n')
    print(PAK, len(data), manifest['sha256'])

if __name__ == '__main__':
    main(*sys.argv[1:4])
