window.EpicShortcutHelp = {
  show(triggers) {
    const existing = document.getElementById('shortcutHelp');
    if (existing) { existing.querySelector('button').focus(); return; }
    const mac = window.EpicInspector?.platform === 'darwin';
    const mod = mac ? '⌘' : 'Ctrl';
    const dialog = document.createElement('dialog');
    dialog.id = 'shortcutHelp';
    dialog.setAttribute('aria-labelledby', 'shortcutHelpTitle');
    const title = document.createElement('h2');
    title.id = 'shortcutHelpTitle';
    title.textContent = 'Keyboard shortcuts & Tab triggers';
    dialog.append(title);
    const body = document.createElement('div');
    body.className = 'shortcut-help-body';
    dialog.append(body);
    const section = (heading, rows, note) => {
      const group = document.createElement('section');
      const label = document.createElement('h3'); label.textContent = heading; group.append(label);
      if (note) { const hint = document.createElement('p'); hint.textContent = note; group.append(hint); }
      const list = document.createElement('dl');
      for (const [keys, description] of rows) {
        const term = document.createElement('dt');
        const key = document.createElement('kbd'); key.textContent = keys; term.append(key);
        const detail = document.createElement('dd'); detail.textContent = description;
        list.append(term, detail);
      }
      group.append(list); body.append(group);
    };
    section('Writing', [
      [`${mod} + N`, 'New Blank Document'],
      [`${mod} + S`, 'Save'],
      [`${mod} + Shift + S`, 'Save as…'],
      [`${mod} + Z`, 'Undo'],
      [mac ? '⌘ + Shift + Z' : 'Ctrl + Y / Ctrl + Shift + Z', 'Redo'],
      [`${mod} + X / C / V`, 'Cut / copy / paste'],
      [`${mod} + A`, 'Select all'],
      [`${mod} + E`, 'Open emotive recipes for the section at the cursor, or the hovered section when the editor is unfocused'],
      [`${mod} + Shift + ;`, 'Insert the freeflow closing marker :::']
    ]);
    section('Navigation', [
      ['N', 'Open or close the Sections drawer'],
      ['T', 'Focus the song editor'],
      ['Esc', 'Leave the focused text field; close a popup when one is open']
    ], 'N and T work when you are not typing and no popup is open.');
    section('Tab triggers', [
      ...Array.from(triggers, ([key, trigger]) => [`${key} → Tab`, trigger.text +
        (trigger.cursor !== undefined ? ' — cursor inside the brackets' : '')]),
      ['& → Tab', '[{&}] — cursor inside the brackets'],
      ['Enter or Tab in [{&}…]', 'Move past the closing bracket onto the next line'],
      ['Tab in the header', 'Select the next header value, then move into the song'],
      ['Tab or Enter in an empty editor', 'Insert the suggested header']
    ], 'Type gen on its own line, then press Tab. The cursor lands after “Styles: ”.');
    section('Recipe popup', [['Enter in the recipe field', 'Add the typed recipe']]);
    const footer = document.createElement('footer');
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Done';
    close.addEventListener('click', () => dialog.close());
    footer.append(close); dialog.append(footer);
    dialog.addEventListener('close', () => dialog.remove());
    // Keep background popup key handlers from consuming Escape.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  }
};
