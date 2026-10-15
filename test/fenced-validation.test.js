const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const { parseEpicText } = require(path.join(root, 'lib/epic-parser.js'));
const source = fs.readFileSync(process.env.RENDERER_SOURCE || path.join(root, 'renderer.js'), 'utf8');
const c = vm.createContext({ window: { EpicInspector: { parseEpic: ({ source }) => parseEpicText(source) } }, numericOrderingBtn: { style: {} } });
for (const [start, end] of [
  ['function getEpicStructuralLines(', 'function scheduleEpicValidation('],
  ['function updateNumericOrderingButton(', 'numericOrderingBtn?.addEventListener("mousedown"']
]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), c);
(async () => {
  const header = '---\nTitle: Example\nArtist: Test\n---\n\n';
  const example = '```epicx\n\n\n99\n00:09.000\n[Example]\n[0:v]scale=356:200[gif];\n```';
  const text = header + '1\n00:01.000\n[Verse]\nLyrics\n\n' + example + '\n\n2\n00:02.000\n[Chorus]\nMore lyrics';
  const parsed = await c.parseEpicStructure(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  assert.equal(parsed.document.body.entries.length, 2);
  c.updateNumericOrderingButton(parsed);
  assert.equal(c.numericOrderingBtn.style.display, 'none');
  const broken = text.replace('\n2\n00:02.000', '\n8\n00:02.000');
  const bad = await c.parseEpicStructure(broken);
  c.updateNumericOrderingButton(bad);
  assert.equal(c.numericOrderingBtn.style.display, '');
  const repaired = c.resyncEpicxEntryIndexes(broken, bad.document.body.entries);
  assert.equal(repaired, text, 'Only the real entry number changes; fenced code and blank lines stay intact');
  const invalid = text + '\n\n[bad]trailing';
  const errors = await c.parseEpicStructure(invalid);
  assert.equal(errors.ok, false, 'Real errors outside fences remain visible');
  assert.ok(errors.issues.some(issue => issue.line === invalid.split('\n').length), 'Real error retains original line number');
  const onlyCode = await c.parseEpicStructure(example);
  assert.equal(onlyCode.empty, true);
  console.log('Fenced validation and numeric reordering tests passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
