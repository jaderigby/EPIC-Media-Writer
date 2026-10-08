import { EditorState, EditorSelection, StateEffect, StateField, Compartment, Prec, Transaction } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, placeholder } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, undo, redo, isolateHistory, selectLine } from '@codemirror/commands';
import { epicSyntax, textChange } from './epic-syntax.mjs';

// Keep the insertion policy in one place for future editor preferences.
const tabText = ' '.repeat(4);
function insertTabSpaces(view) {
  if (view.state.readOnly) return false;
  view.dispatch(view.state.replaceSelection(tabText), {
    scrollIntoView: true, annotations: Transaction.userEvent.of('input.type')
  });
  return true;
}

function cycleEmphasis(view) {
  const { state } = view;
  const selection = state.selection.main;
  if (state.readOnly || selection.empty) return true;
  let { from, to } = selection;
  let text = state.doc.sliceString(from, to), width = 0;
  // Accept either the words alone or a selection including their markers.
  const wrapped = /^(\*{1,2})(?!\*)([\s\S]*?[^*])\1$/.exec(text);
  if (wrapped) {
    width = wrapped[1].length;
    text = wrapped[2];
  } else {
    const before = state.doc.sliceString(Math.max(0, from - 3), from).match(/\*+$/)?.[0].length || 0;
    const after = state.doc.sliceString(to, Math.min(state.doc.length, to + 3)).match(/^\*+/)?.[0].length || 0;
    if (before === after && before > 0 && before <= 2) {
      width = before;
      from -= width;
      to += width;
    }
  }
  const nextWidth = (width + 1) % 3;
  const marker = '*'.repeat(nextWidth);
  const start = from + nextWidth, end = start + text.length;
  view.dispatch({
    changes: { from, to, insert: marker + text + marker },
    selection: selection.anchor > selection.head ? { anchor: end, head: start } : { anchor: start, head: end },
    annotations: [Transaction.userEvent.of('input.emphasis'), isolateHistory.of('full')],
    scrollIntoView: true
  });
  return true;
}

const selectedSpace = Decoration.mark({ class: 'cm-selected-space' });
const secondarySelection = Decoration.mark({ class: 'cm-extra-selection' });
class ExtraCursor extends WidgetType {
  toDOM() {
    const cursor = document.createElement('span');
    cursor.className = 'cm-extra-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    return cursor;
  }
}
const extraCursor = Decoration.widget({ widget: new ExtraCursor(), side: 1 });

const skippedEffect = StateEffect.define();
const skipNotice = ViewPlugin.fromClass(class {
  constructor() {
    this.notice = document.createElement('div');
    this.notice.className = 'epic-skip-notice';
    this.notice.setAttribute('role', 'status');
    Object.assign(this.notice.style, {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
      zIndex: '10000', pointerEvents: 'none', opacity: '0',
      padding: '10px 20px', borderRadius: '8px', background: 'rgba(31, 33, 38, .94)',
      color: '#e8e9ec', font: '14px system-ui, sans-serif', boxShadow: '0 4px 20px #0005'
    });
  }
  update(update) {
    if (!update.transactions.some(transaction => transaction.effects.some(effect => effect.is(skippedEffect)))) return;
    this.animation?.cancel();
    this.notice.textContent = 'skipped';
    document.body.append(this.notice);
    this.animation = this.notice.animate([
      // Keep fade timing independent of the fully visible pause.
      { opacity: 0, offset: 0, easing: 'ease-out' },
      { opacity: 1, offset: 100 / 1300 },
      { opacity: 1, offset: 1200 / 1300, easing: 'ease-in' },
      { opacity: 0, offset: 1 }
    ], { duration: 1300, easing: 'linear' });
    this.animation.onfinish = () => this.notice.remove();
  }
  destroy() { this.animation?.cancel(); this.notice.remove(); }
});

function selectNextOccurrence(view, skipCurrent = false) {
  const { state } = view;
  const main = state.selection.main;
  if (main.empty) {
    if (skipCurrent) return true;
    const word = state.wordAt(main.head);
    if (word) view.dispatch({ selection: EditorSelection.create([word]), scrollIntoView: true });
    return true;
  }
  const text = state.doc.toString(), query = text.slice(main.from, main.to);
  for (const [start, end] of [[main.to, text.length], [0, main.from]]) {
    let position = text.indexOf(query, start);
    while (position >= 0 && position + query.length <= end) {
      const to = position + query.length;
      if (!state.selection.ranges.some(range => position < range.to && to > range.from)) {
        const next = EditorSelection.range(position, to);
        const kept = state.selection.ranges.filter(range => range !== main);
        view.dispatch({
          selection: skipCurrent
            ? EditorSelection.create([...kept, next], kept.length)
            : state.selection.addRange(next),
          effects: [EditorView.scrollIntoView(next, { y: 'center' }), ...(skipCurrent ? [skippedEffect.of(null)] : [])], userEvent: 'select'
        });
        return true;
      }
      position = text.indexOf(query, position + 1);
    }
  }
  return true;
}

function selectedSpaceDecorations(view) {
  const marks = [];
  for (const selection of view.state.selection.ranges) {
    if (selection.empty && selection !== view.state.selection.main &&
        view.visibleRanges.some(range => selection.head >= range.from && selection.head <= range.to)) {
      marks.push(extraCursor.range(selection.head));
    }
    for (const visible of view.visibleRanges) {
      const from = Math.max(selection.from, visible.from);
      const to = Math.min(selection.to, visible.to);
      if (from >= to) continue;
      // Keep the main selection native; only paint additional selections.
      if (selection !== view.state.selection.main) marks.push(secondarySelection.range(from, to));
      const text = view.state.doc.sliceString(from, to);
      for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ') marks.push(selectedSpace.range(from + i, from + i + 1));
      }
    }
  }
  return Decoration.set(marks, true);
}
const selectedSpaces = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = selectedSpaceDecorations(view); }
  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = selectedSpaceDecorations(update.view);
    }
  }
}, { decorations: plugin => plugin.decorations });

// Leave two visible lines at maximum scroll, adapting to the editor's height.
const scrollTail = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.measure = {
      read: () => Math.max(0, view.scrollDOM.clientHeight - view.defaultLineHeight * 2 - view.documentPadding.top),
      write: height => {
        const value = `${height}px`;
        if (view.dom.style.getPropertyValue('--epic-scroll-tail') !== value) {
          view.dom.style.setProperty('--epic-scroll-tail', value);
        }
      }
    };
    this.observer = new ResizeObserver(() => view.requestMeasure(this.measure));
    this.observer.observe(view.scrollDOM);
    view.requestMeasure(this.measure);
  }
  update(update) {
    if (update.geometryChanged) this.view.requestMeasure(this.measure);
  }
  destroy() { this.observer.disconnect(); }
});

function syntaxDecorations(doc) {
  const tokens = epicSyntax(doc.toString());
  return Decoration.set([
    ...tokens.lines.map(line => Decoration.line({ class: line.className }).range(line.from)),
    ...tokens.marks.map(mark => Decoration.mark({ class: mark.className }).range(mark.from, mark.to))
  ], true);
}
const syntax = StateField.define({
  create: state => syntaxDecorations(state.doc),
  update: (value, transaction) => transaction.docChanged ? syntaxDecorations(transaction.state.doc) : value,
  provide: field => EditorView.decorations.from(field)
});
const flashEffect = StateEffect.define();
const flash = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(flashEffect)) continue;
      const ranges = [];
      if (effect.value) {
        const { start, end } = effect.value;
        for (let number = start + 1; number <= Math.min(end + 1, transaction.state.doc.lines); number++) {
          ranges.push(Decoration.line({ class: 'cm-epic-flash' }).range(transaction.state.doc.line(number).from));
        }
      }
      value = Decoration.set(ranges);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

export function create(parent) {
  const events = new EventTarget();
  const keyHandlers = [];
  const ghost = new Compartment();
  let pendingInput = false, lastInputType = '', flashTimer, ghostText = '', documentVersion = 0;
  // Application callbacks may themselves edit (e.g. header correction). Run after
  // CodeMirror finishes its update, and coalesce synchronous programmatic edits.
  const notifyInput = type => {
    lastInputType = type;
    if (pendingInput) return;
    pendingInput = true;
    queueMicrotask(() => {
      pendingInput = false;
      events.dispatchEvent(new InputEvent('input', { inputType: lastInputType }));
    });
  };
  const extensions = [
    history(), syntax, flash, scrollTail, selectedSpaces, skipNotice, EditorView.lineWrapping,
    // Follow typing (including wrapping, Enter, and paste) with breathing room
    // below the caret. Background/programmatic replacements retain their scroll.
    EditorState.transactionExtender.of(transaction => {
      if (!transaction.docChanged || !transaction.isUserEvent('input') || transaction.isUserEvent('input.replace')) return null;
      return { effects: EditorView.scrollIntoView(transaction.newSelection.main.head, { y: 'nearest', yMargin: 100 }) };
    }),
    EditorState.allowMultipleSelections.of(true),
    EditorView.contentAttributes.of({ 'aria-label': 'EPIC song editor', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    Prec.highest(EditorView.domEventHandlers({
      keydown(event) {
        for (const handler of keyHandlers) handler(event);
        if (event.defaultPrevented && (event.key === 'Tab' || event.key === 'Enter') && view.hasFocus) {
          view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 100 }) });
        }
        return event.defaultPrevented;
      }
    })),
    keymap.of([{ key: 'Mod-l', run: selectLine }, { key: 'Mod-d', run: selectNextOccurrence }, { key: 'Mod-k', run: view => selectNextOccurrence(view, true) }, { key: 'Meta-8', run: cycleEmphasis }, { key: 'Tab', run: insertTabSpaces }, ...historyKeymap, ...defaultKeymap]),
    ghost.of(placeholder('')),
    EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      const userEvent = update.transactions.map(tr => tr.annotation(Transaction.userEvent)).find(Boolean) || 'input';
      notifyInput(userEvent === 'undo' ? 'historyUndo' : userEvent === 'redo' ? 'historyRedo' : 'insertText');
    }),
    EditorView.theme({
      '&': { height: '100%', backgroundColor: '#050505', color: '#f4f4f4', fontSize: '13px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono-font)', lineHeight: '19px' },
      '.cm-content': { padding: '14px 0 var(--epic-scroll-tail, 116px)', caretColor: '#f4f4f4' },
      '.cm-line': { padding: '0 14px' },
      '.cm-cursor': { borderLeftColor: '#f4f4f4' },
      '.cm-extra-selection': { backgroundColor: '#315d8d' },
      '.cm-extra-cursor': { borderLeft: '1px solid #f4f4f4', marginLeft: '-1px', pointerEvents: 'none' },
      '.cm-selected-space': { position: 'relative' },
      '.cm-selected-space::after': {
        content: '""', position: 'absolute', left: '50%', top: '50%',
        width: '2px', height: '2px', borderRadius: '50%',
        backgroundColor: 'currentColor', transform: 'translate(-50%, -50%)',
        pointerEvents: 'none'
      },
      // Keep the multiline hint out of the empty line's layout. Otherwise the
      // native caret grows to the height of the entire placeholder widget.
      '.cm-line:has(.cm-placeholder)': { position: 'relative' },
      '.cm-placeholder': {
        position: 'absolute', top: '0', left: '14px', right: '14px',
        color: '#777', opacity: '.55', whiteSpace: 'pre-wrap'
      }
    }, { dark: true })
  ];
  const view = new EditorView({ state: EditorState.create({ extensions }), parent });
  return {
    view,
    get value() { return view.state.doc.toString(); },
    set value(text) {
      const changes = textChange(view.state.doc.toString(), String(text));
      if (changes) view.dispatch({ changes, annotations: [Transaction.userEvent.of('input.replace'), isolateHistory.of('full')] });
    },
    // File loads must reset history even when the new file has identical text.
    load(text) {
      documentVersion++;
      clearTimeout(flashTimer);
      view.setState(EditorState.create({ doc: String(text), extensions }));
      if (ghostText) view.dispatch({ effects: ghost.reconfigure(placeholder(ghostText)) });
      view.scrollDOM.scrollTop = 0;
      notifyInput('insertReplacementText');
    },
    capture() {
      return { state: view.state, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft };
    },
    restore(snapshot) {
      const version = ++documentVersion;
      clearTimeout(flashTimer);
      view.setState(snapshot.state);
      view.dispatch({ effects: flashEffect.of(null) });
      view.requestMeasure({
        read: () => null,
        write: () => {
          if (version !== documentVersion) return;
          view.scrollDOM.scrollTop = snapshot.scrollTop;
          view.scrollDOM.scrollLeft = snapshot.scrollLeft;
        }
      });
      notifyInput('insertReplacementText');
    },
    // Apply a document-level command as one CodeMirror history event.
    applyDocumentEdit(changes, cursor) {
      if (view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
      view.dispatch({
        changes,
        selection: { anchor: cursor },
        annotations: [Transaction.userEvent.of('input.splitSelection'), isolateHistory.of('full')],
        scrollIntoView: true
      });
      return true;
    },
    get selectionStart() { return view.state.selection.main.from; },
    get selectionEnd() { return view.state.selection.main.to; },
    setSelectionRange(start, end = start) {
      const clamp = value => Math.max(0, Math.min(value, view.state.doc.length));
      view.dispatch({ selection: { anchor: clamp(start), head: clamp(end) } });
    },
    get scrollTop() { return view.scrollDOM.scrollTop; },
    set scrollTop(value) { view.scrollDOM.scrollTop = value; },
    get hasFocus() { return view.hasFocus; },
    get disabled() { return view.state.readOnly; },
    get offsetParent() { return view.dom.offsetParent; },
    focus() { view.focus(); },
    blur() { view.contentDOM.blur(); },
    undo() { return undo(view); },
    redo() { return redo(view); },
    addEventListener(type, callback) {
      if (type === 'input') events.addEventListener(type, callback);
      else if (type === 'keydown') keyHandlers.push(callback);
      else if (type === 'scroll') view.scrollDOM.addEventListener(type, callback);
      // Record pasted timestamp positions before CodeMirror inserts the text.
      else if (type === 'paste') view.contentDOM.addEventListener(type, callback, true);
      else view.contentDOM.addEventListener(type, callback);
    },
    setPlaceholder(text) {
      ghostText = text;
      view.dispatch({ effects: ghost.reconfigure(placeholder(text)) });
    },
    scrollToLine(index) {
      const line = view.state.doc.line(Math.max(1, Math.min(index + 1, view.state.doc.lines)));
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    },
    lineIndexAtClientY(clientY) {
      const rect = view.scrollDOM.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) return null;
      const height = clientY - view.documentTop;
      if (height < 0 || height >= view.contentHeight) return null;
      return view.state.doc.lineAt(view.lineBlockAtHeight(height).from).number - 1;
    },
    flashLines(start, end, duration = 1400) {
      clearTimeout(flashTimer);
      view.dispatch({ effects: flashEffect.of({ start, end }) });
      flashTimer = setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), duration);
    },
    destroy() { clearTimeout(flashTimer); view.destroy(); }
  };
}

window.EpicEditor = { create };
