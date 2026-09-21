"""Regenerates live-card/data/icon_index.json — the list of icons the custom-unit editor offers in its
"[[значок]]" picker. A static site can't list a folder, so run this again after adding icons:

    python live-card/build_icon_index.py
"""
import json, os, re
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, 'icons')
DATA = os.path.join(HERE, 'data')

# every icon usable in a [[tag]] = a .png under icons/ (path without extension, "/"-separated)
codes = []
for root, _, files in os.walk(ICONS):
    for f in files:
        if f.lower().endswith('.png'):
            rel = os.path.relpath(os.path.join(root, f), ICONS).replace(os.sep, '/')
            codes.append(rel[:-4])
codes.sort()

# how often each icon is already used inside the official cards' text -> the "common" block
tag = re.compile(r'\[\[([^\]|]+)(?:\|[^\]]*)?\]\]')
uses = Counter()
for name in ('fww_unit_templates.json', 'fww_equipment.json'):
    with open(os.path.join(DATA, name), encoding='utf-8') as fh:
        for m in tag.finditer(fh.read()):
            uses[m.group(1).lstrip('/')] += 1
known = set(codes)
common = [c for c, _ in uses.most_common() if c in known][:40]

with open(os.path.join(DATA, 'icon_index.json'), 'w', encoding='utf-8') as fh:
    json.dump({'icons': codes, 'common': common}, fh, ensure_ascii=False, indent=1)
print(f'{len(codes)} icons, {len(common)} common -> data/icon_index.json')
