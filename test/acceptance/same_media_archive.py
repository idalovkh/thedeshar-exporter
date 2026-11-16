"""Verify an export optimization that preserves every logical and physical file."""
import json
from pathlib import Path
import zipfile

from dedup_archive import entry_names, read_entry


def verify_same_media_archives(baseline, candidate):
    size = Path(baseline).stat().st_size
    if not 0 < size <= 4_000_000_000 or Path(candidate).stat().st_size != size:
        raise RuntimeError('expected archives of the same size within the ZIP32 export limit')

    with zipfile.ZipFile(baseline) as old, zipfile.ZipFile(candidate) as new:
        names = entry_names(old)
        if names != entry_names(new) or old.namelist() != new.namelist():
            raise RuntimeError('ZIP entry names or order differ')

        manifests = [json.loads(archive.read('manifest.json')) for archive in (old, new)]
        for manifest in manifests:
            manifest.pop('exportedAt', None)
        if manifests[0] != manifests[1]:
            raise RuntimeError('manifest or logical inventory differs')

        assets = manifests[0]['inventory']['assets']
        media_paths = set()
        for index, asset in enumerate(assets, 1):
            path = asset['file']
            if not isinstance(path, str) or not path.startswith('media/') or path not in names:
                raise RuntimeError(f'asset {index}: missing media entry')
            if old.getinfo(path).file_size != asset['size'] or not 0 < asset['size'] <= (100 << 20):
                raise RuntimeError(f'asset {index}: media size differs from manifest')
            media_paths.add(path)
        if media_paths != {path for path in names if path.startswith('media/')}:
            raise RuntimeError('ZIP has unreferenced media entries')

        # read_entry reads the full body, so Python's ZIP reader also checks its CRC.
        for path in names - {'manifest.json'}:
            before, after = old.getinfo(path), new.getinfo(path)
            if (before.file_size != after.file_size or before.CRC != after.CRC or
                    read_entry(old, before) != read_entry(new, after)):
                raise RuntimeError('ZIP entry size, CRC, or SHA-256 differs')

    return {'logical_media': len(assets), 'physical_media': len(media_paths),
            'zip_entries': len(names), 'archive_bytes': size}
