const BUILTIN_ORIGINS = new Set(['https://platform.desharschool.ru', 'https://progressme.ru']);
const SITES_KEY = 'source-sites-v1';
const trusted = new Set(BUILTIN_ORIGINS);
const listening = new WeakSet();
let hydrationRevision = 0;

export function sourceOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password ? url.origin : '';
  } catch { return ''; }
}

export const isBuiltinSourceOrigin = value => BUILTIN_ORIGINS.has(sourceOrigin(value));
export const isTrustedSourceOrigin = value => trusted.has(sourceOrigin(value));

export async function rememberSourceOrigin(chrome, value) {
  const origin = sourceOrigin(value);
  if (!origin) throw new Error('Для подключения нужен безопасный адрес учебной платформы.');
  hydrationRevision++;
  trusted.add(origin);
  try { await chrome.storage.local.set({ [SITES_KEY]: [...trusted].filter(item => !BUILTIN_ORIGINS.has(item)) }); }
  catch (error) { if (!BUILTIN_ORIGINS.has(origin)) trusted.delete(origin); throw error; }
}

export async function forgetSourceOrigin(chrome, value) {
  const origin = sourceOrigin(value);
  if (BUILTIN_ORIGINS.has(origin)) return;
  hydrationRevision++;
  trusted.delete(origin);
  await chrome.storage.local.set({ [SITES_KEY]: [...trusted].filter(item => !BUILTIN_ORIGINS.has(item)) });
}

/** Restore only sites that were explicitly connected and still have access. */
export async function hydrateSourceOrigins(chrome = globalThis.chrome) {
  if (!chrome?.storage?.local?.get || !chrome?.permissions?.contains) return;
  const revision = ++hydrationRevision;
  const saved = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY];
  const sites = Array.isArray(saved) ? [...new Set(saved.map(sourceOrigin).filter(Boolean))] : [];
  const allowed = await Promise.all(sites.map(async origin => {
    try { return await chrome.permissions.contains({ origins: [`${origin}/*`] }) ? origin : ''; }
    catch { return ''; }
  }));
  if (revision !== hydrationRevision) return;
  trusted.clear();
  for (const origin of [...BUILTIN_ORIGINS, ...allowed.filter(Boolean)]) trusted.add(origin);
  if (!listening.has(chrome)) {
    listening.add(chrome);
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes[SITES_KEY]) void hydrateSourceOrigins(chrome).catch(() => {});
    });
    chrome.permissions.onRemoved?.addListener(() => { void hydrateSourceOrigins(chrome).catch(() => {}); });
  }
}
