"""Compare a real exported book with its replay without logging its contents."""
import hashlib
import json
import argparse
import sys
import zipfile
from collections import Counter


def sha(archive, entry):
    digest = hashlib.sha256()
    with archive.open(entry) as stream:
        while data := stream.read(1 << 20):
            digest.update(data)
    return digest.hexdigest()


def verify(original, optimized, full_hd=False):
    from PIL import Image, UnidentifiedImageError
    from fullhd_archive import RASTER_FORMATS, RASTER_MIMES, display_size, full_hd_size, verify_full_hd_image

    counts = Counter()
    checked = set()
    checked_dimensions = set()
    with zipfile.ZipFile(original) as old, zipfile.ZipFile(optimized) as new:
        old_manifest = json.loads(old.read('manifest.json'))
        new_manifest = json.loads(new.read('manifest.json'))
        new_entries = set(new.namelist())
        old_inventory = old_manifest['inventory']
        new_inventory = new_manifest['inventory']
        assert len(old_inventory['assets']) == len(new_inventory['assets'])
        for field in ('pages', 'responses'):
            assert len(old_inventory[field]) == len(new_inventory[field])
            for old_entry, new_entry in zip(old_inventory[field], new_inventory[field]):
                assert json.loads(old.read(old_entry['file'])) == json.loads(new.read(new_entry['file']))
        for left, right in zip(old_inventory['assets'], new_inventory['assets']):
            assert left['id'] == right['id'] and left['url'] == right['url']
            entry, replacement = left['file'], right['file']
            assert old.getinfo(entry).file_size == left['size'] and new.getinfo(replacement).file_size == right['size']
            assert new.getinfo(replacement).compress_type == zipfile.ZIP_STORED
            hashes = (sha(old, entry), sha(new, replacement))
            if full_hd and hashes[1] not in checked_dimensions:
                with new.open(replacement) as stream:
                    try:
                        with Image.open(stream) as image:
                            if image.format in RASTER_FORMATS:
                                size = display_size(image)
                                assert size == full_hd_size(size), 'Raster exceeds Full HD'
                                counts['unique_full_hd_images'] += 1
                    except UnidentifiedImageError:
                        assert right['mimeType'] not in RASTER_MIMES.values()
                checked_dimensions.add(hashes[1])
            if hashes[0] == hashes[1]:
                counts['unchanged'] += 1
                assert left['name'] == right['name'] and left['mimeType'] == right['mimeType']
                continue
            assert right['mimeType'] == 'image/webp' and right['file'].lower().endswith('.webp')
            if entry != replacement:
                assert entry not in new_entries
            if not full_hd:
                assert left['size'] - right['size'] >= max(64 << 10, (left['size'] + 9) // 10)
            counts['converted'] += 1
            counts['saved_media_bytes'] += left['size'] - right['size']
            if hashes in checked:
                continue
            with old.open(entry) as before, new.open(replacement) as after:
                with Image.open(before) as png, Image.open(after) as webp:
                    if full_hd:
                        resized = verify_full_hd_image(png, webp)
                        if not resized:
                            assert left['size'] - right['size'] >= max(64 << 10, (left['size'] + 9) // 10)
                        counts['unique_resized' if resized else 'unique_exact_png'] += 1
                        checked.add(hashes)
                        continue
                    assert png.format == 'PNG' and webp.format == 'WEBP'
                    assert png.size == webp.size and png.n_frames == webp.n_frames == 1
                    width, height = png.size
                    for y in range(0, height, 128):
                        rect = (0, y, width, min(height, y + 128))
                        assert png.crop(rect).convert('RGBA').tobytes() == webp.crop(rect).convert('RGBA').tobytes()
            checked.add(hashes)
        counts['unique_verified'] = len(checked)
        assert counts['converted'] > 0
        assert len({name for name in new_entries if name.startswith('media/')}) == len(new_inventory['assets'])
    return dict(counts)


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('original')
    parser.add_argument('optimized')
    parser.add_argument('--source', help='raw replay input when --strict-webp compares two exporter builds')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--full-hd', action='store_true')
    mode.add_argument('--dedup', action='store_true')
    mode.add_argument('--same-media', action='store_true')
    mode.add_argument('--strict-webp', action='store_true')
    args = parser.parse_args()
    if args.source and not args.strict_webp:
        parser.error('--source requires --strict-webp')
    if args.dedup:
        from dedup_archive import verify_dedup_archives
        report = verify_dedup_archives(args.original, args.optimized)
    elif args.same_media:
        from same_media_archive import verify_same_media_archives
        report = verify_same_media_archives(args.original, args.optimized)
    elif args.strict_webp:
        from strict_webp_archive import verify_strict_webp_archives
        _, _, report = verify_strict_webp_archives(args.original, args.optimized, args.source)
    else:
        report = verify(args.original, args.optimized, args.full_hd)
    print(json.dumps(report, indent=2))
