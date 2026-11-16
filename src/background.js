import { appendCapture, appendSnapshot, createWorkspace, isSourceUrl } from './lib/state.js';
import { readWorkspace as readPersistent, updateWorkspace as updatePersistent, releaseWorkspace as releasePersistent, resetWorkspace as resetPersistent, listWorkspaceMetadata } from './lib/store.js';
import { sanitizeUrl, redactSensitive, classifyMaterialPayload } from './lib/security.js';
import { collectAssets } from './ui/assets.js';
import { exerciseCaptureObservation, hasExerciseCapture } from './lib/exercise-capture.js';
import { createProblemReportStore } from './lib/problem-report-store.js';
import { createProblemReportCommands, isProblemReportCommand } from './lib/problem-report-commands.js';
import { createBookWorkspaces, sourceBookKey } from './lib/book-workspaces.js';
import { requestSource } from './lib/source-requests.js';
import { cancelledCollection } from './lib/cancel-collection.js';
import { recordDownloadResult } from './lib/record-download-result.js';
import { readExportMetadata, saveExportSummary, readExportRecordPage, recordExportResult } from './lib/store.js';
import { createExportWorkspaceCommands } from './lib/export-workspace-commands.js';
import { createSourceNavigation } from './lib/source-navigation.js';
import { navigationErrorCode, sourceStatusError } from './lib/source-navigation-errors.js';
import { navigationDiagnostic } from './lib/navigation-diagnostics.js';
import { hydrateSourceOrigins } from './lib/source-origins.js';
import { prepareSourceSite } from './lib/source-site-registration.js';
import { createExporterBinding } from './lib/exporter-binding.js';
import { exporterBindingDiagnostic } from './lib/exporter-binding-diagnostics.js';

export function installBackground(chrome, { readWorkspace: readStored = readPersistent, updateWorkspace: updateStored = updatePersistent,
  releaseWorkspace: releaseStored = readStored === readPersistent ? releasePersistent : () => {},
  resetWorkspace: resetStored = readStored === readPersistent ? resetPersistent : async (tabId, { book } = {}) => updateStored(tabId, previous => ({ ...createWorkspace(tabId), ...(book ? { book } : {}), exportRevision: (previous.exportRevision || 0) + 1 })),
  listWorkspaces: listStored = readStored === readPersistent ? listWorkspaceMetadata : async () => [],
  readExportMetadata: readExportMeta = readStored === readPersistent ? readExportMetadata : null,
  saveExportSummary: saveExportProjection = readStored === readPersistent ? saveExportSummary : null,
  readExportRecordPage: readExportPage = readStored === readPersistent ? readExportRecordPage : null,
  recordExportResult: saveExportResult = readStored === readPersistent ? recordExportResult : null } = {}) {
  const epochs = new Map();
  const dataGenerations = new Map();
  const controllers = new Map();
  const captureIds = new Map();
  const begunLeases = new Map();
  const collectionIntents = new Map();
  const leasePersistence = new Map();
  const sourceOriginsReady = hydrateSourceOrigins(chrome);
  const problemReports = createProblemReportStore({ sessionStorage: chrome.storage.session });
  const catalogue = createBookWorkspaces({ storage: chrome.storage.session, listLegacy: listStored });
  const epochOf = tabId => epochs.get(tabId) || 0;
  const stale = (code = 'stale_collection') => Object.assign(new Error(code === 'stale_capture'
    ? 'Этот ответ относится к предыдущему сбору и не сохранён.'
    : 'Этот сбор уже остановлен или сброшен. Начните новый сбор учебника.'), { code });
  const assertEpoch = (tabId, expected) => { if (epochOf(tabId) !== expected) throw stale(); };
  const controllerFor = tabId => {
    if (!controllers.has(tabId)) controllers.set(tabId, new AbortController());
    return controllers.get(tabId);
  };
  const workspaces = new Map();
  const inventories = new Map();
  const summaries = new Map();
  const readWorkspace = async tabId => {
    const generation = dataGenerations.get(tabId) || 0;
    if (!workspaces.has(tabId)) {
      const state = await readStored(tabId);
      if ((dataGenerations.get(tabId) || 0) !== generation) throw stale();
      workspaces.set(tabId, state);
    }
    return workspaces.get(tabId);
  };
  const updateWorkspace = async (tabId, updater, expectedEpoch = epochOf(tabId), epochKey = tabId) => {
    assertEpoch(epochKey, expectedEpoch);
    const generation = dataGenerations.get(tabId) || 0;
    const check = () => {
      assertEpoch(epochKey, expectedEpoch);
      if ((dataGenerations.get(tabId) || 0) !== generation) throw stale();
    };
    let retained;
    try {
      await updateStored(tabId, previous => {
        check();
        const cached = workspaces.get(tabId);
        // The transaction still checks the committed revision. Reuse matching
        // immutable record arrays so append-size and duplicate indexes survive
        // IndexedDB's structured clone of the same earlier records.
        const input = cached && (cached.exportRevision || 0) === (previous.exportRevision || 0) ? cached : previous;
        const changed = updater(input);
        if (changed === input) { retained = input; return previous; }
        retained = { ...changed, exportRevision: (previous.exportRevision || 0) + 1 };
        return retained;
      });
      check();
      workspaces.set(tabId, retained);
      return retained;
    } catch (error) {
      // An updater may have prepared a changed root before the disk write
      // failed. Recover from the committed database on the next request.
      if (epochOf(epochKey) === expectedEpoch && (dataGenerations.get(tabId) || 0) === generation) { workspaces.delete(tabId); summaries.delete(tabId); inventories.delete(tabId); }
      throw error;
    }
  };
  function assetInventory(tabId, state) {
    let cached = inventories.get(tabId);
    if (!cached || cached.contentRevision !== (state.contentRevision || 0)) {
      const appendOnly = cached && cached.captureCount <= state.captures.length && cached.contentRevision <= (state.contentRevision || 0);
      const captureAssets = appendOnly ? [...cached.captureAssets] : [];
      const known = new Set(captureAssets.map(asset => asset.url));
      for (const asset of collectAssets([], state.captures.slice(appendOnly ? cached.captureCount : 0))) {
        if (!known.has(asset.url)) { known.add(asset.url); captureAssets.push(asset); }
      }
      const found = new Map();
      for (const asset of [...collectAssets(state.snapshots, []), ...captureAssets]) {
        if (!found.has(asset.url)) found.set(asset.url, { ...asset, id: `asset-${String(found.size + 1).padStart(4, '0')}` });
      }
      cached = { contentRevision: state.contentRevision || 0,
        captureCount: state.captures.length, captureAssets, assets: [...found.values()] };
      inventories.set(tabId, cached);
    }
    return cached.assets;
  }
  function summary(tabId, state) {
    const revision = state.exportRevision || 0;
    let cached = summaries.get(tabId);
    if (!cached || cached.exportRevision !== revision) {
      const pick = (value, fields) => Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
      cached = { ...state, exportRevision: revision,
        snapshots: state.snapshots.map(snapshot => pick(snapshot, ['url', 'title', 'capturedAt', 'route', 'warnings', 'links', 'materialLinks'])),
        captures: state.captures.map(capture => ({ ...pick(capture, ['kind', 'url', 'pageUrl', 'receivedAt']), data: capture.data != null ? true : null })),
        assetInventory: assetInventory(tabId, state) };
      summaries.set(tabId, cached);
    }
    return cached;
  }
  const exportCommands = createExportWorkspaceCommands({ readMetadata: readExportMeta, saveSummary: saveExportProjection,
    readWorkspace, summary, release(storageId) {
      workspaces.delete(storageId); inventories.delete(storageId); summaries.delete(storageId); releaseStored(storageId);
    } });
  const sessionKey = tabId => `capture:${tabId}`;
  const captureKey = tabId => `capture-id:${tabId}`;
  const leaseKey = tabId => `collection:${tabId}`;
  const ownerKey = tabId => `collection-owner:${tabId}`;
  const pending = new Map();
  const runMutations = new Set(['END_COLLECTION', 'SAVE_COLLECTION', 'START_CAPTURE', 'STOP_CAPTURE', 'CLEAR_CAPTURE', 'TAKE_SNAPSHOT', 'PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE', 'RETRY_SOURCE_NAVIGATION']);
  const mutations = new Set(['BEGIN_COLLECTION', 'END_COLLECTION', 'SAVE_COLLECTION', 'START_CAPTURE', 'STOP_CAPTURE', 'CLEAR_CAPTURE', 'RESET_CAPTURE', 'RECONNECT_SOURCE', 'TAKE_SNAPSHOT', 'PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE', 'RETRY_SOURCE_NAVIGATION', 'BEGIN_PROBLEM_REPORT', 'APPEND_PROBLEM_EVENTS']);
  const issueWarnings = Object.freeze({
    response_too_large: 'Ответ с учебным материалом превышает допустимый размер и не сохранён. Полнота архива не подтверждена.',
    response_too_complex: 'Ответ с учебным материалом слишком сложный и не сохранён. Полнота архива не подтверждена.',
    bootstrap_overflow: 'Часть ответов, полученных при загрузке страницы, не поместилась в буфер и не сохранена.',
    bootstrap_navigation_changed: 'Во время загрузки ответов страница изменилась. Ответы с неоднозначной привязкой не сохранены.',
  });
  // Navigation identifies these materials by IDs in their path. Keep query/hash
  // in saved source references, but do not mistake view/tracking parameters for
  // a different book or section when guarding a navigation command.
  const navigationUrl = value => {
    if (!isSourceUrl(value)) return '';
    const url = new URL(value);
    return /^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(url.pathname) ||
      /^\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section(?:\/(?:\d+|for-homework))?)?\/?$/.test(url.pathname)
      ? `${url.origin}${url.pathname}` : '';
  };
  const sameMaterialPage = (left, right) => Boolean(navigationUrl(left) && navigationUrl(left) === navigationUrl(right));
  const requireDocumentToken = value => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(value)) {
      throw Object.assign(new Error('Обновите расширение и перезагрузите вкладку учебника перед сбором.'), { code: 'source_update_required' });
    }
    return value;
  };
  const exporterBinding = createExporterBinding(chrome);
  const isOwnerTab = exporterBinding.isOwner;
  const isDashboard = exporterBinding.isDashboard;
  const requireOwner = async (sender, sourceTabId, workspaceId, operation) => {
    const epoch = epochOf(sourceTabId);
    try { return await exporterBinding.requireOwner(sender.tab?.id, sourceTabId, workspaceId, { sender, operation }); }
    catch (error) {
      // A queued command can outlive its dashboard. Retain the interrupted
      // report before rejecting it, without touching a newer source epoch.
      if (error.code === 'exporter_binding_mismatch' && Number.isInteger(sourceTabId)) await activeLease(sourceTabId, undefined, epoch);
      throw error;
    }
  };
  const isSource = sender => sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) &&
    sender.frameId === 0 && isSourceUrl(sender.url);
  const problemReportCommand = createProblemReportCommands({ chrome, store: problemReports, readWorkspace, requireOwner, assertEpoch });
  const sourceNavigation = createSourceNavigation({ chrome, canonicalUrl: navigationUrl, bookKey: sourceBookKey,
    sendSource, onChange: tabId => { void notify(tabId).catch(() => {}); },
    async authorize(intent) {
      await sourceOriginsReady;
      const epoch = epochOf(intent.tabId), lease = await leaseRecord(intent.tabId);
      if (!lease || lease.collectionId !== intent.collectionId || lease.ownerTabId !== intent.ownerTabId ||
        (lease.workspaceId || null) !== (intent.workspaceId || null) || !await enabled(intent.tabId) ||
        !await isOwnerTab(intent.ownerTabId, intent.tabId, intent.workspaceId, lease.ownerDocumentId)) throw stale();
      if (lease.bookKey && lease.bookKey !== intent.bookKey) throw stale();
      if (intent.workspaceId && (await catalogue.get(intent.workspaceId))?.bookKey !== intent.bookKey) throw stale();
      assertEpoch(intent.tabId, epoch);
      return () => assertEpoch(intent.tabId, epoch);
    } });

  async function captureIdFor(tabId) {
    if (!captureIds.has(tabId)) {
      const stored = (await chrome.storage.session.get(captureKey(tabId)))[captureKey(tabId)] || null;
      if (!captureIds.has(tabId)) captureIds.set(tabId, stored);
    }
    return captureIds.get(tabId);
  }
  async function enabled(tabId) { return Boolean((await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)]); }
  async function leaseRecord(tabId) { return (await chrome.storage.session.get(leaseKey(tabId)))[leaseKey(tabId)]; }
  function enqueue(tabId, action) {
    const operation = (pending.get(tabId) || Promise.resolve()).catch(() => {}).then(action);
    pending.set(tabId, operation);
    const cleanup = () => { if (pending.get(tabId) === operation) pending.delete(tabId); };
    operation.then(cleanup, cleanup);
    return operation;
  }
  async function notify(tabId, workspaceId) {
    if (!workspaceId) workspaceId = (await leaseRecord(tabId))?.workspaceId;
    try { await chrome.runtime.sendMessage({ type: 'STATE_CHANGED', tabId, ...(workspaceId ? { workspaceId } : {}) }); } catch { /* Dashboard may be closed. */ }
  }
  function sourceError(code) {
    const message = code === 'source_closed'
      ? 'Вкладка с учебником закрыта. Откройте нужную книгу и нажмите значок расширения.'
      : 'Нет связи с книгой. Обновите вкладку книги и снова нажмите значок exporter. Старую страницу экспортера закройте.';
    return Object.assign(new Error(message), { code });
  }
  async function source(tabId) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch { throw sourceError('source_closed'); }
    if (!isSourceUrl(tab.url)) {
      const lease = await leaseRecord(tabId);
      throw sourceStatusError(await sourceNavigation.status({ tabId, ownerTabId: lease?.ownerTabId,
        collectionId: lease?.collectionId, workspaceId: lease?.workspaceId, bookKey: lease?.bookKey || sourceBookKey(tab.pendingUrl) }));
    }
    return { tabId, title: tab.title || 'Учебные материалы', url: sanitizeUrl(tab.url) };
  }
  async function capturePageUrl(sender) {
    // MessageSender.url is the document's original address and can stay on the
    // book contents after the SPA opens lessons. Read the browser-owned tab URL
    // for each response; a page-provided pageUrl is never authoritative.
    const current = new URL((await source(sender.tab.id)).url);
    const document = new URL(sender.url);
    if (current.origin !== document.origin) throw new Error('Источник ответа не совпадает с текущей вкладкой. Ответ не сохранён.');
    return current.href;
  }
  async function sendSource(tabId, message, expectedEpoch = epochOf(tabId)) {
    assertEpoch(tabId, expectedEpoch);
    const signal = controllerFor(tabId).signal;
    let response;
    try {
      response = await requestSource(() => chrome.tabs.sendMessage(tabId, message), { signal, timeoutMs: message.sourceTimeoutMs });
      assertEpoch(tabId, expectedEpoch);
    } catch (error) {
      assertEpoch(tabId, expectedEpoch);
      if (/could not establish connection|receiving end does not exist|message port closed|asynchronous response|extension context invalidated|the page keeping the extension port is moved into back\/forward cache, so the message channel is closed\.?/i.test(error?.message || '')) throw sourceError('source_disconnected');
      throw error;
    }
    if (response == null) throw sourceError('source_disconnected');
    return response;
  }
  async function stopCapture(tabId, expectedEpoch = epochOf(tabId), waitForSource = true) {
    assertEpoch(tabId, expectedEpoch);
    const captureId = await captureIdFor(tabId);
    assertEpoch(tabId, expectedEpoch);
    captureIds.set(tabId, null);
    await Promise.all([chrome.storage.session.remove(sessionKey(tabId)), chrome.storage.session.remove(captureKey(tabId))]);
    assertEpoch(tabId, expectedEpoch);
    if (!waitForSource) {
      void chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_STOP', captureId }).catch(() => {});
      return;
    }
    try { await sendSource(tabId, { type: 'CAPTURE_STOP', captureId }, expectedEpoch); }
    catch (error) { if (error.code === 'stale_collection') throw error; }
  }
  async function releaseLease(tabId, lease, interrupted = false, expectedEpoch = epochOf(tabId)) {
    await sourceNavigation.clear(tabId);
    await stopCapture(tabId, expectedEpoch, !interrupted);
    assertEpoch(tabId, expectedEpoch);
    await chrome.storage.session.remove(leaseKey(tabId));
    if (begunLeases.get(tabId)?.collectionId === lease.collectionId) begunLeases.delete(tabId);
    const reverse = (await chrome.storage.session.get(ownerKey(lease.ownerTabId)))[ownerKey(lease.ownerTabId)];
    assertEpoch(tabId, expectedEpoch);
    if (reverse === tabId) await chrome.storage.session.remove(ownerKey(lease.ownerTabId));
    if (interrupted) {
      await updateWorkspace(lease.storageId ?? tabId, state => {
        if (state.collection?.status !== 'running') return state;
        const reason = typeof interrupted === 'string' ? interrupted : 'Окно обхода или исходная вкладка закрыты. Сохранённые данные доступны для скачивания.';
        return { ...state, collection: { ...state.collection, status: 'cancelled', finishedAt: new Date().toISOString(),
          items: (state.collection.items || []).map(item => item.status === 'running' ? { ...item, status: 'cancelled' } : item),
          warnings: [...new Set([...(state.collection.warnings || []), reason])] } };
      }, expectedEpoch, tabId);
    }
    assertEpoch(tabId, expectedEpoch);
    await notify(tabId, lease.workspaceId);
  }
  async function activeLease(tabId, requesterId, expectedEpoch = epochOf(tabId)) {
    const lease = await leaseRecord(tabId);
    assertEpoch(tabId, expectedEpoch);
    if (!lease) return null;
    try {
      if (!await isOwnerTab(lease.ownerTabId, tabId, lease.workspaceId, lease.ownerDocumentId)) throw new Error('Owner navigated away');
    }
    catch {
      assertEpoch(tabId, expectedEpoch);
      await releaseLease(tabId, lease, true, expectedEpoch);
      if (requesterId === lease.ownerTabId) throw new Error('Окно обхода закрыто. Повторно откройте расширение.');
      return null;
    }
    assertEpoch(tabId, expectedEpoch);
    return lease;
  }

  async function resolveWorkspace(tabId, workspaceId) {
    if (workspaceId) {
      const retained = await catalogue.get(workspaceId);
      if (!retained) throw new Error('Сохранённая книга недоступна в этой сессии Chrome.');
      return retained;
    }
    const current = await source(tabId);
    let entries = await catalogue.list();
    if (!entries.some(entry => entry.storageId === tabId)) {
      await catalogue.adopt(tabId, await readStored(tabId));
      entries = await catalogue.list();
    }
    const candidates = entries.filter(entry => entry.bookKey === sourceBookKey(current.url));
    let active;
    for (const candidate of candidates) {
      const lease = Number.isInteger(candidate.sourceTabId) && await leaseRecord(candidate.sourceTabId);
      if (lease?.workspaceId === candidate.workspaceId) { active = candidate; break; }
    }
    if (active) return active;
    return catalogue.resolve({ sourceTabId: tabId, url: current.url });
  }
  const openingExporters = new Map();
  chrome.action.onClicked.addListener(tab => {
    const preparingSource = prepareSourceSite(chrome, tab);
    void preparingSource.catch(() => {});
    const open = async () => {
      await sourceOriginsReady;
      await preparingSource;
      if (!sourceBookKey(tab.url)) return chrome.tabs.create({ url: chrome.runtime.getURL('exporter.html') });
      const workspace = await resolveWorkspace(tab.id);
      const lease = await activeLease(workspace.sourceTabId);
      const exporterTabId = lease?.workspaceId === workspace.workspaceId ? lease.ownerTabId : workspace.exporterTabId;
      if (Number.isInteger(exporterTabId)) {
        const previous = await exporterBinding.requireOwner(exporterTabId, workspace.sourceTabId, workspace.workspaceId).catch(() => null);
        if (previous &&
            new URL(previous.url).searchParams.get('tab') === String(workspace.sourceTabId)) {
          await chrome.tabs.update(previous.id, { active: true });
          if (chrome.windows?.update && Number.isInteger(previous.windowId)) await chrome.windows.update(previous.windowId, { focused: true });
          return;
        }
      }
      const url = chrome.runtime.getURL(`exporter.html?workspace=${workspace.workspaceId}&tab=${workspace.sourceTabId}`);
      const created = await chrome.tabs.create({ url });
      if (Number.isInteger(created?.id)) await catalogue.update(workspace.workspaceId, { exporterTabId: created.id });
    };
    const key = sourceBookKey(tab.url) || 'no-book';
    const operation = (openingExporters.get(key) || Promise.resolve()).catch(() => {}).then(open);
    openingExporters.set(key, operation);
    const clear = () => { if (openingExporters.get(key) === operation) openingExporters.delete(key); };
    operation.then(clear, clear);
    return operation.catch(error => {
      const code = ['source_unsupported', 'permission_denied'].includes(error?.code) ? error.code : 'source_unavailable';
      return chrome.tabs.create({ url: chrome.runtime.getURL(`exporter.html?sourceError=${code}`) });
    });
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    exporterBinding.invalidate(tabId);
    void sourceNavigation.clear(tabId).catch(() => {});
    const cleanup = async () => {
      const ownedSource = (await chrome.storage.session.get(ownerKey(tabId)))[ownerKey(tabId)];
      try {
        if (Number.isInteger(ownedSource)) {
          await enqueue(ownedSource, async () => {
            const lease = await leaseRecord(ownedSource);
            if (lease?.ownerTabId === tabId) await releaseLease(ownedSource, lease, true);
            else await chrome.storage.session.remove(ownerKey(tabId));
          });
        }
        await enqueue(tabId, async () => {
          const lease = await leaseRecord(tabId);
          if (lease) await releaseLease(tabId, lease, true);
          else await chrome.storage.session.remove(sessionKey(tabId));
        });
      } finally {
        // Retain the committed book on disk for download, while releasing its
        // potentially large worker cache after the final lease update.
        const entries = await catalogue.list();
        const scoped = entries.filter(entry => entry.sourceTabId === tabId || entry.exporterTabId === tabId || entry.sourceTabId === ownedSource);
        for (const id of new Set([tabId, ownedSource, ...scoped.map(entry => entry.storageId)])) {
          if (id == null) continue;
          const retained = workspaces.has(id);
          workspaces.delete(id); inventories.delete(id); summaries.delete(id);
          if (retained) await releaseStored(id);
        }
      }
    };
    void cleanup().catch(() => {});
  });
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (!changeInfo.url && !['loading', 'complete'].includes(changeInfo.status)) return;
    exporterBinding.invalidate(tabId, changeInfo);
    if (!changeInfo.url && changeInfo.status !== 'loading') return;
    const cleanup = async () => {
      const sourceTabId = (await chrome.storage.session.get(ownerKey(tabId)))[ownerKey(tabId)];
      if (!Number.isInteger(sourceTabId)) return;
      await enqueue(sourceTabId, async () => {
        const lease = await leaseRecord(sourceTabId);
        if (lease?.ownerTabId === tabId && !await isOwnerTab(tabId, sourceTabId, lease.workspaceId, lease.ownerDocumentId)) await releaseLease(sourceTabId, lease, true);
      });
    };
    void cleanup().catch(() => {});
  });

  function assertCollectionBook(state, lease, pageUrl) {
    if (!lease || state.collection?.status !== 'running' || !isSourceUrl(state.collection.rootUrl)) return;
    const root = new URL(state.collection.rootUrl), current = new URL(pageUrl);
    const book = root.pathname.match(/\/book\/([^/]+)/)?.[1];
    if (book && (current.origin !== root.origin || current.pathname.match(/\/book\/([^/]+)/)?.[1] !== book)) {
      throw new Error('Исходная вкладка перешла в другой учебник. Ответ не сохранён.');
    }
  }

  async function resetCapture(message, sender, authorized) {
    const tabId = message.tabId;
    const workspace = message.workspaceId ? await resolveWorkspace(null, message.workspaceId) : null;
    const storageId = workspace?.storageId ?? tabId;
    if (!isDashboard(sender) || !Number.isSafeInteger(tabId) || tabId <= 0) throw stale();
    await requireOwner(sender, tabId, workspace?.workspaceId, message.type);
    const sourceLease = await leaseRecord(tabId);
    const lease = sourceLease && (!workspace || sourceLease.workspaceId === workspace.workspaceId) ? sourceLease : null;
    if (lease && lease.ownerTabId !== sender.tab.id) {
      if (await isOwnerTab(lease.ownerTabId, tabId, lease.workspaceId, lease.ownerDocumentId)) throw new Error('Эта вкладка уже собирается в другом окне экспортера. Остановите обход в том окне.');
    }
    let book;
    let requireStoredBook = false;
    if (message.book !== undefined) {
      const value = message.book;
      if (!value || typeof value.title !== 'string' || value.title.length > 500 || typeof value.rootUrl !== 'string' ||
        value.rootUrl.length > 2048 || !/^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(new URL(navigationUrl(value.rootUrl) || 'https://invalid/').pathname)) throw new Error('Не удалось определить выбранный учебник.');
      book = { title: value.title.trim(), rootUrl: navigationUrl(value.rootUrl) };
      if (workspace && sourceBookKey(book.rootUrl) !== workspace.bookKey) throw new Error('Сохранённые материалы относятся к другой книге.');
      let current;
      try { current = await chrome.tabs.get(tabId); } catch { /* A closed source can still be reset. */ }
      if (current && isSourceUrl(current.url)) {
        const actual = new URL(current.url), selected = new URL(book.rootUrl);
        requireStoredBook = actual.origin !== selected.origin || actual.pathname.match(/\/book\/(\d+)/)?.[1] !== selected.pathname.match(/\/book\/(\d+)/)?.[1];
      }
    }
    if (workspace) { book ||= workspace.book || undefined; requireStoredBook = false; }
    await captureIdFor(tabId);
    const captureId = captureIds.get(tabId);
    const begun = begunLeases.get(tabId);
    const latestLease = begun && (!workspace || begun.workspaceId === workspace.workspaceId) ? begun : lease;
    if (latestLease && latestLease.collectionId !== lease?.collectionId && latestLease.ownerTabId !== sender.tab.id) throw new Error('Эта вкладка уже собирается в другом окне экспортера. Остановите обход в том окне.');
    authorized?.();
    const affectsSource = !workspace || !sourceLease || sourceLease.workspaceId === workspace.workspaceId;
    const epoch = epochOf(tabId) + (affectsSource ? 1 : 0);
    if (affectsSource) {
      epochs.set(tabId, epoch);
      await sourceNavigation.clear(tabId);
      captureIds.set(tabId, null);
      begunLeases.delete(tabId);
      controllers.get(tabId)?.abort();
      controllers.delete(tabId);
      // Guarded by the previous capture ID: a delayed stop cannot stop a new run.
      void chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_STOP', captureId }).catch(() => {});
      const removals = [sessionKey(tabId), captureKey(tabId), leaseKey(tabId), ownerKey(sender.tab.id)];
      if (latestLease) removals.push(ownerKey(latestLease.ownerTabId));
      await Promise.all(removals.map(key => chrome.storage.session.remove(key)));
    }
    dataGenerations.set(storageId, (dataGenerations.get(storageId) || 0) + 1);
    workspaces.delete(storageId); summaries.delete(storageId); inventories.delete(storageId);
    assertEpoch(tabId, epoch);
    let state;
    try { state = await resetStored(storageId, { book, requireStoredBook }); }
    catch (error) {
      // A rejected atomic book guard leaves the old dataset intact. The run was
      // already revoked, so its last running report must not appear to continue.
      if (epochOf(tabId) === epoch) {
        try {
          await updateWorkspace(storageId, previous => previous.collection?.status === 'running' ? {
            ...previous, collection: { ...previous.collection, status: 'cancelled', finishedAt: new Date().toISOString(),
              warnings: [...new Set([...(previous.collection.warnings || []), 'Сброс не выполнен. Обход остановлен; сохранённые материалы доступны.'])] },
          } : previous, epoch, tabId);
        } catch { /* Retain the reset error if the disk also rejects cancellation. */ }
      }
      throw error;
    }
    assertEpoch(tabId, epoch);
    workspaces.set(storageId, state);
    summaries.delete(storageId); inventories.delete(storageId);
    let diagnosticStorageError = false;
    try { await problemReports.clear(workspace?.workspaceId || tabId); }
    catch { diagnosticStorageError = true; }
    assertEpoch(tabId, epoch);
    if (workspace) await catalogue.update(workspace.workspaceId, { state });
    await notify(tabId, workspace?.workspaceId);
    return { ok: true, state: { ...state, enabled: false, collectionLocked: false },
      ...(diagnosticStorageError ? { diagnosticStorageError: true } : {}) };
  }

  async function cancelCollection(message, sender, authorized) {
    const tabId = message.tabId;
    if (!isDashboard(sender) || !Number.isSafeInteger(tabId) || tabId <= 0) throw stale();
    const preflight = collectionIntents.get(tabId);
    const active = begunLeases.get(tabId) || await leaseRecord(tabId);
    if (!active && !begunLeases.has(tabId) && preflight && collectionIntents.get(tabId) === preflight &&
      preflight.ownerTabId === sender.tab.id && preflight.documentId === sender.documentId &&
      (preflight.workspaceId || null) === (message.workspaceId || null) && preflight.requestId === message.requestId) {
      assertEpoch(tabId, preflight.epoch);
      authorized?.();
      epochs.set(tabId, preflight.epoch + 1);
      collectionIntents.delete(tabId);
      controllers.get(tabId)?.abort(); controllers.delete(tabId);
      await sourceNavigation.clear(tabId);
      await notify(tabId, message.workspaceId);
      return { ok: true, cancelled: true };
    }
    const workspace = message.workspaceId ? await resolveWorkspace(null, message.workspaceId) : null;
    await requireOwner(sender, tabId, workspace?.workspaceId, message.type);
    const lease = await leaseRecord(tabId);
    const intent = begunLeases.get(tabId) || lease || collectionIntents.get(tabId);
    if (!intent) return { ok: true, cancelled: false };
    if (intent.ownerTabId !== sender.tab.id || intent.ownerDocumentId && intent.ownerDocumentId !== sender.documentId ||
      intent.documentId && intent.documentId !== sender.documentId || workspace && intent.workspaceId !== workspace.workspaceId ||
      message.collectionId && message.collectionId !== intent.collectionId ||
      message.requestId && message.requestId !== intent.requestId) throw stale();
    if (!message.collectionId && !message.requestId && !collectionIntents.has(tabId)) throw stale();
    authorized?.();
    const epoch = epochOf(tabId) + 1;
    epochs.set(tabId, epoch);
    await sourceNavigation.clear(tabId);
    controllers.get(tabId)?.abort(); controllers.delete(tabId);
    const captureId = captureIds.get(tabId) ?? await captureIdFor(tabId);
    captureIds.set(tabId, null); begunLeases.delete(tabId); collectionIntents.delete(tabId);
    void chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_STOP', captureId }).catch(() => {});
    await Promise.all([sessionKey(tabId), captureKey(tabId), leaseKey(tabId), ownerKey(sender.tab.id)].map(key => chrome.storage.session.remove(key)));
    assertEpoch(tabId, epoch);
    const storageId = workspace?.storageId ?? tabId;
    dataGenerations.set(storageId, (dataGenerations.get(storageId) || 0) + 1);
    workspaces.delete(storageId); summaries.delete(storageId); inventories.delete(storageId);
    const state = await updateWorkspace(storageId, cancelledCollection, epoch, tabId);
    if (workspace) await catalogue.update(workspace.workspaceId, { state });
    await notify(tabId, workspace?.workspaceId);
    return { ok: true, cancelled: true, state: { ...summary(storageId, state), enabled: false, collectionLocked: false } };
  }

  async function handle(message, sender, expectedEpoch, expectedIntent) {
    const tabIdForEpoch = isSource(sender) ? sender.tab.id : message.tabId;
    const assertPreflight = () => {
      assertEpoch(tabIdForEpoch, expectedEpoch);
      if (expectedIntent && collectionIntents.get(tabIdForEpoch) !== expectedIntent) throw stale();
    };
    assertPreflight();
    let workspace = null;
    if (message.workspaceId && message.type !== 'RESOLVE_WORKSPACE') {
      if (!isDashboard(sender)) throw new Error('Недоступная команда.');
      workspace = await resolveWorkspace(null, message.workspaceId);
      await requireOwner(sender, message.tabId, workspace.workspaceId, message.type);
      assertPreflight();
    } else if (isDashboard(sender)) {
      await requireOwner(sender, message.type === 'RESOLVE_WORKSPACE' ? undefined : message.tabId, undefined, message.type);
      assertPreflight();
    } else if (isSource(sender)) {
      const lease = await leaseRecord(sender.tab.id);
      if (lease?.workspaceId) workspace = await resolveWorkspace(null, lease.workspaceId);
    }
    const storageId = workspace?.storageId ?? tabIdForEpoch;
    const updateForRun = (_tabId, updater) => updateWorkspace(storageId, updater, expectedEpoch, tabIdForEpoch);

    if (message.type === 'CAPTURE_READY') {
      if (!isSource(sender)) return { enabled: false };
      await activeLease(sender.tab.id, undefined, expectedEpoch);
      const captureId = await captureIdFor(sender.tab.id);
      assertEpoch(sender.tab.id, expectedEpoch);
      return { enabled: Boolean(captureId && await enabled(sender.tab.id)), captureId };
    }
    if (message.type === 'CAPTURE_EVENT' || message.type === 'CAPTURE_ISSUE') {
      if (!isSource(sender)) return { ok: false, error: 'Сбор выключен.' };
      const lease = await activeLease(sender.tab.id, undefined, expectedEpoch);
      const captureId = await captureIdFor(sender.tab.id);
      if (!captureId || message.captureId !== captureId) throw stale('stale_capture');
      if (!await enabled(sender.tab.id)) return { ok: false, error: 'Сбор выключен.' };
      const pageUrl = await capturePageUrl(sender);
      if (message.observedUrl !== undefined && !sameMaterialPage(message.observedUrl, pageUrl)) {
        throw Object.assign(new Error('Раздел изменился до сохранения ответа.'), { code: 'source_changed' });
      }
      let exerciseCapture;
      if (message.type === 'CAPTURE_ISSUE' && !Object.hasOwn(issueWarnings, message.code)) throw new Error('Неизвестная ошибка сбора.');
      await updateForRun(sender.tab.id, state => {
        // Only a running collection determines a selected book. The sender's
        // original document may belong to a previously opened SPA book.
        assertCollectionBook(state, lease, pageUrl);
        if (message.type === 'CAPTURE_ISSUE') {
          const warning = issueWarnings[message.code];
          return { ...state, dropped: (state.dropped || 0) + 1,
            warnings: [...new Set([...(state.warnings || []), warning])], updatedAt: new Date().toISOString() };
        }
        const before = state.dropped || 0;
        const incoming = redactSensitive({ ...message.event, pageUrl });
        const next = appendCapture(state, incoming);
        if ((next.dropped || 0) === before && ['fetch', 'xhr', 'websocket'].includes(incoming.kind) && classifyMaterialPayload(incoming)) {
          exerciseCapture = exerciseCaptureObservation(incoming, pageUrl, next.captures);
        }
        return next;
      });
      await notify(sender.tab.id);
      return { ok: true, ...(exerciseCapture ? { exerciseCapture } : {}) };
    }
    if (!isDashboard(sender)) return { ok: false, error: 'Недоступная команда.' };
    if (message.type === 'RESOLVE_WORKSPACE') {
      const selected = await resolveWorkspace(message.tabId, message.selectedWorkspaceId || message.workspaceId);
      const lease = Number.isInteger(selected.sourceTabId) ? await activeLease(selected.sourceTabId) : null;
      const ownerTabId = lease?.workspaceId === selected.workspaceId ? lease.ownerTabId : null;
      if (Number.isInteger(sender.tab?.id) && !ownerTabId) await catalogue.update(selected.workspaceId, { exporterTabId: sender.tab.id });
      return { ok: true, workspaceId: selected.workspaceId, sourceTabId: selected.sourceTabId, bookKey: selected.bookKey, book: selected.book, ...(ownerTabId ? { ownerTabId } : {}) };
    }
    const tabId = message.tabId;
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('Откройте учебные материалы и нажмите значок расширения в этой вкладке.');
    const sourceLease = await activeLease(tabId, sender.tab?.id, expectedEpoch);
    const lease = sourceLease && (!workspace || sourceLease.workspaceId === workspace.workspaceId) ? sourceLease : null;
    if (workspace && mutations.has(message.type) && !isProblemReportCommand(message.type) && !['SAVE_COLLECTION', 'STOP_CAPTURE', 'END_COLLECTION', 'RETRY_SOURCE_NAVIGATION'].includes(message.type)) {
      if (workspace.sourceTabId !== tabId) throw Object.assign(new Error('Эта книга открыта в другой вкладке. Перейдите в неё и нажмите значок расширения.'), { code: 'source_changed' });
      if (sourceLease && sourceLease.workspaceId !== workspace.workspaceId) throw new Error('Эта вкладка уже собирает другую книгу. Дождитесь завершения или откройте книгу в отдельной вкладке.');
      const current = await source(tabId);
      if (sourceBookKey(current.url) !== workspace.bookKey) throw Object.assign(new Error('В исходной вкладке открыта другая книга. Откройте нужную книгу и нажмите значок расширения.'), { code: 'source_changed' });
    }
    if (lease && mutations.has(message.type) && lease.ownerTabId !== sender.tab?.id) throw new Error('Эта вкладка уже собирается в другом окне экспортера. Остановите обход в том окне.');
    if (runMutations.has(message.type) && (!lease || !lease.collectionId || message.collectionId !== lease.collectionId)) throw stale();
    // A message sent just before the owner navigated away can arrive after its
    // lease cleanup. It must not restore a running report or restart capture.
    if (!lease && mutations.has(message.type) && Number.isInteger(sender.tab?.id)) {
      await requireOwner(sender, tabId, workspace?.workspaceId, message.type);
    }
    if (isProblemReportCommand(message.type)) {
      if (message.type === 'BEGIN_PROBLEM_REPORT' && message.kind === 'collection' && !lease) throw stale();
      return problemReportCommand({ ...message, ...(workspace ? { storageId, workspaceId: workspace.workspaceId } : {}) }, sender, expectedEpoch);
    }
    switch (message.type) {
      case 'BEGIN_COLLECTION': {
        const ownerTabId = sender.tab?.id;
        if (!Number.isInteger(ownerTabId) || ownerTabId <= 0) throw new Error('Обход должен запускаться из вкладки экспортера.');
        await requireOwner(sender, tabId, workspace?.workspaceId, message.type);
        const currentSource = await source(tabId);
        const previousSource = (await chrome.storage.session.get(ownerKey(ownerTabId)))[ownerKey(ownerTabId)];
        if (Number.isInteger(previousSource) && previousSource !== tabId && await activeLease(previousSource)) throw new Error('В этом окне уже запущен обход другого источника.');
        const previousPersistence = leasePersistence.get(tabId);
        if (previousPersistence) await previousPersistence;
        assertPreflight();
        const collectionId = lease?.collectionId || crypto.randomUUID();
        const scoped = { ownerTabId, ownerDocumentId: sender.documentId, collectionId, bookKey: workspace?.bookKey || sourceBookKey(currentSource.url),
          ...(message.requestId ? { requestId: message.requestId } : {}), ...(workspace ? { workspaceId: workspace.workspaceId, storageId } : {}) };
        begunLeases.set(tabId, scoped);
        const persisted = chrome.storage.session.set({ [leaseKey(tabId)]: scoped, [ownerKey(ownerTabId)]: tabId }).then(async () => {
          if (epochOf(tabId) === expectedEpoch) return;
          const late = await leaseRecord(tabId);
          if (late?.collectionId === collectionId) await Promise.all([leaseKey(tabId), ownerKey(ownerTabId)].map(key => chrome.storage.session.remove(key)));
        });
        leasePersistence.set(tabId, persisted);
        try { await persisted; } finally { if (leasePersistence.get(tabId) === persisted) leasePersistence.delete(tabId); }
        assertPreflight();
        collectionIntents.delete(tabId);
        return { ok: true, collectionId };
      }
      case 'END_COLLECTION': {
        if (lease) await releaseLease(tabId, lease, 'Обход остановлен. Сохранённые данные доступны для скачивания.', expectedEpoch);
        return { ok: true };
      }
      case 'GET_SOURCE': return { ok: true, source: await source(tabId) };
      case 'GET_SOURCE_STATUS': {
        await requireOwner(sender, tabId, workspace?.workspaceId, message.type);
        if (message.collectionId && (!lease || message.collectionId !== lease.collectionId || lease.ownerTabId !== sender.tab?.id)) throw stale();
        return { ok: true, sourceStatus: await sourceNavigation.status({ tabId, ownerTabId: sender.tab?.id,
          collectionId: lease?.collectionId, workspaceId: workspace?.workspaceId, bookKey: workspace?.bookKey || lease?.bookKey }, message.transitionId) };
      }
      case 'RETRY_SOURCE_NAVIGATION': {
        if (!lease) throw stale();
        await requireOwner(sender, tabId, workspace?.workspaceId, message.type);
        return await sourceNavigation.retry({ tabId, ownerTabId: sender.tab?.id, collectionId: lease.collectionId,
          workspaceId: workspace?.workspaceId, bookKey: workspace?.bookKey || lease.bookKey }, message.transitionId);
      }
      case 'GET_STATE': {
        const projection = message.summary ? await exportCommands.readSummary(storageId) : null;
        const state = projection || await readWorkspace(storageId);
        return { ok: true, state: { ...(message.summary && !projection ? summary(storageId, state) : state), ...(workspace?.book && !state.book ? { book: workspace.book } : {}), enabled: Boolean((!workspace || lease) && await enabled(tabId)), collectionLocked: Boolean(lease && lease.ownerTabId !== sender.tab?.id), ...(lease?.ownerTabId === sender.tab?.id ? { collectionId: lease.collectionId } : {}) } };
      }
      case 'GET_EXPORT_INFO': {
        return { ok: true, ...await exportCommands.info(storageId) };
      }
      case 'RECORD_DOWNLOAD_RESULT': {
        if (!workspace) throw new Error('Откройте нужную книгу и нажмите значок расширения, чтобы скачать материалы.');
        const state = saveExportResult ? await saveExportResult(storageId, message)
          : await updateForRun(tabId, previous => recordDownloadResult(previous, message));
        if (saveExportResult) { workspaces.delete(storageId); summaries.delete(storageId); inventories.delete(storageId); releaseStored(storageId); }
        await catalogue.update(workspace.workspaceId, { state });
        await notify(tabId, workspace.workspaceId);
        return { ok: true, downloadResult: state.downloadResult, revision: state.exportRevision };
      }
      case 'GET_EXPORT_RECORDS': {
        if (readExportPage) return { ok: true, ...await readExportPage(storageId, message) };
        const state = await readWorkspace(storageId), revision = state.exportRevision || 0;
        if (!Number.isSafeInteger(message.revision) || message.revision !== revision) throw Object.assign(new Error('Собранные материалы изменились во время подготовки архива. Повторите скачивание.'), { code: 'export_changed' });
        if (!['snapshots', 'captures'].includes(message.kind) || !Number.isSafeInteger(message.offset) || message.offset < 0 ||
          !Number.isSafeInteger(message.limit) || message.limit < 1 || message.limit > 32 || message.offset > state[message.kind].length) throw new Error('Недопустимая страница исходных записей.');
        const sourceRecords = state[message.kind], records = [];
        let bytes = 0;
        for (const record of sourceRecords.slice(message.offset, message.offset + message.limit)) {
          const size = new TextEncoder().encode(JSON.stringify(record)).length;
          if (records.length && bytes + size > 12 * 1024 * 1024) break;
          if (size > 12 * 1024 * 1024) throw new Error('Сохранённая запись слишком большая для передачи браузером. Начните новый сбор обновлённым расширением.');
          records.push(record); bytes += size;
        }
        return { ok: true, records, nextOffset: message.offset + records.length, total: sourceRecords.length, revision };
      }
      case 'START_CAPTURE': {
        await source(tabId);
        assertEpoch(tabId, expectedEpoch);
        const captureId = crypto.randomUUID();
        captureIds.set(tabId, captureId);
        await chrome.storage.session.set({ [sessionKey(tabId)]: true, [captureKey(tabId)]: captureId });
        try {
          assertEpoch(tabId, expectedEpoch);
          const response = await sendSource(tabId, { type: 'CAPTURE_START', captureId }, expectedEpoch);
          if (!response?.ok) throw new Error(response?.error || 'Сбор не включился.');
          if (response.captureId !== captureId) throw Object.assign(new Error('Обновите расширение и перезагрузите вкладку учебника. Старая версия страницы не поддерживает безопасный сброс.'), { code: 'source_update_required' });
        } catch (error) {
          if (captureIds.get(tabId) === captureId) {
            captureIds.set(tabId, null);
            await Promise.all([chrome.storage.session.remove(sessionKey(tabId)), chrome.storage.session.remove(captureKey(tabId))]);
          }
          throw error;
        }
        await notify(tabId);
        return { ok: true, captureId };
      }
      case 'STOP_CAPTURE': {
        await stopCapture(tabId, expectedEpoch);
        await notify(tabId);
        return { ok: true };
      }
      case 'TAKE_SNAPSHOT': {
        const current = await source(tabId);
        if (message.expectedUrl && !sameMaterialPage(message.expectedUrl, current.url)) throw new Error('Исходная вкладка изменилась. Обход остановлен.');
        const document = message.expectedUrl || message.expectedDocumentToken !== undefined
          ? { expectedDocumentToken: requireDocumentToken(message.expectedDocumentToken) } : {};
        const response = await sendSource(tabId, { type: 'PAGE_SNAPSHOT', ...document, expectedVisitToken: message.expectedVisitToken, requireExerciseCapture: message.requireExerciseCapture === true }, expectedEpoch);
        if (!response?.ok || !response.snapshot) throw Object.assign(new Error(response?.error || 'Не удалось прочитать страницу.'), { code: response?.code });
        if (message.expectedUrl && !sameMaterialPage(message.expectedUrl, response.snapshot.url)) throw new Error('Раздел изменился во время сохранения.');
        let dropped = false, reason = '', retained;
        await updateForRun(tabId, state => {
          if (message.requireExerciseCapture && response.snapshot.route?.kind === 'lesson' && !hasExerciseCapture(state.captures, response.snapshot.url)) {
            throw Object.assign(new Error('Исходные задания текущего раздела ещё не подтверждены. Снимок не сохранён.'), { code: 'author_data_missing' });
          }
          const before = state.dropped || 0;
          const next = appendSnapshot(state, response.snapshot);
          dropped = (next.dropped || 0) > before;
          if (dropped) reason = next.warnings?.at(-1) || 'Достигнут лимит локального хранения.';
          // The collector checks earlier capture losses from this reply instead
          // of requesting a recomputed summary after every page.
          retained = { dropped: next.dropped || 0, ...(next.warnings?.length ? { warning: next.warnings.at(-1) } : {}) };
          if (response.snapshot.route?.kind === 'lesson') {
            retained.authorData = hasExerciseCapture(next.captures, response.snapshot.url);
          }
          return next;
        });
        if (!dropped && message.expectedDocumentToken) await sourceNavigation.complete(tabId, response.snapshot.url);
        await notify(tabId);
        if (dropped) throw new Error(`Снимок не сохранён: ${reason}`);
        return { ok: true, snapshotUrl: message.expectedUrl ? navigationUrl(response.snapshot.url) : response.snapshot.url,
          savedSnapshotUrl: sanitizeUrl(response.snapshot.url), retained };
      }
      case 'GET_NAVIGATION': {
        if (message.transitionId) {
          if (!lease) throw stale();
          await sourceNavigation.validate({ tabId, ownerTabId: sender.tab?.id, collectionId: lease.collectionId,
            workspaceId: workspace?.workspaceId, bookKey: workspace?.bookKey || lease.bookKey }, message.transitionId);
        }
        const expectedUrl = message.expectedUrl;
        const guarded = expectedUrl !== undefined;
        const changed = () => Object.assign(new Error('Исходная вкладка перешла на другую страницу. Откройте нужную книгу и нажмите значок расширения.'), { code: 'source_changed' });
        const current = await source(tabId);
        if (guarded && !sameMaterialPage(expectedUrl, current.url)) throw changed();
        const document = message.expectedDocumentToken !== undefined
          ? { expectedDocumentToken: requireDocumentToken(message.expectedDocumentToken) } : {};
        assertPreflight();
        const response = await sendSource(tabId, { type: 'MATERIAL_NAVIGATION', ...document, expectedVisitToken: message.expectedVisitToken,
          ...(message.sourceTimeoutMs !== undefined ? { sourceTimeoutMs: message.sourceTimeoutMs } : {}) }, expectedEpoch);
        assertPreflight();
        if (guarded) {
          // A source tab can change books while its content script is replying.
          // Never attach that reply's title to the previously selected URL.
          const latest = await source(tabId);
          if (!sameMaterialPage(expectedUrl, latest.url) ||
            response?.ok && !sameMaterialPage(expectedUrl, response.navigation?.url)) throw changed();
        }
        if (response?.ok && document.expectedDocumentToken) {
          const actual = requireDocumentToken(response.navigation?.documentToken);
          if (actual !== document.expectedDocumentToken) throw changed();
        }
        if (workspace && response?.ok && response.navigation?.kind === 'book' && sourceBookKey(response.navigation.url) === workspace.bookKey) {
          await catalogue.update(workspace.workspaceId, { book: { title: response.navigation.title || workspace.book?.title, rootUrl: response.navigation.url } });
        }
        if (response?.ok && response.navigation) sourceNavigation.remember(tabId, response.navigation);
        return response;
      }
      case 'PREPARE_BOOK': {
        const current = await source(tabId);
        if (!lease || lease.ownerTabId !== sender.tab?.id || !await enabled(tabId)) throw new Error('Сначала запустите сбор учебника.');
        if (!sameMaterialPage(message.expectedUrl, current.url) || !/^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(new URL(current.url).pathname)) throw new Error('Можно раскрыть только содержание выбранного учебника.');
        const response = await sendSource(tabId, { type: 'PREPARE_BOOK', expectedUrl: navigationUrl(current.url),
          expectedDocumentToken: requireDocumentToken(message.expectedDocumentToken),
          ...(message.sourceTimeoutMs !== undefined ? { sourceTimeoutMs: message.sourceTimeoutMs } : {}) }, expectedEpoch);
        if (response?.ok && response.navigation) sourceNavigation.remember(tabId, response.navigation);
        return response;
      }
      case 'OPEN_MATERIAL_ITEM': {
        const current = await source(tabId);
        if (!await enabled(tabId)) throw new Error('Сначала включите сбор.');
        if (!sameMaterialPage(message.expectedUrl, current.url)) throw new Error('Исходная вкладка изменилась. Обход остановлен.');
        return await sourceNavigation.navigate({ tabId, ownerTabId: sender.tab?.id, collectionId: lease.collectionId,
          workspaceId: workspace?.workspaceId, bookKey: workspace?.bookKey || sourceBookKey(current.url) },
        { type: 'OPEN_MATERIAL_ITEM', key: message.key, expectedUrl: navigationUrl(current.url),
          expectedDocumentToken: requireDocumentToken(message.expectedDocumentToken), expectedVisitToken: message.expectedVisitToken });
      }
      case 'NAVIGATE_SOURCE': {
        const current = await source(tabId);
        if (!await enabled(tabId) || !sameMaterialPage(current.url, message.expectedUrl) || !isSourceUrl(message.url)) throw new Error('Переход вне текущей книги запрещён.');
        const target = new URL(message.url);
        const previous = new URL(current.url);
        const reloadSection = message.url === message.expectedUrl && sameMaterialPage(current.url, target.href) &&
          /^\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section\/(?:\d+|for-homework))?\/?$/.test(previous.pathname);
        const book = previous.pathname.match(/\/book\/([^/]+)/)?.[1];
        if (!reloadSection && (!book || target.origin !== previous.origin || target.pathname.match(/\/book\/([^/]+)/)?.[1] !== book ||
          !/^\/cabinet\/(?:school|teacher)\/materials\/book\/[^/]+\/content\/?$/.test(target.pathname) || target.search || target.hash)) throw new Error('Разрешён только возврат к содержанию текущей книги.');
        return await sourceNavigation.navigate({ tabId, ownerTabId: sender.tab?.id, collectionId: lease.collectionId,
          workspaceId: workspace?.workspaceId, bookKey: workspace?.bookKey || sourceBookKey(current.url) },
        { type: 'NAVIGATE_SOURCE', expectedUrl: navigationUrl(current.url),
          expectedDocumentToken: requireDocumentToken(message.expectedDocumentToken), url: target.href,
          reload: reloadSection || current.url === target.href, ...(message.expectedVisitToken !== undefined ? { expectedVisitToken: message.expectedVisitToken } : {}) });
      }
      case 'SAVE_COLLECTION': {
        const report = message.collection;
        if (!report || !['running', 'finished', 'failed', 'cancelled'].includes(report.status) || new TextEncoder().encode(JSON.stringify(report)).length > 16 * 1024 * 1024) throw new Error('Недопустимый отчёт обхода.');
        await updateForRun(tabId, state => ({ ...state, collection: redactSensitive(report) }));
        if (workspace) await catalogue.update(workspace.workspaceId, { state: await readWorkspace(storageId) });
        await notify(tabId);
        return { ok: true };
      }
      case 'CLEAR_CAPTURE': {
        await stopCapture(tabId, expectedEpoch);
        await updateForRun(tabId, () => ({ ...createWorkspace(storageId), ...(workspace?.book ? { book: workspace.book } : {}) }));
        inventories.delete(storageId);
        await notify(tabId);
        return { ok: true };
      }
      case 'RECONNECT_SOURCE': {
        if (lease) throw new Error('Сначала остановите сбор учебника, затем переподключите его.');
        await source(tabId);
        await stopCapture(tabId, expectedEpoch);
        // Reloading is an explicit recovery action and must retain the archive.
        try { await chrome.tabs.reload(tabId); }
        catch { throw sourceError('source_closed'); }
        await notify(tabId);
        return { ok: true };
      }
      default: throw new Error('Неизвестная команда.');
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || typeof message.type !== 'string' || message.type === 'STATE_CHANGED') return false;
    const dispatch = scoped => {
      const key = isSource(sender) ? sender.tab.id : scoped.tabId || 0;
      const expectedEpoch = epochOf(key);
      const previousIntent = collectionIntents.get(key);
      const newPreflight = scoped.type === 'GET_NAVIGATION' && scoped.requestId && previousIntent?.ownerTabId === sender.tab?.id &&
        previousIntent.workspaceId === scoped.workspaceId && previousIntent.requestId !== scoped.requestId;
      let marker = previousIntent?.ownerTabId === sender.tab?.id && previousIntent.documentId === sender.documentId &&
        previousIntent.workspaceId === scoped.workspaceId && previousIntent.requestId === scoped.requestId &&
        previousIntent.epoch === expectedEpoch ? previousIntent : undefined;
      if ((scoped.type === 'BEGIN_COLLECTION' || scoped.type === 'GET_NAVIGATION' && scoped.requestId) && isDashboard(sender) && exporterBinding.matches(sender.url, key, scoped.workspaceId) &&
          (!previousIntent || newPreflight) && !begunLeases.has(key)) {
        marker = { ownerTabId: sender.tab.id, documentId: sender.documentId, workspaceId: scoped.workspaceId, requestId: scoped.requestId, epoch: expectedEpoch };
        collectionIntents.set(key, marker);
      }
      let task;
      if (['RESET_CAPTURE', 'CANCEL_COLLECTION'].includes(scoped.type) && isDashboard(sender)) {
        const fast = scoped.type === 'RESET_CAPTURE' ? resetCapture : cancelCollection;
        task = fast(scoped, sender, () => {
          pending.set(key, task);
          const cleanup = () => { if (pending.get(key) === task) pending.delete(key); };
          task.then(cleanup, cleanup);
        });
      } else task = enqueue(key, () => handle(scoped, sender, expectedEpoch, marker));
      if (scoped.type === 'BEGIN_COLLECTION' || scoped.type === 'GET_NAVIGATION' && scoped.requestId) {
        const clearFailedIntent = () => {
          const intent = collectionIntents.get(key);
          if (marker && intent === marker) collectionIntents.delete(key);
        };
        task.then(result => { if (!result?.ok) clearFailedIntent(); }, clearFailedIntent);
      }
      return task;
    };
    const operation = sourceOriginsReady.then(() => message.workspaceId && !Number.isInteger(message.tabId)
      ? catalogue.get(message.workspaceId).then(workspace => dispatch({ ...message, tabId: workspace?.sourceTabId }))
      : dispatch(message));
    operation.then(respond, error => respond({ ok: false, error: error.message || 'Не удалось выполнить действие.',
      ...(error.code ? { code: error.code } : {}),
      ...(exporterBindingDiagnostic(error.binding) ? { binding: exporterBindingDiagnostic(error.binding) } : {}),
      ...(navigationErrorCode(error.networkError) ? { networkError: navigationErrorCode(error.networkError) } : {}),
      ...(navigationUrl(error.expectedUrl) ? { expectedUrl: navigationUrl(error.expectedUrl) } : {}),
      ...(navigationUrl(error.observedUrl) ? { observedUrl: navigationUrl(error.observedUrl) } : {}),
      ...(navigationDiagnostic(error.navigation) ? { navigation: navigationDiagnostic(error.navigation) } : {}),
      ...(Number.isSafeInteger(error.attempt) && error.attempt > 0 && error.attempt <= 3 ? { attempt: error.attempt } : {}) }));
    return true;
  });
}

if (globalThis.chrome?.runtime?.id) installBackground(globalThis.chrome);
