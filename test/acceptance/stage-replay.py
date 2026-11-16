"""Copy only extension artifacts and private replay input into a temporary run directory."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import zipfile


def unpack_extension(archive, target):
    with zipfile.ZipFile(archive) as package:
        for entry in package.infolist():
            parts = PurePosixPath(entry.filename).parts
            if not parts or parts[0] not in ('manifest.json', 'exporter.html', 'src') or any(part in ('.', '..') or '\\' in part or ':' in part for part in parts):
                raise ValueError('Unexpected extension ZIP entry')
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Symlinks are not supported')
            dest = target.joinpath(*parts)
            if entry.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with package.open(entry) as source, dest.open('wb') as output:
                    shutil.copyfileobj(source, output, 1 << 20)


def main(source_zip, target, baseline, candidate=None):
    target = Path(target)
    builds = {'baseline': baseline, **({'candidate': candidate} if candidate else {})}
    for name, package in builds.items():
        unpack_extension(package, target / name)
    (target / 'replay-media').mkdir()
    with zipfile.ZipFile(source_zip) as source:
        manifest = json.loads(source.read('manifest.json'))
        inventory = manifest['inventory']
        fixture = {
            'source': manifest['source'],
            'collection': json.loads(source.read(manifest['reports']['collection'])),
            'snapshots': [json.loads(source.read(page['file'])) for page in inventory['pages']],
            'captures': [json.loads(source.read(response['file'])) for response in inventory['responses']],
            'warnings': manifest['completeness']['warnings'],
            'dropped': manifest['completeness']['droppedRecords'],
            'assets': [],
        }
        for index, asset in enumerate(inventory['assets']):
            entry = asset['file']
            if not entry or not entry.startswith('media/') or source.getinfo(entry).file_size != asset['size']:
                raise ValueError(f'Incomplete or inconsistent media entry {index}')
            name = f'{index}.bin'
            stored = target / 'replay-media' / name
            digest = hashlib.sha256()
            with source.open(entry) as raw, stored.open('wb') as output:
                while chunk := raw.read(1 << 20):
                    digest.update(chunk)
                    output.write(chunk)
            fixture['assets'].append({**{key: asset[key] for key in ('id', 'url', 'name', 'mimeType', 'size')}, 'sha256': digest.hexdigest()})
        for name in builds:
            (target / name / 'replay.json').write_text(json.dumps(fixture, ensure_ascii=False), encoding='utf-8')
    print(f'Replayed {len(fixture["snapshots"])} snapshots, {len(fixture["captures"])} captures, {len(fixture["assets"])} media entries.')


if __name__ == '__main__':
    main(*sys.argv[1:])
