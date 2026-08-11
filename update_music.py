"""
Rebuilds the MUSIC_TRACKS list in index.html from whatever files are currently in music/.

Run this after adding/removing songs from the music/ folder:
    python update_music.py

No install needed — standard library only.
"""
import json
import os
import re
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MUSIC_DIR = os.path.join(BASE_DIR, 'music')
INDEX_PATH = os.path.join(BASE_DIR, 'index.html')
AUDIO_EXTS = ('.mp3', '.ogg', '.wav', '.m4a')
PATTERN = re.compile(r'const MUSIC_TRACKS = \[.*?\];', re.DOTALL)


def main():
    if not os.path.isdir(MUSIC_DIR):
        print(f'Music folder not found: {MUSIC_DIR}')
        return

    files = sorted(
        (f for f in os.listdir(MUSIC_DIR) if f.lower().endswith(AUDIO_EXTS)),
        key=lambda s: s.lower(),
    )
    if not files:
        print(f'No audio files ({", ".join(AUDIO_EXTS)}) found in {MUSIC_DIR}')
        return

    tracks = [{'file': f, 'title': os.path.splitext(f)[0]} for f in files]
    new_decl = 'const MUSIC_TRACKS = ' + json.dumps(tracks, ensure_ascii=False) + ';'

    with open(INDEX_PATH, encoding='utf-8') as f:
        content = f.read()

    if not PATTERN.search(content):
        print('Could not find "const MUSIC_TRACKS = [...];" in index.html — nothing changed.')
        return

    new_content, n = PATTERN.subn(new_decl, content, count=1)
    if new_content == content:
        print(f'{len(tracks)} tracks found — index.html already up to date, nothing to write.')
        return

    with open(INDEX_PATH, 'w', encoding='utf-8') as f:
        f.write(new_content)

    print(f'Updated index.html with {len(tracks)} tracks:')
    for t in tracks:
        print(f'  - {t["title"]}')


if __name__ == '__main__':
    main()
