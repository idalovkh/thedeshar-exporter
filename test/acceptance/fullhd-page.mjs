const directory = new URL('./fixtures/', location.href);
const worker = new Worker(new URL('./src/lib/webp-worker.js', location.href), { type: 'module' });
const strictWebp = new URL(location.href).searchParams.get('strict-webp') === '1';
let sequence = 0;

function check(condition, description) {
  if (!condition) throw new Error(description);
}

function prepare(blob, mimeType = blob.type) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = ({ data }) => {
      if (data.id !== id || data.progress) return;
      worker.removeEventListener('message', receive);
      if (data.reason) reject(new Error(data.reason));
      else resolve(data);
    };
    worker.addEventListener('message', receive);
    worker.postMessage({ id, blob, mimeType });
  });
}

async function fixture(name, type) {
  const response = await fetch(new URL(name, directory));
  check(response.ok, `${name}: fixture is unavailable`);
  const blob = await response.blob();
  return blob.slice(0, blob.size, type);
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function encodedBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}

function canvasPixels(image, width, height, rotateClockwise = false) {
  const context = new OffscreenCanvas(width, height).getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  context.globalCompositeOperation = 'copy';
  context.imageSmoothingQuality = 'high';
  if (rotateClockwise) {
    context.translate(width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(image, 0, 0, height, width);
  } else {
    context.drawImage(image, 0, 0, width, height);
  }
  return context.getImageData(0, 0, width, height).data;
}

async function checkAnimation(name, type, expectedRepeats, width = 1920, height = 560, shouldResize = true) {
  const source = await fixture(name, type);
  const input = new ImageDecoder({ data: source.stream(), type, preferAnimation: true });
  let output;
  const durations = [];
  try {
    let prepared;
    try {
      prepared = await prepare(source.slice(0, source.size, 'application/octet-stream'));
    } catch (error) {
      const { image } = await input.decode({ frameIndex: 0 });
      const description = `${image.displayWidth} × ${image.displayHeight}; rotation ${image.rotation}; flip ${image.flip}`;
      image.close();
      throw new Error(`${name}: ${error.message} (${description})`);
    }
    const { blob, resized } = prepared;
    check(resized === shouldResize && blob?.type === 'image/webp', `${name}: unexpected WebP result`);
    output = new ImageDecoder({ data: blob.stream(), type: blob.type, preferAnimation: true });
    await Promise.all([input.tracks.ready, input.completed, output.tracks.ready, output.completed]);
    const original = input.tracks.selectedTrack;
    const result = output.tracks.selectedTrack;
    check(original.animated && result.animated, `${name}: animation is absent`);
    check(original.frameCount === 3 && result.frameCount === original.frameCount, `${name}: frame count changed`);
    check(original.repetitionCount === result.repetitionCount, `${name}: repetition count changed`);
    check(expectedRepeats === undefined || original.repetitionCount === expectedRepeats, `${name}: invalid fixture repetition count`);
    let transparent = false, partialAlphaDifferences = 0;
    const hashes = [];
    for (let frameIndex = 0; frameIndex < original.frameCount; frameIndex++) {
      const { image: before } = await input.decode({ frameIndex });
      const { image: after } = await output.decode({ frameIndex });
      try {
        if (after.displayWidth !== width || after.displayHeight !== height) {
          const { inspectRasterImage } = await import('./src/lib/raster-image-metadata.js');
          throw new Error(`${name}: wrong output dimensions (${after.displayWidth} × ${after.displayHeight} instead of ${width} × ${height}) ` +
            JSON.stringify({ input: await inspectRasterImage(source), output: await inspectRasterImage(blob) }));
        }
        check(before.duration === after.duration, `${name}: frame ${frameIndex} duration changed`);
        durations.push(after.duration / 1000);
        const expected = canvasPixels(before, width, height, width < height && before.displayWidth > before.displayHeight);
        const actual = canvasPixels(after, width, height);
        for (let index = 0; index < actual.length; index += 4) {
          const alpha = expected[index + 3];
          if (actual[index + 3] !== alpha) throw new Error(`${name}: frame ${frameIndex} opacity changed at pixel ${index / 4}`);
          transparent ||= alpha === 0;
          for (let channel = index; channel < index + 3; channel++) {
            if (actual[channel] === expected[channel]) continue;
            if (alpha === 0 || alpha === 255) throw new Error(`${name}: frame ${frameIndex} opaque or transparent RGB changed at pixel ${index / 4}`);
            partialAlphaDifferences++;
          }
        }
        hashes.push(await sha256(expected));
      } finally {
        before.close();
        after.close();
      }
    }
    check(transparent, `${name}: test fixture lost transparency`);
    // The runner verifies these bytes with Pillow. Older Chrome versions may
    // round partially transparent colors differently when drawing VideoFrame.
    return { name, width, height, frames: result.frameCount,
      repeats: Number.isFinite(result.repetitionCount) ? result.repetitionCount : 'Infinity', durations,
      hashes, base64: await encodedBase64(blob), partialAlphaDifferences };
  } finally {
    input.close();
    output?.close();
  }
}

async function checkSameSize(name, type, { declaredType = type, mustGrow = false, transparent = false } = {}) {
  const source = await fixture(name, type);
  const { blob, resized } = await prepare(source.slice(0, source.size, declaredType));
  check(blob?.type === 'image/webp' && !resized, `${name}: same-size source did not produce WebP`);
  check(!mustGrow || blob.size > source.size, `${name}: expected the WebP to be heavier than the source`);
  const input = await createImageBitmap(source);
  const output = await createImageBitmap(blob);
  try {
    const { width, height } = input;
    check(output.width === width && output.height === height, `${name}: dimensions changed`);
    const pixels = canvasPixels(input, width, height);
    if (transparent) {
      const alpha = pixels.filter((_, index) => index % 4 === 3);
      check(alpha.includes(0) && alpha.includes(127), `${name}: fixture lacks transparent and translucent pixels`);
    }
    return { name, width, height, sourceBytes: source.size, webpBytes: blob.size, frames: 1,
      hashes: [await sha256(pixels)], base64: await encodedBase64(blob) };
  } finally {
    input.close();
    output.close();
  }
}

async function checkPassthrough() {
  const name = 'existing.webp';
  const source = await fixture(name, 'image/jpeg');
  const { blob, resized } = await prepare(source);
  check(blob?.type === 'image/webp' && !resized, `${name}: mismatched MIME was not corrected`);
  check(await sha256(await source.arrayBuffer()) === await sha256(await blob.arrayBuffer()), `${name}: source bytes changed`);
  return { name, sourceBytes: source.size, webpBytes: blob.size };
}

async function checkCorruptPng() {
  const name = 'corrupt.png';
  const source = await fixture('small-transparent.png', 'image/png');
  const bytes = new Uint8Array(await source.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let offset = 8;
  while (offset < bytes.length && view.getUint32(offset + 4) !== 0x49444154) offset += view.getUint32(offset) + 12;
  check(offset < bytes.length, `${name}: IDAT not found`);
  bytes.fill(0, offset + 8, offset + 8 + view.getUint32(offset));
  try {
    await prepare(new Blob([bytes], { type: 'image/png' }));
  } catch (error) {
    return { name, rejected: true, reason: error.message };
  }
  throw new Error(`${name}: invalid PNG did not fail conversion`);
}

async function checkOrientation(name, type) {
  const source = await fixture(name, type);
  let result;
  try {
    result = await prepare(source);
  } catch (error) {
    const input = await createImageBitmap(source, { imageOrientation: 'from-image' });
    const description = `${input.width} × ${input.height}`;
    input.close();
    throw new Error(`${name}: ${error.message} (${description})`);
  }
  const { blob, resized } = result;
  check(resized && blob?.type === 'image/webp', `${name}: EXIF image was not resized`);
  const bitmap = await createImageBitmap(blob);
  try {
    check(bitmap.width === 960 && bitmap.height === 1920, `${name}: EXIF orientation changed`);
    const pixels = canvasPixels(bitmap, bitmap.width, bitmap.height);
    const left = (480 * bitmap.width + 240) * 4;
    const right = (480 * bitmap.width + 720) * 4;
    check(pixels[left + 2] > 240 && pixels[left] < 15 && pixels[right] > 240 && pixels[right + 2] < 15,
      `${name}: EXIF image pixels were not rotated clockwise`);
    return { name, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

globalThis.fullhdAcceptance = (async () => {
  try {
    const results = [];
    const failures = [];
    const capture = async (name, run) => {
      try { results.push(await run()); }
      catch (error) { failures.push({ name, message: error.message }); }
    };
    for (const [name, type, repeats] of [
      ['animated.gif', 'image/gif', 2], ['animated.png', 'image/png', 1],
      ['animated.webp', 'image/webp', 1], ['animated.avif', 'image/avif', undefined],
      ['infinite.gif', 'image/gif', Infinity], ['once.gif', 'image/gif', 0],
    ]) {
      await capture(name, () => checkAnimation(name, type, repeats));
    }
    await capture('portrait.webp', () => checkAnimation('portrait.webp', 'image/webp', 1, 560, 1920));
    await capture('portrait-animated.png', () => checkAnimation('portrait-animated.png', 'image/png', 1, 560, 1920));
    for (const [name, type] of [['portrait.jpg', 'image/jpeg'], ['portrait.png', 'image/png'],
      ['portrait.avif', 'image/avif'], ['portrait-still.webp', 'image/webp']]) {
      await capture(name, () => checkOrientation(name, type));
    }
    if (strictWebp) {
      for (const [name, type, options] of [
        ['boundary.jpg', 'image/jpeg'],
        ['small.jpg', 'image/jpeg', { declaredType: 'image/png', mustGrow: true }],
        ['small-transparent.png', 'image/png', { transparent: true }],
        ['small.avif', 'image/avif'], ['depth-16.png', 'image/png'],
      ]) await capture(name, () => checkSameSize(name, type, options));
      await capture('small-animated.gif', () => checkAnimation('small-animated.gif', 'image/gif', 3, 96, 28, false));
      await capture('existing.webp', checkPassthrough);
      await capture('corrupt.png', checkCorruptPng);
    } else {
      const { blob } = await prepare(await fixture('boundary.jpg', 'image/jpeg'));
      check(blob === null, 'Full HD boundary image was replaced');
    }
    return { results, failures };
  } finally {
    worker.terminate();
  }
})();
