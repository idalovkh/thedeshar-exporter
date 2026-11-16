#!/usr/bin/env python3
"""Compare browser-produced image archives through the same local API worker."""
import argparse
import collections
from decimal import Decimal
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import quote
import xml.etree.ElementTree as XML
import zipfile

sys.dont_write_bytecode = True
from PIL import Image, ImageChops
from dedup_archive import verify_dedup_archives
from fullhd_archive import RASTER_MIMES, display_size, full_hd_size, verify_full_hd_image
from strict_webp_archive import verify_strict_webp_archives

API = Path(__file__).resolve().parents[3] / 'thedeshar-api'
spec = importlib.util.spec_from_file_location('isolated_import_harness', API / 'scripts/import-reuse-acceptance.py')
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)

TOKEN = re.compile(r'media:sha256=([0-9a-f]{64});size=(\d+);mime=([A-Za-z0-9_.+-]+/[A-Za-z0-9_.+-]+)')
OBJECT = re.compile(r'objects/(images|audio|video|documents)/[0-9a-f-]{36}')


def token(sha, size, mime):
    return f'media:sha256={sha};size={size};mime={mime}'


def pair_strict_webp_archives(old, new, source):
    pairs, removed, stats = verify_strict_webp_archives(old, new, source)
    changes = [((token(*before[:3]), before[3]), (token(*after[:3]), after[3])) for before, after in pairs]
    print(json.dumps(stats), flush=True)
    return changes, removed, stats


def archive_hash(archive, entry):
    # A new encoding can have the same size and MIME as its source.
    digest = hashlib.sha256()
    with archive.open(entry) as source:
        for data in iter(lambda: source.read(1 << 20), b''):
            digest.update(data)
    return digest.hexdigest()


def check_unchanged_image(archive, path, mime):
    with archive.open(path) as stream:
        try:
            image = Image.open(stream)
        except Image.UnidentifiedImageError:
            if mime in RASTER_MIMES.values():
                raise RuntimeError('could not verify raster image dimensions')
            return
        with image:
            if image.format in RASTER_MIMES:
                size = display_size(image)
                if full_hd_size(size) != size:
                    raise RuntimeError('unchanged image exceeds Full HD')


def pair_archives(old, new, full_hd=False):
    changed = []
    checked = {}
    unchanged_checked = set()
    resized_entries = 0
    with zipfile.ZipFile(old) as a, zipfile.ZipFile(new) as b:
        old_manifest, new_manifest = [json.loads(z.read('manifest.json')) for z in (a, b)]
        left, right = [m['inventory']['assets'] for m in (old_manifest, new_manifest)]
        if len(left) != len(right):
            raise RuntimeError('asset inventory count differs')
        new_hashes = set()
        for index, (first, second) in enumerate(zip(left, right), 1):
            for key in ('id', 'url', 'status'):
                if first[key] != second[key]:
                    raise RuntimeError(f'asset {index}: original {key} differs')
            af, bf = first['file'], second['file']
            if not af or not bf:
                if af != bf or first != second:
                    raise RuntimeError(f'asset {index}: absent media differs')
                continue
            for archive, ref, expected_path in ((a, first, af), (b, second, bf)):
                entry = archive.getinfo(expected_path)
                if not expected_path.startswith('media/') or entry.file_size != ref['size'] or entry.compress_type != zipfile.ZIP_STORED:
                    raise RuntimeError(f'asset {index}: path, size or ZIP method invalid')
            before_sha, after_sha = archive_hash(a, af), archive_hash(b, bf)
            new_hashes.add(after_sha)
            if before_sha == after_sha:
                if first != second:
                    raise RuntimeError(f'asset {index}: unchanged asset metadata differs')
                if full_hd and before_sha not in unchanged_checked:
                    check_unchanged_image(b, bf, second['mimeType'])
                    unchanged_checked.add(before_sha)
                continue
            if second['mimeType'] != 'image/webp' or not 0 < second['size'] <= (100 << 20):
                raise RuntimeError(f'asset {index}: unapproved replacement format or size')
            if not bf.lower().endswith('.webp') or not second['name'].lower().endswith('.webp'):
                raise RuntimeError(f'asset {index}: WebP path or name missing extension')
            stable = set(first) | set(second)
            stable.difference_update(('file', 'name', 'mimeType', 'size'))
            if any(first.get(key) != second.get(key) for key in stable):
                raise RuntimeError(f'asset {index}: converted asset lost metadata')
            pair = (before_sha, after_sha)
            if pair not in checked:
                with a.open(af) as before, b.open(bf) as after, Image.open(before) as image, Image.open(after) as result:
                    source_mime = RASTER_MIMES.get(image.format)
                    if source_mime is None:
                        raise RuntimeError(f'asset {index}: unapproved source format')
                    if full_hd:
                        try:
                            resized = verify_full_hd_image(image, result)
                        except AssertionError as error:
                            raise RuntimeError(f'asset {index}: Full HD verification failed') from error
                    else:
                        resized = False
                        if image.format != 'PNG' or result.format != 'WEBP' or image.size != result.size:
                            raise RuntimeError(f'asset {index}: image format or dimensions differ')
                        if image.n_frames != 1 or result.n_frames != 1:
                            raise RuntimeError(f'asset {index}: unexpected animation')
                        if ImageChops.difference(image.convert('RGBA'), result.convert('RGBA')).getbbox(alpha_only=False):
                            raise RuntimeError(f'asset {index}: visible or transparent pixels differ')
                    if not resized and image.width * image.height > 12_000_000:
                        raise RuntimeError(f'asset {index}: converted image exceeds pixel budget')
                    checked[pair] = (source_mime, resized)
            source_mime, resized = checked[pair]
            if not resized and not ((1 << 20) <= first['size'] <= (24 << 20) and
                    second['size'] <= first['size'] - max(64 << 10, (first['size'] + 9) // 10)):
                raise RuntimeError(f'asset {index}: unapproved PNG saving')
            resized_entries += resized
            old_ref = token(before_sha, first['size'], source_mime)
            new_ref = token(after_sha, second['size'], 'image/webp')
            changed.append(((old_ref, first['name']), (new_ref, second['name'])))
        replaced_hashes = {TOKEN.fullmatch(ref).group(1) for (ref, _), _ in changed}
        removed = replaced_hashes - new_hashes
        archive_assets = len(left)
    if not changed:
        raise RuntimeError('new archive contains no converted media')
    resized_unique = sum(resized for _, resized in checked.values())
    pixel_comparisons = len(checked) - resized_unique
    print(f'Paired {archive_assets} archive media, {len(changed)} converted entries, '
          f'{resized_entries} resized entries, {resized_unique} unique resized images, '
          f'{pixel_comparisons} unique same-size pixel-equivalence comparisons.', flush=True)
    return changed, removed, dict(pixel_equivalence_comparisons=pixel_comparisons,
                                  resized_entries=resized_entries, resized_unique_images=resized_unique)


class Acceptance(harness.LocalComparison):
    def __init__(self, work, archives, forbidden_hashes):
        super().__init__(work, archives)
        self.forbidden_hashes = forbidden_hashes
        self.storage = {}
        self.storage_identities = {}
        # Only talk to the local published test MinIO port, never configured S3.
        self.s3_curl = ('user = ' + json.dumps(self.minio['MINIO_ROOT_USER'] + ':' + self.minio['MINIO_ROOT_PASSWORD'])
                        + '\naws-sigv4 = "aws:amz:us-east-1:s3"\n')

    def get_s3(self, url):
        result = subprocess.run(['curl', '--disable', '--silent', '--show-error', '--noproxy', '*',
                                 '--write-out', '\n%{http_code}', '--max-time', '20', '--config', '-',
                                 'http://127.0.0.1:9000/' + url],
                                input=self.s3_curl, text=True, capture_output=True, check=False)
        body, separator, status = result.stdout.rpartition('\n')
        if result.returncode or not separator or not re.fullmatch(r'\d{3}', status):
            raise RuntimeError('local MinIO request failed')
        return int(status), body

    def bucket_listing(self, bucket):
        keys, continuation = {}, ''
        while True:
            status, body = self.get_s3(bucket + '?list-type=2&prefix=objects%2F'
                                      + ('&continuation-token=' + quote(continuation, safe='') if continuation else ''))
            if status != 200:
                raise RuntimeError('local MinIO object listing failed')
            page = XML.fromstring(body)
            for entry in page.findall('{*}Contents'):
                key = entry.findtext('{*}Key')
                if not OBJECT.fullmatch(key or '') or key in keys:
                    raise RuntimeError('invalid or repeated key in isolated MinIO media listing')
                keys[key] = int(entry.findtext('{*}Size'))
            if page.findtext('{*}IsTruncated') != 'true':
                return keys
            continuation = page.findtext('{*}NextContinuationToken')
            if not continuation:
                raise RuntimeError('missing MinIO listing continuation token')

    def verify_storage(self, label, bucket, report):
        database = self.resources[label]
        sql = """select coalesce(json_agg(json_build_array(o.sha256,o.size,o.mime_type,o.state,
                    f.storage_key,f.actual_sha256,f.actual_size,f.integrity_status,f.state)),'[]')::text
                  from media.media_objects o left join media.media_files f
                  on o.current_storage_id=f.storage_id and o.id=f.object_id"""
        rows = json.loads(self.psql(sql, database))
        objects = {}
        identities = set()
        for sha, size, mime, state, key, actual_sha, actual_size, integrity, file_state in rows:
            if ((state, file_state, integrity) != ('ready', 'ready', 'verified') or
                    (sha, size) != (actual_sha, actual_size) or not OBJECT.fullmatch(key or '') or key in objects):
                raise RuntimeError('import did not keep a ready and verified current media object')
            identities.add((sha, size, mime))
            objects[key] = size
        if len(identities) != len(objects) or report['objects'] != len(objects):
            raise RuntimeError('media deduplication/registry count mismatch')
        if objects != self.bucket_listing(bucket):
            raise RuntimeError('MinIO media listing disagrees with verified media registry')
        if label == 'candidate' and any(sha in self.forbidden_hashes for sha, _, _ in identities):
            raise RuntimeError('an original image was stored separately despite its replacement in the archive')
        self.storage[label] = {
            'objects': len(objects), 'bytes': sum(objects.values()),
            'png_objects': sum(mime == 'image/png' for _, _, mime in identities),
            'webp_objects': sum(mime == 'image/webp' for _, _, mime in identities),
        }
        self.storage_identities[label] = identities
        print(f'{label}: verified {len(objects)} physical MinIO objects.', flush=True)

    def container(self, label, case, phase, bucket, repeat, jobs=None):
        result = super().container(label, case, phase, bucket, repeat, jobs)
        if phase == 'measure':
            self.verify_storage(label, bucket, harness.marker(result, 'IMPORT_REUSE_REAL'))
        elif phase == 'cleanup':
            status, body = self.get_s3(bucket + '?list-type=2')
            if status != 404 or XML.fromstring(body).findtext('{*}Code') != 'NoSuchBucket':
                raise RuntimeError('acceptance bucket was not removed')
        return result

    def cleanup(self):
        super().cleanup()
        for database in self.resources.values():
            if self.psql(f"select 1 from pg_database where datname='{database}'"):
                raise RuntimeError('acceptance database still present')
            if self.psql(f"select 1 from pg_roles where rolname='{database}_runtime'"):
                raise RuntimeError('acceptance runtime role still present')


def remap(old_value, mapping):
    if isinstance(old_value, str):
        return TOKEN.sub(lambda match: mapping.get(match.group(), match.group()), old_value)
    if isinstance(old_value, list):
        return [remap(value, mapping) for value in old_value]
    if isinstance(old_value, dict):
        updated = {remap(key, mapping): remap(value, mapping) for key, value in old_value.items()}
        if len(old_value) != len(updated):
            raise RuntimeError('media equivalence collapses an authored object key')
        return updated
    return old_value


def compare_structures(a, b, path='job'):
    if type(a) is not type(b):
        raise RuntimeError('semantic type differs at ' + path)
    if isinstance(a, list):
        if len(a) != len(b):
            raise RuntimeError('semantic count differs at ' + path)
        for index, (x, y) in enumerate(zip(a, b)):
            compare_structures(x, y, path + f'[{index}]')
    elif isinstance(a, dict):
        if a.keys() != b.keys():
            raise RuntimeError('semantic fields differ at ' + path)
        for key in a:
            # User-authored object keys may contain private values; only expose
            # safe structural labels in failure diagnostics.
            safe = key if re.fullmatch(r'[a-zA-Z_]{1,40}', key) else '<key>'
            compare_structures(a[key], b[key], path + '.' + safe)
    elif a != b:
        raise RuntimeError('semantic value differs at ' + path)


def compare_media_and_semantics(work, changed):
    old, new = [json.loads((work / f'{label}-new-1-semantic.json').read_text(), parse_float=Decimal)['jobs'][0]
                for label in ('baseline', 'candidate')]
    left, right = [collections.Counter((m['reference'], m['name']) for m in job.pop('media')) for job in (old, new)]
    verified = 0
    mapping = {}
    original = left.copy()
    for (before, after), amount in collections.Counter(changed).items():
        matches = min(original[before], amount)
        if matches:
            original[before] -= matches
            left[before] -= matches
            left[after] += matches
            source, target = before[0], after[0]
            if source in mapping and mapping[source] != target:
                raise RuntimeError('identical original content was not encoded deterministically')
            mapping[source] = target
            verified += matches
    if +left != +right:
        missing, unexpected = sum((left-right).values()), sum((right-left).values())
        raise RuntimeError(f'imported media inventory differs: missing={missing}, unexpected={unexpected}')
    # If an unchanged handle still points to the PNG, normalize both snapshots to
    # the proven-equivalent content identity. Keep original handle multiplicity and
    # all names covered by the stricter inventory comparison above.
    compare_structures(remap(old, mapping), remap(new, mapping))
    return {'verified_imported_replacements': verified, 'verified_replacement_objects': len(set(mapping.values())),
            'media_handles': old['media_count'], 'lessons': sum(len(m['lessons']) for m in old['materials']),
            'sections': sum(len(l['sections']) for m in old['materials'] for l in m['lessons']),
            'blocks': sum(len(s['blocks']) for m in old['materials'] for l in m['lessons'] for s in l['sections']),
            'ordered_content_equal': True, 'media_handles_equal_after_mapping': True}


def build_api_revision(directory, output, architecture):
    # Compile only committed API source so unrelated worktree edits cannot
    # influence the browser comparison or require a checkout.
    revision = harness.checked(['git', 'rev-parse', 'HEAD']).strip()
    archive = subprocess.run(['git', 'archive', revision], cwd=API, capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        members = tree.getmembers()
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError('unsafe API archive member')
        tree.extractall(directory, members=members)
    harness.checked(['go', 'test', '-buildvcs=false', '-c', '-o', str(output), './' + harness.HARNESS],
                    cwd=directory, env=dict(os.environ, GOOS='linux', GOARCH=architecture, CGO_ENABLED='0',
                                            GOCACHE='/tmp/thedeshar-go-cache'))
    output.chmod(0o755)
    return revision


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('output', type=Path, nargs='?', help='a new directory outside Git for local acceptance artifacts')
    parser.add_argument('--preflight-only', action='store_true', help='compare archive media without Docker or outputs')
    parser.add_argument('--source', type=Path, help='raw replay input when --strict-webp compares two exporter builds')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--full-hd', action='store_true', help='allow lossless WebP with Full HD resizing and verify the size limit')
    mode.add_argument('--dedup', action='store_true', help='verify media path aliases and identical imported content')
    mode.add_argument('--strict-webp', action='store_true', help='verify mandatory WebP and equivalent imported content')
    parser.add_argument('--baseline-origin', default='Baseline exporter ZIP', help='provenance label for the report')
    args = parser.parse_args()
    if args.source and not args.strict_webp:
        parser.error('--source requires --strict-webp')
    os.umask(0o077)
    archives = [source.resolve(strict=True) for source in (args.baseline, args.candidate)]
    if any(not source.is_file() for source in archives) or archives[0] == archives[1]:
        raise RuntimeError('requires two distinct ZIP files')
    if args.preflight_only:
        if args.dedup:
            print(json.dumps(verify_dedup_archives(*archives), indent=2), flush=True)
        else:
            _, forbidden, _ = (pair_strict_webp_archives(*archives, args.source) if args.strict_webp else
                               pair_archives(*archives, full_hd=args.full_hd))
            print(f'{len(forbidden)} original image object identities eliminated from candidate.', flush=True)
        return
    if args.output is None:
        parser.error('output is required unless --preflight-only is set')
    if sys.platform == 'darwin' and os.environ.get('THEDESHAR_WEBP_VERIFY_AWAKE') != '1':
        return subprocess.run(['caffeinate', '-i', sys.executable, *sys.argv],
                              env=dict(os.environ, THEDESHAR_WEBP_VERIFY_AWAKE='1'), check=False).returncode
    work = args.output.resolve()
    harness.require_outside_git(work)
    work.mkdir(mode=0o755)
    work.chmod(0o755)
    harness.LOG_DIRECTORY = work
    harness.require_local_docker()
    print('Acceptance artifacts: ' + str(work), flush=True)
    starting = [{'name': p.name, 'bytes': p.stat().st_size, 'sha256': harness.digest_file(p)} for p in archives]
    if args.dedup:
        changed, forbidden, verification = [], set(), verify_dedup_archives(*archives)
        print(json.dumps(verification), flush=True)
    elif args.strict_webp:
        changed, forbidden, verification = pair_strict_webp_archives(*archives, args.source)
    else:
        changed, forbidden, verification = pair_archives(*archives, full_hd=args.full_hd)
    comparison = None
    with tempfile.TemporaryDirectory(prefix='thedeshar-webp-import-inputs-') as staging:
        staged = harness.stage_archives(Path(staging), archives, starting)
        architecture = json.loads(harness.checked(['docker','info','--format','{{json .Architecture}}']))
        goarch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'amd64', 'amd64': 'amd64'}.get(architecture)
        if goarch is None:
            raise RuntimeError('unsupported local Docker architecture')
        binary = work / 'baseline.test'
        rev = build_api_revision(Path(staging) / 'api', binary, goarch)
        os.link(binary, work / 'candidate.test')
        try:
            comparison = Acceptance(work, [], forbidden)
            comparison.provision()
            comparison.clocks()
            for label, archive in zip(('baseline','candidate'), staged):
                comparison.archives = [archive]
                comparison.trial(label, 'new', 1)
            semantics = compare_media_and_semantics(work, changed)
            if args.dedup and (comparison.storage['baseline'] != comparison.storage['candidate'] or
                    comparison.storage_identities['baseline'] != comparison.storage_identities['candidate']):
                raise RuntimeError('verified media objects differ between the two imports')
            if args.dedup:
                verification['storage_identities_equal'] = True
            unchanged = all(harness.digest_file(source) == entry['sha256'] for source, entry in zip(archives, starting))
            if not unchanged:
                raise RuntimeError('an input archive changed')
            report = {'api_revision': rev, 'api_binary_sha256': harness.digest_file(binary),
                      'baseline_origin': args.baseline_origin,
                      'archive_sha256_verified_after_import': unchanged, 'archives': starting,
                      'archives_converted_entries': len(changed), **verification,
                      'original_image_objects_absent': len(forbidden),
                      'storage': comparison.storage, **semantics,
                      'worker_runs': comparison.reports}
            report['storage_bytes_saved'] = report['storage']['baseline']['bytes'] - report['storage']['candidate']['bytes']
        finally:
            if comparison is not None:
                comparison.cleanup()
    report['cleanup_verified'] = True
    harness.write_json(work / 'report.json', report)
    print('Report: ' + str(work / 'report.json'), flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, OSError, AssertionError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
