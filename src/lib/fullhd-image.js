import { createAnimatedWebp } from './animated-webp.js';

export const MAX_RASTER_BYTES = 100 * 1024 * 1024;
// A 64 MP RGBA decode occupies 256 MB before the target canvas and codec.
const MAX_SOURCE_PIXELS = 64_000_000;
const MAX_SOURCE_EDGE = 16_384;

export function imagePreparationError(reason) {
  const messages = {
    image_dimensions_invalid: 'Получены некорректные размеры или структура изображения.',
    invalid_png: 'Получен повреждённый PNG-файл.',
    image_dimensions_unverified: 'Не удалось проверить разрешение изображения для Full HD.',
    image_dimensions_limit: 'Изображение слишком большое для безопасного уменьшения до Full HD.',
    image_webp_failed: 'Не удалось подготовить изображение в формате WebP.',
    image_webp_timeout: 'Не удалось подготовить WebP за отведённое время.',
  };
  return Object.assign(new Error(messages[reason]), { reason });
}

export function fullHdSize(width, height) {
  const landscape = width >= height;
  const maxWidth = landscape ? 1920 : 1080;
  const maxHeight = landscape ? 1080 : 1920;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return [Math.max(1, Math.min(maxWidth, Math.round(width * scale))),
    Math.max(1, Math.min(maxHeight, Math.round(height * scale)))];
}

export function checkDecodeSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw imagePreparationError('image_dimensions_unverified');
  }
  if (width > MAX_SOURCE_EDGE || height > MAX_SOURCE_EDGE || width * height > MAX_SOURCE_PIXELS) {
    throw imagePreparationError('image_dimensions_limit');
  }
}

// EXIF 2–8 transforms the unrotated target canvas into display orientation.
function orientationTransform(orientation, width, height) {
  return [
    [1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, width, 0],
    [-1, 0, 0, -1, width, height], [1, 0, 0, -1, 0, height],
    [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, width, 0],
    [0, -1, -1, 0, width, height], [0, -1, 1, 0, 0, height],
  ][orientation - 1];
}

export async function resizeRasterImage(blob, metadata, width, height, encodeRGBA, onProgress) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  if (!context) throw imagePreparationError('image_webp_failed');
  context.globalCompositeOperation = 'copy';
  context.imageSmoothingQuality = 'high';
  function encode(source, displayWidth, displayHeight, orientation = 1) {
    checkDecodeSize(displayWidth, displayHeight);
    const swapped = orientation >= 5;
    if (swapped) [displayWidth, displayHeight] = [displayHeight, displayWidth];
    const [expectedWidth, expectedHeight] = fullHdSize(displayWidth, displayHeight);
    if (expectedWidth !== width || expectedHeight !== height) {
      throw imagePreparationError('image_dimensions_unverified');
    }
    context.setTransform(...orientationTransform(orientation, width, height));
    context.drawImage(source, 0, 0, swapped ? height : width, swapped ? width : height);
    const webp = encodeRGBA(context.getImageData(0, 0, width, height).data, width, height);
    if (!webp?.byteLength || webp.byteLength > MAX_RASTER_BYTES) {
      throw imagePreparationError('image_webp_failed');
    }
    return webp;
  }

  if (!metadata.animated) {
    const { orientationChunk } = metadata;
    // PNG EXIF handling differs between Chrome releases. Apply it explicitly
    // using a decode-only view without the orientation chunk.
    const source = orientationChunk
      ? new Blob([blob.slice(0, orientationChunk[0]), blob.slice(orientationChunk[1])], { type: metadata.mimeType })
      : blob;
    const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    try {
      // Chromium's WebP decoder leaves EXIF orientation unapplied.
      const decodedUnrotated = bitmap.width === metadata.width && bitmap.height === metadata.height;
      const orientation = orientationChunk || (metadata.mimeType === 'image/webp' && decodedUnrotated) ? metadata.orientation : 1;
      return new Blob([encode(bitmap, bitmap.width, bitmap.height, orientation)], { type: 'image/webp' });
    } finally {
      bitmap.close();
    }
  }

  const decoder = new ImageDecoder({ data: blob.stream(), type: metadata.mimeType, preferAnimation: true });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    if (!Number.isSafeInteger(track?.frameCount) || track.frameCount < 1 ||
        (metadata.frameCount !== undefined && track.frameCount !== metadata.frameCount) ||
        (!track.animated && (track.frameCount !== 1 || metadata.frameCount !== 1))) {
      throw imagePreparationError('image_webp_failed');
    }
    if (!track.animated) {
      const { image, complete } = await decoder.decode({ frameIndex: 0 });
      try {
        if (!complete) throw imagePreparationError('image_webp_failed');
        checkDecodeSize(image.codedWidth, image.codedHeight);
        const orientation = image.rotation || image.flip ? 1 : metadata.orientation;
        return new Blob([encode(image, image.displayWidth, image.displayHeight, orientation)], { type: 'image/webp' });
      } finally {
        image.close();
      }
    }
    const animation = createAnimatedWebp(width, height, track.repetitionCount, { maxBytes: MAX_RASTER_BYTES });
    for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
      const { image, complete } = await decoder.decode({ frameIndex });
      try {
        if (!complete || image.duration == null) throw imagePreparationError('image_webp_failed');
        checkDecodeSize(image.codedWidth, image.codedHeight);
        // Older Chrome frames and some animated decoders leave EXIF unapplied.
        const orientation = image.rotation || image.flip ? 1 : metadata.orientation;
        animation.addFrame(encode(image, image.displayWidth, image.displayHeight, orientation), image.duration);
      } finally {
        image.close();
      }
      onProgress?.();
    }
    return animation.finish();
  } finally {
    decoder.close();
  }
}
