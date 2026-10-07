// EPIC/EPICX highlighting describes source ranges; it never rewrites the text.
export function epicSyntax(source) {
  const lines = String(source).split('\n');
  const marks = [];
  const lineStyles = [];
  let offset = 0, fences = 0, header = false, freeflow = false, block = '', entry = false;
  let freeflowNotes = false;
  const timeLine = text => /^\s*\d{2}:\d{2}(?::\d{2})?\.\d{3}(?:\s*-->\s*\d{2}:\d{2}(?::\d{2})?\.\d{3})?\s*$/.test(text);
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index], trimmed = text.trim(), classes = [];
    const add = (from, to, className) => {
      if (to > from) marks.push({ from: offset + from, to: offset + to, className });
    };
    const startsEntry = /^\s*\d+\s*$/.test(text) && timeLine(lines[index + 1] || '');
    if (startsEntry) entry = true;
    if (!trimmed) entry = false;
    if (entry) classes.push('cm-epic-entry');
    if (startsEntry) classes.push('cm-epic-entry-start');
    if (entry && !(lines[index + 1] || '').trim()) classes.push('cm-epic-entry-end');
    const opensFreeflow = !header && !freeflowNotes && /^\s*\[\s*\{&\}[\s\S]*\]\s*$/.test(text);
    if (opensFreeflow && /^\s*\[\s*\{&\}\s*\]\s*$/.test(text)) freeflowNotes = true;
    const closesFreeflow = freeflow && !freeflowNotes && trimmed === ':::';
    if (freeflow || opensFreeflow) {
      classes.push('epic-freeflow-section', 'cm-epic-freeflow');
      if (freeflowNotes) classes.push('cm-epic-freeflow-notes');
      if (opensFreeflow) classes.push('cm-epic-freeflow-opener');
      if (closesFreeflow) classes.push('epic-freeflow-closer');
    } else if (trimmed === '---') {
      fences++;
      header = fences === 1;
      classes.push('epic-header');
    } else if (header) {
      classes.push('epic-header');
    } else if (/^\s*\[[^\]]+\]\s*$/.test(text)) {
      classes.push('epic-section');
    }
    if (opensFreeflow) freeflow = true;
    if (trimmed.startsWith('{{') && !trimmed.includes('}}')) {
      block = trimmed.startsWith('{{&}') ? 'epic-freeform-notation' : 'epic-instruction';
    }
    if (block && !freeflow) classes.push(block);
    if (block && trimmed.endsWith('}}')) block = '';
    if (closesFreeflow) freeflow = false;
    if (!header && (/^\s*[-*+]\s+\S/.test(text) || /^\s*\d+\.\s+\S/.test(text))) classes.push('cm-epic-list');
    if (startsEntry && (index === 0 || !lines[index - 1].trim())) add(0, text.length, 'epic-entry-number');
    for (const match of text.matchAll(/\b\d{2}:\d{2}(?::\d{2})?\.\d{3}/g)) add(match.index, match.index + match[0].length, 'epic-time');
    for (const match of text.matchAll(/\{\{&\}[^{}]*?\}\}|\{\{[^{}]*?\}\}/g)) {
      add(match.index, match.index + match[0].length, match[0].startsWith('{{&}') ? 'epic-freeform-notation' : 'epic-instruction');
    }
    const codeRanges = [];
    for (const match of text.matchAll(/`([^`]+)`/g)) {
      const start = match.index, end = start + match[0].length;
      codeRanges.push([start, end]);
      add(start, start + 1, 'md-marker'); add(start + 1, end - 1, 'md-inline-code'); add(end - 1, end, 'md-marker');
    }
    const inCode = match => codeRanges.some(([from, to]) => match.index < to && match.index + match[0].length > from);
    for (const match of text.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)) {
      if (inCode(match)) continue;
      const start = match.index, prefix = match[1] ? 'md-image' : 'md-link', labelStart = start + (match[1] ? 2 : 1);
      const labelEnd = labelStart + match[2].length, targetStart = labelEnd + 2, targetEnd = targetStart + match[3].length;
      add(start, targetEnd + 1, `${prefix}-ref`);
      add(start, labelStart, 'md-marker'); add(labelStart, labelEnd, `${prefix}-label`);
      add(labelEnd, targetStart, 'md-marker'); add(targetStart, targetEnd, `${prefix}-target`); add(targetEnd, targetEnd + 1, 'md-marker');
    }
    for (const [pattern, className, width] of [[/\*\*([^*]+)\*\*/g, 'md-bold', 2], [/(?<!\*)\*([^*\n]+)\*(?!\*)/g, 'md-italic', 1]]) {
      for (const match of text.matchAll(pattern)) {
        if (inCode(match)) continue;
        const start = match.index, end = start + match[0].length;
        add(start, start + width, 'md-marker'); add(start + width, end - width, className); add(end - width, end, 'md-marker');
      }
    }
    if (classes.length) lineStyles.push({ from: offset, className: classes.join(' ') });
    offset += text.length + 1;
  }
  return { marks, lines: lineStyles };
}

// Send only the changed range to CodeMirror, retaining mapped selections and history.
export function textChange(before, after) {
  if (before === after) return null;
  let from = 0, oldEnd = before.length, newEnd = after.length;
  while (from < oldEnd && from < newEnd && before[from] === after[from]) from++;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}
