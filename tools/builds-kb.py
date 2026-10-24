#!/usr/bin/env python3
# Lantern Client - builds the Meta Build Creator's knowledge base (app/builds/kb-1147.json). Licence: AGPL-3.0-only.
#
# Not shipped or run by the app: the owner runs it when the data should be refreshed.
#   python3 tools/builds-kb.py <dauntless-builder-legacy checkout> <catalog-1147.json> [out]
# Needs PyYAML.
#
# Sources (both AGPL-3.0, the same licence as Lantern Client):
#   - Dauntless Builder (pre-Awakening, "DB Reforged"): https://github.com/atomicptr/dauntless-builder-legacy
#     Community-maintained item data for Dauntless 1.14.6. 1.14.7 (9 April 2024) changed no perks, cells, weapons,
#     armour, lanterns or Omnicells, so these are the 1.14.7 numbers.
#   - Its copy of the community "Dauntless Meta Builds - 1.10+" spreadsheet (src/json/meta-builds.json), decoded
#     from the builder's build ids.
# Every item is checked against the game's own 1.14.7 catalog (the Dauntless Forever package's catalog-1147.json,
# read from the game files): items the 1.14.7 game does not have are marked, and builds that use them are dropped.
import json, sys, re, glob, os, subprocess, datetime
import yaml
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from builds_ids import Hashids, Sqids

SRC, CATALOG = sys.argv[1], sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), '..', 'app', 'builds', 'kb-1147.json')
D = os.path.join(SRC, 'data')
def y(p): return yaml.safe_load(open(p, encoding='utf-8'))
def files(*parts): return sorted(glob.glob(os.path.join(D, *parts)))

def render(text, values):
    """'{{x}}' -> its value (the builder's templates); a description with nothing to fill is kept as is"""
    if text is None: return None
    if isinstance(text, list): text = ' '.join(t for t in text if t)
    v = values or {}
    def sub(m):
        k = m.group(1)
        if k == 'NL': return '\n'
        return str(v[k]) if k in v else m.group(0)
    out = re.sub(r'\{\{(\w+)\}\}', sub, str(text))
    out = re.sub(r'<[^>]+>', '', out)   # <b>..</b>
    return re.sub(r'[ \t]+', ' ', out).strip()

# ---- the game's own 1.14.7 names
cat = json.load(open(CATALOG, encoding='utf-8'))['items']
game, byid = {}, {}
for it in cat:
    game.setdefault(it['group'], {}).setdefault(it['name'].strip().lower(), it['id'])
    byid[it['id']] = it
def in_game(group, name): return name.strip().lower() in game.get(group, {})
def game_id(group, name): return game.get(group, {}).get(name.strip().lower())

# Items whose name is not in the catalog (the game files leave some names untranslated, e.g. WP_DP_LERAWR for Ember
# Shots) are found by their internal name: weapons are WP_<type>_<behemoth>, armour AR_<behemoth>_<HELM|CHEST|ARMS|LEGS>,
# and a behemoth's internal name is the one its other, named items use. Behemoths with no named item at all:
WTYPE = {'Aether Strikers': 'AC', 'Chain Blades': 'CB', 'Repeater': 'DP', 'Sword': 'EB', 'Axe': 'GA', 'Hammer': 'IH', 'War Pike': 'MS'}
ASLOT = {'Head': 'HELM', 'Torso': 'CHEST', 'Arms': 'ARMS', 'Legs': 'LEGS'}
KNOWN_CODES = {'Fenroar': 'FENROAR', 'Frostwülf': 'FROSTWOLF', 'Thunderdeep Drask': 'FULGAR_ALPHA'}
# The five sets below exist in 1.14.7 (the catalog has exactly five more unnamed weapon-and-armour sets: AMBER, GLITTER,
# HABANERO, MANTIS, MINT), but which internal name is which behemoth is not known: they count as in the game, with no id.
BY_ELIMINATION = {'Urska', 'Sahvyt', 'Phaelanx', 'Chronovore', 'Alyra'}
# Behemoth-less sets the same way: the catalog has two more unnamed armour-only sets (CRYSTAL, NAKED) for Timeweave and
# the Krolachi outfit, and unnamed event and exotic repeaters (Frostfall and Springtide weapons, EXOTIC_BOMBS) for these
NAMES_BY_ELIMINATION = {'Timeweave Helm', 'Timeweave Robes', 'Timeweave Gauntlets', 'Timeweave Leggings', 'Krolachi Shave',
                        'Krolachi Shorts', 'Krolachi Tunic', 'Krolachi Wraps', 'Silver Sword', 'The Golden Claws', 'The Twin Suns'}
# cells the catalog has without a name, matched by what their internal name says they do (the same effect as the perk)
CELL_CODES = {'Galvanized Cell': 'HPSHIELD_CRIT', 'Pulse Cell': 'RHYTHMIC', 'Omnisurge Cell': 'OMNISURGE', 'Tactician Cell': 'TEAMEXPOSE',
              'Rushdown Cell': 'INTERRUPT_STAM', 'Stop Cell': 'DODGE_STAGGER', 'Roll Cell': 'STAGGER_FREE_DODGE', 'Drop Cell': 'MIN_STAM',
              'Reduce Cell': 'DMGUP_ATKSPDDOWN', 'Recycle Cell': 'SAME_PART_DMG_UP', 'Water Cell': 'DODGE_DR', 'Fire Cell': 'ATKSPD_MVSPD_SELFHARM',
              'Earth Cell': 'SHIELD_DETONATION', 'Conservation Cell': 'MS_DOWN_SHIELD_UP', 'Inertia Cell': 'CRIT_CHANCE_WHILE_SPRINT',
              'Impulse Cell': 'CRIT_DAMAGE_FROM_MS', 'Pack Hunter Cell': 'KILL_FAUNA_DMG', 'Pack Caller Cell': 'BREAK_SUMMON_FAUNA',
              'Pack Walker Cell': 'NEAR_FAUNA_MS_AS'}
# four unnamed cell families (LANTERNCHARGE_FLAT, LOWHP_ATKSPD, SHIELDS_HIT_ABSORB, PART_BREAK_ATKSPD_UP) for four cells
# whose pairing is not certain: in the game, no id
CELLS_BY_ELIMINATION = {'Aegis Cell', 'Aetheric Evasion Cell', "Assassin's Frenzy Cell", 'Reuse Cell'}
RARITY_SUFFIX = {'uncommon': 'UC', 'rare': 'R', 'epic': 'E'}

# ---- perks
perks = {}
for f in files('perks', '*.yml'):
    p = y(f)
    eff = {}
    for lvl, e in (p.get('effects') or {}).items():
        eff[str(lvl)] = render(e.get('description'), e.get('values'))
    perks[p['name']] = {'type': p.get('type'), 'description': render(p.get('description'), None), 'effects': eff}

# ---- cells: the +3 variant is the strongest; all variants kept with their perk value
cells = {}
for f in files('cells', '*', '*.yml'):
    c = y(f)
    variants = {}
    for vname, v in (c.get('variants') or {}).items():
        (perk, val), = v['perks'].items()
        gid = game_id('Cells', vname)
        if not gid and c['name'] in CELL_CODES:
            cand = 'CELL_' + CELL_CODES[c['name']] + '_' + RARITY_SUFFIX.get(v.get('rarity'), '')
            gid = cand if cand in byid else None
        exists = 'yes' if gid else ('inferred' if c['name'] in CELLS_BY_ELIMINATION else 'unknown')
        variants[vname] = {'perk': perk, 'value': val, 'rarity': v.get('rarity'), 'id': gid, 'exists': exists}
    perk = next(iter(variants.values()))['perk'] if variants else None
    cells[c['name']] = {'slot': c.get('slot'), 'perk': perk, 'variants': variants}

def surged_perks(item):
    out = {}
    lst = item.get('perks') or []
    surged = [p for p in lst if p.get('powerSurged')]
    for p in (surged or [p for p in lst if not p.get('powerSurged')]):
        out[p['name']] = out.get(p['name'], 0) + p['value']
    return out
def effects(item):
    ue = item.get('unique_effects') or []
    surged = [u for u in ue if u.get('powerSurged')]
    keep = surged + [u for u in ue if not u.get('powerSurged') and not any(s.get('name') == u.get('name') for s in surged)]
    return [render(u.get('description'), u.get('values')) for u in keep]
def slots(c):
    if c is None: return []
    return c if isinstance(c, list) else [c]

weapons = []
for f in files('weapons', '*', '*.yml'):
    w = y(f)
    weapons.append({'name': w['name'], 'type': w['type'], 'behemoth': w.get('behemoth'), 'element': w.get('elemental'),
                    'damage': w.get('damage'), 'cells': slots(w.get('cells')), 'perks': surged_perks(w), 'effects': effects(w),
                    'exotic': w.get('rarity') == 'exotic', 'bond': (w.get('bond') or {}).get('elemental'),
                    'restrictSpecials': bool(w.get('restrict_specials')), 'event': 'Event' in (w.get('tags') or []),
                    'id': game_id('Weapons', w['name'])})
armours = []
for f in files('armours', '*', '*.yml'):
    a = y(f)
    armours.append({'name': a['name'], 'type': a['type'], 'behemoth': a.get('behemoth'), 'element': a.get('strength'),
                    'weakness': a.get('weakness'), 'cells': slots(a.get('cells')), 'perks': surged_perks(a), 'effects': effects(a),
                    'exotic': a.get('rarity') == 'exotic', 'id': game_id('Armour', a['name'])})
# behemoth internal names from the items that are named in the catalog
import collections
codes = collections.defaultdict(collections.Counter)
for w in weapons:
    if w['id'] and w['behemoth']:
        m = re.match(r'WP_[A-Z]+_(.+)$', w['id']); codes[w['behemoth']][m.group(1)] += 1
for a in armours:
    if a['id'] and a['behemoth']:
        m = re.match(r'AR_(.+)_(HELM|CHEST|ARMS|LEGS)$', a['id'])
        if m: codes[a['behemoth']][m.group(1)] += 1
def code_of(beh):
    if beh in KNOWN_CODES: return KNOWN_CODES[beh]
    c = codes.get(beh)
    return c.most_common(1)[0][0] if c else None
for w in weapons:
    if not w['id'] and w['name'].startswith("Recruit's ") and 'WP_' + WTYPE[w['type']] + '_BEGINNER' in byid: w['id'] = 'WP_' + WTYPE[w['type']] + '_BEGINNER'
    if not w['id'] and w['behemoth']:
        cd = code_of(w['behemoth']); cand = cd and 'WP_' + WTYPE[w['type']] + '_' + cd
        if cand and cand in byid: w['id'] = cand
    w['exists'] = 'yes' if w['id'] else ('inferred' if w['behemoth'] in BY_ELIMINATION or w['name'] in NAMES_BY_ELIMINATION else 'unknown')
RECRUIT_ARMOUR = {"Recruit's Mask": 'AR_BEGINNER_HELM', "Recruit's Breastplate": 'AR_BEGINNER_CHEST', "Recruit's Gloves": 'AR_BEGINNER_ARMS', "Recruit's Greaves": 'AR_BEGINNER_LEGS'}
for a in armours:
    if not a['id'] and a['name'] in RECRUIT_ARMOUR: a['id'] = RECRUIT_ARMOUR[a['name']]
    if not a['id'] and a['behemoth']:
        cd = code_of(a['behemoth']); cand = cd and 'AR_' + cd + '_' + ASLOT[a['type']]
        if cand and cand in byid: a['id'] = cand
    a['exists'] = 'yes' if a['id'] else ('inferred' if a['behemoth'] in BY_ELIMINATION or a['name'] in NAMES_BY_ELIMINATION else 'unknown')
    # the game's own name when the catalog has one for that id (Recruit's armour is named differently in-game)
    if a['id'] and byid[a['id']]['name'] != a['id'] and byid[a['id']]['name'].lower() != a['name'].lower(): a['gameName'] = byid[a['id']]['name']
for w in weapons:
    if w['id'] and byid[w['id']]['name'] != w['id'] and byid[w['id']]['name'].lower() != w['name'].lower(): w['gameName'] = byid[w['id']]['name']
lanterns = []
for f in files('lanterns', '*.yml'):
    l = y(f)
    ab = l.get('lantern_ability') or {}
    lanterns.append({'name': l['name'], 'cells': slots(l.get('cells')), 'instant': render(ab.get('instant'), l.get('values')),
                     'hold': render(ab.get('hold'), l.get('values')), 'id': game_id('Lanterns', l['name'])})
    lanterns[-1]['exists'] = 'yes' if lanterns[-1]['id'] else 'unknown'
omnicells = []
for f in files('omnicells', '*.yml'):
    o = y(f)
    omnicells.append({'name': o['name'], 'passive': render(o.get('passive'), o.get('passive_values')),
                      'active': render(o.get('active'), o.get('active_values')), 'id': game_id('Omnicells', o['name'])})
    omnicells[-1]['exists'] = 'yes' if omnicells[-1]['id'] else 'unknown'
PART_DIRS = {'aetherstrikers': 'Aether Strikers', 'axe': 'Axe', 'chainblades': 'Chain Blades', 'hammer': 'Hammer',
             'repeater': 'Repeater', 'sword': 'Sword', 'warpike': 'War Pike'}
parts = {}
for d, wt in PART_DIRS.items():
    parts[wt] = {}
    for kind_dir in sorted(os.listdir(os.path.join(D, 'parts', d))):
        lst = []
        for f in files('parts', d, kind_dir, '*.yml'):
            p = y(f)
            lst.append({'name': p['name'], 'effect': render(p.get('part_effect'), p.get('values'))})
        parts[wt][kind_dir] = lst

# ---- community meta builds (decoded from the builder's build ids)
names = json.load(open(os.path.join(SRC, 'src', 'json', 'names.json'), encoding='utf-8'))
meta = json.load(open(os.path.join(SRC, 'src', 'json', 'meta-builds.json'), encoding='utf-8'))
H = Hashids('spicy')
S7 = Sqids("MNWboUQG19y_Oja2ZEh4liLfst053FTCkpBVrw~Ix.7dJDnmugeKYS6-vcR8zqHAPX")
S8 = Sqids("h1tiFLYU5eO6rSEfg_JdlVHvMz0NToujK9-ncwXp7P24axkRWsAG3bBImyD8CZQq")
def numbers(bid):
    try:
        n = H.decode(bid)
        if len(n) > 8: return n
    except Exception: pass
    n = S7.decode(bid)
    if len(n) > 8: return n
    return S8.decode(bid)
F6 = ['version', 'flags', 'weapon', 'surged', 'weaponCell1', 'weaponCell2', 'part1', 'part2', 'part3', 'bond',
      'head', 'headSurged', 'headCell', 'torso', 'torsoSurged', 'torsoCell', 'arms', 'armsSurged', 'armsCell',
      'legs', 'legsSurged', 'legsCell', 'lantern', 'lanternCell', 'omnicell']
PARTMAP = {'Aether Strikers': 'Parts:Aetherstrikers', 'Axe': 'Parts:Axe', 'Chain Blades': 'Parts:Chainblades', 'Hammer': 'Parts:Hammer',
           'Repeater': 'Parts:Repeater', 'Sword': 'Parts:Sword', 'War Pike': 'Parts:Warpike'}
W = {w['name']: w for w in weapons}; A = {a['name']: a for a in armours}
CV = {v: c for c, cd in cells.items() for v in cd['variants']}
def nm(group, i): return names[group].get(str(i)) if i else None
metabuilds, dropped = [], {}
for c in meta['categories']:
    for b in c['builds']:
        n = numbers(b['buildId'])
        if not n: dropped['undecodable'] = dropped.get('undecodable', 0) + 1; continue
        if n[0] == 5: n = [6, 0] + n[1:]
        if n[0] not in (6, 7, 8) or len(n) < 24: dropped['format'] = dropped.get('format', 0) + 1; continue
        r = dict(zip(F6, n + [0] * (25 - len(n))))
        w = nm('Weapons', r['weapon'])
        if not w or w not in W: dropped['weapon'] = dropped.get('weapon', 0) + 1; continue
        pm = PARTMAP[W[w]['type']]
        build = {'weapon': w, 'weaponCells': [nm('Cells', r['weaponCell1']), nm('Cells', r['weaponCell2'])],
                 'parts': [x for x in (nm(pm, r['part1']), nm(pm, r['part2']), nm(pm, r['part3'])) if x and x != 'REMOVED'],
                 'bond': nm('Weapons', r['bond']), 'head': nm('Armours', r['head']), 'headCell': nm('Cells', r['headCell']),
                 'torso': nm('Armours', r['torso']), 'torsoCell': nm('Cells', r['torsoCell']), 'arms': nm('Armours', r['arms']),
                 'armsCell': nm('Cells', r['armsCell']), 'legs': nm('Armours', r['legs']), 'legsCell': nm('Cells', r['legsCell']),
                 'lantern': nm('Lanterns', r['lantern']), 'lanternCell': nm('Cells', r['lanternCell']), 'omnicell': nm('Omnicells', r['omnicell'])}
        missing = [build[k] for k in ('head', 'torso', 'arms', 'legs') if build[k] not in A]
        missing += [x for x in build['weaponCells'] + [build[k] for k in ('headCell', 'torsoCell', 'armsCell', 'legsCell', 'lanternCell')] if x and x not in CV]
        if missing: dropped['items not in data'] = dropped.get('items not in data', 0) + 1; continue
        gone = [n for n in [w] + [build[k] for k in ('head', 'torso', 'arms', 'legs')] if (W.get(n) or A.get(n) or {}).get('exists') == 'unknown']
        gone += [x for x in build['weaponCells'] + [build[k] for k in ('headCell', 'torsoCell', 'armsCell', 'legsCell', 'lanternCell')] if x and cells[CV[x]]['variants'][x]['exists'] == 'unknown']
        if gone:
            dropped['items not in 1.14.7'] = dropped.get('items not in 1.14.7', 0) + 1
            for g in gone: dropped['gone:' + g] = dropped.get('gone:' + g, 0) + 1
            continue
        metabuilds.append({'category': c['name'], 'categoryInfo': c.get('description', ''), 'tier': c.get('tier'),
                           'title': b['title'], 'subcategory': b.get('subcategory'),
                           'subcategoryInfo': (c.get('subcategoryDescription') or {}).get(b.get('subcategory') or '', ''),
                           'vsElement': b.get('vsElement'), 'buildId': b['buildId'], 'build': build})

try: commit = subprocess.check_output(['git', '-C', SRC, 'log', '-1', '--format=%H %cs'], text=True).strip()
except Exception: commit = ''
try: metaCommit = subprocess.check_output(['git', '-C', SRC, 'log', '-1', '--format=%H %cs', '--', 'src/json/meta-builds.json'], text=True).strip()
except Exception: metaCommit = ''
misc = y(os.path.join(D, 'misc.yml'))
kb = {
    'about': {
        'game': '1.14.7', 'dataVersion': misc.get('dauntless_version'),
        'note': 'Dauntless 1.14.7 (9 April 2024) changed no perks, cells, weapons, armour, lanterns or Omnicells; the 1.14.6 numbers apply.',
        'generated': datetime.date.today().isoformat(),
        'sources': [
            {'id': 'db', 'title': 'Dauntless Builder (pre-Awakening item data, Dauntless ' + str(misc.get('dauntless_version')) + ')',
             'url': 'https://github.com/atomicptr/dauntless-builder-legacy', 'commit': commit, 'licence': 'AGPL-3.0'},
            {'id': 'meta', 'title': meta.get('title') + ' (community spreadsheet, via Dauntless Builder)',
             'url': 'https://docs.google.com/spreadsheets/d/1-I4LQ_8uNqV9LuybXhz2wjmcPeTNNGWRZ-kFjsckwtk', 'commit': metaCommit},
            {'id': 'patch', 'title': 'Dauntless 1.14.6 and 1.14.7 update notes (Switch update log)',
             'url': 'https://www.perfectly-nintendo.com/dauntless-switch-software-updates/'},
            {'id': 'game', 'title': 'Your Dauntless 1.14.7 game files (item catalog)', 'url': ''},
        ],
        'metaDropped': dropped,
    },
    'perks': perks, 'cells': cells, 'weapons': weapons, 'armours': armours, 'lanterns': lanterns,
    'omnicells': omnicells, 'parts': parts, 'metaBuilds': metabuilds,
}
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
json.dump(kb, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('wrote', OUT, os.path.getsize(OUT), 'bytes;', len(perks), 'perks', len(cells), 'cells', len(weapons), 'weapons',
      len(armours), 'armour', len(lanterns), 'lanterns', len(omnicells), 'omnicells', len(metabuilds), 'meta builds; dropped', dropped)
import collections as Cc
print('weapons', Cc.Counter(w['exists'] for w in weapons), [w['name'] for w in weapons if w['exists'] == 'unknown'])
print('armour', Cc.Counter(a['exists'] for a in armours), [a['name'] for a in armours if a['exists'] == 'unknown'])
print('cells', Cc.Counter(v['exists'] for c in cells.values() for v in c['variants'].values()), [n for n, c in cells.items() if any(v['exists'] == 'unknown' for v in c['variants'].values())])
print('lanterns/omnicells unknown', [l['name'] for l in lanterns if l['exists'] == 'unknown'], [o['name'] for o in omnicells if o['exists'] == 'unknown'])
print('renamed in game', [(x['name'], x['gameName']) for x in weapons + armours if x.get('gameName')])
