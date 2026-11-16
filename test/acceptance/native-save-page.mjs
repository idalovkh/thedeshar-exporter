import { createExportPackage } from './src/lib/package.js';
import { writeZipFile } from './src/lib/archive-stream.js';
import { createExportResources } from './src/lib/export-resources.js';

const runId = new URL(location.href).searchParams.get('run');
const state = globalThis.nativeSaveAcceptance = { status: 'starting', runId };
const button = document.getElementById('save');
const status = document.getElementById('status');
function update(phase, text) { state.status = phase; status.textContent = text; }
try {
  if (typeof showSaveFilePicker !== 'function') throw Error('showSaveFilePicker is unavailable on this extension page');
  const resources = createExportResources();
  try {
    const sample = await resources.sample();
    let cpuAvailable = false;
    try { cpuAvailable = Array.isArray((await chrome.system.cpu.getInfo()).processors); } catch { /* Report availability explicitly. */ }
    state.resources = { memoryAvailable: sample.available !== null && sample.capacity !== null, cpuAvailable, concurrency: sample.concurrency };
  } finally { resources.close(); }
  state.secureContext = isSecureContext;
  button.disabled = false;
  update('ready', 'Готово. Нажмите кнопку и сохраните файл /private/tmp/thedeshar-native-save-qa.zip.');
} catch (error) {
  state.error = { message: error.message, code: error.code, name: error.name };
  update('error', error.message);
}

button.addEventListener('click', async event => {
  button.disabled = true;
  state.gesture = { trusted: event.isTrusted, active: navigator.userActivation.isActive };
  try {
    if (!state.gesture.trusted || !state.gesture.active) throw Error('A real active user gesture is required');
    update('picker', 'Открыт системный диалог сохранения.');
    const handle = await showSaveFilePicker({
      suggestedName: 'thedeshar-native-save-qa.zip',
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      excludeAcceptAllOption: true,
    });
    update('writing', 'Сохраняем и проверяем ZIP…');
    const bytes = new Uint8Array(65553).fill(17);
    bytes.set([73, 68, 51]);
    const root = 'https://progressme.ru/cabinet/school/materials/book/71/content';
    const prepared = createExportPackage({
      snapshots: [{ url: root, title: 'Native Save QA', blocks: [{ text: 'Native external Save QA ' + runId }] }],
      captures: [], warnings: [], source: { platform: 'deshar-progressme', url: root },
      assets: [{ id: 'native-audio', url: 'https://cdn.example.test/native.mp3', name: 'native.mp3',
        mimeType: 'audio/mpeg', status: 'downloaded', data: new Blob([bytes], { type: 'audio/mpeg' }) }],
    });
    state.result = { ...await writeZipFile(prepared.entries, handle, { manifest: prepared.manifest }), name: handle.name };
    update('done', 'ZIP сохранён и проверен. Проверка завершена.');
  } catch (error) {
    state.error = { message: error.message, code: error.code, name: error.name };
    update('error', error.message);
  }
});
