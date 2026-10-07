// Only the active document occupies the editor. Inactive tabs retain immutable
// CodeMirror states (including history), file data, and their metadata form DOM.
let fileTabs = [];
let activeFileTabId = null;
let fileTabEpoch = 0;
let fileOperationDepth = 0;

function blankFileTab() {
  return { id: crypto.randomUUID(), currentFilePath: '', editorText: '', sourceEditorText: '', emotiveRecipes: [], statusText: '', validationText: '' };
}

function hasMetadataDraft() {
  return stagedAlbumArt !== undefined || [...metadataPanel.querySelectorAll('input:not([type="hidden"]), textarea')]
    .some(control => !control.closest('[hidden]') && control.value !== control.defaultValue);
}

function captureActiveFileTab() {
  const tab = fileTabs.find(tab => tab.id === activeFileTabId);
  if (!tab) return;
  Object.assign(tab, {
    currentFilePath, currentMetadata, editorText: editor.value, sourceEditorText,
    sourceHadContent, linkedAudioPath, studioTimingLink, rawMetadataOpen,
    metadataEditMode, metadataActiveTab, stagedAlbumArt,
    statusText: stripPinnedStatusText(statusEl.textContent), validationText: validationStatusEl.textContent,
    lastEpicValidationResult, pendingAddedEpicxTimestamps,
    emotiveRecipes: emotiveSessionRecipes,
    editorSnapshot: editor.capture(), selectionStart: editor.selectionStart,
    selectionEnd: editor.selectionEnd, scrollTop: editor.scrollTop,
    metadataDraftValues: [...metadataPanel.querySelectorAll('input, textarea, select')].map(control => ({ value: control.value, checked: control.checked })),
    metadataDraftDirty: hasMetadataDraft(),
    metadataNodes: [...metadataPanel.childNodes], metadataTabNodes: [...metadataHeaderTabs.childNodes]
  });
}

function applyFileTab(tab) {
  fileTabEpoch++;
  clearTimeout(parseTimer);
  stopStudioTimingPolling();
  closeEmotiveRecipeDialog();
  closeAuthorKeyPicker();
  hoveredEditorLineIndex = null;
  activeFileTabId = tab.id;
  currentFilePath = tab.currentFilePath || '';
  currentMetadata = tab.currentMetadata || null;
  sourceEditorText = tab.sourceEditorText ?? '';
  sourceHadContent = Boolean(tab.sourceHadContent);
  linkedAudioPath = tab.linkedAudioPath || '';
  studioTimingLink = tab.studioTimingLink || null;
  rawMetadataOpen = Boolean(tab.rawMetadataOpen);
  metadataEditMode = Boolean(tab.metadataEditMode);
  metadataActiveTab = tab.metadataActiveTab || 'standard';
  stagedAlbumArt = tab.stagedAlbumArt;
  lastEpicValidationResult = tab.lastEpicValidationResult || null;
  pendingAddedEpicxTimestamps = tab.pendingAddedEpicxTimestamps || [];
  emotiveSessionRecipes = tab.emotiveRecipes || [];
  ghostHeaderVisible = false;
  if (tab.editorSnapshot) editor.restore(tab.editorSnapshot);
  else {
    editor.load(tab.editorText || '');
    editor.setSelectionRange(tab.selectionStart || 0, tab.selectionEnd || 0);
    editor.scrollTop = tab.scrollTop || 0;
  }
  editor.setPlaceholder('');
  filePathEl.textContent = currentFilePath ? getDisplayName(currentFilePath) : 'Untitled';
  setStatus(tab.statusText || '');
  validationStatusEl.textContent = tab.validationText || '';
  if (tab.metadataNodes) {
    metadataPanel.replaceChildren(...tab.metadataNodes);
    metadataHeaderTabs.replaceChildren(...tab.metadataTabNodes);
  } else if (currentMetadata) {
    renderMetadata(currentMetadata);
    const controls = metadataPanel.querySelectorAll('input, textarea, select');
    tab.metadataDraftValues?.forEach((saved, index) => {
      if (!controls[index]) return;
      controls[index].value = saved.value;
      if (saved.checked !== undefined) controls[index].checked = saved.checked;
    });
  }
  else {
    metadataPanel.textContent = '';
    clearMetadataHeaderTabs();
  }
  editMetadataBtn.disabled = !currentMetadata;
  setEditMetadataBtnIcon(metadataEditMode);
  updateNumericOrderingButton(lastEpicValidationResult);
  refreshEditorView();
  updateHeaderState();
  document.querySelector('#fileTabList .is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  showGhostHeaderIfAppropriate();
  if (editor.value.trim()) scheduleEpicValidation();
  if (studioTimingLink && canLinkStudioTiming()) startStudioTimingPolling();
}

function canChangeFileTab() {
  return !fileOperationDepth && !isStudioTimingSyncInProgress &&
    document.getElementById('confirmModal').classList.contains('hidden') &&
    !document.querySelector('#shortcutHelp[open]');
}

function activateFileTab(id) {
  if (!canChangeFileTab() || id === activeFileTabId) return;
  const tab = fileTabs.find(tab => tab.id === id);
  if (!tab) return;
  closeEmotiveRecipeDialog();
  captureActiveFileTab();
  applyFileTab(tab);
  saveSessionState();
}

function addFileTab(tab = blankFileTab()) {
  closeEmotiveRecipeDialog();
  captureActiveFileTab();
  const current = fileTabs.find(tab => tab.id === activeFileTabId);
  if (current && !current.currentFilePath && !current.editorText && !current.emotiveRecipes?.length && fileTabs.length === 1) {
    fileTabs = [];
  }
  fileTabs.push(tab);
  applyFileTab(tab);
  saveSessionState();
}

async function closeFileTab(id) {
  if (!canChangeFileTab()) return;
  if (id !== activeFileTabId) activateFileTab(id);
  if (id !== activeFileTabId) return;
  if (hasUnsavedChanges() || hasMetadataDraft()) {
    const name = currentFilePath ? getDisplayName(currentFilePath) : 'Untitled';
    if (!(await showConfirmModal({ title: 'Close file?', message: `Discard unsaved changes to ${name}?`, confirmLabel: 'Discard', cancelLabel: 'Cancel' }))) return;
  }
  closeEmotiveRecipeDialog();
  const index = fileTabs.findIndex(tab => tab.id === id);
  fileTabs.splice(index, 1);
  if (!fileTabs.length) fileTabs.push(blankFileTab());
  applyFileTab(fileTabs[Math.min(index, fileTabs.length - 1)]);
  saveSessionState();
}

function renderFileTabs() {
  const list = document.getElementById('fileTabList');
  if (!list) return;
  const scrollLeft = list.scrollLeft;
  const focused = document.activeElement;
  const focusId = focused?.dataset?.tabId;
  const focusClose = focused?.classList.contains('file-tab-close');
  list.replaceChildren(...fileTabs.map(tab => {
    const active = tab.id === activeFileTabId;
    const path = active ? currentFilePath : tab.currentFilePath;
    const label = path ? getDisplayName(path) : 'Untitled';
    const dirty = active ? hasUnsavedChanges() || hasMetadataDraft() : tab.editorText !== tab.sourceEditorText || tab.metadataDraftDirty;
    const row = document.createElement('div'); row.className = `file-tab${active ? ' is-active' : ''}`;
    row.classList.toggle('is-studio-linked', Boolean(active ? studioTimingLink : tab.studioTimingLink));
    const select = document.createElement('button'); select.type = 'button'; select.className = 'file-tab-select';
    select.dataset.tabId = tab.id; select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(active)); select.tabIndex = active ? 0 : -1;
    select.textContent = label + (dirty ? ' •' : '');
    select.title = (path || 'Untitled') + (dirty ? ' — unsaved changes' : '');
    select.disabled = !!fileOperationDepth;
    select.addEventListener('click', () => activateFileTab(tab.id));
    select.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = fileTabs.indexOf(tab), count = fileTabs.length;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
      activateFileTab(fileTabs[next].id);
      list.querySelector('[aria-selected="true"]')?.focus();
    });
    const close = document.createElement('button'); close.type = 'button'; close.className = 'file-tab-close';
    close.dataset.tabId = tab.id; close.textContent = '×'; close.setAttribute('aria-label', `Close ${label}`);
    close.disabled = !!fileOperationDepth;
    close.addEventListener('click', () => closeFileTab(tab.id));
    row.append(select, close); return row;
  }));
  if (focusId) list.querySelector(`.${focusClose ? 'file-tab-close' : 'file-tab-select'}[data-tab-id="${focusId}"]`)?.focus();
  list.scrollLeft = scrollLeft;
  document.getElementById('newFileTab').disabled = !!fileOperationDepth;
}

function persistFileTabs() {
  if (restoreInProgress) return;
  captureActiveFileTab();
  const tabs = fileTabs.map(({ editorSnapshot, metadataNodes, metadataTabNodes, ...tab }) => tab);
  localStorage.setItem(SESSION_KEY, JSON.stringify({ version: 2, tabs, activeFileTabId }));
  renderFileTabs();
}

function restoreFileTabs() {
  const raw = localStorage.getItem(SESSION_KEY);
  try {
    restoreInProgress = true;
    const saved = raw ? JSON.parse(raw) : null;
    fileTabs = saved?.version === 2 && saved.tabs?.length ? saved.tabs : saved ? [{ ...saved, id: crypto.randomUUID() }] : [blankFileTab()];
    applyFileTab(fileTabs.find(tab => tab.id === saved?.activeFileTabId) || fileTabs[0]);
  } catch (error) {
    console.warn('Could not restore file tabs:', error);
    fileTabs = [blankFileTab()];
    applyFileTab(fileTabs[0]);
  } finally { restoreInProgress = false; }
  renderFileTabs();
}

// Keep file operations on the originating document until they finish.
function lockFileOperation(operation) {
  return async function (...args) {
    fileOperationDepth++;
    renderFileTabs();
    try { return await operation.apply(this, args); }
    finally { fileOperationDepth--; renderFileTabs(); }
  };
}
