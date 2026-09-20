/* Conservative three-way line merge. Never guesses when two edits overlap. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EpicProjectTextMerge = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const normalize = text => String(text || '').replace(/\r\n?/g, '\n').trim();
  function changes(base, next) {
    let prefix = 0;
    while (prefix < base.length && prefix < next.length && base[prefix] === next[prefix]) prefix++;
    let tailA = base.length, tailB = next.length;
    while (tailA > prefix && tailB > prefix && base[tailA - 1] === next[tailB - 1]) { tailA--; tailB--; }
    const a = base.slice(prefix, tailA), b = next.slice(prefix, tailB);
    if ((a.length + 1) * (b.length + 1) > 8000000) throw new Error('The changes are too large to merge automatically.');
    const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
      }
    }
    const edits = [];
    let i = 0, j = 0, edit = null;
    const finish = () => { if (edit) edits.push(edit); edit = null; };
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { finish(); i++; j++; continue; }
      if (!edit) edit = { start: i + prefix, end: i + prefix, lines: [] };
      if (j < b.length && (i === a.length || rows[i][j + 1] > rows[i + 1][j])) edit.lines.push(b[j++]);
      else { i++; edit.end = i + prefix; }
    }
    finish();
    return edits;
  }
  function overlaps(a, b) {
    if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
    if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
    return Math.max(a.start, b.start) < Math.min(a.end, b.end);
  }
  function merge(baseText, localText, incomingText) {
    const base = normalize(baseText), local = normalize(localText), incoming = normalize(incomingText);
    if (local === incoming || incoming === base) return { ok: true, text: local };
    if (local === base) return { ok: true, text: incoming };
    try {
      const lines = base.split('\n');
      const localEdits = changes(lines, local.split('\n'));
      const edits = [...localEdits];
      for (const edit of changes(lines, incoming.split('\n'))) {
        const matching = localEdits.filter(other => overlaps(edit, other));
        if (matching.length) {
          if (matching.length === 1 && JSON.stringify(matching[0]) === JSON.stringify(edit)) continue;
          return { ok: false, reason: 'conflict', message: 'Studio and Writer changed the same lines. Your Writer edits have been kept; resolve those lines before saving.' };
        }
        edits.push(edit);
      }
      edits.sort((a, b) => b.start - a.start);
      for (const edit of edits) lines.splice(edit.start, edit.end - edit.start, ...edit.lines);
      return { ok: true, text: lines.join('\n') };
    } catch (error) { return { ok: false, reason: 'conflict', message: error.message }; }
  }
  return { merge, normalize };
});
