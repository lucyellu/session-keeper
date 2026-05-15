"use strict";

const state = {
  sessions: [],
  currentWindows: [],
  selectedId: "",
  search: "",
  settings: { autosaveMinutes: 15, maxAutosaves: 80 }
};

const extensionApi = typeof chrome !== "undefined" && chrome.runtime?.sendMessage;
const thumbnailCache = new Map();

const els = {
  autosaveLabel: document.querySelector("#autosaveLabel"),
  searchInput: document.querySelector("#searchInput"),
  saveManualButton: document.querySelector("#saveManualButton"),
  autosaveNowButton: document.querySelector("#autosaveNowButton"),
  sessionList: document.querySelector("#sessionList"),
  currentTitle: document.querySelector("#currentTitle"),
  currentMeta: document.querySelector("#currentMeta"),
  copyCurrentButton: document.querySelector("#copyCurrentButton"),
  exportCurrentButton: document.querySelector("#exportCurrentButton"),
  detailKind: document.querySelector("#detailKind"),
  detailTitle: document.querySelector("#detailTitle"),
  detailMeta: document.querySelector("#detailMeta"),
  copySelectedButton: document.querySelector("#copySelectedButton"),
  exportSelectedButton: document.querySelector("#exportSelectedButton"),
  restoreSelectedButton: document.querySelector("#restoreSelectedButton"),
  selectedTabList: document.querySelector("#selectedTabList"),
  openNowTitle: document.querySelector("#openNowTitle"),
  openNowMeta: document.querySelector("#openNowMeta"),
  currentTabList: document.querySelector("#currentTabList"),
  saveDialog: document.querySelector("#saveDialog"),
  saveForm: document.querySelector("#saveForm"),
  sessionNameInput: document.querySelector("#sessionNameInput"),
  sessionTemplate: document.querySelector("#sessionTemplate"),
  windowTemplate: document.querySelector("#windowTemplate"),
  tabTemplate: document.querySelector("#tabTemplate"),
  toast: document.querySelector("#toast")
};

init();

async function init() {
  bindEvents();
  await refreshData();
}

function bindEvents() {
  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value.trim().toLowerCase();
    renderSessions();
  });

  els.saveManualButton.addEventListener("click", openManualSaveDialog);
  els.autosaveNowButton.addEventListener("click", () => captureSession("auto"));
  els.copyCurrentButton.addEventListener("click", () => copyLinks(state.currentWindows, "Current tabs"));
  els.exportCurrentButton.addEventListener("click", () => exportLinks(state.currentWindows, "current-tabs"));
  els.copySelectedButton.addEventListener("click", () => copySelectedSession());
  els.exportSelectedButton.addEventListener("click", () => exportSelectedSession());
  els.restoreSelectedButton.addEventListener("click", restoreSelectedSession);

  els.saveForm.addEventListener("submit", (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    els.saveDialog.close();
    captureSession("manual", els.sessionNameInput.value);
  });
}

async function refreshData() {
  if (!extensionApi) {
    loadDemoData();
    return;
  }

  const response = await sendMessage({ type: "GET_DASHBOARD_DATA" });
  state.sessions = response.sessions || [];
  state.currentWindows = response.currentWindows || [];
  state.settings = response.settings || state.settings;
  if (!state.selectedId && state.sessions[0]) state.selectedId = state.sessions[0].id;
  render();
}

async function captureSession(kind, name = "") {
  const label = kind === "manual" ? "Manual session saved." : "Autosave captured.";

  if (!extensionApi) {
    const session = createDemoSession(kind, name || formatTimestamp(new Date()));
    state.sessions = [session, ...state.sessions];
    state.selectedId = session.id;
    render();
    toast(label);
    return;
  }

  const response = await sendMessage({ type: "CAPTURE_SESSION", kind, name });
  state.sessions = response.sessions || [];
  state.selectedId = response.session?.id || state.sessions[0]?.id || "";
  render();
  toast(label);
}

function openManualSaveDialog() {
  els.sessionNameInput.value = formatTimestamp(new Date());
  els.saveDialog.showModal();
  requestAnimationFrame(() => {
    els.sessionNameInput.focus();
    els.sessionNameInput.select();
  });
}

function render() {
  const currentTabCount = countTabs(state.currentWindows);
  els.autosaveLabel.textContent = `Autosaves every ${state.settings.autosaveMinutes} minutes`;
  els.currentTitle.textContent = `${currentTabCount} tab${currentTabCount === 1 ? "" : "s"} open`;
  els.currentMeta.textContent = `${state.currentWindows.length} window${state.currentWindows.length === 1 ? "" : "s"} captured from the current browser.`;
  els.openNowTitle.textContent = `${currentTabCount} current tab${currentTabCount === 1 ? "" : "s"}`;
  els.openNowMeta.textContent = `${state.currentWindows.length} browser window${state.currentWindows.length === 1 ? "" : "s"}.`;

  renderSessions();
  renderSessionDetail();
  renderWindows(els.currentTabList, state.currentWindows);
}

function renderSessions() {
  els.sessionList.textContent = "";
  const sessions = filteredSessions();

  if (!sessions.length) {
    els.sessionList.appendChild(emptyNode("No sessions match the current search."));
    return;
  }

  const fragment = document.createDocumentFragment();
  sessions.forEach((session) => fragment.appendChild(createSessionCard(session)));
  els.sessionList.appendChild(fragment);
}

function filteredSessions() {
  if (!state.search) return state.sessions;
  return state.sessions.filter((session) => {
    const text = [
      session.name,
      session.kind,
      session.createdAt,
      ...flattenTabs(session.windows).flatMap((tab) => [tab.title, tab.url])
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(state.search);
  });
}

function createSessionCard(session) {
  const node = els.sessionTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add(session.kind === "manual" ? "kind-manual" : "kind-auto");
  node.classList.toggle("is-active", session.id === state.selectedId);
  node.querySelector(".kind-pill").textContent = session.kind;
  node.querySelector(".session-name").textContent = session.name;
  node.querySelector(".session-meta").textContent =
    `${session.tabCount} tabs · ${session.windowCount} windows · ${relativeTime(session.createdAt)}`;
  node.addEventListener("click", () => {
    state.selectedId = session.id;
    render();
  });
  return node;
}

function renderSessionDetail() {
  const session = selectedSession();
  const hasSession = Boolean(session);

  els.copySelectedButton.disabled = !hasSession;
  els.exportSelectedButton.disabled = !hasSession;
  els.restoreSelectedButton.disabled = !hasSession;

  if (!session) {
    els.detailKind.textContent = "Selected session";
    els.detailTitle.textContent = "No session selected";
    els.detailMeta.textContent = "Save your current browser or wait for an autosave.";
    els.selectedTabList.textContent = "";
    els.selectedTabList.appendChild(emptyNode("Saved sessions will show here."));
    return;
  }

  els.detailKind.textContent = session.kind === "manual" ? "Manual save" : "Autosave";
  els.detailTitle.textContent = session.name;
  els.detailMeta.textContent =
    `${session.tabCount} tabs across ${session.windowCount} windows · ${formatDate(session.createdAt)}`;
  renderWindows(els.selectedTabList, session.windows);
}

function renderWindows(container, windows) {
  container.textContent = "";

  if (!windows.length || !countTabs(windows)) {
    container.appendChild(emptyNode("No tabs in this view."));
    return;
  }

  const fragment = document.createDocumentFragment();
  windows.forEach((window, index) => {
    const node = els.windowTemplate.content.firstElementChild.cloneNode(true);
    const tabs = window.tabs || [];
    node.querySelector("h3").textContent = `Window ${index + 1} · ${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
    const tabContainer = node.querySelector(".window-tabs");
    tabs.forEach((tab) => tabContainer.appendChild(createTabRow(tab)));
    fragment.appendChild(node);
  });
  container.appendChild(fragment);
  hydrateThumbnails(container);
}

function createTabRow(tab) {
  const node = els.tabTemplate.content.firstElementChild.cloneNode(true);
  const thumbnail = node.querySelector(".tab-thumbnail");
  const favicon = node.querySelector(".favicon");
  const thumbnailUrl = tab.thumbnailUrl || thumbnailCache.get(tab.thumbnailId) || "";
  const hasThumbnail = Boolean(thumbnailUrl || tab.thumbnailId);
  node.classList.toggle("no-thumbnail", !hasThumbnail);
  thumbnail.dataset.thumbnailId = tab.thumbnailId || "";
  setImageSource(thumbnail, thumbnailUrl);
  favicon.src = tab.favIconUrl || "";
  favicon.style.visibility = tab.favIconUrl ? "visible" : "hidden";
  node.querySelector(".tab-title").textContent = tab.title || tab.url || "Untitled";
  node.querySelector(".tab-url").textContent = tab.url || "";
  const link = node.querySelector(".open-link");
  link.href = tab.url || "#";
  link.style.visibility = tab.url ? "visible" : "hidden";
  return node;
}

async function hydrateThumbnails(container) {
  if (!extensionApi) return;

  const images = [...container.querySelectorAll(".tab-thumbnail[data-thumbnail-id]")].filter((image) => {
    const id = image.dataset.thumbnailId;
    return id && !image.getAttribute("src");
  });
  const missingIds = [...new Set(images.map((image) => image.dataset.thumbnailId).filter((id) => !thumbnailCache.has(id)))];

  if (missingIds.length) {
    const response = await sendMessage({ type: "GET_THUMBNAILS", ids: missingIds });
    Object.entries(response.thumbnails || {}).forEach(([id, dataUrl]) => thumbnailCache.set(id, dataUrl));
  }

  images.forEach((image) => {
    const id = image.dataset.thumbnailId;
    const dataUrl = thumbnailCache.get(id);
    if (dataUrl) {
      setImageSource(image, dataUrl);
      image.closest(".tab-row")?.classList.remove("no-thumbnail");
    } else {
      image.closest(".tab-row")?.classList.add("no-thumbnail");
    }
  });
}

function setImageSource(image, src) {
  if (src) {
    image.src = src;
    image.style.visibility = "visible";
    return;
  }

  image.removeAttribute("src");
  image.style.visibility = "hidden";
}

async function copySelectedSession() {
  const session = selectedSession();
  if (!session) return;
  await copyLinks(session.windows, session.name);
}

async function exportSelectedSession() {
  const session = selectedSession();
  if (!session) return;
  await exportLinks(session.windows, safeName(session.name));
}

async function restoreSelectedSession() {
  const session = selectedSession();
  if (!session) return;

  if (!extensionApi) {
    toast("Load as an unpacked extension to restore tabs.");
    return;
  }

  await sendMessage({ type: "RESTORE_SESSION", id: session.id, mode: "new-window" });
  toast("Session restore started in new window(s).");
}

async function copyLinks(windows, title) {
  const links = flattenTabs(windows).map((tab) => tab.url).filter(Boolean);
  if (!links.length) {
    toast("No links to copy.");
    return;
  }

  const codeBlock = ["```text", ...links, "```"].join("\n");
  await writeClipboard(codeBlock);
  toast(`${links.length} links copied as a code block.`);
}

async function exportLinks(windows, name) {
  const links = flattenTabs(windows).map((tab) => tab.url).filter(Boolean);
  if (!links.length) {
    toast("No links to export.");
    return;
  }

  const content = links.join("\n") + "\n";
  const fileName = `Session Keeper/${safeName(name || "tabs")}.txt`;

  if (extensionApi && chrome.downloads?.download) {
    const blobUrl = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    try {
      await chrome.downloads.download({
        url: blobUrl,
        filename: fileName,
        conflictAction: "uniquify",
        saveAs: false
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    }
  } else {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    link.download = `${safeName(name || "tabs")}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  }

  toast(`${links.length} links exported as TXT.`);
}

async function writeClipboard(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

function selectedSession() {
  return state.sessions.find((session) => session.id === state.selectedId) || state.sessions[0] || null;
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Extension request failed.");
  return response;
}

function flattenTabs(windows = []) {
  return windows.flatMap((window) => window.tabs || []);
}

function countTabs(windows = []) {
  return flattenTabs(windows).length;
}

function emptyNode(message) {
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = message;
  return node;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
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

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function relativeTime(value) {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function safeName(value) {
  return String(value || "tabs")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "tabs";
}

function loadDemoData() {
  state.currentWindows = [
    {
      tabs: [
        {
          title: "Session Buddy",
          url: "https://sessionbuddy.com/",
          favIconUrl: "",
          pinned: false
        },
        {
          title: "Chrome Extensions",
          url: "https://developer.chrome.com/docs/extensions/",
          favIconUrl: "",
          pinned: false
        },
        {
          title: "GitHub repo",
          url: "https://github.com/lucyellu/chrome-extensions",
          favIconUrl: "",
          pinned: false
        }
      ]
    },
    {
      tabs: [
        {
          title: "Open tabs export notes",
          url: "https://example.com/research/session-export",
          favIconUrl: "",
          pinned: false
        }
      ]
    }
  ];
  state.sessions = [
    createDemoSession("manual", "Launch research tabs"),
    createDemoSession("auto", formatTimestamp(new Date(Date.now() - 18 * 60000))),
    createDemoSession("auto", formatTimestamp(new Date(Date.now() - 38 * 60000)))
  ];
  state.selectedId = state.sessions[0].id;
  render();
}

function createDemoSession(kind, name) {
  const createdAt = new Date(kind === "manual" ? Date.now() - 6 * 60000 : Date.now() - 22 * 60000).toISOString();
  const windows = JSON.parse(JSON.stringify(state.currentWindows));
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    name,
    createdAt,
    tabCount: countTabs(windows),
    windowCount: windows.length,
    windows
  };
}
