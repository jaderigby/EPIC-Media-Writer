const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.RENDERER_SOURCE || path.join(__dirname, '..', 'renderer.js'), 'utf8');
const helper = source.slice(source.indexOf('function getEpicStructuralLines('), source.indexOf('function scheduleEpicValidation('));
function setup(filePath) {
  const c = vm.createContext({
    currentFilePath: filePath, fileTabEpoch: 0, parseTimer: null,
    editor: { value: '# Markdown\n```\n[0:v]scale=356:200[gif];\n```' },
    validationStatusEl: { textContent: 'old errors' },
    lastEpicValidationResult: { ok: false }, calls: 0, ordering: true,
    clearTimeout() { c.pending = null; },
    setTimeout(fn) { c.pending = fn; return 1; },
    updateNumericOrderingButton(result) { c.ordering = result; },
    saveSessionState() {}, formatParseIssue(issue) { return issue.message; },
    window: { EpicInspector: { async parseEpic() { c.calls++; return { ok: true }; } } }
  });
  vm.runInContext(helper + source.slice(source.indexOf('function scheduleEpicValidation()'), source.indexOf('editor.addEventListener("input", scheduleEpicValidation)')), c);
  return c;
}
(async () => {
  for (const name of ['notes.md', 'NOTES.MD', 'notes.markdown']) {
    const c = setup(name);
    c.scheduleEpicValidation();
    assert.equal(c.pending, null);
    assert.equal(c.calls, 0);
    assert.equal(c.validationStatusEl.textContent, '');
    assert.equal(c.lastEpicValidationResult, null);
    assert.equal(c.ordering, null);
  }
  for (const name of ['song.epic', 'song.epicx', 'song.epic.txt', 'song.wav', '']) {
    const c = setup(name);
    c.scheduleEpicValidation();
    await c.pending();
    assert.equal(c.calls, 1);
    assert.equal(c.validationStatusEl.textContent, 'EPIC/EPICX valid.');
  }
  for (const fails of [false, true]) {
    const c = setup('song.epic');
    let finish;
    c.window.EpicInspector.parseEpic = () => new Promise((resolve, reject) => {
      finish = () => fails ? reject(new Error('late failure')) : resolve({ ok: false, issues: [{ message: 'late error' }] });
    });
    c.scheduleEpicValidation();
    const running = c.pending();
    c.currentFilePath = 'song.md'; // Save As does not change the tab epoch.
    c.scheduleEpicValidation();
    finish();
    await running;
    assert.equal(c.validationStatusEl.textContent, '');
    assert.equal(c.lastEpicValidationResult, null);
  }
  const c = setup('song.epic');
  c.scheduleEpicValidation();
  c.currentFilePath = 'notes.md';
  c.scheduleEpicValidation();
  assert.equal(c.pending, null);
  console.log('Markdown validation regression tests passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
