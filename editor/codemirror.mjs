import { EditorState, StateEffect, StateField, Compartment, Prec, Transaction } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, keymap, placeholder } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, undo, redo, isolateHistory } from '@codemirror/commands';
import { epicSyntax, textChange } from './epic-syntax.mjs';

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
  let pendingInput = false, lastInputType = '', flashTimer, ghostText = '';
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
    history(), syntax, flash, scrollTail, EditorView.lineWrapping,
    // Follow typing (including wrapping, Enter, and paste) with breathing room
    // below the caret. Background/programmatic replacements retain their scroll.
    EditorState.transactionExtender.of(transaction => {
      if (!transaction.docChanged || !transaction.isUserEvent('input') || transaction.isUserEvent('input.replace')) return null;
      return { effects: EditorView.scrollIntoView(transaction.newSelection.main.head, { y: 'nearest', yMargin: 100 }) };
    }),
    EditorState.allowMultipleSelections.of(false),
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
    keymap.of([...historyKeymap, ...defaultKeymap]),
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
      clearTimeout(flashTimer);
      view.setState(EditorState.create({ doc: String(text), extensions }));
      if (ghostText) view.dispatch({ effects: ghost.reconfigure(placeholder(ghostText)) });
      view.scrollDOM.scrollTop = 0;
      notifyInput('insertReplacementText');
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
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 40 }) });
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
