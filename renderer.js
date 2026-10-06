let currentFilePath = "";

const openBtn = document.getElementById("openBtn");
const saveBtn = document.getElementById("saveBtn");

const clearSessionBtn = document.getElementById("clearSessionBtn");
const editor = document.getElementById("editor");
const filePathEl = document.getElementById("filePath");
const statusEl = document.getElementById("status");
const metadataPanel = document.getElementById("metadataPanel");
const metadataHeaderTabs = document.getElementById("metadataHeaderTabs");
const editMetadataBtn = document.getElementById("editMetadataBtn");
const addAlbumArtBtn = document.getElementById("addAlbumArtBtn");
const storeAudioBtn = document.getElementById("storeAudioBtn");
const editorGhost = document.getElementById("editorGhost");
const audioLinkInfo = document.getElementById("audioLinkInfo");
const unlinkAudioBtn = document.getElementById("unlinkAudioBtn");
const numericOrderingBtn = document.getElementById("numericOrderingBtn");

const tocToggleBtn = document.getElementById("tocToggleBtn");
const tocDrawer = document.getElementById("tocDrawer");
const tocCloseBtn = document.getElementById("tocCloseBtn");
const tocList = document.getElementById("tocList");

if (numericOrderingBtn) {
  numericOrderingBtn.style.display = "none";
}

function isSavedTextProject() {
  return /\.(epic|epicx|txt|md)$/i.test(currentFilePath || "");
}

function isSavedEpicxProject() {
  return /\.epicx$/i.test(currentFilePath || "");
}

function isWavProjectDocument() {
  return /\.wav$/i.test(currentFilePath || '');
}
function canLinkStudioTiming() {
  return isSavedEpicxProject() || isWavProjectDocument();
}
let isProjectSaveInProgress = false;

// Timing-only polls never write the WAV. Studio retains its session save policy.
function receiveStudioProject(snapshot, { initial = false } = {}) {
  const project = snapshot?.project;
  if (!project || project.filePath !== currentFilePath ||
      (!initial && project.session !== studioTimingLink?.session)) {
    if (!initial) unlinkStudioTiming({ silent: true });
    statusEl.textContent = 'Open this same project in Studio, then link it again. Your Writer edits have been kept.';
    return false;
  }
  const result = window.EpicProjectTextMerge.merge(sourceEditorText, editor.value, project.text);
  if (!result.ok) {
    statusEl.textContent = result.message;
    return false;
  }
  const start = editor.selectionStart, end = editor.selectionEnd, scroll = editor.scrollTop;
  if (result.text !== editor.value) {
    replaceEditorTextWithManualUndo(result.text);
    editor.setSelectionRange(Math.min(start, result.text.length), Math.min(end, result.text.length));
    editor.scrollTop = scroll;
    scheduleEpicValidation();
  }
  sourceEditorText = project.text;
  sourceHadContent = !!project.text.trim();
  studioTimingLink = {
    kind: 'project', filePath: project.filePath, session: project.session,
    contextRevision: snapshot.context?.contextRevision ?? null,
    timingFingerprint: snapshot.timingFingerprint || '', waiting: false
  };
  if (initial) statusEl.textContent = 'Linked EPIC Project to Studio. Timing updates here; Save sends your text edits to Studio.';
  updateHeaderState();
  saveSessionState();
  return true;
}

async function saveLinkedStudioProject() {
  if (isProjectSaveInProgress) return;
  isProjectSaveInProgress = true;
  const link = { ...studioTimingLink };
  const submitted = editor.value;
  try {
    statusEl.textContent = 'Saving linked project in Studio...';
    const result = await window.EpicInspector.saveStudioProject({
      filePath: link.filePath, session: link.session,
      baseText: sourceEditorText, text: submitted
    });
    if (currentFilePath !== link.filePath || studioTimingLink?.session !== link.session) return;
    if (!result?.ok) {
      statusEl.textContent = result?.message || 'Studio could not save. Your Writer edits have been kept.';
      return;
    }
    // Keep any edits typed while the save was in flight.
    const merged = window.EpicProjectTextMerge.merge(submitted, editor.value, result.project.text);
    if (merged.ok && merged.text !== editor.value) replaceEditorTextWithManualUndo(merged.text);
    sourceEditorText = result.project.text;
    sourceHadContent = !!sourceEditorText.trim();
    if (currentMetadata) currentMetadata.epicx = sourceEditorText;
    statusEl.textContent = merged.ok ? 'Project saved in Studio.' : merged.message;
    scheduleEpicValidation(); updateHeaderState(); saveSessionState();
  } finally { isProjectSaveInProgress = false; }
}

function setEditMetadataBtnIcon(active) {
  if (!editMetadataBtn) return;
  editMetadataBtn.innerHTML = `
    <svg class="icon ${active ? "close-icon" : "edit-mini-icon"} core-action" viewBox="0 0 628 628" aria-hidden="true">
      <use href="icons.svg#${active ? "close-icon" : "edit-mini-icon"}"></use>
    </svg>
  `;
}

const AUTHOR_KEY_PREF = "epic-author-key-preference";
const AUTHOR_KEY_HISTORY = "epic-author-key-history";
const AUTHOR_VALUE_PREF = "epic-author-value-preference";
const AUTHOR_VALUE_HISTORY = "epic-author-value-history";
const AUTHOR_HISTORY_SIZE = 3;
const AUTHOR_KEYS = ["Creator", "Author", "Artist"];

let ghostHeaderVisible = false;
let lastEpicValidationResult = null;

let sourceEditorText = "";
let sourceHadContent = false;
let linkedAudioPath = "";
let studioTimingLink = null;
let studioTimingPollTimer = null;
let isStudioTimingSyncInProgress = false;
let transientStatusText = "";
let statusObserver = null;
let manualUndoStack = [];
let manualRedoStack = [];
let isApplyingUndo = false;
let pendingAddedEpicxTimestamps = [];

const MAX_UNDO_SNAPSHOTS = 100;

function getTocGroupKey(sectionIdentity) {
  const match = String(sectionIdentity || "").match(/^\[\s*([^{}\]]+)/);
  return match ? match[1].trim() : sectionIdentity;
}

function groupSectionTocEntries(entries) {
  const groups = [];

  entries.forEach((entry) => {
    const groupKey = getTocGroupKey(entry.label);
    const lastGroup = groups[groups.length - 1];

    if (lastGroup && lastGroup.groupKey === groupKey) {
      lastGroup.entries.push(entry);
    } else {
      groups.push({
        groupKey,
        entries: [entry]
      });
    }
  });

  return groups;
}

function pushUndoSnapshot() {
  manualUndoStack.push(captureEditorSnapshot());
  manualRedoStack = [];

  if (manualUndoStack.length > MAX_UNDO_SNAPSHOTS) {
    manualUndoStack.shift();
  }
}

function captureEditorSnapshot() {
  return {
    value: editor.value,
    selectionStart: editor.selectionStart,
    selectionEnd: editor.selectionEnd,
    scrollTop: editor.scrollTop
  };
}

function applyEditorSnapshot(snapshot, inputType = "historyUndo") {
  const before = captureEditorSnapshot();

  isApplyingUndo = true;

  try {
    editor.value = snapshot.value;
    editor.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    editor.scrollTop = snapshot.scrollTop;

    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType
    }));
  } finally {
    isApplyingUndo = false;
  }

  return before;
}

function applyEditorHistoryAction(action) {
  if (action === "undo") {
    const snapshot = manualUndoStack.pop();

    if (!snapshot) return false;

    const redoSnapshot = applyEditorSnapshot(snapshot, "historyUndo");
    manualRedoStack.push(redoSnapshot);
  } else if (action === "redo") {
    const snapshot = manualRedoStack.pop();

    if (!snapshot) return false;

    const undoSnapshot = applyEditorSnapshot(snapshot, "historyRedo");
    manualUndoStack.push(undoSnapshot);
  } else {
    return false;
  }

  scheduleEpicValidation();
  saveSessionState();
  updateHeaderState();
  return true;
}

const validationStatusEl =
  document.getElementById("validationStatus");

const SESSION_KEY = "epic-media-inspector-session";
  let restoreInProgress = false;
let rawMetadataOpen = false;

let currentMetadata = null;
let metadataEditMode = false;
let metadataActiveTab = "standard";
let stagedAlbumArt = undefined; // undefined = no change, null = remove, object = { mimeType, data }

let parseTimer = null;

const DEFAULT_STATUS_TEXT = "Ready";
const LINKED_STUDIO_TIMING_STATUS = "Linked EPICX (Studio) timing";

function getPinnedStatusLines() {
  return studioTimingLink ? [LINKED_STUDIO_TIMING_STATUS] : [];
}

function stripPinnedStatusText(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim().replace(/\.$/, "");
      if (!normalized || normalized === "Idle") return false;
      return !normalized.startsWith(LINKED_STUDIO_TIMING_STATUS);
    })
    .join("\n")
    .trim();
}

function renderStatus() {
  const lines = [
    ...getPinnedStatusLines(),
    transientStatusText
  ].filter((line) => String(line || "").trim().length > 0);

  statusObserver?.disconnect();
  statusEl.textContent = lines.length
    ? lines.join("\n")
    : DEFAULT_STATUS_TEXT;
  observeStatusChanges();
}

function setStatus(value) {
  transientStatusText = stripPinnedStatusText(value);
  renderStatus();
}

function observeStatusChanges() {
  if (!statusObserver) {
    statusObserver = new MutationObserver(() => {
      transientStatusText = stripPinnedStatusText(statusEl.textContent);
      renderStatus();
    });
  }

  statusObserver.observe(statusEl, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

renderStatus();

function readRecentHistory(storageKey) {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return Array.isArray(value) ? value.slice(-AUTHOR_HISTORY_SIZE) : [];
  } catch {
    return [];
  }
}

function rememberRepeatedPreference(historyKey, preferenceKey, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return;

  const history = readRecentHistory(historyKey);
  history.push(normalized);
  const recent = history.slice(-AUTHOR_HISTORY_SIZE);
  localStorage.setItem(historyKey, JSON.stringify(recent));

  if (
    recent.length === AUTHOR_HISTORY_SIZE &&
    recent.every(item => item === normalized)
  ) {
    localStorage.setItem(preferenceKey, normalized);
  }
}

function getPreferredAuthorKey() {
  return localStorage.getItem(AUTHOR_KEY_PREF) || "Author";
}

function getPreferredAuthorValue() {
  return localStorage.getItem(AUTHOR_VALUE_PREF) || "";
}

function getHeaderAuthorship(source = editor.value) {
  const match = String(source || "").match(
    /^---\s*\n[\s\S]*?^\s*(Creator|Artist|Author):[ \t]*(.*)$/m
  );

  return match
    ? { key: match[1], value: match[2].trim() }
    : null;
}

function rememberCompletedHeaderValue(source = editor.value) {
  const authorship = getHeaderAuthorship(source);
  if (!authorship?.value) return;

  // EPIC Writer learns the credit value when header authoring is completed.
  rememberRepeatedPreference(
    AUTHOR_VALUE_HISTORY,
    AUTHOR_VALUE_PREF,
    authorship.value
  );
}

function getHeaderStub() {
  const authorKey = getPreferredAuthorKey();
  const authorValue = getPreferredAuthorValue();

  return `---
Title: Untitled
${authorKey}: ${authorValue}
---

`;
}

const editorHighlight = document.getElementById("editorHighlight");

function syncEditorHighlight() {
  if (!editorHighlight) return;

  editorHighlight.innerHTML =
    renderEpicHighlight(editor.value) + "\n ";

  editorHighlight.scrollTop = editor.scrollTop;
  editorHighlight.scrollLeft = editor.scrollLeft;

  updateSectionFlashOverlay();
}

function showGhostHeaderIfAppropriate() {
  if (!editorGhost) return;

  const shouldShow =
    editor.value.length === 0 &&
    document.activeElement === editor;

  ghostHeaderVisible = shouldShow;

  if (shouldShow) {
    editorGhost.textContent = getHeaderStub();
    editor.classList.add("has-ghost");
  } else {
    editorGhost.textContent = "";
    editor.classList.remove("has-ghost");
  }
}

function commitGhostHeader() {
  const stub = getHeaderStub();

  editor.value = stub;
  refreshEditorView();

  sourceEditorText = "";

  ghostHeaderVisible = false;
  editorGhost.textContent = "";
  editor.classList.remove("has-ghost");

  const titleStart = stub.indexOf("Untitled");
  const titleEnd = titleStart + "Untitled".length;

  editor.focus();
  editor.setSelectionRange(titleStart, titleEnd);

  scheduleEpicValidation();
  saveSessionState();
  updateHeaderState();
}

function hasUnsavedChanges() {
  return editor.value !== sourceEditorText;
}

let highlightSyncFrame = null;
let sectionFlash = null; // { start, end, startedAt } line range briefly highlighted after a drawer jump
let sectionFlashTimer = null;
const SECTION_FLASH_MS = 1400;

function requestEditorHighlightSync() {
  if (highlightSyncFrame) {
    cancelAnimationFrame(highlightSyncFrame);
  }

  highlightSyncFrame = requestAnimationFrame(() => {
    highlightSyncFrame = null;
    syncEditorHighlight();
  });
}

function refreshEditorView() {
  requestEditorHighlightSync();
  updateTocDrawerAvailability();

  if (tocDrawer?.classList.contains("open")) {
    renderSectionToc();
  }
}

async function confirmDiscardUnsavedChanges() {
  if (editor.value === sourceEditorText) return true;

  return showConfirmModal({
    title: "Unsaved Changes",
    message: "You have unsaved changes that will be lost if you proceed. Do you still want to continue?",
    confirmLabel: "Yes",
    cancelLabel: "Cancel"
  });
}

function updateSidebarState() {
  const hasAudioContext =
    /\.(wav|mp3)$/i.test(currentFilePath || "") ||
    Boolean(linkedAudioPath);

  const hasMetadata =
    hasAudioContext && Boolean(currentMetadata);

  metadataPanel.style.display =
    hasMetadata ? "" : "none";

  if (metadataHeaderTabs) {
    metadataHeaderTabs.style.display = hasMetadata ? "" : "none";
  }

  const metadataTitleRow =
    document.querySelector(".sidebar-title-row");

  if (metadataTitleRow) {
    metadataTitleRow.style.display =
      hasMetadata ? "" : "none";
  }

  editMetadataBtn.style.display = "none";

  const sidebarTitle =
    document.querySelector(".sidebar-title");

  if (sidebarTitle) {
    sidebarTitle.style.display =
      hasMetadata ? "" : "none";
  }

  if (addAlbumArtBtn) {
    addAlbumArtBtn.style.display = "none";
    addAlbumArtBtn.disabled = !hasMetadata;
  }
}

function clearMetadataHeaderTabs() {
  if (metadataHeaderTabs) {
    metadataHeaderTabs.textContent = "";
  }
}

function moveToNextHeaderValue() {
  const text = editor.value;
  const cursor = editor.selectionEnd;

  const headerEnd = text.indexOf("\n---", 3);

  if (headerEnd === -1 || cursor > headerEnd) {
    return false;
  }

  const fieldRe = /^(Title|Creator|Artist|Author):[ \t]*(.*)$/gm;

  let match;

  while ((match = fieldRe.exec(text)) !== null) {
    const fullLineStart = match.index;
    const valueStart =
      fullLineStart +
      match[0].indexOf(":") +
      1 +
      (match[0].match(/:[ \t]*/)?.[0].length - 1);

    const valueEnd =
      valueStart + match[2].length;

    if (valueStart > cursor) {
      editor.focus();
      editor.setSelectionRange(valueStart, valueEnd);
      return true;
    }
  }

  const headerCloseStart = text.indexOf("\n---", 3);

  if (headerCloseStart !== -1 && cursor <= headerCloseStart + 4) {
    rememberCompletedHeaderValue();

    const afterHeader =
      headerCloseStart + "\n---".length;

    const nextLineStart =
      text.indexOf("\n", afterHeader) + 1;

    const target =
      nextLineStart > 0
        ? nextLineStart + 1
        : text.length;

    editor.focus();
    editor.setSelectionRange(target, target);
    return true;
  }

  return false;
}

function expandFreeflowSectionTrigger() {
  const text = editor.value;
  const cursor = editor.selectionStart;

  if (cursor !== editor.selectionEnd) return false;
  if (text[cursor - 1] !== "&") return false;

  const beforeTrigger = text[cursor - 2] || "";

  if (beforeTrigger && !/\s/.test(beforeTrigger)) return false;

  const replacement = "[{&}]";
  const triggerStart = cursor - 1;
  const cursorTarget = triggerStart + 4;
  const scrollTop = editor.scrollTop;

  pushUndoSnapshot();

  editor.value =
    text.slice(0, triggerStart) +
    replacement +
    text.slice(cursor);

  editor.focus();
  editor.setSelectionRange(cursorTarget, cursorTarget);
  editor.scrollTop = scrollTop;

  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertReplacementText"
  }));

  return true;
}

function moveOutOfFreeflowSectionOpener() {
  const text = editor.value;
  const cursor = editor.selectionStart;

  if (cursor !== editor.selectionEnd) return false;
  if (text[cursor] !== "]") return false;

  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const openerPrefix = text.slice(lineStart, cursor);

  if (!/^\s*\[\{&\}/.test(openerPrefix)) return false;

  const afterCloser = cursor + 1;

  if (text[afterCloser] === "\n") {
    editor.focus();
    editor.setSelectionRange(afterCloser + 1, afterCloser + 1);
    return true;
  }

  const scrollTop = editor.scrollTop;

  pushUndoSnapshot();

  editor.value =
    text.slice(0, afterCloser) +
    "\n" +
    text.slice(afterCloser);

  editor.focus();
  editor.setSelectionRange(afterCloser + 1, afterCloser + 1);
  editor.scrollTop = scrollTop;

  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertLineBreak"
  }));

  return true;
}

function insertFreeflowSectionCloser() {
  const text = editor.value;
  const selectionStart = editor.selectionStart;
  const selectionEnd = editor.selectionEnd;
  const selectedText = text.slice(selectionStart, selectionEnd);
  const lineStart = text.lastIndexOf("\n", selectionStart - 1) + 1;
  const linePrefix = text.slice(lineStart, selectionStart);
  const needsLeadingNewline =
    selectionStart === selectionEnd &&
    linePrefix.trim().length > 0;
  const replacement = `${needsLeadingNewline ? "\n" : ""}:::\n`;
  const cursorTarget = selectionStart + replacement.length;
  const scrollTop = editor.scrollTop;

  pushUndoSnapshot();

  editor.value =
    text.slice(0, selectionStart) +
    replacement +
    text.slice(selectionEnd);

  editor.focus();
  editor.setSelectionRange(cursorTarget, cursorTarget);
  editor.scrollTop = scrollTop;

  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: selectedText
      ? "insertReplacementText"
      : "insertText"
  }));

  return true;
}

function showConfirmModal({
  title = "Confirm",
  message,
  confirmLabel = "Yes",
  cancelLabel = "Cancel"
}) {
  const modal = document.getElementById("confirmModal");
  const titleEl = document.getElementById("confirmModalTitle");
  const messageEl = document.getElementById("confirmModalMessage");
  const yesBtn = document.getElementById("confirmModalYesBtn");
  const cancelBtn = document.getElementById("confirmModalCancelBtn");

  return new Promise((resolve) => {
    titleEl.textContent = title;
    messageEl.textContent = message;
    yesBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    modal.classList.remove("hidden");

    const close = (value) => {
      modal.classList.add("hidden");
      yesBtn.removeEventListener("click", onYes);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKeydown);
      resolve(value);
    };

    const onYes = () => close(true);
    const onCancel = () => close(false);

    const onBackdrop = (event) => {
      if (event.target === modal) close(false);
    };

    const onKeydown = (event) => {
      if (event.key === "Escape") close(false);
      if (event.key === "Enter") close(true);
    };

    yesBtn.addEventListener("click", onYes);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onKeydown);

    cancelBtn.focus();
  });
}

function rememberAuthorKeyCorrection() {
  // Preference learning happens when header entry is completed, rather than
  // on every keystroke. Kept as a no-op because older call sites still invoke it.
}

function replaceHeaderAuthorKey(nextKey) {
  if (!AUTHOR_KEYS.includes(nextKey)) return false;

  const text = editor.value;
  const headerEnd = text.indexOf("\n---", 3);
  if (headerEnd === -1) return false;

  const header = text.slice(0, headerEnd);
  const match = /^(Creator|Artist|Author):/m.exec(header);
  if (!match) return false;

  const keyStart = match.index;
  const keyEnd = keyStart + match[1].length;
  const selectionStart = editor.selectionStart;
  const selectionEnd = editor.selectionEnd;
  const delta = nextKey.length - match[1].length;

  pushUndoSnapshot();
  editor.value = text.slice(0, keyStart) + nextKey + text.slice(keyEnd);

  const adjust = position => position > keyEnd ? position + delta : position;
  editor.setSelectionRange(adjust(selectionStart), adjust(selectionEnd));
  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertReplacementText"
  }));

  return true;
}

let authorKeyPicker = null;

function closeAuthorKeyPicker() {
  authorKeyPicker?.remove();
  authorKeyPicker = null;
}

function showAuthorKeyPicker(event, currentKey) {
  closeAuthorKeyPicker();

  const picker = document.createElement("div");
  picker.setAttribute("role", "menu");
  picker.style.cssText = [
    "position:fixed",
    `left:${event.clientX}px`,
    `top:${event.clientY}px`,
    "z-index:10000",
    "display:flex",
    "gap:4px",
    "padding:6px",
    "border:1px solid rgba(127,127,127,.45)",
    "border-radius:7px",
    "background:var(--panel-bg, #202124)",
    "box-shadow:0 6px 20px rgba(0,0,0,.25)"
  ].join(";");

  AUTHOR_KEYS
    .filter(key => key !== currentKey)
    .forEach(key => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = key;
    button.style.cssText = "padding:4px 8px;cursor:pointer";
    button.addEventListener("mousedown", e => {
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener("click", () => {
      if (replaceHeaderAuthorKey(key)) {
        // EPIC Writer records the label when the user explicitly selects it.
        rememberRepeatedPreference(
          AUTHOR_KEY_HISTORY,
          AUTHOR_KEY_PREF,
          key
        );
      }
      closeAuthorKeyPicker();
      editor.focus();
    });
    picker.appendChild(button);
  });

  document.body.appendChild(picker);
  authorKeyPicker = picker;

  setTimeout(() => {
    const closeOnOutsidePointer = event => {
      if (authorKeyPicker?.contains(event.target)) return;
      closeAuthorKeyPicker();
      document.removeEventListener("mousedown", closeOnOutsidePointer, true);
    };

    document.addEventListener("mousedown", closeOnOutsidePointer, true);
  }, 0);
}

function maybeShowAuthorKeyPicker(event) {
  const text = editor.value;
  const cursor = editor.selectionStart;
  const headerEnd = text.indexOf("\n---", 3);
  if (headerEnd === -1 || cursor > headerEnd) return;

  const header = text.slice(0, headerEnd);
  const match = /^(Creator|Artist|Author):/m.exec(header);
  if (!match) return;

  const keyStart = match.index;
  const keyEnd = keyStart + match[1].length;
  if (cursor < keyStart || cursor > keyEnd) return;

  showAuthorKeyPicker(event, match[1]);
}

function updateHeaderState() {
  const hasContent =
    editor.value.trim().length > 0;

  const hasChanges =
    editor.value !== sourceEditorText;

  const shouldShowSave =
    hasChanges &&
    (
      hasContent ||
      sourceHadContent
    );

  const hasLinkedAudio =
    Boolean(linkedAudioPath);

  audioLinkInfo.textContent =
    hasLinkedAudio
      ? `${getDisplayName(linkedAudioPath)}`
      : "";

  audioLinkInfo.style.display =
    hasContent && hasLinkedAudio ? "" : "none";

  unlinkAudioBtn.style.display =
    hasContent && hasLinkedAudio ? "" : "none";
  
  const isAudioSession =
    /\.(wav|mp3)$/i.test(currentFilePath || "");

  const canStoreInAudio =
    hasContent &&
    isSavedTextProject() &&
    !hasLinkedAudio &&
    !isAudioSession;

  storeAudioBtn.style.display =
    canStoreInAudio ? "" : "none";

  storeAudioBtn.disabled =
    !canStoreInAudio;

  const shouldShowSession =
    Boolean(currentFilePath);

  saveBtn.style.display =
    shouldShowSave ? "" : "none";

  saveBtn.disabled =
    !shouldShowSave;

  filePathEl.style.display =
    shouldShowSession ? "" : "none";

  clearSessionBtn.style.display =
    shouldShowSession ? "" : "none";
  
  updateSidebarState();
  updateStudioTimingMenuState();
}

function getDisplayName(filePath) {
  if (!filePath) return "No file loaded";
  return String(filePath).split(/[\\/]/).pop();
}

function updateStudioTimingMenuState() {
  const isAvailable = canLinkStudioTiming();

  if (!isAvailable && studioTimingLink) {
    studioTimingLink = null;
    stopStudioTimingPolling();
    renderStatus();
  }

  window.EpicInspector?.updateStudioTimingMenuState?.({
    available: isAvailable,
    linked: Boolean(studioTimingLink),
    project: isWavProjectDocument()
  });
}

function unlinkStudioTiming({ silent = false } = {}) {
  studioTimingLink = null;
  stopStudioTimingPolling();

  if (!silent) {
    statusEl.textContent = "Studio timing unlinked.";
  }

  saveSessionState();
  updateStudioTimingMenuState();
}

async function refreshEpicValidationResult() {
  if (!window.EpicInspector?.parseEpic) return null;

  const result = await window.EpicInspector.parseEpic({
    source: editor.value
  });

  lastEpicValidationResult = result;
  updateNumericOrderingButton(result);
  return result;
}

function getStudioTimingSnapshotPayload(response) {
  if (!response) return null;
  if (Array.isArray(response.entries)) return response;
  if (Array.isArray(response.snapshot?.entries)) return response.snapshot;
  return null;
}

function hasStudioTimingContextChanged(snapshot) {
  if (studioTimingLink?.contextRevision == null) return false;

  const nextRevision = snapshot?.context?.contextRevision ?? null;
  return nextRevision !== null &&
    nextRevision !== studioTimingLink.contextRevision;
}

function startStudioTimingPolling() {
  stopStudioTimingPolling();

  studioTimingPollTimer = window.setInterval(() => {
    syncStudioTimingFromStudio({ quiet: true });
  }, 1200);
}

function stopStudioTimingPolling() {
  if (!studioTimingPollTimer) return;

  window.clearInterval(studioTimingPollTimer);
  studioTimingPollTimer = null;
}

function applyStudioTimingSnapshot(snapshot) {
  const entries = Array.isArray(snapshot?.entries)
    ? snapshot.entries
    : [];

  const parsedEntries =
    lastEpicValidationResult?.document?.format === "epicx"
      ? lastEpicValidationResult.document.body?.entries || []
      : [];

  if (!entries.length || !parsedEntries.length) {
    return {
      applied: false,
      reason: "No EPICX entries available for timing sync."
    };
  }

  if (entries.length !== parsedEntries.length) {
    return {
      applied: false,
      reason: "Studio timing could not be applied because entry counts do not match."
    };
  }

  const lines = editor.value.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < parsedEntries.length; index += 1) {
    const parsedEntry = parsedEntries[index];
    const studioEntry = entries[index];

    if (Number(studioEntry.index) !== index + 1) {
      return {
        applied: false,
        reason: "Studio timing could not be applied because entry indexes do not match."
      };
    }

    const entryLineIndex = (parsedEntry.loc?.startLine ?? 0) - 1;
    const timingLineIndex = entryLineIndex + 1;

    if (!isEpicxTimestampLine(lines[timingLineIndex] || "")) {
      return {
        applied: false,
        reason: `Studio timing could not be applied because entry ${index + 1} has no timing line.`
      };
    }
  }

  const nextLines = [...lines];

  for (let index = 0; index < parsedEntries.length; index += 1) {
    const parsedEntry = parsedEntries[index];
    const studioEntry = entries[index];
    const timingLine = String(studioEntry.timingLine || "").trim();
    const timingLineIndex = ((parsedEntry.loc?.startLine ?? 0) - 1) + 1;

    if (!isEpicxTimestampLine(timingLine)) {
      return {
        applied: false,
        reason: `Studio timing for entry ${index + 1} is invalid.`
      };
    }

    nextLines[timingLineIndex] = timingLine;
  }

  const nextText = nextLines.join("\n");

  if (nextText === editor.value) {
    return {
      applied: false,
      unchanged: true,
      reason: "Studio timing is already current."
    };
  }

  const selectionStart = editor.selectionStart;
  const selectionEnd = editor.selectionEnd;
  const scrollTop = editor.scrollTop;

  replaceEditorTextWithManualUndo(nextText);

  editor.setSelectionRange(
    Math.min(selectionStart, nextText.length),
    Math.min(selectionEnd, nextText.length)
  );
  editor.scrollTop = scrollTop;

  scheduleEpicValidation();
  updateHeaderState();
  saveSessionState();

  return { applied: true };
}

async function autoSaveStudioTimingIfClean(wasCleanBeforeTiming) {
  if (!wasCleanBeforeTiming || !isSavedEpicxProject()) return false;

  await saveCurrentTextFile({
    updateLinkedAudio: false,
    notifyStudio: false
  });
  return true;
}

async function notifyStudioOfSavedEpicx() {
  if (!studioTimingLink || !isSavedEpicxProject()) return;

  await window.EpicInspector?.notifyStudioEpicxSaved?.({
    filePath: currentFilePath,
    savedAt: new Date().toISOString()
  });
}

async function linkStudioTiming() {
  if (!canLinkStudioTiming()) return;
  if (isWavProjectDocument()) {
    const response = await window.EpicInspector.getStudioTimingSnapshot();
    if (receiveStudioProject(getStudioTimingSnapshotPayload(response), { initial: true })) startStudioTimingPolling();
    return;
  }

  let parseResult = null;

  try {
    parseResult = await refreshEpicValidationResult();
  } catch (err) {
    statusEl.textContent = `Studio timing link failed:\n${err.message || err}`;
    return;
  }

  if (parseResult?.document?.format !== "epicx") {
    statusEl.textContent = "Studio timing link requires a valid EPICX document.";
    return;
  }

  const snapshot = await window.EpicInspector?.getStudioTimingSnapshot?.();
  const payload = getStudioTimingSnapshotPayload(snapshot);

  if (!payload) {
    studioTimingLink = {
      contextRevision: null,
      timingFingerprint: "",
      linkedAt: new Date().toISOString(),
      waiting: true
    };

    statusEl.textContent =
      "Linked EPICX (Studio) timing; waiting for EPIC Studio.";
    startStudioTimingPolling();
    saveSessionState();
    updateStudioTimingMenuState();
    return;
  }

  const wasCleanBeforeTiming = !hasUnsavedChanges();
  const result = applyStudioTimingSnapshot(payload);

  if (!result.applied && !result.unchanged) {
    statusEl.textContent = result.reason;
    return;
  }

  if (result.applied) {
    try {
      await autoSaveStudioTimingIfClean(wasCleanBeforeTiming);
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Studio timing applied, but auto-save failed:\n${err.message || err}`;
      return;
    }
  }

  studioTimingLink = {
    contextRevision: payload?.context?.contextRevision ?? null,
    timingFingerprint: payload?.timingFingerprint || "",
    linkedAt: new Date().toISOString(),
    waiting: false
  };

  statusEl.textContent = result.applied
    ? "Linked EPICX (Studio) timing and applied current timing."
    : "Linked EPICX (Studio) timing.";

  startStudioTimingPolling();
  saveSessionState();
  updateStudioTimingMenuState();
}

async function syncStudioTimingFromStudio({ quiet = false } = {}) {
  if (!studioTimingLink || isStudioTimingSyncInProgress || isProjectSaveInProgress) return;

  isStudioTimingSyncInProgress = true;

  try {
    const snapshot = await window.EpicInspector?.getStudioTimingSnapshot?.();
    const payload = getStudioTimingSnapshotPayload(snapshot);

    if (!payload) {
      if (!quiet) {
        statusEl.textContent =
          snapshot?.message ||
          "EPIC Studio timing is not available.";
      }
      return;
    }

    if (!studioTimingLink || isProjectSaveInProgress) return;
    if (studioTimingLink.kind === 'project') {
      receiveStudioProject(payload);
      return;
    }

    if (hasStudioTimingContextChanged(payload)) {
      studioTimingLink = null;
      stopStudioTimingPolling();
      statusEl.textContent =
        "Studio timing unlinked because EPIC Studio changed projects.";
      saveSessionState();
      updateStudioTimingMenuState();
      return;
    }

    if (
      !studioTimingLink.waiting &&
      payload.timingFingerprint &&
      payload.timingFingerprint === studioTimingLink.timingFingerprint
    ) {
      return;
    }

    try {
      const parseResult = await refreshEpicValidationResult();

      if (parseResult?.document?.format !== "epicx") {
        statusEl.textContent =
          "Studio timing sync paused because the document is no longer valid EPICX.";
        return;
      }
    } catch (err) {
      statusEl.textContent =
        `Studio timing sync paused:\n${err.message || err}`;
      return;
    }

    const wasCleanBeforeTiming = !hasUnsavedChanges();
    const result = applyStudioTimingSnapshot(payload);

    if (!result.applied && !result.unchanged) {
      statusEl.textContent = result.reason;
      return;
    }

    if (result.applied) {
      try {
        await autoSaveStudioTimingIfClean(wasCleanBeforeTiming);
      } catch (err) {
        console.error(err);
        statusEl.textContent = `Studio timing applied, but auto-save failed:\n${err.message || err}`;
        return;
      }
    }

    studioTimingLink = {
      ...studioTimingLink,
      contextRevision: payload?.context?.contextRevision ?? null,
      timingFingerprint: payload?.timingFingerprint || "",
      waiting: false
    };

    if (result.applied && !wasCleanBeforeTiming) {
      statusEl.textContent = "Applied EPIC Studio timing update.";
    }

    saveSessionState();
    updateStudioTimingMenuState();
  } finally {
    isStudioTimingSyncInProgress = false;
  }
}

function handleStudioTimingMenuAction() {
  if (studioTimingLink) {
    unlinkStudioTiming();
    return;
  }

  linkStudioTiming();
}

function saveSessionState() {
  if (restoreInProgress) return;

  const state = {
    currentFilePath,
    currentMetadata,
    editorText: editor.value,
    statusText: stripPinnedStatusText(statusEl.textContent),
    validationText: validationStatusEl.textContent,
    sourceEditorText,
    linkedAudioPath,
    studioTimingLink,
    sourceHadContent,
    rawMetadataOpen,
    savedAt: new Date().toISOString()
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(state));
}

function restoreSessionState() {
  const raw = localStorage.getItem(SESSION_KEY);
  
  if (!raw) return;

  try {
    restoreInProgress = true;

    const state = JSON.parse(raw);
    linkedAudioPath = state.linkedAudioPath || "";
    studioTimingLink = state.studioTimingLink || null;

    sourceHadContent = Boolean(state.sourceHadContent);
    rawMetadataOpen = Boolean(state.rawMetadataOpen);

    sourceEditorText = state.sourceEditorText || editor.value;

    currentMetadata = state.currentMetadata || null;

    currentFilePath = state.currentFilePath || "";
    editor.value = state.editorText || "";
    refreshEditorView();

    filePathEl.textContent =
      currentFilePath
        ? getDisplayName(currentFilePath)
        : "Unsaved EPIC session";

    setStatus(state.statusText || "Restored session.");

    validationStatusEl.textContent =
      state.validationText || "";

    saveBtn.disabled = false;

    if (currentMetadata) {
      renderMetadata(currentMetadata);
      editMetadataBtn.disabled = false;
    } else {
      metadataPanel.textContent = "";
      clearMetadataHeaderTabs();
      editMetadataBtn.disabled = true;
    }

    if (editor.value.trim()) {
      scheduleEpicValidation();
    }
    updateHeaderState();
    updateStudioTimingMenuState();

    if (studioTimingLink && canLinkStudioTiming()) {
      startStudioTimingPolling();
    }
  } catch (err) {
    console.warn("Failed to restore session:", err);
  } finally {
    restoreInProgress = false;
  }
}

function resetSession() {
  switchEmotiveRecipeSong("");
  currentFilePath = "";
  currentMetadata = null;
  metadataEditMode = false;
  rawMetadataOpen = false;

  manualUndoStack = [];
  manualRedoStack = [];

  editor.value = "";
  refreshEditorView();

  sourceEditorText = "";
  sourceHadContent = false;

  filePathEl.textContent = "No file loaded";

  linkedAudioPath = "";
  studioTimingLink = null;
  stopStudioTimingPolling();

  setStatus("");

  validationStatusEl.textContent = "";

  metadataPanel.textContent = "";
  clearMetadataHeaderTabs();

  saveBtn.disabled = true;

  editMetadataBtn.disabled = true;

  setEditMetadataBtnIcon(false);
  editMetadataBtn.title = "Edit metadata";
  updateNumericOrderingButton(null);

  localStorage.removeItem(SESSION_KEY);
  updateHeaderState();
  updateStudioTimingMenuState();
  showGhostHeaderIfAppropriate();
}

function replaceEditorTextWithManualUndo(nextText) {
  pushUndoSnapshot();

  editor.value = nextText;

  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertReplacementText"
  }));
}

function scheduleEpicValidation() {
  clearTimeout(parseTimer);

  parseTimer = setTimeout(async () => {
    if (!window.EpicInspector?.parseEpic) return;

    try {
      const result = await window.EpicInspector.parseEpic({
        source: editor.value
      });

      lastEpicValidationResult = result;
      updateNumericOrderingButton(result);

      if (result.ok) {
        validationStatusEl.textContent =
          "EPIC/EPICX valid.";
        saveSessionState();
      } else if (result.empty) {
        validationStatusEl.textContent =
          "No EPIC/EPICX text.";
        saveSessionState();
      } else {
        const issues =
          result.issues ||
          result.errors ||
          [];

        validationStatusEl.textContent =
          `EPIC/EPICX parse issues:\n` +
          issues.map(formatParseIssue).join("\n");

        saveSessionState();
      }
    } catch (err) {
      validationStatusEl.textContent =
        `Parser failed:\n${err.message || err}`;
      
      saveSessionState();
    }
  }, 1300);
}

editor.addEventListener("input", scheduleEpicValidation);

function updateNumericOrderingButton(parseResult) {
  if (!numericOrderingBtn) return;

  const entries =
    parseResult?.document?.format === "epicx"
      ? parseResult.document.body?.entries || []
      : [];

  const shouldShow =
    entries.length > 0 &&
    entries.some((entry, index) => entry.index !== index + 1);

  numericOrderingBtn.style.display = shouldShow ? "" : "none";
}

function isEpicxTimestampLine(line) {
  return /^\s*\d{2}:\d{2}(?::\d{2})?\.\d{3}(?:\s*-->\s*\d{2}:\d{2}(?::\d{2})?\.\d{3})?\s*$/.test(line);
}

function timestampToMilliseconds(value) {
  const parts = value.trim().split(":").map(Number);
  const seconds = parts.pop();
  const minutes = parts.pop();
  const hours = parts.length ? parts.pop() : 0;
  const [wholeSeconds, milliseconds] = String(seconds).split(".").map(Number);
  return (((hours * 60) + minutes) * 60 + wholeSeconds) * 1000 + milliseconds;
}

function millisecondsToTimestamp(milliseconds, original) {
  const hasHours = original.trim().split(":").length === 3;
  const totalSeconds = Math.floor(milliseconds / 1000);
  const remainder = milliseconds % 1000;
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const minutes = String(Math.floor(totalSeconds / 60) % 60).padStart(2, "0");
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  return `${hasHours ? `${hours}:` : ""}${minutes}:${seconds}.${String(remainder).padStart(3, "0")}`;
}

function rememberAddedEpicxTimestamps(source, insertionStart, pastedText) {
  const timestampPattern = /\d{2}:\d{2}(?::\d{2})?\.\d{3}/g;
  const pastedTimestamps = [...pastedText.matchAll(timestampPattern)].map(match => match[0]);

  pastedTimestamps.forEach((timestamp, index) => {
    const occurrence = [...source.slice(0, insertionStart).matchAll(
      new RegExp(timestamp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
    )].length + index;
    pendingAddedEpicxTimestamps.push({ timestamp, occurrence });
  });
}

function adjustPendingAddedEpicxTimestamps(source) {
  if (pendingAddedEpicxTimestamps.length === 0) return source;

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const seen = new Map();
  const timestampLines = [];

  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)(\d{2}:\d{2}(?::\d{2})?\.\d{3})(\s*(?:-->.*)?\s*)$/);
    if (!match) return;
    const occurrence = seen.get(match[2]) || 0;
    seen.set(match[2], occurrence + 1);
    timestampLines.push({ index, timestamp: match[2], occurrence, match });
  });

  pendingAddedEpicxTimestamps.forEach(({ timestamp, occurrence }) => {
    const target = timestampLines.find(item => item.timestamp === timestamp && item.occurrence === occurrence);
    if (!target) return;

    const previous = timestampLines
      .filter(item => item.index < target.index)
      .at(-1);
    if (!previous) return;

    const currentMs = timestampToMilliseconds(target.timestamp);
    const previousMs = timestampToMilliseconds(previous.timestamp);
    if (currentMs >= previousMs + 2000) return;

    const adjusted = millisecondsToTimestamp(previousMs + 2000, target.timestamp);
    lines[target.index] = `${target.match[1]}${adjusted}${target.match[3]}`;
    target.timestamp = adjusted;
  });

  pendingAddedEpicxTimestamps = [];
  return lines.join("\n");
}

function resyncEpicxEntryIndexes(source, entries) {
  if (!entries || entries.length === 0) return source;

  const lines = source.replace(/\r\n/g, "\n").split("\n");

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const targetIndex = (entry.loc?.startLine ?? 0) - 1;

    if (targetIndex < 0 || targetIndex >= lines.length) continue;

    const existing = lines[targetIndex] || "";

    if (/^\s*\d+\s*$/.test(existing)) {
      const leading = existing.match(/^\s*/)?.[0] || "";
      const trailing = existing.match(/\s*$/)?.[0] || "";
      lines[targetIndex] = `${leading}${i + 1}${trailing}`;
      continue;
    }

    if (isEpicxTimestampLine(existing)) {
      lines.splice(targetIndex, 0, String(i + 1));
    }
  }

  return lines
    .join("\n")
    .replace(/\n{3,}(?=\d+\n\d{2}:\d{2}(?::\d{2})?\.\d{3})/g, "\n\n");
}

numericOrderingBtn?.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

numericOrderingBtn?.addEventListener("click", async () => {
  if (!window.EpicInspector?.parseEpic) return;

  const result = await window.EpicInspector.parseEpic({
    source: editor.value
  });

  if (!result?.document || result.document.format !== "epicx") {
    numericOrderingBtn.style.display = "none";
    return;
  }

  const entries = result.document.body?.entries || [];
  const timestampAdjusted = adjustPendingAddedEpicxTimestamps(editor.value);
  const normalized = resyncEpicxEntryIndexes(timestampAdjusted, entries);

  if (normalized !== editor.value) {
    const selectionStart = editor.selectionStart;
    const selectionEnd = editor.selectionEnd;
    const scrollTop = editor.scrollTop;
    const hadFocus = document.activeElement === editor;

    if (!hadFocus) {
      editor.focus({ preventScroll: true });
    }

    replaceEditorTextWithManualUndo(normalized);

    editor.setSelectionRange(
      Math.min(selectionStart, normalized.length),
      Math.min(selectionEnd, normalized.length)
    );
    editor.scrollTop = scrollTop;

    if (!hadFocus) {
      editor.blur();
    }

    scheduleEpicValidation();
    updateHeaderState();
    saveSessionState();
  }
});

function formatParseIssue(issue) {
  if (typeof issue === "string") return issue;

  const severity = issue.severity
    ? issue.severity.toUpperCase()
    : "ISSUE";

  const line = issue.line
    ? ` line ${issue.line}`
    : "";

  const code = issue.code
    ? ` [${issue.code}]`
    : "";

  return `${severity}${line}${code}: ${issue.message || JSON.stringify(issue)}`;
}

editor.addEventListener("input", saveSessionState);
editor.addEventListener("input", updateHeaderState);
window.addEventListener("beforeunload", saveSessionState);

function createStarterEpicx(filePath) {
  const baseName = String(filePath || "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.epic\.(wav|mp3)$/i, "")
    .replace(/\.(wav|mp3)$/i, "");

  const authorKey = getPreferredAuthorKey();
  const authorValue = getPreferredAuthorValue();

  return `---
Title: ${baseName}
${authorKey}: ${authorValue}
---

`;
}

function getStandardFields(metadata) {
  if (metadata?.format === "mp3") {
    const tags = metadata.mp3Tags || {};

    return {
      title: tags.title || "",
      artist: tags.artist || "",
      album: tags.album || "",
      track: tags.track || "",
      year: tags.year || "",
      genre: tags.genre || "",
      comment: tags.comment || ""
    };
  }

  const info = metadata?.listInfo || {};

  return {
    title: info.INAM || "",
    artist: info.IART || "",
    album: info.IPRD || "",
    track: info.ITRK || "",
    year: info.ICRD || "",
    genre: info.IGNR || "",
    comment: info.ICMT || ""
  };
}

function getEditableId3Fields(metadata) {
  if (metadata?.format !== "mp3") return [];

  return Array.isArray(metadata?.editableId3Frames)
    ? metadata.editableId3Frames
    : [];
}

function getAdditionalDataItems(metadata) {
  const items = Array.isArray(metadata?.additionalData)
    ? metadata.additionalData
    : [];

  if (metadata?.format !== "wav") return items;

  return filterWavAdditionalDataItems(items);
}

function isWavSoftwareAdditionalDataItem(item) {
  const label = String(item?.label || "").trim().toUpperCase();
  const id = String(item?.id || "").trim().toUpperCase();

  return (
    label === "ISFT" ||
    label === "SOFTWARE" ||
    id.endsWith(":ISFT") ||
    id.endsWith(":SOFTWARE")
  );
}

function filterWavAdditionalDataItems(items) {
  return items
    .map(item => {
      if (isWavSoftwareAdditionalDataItem(item)) return null;

      const children = Array.isArray(item?.children)
        ? filterWavAdditionalDataItems(item.children)
        : [];

      if (
        item?.label === "LIST/INFO" &&
        Array.isArray(item?.children) &&
        children.length === 0
      ) {
        return null;
      }

      return {
        ...item,
        value: item?.label === "LIST/INFO" && Array.isArray(item?.children)
          ? `${children.length} additional field${children.length === 1 ? "" : "s"}`
          : item?.value,
        children
      };
    })
    .filter(Boolean);
}

function getEditableId3FrameMap(metadata) {
  const editableFrames = getEditableId3Fields(metadata);

  return new Map(
    editableFrames
      .filter(frame => frame?.key)
      .map(frame => [frame.key, frame])
  );
}

function formatAdditionalDataText(items, depth = 0) {
  return items
    .map(item => {
      const label = String(item?.label || item?.id || "").trim();
      const value = String(item?.value || "").trim();
      const children = Array.isArray(item?.children)
        ? item.children
        : [];
      const indent = "  ".repeat(depth);
      const line = value
        ? `${indent}${label}: ${value}`
        : `${indent}${label}`;
      const childText = children.length
        ? `\n${formatAdditionalDataText(children, depth + 1)}`
        : "";

      return `${line}${childText}`;
    })
    .filter(Boolean)
    .join("\n");
}

function renderAdditionalDataRows(items, depth = 0, editableByKey = null) {
  if (!items.length && depth === 0) {
    return `<div class="additional-data-empty">No additional data found.</div>`;
  }

  return items.map((item, index) => {
    const label = String(item?.label || item?.id || "").trim();
    const value = String(item?.value || "").trim();
    const children = Array.isArray(item?.children)
      ? item.children
      : [];
    const editableFrame = item?.key && editableByKey
      ? editableByKey.get(item.key)
      : null;
    const editableKey = editableFrame?.key || "";
    const actions = [
      editableFrame
        ? `
          <button
            type="button"
            class="additional-data-edit-btn"
            data-additional-data-edit-key="${escapeHtml(editableKey)}"
            title="Edit ${escapeHtml(label)}"
          >
            <svg class="icon edit-mini-icon core-action">
              <use href="icons.svg#edit-mini-icon"></use>
            </svg>
          </button>
        `
        : "",
      (item?.removable || editableFrame) && editableKey
        ? `
          <button
            type="button"
            class="additional-data-remove-btn"
            data-additional-data-remove-key="${escapeHtml(editableKey)}"
            title="Remove ${escapeHtml(label)}"
          >
            <svg class="icon delete-icon core-action">
              <use href="icons.svg#delete-icon"></use>
            </svg>
          </button>
        `
        : ""
    ].filter(Boolean).join("");

    return `
      <div class="additional-data-row" style="margin-left: ${depth * 10}px;">
        <div class="additional-data-main">
          <div class="additional-data-key">${escapeHtml(label)}</div>
          <div class="additional-data-value" data-additional-data-value="${escapeHtml(editableKey)}">${escapeHtml(value)}</div>
          <div class="additional-data-actions-inline">${actions}</div>
        </div>
        ${children.length ? renderAdditionalDataRows(children, depth + 1, editableByKey) : ""}
      </div>
    `;
  }).join("");
}

function renderAdditionalDataHiddenFields(editableByKey) {
  if (!editableByKey?.size) return "";

  return Array.from(editableByKey.values()).map(frame => `
    <input
      type="hidden"
      data-id3-frame-key="${escapeHtml(frame?.key || "")}"
      data-id3-frame-id="${escapeHtml(frame?.id || "")}"
      data-id3-frame-type="${escapeHtml(frame?.type || "")}"
      data-id3-frame-description="${escapeHtml(frame?.description || "")}"
      data-id3-frame-language="${escapeHtml(frame?.language || "")}"
      value="${escapeHtml(frame?.value || "")}"
    />
  `).join("");
}

function renderAdditionalDataPanel(metadata, { editable = false } = {}) {
  const items = getAdditionalDataItems(metadata);
  const editableByKey = editable
    ? getEditableId3FrameMap(metadata)
    : null;
  const hasEditableItems = Boolean(editableByKey?.size);

  return `
    <div class="additional-data-list">
      ${hasEditableItems
        ? `
          <div class="additional-data-editor" data-additional-data-editor hidden>
            <div class="additional-data-editor-card">
              <div class="additional-data-editor-title" data-additional-data-editor-title></div>
              <textarea data-additional-data-editor-input></textarea>
              <div class="additional-data-editor-actions">
                <button type="button" class="text-link-btn" data-additional-data-editor-cancel>Cancel</button>
                <button type="button" class="metadata-done-btn" data-additional-data-editor-close>Done</button>
              </div>
            </div>
          </div>
          <div class="additional-data-hidden-fields">
            ${renderAdditionalDataHiddenFields(editableByKey)}
          </div>
        `
        : ""}
      ${renderAdditionalDataRows(items, 0, editableByKey)}
    </div>
  `;
}

function getEditableId3FormFields(form) {
  return Array.from(form.querySelectorAll("[data-id3-frame-key]"))
    .map(control => ({
      key: control.dataset.id3FrameKey || "",
      id: control.dataset.id3FrameId || "",
      type: control.dataset.id3FrameType || "",
      description: control.dataset.id3FrameDescription || "",
      language: control.dataset.id3FrameLanguage || "",
      value: String(control.value || "")
    }))
    .filter(frame => frame.key || frame.id);
}

async function saveMetadataFieldChanges(fields) {
  const result = await window.EpicInspector.saveMetadata({
    filePath: linkedAudioPath || currentFilePath,
    fields,
    albumArt: stagedAlbumArt
  });

  currentMetadata = result.metadata;
  stagedAlbumArt = undefined;
  saveSessionState();
  updateHeaderState();

  return result;
}

function wireAdditionalDataEditor(root) {
  const editorPanel = root.querySelector("[data-additional-data-editor]");
  const editorTitle = root.querySelector("[data-additional-data-editor-title]");
  const editorInput = root.querySelector("[data-additional-data-editor-input]");
  const editorCloseBtn = root.querySelector("[data-additional-data-editor-close]");
  const editorCancelBtn = root.querySelector("[data-additional-data-editor-cancel]");

  if (!editorPanel || !editorTitle || !editorInput) return;

  let activeKey = "";

  const getHiddenField = key => root.querySelector(
    `[data-id3-frame-key="${CSS.escape(key)}"]`
  );
  const getValueDisplay = key => root.querySelector(
    `[data-additional-data-value="${CSS.escape(key)}"]`
  );

  root.querySelectorAll("[data-additional-data-edit-key]").forEach(button => {
    button.addEventListener("click", () => {
      activeKey = button.dataset.additionalDataEditKey || "";

      const hiddenField = getHiddenField(activeKey);
      const row = button.closest(".additional-data-row");
      const label = row?.querySelector(".additional-data-key")?.textContent?.trim() || "Additional Data";

      editorTitle.textContent = label;
      editorInput.value = hiddenField?.value || "";
      editorPanel.hidden = false;
      editorInput.focus();
    });
  });

  root.querySelectorAll("[data-additional-data-remove-key]").forEach(button => {
    button.addEventListener("click", async () => {
      const key = button.dataset.additionalDataRemoveKey || "";
      const row = button.closest(".additional-data-row");
      const label = row?.querySelector(".additional-data-key")?.textContent?.trim() || "Additional Data";
      const ok = await showConfirmModal({
        title: "Remove Additional Data",
        message: `Remove ${label}?`,
        confirmLabel: "Remove",
        cancelLabel: "Cancel"
      });

      if (!ok) return;

      const hiddenField = getHiddenField(key);
      const valueDisplay = getValueDisplay(key);

      if (hiddenField) {
        hiddenField.value = "";
      }

      if (valueDisplay) {
        valueDisplay.textContent = "(marked for removal)";
      }

      if (activeKey === key) {
        editorInput.value = "";
        editorPanel.hidden = true;
        activeKey = "";
      }

      const fields = getStandardFields(currentMetadata);
      const editableId3Frames = getEditableId3FormFields(root);

      if (editableId3Frames.length) {
        fields.id3Frames = editableId3Frames;
      }

      try {
        statusEl.textContent = "Saving metadata...";
        await saveMetadataFieldChanges(fields);
        metadataEditMode = false;
        metadataActiveTab = "additional";
        renderMetadata(currentMetadata);
        statusEl.textContent = "Metadata saved.";
      } catch (err) {
        console.error(err);
        statusEl.textContent = `Metadata save failed:\n${err.message || err}`;
      }
    });
  });

  const saveActiveAdditionalDataEdit = async () => {
    if (!activeKey) return;

    const hiddenField = getHiddenField(activeKey);
    const valueDisplay = getValueDisplay(activeKey);

    if (hiddenField) {
      hiddenField.value = editorInput.value;
    }

    if (valueDisplay) {
      valueDisplay.textContent = editorInput.value;
    }

    const fields = getStandardFields(currentMetadata);
    const editableId3Frames = getEditableId3FormFields(root);

    if (editableId3Frames.length) {
      fields.id3Frames = editableId3Frames;
    }

    try {
      statusEl.textContent = "Saving metadata...";
      await saveMetadataFieldChanges(fields);
      metadataEditMode = false;
      editorPanel.hidden = true;
      activeKey = "";
      metadataActiveTab = "additional";
      renderMetadata(currentMetadata);
      statusEl.textContent = "Metadata saved.";
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Metadata save failed:\n${err.message || err}`;
    }
  };

  const closeAdditionalDataEditor = () => {
    editorPanel.hidden = true;
    activeKey = "";
  };

  editorCloseBtn?.addEventListener("click", saveActiveAdditionalDataEdit);
  editorCancelBtn?.addEventListener("click", closeAdditionalDataEditor);

  editorPanel.addEventListener("click", (event) => {
    if (event.target === editorPanel) {
      closeAdditionalDataEditor();
    }
  });

  editorInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAdditionalDataEditor();
    }
  });
}

function renderMetadataEditForm(metadata) {
  metadataEditMode = true;
  metadataActiveTab = "standard";
  renderMetadata(metadata);
}

clearSessionBtn?.addEventListener("click", async () => {
  if (!(await confirmDiscardUnsavedChanges())) return;
  resetSession();
});

editMetadataBtn?.addEventListener("click", () => {
  if (!currentMetadata) return;

  metadataEditMode = !metadataEditMode;

  if (metadataEditMode) {
    renderMetadataEditForm(currentMetadata);
    setEditMetadataBtnIcon(true);
    editMetadataBtn.title = "Close metadata editor";
  } else {
    renderMetadata(currentMetadata);
    setEditMetadataBtnIcon(false);
    editMetadataBtn.title = "Edit metadata";
  }

  updateHeaderState();
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function highlightEntryNumbers(text) {
  return text.replace(
    /(^|\n\n)(\d+)(\n\d{2}:\d{2}(?::\d{2})?\.\d{3})/g,
    (_, prefix, number, timestamp) =>
      `${prefix}<span class="epic-entry-number">${number}</span>${timestamp}`
  );
}

function highlightTimestamps(text) {
  return text.replace(
    /\b(\d{2}:\d{2}(?::\d{2})?\.\d{3})(\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3}))?/g,
    (match, start, rangePart = "") => {
      if (rangePart) {
        return `<span class="epic-time-range"><span class="epic-time">${start}</span>${rangePart.replace(
          /(\d{2}:\d{2}(?::\d{2})?\.\d{3})/,
          '<span class="epic-time">$1</span>'
        )}</span>`;
      }

      return `<span class="epic-time">${start}</span>`;
    }
  );
}

function getSectionTocEntries(source) {
  const lines = String(source || "").split("\n");
  const entries = [];

  let previousSectionIdentity = "";

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (!/^\[[^\]]+\]$/.test(trimmed)) return;

    const sectionIdentity = trimmed;

    if (sectionIdentity === previousSectionIdentity) {
      return;
    }

    previousSectionIdentity = sectionIdentity;

    entries.push({
      label: sectionIdentity,
      lineIndex: index
    });
  });

  return entries;
}

function getOffsetForLine(source, lineIndex) {
  const lines = String(source || "").split("\n");
  let offset = 0;

  for (let i = 0; i < lineIndex; i += 1) {
    offset += lines[i].length + 1;
  }

  return offset;
}

function renderSectionToc() {
  if (!tocList) return;

  const entries = getSectionTocEntries(editor.value);

  if (!entries.length) {
    tocList.innerHTML = `<div class="toc-empty">No sections found.</div>`;
    return;
  }

  const groups = groupSectionTocEntries(entries);

  tocList.innerHTML = groups.map((group) => {
    const items = group.entries.map((entry) => `
      <button
        class="toc-item"
        type="button"
        data-line-index="${entry.lineIndex}"
        title="${escapeHtml(entry.label)}"
      >
        <span class="toc-item-label">
          ${formatTocLabel(entry.label)}
        </span>
        ${parseSectionLabelLine(entry.label) ? `<span
          class="toc-item-more"
          role="button"
          tabindex="0"
          title="Emotive recipes"
          aria-label="Emotive recipes for this section"
        ><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg></span>` : ""}
      </button>
    `).join("");

    return group.entries.length > 1
      ? `<div class="toc-group">${items}</div>`
      : items;
  }).join("");

  tocList.querySelectorAll(".toc-item-more").forEach((more) => {
    const openMore = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const lineIndex = Number(more.closest(".toc-item").dataset.lineIndex);
      openEmotiveRecipeDialog(lineIndex);
    };

    more.addEventListener("click", openMore);
    more.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") openMore(event);
    });
    more.addEventListener("keyup", (event) => event.stopPropagation());
  });

  tocList.querySelectorAll(".toc-item").forEach((button) => {
    button.addEventListener("click", () => {
      const lineIndex = Number(button.dataset.lineIndex);
      const offset = getOffsetForLine(editor.value, lineIndex);

      // Move the caret to the section without stealing focus from the drawer.
      editor.setSelectionRange(offset, offset);

      const lineHeight =
        parseFloat(getComputedStyle(editor).lineHeight) || 20;

      editor.scrollTop =
        Math.max(0, lineIndex * lineHeight - 40);

      flashSection(lineIndex);
      refreshEditorView();
    });
  });
}

function updateTocDrawerAvailability() {
  if (!tocDrawer) return;

  const hasSections =
    getSectionTocEntries(editor.value).length > 0;

  tocDrawer.classList.toggle("is-hidden", !hasSections);

  if (!hasSections) {
    tocDrawer.classList.remove("open");
  }
}

function formatTocLabel(sectionIdentity) {
  return escapeHtml(sectionIdentity).replace(
    /^(\[)(.*?)(\{\{.*?\}\})?(])$/,
    (_, open, title, instruction = "", close) => {
      const instructionHtml = instruction
        ? instruction.replace(
            /^(\{\{)(.*?)(\}\})$/,
            `<span class="toc-item-decorator">$1</span>$2<span class="toc-item-decorator">$3</span>`
          )
        : "";

      return `<span class="toc-item-decorator">${open}</span>${title}${instructionHtml}<span class="toc-item-decorator">${close}</span>`;
    }
  );
}

function highlightInstructionBlocks(text) {
  return text.replace(
    /\{\{&\}([^{}]*?)\}\}|\{\{([^{}]*?)\}\}/g,
    (match, freeformInner) => {
      const cssClass = freeformInner !== undefined
        ? "epic-freeform-notation"
        : "epic-instruction";

      return `<span class="${cssClass}">${match}</span>`;
    }
  );
}

function highlightMarkdownInline(text) {
  return text
    .replace(
      /`([^`]+)`/g,
      '<span class="md-marker">`</span><span class="md-inline-code">$1</span><span class="md-marker">`</span>'
    )
    .replace(
      /(!?)\[([^\]]*)\]\(([^)]+)\)/g,
      (_, bang, label, target) => {
        if (bang) {
          return `<span class="md-image-ref"><span class="md-marker">![</span><span class="md-image-label">${label}</span><span class="md-marker">](</span><span class="md-image-target">${target}</span><span class="md-marker">)</span></span>`;
        }

        return `<span class="md-link-ref"><span class="md-marker">[</span><span class="md-link-label">${label}</span><span class="md-marker">](</span><span class="md-link-target">${target}</span><span class="md-marker">)</span></span>`;
      }
    )
    .replace(
      /\*\*([^*]+)\*\*/g,
      '<span class="md-marker">**</span><span class="md-bold">$1</span><span class="md-marker">**</span>'
    )
    .replace(
      /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
      '<span class="md-marker">*</span><span class="md-italic">$1</span><span class="md-marker">*</span>'
    );
}

function isMarkdownListLine(rawLine) {
  return /^\s*(-|\*|\+)\s+\S/.test(rawLine) ||
    /^\s*\d+\.\s+\S/.test(rawLine);
}

function isEpicxEntryIndexLine(rawLine) {
  return /^\s*\d+\s*$/.test(rawLine);
}

function isEpicxTimeLine(rawLine) {
  return /^\s*\d{2}:\d{2}(?::\d{2})?\.\d{3}(?:\s*-->\s*\d{2}:\d{2}(?::\d{2})?\.\d{3})?\s*$/.test(rawLine);
}

function isFreeflowSectionLine(rawLine) {
  return /^\s*\[\s*\{&\}[\s\S]*\]\s*$/.test(rawLine);
}

function renderEpicHighlight(value) {
  const lines = String(value).split("\n");

  let fenceCount = 0;
  let inHeader = false;
  let inEpicxEntry = false;
  let inFreeflowSection = false;
  let activeBlockClass = "";

  const rendered = lines.map((rawLine, index) => {
    const escaped = escapeHtml(rawLine);
    const previousLine = lines[index - 1] || "";

    const isEntryNumberLine =
      isEpicxEntryIndexLine(rawLine) &&
      isEpicxTimeLine(lines[index + 1] || "") &&
      (
        index === 0 ||
        previousLine.trim().length === 0
      );

    let highlighted =
      highlightTimestamps(
        highlightInstructionBlocks(
          highlightMarkdownInline(escaped)
        )
      );

    if (isEntryNumberLine) {
      highlighted =
        `<span class="epic-entry-number">${highlighted}</span>`;
    }
    const trimmed = rawLine.trim();

    const startsMultilineBlock =
      trimmed.startsWith("{{") &&
      !trimmed.includes("}}");

    const endsMultilineBlock =
      activeBlockClass &&
      trimmed.endsWith("}}");

    const startsFreeflowSection =
      !inHeader &&
      isFreeflowSectionLine(rawLine);

    const endsFreeflowSection =
      inFreeflowSection &&
      trimmed === ":::";

    const isFreeflowSectionContent =
      inFreeflowSection ||
      startsFreeflowSection;

    let lineHtml = highlighted;

    if (isFreeflowSectionContent) {
      const freeflowClass = startsFreeflowSection
        ? "epic-freeflow-section epic-freeflow-opener"
        : endsFreeflowSection
          ? "epic-freeflow-section epic-freeflow-closer"
          : "epic-freeflow-section";

      lineHtml = `<span class="${freeflowClass}">${highlighted}</span>`;
    } else if (trimmed === "---") {
      fenceCount += 1;

      inHeader = fenceCount === 1;

      lineHtml = `<span class="epic-header">${highlighted}</span>`;

      if (fenceCount === 2) {
        inHeader = false;
      }
    } else if (inHeader) {
      lineHtml = `<span class="epic-header">${highlighted}</span>`;
    } else if (/^\s*\[[^\]]+\]\s*$/.test(rawLine)) {
      lineHtml = `<span class="epic-section">${highlighted}</span>`;
    }

    if (startsFreeflowSection) {
      inFreeflowSection = true;
    }

    if (startsMultilineBlock) {
      activeBlockClass = trimmed.startsWith("{{&}")
        ? "epic-freeform-notation"
        : "epic-instruction";
    }

    if (activeBlockClass && !isFreeflowSectionContent) {
      lineHtml =
        `<span class="${activeBlockClass}">${highlighted}</span>`;
    }

    if (endsMultilineBlock) {
      activeBlockClass = "";
    }

    if (endsFreeflowSection) {
      inFreeflowSection = false;
    }

    const nextLine = lines[index + 1] || "";
    const startsEpicxEntry =
      isEpicxEntryIndexLine(rawLine) &&
      isEpicxTimeLine(nextLine);

    const isBlank =
      trimmed.length === 0;

    let output = "";

    if (!inHeader && isMarkdownListLine(rawLine)) {
      lineHtml = `<span class="md-list-line">${lineHtml}</span>`;
    }

    if (sectionFlash) {
      // Empty, zero-size markers: they only let us measure where the section
      // starts and ends. They add no text and do not change layout.
      if (index === sectionFlash.start) {
        lineHtml = `<span data-flash-marker="start"></span>${lineHtml}`;
      }
      if (index === sectionFlash.end) {
        lineHtml = `${lineHtml}<span data-flash-marker="end"></span>`;
      }
    }

    if (startsEpicxEntry) {
      if (inEpicxEntry) {
        output += `</span>`;
      }

      output += `<span class="epicx-entry">`;
      inEpicxEntry = true;
    }

    if (startsFreeflowSection) {
      output += `<span class="epic-freeflow-block">`;
    }

    if (inEpicxEntry && isBlank) {
      output += `${lineHtml}</span>`;
      inEpicxEntry = false;
      return output;
    }

    output += lineHtml;

    if (endsFreeflowSection) {
      output += `</span>`;
    }

    return output;
  }).join("\n");

  let output = rendered;

  if (inEpicxEntry) {
    output += `</span>`;
  }

  if (inFreeflowSection) {
    output += `</span>`;
  }

  return output;
}

function getCurrentAudioPath() {
  return linkedAudioPath || currentFilePath || "";
}

async function addAlbumArt() {
  const audioPath = getCurrentAudioPath();
  if (!audioPath) return;

  try {
    statusEl.textContent = "Adding album art...";

    const result = await window.EpicInspector.addAlbumArt({
      audioPath
    });

    if (!result) {
      statusEl.textContent = "Album art selection canceled.";
      return;
    }

    if (result.filePath) {
      currentFilePath = result.filePath;
    }

    currentMetadata = result.metadata;
    metadataEditMode = false;

    filePathEl.textContent = getDisplayName(currentFilePath);
    renderMetadata(currentMetadata);
    editMetadataBtn.disabled = false;
    statusEl.textContent = "Album art added.";
    saveSessionState();
    updateHeaderState();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Add album art failed:\n${err.message || err}`;
  }
}

function wireAlbumArtNormalModeActions() {
  document.getElementById("replaceAlbumArtBtn")
    ?.addEventListener("click", addAlbumArt);

  document.getElementById("deleteAlbumArtBtn")
    ?.addEventListener("click", confirmRemoveAlbumArt);
}

async function confirmRemoveAlbumArt() {
  const ok = await showConfirmModal({
    title: "Remove Album Art",
    message: "Remove album art from this audio file? This cannot be undone unless you add the image again.",
    confirmLabel: "Yes",
    cancelLabel: "Cancel"
  });

  if (!ok) return;

  removeAlbumArt();
}

async function removeAlbumArt() {
  const audioPath = getCurrentAudioPath();
  if (!audioPath) return;

  try {
    statusEl.textContent = "Removing album art...";

    const result = await window.EpicInspector.saveMetadata({
      filePath: audioPath,
      albumArt: null
    });

    currentMetadata = result.metadata;
    metadataEditMode = false;

    renderMetadata(currentMetadata);
    updateHeaderState();

    statusEl.textContent = "Album art removed.";
    saveSessionState();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Remove album art failed:\n${err.message || err}`;
  }
}

function renderMetadata(metadata) {
  if (!metadataPanel) return;

  const isMp3 = metadata?.format === "mp3";
  const info = metadata?.listInfo || {};
  const mp3 = metadata?.mp3Tags || {};
  const chunks = metadata?.wavChunks || [];
  const albumArtInfo = metadata?.albumArtInfo;
  const albumArtBase64 = typeof metadata?.albumArt === "string"
    ? metadata.albumArt
    : albumArtInfo?.data;
  const albumArtMime = metadata?.albumArtMime || albumArtInfo?.mimeType;

  const items = isMp3
    ? [
        ["Name", mp3.title || ""],
        ["Artist", mp3.artist || ""],
        ["Album", mp3.album || ""],
        ["Track Number", mp3.track || ""],
        ["Year", mp3.year || ""],
        ["Genre", mp3.genre || ""],
        ["Comments", mp3.comment || ""],
        ["EPIC", metadata?.epicx ? "Present" : "None"],
        ...(metadata?.epicx
          ? [["EPIC Size", `${metadata.epicx.length} chars`]]
          : []),
        ["ID3 Version", metadata?.id3?.version || ""],
        ["ID3 Frames", metadata?.id3?.frameCount ?? ""],
        ["ID3v1", metadata?.id3?.v1Present ? "Present" : ""]
      ]
    : [
        ["Name", info.INAM || ""],
        ["Artist", info.IART || ""],
        ["Album", info.IPRD || ""],
        ["Track Number", info.ITRK || ""],
        ["Year", info.ICRD || ""],
        ["Genre", info.IGNR || ""],
        ["Comments", info.ICMT || ""],
        ["Software", info.ISFT || ""],
        ["EPIC", metadata?.epicx ? "Present" : "None"],
        ...(metadata?.epicx
          ? [["EPIC Size", `${metadata.epicx.length} chars`]]
          : []),
        ["WAV Chunks", chunks.map(chunk => chunk.id.trim()).join(", ")]
      ];

  const visibleItems = items.filter(([, value]) => {
    return String(value ?? "").trim() !== "";
  });

  const standardReadHtml = visibleItems.map(([key, value]) => `
    <div class="meta-item">
      <div class="meta-key">${escapeHtml(key)}</div>
      <div class="meta-value">${escapeHtml(value)}</div>
    </div>
  `).join("");
  const fields = getStandardFields(metadata);
  const standardEditHtml = `
    <div class="standard-metadata-toolbar">
      <button type="button" class="icon-btn cancelMetadataEditBtn" title="Close standard metadata editor">
        <svg class="icon close-icon core-action">
          <use href="icons.svg#close-icon"></use>
        </svg>
      </button>
    </div>

    <div class="metadata-field">
      <label for="standardTitle">Name</label>
      <input id="standardTitle" name="title" value="${escapeHtml(fields.title)}" />
    </div>

    <div class="metadata-field">
      <label for="standardArtist">Artist</label>
      <input id="standardArtist" name="artist" value="${escapeHtml(fields.artist)}" />
    </div>

    <div class="metadata-field">
      <label for="standardAlbum">Album</label>
      <input id="standardAlbum" name="album" value="${escapeHtml(fields.album)}" />
    </div>

    <div class="metadata-field">
      <label for="standardTrack">Track Number</label>
      <input id="standardTrack" name="track" value="${escapeHtml(fields.track)}" />
    </div>

    <div class="metadata-field">
      <label for="standardYear">Year</label>
      <input id="standardYear" name="year" value="${escapeHtml(fields.year)}" />
    </div>

    <div class="metadata-field">
      <label for="standardGenre">Genre</label>
      <input id="standardGenre" name="genre" value="${escapeHtml(fields.genre)}" />
    </div>

    <div class="metadata-field">
      <label for="standardComment">Comments</label>
      <textarea id="standardComment" name="comment">${escapeHtml(fields.comment)}</textarea>
    </div>

      <div class="metadata-actions">
        <button type="button" class="text-link-btn cancelMetadataEditBtn">Cancel</button>
        <button type="submit" class="metadata-done-btn">Done</button>
      </div>
  `;
  let albumArtHtml = "";

  if (
    albumArtBase64 &&
    albumArtMime &&
    String(albumArtMime).startsWith("image/")
  ) {
    const dataUrl = `data:${albumArtMime};base64,${albumArtBase64}`;

    albumArtHtml = `
      <div class="album-art-container">
        <div class="album-art-shell">
          <img class="album-art-preview" src="${dataUrl}" alt="Album Art" />

          <div class="album-art-hover-actions">
            <button type="button" id="replaceAlbumArtBtn" title="Replace album art">
              <svg class="icon edit-mini-icon core-action">
                <use href="icons.svg#edit-mini-icon"></use>
              </svg>
            </button>

            <button type="button" id="deleteAlbumArtBtn" title="Remove album art">
              <svg class="icon delete-icon core-action">
                <use href="icons.svg#delete-icon"></use>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
  } else {
    albumArtHtml = `
      <button type="button" id="standardAddAlbumArtBtn" title="Add album art">Add Album Art</button>
    `;
  }
  const additionalDataPanel = renderAdditionalDataPanel(metadata, { editable: true });

  if (metadataHeaderTabs) {
    metadataHeaderTabs.innerHTML = `
      <div class="metadata-tabs" role="tablist" aria-label="Metadata sections">
        <button type="button" class="metadata-tab ${metadataActiveTab === "standard" ? "active" : ""}" data-metadata-tab="standard" role="tab" aria-selected="${metadataActiveTab === "standard" ? "true" : "false"}">General</button>
        <button type="button" class="metadata-tab ${metadataActiveTab === "additional" ? "active" : ""}" data-metadata-tab="additional" role="tab" aria-selected="${metadataActiveTab === "additional" ? "true" : "false"}">Additional Data</button>
      </div>
    `;
  }

  metadataPanel.innerHTML = `
    <form id="metadataEditForm" class="metadata-form">
      <div class="metadata-tab-panel" data-metadata-tab-panel="standard" ${metadataActiveTab === "standard" ? "" : "hidden"}>
        ${metadataEditMode
          ? standardEditHtml
          : `
            <div class="standard-metadata-toolbar">
              <button type="button" id="standardMetadataEditBtn" class="icon-btn" title="Edit standard metadata">
                <svg class="icon edit-mini-icon core-action">
                  <use href="icons.svg#edit-mini-icon"></use>
                </svg>
              </button>
            </div>
            ${standardReadHtml}
            ${albumArtHtml}
          `}
      </div>

      <div class="metadata-tab-panel" data-metadata-tab-panel="additional" ${metadataActiveTab === "additional" ? "" : "hidden"}>
        ${additionalDataPanel}
      </div>
    </form>
  `;

  metadataHeaderTabs?.querySelectorAll("[data-metadata-tab]").forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.metadataTab || "standard";
      metadataActiveTab = target;

      metadataHeaderTabs.querySelectorAll("[data-metadata-tab]").forEach(candidate => {
        const active = candidate.dataset.metadataTab === target;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-selected", active ? "true" : "false");
      });

      metadataPanel.querySelectorAll("[data-metadata-tab-panel]").forEach(panel => {
        panel.hidden = panel.dataset.metadataTabPanel !== target;
      });
    });
  });

  document.getElementById("standardMetadataEditBtn")?.addEventListener("click", () => {
    metadataEditMode = true;
    metadataActiveTab = "standard";
    renderMetadata(currentMetadata);
    updateHeaderState();
  });

  metadataPanel.querySelectorAll(".cancelMetadataEditBtn").forEach(button => {
    button.addEventListener("click", () => {
    metadataEditMode = false;
    renderMetadata(currentMetadata);
    updateHeaderState();
    });
  });

  document.getElementById("metadataEditForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const fields = {
      title: String(form.get("title") || ""),
      artist: String(form.get("artist") || ""),
      album: String(form.get("album") || ""),
      track: String(form.get("track") || ""),
      year: String(form.get("year") || ""),
      genre: String(form.get("genre") || ""),
      comment: String(form.get("comment") || "")
    };
    const editableId3Frames = getEditableId3FormFields(event.currentTarget);

    if (editableId3Frames.length) {
      fields.id3Frames = editableId3Frames;
    }

    try {
      statusEl.textContent = "Saving metadata...";
      await saveMetadataFieldChanges(fields);
      metadataEditMode = false;
      metadataActiveTab = "standard";
      renderMetadata(currentMetadata);
      statusEl.textContent = "Metadata saved.";
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Metadata save failed:\n${err.message || err}`;
    }
  });

  wireAlbumArtNormalModeActions();
  document.getElementById("standardAddAlbumArtBtn")?.addEventListener("click", addAlbumArt);
  wireAdditionalDataEditor(metadataPanel);
}

editor.addEventListener("focus", showGhostHeaderIfAppropriate);
editor.addEventListener("blur", showGhostHeaderIfAppropriate);

editor.addEventListener("input", () => {
  updateTocDrawerAvailability();

  if (tocDrawer?.classList.contains("open")) {
    renderSectionToc();
  }

  showGhostHeaderIfAppropriate();
  rememberAuthorKeyCorrection();
});

editor.addEventListener("keydown", (event) => {

  const isUndo =
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey &&
  event.key.toLowerCase() === "z";

  const isRedo =
    (event.metaKey || event.ctrlKey) &&
    (
      (event.shiftKey && event.key.toLowerCase() === "z") ||
      event.key.toLowerCase() === "y"
    );

  const isFreeflowCloserShortcut =
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    (event.key === ":" || event.code === "Semicolon");

  if (isUndo) {
    if (applyEditorHistoryAction("undo")) {
      event.preventDefault();
      return;
    }
  }

  if (isRedo) {
    if (applyEditorHistoryAction("redo")) {
      event.preventDefault();
      return;
    }
  }

  if (isFreeflowCloserShortcut) {
    event.preventDefault();
    insertFreeflowSectionCloser();
    return;
  }

  if (
    ghostHeaderVisible &&
    (event.key === "Enter" || event.key === "Tab")
  ) {
    event.preventDefault();
    commitGhostHeader();
    return;
  }

  if (event.key === "Tab") {
    if (expandFreeflowSectionTrigger()) {
      event.preventDefault();
      return;
    }

    if (moveOutOfFreeflowSectionOpener()) {
      event.preventDefault();
      return;
    }

    if (moveToNextHeaderValue()) {
      event.preventDefault();
    }
  }
});

openBtn.addEventListener("click", async () => {
  try {
    if (!(await confirmDiscardUnsavedChanges())) return;

    const result = await window.EpicInspector.openMedia();

    if (!result) return;

    manualUndoStack = [];
    manualRedoStack = [];

    resetSession();
    switchEmotiveRecipeSong(result.filePath || "");

    if (result.filePath) {
      currentFilePath = result.filePath;
    }

    if (result.kind === "text") {
      editor.value = result.text || "";
      refreshEditorView();

      sourceEditorText = editor.value;
      sourceHadContent =
        editor.value.trim().length > 0;

      currentMetadata = null;
      metadataEditMode = false;

      metadataPanel.textContent = "";
      clearMetadataHeaderTabs();
      editMetadataBtn.disabled = true;
      setEditMetadataBtnIcon(false);
      editMetadataBtn.title = "Edit metadata";

      filePathEl.textContent = getDisplayName(currentFilePath);
      saveBtn.disabled = false;

      statusEl.textContent = "Loaded EPIC text file.";

      scheduleEpicValidation();
      saveSessionState();
      updateHeaderState();

      return;
    }

    editor.value = result.epicx || "";
    refreshEditorView();
    
    sourceEditorText = editor.value;
    sourceHadContent =
      sourceEditorText.trim().length > 0;

    scheduleEpicValidation();
    renderMetadata(result.metadata);

    currentMetadata = result.metadata;
    metadataEditMode = false;

    setEditMetadataBtnIcon(false);
    editMetadataBtn.title = "Edit metadata";
    editMetadataBtn.disabled = false;

    filePathEl.textContent = getDisplayName(currentFilePath);
    saveBtn.disabled = false;

    if (result.epicx) {
      statusEl.textContent =
        `Loaded media\n` +
        `EPIC size: ${result.epicx.length} chars`;
    } else {
      statusEl.textContent = "Loaded media";
    }

    saveSessionState();
    updateHeaderState();

  } catch (err) {
    console.error(err);
    statusEl.textContent = `Open failed:\n${err.message || err}`;
  }
});

function toggleTocDrawer() {
  const willOpen =
    !tocDrawer?.classList.contains("open");

  if (willOpen) {
    renderSectionToc();
  }

  tocDrawer?.classList.toggle("open", willOpen);
}

tocToggleBtn?.addEventListener("click", toggleTocDrawer);

tocCloseBtn?.addEventListener("click", () => {
  tocDrawer?.classList.remove("open");
});

// Hotkeys (when not typing and no dialog is open):
//   n = toggle the section drawer (navigation)
//   t = focus the editor (text)
function isTypingTarget(node) {
  if (!(node instanceof HTMLElement)) return false;
  return (
    node.isContentEditable ||
    node.tagName === "INPUT" ||
    node.tagName === "TEXTAREA" ||
    node.tagName === "SELECT"
  );
}

// True when a single-key hotkey should not fire: modifiers held, key repeat,
// the person is typing, or a dialog is open.
function shouldIgnoreHotkey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  if (event.repeat || event.defaultPrevented) return true;
  if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return true;
  if (emotiveState) return true;
  if (!document.getElementById("confirmModal")?.classList.contains("hidden")) return true;
  return false;
}

window.addEventListener("keydown", (event) => {
  const key = String(event.key || "").toLowerCase();
  if (key !== "n" && key !== "t") return;
  if (shouldIgnoreHotkey(event)) return;

  if (key === "n") {
    // "n" = navigation: toggle the section drawer.
    if (!tocDrawer || tocDrawer.classList.contains("is-hidden")) return;

    event.preventDefault();
    toggleTocDrawer();
    return;
  }

  // "t" = text: put the cursor back in the editor.
  if (!editor || editor.disabled || editor.offsetParent === null) return;

  event.preventDefault();
  editor.focus();
});

// Escape leaves whatever text field has focus (including the editor), so
// single-key hotkeys like "n" work again. The recipe popup and the confirm
// dialog handle Escape themselves.
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (emotiveState) return;
  if (!document.getElementById("confirmModal")?.classList.contains("hidden")) return;

  const active = document.activeElement;
  if (isTypingTarget(active)) active.blur();
});

storeAudioBtn?.addEventListener("click", async () => {
  try {
    if (!isSavedTextProject()) {
      statusEl.textContent =
        "Save this EPIC project before storing it in audio.";
      return;
    }

    if (hasUnsavedChanges()) {
      const ok = await showConfirmModal({
        title: "Save Changes First",
        message: "This project has unsaved changes. Save them before storing in audio?",
        confirmLabel: "Save",
        cancelLabel: "Cancel"
      });

      if (!ok) return;

      await performSave();

      if (hasUnsavedChanges()) {
        statusEl.textContent =
          "Store in Audio canceled because the project was not saved.";
        return;
      }
    }

    statusEl.textContent = "Storing in audio...";

    const result = await window.EpicInspector.storeInAudio({
      targetPath: "",
      epicx: editor.value,
      projectLabel:
        currentFilePath
          ? getDisplayName(currentFilePath)
          : "Unsaved EPIC project"
    });

    if (!result) {
      statusEl.textContent = "Link audio canceled.";
      return;
    }

    if (result.useExistingEpicx) {
      switchEmotiveRecipeSong(result.filePath);
      currentFilePath = result.filePath;
      linkedAudioPath = "";

      currentMetadata = result.metadata;
      metadataEditMode = false;

      editor.value = result.epicx || "";
      refreshEditorView();

      sourceEditorText = editor.value;
      sourceHadContent =
        editor.value.trim().length > 0;

      filePathEl.textContent =
        getDisplayName(currentFilePath);

      renderMetadata(currentMetadata);

      editMetadataBtn.disabled = false;

      statusEl.textContent =
        `Opened audio using existing embedded EPIC:\n${getDisplayName(currentFilePath)}`;

      scheduleEpicValidation();
      saveSessionState();
      updateHeaderState();

      return;
    }

    linkedAudioPath = result.filePath;
    currentMetadata = result.metadata;

    renderMetadata(currentMetadata);

    editMetadataBtn.disabled = false;

    statusEl.textContent =
      result.verified
        ? `Stored in audio:\n${getDisplayName(linkedAudioPath)}`
        : `Stored in audio, but verification failed:\n${getDisplayName(linkedAudioPath)}`;

    saveSessionState();
    updateHeaderState();
  } catch (err) {
    console.error(err);
    statusEl.textContent =
      `Link audio failed:\n${err.message || err}`;
  }
});

unlinkAudioBtn?.addEventListener("click", () => {
  linkedAudioPath = "";
  currentMetadata = null;
  metadataPanel.textContent = "";
  clearMetadataHeaderTabs();
  editMetadataBtn.disabled = true;
  saveSessionState();
  updateHeaderState();
});

async function saveCurrentTextFile({
  updateLinkedAudio = true,
  notifyStudio = true
} = {}) {
  const result = await window.EpicInspector.saveText({
    filePath: currentFilePath,
    text: editor.value
  });

  sourceEditorText = editor.value;
  sourceHadContent =
    editor.value.trim().length > 0;


  if (updateLinkedAudio && linkedAudioPath) {
    const audioResult =
      await window.EpicInspector.storeInAudio({
        targetPath: linkedAudioPath,
        epicx: editor.value,
        projectLabel:
          getDisplayName(currentFilePath) ||
          "Current project"
      });

    currentMetadata = audioResult.metadata;
    renderMetadata(currentMetadata);
  }

  saveSessionState();
  updateHeaderState();

  if (notifyStudio) {
    try {
      await notifyStudioOfSavedEpicx();
    } catch (err) {
      console.warn("Studio save notification failed:", err);
    }
  }

  return result;
}

async function performSave({ saveAs = false } = {}) {
  try {
    if (studioTimingLink?.kind === 'project') {
      if (saveAs) {
        statusEl.textContent =
          "This project is linked to Studio, which saves it. Unlink it from Studio first to use Save As.";
        return;
      }
      await saveLinkedStudioProject();
      return;
    }
    statusEl.textContent = saveAs ? "Save As..." : "Saving...";

    const isTextFile = /\.(epic|epicx|txt|md)$/i.test(currentFilePath || "");

    if (isTextFile && saveAs) {
      // Write the text to a new file and keep editing that file. Linked audio
      // and Studio are not touched; the next Save updates them as usual.
      const result = await window.EpicInspector.saveTextAs({
        text: editor.value,
        defaultPath: currentFilePath
      });

      if (!result) {
        statusEl.textContent = "Save As canceled.";
        return;
      }

      currentFilePath = result.filePath;
      sourceEditorText = editor.value;
      sourceHadContent = editor.value.trim().length > 0;

      filePathEl.textContent = getDisplayName(currentFilePath);
      statusEl.textContent = `Saved as:\n${getDisplayName(result.filePath)}`;

      saveSessionState();
      updateHeaderState();
      return;
    }

    if (isTextFile) {
      const result = await saveCurrentTextFile();

      statusEl.textContent =
        linkedAudioPath
          ? `Saved text and updated audio:\n${getDisplayName(result.filePath)} ↔ ${getDisplayName(linkedAudioPath)}`
          : `Saved text file:\n${getDisplayName(result.filePath)}`;

      return;
    }

    if (!currentFilePath) {
      const result = await window.EpicInspector.saveTextAs({
        text: editor.value
      });

      if (!result) return;

      currentFilePath = result.filePath;
      sourceEditorText = editor.value;
      sourceHadContent =
        editor.value.trim().length > 0;


      filePathEl.textContent = getDisplayName(currentFilePath);

      statusEl.textContent =
        `Saved text file:\n${getDisplayName(result.filePath)}`;

      saveSessionState();
      updateHeaderState();
      return;
    }

    const result = await window.EpicInspector.saveMedia({
      filePath: linkedAudioPath || currentFilePath,
      epicx: editor.value,
      saveAs
    });

    if (!result) {
      statusEl.textContent = saveAs ? "Save As canceled." : "Save canceled.";
      return;
    }

    currentFilePath = result.filePath;
    filePathEl.textContent = getDisplayName(currentFilePath);

    renderMetadata(result.reread);

    currentMetadata = result.reread;
    sourceEditorText = editor.value;
    sourceHadContent =
      editor.value.trim().length > 0;

    statusEl.textContent =
      `Save complete\n` +
      `Verified: ${result.verified ? "yes" : "NO"}\n` +
      `Expected length: ${result.expectedLength}\n` +
      `Read-back length: ${result.actualLength}`;

    saveSessionState();
    updateHeaderState();

  } catch (err) {
    console.error(err);
    statusEl.textContent = `Save failed:\n${err.message || err}`;
  }
}

saveBtn.addEventListener("click", () => performSave());

addAlbumArtBtn?.addEventListener("click", () => {
  addAlbumArt();
});

// File > Save / Save As... (and their shortcuts) live in the application menu;
// main.js calls this when one of them is chosen.
window.epicMenuSave = (options = {}) => performSave({ saveAs: Boolean(options.saveAs) });

editor.addEventListener("input", requestEditorHighlightSync);
editor.addEventListener("keyup", requestEditorHighlightSync);
editor.addEventListener("mouseup", requestEditorHighlightSync);
editor.addEventListener("click", requestEditorHighlightSync);
editor.addEventListener("click", maybeShowAuthorKeyPicker);
editor.addEventListener("select", requestEditorHighlightSync);

editor.addEventListener("scroll", requestEditorHighlightSync);

editor.addEventListener("beforeinput", (event) => {
  if (isApplyingUndo) return;

  if (event.inputType === "historyUndo") {
    if (applyEditorHistoryAction("undo")) {
      event.preventDefault();
    }
    return;
  }

  if (event.inputType === "historyRedo") {
    if (applyEditorHistoryAction("redo")) {
      event.preventDefault();
    }
    return;
  }

  const scrollTop = editor.scrollTop;

  if (
    event.inputType === "insertFromPaste" &&
    event.data &&
    editor.selectionStart === editor.selectionEnd
  ) {
    rememberAddedEpicxTimestamps(editor.value, editor.selectionStart, event.data);
  }

  pushUndoSnapshot();

  requestAnimationFrame(() => {
    editor.scrollTop = scrollTop;
  });
});

/* ==========================================================================
   Section flash: brief background highlight after jumping to a section
   ========================================================================== */

function installSectionFlashStyles() {
  const css = `
.epic-section-flash-band {
  position: absolute; left: 0; right: 0; pointer-events: none;
  background-color: rgba(124, 156, 255, 0);
  animation: epic-section-flash-fade ${SECTION_FLASH_MS}ms ease-out both;
}
@keyframes epic-section-flash-fade {
  0%   { background-color: rgba(124, 156, 255, .24); }
  100% { background-color: rgba(124, 156, 255, 0); }
}
`;
  try {
    if ("adoptedStyleSheets" in document && typeof CSSStyleSheet !== "undefined") {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return;
    }
  } catch (_) { /* fall through to <style> */ }
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

// Draws one solid band behind the flashed section. The band is absolutely
// positioned inside the highlight layer (so it scrolls with the text) and takes
// no space in the text flow, so nothing moves when it appears or disappears.
function updateSectionFlashOverlay() {
  if (!editorHighlight || !sectionFlash) return;

  const startMarker = editorHighlight.querySelector('[data-flash-marker="start"]');
  const endMarker = editorHighlight.querySelector('[data-flash-marker="end"]');
  if (!startMarker || !endMarker) return;

  if (getComputedStyle(editorHighlight).position === "static") {
    editorHighlight.style.position = "relative";
  }

  const lineHeight = parseFloat(getComputedStyle(editorHighlight).lineHeight) || 20;
  const layerRect = editorHighlight.getBoundingClientRect();
  const startRect = startMarker.getBoundingClientRect();
  const endRect = endMarker.getBoundingClientRect();

  // Marker rects cover the font box; expand to whole line boxes, then convert
  // to the layer's scrolled content coordinates.
  const origin = layerRect.top + editorHighlight.clientTop - editorHighlight.scrollTop;
  const top = startRect.top + startRect.height / 2 - lineHeight / 2 - origin;
  const bottom = endRect.top + endRect.height / 2 + lineHeight / 2 - origin;
  if (!(bottom > top)) return;

  const elapsed = Math.max(0, Math.min(SECTION_FLASH_MS, Date.now() - sectionFlash.startedAt));

  const band = document.createElement("div");
  band.className = "epic-section-flash-band";
  band.style.top = `${top}px`;
  band.style.height = `${bottom - top}px`;
  // Negative delay keeps the fade continuous when the layer re-renders mid-flash.
  band.style.animationDelay = `-${elapsed}ms`;
  editorHighlight.appendChild(band);
}

// In .epicx, an entry's number and timestamp sit on the two lines above its
// [Section] label. Returns the first line of that entry (or the label line).
function getEntryStartLine(lines, labelLine) {
  let start = labelLine;

  if (isEpicxTimeLine(lines[start - 1] || "")) {
    start -= 1;
    if (isEpicxEntryIndexLine(lines[start - 1] || "")) start -= 1;
  }

  return start;
}

// Highlights the section from its first line (including the .epicx entry
// number and timestamp) through the line before the next drawer entry's own
// number/timestamp, with trailing blank lines excluded.
function flashSection(lineIndex) {
  const lines = editor.value.split("\n");
  const entries = getSectionTocEntries(editor.value);
  const position = entries.findIndex((entry) => entry.lineIndex === lineIndex);

  const start = getEntryStartLine(lines, lineIndex);

  let end = position >= 0 && position < entries.length - 1
    ? getEntryStartLine(lines, entries[position + 1].lineIndex) - 1
    : lines.length - 1;

  while (end > start && lines[end].trim() === "") end -= 1;

  clearTimeout(sectionFlashTimer);
  sectionFlash = { start, end, startedAt: Date.now() };
  requestEditorHighlightSync();

  sectionFlashTimer = setTimeout(() => {
    sectionFlash = null;
    requestEditorHighlightSync();
  }, SECTION_FLASH_MS + 100);
}

installSectionFlashStyles();

/* ==========================================================================
   Emotive recipes (section drawer "more" popup)
   Vocabulary, axes, definitions and syntax rules come from
   "epic Module: Emotives 2.1".

   A recipe is written into the section label's instruction block (shorthand):
     [Chorus {{energetic, swell, strong}}]
   Shorthand rules: emotives first, prominence modifiers last (arcs, when
   present, come after modifiers). Arcs are not composed in this pass, but
   existing arcs on a label are preserved.
   ========================================================================== */

const EMOTIVE_LAYERS = [
  {
    name: "Movement",
    axes: [
      { name: "Direction", pair: ["rise", "fall"] },
      { name: "Collection", pair: ["converge", "drift"] }
    ]
  },
  {
    name: "Dynamics",
    axes: [
      { name: "Intensity", pair: ["swell", "decay"] },
      { name: "Energy", pair: ["energetic", "calm"] }
    ]
  },
  {
    name: "Perception",
    axes: [
      { name: "Atmosphere", pair: ["light", "dark"] },
      { name: "Distortion", pair: ["warp", "blur"] },
      { name: "Visibility", pair: ["reveal", "fade"] },
      { name: "Micro-motion", pair: ["smooth", "turbulent"] },
      { name: "Timing", pair: ["tight", "loose"] },
      { name: "Timing", pair: ["pulse", "flash"] },
      { name: "Expressive space", pair: ["open", "contained"] }
    ]
  }
];

// Focus modifiers: not paired axes. They mark relative semantic importance.
const EMOTIVE_MODIFIERS = ["diminished", "emphasis", "strong"];

const EMOTIVE_DEFINITIONS = {
  rise: "Directional upward progression in motion or intensity.",
  fall: "Directional downward progression in motion or intensity.",
  converge: "Movement directed toward a shared focal point.",
  drift: "Motion without clear directional intent; ambient or wandering.",
  swell: "Gradual accumulation of intensity, density, or presence.",
  decay: "Gradual reduction or dispersal of intensity, density, or presence.",
  energetic: "High activity level with vigorous or frequent motion.",
  calm: "Low activity level with restrained or minimal motion.",
  light: "Airy, enlightened, bright, or elevated atmospheric tone.",
  dark: "Heavy, mysterious, or weighty atmospheric tone.",
  warp: "Distortion that alters meaning or form.",
  blur: "Distortion that reduces clarity or sharpness.",
  reveal: "Transition into visibility or perceptual awareness.",
  fade: "Transition out of visibility or perceptual awareness.",
  smooth: "Uniform motion with minimal irregularity or turbulence.",
  turbulent: "Irregular or chaotic motion with unpredictable variation.",
  tight: "Motion closely aligned with timing cues or rhythmic events.",
  loose: "Motion that stretches or relaxes around timing cues.",
  pulse: "Periodic or rhythmic repetition over time.",
  flash: "A sudden, instantaneous perceptual event.",
  open: "Expressive room becoming more expansive or open.",
  contained: "Expressive room becoming more restrictive or contained.",
  strong: "Designates an element as the semantic anchor of the moment.",
  emphasis: "Increases the perceptual prominence of an element relative to surrounding elements.",
  diminished: "Reduces the perceptual prominence of an element relative to surrounding elements."
};

// What a term displaces when picked: its paired opposite; diminished is the
// opposite of the two prominence-raising modifiers (per their definitions).
const EMOTIVE_CONFLICTS = (() => {
  const map = {};
  EMOTIVE_LAYERS.forEach((layer) => layer.axes.forEach(({ pair }) => {
    map[pair[0]] = [pair[1]];
    map[pair[1]] = [pair[0]];
  }));
  map.strong = ["diminished"];
  map.emphasis = ["diminished"];
  map.diminished = ["strong", "emphasis"];
  return map;
})();

const EMOTIVE_VOCAB = new Set(Object.keys(EMOTIVE_DEFINITIONS));
const SECTION_LABEL_LINE_RE = /^(\s*)\[([^{\]]*?)\s*(?:\{\{([\s\S]*?)\}\})?\s*\](\s*)$/;

// Unused recipes belong to the song where they were composed. Keep them
// available when returning to that file, without sharing them with other songs.
const emotiveRecipesBySong = new Map();
let emotiveSessionRecipes = [];
let emotiveState = null;
let hoveredEditorLineIndex = null;

function switchEmotiveRecipeSong(nextFilePath) {
  closeEmotiveRecipeDialog();
  if (currentFilePath) {
    emotiveRecipesBySong.set(currentFilePath, emotiveSessionRecipes);
  }
  emotiveSessionRecipes = nextFilePath
    ? emotiveRecipesBySong.get(nextFilePath) || []
    : [];
}

function installEmotiveRecipeStyles() {
  const css = `
.toc-item { position: relative; padding-right: 34px; }
.toc-item-more {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
  border-radius: 6px; opacity: .55; cursor: pointer;
}
.toc-item-more:hover, .toc-item-more:focus-visible { opacity: 1; background: rgba(127,127,127,.28); outline: none; }

.emo-overlay {
  position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.5);
  --emo-bg: #1f2126; --emo-fg: #e8e9ec; --emo-border: rgba(255,255,255,.16);
  --emo-accent: #7c9cff; --emo-accent-fg: #0d1020; --emo-muted: rgba(232,233,236,.62);
}
.emo-dialog {
  width: min(600px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
  background: var(--emo-bg); color: var(--emo-fg); border: 1px solid var(--emo-border);
  border-radius: 12px; box-shadow: 0 18px 60px rgba(0,0,0,.5); font-size: 14px;
}
.emo-header, .emo-footer { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
.emo-header { justify-content: space-between; border-bottom: 1px solid var(--emo-border); }
.emo-footer { justify-content: flex-end; border-top: 1px solid var(--emo-border); }
.emo-title { font-weight: 600; }
.emo-title small { font-weight: 400; color: var(--emo-muted); margin-left: 6px; }
.emo-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
.emo-section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--emo-muted); }
.emo-layer-name { margin: 10px 0 6px; font-size: 11px; color: var(--emo-muted); }
.emo-layer-name:first-of-type { margin-top: 0; }
.emo-hint, .emo-empty { color: var(--emo-muted); font-size: 13px; }
.emo-delete { border-color: var(--emo-border); color: var(--emo-muted); }
.emo-delete:hover:not(:disabled) { background: #d9534f; border-color: #d9534f; color: #fff; }
.emo-text-row { display: flex; gap: 8px; position: relative; }
.emo-text-wrap { position: relative; flex: 1; min-width: 0; }
.emo-text-input { width: 100%; box-sizing: border-box; font: inherit; color: inherit; background: rgba(127,127,127,.12);
  border: 1px solid var(--emo-border); border-radius: 8px; padding: 6px 104px 6px 10px; }
.emo-text-input:focus-visible { outline: 2px solid var(--emo-accent); outline-offset: 1px; }
.emo-show-emotives {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  border: 0; padding: 2px 4px; background: transparent; color: var(--emo-accent);
  font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.emo-show-emotives:hover { text-decoration: underline; }
.emo-helper-drawer {
  display: grid; grid-template-rows: 0fr; opacity: 0; transform: translateY(6px);
  transition: grid-template-rows .18s ease, opacity .15s ease, transform .18s ease;
  pointer-events: none;
}
.emo-helper-drawer.is-open {
  grid-template-rows: 1fr; opacity: 1; transform: translateY(0); pointer-events: auto;
}
.emo-helper-drawer-inner { min-height: 0; overflow: hidden; }
.emo-helper-panel {
  margin-bottom: 8px; padding: 10px; border: 1px solid var(--emo-border); border-radius: 10px;
  background: rgba(18,20,24,.98); box-shadow: 0 -10px 28px rgba(0,0,0,.28);
}
.emo-helper-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.emo-helper-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--emo-muted); }
.emo-helper-close { border: 0; background: transparent; color: var(--emo-muted); font: inherit; font-size: 18px; line-height: 1; cursor: pointer; padding: 0 3px; }
.emo-helper-close:hover { color: var(--emo-fg); }
.emo-helper-layer + .emo-helper-layer { margin-top: 8px; }
.emo-helper-layer-name { margin-bottom: 4px; font-size: 10px; color: var(--emo-muted); }
.emo-helper-pairs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.emo-helper-pair { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; }
.emo-helper-modifiers { display: grid; grid-template-columns: repeat(3, 1fr); }
.emo-helper-choice {
  font: inherit; color: inherit; background: transparent; border: 1px solid var(--emo-border);
  padding: 5px 7px; cursor: pointer;
}
.emo-helper-choice:not(:last-child) { border-right-width: 0; }
.emo-helper-choice:first-child { border-radius: 7px 0 0 7px; }
.emo-helper-choice:last-child { border-radius: 0 7px 7px 0; }
.emo-helper-choice:hover { background: rgba(127,127,127,.2); }
.emo-helper-choice.is-on { background: var(--emo-accent); color: var(--emo-accent-fg); border-color: var(--emo-accent); font-weight: 600; }
.emo-text-error { margin-top: 6px; color: #ff8a8a; font-size: 12px; }
.emo-text-error:empty { display: none; }

.emo-btn, .emo-x {
  font: inherit; color: inherit; background: transparent; border: 1px solid var(--emo-border);
  border-radius: 8px; padding: 6px 12px; cursor: pointer;
}
.emo-btn:hover:not(:disabled), .emo-x:hover { background: rgba(127,127,127,.2); }
.emo-btn-primary { background: var(--emo-accent); color: var(--emo-accent-fg); border-color: var(--emo-accent); font-weight: 600; }
.emo-btn-primary:hover:not(:disabled) { background: var(--emo-accent); filter: brightness(1.08); }
.emo-x { border: none; padding: 4px 8px; font-size: 18px; line-height: 1; }
.emo-dialog button:disabled { opacity: .4; cursor: not-allowed; }
.emo-dialog button:focus-visible { outline: 2px solid var(--emo-accent); outline-offset: 2px; }

.emo-pairs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.emo-pair { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; }
.emo-mods { max-width: 100%; }
.emo-choice {
  font: inherit; color: inherit; background: transparent; border: 1px solid var(--emo-border);
  padding: 6px 8px; cursor: pointer;
}
.emo-choice:not(:last-child) { border-right-width: 0; }
.emo-choice:first-child { border-radius: 8px 0 0 8px; }
.emo-choice:last-child { border-radius: 0 8px 8px 0; }
.emo-choice:hover:not(:disabled) { background: rgba(127,127,127,.2); }
.emo-choice.is-on { background: var(--emo-accent); color: var(--emo-accent-fg); border-color: var(--emo-accent); font-weight: 600; }

.emo-container {
  display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 10px;
  border: 1px solid var(--emo-border); border-radius: 10px;
}
.emo-container.is-draft { border: 1px dashed var(--emo-accent); }
.emo-items { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.emo-pill { padding: 2px 9px; border-radius: 999px; background: rgba(127,127,127,.25); font-size: 12px; }
.emo-source { font-size: 11px; color: var(--emo-muted); white-space: nowrap; }
.emo-done { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0;
  border-radius: 8px; border: 1px solid var(--emo-accent); background: transparent; color: var(--emo-accent); cursor: pointer; }
.emo-done:hover:not(:disabled) { background: var(--emo-accent); color: var(--emo-accent-fg); }
.emo-recipes { display: flex; flex-direction: column; gap: 8px; }
.emo-recipes > .emo-container { position: relative; transition: border-color .15s ease, background-color .15s ease, color .15s ease; cursor: pointer; }
.emo-container.is-current {
  margin-top: 17px; margin-bottom: 30px; color: #fff;
  background-color: rgb(53 78 155 / 26%); border-color: #4e63a8;
}
.emo-add-section { margin-top: 15px; margin-bottom: 15px; }
.emo-container:not(.is-current) .emo-items { color: #b5c8ff; }
.emo-container:not(.is-current) .emo-source { color: #a1add1; }
.emo-container.is-current .emo-source { color: #b5c8ff; }
.emo-recipes > .emo-container:hover { color: white; background-color: rgba(124,156,255,.14); border-color: var(--emo-accent); }
.emo-recipes > .emo-container:hover .emo-items { color: white; }
.emo-recipe .emo-items { transition: color .15s ease; }
.emo-reference { display: grid; min-width: 80px; text-align: right; }
.emo-reference > span { grid-area: 1 / 1; }
.emo-use {
  font-weight: 700;
  position: absolute; top: 0; right: 0; bottom: 0; width: 80px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 0 9px 9px 0; background: var(--emo-accent); color: var(--emo-accent-fg);
  visibility: hidden; opacity: 0; transition: opacity .15s ease, visibility .15s ease;
}
.emo-container:has(.emo-delete) .emo-use { right: 40px; border-radius: 0; }
.emo-container:not(.is-current):hover .emo-reference .emo-source { visibility: hidden; }
.emo-container:not(.is-current):hover .emo-use { visibility: visible; opacity: 1; }
.emo-recipe { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; border: 0; border-radius: 6px; padding: 6px; text-align: left; font: inherit; color: inherit; background: transparent; cursor: pointer; }
.emo-recipe .emo-items { line-height: 1.5; }
`;
  try {
    if ("adoptedStyleSheets" in document && typeof CSSStyleSheet !== "undefined") {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return;
    }
  } catch (_) { /* fall through to <style> */ }
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/* ---------- parsing helpers ---------- */

function splitInstructionItems(inner) {
  const items = [];
  let current = "";
  let inLiteral = false;

  for (const ch of String(inner || "")) {
    if (ch === "`") inLiteral = !inLiteral;
    if (ch === "," && !inLiteral) {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current);

  return items.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// Returns null for anything that isn't an ordinary section label (e.g. freeflow labels).
function parseSectionLabelLine(line) {
  const match = String(line || "").match(SECTION_LABEL_LINE_RE);
  if (!match || !match[2].trim()) return null;

  return {
    indent: match[1],
    name: match[2].trim(),
    items: match[3] ? splitInstructionItems(match[3]) : [],
    trailing: match[4]
  };
}

function isModifierTerm(item) {
  return EMOTIVE_MODIFIERS.includes(String(item).toLowerCase());
}

// A standalone emotive or modifier (shorthand form).
function isEmotiveItem(item) {
  return EMOTIVE_VOCAB.has(String(item).toLowerCase());
}

// Individual syntax such as "energetic--strong" or "swell--arc-lift".
function isCompoundEmotiveItem(item) {
  const text = String(item);
  return text.includes("--") && isEmotiveItem(text.split("--")[0]);
}

function isArcItem(item) {
  return /^arc(-[a-z0-9-]+)?$/i.test(String(item)) && !String(item).includes("--");
}

// Emotives first (in the order given), prominence modifiers last.
function orderEmotiveRecipe(items) {
  return [
    ...items.filter((item) => !isModifierTerm(item)),
    ...items.filter(isModifierTerm)
  ];
}

function emotiveRecipeKey(items) {
  return items.map((item) => item.toLowerCase()).sort().join("|");
}

function collectFileEmotiveRecipes() {
  const seen = new Map();

  editor.value.split("\n").forEach((line) => {
    const parsed = parseSectionLabelLine(line);
    if (!parsed) return;

    const items = orderEmotiveRecipe(
      parsed.items
        .filter((item) => isEmotiveItem(item) || isCompoundEmotiveItem(item) || isArcItem(item))
        .map((item) => item.toLowerCase())
    );
    if (!items.length) return;

    const key = emotiveRecipeKey(items);
    if (!seen.has(key)) seen.set(key, { items, source: parsed.name });
  });

  return [...seen.values()];
}

function getEmotiveRecipeLibrary() {
  const library = collectFileEmotiveRecipes();
  const keys = new Set(library.map((recipe) => emotiveRecipeKey(recipe.items)));

  emotiveSessionRecipes.forEach((items) => {
    const key = emotiveRecipeKey(items);
    if (keys.has(key)) return;
    keys.add(key);
    library.push({ items: [...items], source: "" });
  });

  return library;
}

/* ---------- applying a recipe ---------- */

// The drawer collapses consecutive identical labels (common in .epicx), so
// edits apply to the whole run to keep the drawer showing a single entry.
function getSectionLabelRun(lines, lineIndex) {
  const originalTrimmed = lines[lineIndex].trim();
  const targets = [lineIndex];

  for (let i = lineIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!/^\[[^\]]+\]$/.test(trimmed)) continue;
    if (trimmed !== originalTrimmed) break;
    targets.push(i);
  }

  return targets;
}

// Everything on the label that belongs to its recipe: emotives, modifiers,
// individual-syntax items, and arcs (an arc describes the recipe's lifecycle).
function getSectionRecipeItems(lineIndex) {
  const parsed = parseSectionLabelLine(editor.value.split("\n")[lineIndex]);
  if (!parsed) return [];

  return parsed.items.filter(
    (item) => isEmotiveItem(item) || isCompoundEmotiveItem(item) || isArcItem(item)
  );
}

function removeEmotiveRecipeFromSection(lineIndex) {
  const lines = editor.value.split("\n");
  const parsed = parseSectionLabelLine(lines[lineIndex]);

  if (!parsed) {
    statusEl.textContent = "Couldn't remove the recipe: that section label has moved or changed.";
    return false;
  }

  getSectionLabelRun(lines, lineIndex).forEach((index) => {
    const label = parseSectionLabelLine(lines[index]);
    if (!label) return;

    // Keep non-recipe instructions (e.g. "choral chant"); drop the recipe and its arc.
    const others = label.items.filter(
      (item) => !isEmotiveItem(item) && !isCompoundEmotiveItem(item) && !isArcItem(item)
    );

    lines[index] =
      label.indent +
      "[" + label.name + (others.length ? " {{" + others.join(", ") + "}}" : "") + "]" +
      label.trailing;
  });

  const scrollTop = editor.scrollTop;
  replaceEditorTextWithManualUndo(lines.join("\n"));
  editor.scrollTop = scrollTop;

  refreshEditorView();
  return true;
}

function applyEmotiveRecipeToSection(lineIndex, recipeItems) {
  const lines = editor.value.split("\n");
  const parsed = parseSectionLabelLine(lines[lineIndex]);

  if (!parsed) {
    statusEl.textContent = "Couldn't apply the recipe: that section label has moved or changed.";
    return false;
  }

  const targets = getSectionLabelRun(lines, lineIndex);

  const ordered = orderEmotiveRecipe(recipeItems);

  targets.forEach((index) => {
    const label = parseSectionLabelLine(lines[index]);
    if (!label) return;

    // Replace existing emotives; keep other instructions first and any
    // existing arcs last (arcs come after modifiers).
    const others = label.items.filter(
      (item) => !isEmotiveItem(item) && !isCompoundEmotiveItem(item) && !isArcItem(item)
    );
    const arcs = ordered.some(isArcItem) ? [] : label.items.filter(isArcItem);
    const items = [...others, ...ordered, ...arcs];

    lines[index] =
      label.indent + "[" + label.name + " {{" + items.join(", ") + "}}]" + label.trailing;
  });

  const scrollTop = editor.scrollTop;
  replaceEditorTextWithManualUndo(lines.join("\n"));

  const offset = getOffsetForLine(editor.value, lineIndex);
  editor.focus();
  editor.setSelectionRange(offset, offset);
  editor.scrollTop = scrollTop;

  refreshEditorView();
  return true;
}

/* ---------- typed recipes ---------- */

// Accepts "energetic, swell, strong" or "{{energetic, swell, strong}}", and the
// per-emotive modifier form: "open, energetic, swell--strong".
// Module rule: per-emotive modifiers can't be combined with a shared modifier.
// Returns { items } (shared modifiers last) or { error }.
function parseEmotiveRecipeText(text) {
  const cleaned = String(text || "").replace(/^\s*\{\{/, "").replace(/\}\}\s*$/, "").trim();
  const tokens = cleaned.split(/[\s,]+/).map((t) => t.toLowerCase()).filter(Boolean);

  if (!tokens.length) return { error: "Type at least one emotive, e.g. energetic, swell, strong." };

  const items = [];
  const problems = [];

  tokens.forEach((token) => {
    const [base, ...rest] = token.split("--");

    if (!isEmotiveItem(base)) {
      problems.push(
        isArcItem(base)
          ? `"${token}": arcs aren't supported yet`
          : `"${token}": not in the emotive vocabulary`
      );
      return;
    }

    if (rest.length) {
      if (isModifierTerm(base)) {
        problems.push(`"${token}": a modifier can't take a modifier`);
        return;
      }

      const [modifier, ...extra] = rest;

      if (!isModifierTerm(modifier)) {
        problems.push(
          isArcItem(modifier)
            ? `"${token}": arcs aren't supported yet`
            : `"${token}": "${modifier}" isn't a modifier (strong, emphasis, diminished)`
        );
        return;
      }

      if (extra.length) {
        problems.push(
          `"${token}": ${extra.some(isArcItem) ? "arcs aren't supported yet" : "only one modifier per emotive"}`
        );
        return;
      }
    }

    if (!items.includes(token)) items.push(token);
  });

  if (problems.length) return { error: problems.join("; ") + "." };

  const bases = items.map((item) => item.split("--")[0]);

  for (let i = 0; i < bases.length; i += 1) {
    if (bases.indexOf(bases[i]) !== i) {
      return { error: `${bases[i]} is listed more than once.` };
    }

    const clash = (EMOTIVE_CONFLICTS[bases[i]] || []).find((other) => bases.includes(other));
    if (clash) return { error: `${bases[i]} and ${clash} can't be combined in one recipe.` };
  }

  if (items.some(isCompoundEmotiveItem) && items.some(isModifierTerm)) {
    return {
      error:
        "Per-emotive modifiers (like swell--strong) can't be combined with a shared modifier (like strong). Use one style or the other."
    };
  }

  return { items: orderEmotiveRecipe(items) };
}

function getEmotiveTextTokens(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isEmotiveTextTermSelected(value, term) {
  return getEmotiveTextTokens(value).some((token) => token.split("--")[0] === term);
}

function renderEmotiveInputPalette(state) {
  const layers = EMOTIVE_LAYERS.map((layer) => `
    <div class="emo-helper-layer">
      <div class="emo-helper-layer-name">${escapeHtml(layer.name)}</div>
      <div class="emo-helper-pairs">
        ${layer.axes.map(({ pair }) => `
          <div class="emo-helper-pair">
            ${pair.map((term) => `<button type="button"
              class="emo-helper-choice${isEmotiveTextTermSelected(state.textValue, term) ? " is-on" : ""}"
              data-action="toggle-input-emotive" data-emotive="${escapeHtml(term)}"
              aria-pressed="${isEmotiveTextTermSelected(state.textValue, term)}">${escapeHtml(term)}</button>`).join("")}
          </div>`).join("")}
      </div>
    </div>`).join("");

  const modifiers = `
    <div class="emo-helper-layer">
      <div class="emo-helper-layer-name">Modifiers</div>
      <div class="emo-helper-modifiers">
        ${EMOTIVE_MODIFIERS.map((term) => `<button type="button"
          class="emo-helper-choice${isEmotiveTextTermSelected(state.textValue, term) ? " is-on" : ""}"
          data-action="toggle-input-emotive" data-emotive="${escapeHtml(term)}"
          aria-pressed="${isEmotiveTextTermSelected(state.textValue, term)}">${escapeHtml(term)}</button>`).join("")}
      </div>
    </div>`;

  return layers + modifiers;
}

function syncEmotiveInputPalette() {
  const state = emotiveState;
  if (!state) return;

  state.overlay.querySelectorAll(".emo-helper-choice[data-emotive]").forEach((button) => {
    const selected = isEmotiveTextTermSelected(state.textValue, button.dataset.emotive);
    button.classList.toggle("is-on", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function toggleEmotiveInputTerm(term) {
  const state = emotiveState;
  if (!state || !EMOTIVE_VOCAB.has(term)) return;

  let tokens = getEmotiveTextTokens(state.textValue);
  const selected = tokens.some((token) => token.split("--")[0] === term);

  if (selected) {
    tokens = tokens.filter((token) => token.split("--")[0] !== term);
  } else {
    const conflicts = new Set(EMOTIVE_CONFLICTS[term] || []);
    tokens = tokens.filter((token) => !conflicts.has(token.split("--")[0]));
    tokens.push(term);
  }

  state.textValue = tokens.join(", ");
  state.textError = "";

  const input = state.overlay.querySelector(".emo-text-input");
  if (input) {
    input.value = state.textValue;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  const errorEl = state.overlay.querySelector(".emo-text-error");
  if (errorEl) errorEl.textContent = "";
  syncEmotiveInputPalette();
}

function submitEmotiveTextRecipe() {
  const state = emotiveState;
  if (!state) return;

  const result = parseEmotiveRecipeText(state.textValue);

  if (result.error) {
    state.textError = result.error;
  } else {
    const key = emotiveRecipeKey(result.items);

    if (!state.recipes.some((r) => emotiveRecipeKey(r.items) === key)) {
      state.recipes.push({ items: result.items, source: "" });
      emotiveSessionRecipes.push(result.items);
    }

    if (!getSectionRecipeItems(state.lineIndex).length) {
      applyEmotiveRecipeToSection(state.lineIndex, result.items);
      state.recipes = getEmotiveRecipeLibrary();
    }

    state.textValue = "";
    state.textError = "";
  }

  renderEmotiveDialog();

  const input = state.overlay.querySelector(".emo-text-input");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function handleEmotiveDialogInput(event) {
  const state = emotiveState;
  if (!state || !event.target.classList.contains("emo-text-input")) return;

  state.textValue = event.target.value;

  if (state.textError) {
    state.textError = "";
    const errorEl = state.overlay.querySelector(".emo-text-error");
    if (errorEl) errorEl.textContent = "";
  }

  syncEmotiveInputPalette();
}

/* ---------- popup ---------- */

function getEditorCaretLineIndex() {
  const caret = editor.selectionStart;
  return editor.value.slice(0, caret).split("\n").length - 1;
}

function getSectionLineIndexForEditorLine(lineIndex) {
  const lines = editor.value.split("\n");

  for (let i = lineIndex; i >= 0; i -= 1) {
    if (parseSectionLabelLine(lines[i])) return i;
  }

  return null;
}

function getEditorLineIndexAtClientY(clientY) {
  const rect = editor.getBoundingClientRect();
  if (clientY < rect.top || clientY > rect.bottom) return null;

  const style = getComputedStyle(editor);
  const lineHeight = parseFloat(style.lineHeight) || 20;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const contentY = clientY - rect.top - paddingTop + editor.scrollTop;

  if (contentY < 0) return null;

  const lineIndex = Math.floor(contentY / lineHeight);
  const lineCount = editor.value.split("\n").length;

  return lineIndex >= 0 && lineIndex < lineCount ? lineIndex : null;
}

editor.addEventListener("pointermove", (event) => {
  hoveredEditorLineIndex = getEditorLineIndexAtClientY(event.clientY);
});

editor.addEventListener("pointerleave", () => {
  hoveredEditorLineIndex = null;
});

function handleEmotiveShortcut(event) {
  if (
    event.defaultPrevented ||
    event.shiftKey ||
    event.altKey ||
    !(event.metaKey || event.ctrlKey) ||
    event.key.toLowerCase() !== "e" ||
    emotiveState
  ) {
    return;
  }

  let lineIndex = null;

  if (document.activeElement === editor) {
    lineIndex = getSectionLineIndexForEditorLine(getEditorCaretLineIndex());
  } else if (Number.isInteger(hoveredEditorLineIndex)) {
    lineIndex = getSectionLineIndexForEditorLine(hoveredEditorLineIndex);
  }

  if (!Number.isInteger(lineIndex)) return;

  event.preventDefault();
  event.stopPropagation();
  openEmotiveRecipeDialog(lineIndex);
}

document.addEventListener("keydown", handleEmotiveShortcut, true);

function openEmotiveRecipeDialog(lineIndex) {
  if (emotiveState) return;

  const parsed = parseSectionLabelLine(editor.value.split("\n")[lineIndex]);
  if (!parsed) return;

  const overlay = document.createElement("div");
  overlay.className = "emo-overlay";

  emotiveState = {
    lineIndex,
    sectionName: parsed.name,
    recipes: getEmotiveRecipeLibrary(),
    originalText: editor.value,
    originalRecipes: emotiveSessionRecipes.map(items => [...items]),
    textValue: "",
    textError: "",
    paletteOpen: false,
    overlay,
    previousFocus: document.activeElement
  };

  overlay.addEventListener("click", handleEmotiveDialogClick);
  overlay.addEventListener("input", handleEmotiveDialogInput);
  document.addEventListener("keydown", handleEmotiveDialogKeydown, true);
  document.body.appendChild(overlay);

  renderEmotiveDialog();
  overlay.querySelector(".emo-text-input")?.focus();
}

function closeEmotiveRecipeDialog() {
  if (!emotiveState) return;

  const { overlay, previousFocus } = emotiveState;
  document.removeEventListener("keydown", handleEmotiveDialogKeydown, true);
  overlay.remove();
  emotiveState = null;

  if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
}

function handleEmotiveDialogKeydown(event) {
  if (event.key === "Enter" && event.target?.classList?.contains("emo-text-input")) {
    event.preventDefault();
    event.stopPropagation();
    submitEmotiveTextRecipe();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeEmotiveRecipeDialog();
  }
}

function renderEmotiveRecipePills(items) {
  return items.map((item) => `<span class="emo-pill">${escapeHtml(item)}</span>`).join("");
}

function renderEmotiveDialog() {
  const state = emotiveState;
  if (!state) return;
  const currentKey = emotiveRecipeKey(getSectionRecipeItems(state.lineIndex));
  const usedKeys = new Set(collectFileEmotiveRecipes().map(recipe => emotiveRecipeKey(recipe.items)));

  // Display ordering only. Do not mutate state.recipes: click handling relies on
  // that library and continues to resolve selections exactly as before.
  const appliedRecipes = state.recipes.filter(
    recipe => emotiveRecipeKey(recipe.items) === currentKey
  );
  const unassignedRecipes = state.recipes.filter(recipe => {
    const key = emotiveRecipeKey(recipe.items);
    return key !== currentKey && !usedKeys.has(key);
  }).reverse();
  const otherAssignedRecipes = state.recipes.filter(recipe => {
    const key = emotiveRecipeKey(recipe.items);
    return key !== currentKey && usedKeys.has(key);
  });
  const displayedRecipes = [
    ...appliedRecipes,
    ...unassignedRecipes,
    ...otherAssignedRecipes
  ];

  const recipesHtml = displayedRecipes.length
    ? displayedRecipes.map(recipe => {
        const key = emotiveRecipeKey(recipe.items);
        const assigned = key === currentKey;
        return `<div class="emo-container${assigned ? " is-current" : ""}">
          <button type="button" class="emo-recipe"
            data-recipe-key="${escapeHtml(key)}" aria-pressed="${assigned}"
            ${assigned ? 'aria-current="true"' : ''}>
            <span class="emo-items">${escapeHtml(recipe.items.join(", "))}</span>
            ${assigned ? '<span class="emo-source">Applied</span>' : `<span class="emo-reference"><span class="emo-source">${escapeHtml(recipe.source || '')}</span><span class="emo-use" aria-hidden="true">Use</span></span>`}
          </button>
          ${assigned ? `<button type="button" class="emo-x" data-action="remove-section-recipe"
            title="Remove from this section" aria-label="Remove from this section">×</button>` : !usedKeys.has(key) ? `<button type="button" class="emo-x emo-delete"
            data-action="delete-recipe" data-recipe-key="${escapeHtml(key)}"
            title="Delete recipe" aria-label="Delete recipe">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>
          </button>` : ''}
        </div>`;
      }).join('')
    : '<div class="emo-empty">No recipes yet. Type one above.</div>';

  state.overlay.innerHTML = `
    <div class="emo-dialog" role="dialog" aria-modal="true" aria-label="Emotive recipes">
      <div class="emo-header">
        <div class="emo-title">Emotive recipe<small>${escapeHtml(state.sectionName)}</small></div>
        <button type="button" class="emo-x" data-action="close" aria-label="Close">×</button>
      </div>
      <div class="emo-body">
        <div class="emo-add-section">
          <div class="emo-section-head"><span>Type a recipe</span></div>
          <div class="emo-helper-drawer${state.paletteOpen ? " is-open" : ""}" aria-hidden="${!state.paletteOpen}">
            <div class="emo-helper-drawer-inner">
              <div class="emo-helper-panel">
                <div class="emo-helper-head">
                  <span class="emo-helper-title">Emotives</span>
                  <button type="button" class="emo-helper-close" data-action="hide-emotives" aria-label="Close emotives">×</button>
                </div>
                ${renderEmotiveInputPalette(state)}
              </div>
            </div>
          </div>
          <div class="emo-text-row">
            <div class="emo-text-wrap">
              <input type="text" class="emo-text-input" spellcheck="false" autocomplete="off"
                placeholder="energetic, swell, strong" aria-label="Recipe as text"
                value="${escapeHtml(state.textValue)}">
              <button type="button" class="emo-show-emotives" data-action="toggle-emotives">${state.paletteOpen ? "Hide emotives" : "Show emotives"}</button>
            </div>
            <button type="button" class="emo-btn" data-action="add-text">Add recipe</button>
          </div>
          <div class="emo-text-error" role="alert">${escapeHtml(state.textError)}</div>
        </div>
        <div>
          <div class="emo-section-head"><span>Recipes</span></div>
          <div class="emo-recipes">${recipesHtml}</div>
        </div>
      </div>
      <div class="emo-footer">
        <button type="button" class="emo-btn" data-action="cancel">Cancel</button>
        <button type="button" class="emo-btn emo-btn-primary" data-action="close">Done</button>
      </div>
    </div>`;
}

function handleEmotiveDialogClick(event) {
  const state = emotiveState;
  if (!state) return;

  const target = event.target.closest("button") ||
    event.target.closest(".emo-container")?.querySelector(".emo-recipe");
  if (!target || target.disabled || !state.overlay.contains(target)) return;

  const action = target.dataset.action;

  if (action === "close") {
    closeEmotiveRecipeDialog();
    return;
  }

  if (action === "remove-section-recipe") {
    const removed = getSectionRecipeItems(state.lineIndex);
    if (removeEmotiveRecipeFromSection(state.lineIndex)) {
      const key = emotiveRecipeKey(removed);
      if (removed.length && !emotiveSessionRecipes.some(items => emotiveRecipeKey(items) === key)) {
        emotiveSessionRecipes.push(removed);
      }
      state.recipes = getEmotiveRecipeLibrary();
    }
    renderEmotiveDialog();
    return;
  }

  if (action === "delete-recipe") {
    const key = target.dataset.recipeKey;
    if (collectFileEmotiveRecipes().some(recipe => emotiveRecipeKey(recipe.items) === key)) return;
    // Preserve the array identity held by the song cache.
    for (let i = emotiveSessionRecipes.length - 1; i >= 0; i--) {
      if (emotiveRecipeKey(emotiveSessionRecipes[i]) === key) emotiveSessionRecipes.splice(i, 1);
    }
    state.recipes = getEmotiveRecipeLibrary();
    renderEmotiveDialog();
    return;
  }

  if (action === "toggle-emotives") {
    state.paletteOpen = !state.paletteOpen;
    const drawer = state.overlay.querySelector(".emo-helper-drawer");
    const toggle = state.overlay.querySelector(".emo-show-emotives");

    if (drawer) {
      drawer.classList.toggle("is-open", state.paletteOpen);
      drawer.setAttribute("aria-hidden", String(!state.paletteOpen));
    }

    if (toggle) {
      toggle.textContent = state.paletteOpen ? "Hide emotives" : "Show emotives";
    }

    if (state.paletteOpen) syncEmotiveInputPalette();
    return;
  }

  if (action === "hide-emotives") {
    state.paletteOpen = false;
    const drawer = state.overlay.querySelector(".emo-helper-drawer");
    if (drawer) {
      drawer.classList.remove("is-open");
      drawer.setAttribute("aria-hidden", "true");
    }
    const toggle = state.overlay.querySelector(".emo-show-emotives");
    if (toggle) toggle.textContent = "Show emotives";
    state.overlay.querySelector(".emo-text-input")?.focus();
    return;
  }

  if (action === "toggle-input-emotive") {
    toggleEmotiveInputTerm(target.dataset.emotive);
    return;
  }

  if (action === "add-text") {
    submitEmotiveTextRecipe();
    return;
  }

  if (action === "cancel") {
    if (editor.value !== state.originalText) {
      replaceEditorTextWithManualUndo(state.originalText);
      refreshEditorView();
    }
    emotiveSessionRecipes.splice(0, emotiveSessionRecipes.length, ...state.originalRecipes);
    closeEmotiveRecipeDialog();
    return;
  }

  if (target.dataset.recipeKey) {
    const recipe = state.recipes.find(r => emotiveRecipeKey(r.items) === target.dataset.recipeKey);
    if (!recipe || emotiveRecipeKey(getSectionRecipeItems(state.lineIndex)) === target.dataset.recipeKey) return;
    const previous = getSectionRecipeItems(state.lineIndex);
    if (applyEmotiveRecipeToSection(state.lineIndex, recipe.items)) {
      if (previous.length && !emotiveSessionRecipes.some(items => emotiveRecipeKey(items) === emotiveRecipeKey(previous))) {
        emotiveSessionRecipes.push(previous);
      }
      state.recipes = getEmotiveRecipeLibrary();
      renderEmotiveDialog();
      state.overlay.querySelector('.emo-recipe[aria-current="true"]')?.focus();
    }
  }
}

installEmotiveRecipeStyles();


restoreSessionState();
window.EpicInspector?.onEditorHistoryAction?.((action) => {
  editor.focus();

  if (applyEditorHistoryAction(action)) return;

  if (action === "undo" || action === "redo") {
    document.execCommand(action);
  }
});
window.EpicInspector?.onStudioTimingMenuAction?.(handleStudioTimingMenuAction);
updateHeaderState();
