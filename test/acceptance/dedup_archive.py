"""Verify a legacy export and its media-deduplicated counterpart."""
import hashlib
import json
from pathlib import Path
import zipfile


def read_entry(archive, entry):
    digest = hashlib.sha256()
    # Reading through EOF also checks the entry CRC against the ZIP directory.
    with archive.open(entry) as source:
        for data in iter(lambda: source.read(1 << 20), b''):
            digest.update(data)
    return digest.hexdigest()


def entry_names(archive):
    names = set(archive.namelist())
    if len(names) != len(archive.infolist()):
        raise RuntimeError('ZIP has repeated entry names')
    if any(entry.compress_type != zipfile.ZIP_STORED for entry in archive.infolist()):
        raise RuntimeError('ZIP entries must use Store')
    return names


def media_identity(archive, path, size):
    if not path.startswith('media/') or not 0 < size <= (100 << 20):
        raise RuntimeError('invalid path or size for a media reference')
    entry = archive.getinfo(path)
    if entry.file_size != size:
        raise RuntimeError('media size differs from expected')
    return read_entry(archive, entry), size


def verify_dedup_archives(baseline, candidate):
    baseline_bytes = Path(baseline).stat().st_size
    candidate_bytes = Path(candidate).stat().st_size
    if not 0 < candidate_bytes < baseline_bytes <= 4_000_000_000:
        raise RuntimeError('expected a smaller candidate within the ZIP32 export limit')
    with zipfile.ZipFile(baseline) as old, zipfile.ZipFile(candidate) as new:
        old_names, new_names = entry_names(old), entry_names(new)
        old_media = {name for name in old_names if name.startswith('media/')}
        new_media = {name for name in new_names if name.startswith('media/')}
        old_metadata = old_names - old_media - {'manifest.json'}
        new_metadata = new_names - new_media - {'manifest.json'}
        if old_metadata != new_metadata:
            raise RuntimeError('non-media ZIP entries differ')
        for name in sorted(old_metadata):
            if read_entry(old, name) != read_entry(new, name):
                raise RuntimeError('non-media ZIP content differs')

        manifests = [json.loads(archive.read('manifest.json')) for archive in (old, new)]
        left, right = [manifest['inventory'].pop('assets') for manifest in manifests]
        for manifest in manifests:
            manifest.pop('exportedAt', None)
        if manifests[0] != manifests[1] or len(left) != len(right):
            raise RuntimeError('manifest metadata or logical inventory count differs')

        canonical = {}
        verified_old = set()
        verified_new = {}
        for index, (before, after) in enumerate(zip(left, right), 1):
            source, target = before.get('file'), after.get('file')
            if {**before, 'file': target} != after:
                raise RuntimeError(f'asset {index}: logical metadata differs')
            if not source or not target:
                if source != target:
                    raise RuntimeError(f'asset {index}: media presence differs')
                continue
            if source in verified_old:
                raise RuntimeError(f'asset {index}: baseline is not a legacy one-entry-per-reference archive')
            verified_old.add(source)
            identity = media_identity(old, source, before['size'])
            first_path = canonical.setdefault(identity, source)
            if target != first_path:
                raise RuntimeError(f'asset {index}: media path differs from the first matching reference')
            if target not in verified_new:
                verified_new[target] = media_identity(new, target, after['size'])
            if verified_new[target] != identity:
                raise RuntimeError(f'asset {index}: media content differs')

        if verified_old != old_media or verified_new.keys() != new_media:
            raise RuntimeError('ZIP has unreferenced media entries')
        removed = len(old_media) - len(new_media)
        if removed <= 0 or len(new_media) != len(canonical):
            raise RuntimeError('candidate media entries are not deduplicated')
        if [name for name in new.namelist() if name in new_media] != list(canonical.values()):
            raise RuntimeError('candidate ZIP media entries are out of manifest order')
        return {
            'logical_media': len(left),
            'baseline_media_entries': len(old_media),
            'candidate_media_entries': len(new_media),
            'removed_media_entries': removed,
            'archive_bytes_saved': baseline_bytes - candidate_bytes,
            'verified_media_references': len(verified_old),
        }
