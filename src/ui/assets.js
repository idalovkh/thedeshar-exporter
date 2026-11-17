import { isSafeMediaUrl, sanitizeUrl, safeFilename } from "../lib/security.js";
import { isSourceUrl } from "../lib/state.js";
import { archiveSizeError } from "../lib/archive.js";
import { snapshotBookCover } from "../lib/book-cover.js";
import { detectedFormat, emitMediaDiagnostic, inspectRejectedMediaResponse, mediaDiagnosticError } from "../lib/media-response-diagnostics.js";
import { buildMediaRequestUrls } from "../lib/media-request-urls.js";
import { createPngStreamValidator } from "../lib/png-stream-validator.js";
import { normalizePngSource } from "../lib/normalize-png-source.js";
import { hashArchiveMedia } from "../lib/media-sha256.js";

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export const MEDIA_CONCURRENCY = 6;

const MEDIA_EXTENSION = /\.(?:avif|gif|jpe?g|a?png|svg|webp|pdf|mp3|m4a|aac|ogg|oga|wav|flac|mp4|m4v|webm|mov)(?:$|[?#])/i;
const MEDIA_FIELD = /(?:image|picture|photo|thumbnail|cover|audio|video|media|file|attachment|poster)(?:url|src|path)?$/i;
const MEDIA_METADATA_FIELD = /^(?:name|title|label|filename|file_name|description|text)$/i;
const MEDIA_CONTAINER = /^(?:audios?|images?|videos?|attachments?|files?|pictures?|photos?|media)$/i;
const MEDIA_REFERENCE = /^(?:url(?:Full)?|src|path|fileUrl|filePath|sourceUrl)$/i;
const SERIALIZED_MEDIA_FIELDS = new Set(["JsonData", "ImagesJson"]);
const MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;

const isExerciseRpc = value => value?.Class === "GetExerciseWsController" && value.IsSuccess === true &&
  ["LoadExercises", "LoadExercisesInMaterial"].includes(value.Method);

// These resources remain embedded activities/players in the native importer.
// Check every discovery route: DOM iframe snapshots also carry them as assets.
function isEmbeddedResource(value, base) {
  let url;
  try { url = new URL(value, base); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  switch (url.hostname.toLowerCase()) {
    case "youtube.com": case "www.youtube.com": case "m.youtube.com":
      return url.pathname === "/watch" ? /^[\w-]+$/.test(url.searchParams.get("v") || "") : /^\/(embed|shorts|live)\/[\w-]+$/.test(url.pathname);
    case "youtube-nocookie.com": case "www.youtube-nocookie.com": return /^\/embed\/[\w-]+\/?$/.test(url.pathname);
    case "youtu.be": return /^\/[\w-]+$/.test(url.pathname);
    case "vimeo.com": case "www.vimeo.com": return /^\/[0-9]+$/.test(url.pathname);
    case "player.vimeo.com": return /^\/video\/[0-9]+\/?$/.test(url.pathname);
    case "rutube.ru": case "www.rutube.ru": return /^\/(?:video\/(?:private\/)?|play\/embed\/)[a-zA-Z0-9]+\/?$/.test(url.pathname);
    case "vk.com": case "vkvideo.ru": return url.pathname === "/video_ext.php";
    case "dzen.ru": return url.pathname.startsWith("/embed/");
    case "wordwall.net": return /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed|resource)\/[\w-]+(?:\/[^/]*)?\/?$/i.test(url.pathname);
    case "learningapps.org": return /^\/\d+\/?$/.test(url.pathname) || /^\/(?:watch|display)(?:\.php)?$/.test(url.pathname) && ["app", "v"].some(key => /^[\w-]+$/.test(url.searchParams.get(key) || ""));
    case "drive.google.com": return /^\/file\/d\/[\w-]+\/(?:view|preview)\/?$/.test(url.pathname);
    case "view.genially.com": return /^\/[a-zA-Z0-9-]+\//.test(url.pathname);
    case "quizlet.com": return /^\/[0-9]+(?:\/|$)/.test(url.pathname);
    default: return false;
  }
}

function resolvedSerializedAudio(parsed, exercise, base) {
  if (!parsed || Array.isArray(parsed) || exercise?.Type !== 4 || !Number.isSafeInteger(exercise.Id) || exercise.Id <= 0 ||
      !Array.isArray(exercise.Audios) || !Array.isArray(parsed.Audios)) return parsed;
  const current = new Map();
  for (const row of exercise.Audios) {
    if (!row || typeof row !== "object" || typeof row.Id !== "string" || !row.Id.trim()) continue;
    const address = [row.Url, row.UrlFull].find(value => typeof value === "string" && value.trim());
    let url;
    try { url = new URL(address || "", base).href; } catch { continue; }
    if (!address || !isSafeMediaUrl(url)) continue;
    // Ambiguous IDs must not suppress a potentially distinct author reference.
    current.set(row.Id, current.has(row.Id) ? null : address);
  }
  return { ...parsed, Audios: parsed.Audios.map(row => {
    const address = row && typeof row === "object" && current.get(row.Id);
    return address ? { ...row, Url: address, UrlFull: "" } : row;
  }) };
}

const mediaContextFor = (key, current) => /^videos?$/i.test(key) ? "video" : current || MEDIA_CONTAINER.test(key);

function captureMediaBase(capture) {
  const rpc = capture.data;
  // ProgressMe puts these DTO URLs directly into browser media elements. They
  // resolve in the lesson page even when this envelope arrived through HTTP.
  if (isExerciseRpc(rpc) && isSourceUrl(capture.pageUrl)) return capture.pageUrl;
  try {
    const endpoint = new URL(capture.url);
    // Fetch/XHR references retain their API-relative URL semantics. A socket
    // address is a transport endpoint, so resolve its author media in the page.
    if (["http:", "https:"].includes(endpoint.protocol)) return endpoint.href;
    if (endpoint.protocol === "wss:" && isSourceUrl(capture.pageUrl)) return capture.pageUrl;
  } catch { /* Absolute media URLs remain usable without a relative base. */ }
  return undefined;
}

/** Read only explicit media references; ordinary document/API links are not files. */
export function collectAssets(snapshots = [], captures = []) {
  const found = new Map();
  const add = (value, metadata = {}, base, sourcePage = isSourceUrl(base) ? base : undefined) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    // URL resolution would turn raw markup such as a player iframe into a relative file path.
    if (!trimmed || trimmed.startsWith("<")) return;
    let absolute;
    try { absolute = new URL(value, base).href; } catch { return; }
    if (isEmbeddedResource(absolute)) return;
    const url = sanitizeUrl(absolute);
    if (!url || !isSafeMediaUrl(url)) return;
    if (found.has(url)) {
      if (!found.get(url).sourcePage && sourcePage) found.get(url).sourcePage = sourcePage;
      return;
    }
    const id = `asset-${String(found.size + 1).padStart(4, "0")}`;
    const basename = new URL(url).pathname.split("/").at(-1) || id;
    const suffix = basename.match(/\.(avif|gif|jpe?g|a?png|svg|webp|pdf|mp3|m4a|aac|ogg|oga|wav|flac|mp4|m4v|webm|mov)$/i)?.[0] || "";
    let preferredName = typeof metadata.name === "string" && metadata.name.trim() ? metadata.name : basename;
    if (suffix && !preferredName.toLowerCase().endsWith(suffix.toLowerCase())) preferredName += suffix;
    const name = safeFilename(preferredName, id);
    found.set(url, {
      id, url, name, kind: typeof metadata.kind === "string" && metadata.kind ? metadata.kind : "file",
      mimeType: [metadata.mimeType, metadata.mime].find(value => typeof value === "string" && value.trim()) || "",
      status: "referenced",
      ...(sourcePage ? { sourcePage } : {}),
      ...(metadata.downloadUnavailable || url !== absolute ? {
        downloadUnavailable: true,
        reason: typeof metadata.reason === "string" && metadata.reason ? metadata.reason : "Ссылка содержит временные параметры доступа. Сохранена ссылка без секретных параметров.",
      } : {}),
    });
  };
  for (const snapshot of snapshots) {
    for (const asset of snapshot.assets || []) {
      if (typeof asset === "string") add(asset, {}, snapshot.url);
      else if (asset && typeof asset === "object") add(asset.url || asset.src, asset, snapshot.url);
    }
    if (snapshotBookCover(snapshot)) add(snapshot.coverUrl, { kind: "image", name: "Обложка книги" }, snapshot.url);
  }
  const addHtmlMedia = (html, base, sourcePage) => {
    for (const tag of html.matchAll(/<(img|audio|video|source|track|a)\b[^>]*>/gi)) {
      for (const attr of tag[0].matchAll(/\b(src|poster|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const reference = (attr[2] ?? attr[3] ?? attr[4]).replace(/&(?:amp|#0*38|#x0*26);/gi, "&");
        if (attr[1].toLowerCase() === "href" && (tag[1].toLowerCase() !== "a" || !MEDIA_EXTENSION.test(reference))) continue;
        if (attr[1].toLowerCase() !== "href" && tag[1].toLowerCase() === "a") continue;
        add(reference, {}, base, sourcePage);
      }
    }
  };
  const visit = (value, key, base, depth = 0, mediaContext = false, sourcePage, exercise) => {
    if (depth > 18 || value == null) return;
    // A transport batch may mix authored RPC definitions with ordinary HTTP
    // data. Apply document-relative media semantics only to the RPC branch.
    if (sourcePage && isExerciseRpc(value)) base = sourcePage;
    if (typeof value === "string") {
      if (SERIALIZED_MEDIA_FIELDS.has(key)) {
        if (value.length > MAX_SERIALIZED_BYTES || new TextEncoder().encode(value).byteLength > MAX_SERIALIZED_BYTES || !/^\s*[\[{]/.test(value)) return;
        try {
          const parsed = key === "JsonData" ? resolvedSerializedAudio(JSON.parse(value), exercise, base) : JSON.parse(value);
          if (parsed && typeof parsed === "object") visit(parsed, "", base, depth + 1, mediaContext || key === "ImagesJson", sourcePage);
        } catch { /* An unsupported serialized field is not a media URL. */ }
        return;
      }
      if (/<(?:img|audio|video|source|track|a)\b/i.test(value)) { addHtmlMedia(value, base, sourcePage); return; }
      const videoLink = mediaContext === "video" && /^link$/i.test(key);
      if ((!MEDIA_METADATA_FIELD.test(key) && MEDIA_EXTENSION.test(value)) || MEDIA_FIELD.test(key) || (mediaContext && MEDIA_REFERENCE.test(key)) || videoLink) add(value, {}, base, sourcePage);
    } else if (Array.isArray(value)) {
      for (const child of value) visit(child, key, base, depth + 1, mediaContextFor(key, mediaContext), sourcePage);
    } else if (typeof value === "object") {
      const mime = [value.mimeType, value.mime, value.contentType].find(item => typeof item === "string" && item.trim()) || "";
      if (/^(?:image|audio|video)\/|^application\/pdf$/i.test(mime)) add(value.url || value.src || value.fileUrl, value, base, sourcePage);
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey, base, depth + 1, mediaContextFor(key, mediaContext), sourcePage, childKey === "JsonData" ? value : undefined);
    }
  };
  for (const capture of captures) visit(capture.data, "", captureMediaBase(capture), 0, false, isSourceUrl(capture.pageUrl) ? capture.pageUrl : undefined);
  return [...found.values()];
}

export function mediaOrigins(assets) {
  const requests = buildMediaRequestUrls(assets);
  return [...new Set(assets.filter((asset) => !asset.downloadUnavailable && isSafeMediaUrl(asset.url))
    .map(asset => requests.get(asset.url)).filter(request => request?.url)
    .map(request => `${new URL(request.url).origin}/*`))];
}

export async function readMediaResponse(response, { signal, maxBytes = MAX_MEDIA_BYTES, onProgress, diagnostic, destination, onWrite }) {
  if (!response.ok) throw mediaDiagnosticError(`Сервер вернул HTTP ${response.status}.`, "http_error");
  // This downloader never requests ranges. A range response cannot stand in
  // for the complete attachment, even if its own Content-Length matches.
  if (response.status === 206 || response.headers.has("content-range")) {
    try { void response.body?.cancel().catch(() => {}); } catch { /* Keep the range error if cleanup fails. */ }
    throw mediaDiagnosticError("Сервер вернул только часть файла. Повторите скачивание полного файла.", "partial_response");
  }
  const lengthHeader = response.headers.get("content-length")?.trim() || "";
  const size = Number(lengthHeader);
  const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const provisionalPng = mimeType === "text/plain";
  if (mimeType && !provisionalPng && !/^(?:image|audio|video)\//.test(mimeType) && !["application/pdf", "application/octet-stream", "binary/octet-stream", "application/ogg"].includes(mimeType)) {
    if (diagnostic) Object.assign(diagnostic, await inspectRejectedMediaResponse(response, { signal }));
    throw mediaDiagnosticError("Ссылка вернула страницу или другой неподдерживаемый тип файла.", "unsupported_content_type");
  }
  if (!response.body?.getReader) throw mediaDiagnosticError("Браузер не поддерживает ограниченное скачивание потока.", "unsupported_stream");
  // Fetch yields decoded bytes; an encoded/chunked response cannot supply a
  // trustworthy denominator for that byte count through Content-Length.
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  const transferEncoding = response.headers.get("transfer-encoding")?.trim().toLowerCase();
  const expectedSize = /^\d+$/.test(lengthHeader) && Number.isSafeInteger(size) && size > 0
    && (!encoding || encoding === "identity") && (!transferEncoding || transferEncoding === "identity")
    ? size : undefined;
  if (expectedSize !== undefined && expectedSize > maxBytes) {
    try { void response.body.cancel().catch(() => {}); } catch { /* Keep the size error if cleanup fails. */ }
    throw mediaDiagnosticError("Превышен лимит размера файла.", "file_limit");
  }
  const reader = response.body.getReader();
  // Some source images are sent as text/plain. Their bytes must pass the full
  // container check before their effective MIME can change; a prefix is insufficient.
  const pngValidator = provisionalPng ? createPngStreamValidator({ maxBytes, allowTrailing: true }) : null;
  const diagnosticPrefix = provisionalPng && diagnostic ? new Uint8Array(1024) : null;
  let prefixBytes = 0;
  const chunks = [], blobParts = [];
  let loaded = 0, chunkBytes = 0;
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abortRead, { once: true });
  try {
    if (signal?.aborted) throw new DOMException("Скачивание отменено.", "AbortError");
    onProgress?.({ loaded, total: expectedSize });
    while (true) {
      if (signal?.aborted) throw new DOMException("Скачивание отменено.", "AbortError");
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException("Скачивание отменено.", "AbortError");
      if (done) break;
      loaded += value.byteLength;
      if (diagnostic) diagnostic.receivedBytes = loaded;
      if (diagnosticPrefix) {
        const prefix = value.subarray(0, diagnosticPrefix.length - prefixBytes);
        diagnosticPrefix.set(prefix, prefixBytes); prefixBytes += prefix.byteLength;
        diagnostic.detectedFormat = detectedFormat(diagnosticPrefix.subarray(0, prefixBytes));
      }
      if (loaded > maxBytes) throw mediaDiagnosticError("Превышен лимит размера файла.", "file_limit");
      if (expectedSize !== undefined && loaded > expectedSize) throw mediaDiagnosticError("Полученный размер файла не совпадает с объявленным. Повторите скачивание.", "size_mismatch");
      pngValidator?.feed(value);
      if (destination) {
        for (let offset = 0; offset < value.byteLength; offset += 1024 * 1024) {
          signal?.throwIfAborted();
          const started = performance.now();
          await destination.write(value.subarray(offset, Math.min(value.byteLength, offset + 1024 * 1024)));
          onWrite?.(performance.now() - started);
        }
      } else {
        chunks.push(value); chunkBytes += value.byteLength;
        if (chunkBytes >= 4 * 1024 * 1024) {
          blobParts.push(new Blob(chunks)); chunks.length = 0; chunkBytes = 0;
        }
      }
      onProgress?.({ loaded, total: expectedSize });
    }
    if (expectedSize !== undefined && loaded !== expectedSize) {
      throw mediaDiagnosticError("Полученный размер файла не совпадает с объявленным. Повторите скачивание.", "size_mismatch");
    }
    pngValidator?.finish();
    if (!loaded) throw mediaDiagnosticError("Получен пустой файл.", "empty_file");
    if (destination) await destination.close();
  } catch (error) {
    try { void reader.cancel().catch(() => {}); } catch { /* Keep the file error if cancellation fails. */ }
    if (destination) try { await destination.abort(); } catch { /* Preserve the source failure. */ }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }
  if (!loaded) throw mediaDiagnosticError("Получен пустой файл.", "empty_file");
  const effectiveMimeType = provisionalPng ? "image/png" : mimeType;
  if (provisionalPng && diagnostic) diagnostic.effectiveMimeType = effectiveMimeType;
  return { data: destination ? null : new Blob([...blobParts, ...chunks], { type: effectiveMimeType || "application/octet-stream" }), mimeType: effectiveMimeType };
}


function mediaError(error) {
  const status = error.message?.match(/HTTP (\d{3})/)?.[1];
  if (status === "404") return "Файл не найден на исходной платформе.";
  if (["401", "403"].includes(status)) return "Платформа не разрешила скачать файл. Сохраните его из книги.";
  if (status?.startsWith("5")) return "Сервер файлов временно недоступен. Попробуйте скачать архив ещё раз.";
  if (error instanceof TypeError) return "Нет связи с сервером файла. Проверьте интернет и попробуйте ещё раз.";
  return error.message || "Не удалось скачать файл.";
}

function waitToRetry(delay, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      reject(new DOMException("Скачивание отменено.", "AbortError"));
    };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Bounded parallel downloads; the book budget never masquerades as a file limit. */
export async function downloadMediaAssets(candidates, {
  signal, maxFileBytes = MAX_MEDIA_BYTES, maxTotalBytes = Infinity,
  concurrency = MEDIA_CONCURRENCY, timeoutMs = 45_000, retryDelayMs = 300,
  fetchFile = globalThis.fetch, hasPermission = async () => true, onProgress, onDiagnostic, optimizeMedia, deduplicate = false,
} = {}) {
  const operation = new AbortController();
  const abort = () => operation.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) operation.abort();
  const results = new Array(candidates.length);
  const requests = buildMediaRequestUrls(candidates);
  const active = new Map(), permissions = new Map();
  const uniqueBodies = deduplicate ? new Map() : null;
  const preparedByURL = deduplicate ? new Map() : null;
  const admitAfterDownload = Boolean(optimizeMedia || uniqueBodies);
  let next = 0, completed = 0, retainedBytes = 0, transferredBytes = 0, encoding = 0, fatal;
  const check = () => {
    if (fatal) throw fatal;
    if (operation.signal.aborted) throw new DOMException("Скачивание отменено.", "AbortError");
  };
  const report = () => onProgress?.({
    completed, total: candidates.length, loadedBytes: transferredBytes,
    retainedBytes: retainedBytes + (admitAfterDownload ? 0 : [...active.values()].reduce((sum, item) => sum + item.loaded, 0)),
    active: [...active.values()].map(item => ({ ...item })),
    encoding,
  });
  const permitted = origin => {
    if (!permissions.has(origin)) permissions.set(origin, Promise.resolve().then(() => hasPermission(origin)));
    return permissions.get(origin);
  };
  async function worker() {
    while (next < candidates.length) {
      check();
      const index = next++, asset = { ...candidates[index] };
      let requestUrl = asset.url;
      let details = { receivedBytes: 0 }, attemptNumber = 0, attemptStartedAt = performance.now();
      const diagnostic = (status, reason) => emitMediaDiagnostic(onDiagnostic, {
        status, assetId: asset.id, url: requestUrl, sourcePage: asset.sourcePage,
        attempt: attemptNumber, elapsedMs: Math.round(performance.now() - attemptStartedAt),
        ...details, ...(reason ? { reason } : {}),
      });
      if (asset.downloadUnavailable) {
        results[index] = { ...asset, status: "unavailable", error: "Файл доступен только по временной ссылке. Скачайте его на исходной платформе." };
        diagnostic("unavailable", "temporary_url");
        completed++; report(); continue;
      }
      const request = requests.get(asset.url);
      if (request?.reason) {
        results[index] = { ...asset, status: "failed", error: "Не удалось однозначно определить адрес файла: в книге найдены разные ссылки." };
        diagnostic("failed", request.reason);
        completed++; report(); continue;
      }
      requestUrl = request?.url || asset.url;
      const controller = new AbortController();
      const abortFile = () => controller.abort();
      operation.signal.addEventListener("abort", abortFile, { once: true });
      let timeout, sharedTimeout = false;
      const restartTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), timeoutMs); };
      async function prepareFile() {
        let file;
        for (let attempt = 0; attempt < 3; attempt++) {
          check(); restartTimeout();
          attemptNumber = attempt + 1; attemptStartedAt = performance.now(); details = { receivedBytes: 0 };
          diagnostic("started");
          active.set(index, { name: asset.name, loaded: 0, total: undefined });
          report();
          try {
            const response = await fetchFile(requestUrl, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
            details.httpStatus = response.status;
            details.mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
            const declared = response.headers.get("content-length")?.trim() || "";
            if (/^\d+$/.test(declared) && Number.isSafeInteger(Number(declared))) details.declaredBytes = Number(declared);
            if (attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) {
              await response.body?.cancel().catch(() => {});
              diagnostic("retrying", "http_error");
            } else {
              file = await readMediaResponse(response, {
                signal: controller.signal, maxBytes: maxFileBytes, diagnostic: onDiagnostic ? details : undefined,
                onProgress: ({ loaded, total }) => {
                  check();
                  const previous = active.get(index);
                  transferredBytes += loaded - previous.loaded;
                  active.set(index, { name: asset.name, loaded, total });
                  // With postprocessing, each lane owns at most one original.
                  // The ZIP budget counts the resulting bodies after admission.
                  if (!admitAfterDownload && retainedBytes + [...active.values()].reduce((sum, item) => sum + item.loaded, 0) > maxTotalBytes) {
                    fatal = archiveSizeError(); operation.abort(); throw fatal;
                  }
                  restartTimeout(); report();
                },
              });
              break;
            }
          } catch (error) {
            // Fetch and body reads surface interrupted network requests as TypeError.
            if (attempt === 2 || controller.signal.aborted || !(error instanceof TypeError)) throw error;
            diagnostic("retrying", "network_error");
          }
          // Bytes from a failed attempt are never retained in the archive.
          active.delete(index);
          clearTimeout(timeout);
          await waitToRetry(Math.max(0, retryDelayMs) * (attempt + 1), controller.signal);
        }
        clearTimeout(timeout);
        active.delete(index);
        check();
        file = await normalizePngSource(file, details);
        let converted = false;
        if (optimizeMedia) {
          encoding++;
          report();
          try {
            const selected = await optimizeMedia(file, { signal: operation.signal, index });
            converted = selected.mimeType === 'image/webp' && (selected.mimeType !== file.mimeType || selected.data !== file.data);
            file = selected;
          } finally { encoding--; }
          check();
        }
        let key;
        if (uniqueBodies) {
          try {
            key = `${file.data.size}:${await hashArchiveMedia(file.data, operation.signal)}`;
          } catch {
            check();
            throw mediaDiagnosticError("Не удалось прочитать файл для проверки дубликатов.", "media_hash_failed");
          }
          check();
        }
        const shared = uniqueBodies?.get(key);
        if (shared) {
          file = { ...file, data: shared };
        } else {
          // Reserve space and publish the body without yielding to another lane.
          if (file.data.size > maxTotalBytes - retainedBytes) {
            fatal = archiveSizeError(); operation.abort(); throw fatal;
          }
          retainedBytes += file.data.size;
          uniqueBodies?.set(key, file.data);
        }
        return { file, converted };
      }
      try {
        if (!await permitted(`${new URL(requestUrl).origin}/*`)) {
          results[index] = { ...asset, status: "skipped", error: "Не разрешён доступ к серверу файла." };
          diagnostic("skipped", "permission_denied");
          continue;
        }
        check();
        let prepared = preparedByURL?.get(requestUrl);
        const reused = Boolean(prepared);
        if (!prepared) {
          // Keep the shared outcome after retries, including failures. Each
          // logical reference still records its own status and archive name.
          prepared = prepareFile().then(
            result => ({ ...result, details, attemptNumber }),
            error => ({ error, details, attemptNumber, timedOut: controller.signal.aborted && !operation.signal.aborted }),
          );
          preparedByURL?.set(requestUrl, prepared);
        }
        const result = await prepared;
        if (reused) {
          // No network bytes were received by this alias.
          details = { ...result.details, receivedBytes: 0 };
          attemptNumber = result.attemptNumber;
          sharedTimeout = result.timedOut;
        }
        if ("error" in result) throw result.error ?? new Error("Не удалось подготовить медиафайл.");
        check();
        const { file, converted } = result;
        if (converted) {
          asset.name = safeFilename(`${safeFilename(asset.name || asset.url).replace(/\.[^.]+$/, '')}.webp`, 'image.webp');
        }
        results[index] = { ...asset, ...file, status: "downloaded" };
        diagnostic("downloaded");
      } catch (error) {
        if (error.code === "archive_limit") { fatal ||= error; operation.abort(); }
        if (fatal || operation.signal.aborted) {
          diagnostic(fatal ? "failed" : "cancelled", fatal ? "archive_limit" : "cancelled");
          throw fatal || new DOMException("Скачивание отменено.", "AbortError");
        }
        const timedOut = sharedTimeout || controller.signal.aborted;
        results[index] = { ...asset, status: "failed", error: timedOut ? "Сервер файла не передавал данные 45 секунд. Попробуйте скачать архив ещё раз." : mediaError(error) };
        diagnostic("failed", timedOut ? "timeout" : error.reason || (error instanceof TypeError ? "network_error" : "download_failed"));
      } finally {
        controller.abort(); clearTimeout(timeout);
        operation.signal.removeEventListener("abort", abortFile);
        active.delete(index); completed++; report();
      }
    }
  }
  try {
    check(); report();
    const poolSize = Math.min(candidates.length, Math.max(1, Math.min(6, Math.trunc(concurrency) || MEDIA_CONCURRENCY)));
    const workers = await Promise.allSettled(Array.from({ length: poolSize }, worker));
    const rejected = workers.find(result => result.status === "rejected");
    if (rejected) throw fatal || rejected.reason;
    check();
    return results;
  } finally {
    operation.abort(); signal?.removeEventListener("abort", abort);
  }
}
