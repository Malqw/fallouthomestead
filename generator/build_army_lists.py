# -*- coding: utf-8 -*-
"""Turns the BMCE army-list Excel (units per faction + which equipment each army list may use) into
generator/army_lists.json for the Master tab's unit generator, mapping every unit/item to our own
UNITS_DB / ITEMS_DB row index (by normalised name). Usage: python build_army_lists.py [path-to.xlsx]"""
import json, re, sys, collections, os
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
XLSX = sys.argv[1] if len(sys.argv) > 1 else 'C:/Users/yablo/Downloads/Fallout_Wasteland_Warfare_BMCE.xlsx'
INDEX = os.path.join(HERE, '..', 'index.html')

src = open(INDEX, encoding='utf-8').read()
def arr(name):
    return json.loads(re.search(r'const %s = (\[.*?\]);\r?\n' % name, src, re.S).group(1))
UNITS = arr('UNITS_DB'); ITEMS = arr('ITEMS_DB')
hidden_units = set(json.loads('[' + re.search(r'HIDDEN_UNIT_INDICES = new Set\(\[(.*?)\]\)', src, re.S).group(1) + ']'))
hidden_items = set(json.loads('[' + re.search(r'HIDDEN_ITEM_INDICES = new Set\(\[(.*?)\]\)', src, re.S).group(1) + ']'))

def norm(s):
    s = str(s).upper().replace('*', '').replace('\u2019', "'").replace("'", '')
    s = re.sub(r'\bARMOUR\b', 'ARMOR', s)
    s = re.sub(r'\bMK\s*(I{1,3}|\d)\b', lambda m: 'MK' + {'I': '1', 'II': '2', 'III': '3'}.get(m.group(1), m.group(1)), s)
    s = re.sub(r'[^A-Z0-9 ]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

# our unit name for the Excel names that don't normalise to it
UNIT_ALIAS = {
    'Operators Butcher': 'Operator Butcher', 'Operators Pillager': 'Operator Pillager', 'Operators Scavver': 'Operator Scavver',
    'Operators Survivalist': 'Operator Survivalist', 'Operators Tormentor': 'Operator Tormentor',
    'Operators Veteran': 'Operator Veteran', 'Operators Waster': 'Operator Waster',
    'Dixie': 'Disciples Dixie', 'Nisha': 'Disciples Nisha', 'Savoy': 'Disciples Savoy',
    'Lizzie': 'Operator Lizzie', 'Mags': 'Operator Mags', 'William': 'Operator William',
    'Hound': 'Pack Hound', 'Mason': 'Pack MASON', 'Gatorclaw': 'Gator Claw', 'Lucy Maclean': 'Lucy*',
    'Moria Brown': 'Moira Brown', 'Sierra': 'Sierra Petrovita',
    'Securitron MK I': 'Securitron mk1', 'Securitron MK II': 'Securitron mk2',
    'Nukalurk': 'Nukalurk Hatchlings',
}

units_by_name = collections.defaultdict(list)
for i, u in enumerate(UNITS):
    units_by_name[norm(u[1])].append(i)
items_by_name = collections.defaultdict(list)
for i, it in enumerate(ITEMS):
    items_by_name[norm(it[2])].append(i)

def unit_idx(name):
    n = re.sub(r'\s*\(.*?\)\s*$', '', name).strip()  # "Raul (May be selected ...)"
    n = UNIT_ALIAS.get(name, UNIT_ALIAS.get(n, n))
    c = units_by_name.get(norm(n), [])
    vis = [i for i in c if i not in hidden_units]
    return (vis or c or [None])[0]

SECTIONS = {  # Excel section / unit "Allowed Items" token -> canonical name (= our ITEMS_DB group)
    'STANDARD ITEM': 'Standard Items', 'STANDARD ITEMS': 'Standard Items', 'WASTELAND ITEMS': 'Wasteland Items',
    'ADVANCED ITEMS': 'Advanced Items', 'HIGH-TECH ITEMS': 'Hightech Items', 'USABLE ITEMS': 'Useable Items',
    'POWER ARMOR': 'Power Armor', 'UPGRADES': 'Upgrades', 'SUPER MUTANTS ITEMS': 'Super Mutants Items',
    'PERSONAL ITEMS': 'Personal Items', 'ROBOT ITEMS': 'Robot Items', 'ROBOT WEAPONS': 'Robot Items',
    'ROBOT WEAPON': 'Robot Items', 'CREATURE ITEMS': 'Creature Items', 'DOG ITEMS': 'Dog Items', 'ALIEN ITEMS': 'Alien Items',
}
def allowed_sections(text):
    t = str(text or '').strip()
    if t in ('', '-'):
        return []
    if t.startswith('(see'):
        return None  # "see models entry": don't restrict
    out = []
    for tok in re.split(r',+', t):
        k = tok.strip().lower()
        if not k:
            continue
        name = ('Upgrades' if 'upgrade' in k else 'Useable Items' if 'usable' in k else 'Hightech Items' if ('high' in k) else
                'Power Armor' if 'power' in k else 'Standard Items' if 'standard' in k else 'Wasteland Items' if 'wasteland' in k else
                'Advanced Items' if 'advanced' in k else 'Super Mutants Items' if 'super mutant' in k else 'Robot Items' if 'robot' in k else
                'Creature Items' if 'creature' in k else 'Dog Items' if 'dog' in k else 'Alien Items' if 'alien' in k else
                'Personal Items' if 'personal' in k else None)
        if name and name not in out:
            out.append(name)
    return out

CATS = {'heavy weapons': 'Heavy Weapon', 'heavy weapon': 'Heavy Weapon', 'thrown weapon': 'Thrown Weapon', 'thrown weapons': 'Thrown Weapon',
        'throwing weapon': 'Thrown Weapon', 'throw weapon': 'Thrown Weapon', 'chems': 'Chem', 'chem': 'Chem'}
def category(c):
    c = str(c).replace('*', '').strip()
    return CATS.get(c.lower(), c)

def item_idx(name, section):
    name = re.sub(r'^\*+\s*', '', name)
    c = [i for i in items_by_name.get(norm(name), []) if i not in hidden_items]
    if not c:
        return None
    pref = [i for i in c if ITEMS[i][0] == section]
    return (pref or c)[0]

wb = openpyxl.load_workbook(XLSX, data_only=True)
lists = []
for ws in wb.worksheets[1:]:
    rows = list(ws.iter_rows(values_only=True))
    i, cur = 0, None
    while i < len(rows):
        a = rows[i][0]
        if isinstance(a, str) and a.startswith('ТАБЛИЦА ЮНИТОВ'):
            cur = {'faction': ws.title, 'name': rows[i - 1][0], 'units': [], 'items': []}
            lists.append(cur)
            i += 2
            while i < len(rows) and rows[i][0] and not str(rows[i][0]).startswith(('*', 'ЭКИПИРОВКА')):
                u = rows[i]
                cur['units'].append({'n': u[0].strip(), 'u': unit_idx(u[0].strip()), 'a': allowed_sections(u[1]),
                                     'carry': u[2] or '', 'p': u[3]})
                i += 1
            continue
        if isinstance(a, str) and a.startswith('ЭКИПИРОВКА И УЛУЧШЕНИЯ') and cur is not None:
            i += 2
            while i < len(rows) and rows[i][0] and rows[i][2] is not None:
                r = rows[i]
                sec = SECTIONS.get(str(r[0]).strip().upper())
                cat = category(r[1])
                if sec and cat not in ('Perk', 'Leader', 'Heroic'):
                    cur['items'].append({'s': sec, 'c': cat, 'n': str(r[2]).strip(), 'i': item_idx(str(r[2]).strip(), sec), 'cost': r[3]})
                i += 1
            continue
        i += 1

for n, l in enumerate(lists):
    l['id'] = n
tot_u = sum(len(l['units']) for l in lists); ok_u = sum(1 for l in lists for u in l['units'] if u['u'] is not None)
tot_i = sum(len(l['items']) for l in lists); ok_i = sum(1 for l in lists for it in l['items'] if it['i'] is not None)
print('lists', len(lists), '| units mapped %d/%d | items mapped %d/%d' % (ok_u, tot_u, ok_i, tot_i))
print('unmapped units:', sorted({u['n'] for l in lists for u in l['units'] if u['u'] is None}))
json.dump({'lists': lists}, open(os.path.join(HERE, 'army_lists.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('size KB', os.path.getsize(os.path.join(HERE, 'army_lists.json')) // 1024)
