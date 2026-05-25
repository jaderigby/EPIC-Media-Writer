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

let sourceEditorText = "";
let sourceHadContent = false;
let linkedAudioPath = "";

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

  storeAudioBtn.style.display =
    hasContent && !hasLinkedAudio && !isAudioSession
      ? ""
      : "none";

  storeAudioBtn.disabled =
    !hasContent || hasLinkedAudio || isAudioSession;

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
}

function getDisplayName(filePath) {
  if (!filePath) return "No file loaded";
  return String(filePath).split(/[\\/]/).pop();
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

    sourceHadContent = Boolean(state.sourceHadContent);

    sourceEditorText = state.sourceEditorText || editor.value;

    currentMetadata = state.currentMetadata || null;

    currentFilePath = state.currentFilePath || "";
    editor.value = state.editorText || "";

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

  editor.value = "";
  sourceEditorText = "";
  sourceHadContent = false;

  filePathEl.textContent = "No file loaded";

  linkedAudioPath = "";

  statusEl.textContent = "Idle";

  validationStatusEl.textContent = "";

  metadataPanel.textContent = "";

  saveBtn.disabled = true;

  editMetadataBtn.disabled = true;

  setEditMetadataBtnIcon(false);
  editMetadataBtn.title = "Edit metadata";

  localStorage.removeItem(SESSION_KEY);
  updateHeaderState();
  showGhostHeaderIfAppropriate();
}

function scheduleEpicValidation() {
  clearTimeout(parseTimer);

  parseTimer = setTimeout(async () => {
    if (!window.EpicInspector?.parseEpic) return;

    try {
      const result = await window.EpicInspector.parseEpic({
        source: editor.value
      });

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
  const existingArtBase64 = metadata?.albumArt || metadata?.albumArtInfo?.data || "";
  const existingArtMime = metadata?.albumArtMime || metadata?.albumArtInfo?.mimeType || "";

  // start with no staged change
  stagedAlbumArt = undefined;

  // Only show album art editor inside the edit form when an image already exists.
  const albumArtEditorHtml = existingArtBase64
    ? `
      <div class="meta-item">
        <div class="meta-key">Album Art</div>
        <div class="meta-value" id="albumArtEditor">
          <div id="albumArtContainer" style="position:relative;display:inline-block;">
            <img id="albumArtPreview" class="album-art-preview" src="${existingArtBase64 && existingArtMime ? `data:${existingArtMime};base64,${existingArtBase64}` : ""}" style="display: ${existingArtBase64 ? "block" : "none"}; max-width:240px; max-height:240px;" alt="Album Art Preview" />
            <!-- when no existing art, do not show a placeholder box; adding is via the sidebar button -->
            <div id="albumArtPlaceholder" style="opacity:0.8; display: ${existingArtBase64 ? "none" : "none"}; width:240px; height:240px; background:#f3f3f3; align-items:center; justify-content:center;">No album art</div>

            <!-- overlay icon buttons in top-right -->
            <div id="albumArtIcons" style="position:absolute; top:6px; right:6px; display:${existingArtBase64 ? "flex" : "none"}; gap:6px;">
              <button type="button" id="uploadAlbumArtIconBtn" title="Upload/Replace" style="width:32px;height:32px;border-radius:4px;background:rgba(0,0,0,0.6);color:#fff;border:0;display:flex;align-items:center;justify-content:center;">
                <svg class="icon edit-mini-icon" viewBox="0 0 628 628" aria-hidden="true" style="width:18px;height:18px;">
                  <use href="icons.svg#edit-mini-icon"></use>
                </svg>
              </button>
              <button type="button" id="removeAlbumArtIconBtn" title="Remove" style="width:32px;height:32px;border-radius:4px;background:rgba(200,0,0,0.85);color:#fff;border:0;display:flex;align-items:center;justify-content:center;">
                <svg class="icon delete-icon" viewBox="0 0 628 628" aria-hidden="true" style="width:18px;height:18px;">
                  <use href="icons.svg#delete-icon"></use>
                </svg>
              </button>
            </div>
          </div>
          <input id="albumArtFileInput" type="file" accept="image/*" style="display:none" />
        </div>
      </div>
    `
    : '';

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

      ${albumArtEditorHtml}

      <div class="metadata-actions">
        <button type="submit">Save Metadata</button>
        <button type="button" id="cancelMetadataEditBtn">Cancel</button>
      </div>
    </form>
  `;

  // Wire album art controls (icon upload / remove) for edit-mode staging
  const uploadBtn = document.getElementById("uploadAlbumArtIconBtn");
  const removeBtn = document.getElementById("removeAlbumArtIconBtn");
  const fileInput = document.getElementById("albumArtFileInput");
  const preview = document.getElementById("albumArtPreview");
  const placeholder = document.getElementById("albumArtPlaceholder");
  const iconsWrap = document.getElementById("albumArtIcons");

  uploadBtn?.addEventListener("click", () => fileInput?.click());

    if (uploadBtn) {
      uploadBtn.innerHTML = `<svg class="icon edit-mini-icon core-action"><use href="icons.svg#edit-mini-icon"></use></svg>`;
    }
  fileInput?.addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const m = String(dataUrl).match(/^data:(image\/[^;]+);base64,(.*)$/i);
      if (m) {
        stagedAlbumArt = { mimeType: m[1], data: m[2] };
        if (preview) {
          preview.src = dataUrl;
          preview.style.display = "block";
        }
        if (placeholder) placeholder.style.display = "none";
        if (iconsWrap) iconsWrap.style.display = "flex";
        // ensure the whole meta-item is visible when uploading
        const metaItem = document.getElementById("albumArtEditor")?.closest('.meta-item');
        if (metaItem) metaItem.style.display = "";
      }
    };
    reader.readAsDataURL(f);
  });

  removeBtn?.addEventListener("click", () => {
    // mark removal (null) so save will remove art
    stagedAlbumArt = null;
    if (preview) {
      preview.src = "";
      preview.style.display = "none";
    }
    // hide placeholder, overlay icons and the entire Album Art meta-item
    if (placeholder) {
      placeholder.style.display = "none";
    }
    if (iconsWrap) iconsWrap.style.display = "none";
    const metaItem = document.getElementById("albumArtEditor")?.closest('.meta-item');
    if (metaItem) metaItem.style.display = "none";
  });

  document.getElementById("cancelMetadataEditBtn")?.addEventListener("click", () => {
    metadataEditMode = false;
    setEditMetadataBtnIcon(false);
    editMetadataBtn.title = "Edit metadata";
    // discard staged album art changes
    stagedAlbumArt = undefined;
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

clearSessionBtn?.addEventListener("click", () => {
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

    currentFilePath = result.filePath;
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
        <img class="album-art-preview" src="${dataUrl}" alt="Album Art" />
      </div>
    `;
  }

  metadataPanel.innerHTML = html;
}

editor.addEventListener("focus", showGhostHeaderIfAppropriate);
editor.addEventListener("blur", showGhostHeaderIfAppropriate);

editor.addEventListener("input", () => {
  showGhostHeaderIfAppropriate();
  rememberAuthorKeyCorrection();
});

editor.addEventListener("keydown", (event) => {
  if (
    ghostHeaderVisible &&
    (event.key === "Enter" || event.key === "Tab")
  ) {
    event.preventDefault();
    commitGhostHeader();
    return;
  }

  if (event.key === "Tab") {
    if (moveToNextHeaderValue()) {
      event.preventDefault();
    }
  }
});

openBtn.addEventListener("click", async () => {
  try {
    const hadExistingSession =
      Boolean(currentFilePath || linkedAudioPath);

    const result = await window.EpicInspector.openMedia();

    if (!result) return;

    if (hadExistingSession) {
      resetSession();
    }

    currentFilePath = result.filePath;

    if (result.kind === "text") {
      editor.value = result.text || "";
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

storeAudioBtn?.addEventListener("click", async () => {
  try {
    statusEl.textContent = "Linking audio...";

    const result = await window.EpicInspector.storeInAudio({
      targetPath: "",
      epicx: editor.value,
      projectLabel: getDisplayName(currentFilePath) || "Current project"
    });

    if (!result) {
      statusEl.textContent = "Link audio canceled.";
      return;
    }

    linkedAudioPath = result.filePath;
    currentMetadata = result.metadata;

    renderMetadata(currentMetadata);

    editMetadataBtn.disabled = false;

    statusEl.textContent =
      result.verified
        ? `Linked and stored in audio:\n${getDisplayName(linkedAudioPath)}`
        : `Linked, but verification failed:\n${getDisplayName(linkedAudioPath)}`;

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

async function performSave() {
  try {
    statusEl.textContent = "Saving...";

    const isTextFile =
      /\.(epic|epicx)$/i.test(currentFilePath || "");

    if (isTextFile) {
      const result = await window.EpicInspector.saveText({
        filePath: currentFilePath,
        text: editor.value
      });

      sourceEditorText = editor.value;
      sourceHadContent =
        editor.value.trim().length > 0;

      if (linkedAudioPath) {
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

      statusEl.textContent =
        linkedAudioPath
          ? `Saved text and updated audio:\n${getDisplayName(result.filePath)} ↔ ${getDisplayName(linkedAudioPath)}`
          : `Saved text file:\n${getDisplayName(result.filePath)}`;

      saveSessionState();
      updateHeaderState();
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

window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") {
    ev.preventDefault();
    performSave();
  }
});

restoreSessionState();
updateHeaderState();