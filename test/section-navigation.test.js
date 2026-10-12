const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.RENDERER_SOURCE || path.join(__dirname, '..', 'renderer.js'), 'utf8');
const helper = source.slice(source.indexOf('function getEpicStructuralLines('), source.indexOf('function scheduleEpicValidation('));
const context = vm.createContext({});
vm.runInContext(helper + source.slice(source.indexOf('function getSectionTocEntries('), source.indexOf('function getOffsetForLine(')), context);
const entries = lines => JSON.parse(JSON.stringify(context.getSectionTocEntries(lines.join('\n'))));
for (const fence of ['```', '```epic', '~~~text', '   ```js']) {
  const close = fence.includes('~') ? '~~~' : '```';
  assert.deepEqual(entries(['[Verse]', fence, '[Example]', close, '[Chorus]']), [
    { label: '[Verse]', lineIndex: 0 }, { label: '[Chorus]', lineIndex: 4 }
  ]);
}
assert.deepEqual(entries(['````epic', '[Hidden]', '```', '[Still hidden]', '~~~~', '[Hidden too]', '```` trailing', '[Still code]', '`````', '[Visible]']), [{ label: '[Visible]', lineIndex: 9 }]);
assert.deepEqual(entries(['~~~', '[Hidden]', '```', '[Still hidden]', '~~~', '[Visible]']), [{ label: '[Visible]', lineIndex: 5 }]);
assert.deepEqual(entries(['[Verse]', '```', '[Unclosed]']), [{ label: '[Verse]', lineIndex: 0 }]);
assert.deepEqual(entries(['```', '[Only code]', '```']), []);
assert.deepEqual(entries(['[Verse]', '```', '[Example]', '```', '[Verse]', '[Chorus {{open}}]']), [
  { label: '[Verse]', lineIndex: 0 }, { label: '[Chorus {{open}}]', lineIndex: 5 }
]);
assert.deepEqual(entries(['`inline`', '[Visible]', '``', '[Also visible]']), [
  { label: '[Visible]', lineIndex: 1 }, { label: '[Also visible]', lineIndex: 3 }
]);
assert.deepEqual(entries(['```bad`info', '[Visible]']), [{ label: '[Visible]', lineIndex: 1 }]);
assert.deepEqual(entries(['```epic\r', '[Hidden]\r', '```\r', '[Visible]\r']), [{ label: '[Visible]', lineIndex: 3 }]);
console.log('Fenced-code section navigation tests passed.');
