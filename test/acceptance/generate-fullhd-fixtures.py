"""Create synthetic raster fixtures for fullhd-chrome.mjs (Pillow 11+)."""

import sys
from pathlib import Path
from random import Random
from struct import pack

from PIL import Image, ImageDraw


def create_frames():
    colors = [(232, 51, 23, 255), (40, 78, 229, 255), (18, 201, 74, 127)]
    frames = []
    for index, color in enumerate(colors):
        image = Image.new("RGBA", (1921, 560))
        draw = ImageDraw.Draw(image)
        draw.rectangle((index * 450, 50, 900 + index * 450, 510), fill=color)
        frames.append(image)
    return frames


def main(directory):
    directory.mkdir(exist_ok=True)
    frames = create_frames()
    duration = [90, 140, 210]
    for extension, format_name, options in [
        ("png", "PNG", {"blend": [0, 0, 0], "disposal": [0, 0, 0]}),
        ("gif", "GIF", {"disposal": [2, 2, 2]}),
        ("webp", "WEBP", {"lossless": True, "exact": True}),
        ("avif", "AVIF", {"quality": 100, "speed": 8, "max_threads": 1, "subsampling": "4:4:4"}),
    ]:
        frames[0].save(directory / f"animated.{extension}", format_name, save_all=True,
                       append_images=frames[1:], loop=2, duration=duration, **options)
    frames[0].save(directory / "infinite.gif", "GIF", save_all=True, append_images=frames[1:],
                   loop=0, duration=duration, disposal=[2, 2, 2])
    frames[0].save(directory / "once.gif", "GIF", save_all=True, append_images=frames[1:],
                   duration=duration, disposal=[2, 2, 2])

    oriented = Image.new("RGB", (2200, 1100), "red")
    ImageDraw.Draw(oriented).rectangle((0, 550, 2199, 1099), fill="blue")
    exif = oriented.getexif()
    exif[274] = 6
    oriented.save(directory / "portrait.jpg", exif=exif)
    oriented.save(directory / "portrait.png", exif=exif)
    oriented.save(directory / "portrait-still.webp", exif=exif, lossless=True, exact=True)
    frames[0].save(directory / "portrait.webp", "WEBP", save_all=True, append_images=frames[1:],
                   loop=2, duration=duration, lossless=True, exact=True, exif=exif)
    frames[0].save(directory / "portrait-animated.png", "PNG", save_all=True, append_images=frames[1:],
                   loop=2, duration=duration, blend=[0, 0, 0], disposal=[0, 0, 0], exif=exif)
    oriented.save(directory / "portrait.avif", exif=exif, quality=100, speed=8, max_threads=1)
    Image.new("RGB", (1920, 1080), "black").save(directory / "boundary.jpg")

    random = Random(1234)
    photo = Image.frombytes("RGB", (31, 29), bytes(random.getrandbits(8) for _ in range(31 * 29 * 3)))
    photo.save(directory / "small.jpg", quality=10)
    photo.save(directory / "small.avif", quality=60, speed=8, max_threads=1)
    photo.save(directory / "existing.webp", lossless=False, quality=60)
    samples = [round(index * 65535 / 159) for index in range(160)]
    Image.frombytes("I;16", (16, 10), pack("<160H", *samples)).save(directory / "depth-16.png")
    small_frames = [frame.resize((96, 28), Image.Resampling.NEAREST) for frame in frames]
    small_frames[-1].save(directory / "small-transparent.png")
    small_frames[0].save(directory / "small-animated.gif", save_all=True, append_images=small_frames[1:],
                         duration=duration, loop=3, disposal=[2, 2, 2])


if __name__ == "__main__":
    main(Path(sys.argv[1]))
