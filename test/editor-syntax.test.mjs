import assert from 'node:assert/strict';
import { epicSyntax, textChange } from '../editor/epic-syntax.mjs';
import { EditorState } from '@codemirror/state';

const sample = '---\nTitle: <literal> & song\n---\n\n1\n00:01.000 --> 00:02.000\n[Verse {{open}}]\n**bold** *soft* `*literal*` [link](url) ![art](art.png)\n\n[{&}free]\nfree text\n:::\n{{&}direction\nmultiline\n}}';
const tokens = epicSyntax(sample);
const hasMark = (text, className) => tokens.marks.some(mark => sample.slice(mark.from, mark.to) === text && mark.className === className);
assert.ok(hasMark('1', 'epic-entry-number'));
assert.ok(hasMark('00:01.000', 'epic-time'));
assert.ok(hasMark('{{open}}', 'epic-instruction'));
assert.ok(hasMark('bold', 'md-bold'));
assert.ok(hasMark('soft', 'md-italic'));
assert.ok(hasMark('*literal*', 'md-inline-code'));
assert.ok(!hasMark('literal', 'md-italic'), 'Code spans preserve literal markdown');
assert.ok(hasMark('link', 'md-link-label'));
assert.ok(hasMark('art.png', 'md-image-target'));
for (const className of ['epic-header', 'epic-section', 'cm-epic-entry', 'cm-epic-freeflow-opener', 'epic-freeflow-closer', 'epic-freeform-notation']) {
  assert.ok(tokens.lines.some(line => line.className.split(' ').includes(className)), className);
}
for (const [before, after] of [['abc', 'axc'], ['', 'hello'], ['hello', ''], ['😀 song', '😄 song'], ['line\nnext', 'line\nlast'], ['same', 'same']]) {
  const change = textChange(before, after);
  assert.equal(change ? EditorState.create({ doc: before }).update({ changes: change }).state.doc.toString() : before, after);
}
console.log('EPIC syntax ranges and document edits passed.');

const notesSource = '[{&}Verse]\nRegular\n:::\n[{&}]\nNotes\n:::\n[Chorus]\n[{&}Other]\nLast line';
const notesStart = notesSource.indexOf('[{&}]');
const notesTokens = epicSyntax(notesSource);
for (const line of notesTokens.lines) {
  assert.equal(line.className.includes('cm-epic-freeflow-notes'), line.from >= notesStart,
    'Only unlabeled Freeflow Notes receive notes styling, continuing through EOF');
  if (line.from > notesStart) {
    assert.ok(!line.className.includes('cm-epic-freeflow-opener'));
    assert.ok(!line.className.includes('epic-freeflow-closer'));
  }
}
assert.ok(notesTokens.lines.some(line => line.from === notesSource.lastIndexOf('Last line') && line.className.includes('cm-epic-freeflow-notes')));
console.log('Freeflow Notes scope and EOF termination passed.');
