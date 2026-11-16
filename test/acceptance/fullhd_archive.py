"""Validate the Full HD image contract without printing book content."""
from PIL import ImageChops, ImageOps

RASTER_FORMATS = {'PNG', 'JPEG', 'WEBP', 'GIF', 'AVIF'}
RASTER_MIMES = {name: 'image/' + name.lower() for name in RASTER_FORMATS}


def display_size(image):
    return image.size[::-1] if image.getexif().get(274, 1) in (5, 6, 7, 8) else image.size


def full_hd_size(size):
    width, height = size
    bound_width, bound_height = (1920, 1080) if width >= height else (1080, 1920)
    scale = min(1, bound_width / width, bound_height / height)
    return (max(1, min(bound_width, int(width * scale + .5))),
            max(1, min(bound_height, int(height * scale + .5))))


def verify_full_hd_image(before, after):
    """Return whether this is a verified resize or same-size PNG conversion."""
    assert before.format in RASTER_FORMATS and after.format == 'WEBP'
    size = display_size(before)
    target = full_hd_size(size)
    assert display_size(after) == target
    frames = getattr(before, 'n_frames', 1)
    assert frames == getattr(after, 'n_frames', 1)
    if size == target:
        assert before.format == 'PNG' and frames == 1
        old_pixels = ImageOps.exif_transpose(before).convert('RGBA')
        new_pixels = ImageOps.exif_transpose(after).convert('RGBA')
        assert not ImageChops.difference(old_pixels, new_pixels).getbbox(alpha_only=False)
        return False
    return True
