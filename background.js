"use strict";

const STORAGE_KEY = "sessionKeeper.sessions";
const SETTINGS_KEY = "sessionKeeper.settings";
const AUTOSAVE_ALARM = "session-keeper-autosave";
const THUMBNAIL_DB_NAME = "sessionKeeper.thumbnails";
const THUMBNAIL_DB_VERSION = 1;
const THUMBNAIL_STORE = "thumbnails";
const THUMBNAIL_WIDTH = 320;
const THUMBNAIL_HEIGHT = 200;
const THUMBNAIL_TAB_SETTLE_MS = 300;
const THUMBNAIL_CAPTURE_INTERVAL_MS = 650;
const THUMBNAIL_CAPTURE_RETRY_MS = 1000;
const DEFAULT_SETTINGS = {
  autosaveMinutes: 15,
  maxAutosaves: 80
};
let thumbnailDbPromise = null;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await scheduleAutosave();
  await captureSession({ kind: "auto" });
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSettings();
  await scheduleAutosave();
  setTimeout(() => captureSession({ kind: "auto" }).then(updateBadge), 2500);
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTOSAVE_ALARM) return;
  captureSession({ kind: "auto" }).then(updateBadge);
});

chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete") updateBadge();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_DASHBOARD_DATA": {
      const [sessions, currentWindows, settings] = await Promise.all([
        getSessions(),
        getCurrentWindows(),
        ensureSettings()
      ]);
      return { sessions, currentWindows, settings };
    }
    case "CAPTURE_SESSION": {
      const session = await captureSession({
        kind: message.kind === "manual" ? "manual" : "auto",
        name: message.name
      });
      return { session, sessions: await getSessions() };
    }
    case "DELETE_SESSION": {
      const currentSessions = await getSessions();
      const deletedSession = currentSessions.find((session) => session.id === message.id);
      const sessions = currentSessions.filter((session) => session.id !== message.id);
      await setSessions(sessions);
      await deleteSessionThumbnails(deletedSession);
      return { sessions };
    }
    case "GET_THUMBNAILS": {
      return { thumbnails: await getThumbnails(message.ids || []) };
    }
    case "RESTORE_SESSION": {
      const sessions = await getSessions();
      const session = sessions.find((item) => item.id === message.id);
      if (!session) throw new Error("Session not found.");
      await restoreSession(session, message.mode || "new-window");
      return {};
    }
    case "UPDATE_SETTINGS": {
      const settings = await saveSettings(message.settings || {});
      await scheduleAutosave();
      return { settings };
    }
    default:
      throw new Error("Unknown message.");
  }
}

async function captureSession({ kind = "auto", name = "" } = {}) {
  const windows = await getCurrentWindows();
  await attachTabThumbnails(windows);
  const now = new Date();
  const createdAt = now.toISOString();
  const session = {
    id: `${kind}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    name: name?.trim() || formatTimestamp(now),
    createdAt,
    tabCount: windows.reduce((total, item) => total + item.tabs.length, 0),
    windowCount: windows.length,
    windows
  };

  const settings = await ensureSettings();
  const sessions = await getSessions();
  const next = [session, ...sessions];
  const autosaves = next.filter((item) => item.kind === "auto");
  const autosavesToDrop = autosaves.slice(settings.maxAutosaves);
  const autosaveIdsToDrop = new Set(autosavesToDrop.map((item) => item.id));
  await setSessions(next.filter((item) => !autosaveIdsToDrop.has(item.id)));
  await deleteSessionsThumbnails(autosavesToDrop);
  return session;
}

async function getCurrentWindows() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return windows.map((window) => ({
    id: window.id,
    focused: Boolean(window.focused),
    left: window.left ?? null,
    top: window.top ?? null,
    width: window.width ?? null,
    height: window.height ?? null,
    state: window.state || "normal",
    tabs: (window.tabs || []).map((tab) => ({
      id: tab.id,
      index: tab.index,
      title: tab.title || tab.url || "Untitled",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || "",
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active),
      incognito: Boolean(tab.incognito)
    }))
  }));
}

async function attachTabThumbnails(windows) {
  if (!chrome.tabs.captureVisibleTab) return;

  const captureVisibleTab = createCaptureLimiter();
  let lastFocusedWindow = null;
  try {
    lastFocusedWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  } catch {
    lastFocusedWindow = null;
  }

  const activeTabsByWindow = new Map(
    windows
      .map((window) => [window.id, (window.tabs || []).find((tab) => tab.active)?.id])
      .filter(([, tabId]) => Number.isInteger(tabId))
  );

  for (const window of windows) {
    if (!Number.isInteger(window.id)) continue;

    for (const tab of window.tabs || []) {
      if (!isCapturableTab(tab)) continue;

      try {
        await chrome.windows.update(window.id, { focused: true });
        await chrome.tabs.update(tab.id, { active: true });
        await delay(THUMBNAIL_TAB_SETTLE_MS);
        const screenshotUrl = await captureVisibleTab(window.id);
        const thumbnailBlob = await createThumbnailBlob(screenshotUrl);
        const thumbnailId = `${Date.now()}-${tab.id}-${Math.random().toString(36).slice(2, 8)}`;
        await saveThumbnail(thumbnailId, thumbnailBlob);
        tab.thumbnailId = thumbnailId;
      } catch (error) {
        console.warn(`Session Keeper could not capture a thumbnail for ${tab.url}:`, error);
        tab.thumbnailId = "";
      }
    }
  }

  for (const [windowId, tabId] of activeTabsByWindow) {
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch {
      // The tab may have closed during capture.
    }
  }

  if (Number.isInteger(lastFocusedWindow?.id)) {
    try {
      await chrome.windows.update(lastFocusedWindow.id, { focused: true });
    } catch {
      // The window may have closed during capture.
    }
  }
}

function isCapturableTab(tab) {
  return Number.isInteger(tab.id) && /^(https?|file|chrome|chrome-extension):/i.test(tab.url || "");
}

function createCaptureLimiter() {
  let lastCaptureAt = 0;

  return async function captureVisibleTab(windowId) {
    await waitForCaptureSlot(lastCaptureAt);

    try {
      const screenshotUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 45
      });
      lastCaptureAt = Date.now();
      return screenshotUrl;
    } catch (error) {
      if (!isCaptureRateLimitError(error)) throw error;

      await delay(THUMBNAIL_CAPTURE_RETRY_MS);
      const screenshotUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 45
      });
      lastCaptureAt = Date.now();
      return screenshotUrl;
    }
  };
}

async function waitForCaptureSlot(lastCaptureAt) {
  const elapsed = Date.now() - lastCaptureAt;
  if (elapsed < THUMBNAIL_CAPTURE_INTERVAL_MS) {
    await delay(THUMBNAIL_CAPTURE_INTERVAL_MS - elapsed);
  }
}

function isCaptureRateLimitError(error) {
  return /quota|capture|too frequently|maximum/i.test(error?.message || "");
}

async function createThumbnailBlob(dataUrl) {
  const sourceBlob = await (await fetch(dataUrl)).blob();
  if (!self.OffscreenCanvas || !self.createImageBitmap) return sourceBlob;

  const bitmap = await createImageBitmap(sourceBlob);
  const scale = Math.min(THUMBNAIL_WIDTH / bitmap.width, THUMBNAIL_HEIGHT / bitmap.height, 1);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });

  context.drawImage(bitmap, 0, 0, width, height);
  if (bitmap.close) bitmap.close();

  const thumbnailBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: 0.72
  });
  return thumbnailBlob;
}

async function getThumbnails(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const entries = await Promise.all(
    uniqueIds.map(async (id) => {
      const blob = await readThumbnail(id);
      return [id, blob ? await blobToDataUrl(blob) : ""];
    })
  );
  return Object.fromEntries(entries.filter(([, dataUrl]) => dataUrl));
}

async function saveThumbnail(id, blob) {
  const db = await openThumbnailDb();
  return runThumbnailTransaction(db, "readwrite", (store) => store.put(blob, id));
}

async function readThumbnail(id) {
  const db = await openThumbnailDb();
  return runThumbnailTransaction(db, "readonly", (store) => store.get(id));
}

async function deleteSessionThumbnails(session) {
  await deleteThumbnails(collectThumbnailIds([session]));
}

async function deleteSessionsThumbnails(sessions) {
  await deleteThumbnails(collectThumbnailIds(sessions));
}

async function deleteThumbnails(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return;

  const db = await openThumbnailDb();
  await runThumbnailTransaction(db, "readwrite", (store) => {
    uniqueIds.forEach((id) => store.delete(id));
  });
}

function collectThumbnailIds(sessions = []) {
  return sessions
    .filter(Boolean)
    .flatMap((session) => session.windows || [])
    .flatMap((window) => window.tabs || [])
    .map((tab) => tab.thumbnailId);
}

function openThumbnailDb() {
  if (!thumbnailDbPromise) {
    thumbnailDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(THUMBNAIL_DB_NAME, THUMBNAIL_DB_VERSION);

      request.onupgradeneeded = () => {
        request.result.createObjectStore(THUMBNAIL_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return thumbnailDbPromise;
}

function runThumbnailTransaction(db, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(THUMBNAIL_STORE, mode);
    const store = transaction.objectStore(THUMBNAIL_STORE);
    const request = action(store);
    let result;

    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function restoreSession(session, mode) {
  const windows = session.windows || [];
  if (mode === "current-window") {
    const tabs = windows.flatMap((window) => window.tabs || []).filter((tab) => isRestorableUrl(tab.url));
    for (const tab of tabs) {
      await chrome.tabs.create({ url: tab.url, pinned: Boolean(tab.pinned), active: false });
    }
    return;
  }

  for (const window of windows) {
    const tabs = (window.tabs || []).filter((tab) => isRestorableUrl(tab.url));
    if (!tabs.length) continue;

    const created = await chrome.windows.create({
      url: tabs[0].url,
      focused: false,
      left: Number.isFinite(window.left) ? window.left : undefined,
      top: Number.isFinite(window.top) ? window.top : undefined,
      width: Number.isFinite(window.width) ? window.width : undefined,
      height: Number.isFinite(window.height) ? window.height : undefined
    });

    const firstTab = created.tabs?.[0];
    if (firstTab?.id && tabs[0].pinned) {
      await chrome.tabs.update(firstTab.id, { pinned: true });
    }

    for (const tab of tabs.slice(1)) {
      await chrome.tabs.create({
        windowId: created.id,
        url: tab.url,
        pinned: Boolean(tab.pinned),
        active: false
      });
    }
  }
}

function isRestorableUrl(url = "") {
  return /^(https?|file|chrome-extension):/i.test(url);
}

async function getSessions() {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function setSessions(sessions) {
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
}

async function ensureSettings() {
  const result = await chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(result[SETTINGS_KEY] || {})
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function saveSettings(patch) {
  const current = await ensureSettings();
  const settings = {
    ...current,
    autosaveMinutes: clampNumber(patch.autosaveMinutes, 5, 240, current.autosaveMinutes),
    maxAutosaves: clampNumber(patch.maxAutosaves, 10, 500, current.maxAutosaves)
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function scheduleAutosave() {
  const settings = await ensureSettings();
  await chrome.alarms.clear(AUTOSAVE_ALARM);
  await chrome.alarms.create(AUTOSAVE_ALARM, {
    periodInMinutes: settings.autosaveMinutes,
    delayInMinutes: settings.autosaveMinutes
  });
}

async function updateBadge() {
  const windows = await getCurrentWindows();
  const tabCount = windows.reduce((total, item) => total + item.tabs.length, 0);
  await chrome.action.setBadgeText({ text: tabCount ? String(tabCount) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#5f6875" });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: "#d8dee8" });
  }
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
