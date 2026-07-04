let currentFilePath = "";

const openBtn = document.getElementById("openBtn");
const saveBtn = document.getElementById("saveBtn");
const clearSessionBtn = document.getElementById("clearSessionBtn");
const editor = document.getElementById("editor");
const filePathEl = document.getElementById("filePath");
const statusEl = document.getElementById("status");
const metadataPanel = document.getElementById("metadataPanel");
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

function setEditMetadataBtnIcon(active) {
  if (!editMetadataBtn) return;
  editMetadataBtn.innerHTML = `
    <svg class="icon ${active ? "close-icon" : "edit-mini-icon"} core-action" viewBox="0 0 628 628" aria-hidden="true">
      <use href="icons.svg#${active ? "close-icon" : "edit-mini-icon"}"></use>
    </svg>
  `;
}

const AUTHOR_KEY_PREF = "epic-author-key-preference";
const AUTHOR_KEY_CORRECTIONS = "epic-author-key-corrections";

let ghostHeaderVisible = false;
let lastEpicValidationResult = null;

let sourceEditorText = "";
let sourceHadContent = false;
let linkedAudioPath = "";
let studioTimingLink = null;
let studioTimingPollTimer = null;
let isStudioTimingSyncInProgress = false;
let manualUndoStack = [];
let manualRedoStack = [];
let isApplyingUndo = false;

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

  editor.value = snapshot.value;
  editor.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  editor.scrollTop = snapshot.scrollTop;

  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType
  }));

  isApplyingUndo = false;

  return before;
}

const validationStatusEl =
  document.getElementById("validationStatus");

const SESSION_KEY = "epic-media-inspector-session";
  let restoreInProgress = false;

let currentMetadata = null;
let metadataEditMode = false;
let stagedAlbumArt = undefined; // undefined = no change, null = remove, object = { mimeType, data }

let parseTimer = null;

function getPreferredAuthorKey() {
  return localStorage.getItem(AUTHOR_KEY_PREF) || "Creator";
}

function getHeaderStub() {
  const authorKey = getPreferredAuthorKey();

  return `---
Title: Untitled
${authorKey}: 
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

  editMetadataBtn.style.display =
    hasMetadata ? "" : "none";

  const sidebarTitle =
    document.querySelector(".sidebar-title");

  if (sidebarTitle) {
    sidebarTitle.style.display =
      hasMetadata ? "" : "none";
  }

  if (addAlbumArtBtn) {
    const albumArtPresent = Boolean(
      currentMetadata?.albumArt ||
      currentMetadata?.albumArtInfo
    );

    // Show Add button only when no album art present and NOT in edit mode.
    addAlbumArtBtn.style.display = hasMetadata && !albumArtPresent && !metadataEditMode ? "" : "none";
    addAlbumArtBtn.textContent = "Add Album Art";
    addAlbumArtBtn.disabled = !hasMetadata;
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
  const match = editor.value.match(/^---\s*\n[\s\S]*?\n(Creator|Artist|Author):/m);
  if (!match) return;

  const key = match[1];
  const currentPreferred = getPreferredAuthorKey();

  if (key === currentPreferred) return;

  let corrections = {};

  try {
    corrections = JSON.parse(
      localStorage.getItem(AUTHOR_KEY_CORRECTIONS) || "{}"
    );
  } catch {
    corrections = {};
  }

  corrections[key] = (corrections[key] || 0) + 1;

  localStorage.setItem(
    AUTHOR_KEY_CORRECTIONS,
    JSON.stringify(corrections)
  );

  if (corrections[key] >= 3) {
    localStorage.setItem(AUTHOR_KEY_PREF, key);
  }
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
  const isAvailable = isSavedEpicxProject();

  if (!isAvailable && studioTimingLink) {
    studioTimingLink = null;
    stopStudioTimingPolling();
  }

  window.EpicInspector?.updateStudioTimingMenuState?.({
    available: isAvailable,
    linked: Boolean(studioTimingLink)
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

  await saveCurrentTextFile({ updateLinkedAudio: false });
  return true;
}

async function linkStudioTiming() {
  if (!isSavedEpicxProject()) return;

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
  if (!studioTimingLink || isStudioTimingSyncInProgress) return;

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
    statusText: statusEl.textContent,
    validationText: validationStatusEl.textContent,
    sourceEditorText,
    linkedAudioPath,
    studioTimingLink,
    sourceHadContent,
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

    sourceEditorText = state.sourceEditorText || editor.value;

    currentMetadata = state.currentMetadata || null;

    currentFilePath = state.currentFilePath || "";
    editor.value = state.editorText || "";
    refreshEditorView();

    filePathEl.textContent =
      currentFilePath
        ? getDisplayName(currentFilePath)
        : "Unsaved EPIC session";

    statusEl.textContent =
      state.statusText || "Restored session.";

    validationStatusEl.textContent =
      state.validationText || "";

    saveBtn.disabled = false;

    if (currentMetadata) {
      renderMetadata(currentMetadata);
      editMetadataBtn.disabled = false;
    } else {
      metadataPanel.textContent = "";
      editMetadataBtn.disabled = true;
    }

    if (editor.value.trim()) {
      scheduleEpicValidation();
    }
    updateHeaderState();
    updateStudioTimingMenuState();

    if (studioTimingLink && isSavedEpicxProject()) {
      startStudioTimingPolling();
    }
  } catch (err) {
    console.warn("Failed to restore session:", err);
  } finally {
    restoreInProgress = false;
  }
}

function resetSession() {
  currentFilePath = "";
  currentMetadata = null;
  metadataEditMode = false;

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

  statusEl.textContent = "Idle";

  validationStatusEl.textContent = "";

  metadataPanel.textContent = "";

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
  const normalized = resyncEpicxEntryIndexes(editor.value, entries);

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

  return `---
Title: ${baseName}
Creator:
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

function renderMetadataEditForm(metadata) {
  const fields = getStandardFields(metadata);

  metadataPanel.innerHTML = `
    <form id="metadataEditForm" class="metadata-form">
      <label>Name
        <input name="title" value="${escapeHtml(fields.title)}" />
      </label>

      <label>Artist
        <input name="artist" value="${escapeHtml(fields.artist)}" />
      </label>

      <label>Album
        <input name="album" value="${escapeHtml(fields.album)}" />
      </label>

      <label>Track Number
        <input name="track" value="${escapeHtml(fields.track)}" />
      </label>

      <label>Year
        <input name="year" value="${escapeHtml(fields.year)}" />
      </label>

      <label>Genre
        <input name="genre" value="${escapeHtml(fields.genre)}" />
      </label>

      <label>Comments
        <textarea name="comment">${escapeHtml(fields.comment)}</textarea>
      </label>

      <div class="metadata-actions">
        <button type="submit">
          <svg class="icon store-icon">
            <use href="icons.svg#store-icon"></use>
          </svg>
          Store Metadata
        </button>
        <button type="button" id="cancelMetadataEditBtn">Cancel</button>
      </div>
    </form>
  `;

  document.getElementById("cancelMetadataEditBtn")?.addEventListener("click", () => {
    metadataEditMode = false;
    setEditMetadataBtnIcon(false);
    editMetadataBtn.title = "Edit metadata";
    renderMetadata(currentMetadata);
  });

  document.getElementById("metadataEditForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const form = new FormData(e.currentTarget);

    const fields = {
      title: String(form.get("title") || ""),
      artist: String(form.get("artist") || ""),
      album: String(form.get("album") || ""),
      track: String(form.get("track") || ""),
      year: String(form.get("year") || ""),
      genre: String(form.get("genre") || ""),
      comment: String(form.get("comment") || "")
    };

    try {
      statusEl.textContent = "Saving metadata...";

      const result = await window.EpicInspector.saveMetadata({
        filePath: linkedAudioPath || currentFilePath,
        fields,
        albumArt: stagedAlbumArt // undefined => no change, null => remove, object => set
      });
      currentMetadata = result.metadata;
      // clear staged state after successful save
      stagedAlbumArt = undefined;
      metadataEditMode = false;

      setEditMetadataBtnIcon(false);
      editMetadataBtn.title = "Edit metadata";

      renderMetadata(currentMetadata);
      // update sidebar buttons/visibility after save
      updateHeaderState();

      statusEl.textContent = "Metadata saved.";
      saveSessionState();
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Metadata save failed:\n${err.message || err}`;
    }
  });
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
  }
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
      </button>
    `).join("");

    return group.entries.length > 1
      ? `<div class="toc-group">${items}</div>`
      : items;
  }).join("");

  tocList.querySelectorAll(".toc-item").forEach((button) => {
    button.addEventListener("click", () => {
      const lineIndex = Number(button.dataset.lineIndex);
      const offset = getOffsetForLine(editor.value, lineIndex);

      editor.focus();
      editor.setSelectionRange(offset, offset);

      const lineHeight =
        parseFloat(getComputedStyle(editor).lineHeight) || 20;

      editor.scrollTop =
        Math.max(0, lineIndex * lineHeight - 40);

      refreshEditorView();
    });
  });
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
      fields: {},
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
        ["ID3 Version", metadata?.id3?.version || ""],
        ["ID3 Frames", metadata?.id3?.frameCount ?? ""],
        ["EPICX", metadata?.epicx ? "Present" : "Missing"],
        ["EPICX Frame", metadata?.epicxFrame || "TXXX:EPICX"],
        ["EPICX Size", `${String(metadata?.epicx || "").length} chars`]
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
        ["EPICX", metadata?.epicx ? "Present" : "Missing"],
        ["EPICX Size", `${String(metadata?.epicx || "").length} chars`],
        ["WAV Chunks", chunks.map(chunk => chunk.id.trim()).join(", ")]
      ];

  const visibleItems = items.filter(([, value]) => {
    return String(value ?? "").trim() !== "";
  });

  let html = visibleItems.map(([key, value]) => `
    <div class="meta-item">
      <div class="meta-key">${escapeHtml(key)}</div>
      <div class="meta-value">${escapeHtml(value)}</div>
    </div>
  `).join("");

  // Add album art preview at the bottom if available
  if (
    albumArtBase64 &&
    albumArtMime &&
    String(albumArtMime).startsWith("image/")
  ) {
    const dataUrl = `data:${albumArtMime};base64,${albumArtBase64}`;

    html += `
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
  }

  metadataPanel.innerHTML = html;
  wireAlbumArtNormalModeActions();
}

editor.addEventListener("focus", showGhostHeaderIfAppropriate);
editor.addEventListener("blur", showGhostHeaderIfAppropriate);

editor.addEventListener("input", () => {
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
    const snapshot = manualUndoStack.pop();

    if (snapshot) {
      event.preventDefault();
      const redoSnapshot = applyEditorSnapshot(snapshot, "historyUndo");
      manualRedoStack.push(redoSnapshot);

      scheduleEpicValidation();
      saveSessionState();
      updateHeaderState();
      return;
    }
  }

  if (isRedo) {
    const snapshot = manualRedoStack.pop();

    if (snapshot) {
      event.preventDefault();
      const undoSnapshot = applyEditorSnapshot(snapshot, "historyRedo");
      manualUndoStack.push(undoSnapshot);

      scheduleEpicValidation();
      saveSessionState();
      updateHeaderState();
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

    const hadExistingSession =
      Boolean(currentFilePath || linkedAudioPath);

    const result = await window.EpicInspector.openMedia();

    if (!result) return;

    manualUndoStack = [];
    manualRedoStack = [];

    if (hadExistingSession) {
      resetSession();
    }

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

    statusEl.textContent =
      `Loaded media\n` +
      `EPICX found: ${result.epicx ? "yes" : "no — ready to create"}\n` +
      `EPICX length: ${(result.epicx || "").length} chars`;

    saveSessionState();
    updateHeaderState();

  } catch (err) {
    console.error(err);
    statusEl.textContent = `Open failed:\n${err.message || err}`;
  }
});

tocToggleBtn?.addEventListener("click", () => {
  const willOpen =
    !tocDrawer?.classList.contains("open");

  if (willOpen) {
    renderSectionToc();
  }

  tocDrawer?.classList.toggle("open", willOpen);
});

tocCloseBtn?.addEventListener("click", () => {
  tocDrawer?.classList.remove("open");
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
        `Opened audio using existing embedded EPICX:\n${getDisplayName(currentFilePath)}`;

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
  editMetadataBtn.disabled = true;
  saveSessionState();
  updateHeaderState();
});

async function saveCurrentTextFile({ updateLinkedAudio = true } = {}) {
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

  return result;
}

async function performSave() {
  try {
    statusEl.textContent = "Saving...";

    const isTextFile = /\.(epic|epicx|txt|md)$/i.test(currentFilePath || "");

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
      epicx: editor.value
    });

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

saveBtn.addEventListener("click", performSave);

addAlbumArtBtn?.addEventListener("click", () => {
  addAlbumArt();
});

window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") {
    ev.preventDefault();
    performSave();
  }
});

editor.addEventListener("input", requestEditorHighlightSync);
editor.addEventListener("keyup", requestEditorHighlightSync);
editor.addEventListener("mouseup", requestEditorHighlightSync);
editor.addEventListener("click", requestEditorHighlightSync);
editor.addEventListener("select", requestEditorHighlightSync);

editor.addEventListener("scroll", requestEditorHighlightSync);

editor.addEventListener("beforeinput", () => {
  if (isApplyingUndo) return;

  const scrollTop = editor.scrollTop;

  pushUndoSnapshot();

  requestAnimationFrame(() => {
    editor.scrollTop = scrollTop;
  });
});

restoreSessionState();
window.EpicInspector?.onStudioTimingMenuAction?.(handleStudioTimingMenuAction);
updateHeaderState();
