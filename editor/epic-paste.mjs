import { EditorState } from '@codemirror/state';
import { LineCursor } from '../epic-spec/src/cursor.js';
import { parseHeader } from '../epic-spec/src/header.js';
import { parseEpicxBody } from '../epic-spec/src/epicx.js';

const timestamp = /^(\s*)(\d{2}:\d{2}(?::\d{2})?\.\d{3})/;
function toMilliseconds(value) {
  const parts = value.split(':');
  const [seconds, milliseconds] = parts.pop().split('.').map(Number);
  const minutes = Number(parts.pop());
  const hours = Number(parts.pop() || 0);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}
function formatTime(value, original) {
  const seconds = Math.floor(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const withHours = original.split(':').length === 3 || hours > 0;
  const pad = number => String(number).padStart(2, '0');
  return `${withHours ? `${pad(hours)}:` : ''}${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}.${String(value % 1000).padStart(3, '0')}`;
}

// Apply corrections within the paste transaction so selection mapping, undo,
// and redo include them. Only pasted entry anchors receive timing adjustments.
export const normalizeEpicxPaste = EditorState.transactionFilter.of(transaction => {
  if (!transaction.docChanged || !transaction.isUserEvent('input.paste')) return transaction;
  const doc = transaction.newDoc;
  const cursor = new LineCursor(doc.toString().split('\n'));
  while (cursor.peek()?.trim() === '') cursor.next();
  if (cursor.peek()?.trim() === '---') parseHeader(cursor);
  while (cursor.peek()?.trim() === '') cursor.next();
  if (!/^\d+$/.test(cursor.peek()?.trim() || '')) return transaction;
  const inserted = [];
  transaction.changes.iterChanges((_from, _to, from, to) => inserted.push({ from, to }));
  const entries = parseEpicxBody(cursor).body.entries;
  const pastedEntries = new Set(entries.filter(entry => {
    const line = doc.line(entry.loc.startLine);
    const anchor = doc.line(Math.min(doc.lines, entry.loc.startLine + 1));
    return inserted.some(range => range.from <= line.from && range.to >= anchor.to);
  }));
  if (!pastedEntries.size) return transaction;
  const changes = [];
  let previousTime = null;
  entries.forEach((entry, index) => {
    const line = doc.line(entry.loc.startLine);
    if (/^\s*\d+\s*$/.test(line.text) && entry.index !== index + 1) {
      changes.push({ from: line.from, to: line.to, insert: line.text.replace(/\d+/, String(index + 1)) });
    }
    if (line.number === doc.lines) return;
    const anchor = doc.line(line.number + 1);
    const match = timestamp.exec(anchor.text);
    if (!match) return;
    let time = toMilliseconds(match[2]);
    if (pastedEntries.has(entry) && previousTime !== null && time < previousTime + 2000) {
      time = previousTime + 2000;
      const from = anchor.from + match[1].length;
      changes.push({ from, to: from + match[2].length, insert: formatTime(time, match[2]) });
    }
    previousTime = time;
  });
  return changes.length ? [transaction, { changes, sequential: true }] : transaction;
});
