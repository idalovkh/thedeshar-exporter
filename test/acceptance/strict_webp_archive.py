"""Verify mandatory WebP output and pair media identities for import comparison."""
from collections import Counter
from contextlib import ExitStack
import json
import math
from pathlib import Path
import struct
import zipfile

from PIL import Image

from dedup_archive import entry_names, media_identity, read_entry
from fullhd_archive import RASTER_MIMES, display_size, full_hd_size


def raster_format(archive, path):
    with archive.open(path) as source:
        prefix = source.read(32)
        if prefix.startswith(b'\x89PNG\r\n\x1a\n'):
            return 'PNG'
        if prefix.startswith(b'\xff\xd8\xff'):
            return 'JPEG'
        if prefix.startswith((b'GIF87a', b'GIF89a')):
            return 'GIF'
        if prefix[:4] == b'RIFF' and prefix[8:12] == b'WEBP':
            return 'WEBP'
        if prefix[4:8] == b'ftyp':
            size, = struct.unpack('>I', prefix[:4])
            start = 16 if size == 1 else 8
            if size == 1 and len(prefix) >= 16:
                size, = struct.unpack('>Q', prefix[8:16])
            if start + 8 <= size <= min(archive.getinfo(path).file_size, 1 << 20):
                source.seek(0)
                ftyp = source.read(size)
                brands = [ftyp[start:start + 4], *(ftyp[i:i + 4] for i in range(start + 8, size, 4))]
                if b'avif' in brands or b'avis' in brands:
                    return 'AVIF'
    return None


def animation_loops(image):
    count = image.info.get('loop')
    if image.format == 'GIF':
        return 1 if count is None else count + 1 if count else 0
    return count


def require_lossless_webp(archive, path, frame_count):
    with archive.open(path) as source:
        header = source.read(12)
        assert int.from_bytes(header[4:8], 'little') + 8 == archive.getinfo(path).file_size
        chunks = Counter()
        while chunk := source.read(8):
            assert len(chunk) == 8
            name = chunk[:4]
            size = int.from_bytes(chunk[4:], 'little')
            end = source.tell() + size + (size & 1)
            assert end <= archive.getinfo(path).file_size
            chunks[name] += 1
            if name == b'ANMF':
                # The exporter stores one VP8L subchunk per full-canvas frame.
                assert size >= 24
                source.read(16)
                payload = source.read(8)
                subsize = int.from_bytes(payload[4:], 'little')
                assert payload[:4] == b'VP8L' and 24 + subsize + (subsize & 1) == size
            source.seek(end)
        assert not chunks[b'VP8 '] and not chunks[b'ALPH']
        if chunks[b'ANMF']:
            assert chunks[b'ANMF'] == frame_count and not chunks[b'VP8L']
        else:
            assert frame_count == chunks[b'VP8L'] == 1


def verify_raster(inputs, source, new, target, source_format, same_bytes):
    with inputs.open(source) as before, new.open(target) as after:
        with Image.open(before) as original, Image.open(after) as result:
            assert original.format == source_format and result.format == 'WEBP'
            size = display_size(original)
            expected = full_hd_size(size)
            assert display_size(result) == expected, 'oriented dimensions differ'
            first_frame = int(bool(original.info.get('default_image')))
            frames = getattr(original, 'n_frames', 1) - first_frame
            assert frames == getattr(result, 'n_frames', 1), 'frame count differs'
            if frames > 1 and (loops := animation_loops(original)) is not None:
                assert animation_loops(result) == loops, 'loop count differs'
            input_elapsed = output_elapsed = 0
            for frame in range(frames):
                result.seek(frame)
                result.load()
                if frames > 1:
                    original.seek(frame + first_frame)
                    original.load()
                    input_elapsed += original.info['duration']
                    output_elapsed += result.info['duration']
                    assert math.floor(input_elapsed + .5) == output_elapsed, 'frame timing differs'
            if source_format == 'WEBP' and size == expected:
                assert same_bytes, 'existing WebP was re-encoded'
            else:
                assert not same_bytes, 'raster image was not converted'
                require_lossless_webp(new, target, frames)
            return size != expected


def compare_manifest(old, new):
    manifests = [json.loads(archive.read('manifest.json')) for archive in (old, new)]
    left, right = [manifest['inventory'].pop('assets') for manifest in manifests]
    for manifest in manifests:
        manifest.pop('exportedAt', None)
    if manifests[0] != manifests[1] or len(left) != len(right):
        raise RuntimeError('manifest metadata or logical inventory count differs')
    return left, right


def asset_body(archive, asset, bodies):
    path, size = asset['file'], asset['size']
    if path not in bodies:
        bodies[path] = (*media_identity(archive, path, size), raster_format(archive, path))
    if bodies[path][1] != size:
        raise RuntimeError('media size differs from manifest')
    return bodies[path]


def replay_inputs(inputs, baseline_assets):
    assets = json.loads(inputs.read('manifest.json'))['inventory']['assets']
    if [(a['id'], a['url']) for a in assets] != [(a['id'], a['url']) for a in baseline_assets]:
        raise RuntimeError('replay source inventory differs from baseline')
    return assets


def verify_strict_webp_archives(baseline, candidate, replay_source=None):
    """Return proven per-reference replacements, removed hashes and statistics."""
    sizes = [Path(path).stat().st_size for path in (baseline, candidate)]
    if any(not 0 < size <= 4_000_000_000 for size in sizes):
        raise RuntimeError('archive exceeds the ZIP32 export limit')

    changes = []
    counts = Counter()
    checked_images = {}
    with ExitStack() as stack:
        old, new = [stack.enter_context(zipfile.ZipFile(path)) for path in (baseline, candidate)]
        inputs = stack.enter_context(zipfile.ZipFile(replay_source)) if replay_source else old
        names = [entry_names(archive) for archive in (old, new)]
        old_media, new_media = [{name for name in entries if name.startswith('media/')} for entries in names]
        old_metadata, new_metadata = [entries - media - {'manifest.json'} for entries, media in zip(names, (old_media, new_media))]
        if old_metadata != new_metadata or any(read_entry(old, name) != read_entry(new, name) for name in sorted(old_metadata)):
            raise RuntimeError('non-media ZIP entries differ')

        left, right = compare_manifest(old, new)
        old_bodies, new_bodies = {}, {}
        original_bodies = {} if replay_source else old_bodies
        originals = replay_inputs(inputs, left) if replay_source else left
        canonical = {}
        for index, (original, before, after) in enumerate(zip(originals, left, right), 1):
            source, target = before.get('file'), after.get('file')
            if not source or not target:
                if before != after:
                    raise RuntimeError(f'asset {index}: absent media differs')
                continue

            before_hash, before_size, before_format = asset_body(old, before, old_bodies)
            after_hash, after_size, after_format = asset_body(new, after, new_bodies)
            input_hash, input_size, input_format = asset_body(inputs, original, original_bodies)
            if target != canonical.setdefault((after_hash, after_size), f'media/{index:05d}-{after["name"]}'):
                raise RuntimeError(f'asset {index}: media path differs from first matching reference')

            unchanged = (before_hash, before_size) == (after_hash, after_size)
            unchanged_input = (input_hash, input_size) == (after_hash, after_size)
            if not input_format:
                if not unchanged or not unchanged_input or after_format or {**before, 'file': target} != after:
                    raise RuntimeError(f'asset {index}: non-raster content or metadata differs')
                counts['unchanged_non_raster_references'] += 1
                continue

            if (not before_format or after_format != 'WEBP' or after['mimeType'] != 'image/webp' or
                    not target.endswith('.webp') or not after['name'].endswith('.webp')):
                raise RuntimeError(f'asset {index}: raster image is not WebP by content, MIME, and extension')
            changed_fields = {'file', 'name', 'mimeType', 'size'}
            if {k: v for k, v in before.items() if k not in changed_fields} != {
                    k: v for k, v in after.items() if k not in changed_fields}:
                raise RuntimeError(f'asset {index}: raster reference changed')

            pair = (input_hash, after_hash)
            if pair not in checked_images:
                try:
                    checked_images[pair] = verify_raster(
                        inputs, original['file'], new, target, input_format, unchanged_input,
                    )
                except (AssertionError, OSError) as error:
                    raise RuntimeError(f'asset {index}: raster verification failed ({error})') from error
            counts['webp_references'] += 1
            counts['resized_entries'] += checked_images[pair]
            counts['converted_references'] += not unchanged
            counts['preserved_webp_references'] += unchanged_input
            if not unchanged or before['name'] != after['name']:
                changes.append((
                    (before_hash, before_size, RASTER_MIMES[before_format], before['name']),
                    (after_hash, after_size, 'image/webp', after['name']),
                ))

        if old_bodies.keys() != old_media or new_bodies.keys() != new_media:
            raise RuntimeError('ZIP has unreferenced media entries')
        if [name for name in new.namelist() if name in new_media] != list(canonical.values()):
            raise RuntimeError('candidate ZIP media entries are out of manifest order')

    removed = {before[0] for before, _ in changes} - {sha for sha, _, _ in new_bodies.values()}
    return changes, removed, {
        **counts,
        'logical_media': len(left),
        'baseline_media_entries': len(old_media),
        'candidate_media_entries': len(new_media),
        'unique_webp_entries': sum(kind == 'WEBP' for _, _, kind in new_bodies.values()),
        'resized_unique_images': sum(checked_images.values()),
        'archive_bytes_saved': sizes[0] - sizes[1],
    }
