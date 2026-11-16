const PREFIX_BYTES = 1024;
const INSPECTION_MS = 1000;

export function detectedFormat(bytes) {
  const starts = signature => signature.every((value, index) => bytes[index] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (starts([255, 216, 255])) return 'jpeg';
  const text = new TextDecoder().decode(bytes);
  if (/^GIF8[79]a/.test(text)) return 'gif';
  if (/^RIFF[\s\S]{4}WEBP/.test(text)) return 'webp';
  if (/^%PDF-/.test(text)) return 'pdf';
  const beginning = text.replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(beginning)) return 'html';
  if (/^[{[]/.test(beginning)) return 'json';
  return 'unknown';
}

/** Inspect a refused response in place. Neither raw bytes nor text leave this function. */
export async function inspectRejectedMediaResponse(response, { signal } = {}) {
  const result = { detectedFormat: 'unknown', receivedBytes: 0 };
  let reader, timer, abortInspection;
  const cancel = () => {
    try { void reader?.cancel().catch(() => {}); } catch { /* Diagnostic cleanup must not replace the download error. */ }
  };
  const prefix = new Uint8Array(PREFIX_BYTES);
  let length = 0;
  try {
    if (signal?.aborted || !response.body?.getReader) return result;
    reader = response.body.getReader();
    const expired = new Promise(resolve => { timer = setTimeout(() => { cancel(); resolve(); }, INSPECTION_MS); });
    const aborted = new Promise(resolve => {
      if (signal) {
        abortInspection = () => { cancel(); resolve(); };
        signal.addEventListener('abort', abortInspection, { once: true });
      }
    });
    const reading = (async () => {
      while (length < PREFIX_BYTES && !signal?.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) break;
        result.receivedBytes += chunk.value.byteLength;
        const bytes = chunk.value.subarray(0, PREFIX_BYTES - length);
        prefix.set(bytes, length);
        length += bytes.byteLength;
        // A recognized signature needs no further bytes from an open stream.
        if (detectedFormat(prefix.subarray(0, length)) !== 'unknown') break;
      }
    })();
    await Promise.race([reading, expired, aborted]);
  } catch { /* The original unsupported MIME error remains authoritative. */ }
  finally {
    clearTimeout(timer);
    if (abortInspection) signal?.removeEventListener('abort', abortInspection);
    cancel();
    try { reader?.releaseLock(); } catch { /* The read may still be settling after cancellation. */ }
  }
  result.detectedFormat = detectedFormat(prefix.subarray(0, length));
  return result;
}

export function mediaDiagnosticError(message, reason) {
  return Object.assign(new Error(message), { reason });
}

export function emitMediaDiagnostic(callback, value) {
  try {
    const pending = callback?.({ at: new Date().toISOString(), stage: 'files', ...value });
    pending?.catch?.(() => {});
  } catch { /* Diagnostic delivery must not affect the attachment or retry policy. */ }
}
