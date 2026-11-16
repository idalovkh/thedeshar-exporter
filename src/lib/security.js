const REDACTED = "[REDACTED]";
const SECRET_QUERY = /^(?:.*token|auth(?:orization)?|api[_-]?key|key|password|passwd|secret|session(?:id)?|sid|jwt|signature|sig|credential|policy|key[_-]?pair[_-]?id|code|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|x[_-]amz[_-].*|x[_-]goog[_-].*)$/i;
const PRIVATE_KEY = /^(?:password|passwd|secret|client[_-]?secret|.*token|csrf|xsrf|authorization|authentication|credentials?|api[_-]?key|cookie|cookies|set[_-]?cookie|headers|request[_-]?headers|response[_-]?headers|session|session[_-]?id|jwt|email|e[_-]?mail|phone|telephone|mobile|first[_-]?name|last[_-]?name|full[_-]?name|birth[_-]?date|date[_-]?of[_-]?birth|address|billing|payment(?:s)?|balance|credit[_-]?card|card[_-]?(?:number|token)|student(?:s|[_-]?(?:id|name|email|profile|results|answers|data))?|learner(?:s)?|user(?:s|[_-]?(?:id|name|email|profile|data))?|account(?:s|[_-]?(?:id|name|profile|data))?|profile|personal[_-]?data|employee(?:s)?|contact(?:s)?|download[_-]?url)$/i;
const BLOCKED_PATH = /(?:^|\/)(?:auth|login|logout|register|registration|oauth|session|identity|profile|account|accounts|users?|students?|learners?|employees?|payments?|billing|balance|indicators|analytics|tracking|telemetry|notifications?|messenger|chat)(?:\/|$)/i;
const MATERIAL_PATH = /(?:^|\/)(?:materials?|books?|lessons?|lesson-editor|exercises?|sections?|units?|courses?|contents?)(?:\/|$)/i;
const MATERIAL_KEY = /^(?:materials?|books?|lessons?|exercises?|sections?|units?|courses?|blocks|answer[_-]?key|correct[_-]?answers?|wordlist|vocabulary|classwork|homework|author[_-]?content)$/i;
const SAFE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "pdf", "mp3", "wav", "ogg", "m4a", "aac", "flac", "mp4", "webm", "mov", "vtt", "srt", "txt", "json", "bin"]);
// ProgressMe's read-only material responses wrap definitions in Value.Items,
// without a generic "exercises" key. Exclude learner histories and account data
// by projecting the confirmed ExerciseModel definition fields only. The MAIN
// world observer has the same projection because it cannot import this module.
const DEFINITION_FIELDS = new Set(("Id Type Name Number ExerciseNumber IsAutoCheck IsLessonPage IsShowExerciseNumber JsonData Images ImageInputCorrectWord PasteWordByDrag InputCorrectFormWord SelectCorrectFormWord Essay ImageSelectCorrectWord Note Audios Button Text BuildWordFromLetters PracticeId PersonalMaterialId HomeworkLessonId PracticeNumber SectionId LessonSectionId Videos VideosUrl AudioRecording Questions QuestionAnswers MappingWords Words AddWordsToVocabulary Topic MappingImageByDrag GroupWordsByColumns Test QuestionWithCodingTexts SentencesInCorrectOrder Descriptions NumberToHeader MainNumberToHeader MiroBoard GooglePDF Wordwall Learningapps Genially Baamboozle Quizlet ChoiseExtraWords TrueOrFalse IsHidePupil ImagesJson AutoCheck TimerMinutes UsedNewConstructor Statistics").split(" "));
const DEFINITION_TYPES = new Set([2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 43, 99]);

function rpcEnvelope(value) {
  return value && typeof value === "object" && typeof value.Method === "string" &&
    (typeof value.Class === "string" || typeof value.Controller === "string");
}

function exerciseDefinitions(value) {
  if (value?.Class !== "GetExerciseWsController" ||
    !["LoadExercisesInMaterial", "LoadExercises"].includes(value.Method) || value.IsSuccess !== true ||
    (value.ProjectName !== undefined && value.ProjectName !== "Exercises") ||
    !value.Value || !Array.isArray(value.Value.Items) || value.Value.Items.length > 4000) return null;
  if (!value.Value.Items.every(item => item && typeof item === "object" && !Array.isArray(item) &&
    Number.isSafeInteger(item.Id) && item.Id > 0 && DEFINITION_TYPES.has(item.Type))) return null;
  const data = { Items: value.Value.Items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => DEFINITION_FIELDS.has(key)))) };
  for (const key of ["SectionId", "Count"]) if (Number.isSafeInteger(value.Value[key]) && value.Value[key] >= 0) data[key] = value.Value[key];
  return { Class: value.Class, Method: value.Method, IsSuccess: true, ProjectName: "Exercises", Value: data };
}

// Independently validate the passive book inventory before it reaches storage.
function bookCourses(value) {
  if (!["CourseWsController", "SharingMaterialWsController"].includes(value?.Class) ||
    value.Method !== "GetBookCourses" || value.IsSuccess !== true ||
    (value.ProjectName !== undefined && value.ProjectName !== "Books") ||
    !Array.isArray(value.Value) || value.Value.length > 1000) return null;
  const ids = new Set();
  if (!value.Value.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      !Number.isSafeInteger(item.Id) || item.Id <= 0 || ids.has(item.Id) ||
      typeof item.Name !== "string" || item.Name.length > 500 ||
      !Number.isSafeInteger(item.CountLesson) || item.CountLesson < 0 || item.CountLesson > 10000 ||
      (item.BookId !== undefined && (!Number.isSafeInteger(item.BookId) || item.BookId <= 0))) return false;
    ids.add(item.Id);
    return true;
  })) return null;
  return { Class: value.Class, Method: value.Method, IsSuccess: true, ProjectName: "Books",
    Value: value.Value.map(item => ({ Id: item.Id, Name: item.Name, CountLesson: item.CountLesson,
      ...(item.BookId !== undefined ? { BookId: item.BookId } : {}),
      ...(Object.hasOwn(item, "ImageUrl") && (item.ImageUrl === null || typeof item.ImageUrl === "string") ? { ImageUrl: item.ImageUrl } : {}) })) };
}

function materialRpcEnvelope(value) {
  return Boolean(exerciseDefinitions(value) || bookCourses(value)) || (value.Class === "LessonWsController" &&
    ["GetLessonWithId", "GetLessonPreview"].includes(value.Method) && value.IsSuccess === true &&
    value.Value && typeof value.Value === "object" &&
    (Array.isArray(value.Value.Sections) || Array.isArray(value.Value.sections) ||
      Boolean(value.Value.Book && typeof value.Value.Book === "object")));
}

// Scoring definitions are author data; runtime learner statistics are not.
function authoredStatistics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  const unsupported = '[unsupported scoring definition]';
  const scalar = item => item === null || typeof item === 'number' && Number.isFinite(item) ||
    typeof item === 'string' && /^-?\d+(?:\.\d+)?$/.test(item) ? item : unsupported;
  if (Object.hasOwn(value, 'ScoringType')) result.ScoringType = scalar(value.ScoringType);
  if (Object.hasOwn(value, 'ConfigurationJson')) {
    let configuration = value.ConfigurationJson;
    if (configuration === null || typeof configuration === 'string' && !configuration.trim()) {
      result.ConfigurationJson = configuration;
      return result;
    }
    const serialized = typeof configuration === 'string';
    if (serialized) {
      if (configuration.length > 1024 * 1024 || new TextEncoder().encode(configuration).byteLength > 1024 * 1024) configuration = undefined;
      else {
        try { configuration = JSON.parse(configuration); } catch { configuration = undefined; }
      }
    }
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
      result.ConfigurationJson = unsupported;
    } else {
      const config = {};
      for (const field of ['TotalPoints', 'TotalCountAnswers', 'MaxPoints']) {
        if (Object.hasOwn(configuration, field)) config[field] = scalar(configuration[field]);
      }
      for (const [field, fields] of [['TestAnswers', ['AnswerId', 'Points']], ['Points', ['CountAnswersFalse', 'Point']]]) {
        if (!Object.hasOwn(configuration, field)) continue;
        config[field] = Array.isArray(configuration[field]) && configuration[field].length <= 4000 ? configuration[field].map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return unsupported;
          return Object.fromEntries(fields.filter(name => Object.hasOwn(item, name)).map(name => [name, scalar(item[name])]));
        }) : unsupported;
      }
      result.ConfigurationJson = serialized ? JSON.stringify(config) : config;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function parsedDefinitionJson(key, value) {
  const maxBytes = 8 * 1024 * 1024;
  if (!["JsonData", "ImagesJson"].includes(key) || typeof value !== "string" ||
    value.length > maxBytes || new TextEncoder().encode(value).byteLength > maxBytes) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch { return undefined; }
}

function stripQuerySecrets(searchParams) {
  for (const name of [...searchParams.keys()]) {
    if (SECRET_QUERY.test(name)) searchParams.delete(name);
  }
}

/** Remove credentials from a reference. A sanitized signed URL is an inventory reference, not a download URL. */
export function sanitizeUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(trimmed);
  try {
    const url = new URL(trimmed, base || "https://export.invalid/");
    if (!["https:", "http:", "wss:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    stripQuerySecrets(url.searchParams);
    if (/[?=&]/.test(url.hash)) {
      const hash = url.hash.slice(1);
      const offset = hash.indexOf("?");
      const prefix = offset >= 0 ? hash.slice(0, offset + 1) : "";
      const params = new URLSearchParams(offset >= 0 ? hash.slice(offset + 1) : hash);
      stripQuerySecrets(params);
      url.hash = params.size ? `${prefix}${params}` : "";
    }
    return absolute || base || trimmed.startsWith("//") ? url.href : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "";
  }
}

function redactString(value) {
  // Relative media references occur both as JSON string values and in serialized
  // lesson HTML. Only URL contexts are inspected; exercise prose such as
  // "policy = fair" must remain educational content, rather than a credential.
  function relativeReference(reference) {
    const encodedAmpersands = /&(?:amp|#0*38|#x0*26);/i.test(reference);
    const decoded = reference.replace(/&(?:amp|#0*38|#x0*26);/gi, "&");
    let sanitized = sanitizeUrl(decoded);
    if (decoded.startsWith("//") && sanitized.startsWith("https:")) sanitized = sanitized.slice(6);
    return encodedAmpersands ? sanitized.replace(/&/g, "&amp;") : sanitized;
  }
  let text = value;
  if (/^\/[^\s<>"']*$/.test(text.trim())) text = relativeReference(text.trim());
  return text
    .replace(/(\b(?:src|href|poster|data-src)\s*=\s*)(["'])(\/[^"']*)\2/gi,
      (_match, prefix, quote, reference) => `${prefix}${quote}${relativeReference(reference)}${quote}`)
    .replace(/(\b(?:src|href|poster|data-src)\s*=\s*)(\/[^\s<>"']+)/gi,
      (_match, prefix, reference) => `${prefix}${relativeReference(reference)}`)
    .replace(/(?:https?|wss):\/\/[^\s<>"']+/gi, relativeReference)
    .replace(/\bBearer\s+[a-z\d._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[a-z\d_-]{6,}\.[a-z\d_-]{6,}\.[a-z\d_-]+/gi, REDACTED)
    .replace(/\b((?:[a-z_-]*token|csrf|xsrf|authorization|password|api[_-]?key|session[_-]?id)\s*[=:]\s*)[^\s&;,<>"']+/gi, `$1${REDACTED}`);
}

/** Copy JSON-like data and remove session credentials and unrelated personal/account payloads. */
export function redactSensitive(value, seen = new WeakSet(), depth = 0) {
  if (depth > 60) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (rpcEnvelope(value) && !materialRpcEnvelope(value)) return REDACTED;
  value = exerciseDefinitions(value) || bookCourses(value) || value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => redactSensitive(item, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [name, item] of Object.entries(value)) {
    if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
    if (PRIVATE_KEY.test(name)) { result[name] = REDACTED; continue; }
    if (name === "Statistics") {
      const statistics = authoredStatistics(item);
      if (statistics !== undefined) result[name] = redactSensitive(statistics, seen, depth + 1);
      continue;
    }
    const parsed = parsedDefinitionJson(name, item);
    result[name] = parsed === undefined ? redactSensitive(item, seen, depth + 1)
      : JSON.stringify(redactSensitive(parsed, seen, depth + 1) ?? null);
  }
  seen.delete(value);
  return result;
}

function isPrivateIpv4(hostname) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19));
}

/** The original URL may retain its download signature in memory. Never serialize it directly. */
export function isSafeMediaUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    if (!host || !host.includes(".") || host.includes(":") || host.includes("[") || host.includes("%")) return false;
    if (/^(?:localhost|localhost\.localhost)$/.test(host) || /\.(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return false;
    return !isPrivateIpv4(host);
  } catch {
    return false;
  }
}

export function safeFilename(value, fallback = "asset.bin") {
  let name = String(value || "");
  try {
    if (/^https?:/i.test(name)) name = new URL(name).pathname.split("/").pop() || "";
    name = decodeURIComponent(name);
  } catch { /* Malformed source names are normalized below. */ }
  name = name.split(/[\\/]/).pop().split(/[?#]/)[0].normalize("NFKC");
  name = name.replace(/[\u0000-\u001f\u007f%<>:"|?*]/g, "_").replace(/\s+/g, " ").replace(/^\.+|[. ]+$/g, "").trim();
  if (!name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    return fallback === "asset.bin" ? "asset.bin" : safeFilename(fallback, "asset.bin");
  }
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (extension && !SAFE_EXTENSIONS.has(extension)) name = `${name.slice(0, dot)}.bin`;
  if (name.length > 160) {
    const lastDot = name.lastIndexOf(".");
    const suffix = lastDot > 0 ? name.slice(lastDot) : "";
    name = `${name.slice(0, 160 - suffix.length)}${suffix}`;
  }
  return name || "asset.bin";
}

export function classifyMaterialPayload({ url = "", data } = {}) {
  let pathname;
  try { pathname = new URL(url, "https://export.invalid/").pathname; } catch { return false; }
  if (BLOCKED_PATH.test(pathname)) return false;
  if (rpcEnvelope(data)) return materialRpcEnvelope(data);
  if (MATERIAL_PATH.test(pathname)) return true;
  let visited = 0;
  const pending = [{ value: data, depth: 0 }];
  while (pending.length && visited++ < 2000) {
    const { value, depth } = pending.pop();
    if (!value || typeof value !== "object" || depth > 8) continue;
    if (rpcEnvelope(value)) {
      if (materialRpcEnvelope(value)) return true;
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (MATERIAL_KEY.test(key)) return true;
      if (!PRIVATE_KEY.test(key) && child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}
