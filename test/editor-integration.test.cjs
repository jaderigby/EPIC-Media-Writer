const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-editor-test-'));
  const env = { ...process.env, EPIC_TEST_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [path.join(__dirname, 'editor-electron-main.cjs')], env });
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForSelector('#editor .cm-content');
    const read = () => page.evaluate(() => editor.value);
    const load = text => page.evaluate(text => { editor.load(text); sourceEditorText = text; refreshEditorView(); }, text);
    const shortcut = process.platform === 'darwin' ? 'Meta' : 'Control';
    await load('First\nSecond\nLast');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(8); });
    await page.keyboard.press(`${shortcut}+l`);
    assert.equal(await page.evaluate(() => editor.value.slice(editor.selectionStart, editor.selectionEnd)), 'Second\n', 'Cmd+L selects the whole line including its newline');
    await page.evaluate(() => editor.setSelectionRange(editor.value.length));
    await page.keyboard.press(`${shortcut}+l`);
    assert.equal(await page.evaluate(() => editor.value.slice(editor.selectionStart, editor.selectionEnd)), 'Last', 'Cmd+L selects the last line without a trailing newline');
    await load('First\nSecond\nThird\nFourth');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(8); });
    await page.keyboard.press('Alt+ArrowUp');
    assert.equal(await read(), 'Second\nFirst\nThird\nFourth', 'Option+Up moves the current line up');
    assert.equal(await page.evaluate(() => editor.selectionStart), 2, 'Caret follows the moved line');
    await page.keyboard.press('Alt+ArrowDown');
    assert.equal(await read(), 'First\nSecond\nThird\nFourth', 'Option+Down moves the current line down');
    await page.keyboard.press(`${shortcut}+z`);
    assert.equal(await read(), 'Second\nFirst\nThird\nFourth', 'Line movement is undoable');
    await load('First\nSecond\nThird\nFourth');
    await page.evaluate(() => editor.setSelectionRange(6, 18));
    await page.keyboard.press('Alt+ArrowUp');
    assert.equal(await read(), 'Second\nThird\nFirst\nFourth', 'Selected lines move together');
    await page.keyboard.press('Alt+ArrowUp');
    assert.equal(await read(), 'Second\nThird\nFirst\nFourth', 'Moving above the first line leaves text unchanged');
    await load('one one one one');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(0, 3); });
    await page.keyboard.press(`${shortcut}+d`);
    await page.keyboard.press(`${shortcut}+k`);
    assert.deepEqual(await page.evaluate(() => editor.view.state.selection.ranges.map(range => range.from)), [0, 8], 'Cmd+K skips the current match and keeps earlier selections');
    await page.keyboard.press(`${shortcut}+k`);
    assert.deepEqual(await page.evaluate(() => editor.view.state.selection.ranges.map(range => range.from)), [0, 12], 'Repeated skipping advances');
    await page.keyboard.press(`${shortcut}+k`);
    assert.deepEqual(await page.evaluate(() => editor.view.state.selection.ranges.map(range => range.from)), [0, 4], 'Skipping wraps past already selected matches');
    assert.equal(await page.locator('.epic-skip-notice').textContent(), 'skipped');
    assert.equal(await page.locator('.epic-skip-notice').count(), 1, 'Repeated skips reuse one notice');
    assert.ok(await page.locator('.epic-skip-notice').evaluate(element => {
      const box = element.getBoundingClientRect();
      return Math.abs(box.x + box.width / 2 - innerWidth / 2) < 1 &&
        Math.abs(box.y + box.height / 2 - innerHeight / 2) < 1;
    }), 'Skip notice is centered in the window');
    assert.equal(await page.evaluate(() => editor.hasFocus), true, 'Notice does not steal focus');
    await page.locator('.epic-skip-notice').waitFor({ state: 'detached' });
    await page.keyboard.type('two');
    assert.equal(await read(), 'two two one one', 'Skipped occurrences remain unchanged when typing');
    await load('echo Echo echo\necho');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(10, 14); });
    for (const count of [2, 3, 3]) {
      await page.keyboard.press(`${shortcut}+d`);
      assert.equal(await page.evaluate(() => editor.view.state.selection.ranges.length), count, 'Cmd+D adds matches, wraps, and stops when all are selected');
    }
    assert.equal(await page.locator('.cm-extra-selection').count(), 2, 'Additional selections are visible');
    await page.keyboard.type('song');
    assert.equal(await read(), 'song Echo song\nsong', 'Typing replaces every selected occurrence, case sensitively');
    assert.equal(await page.locator('.cm-extra-cursor').count(), 2, 'Additional cursors remain visible after typing');
    await page.keyboard.press(`${shortcut}+z`);
    assert.equal(await read(), 'echo Echo echo\necho', 'Undo restores all replacements together');
    await load('Sing these words aloud');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(5, 16); });
    for (const marker of ['*', '**', '']) {
      await page.keyboard.press('Meta+8');
      assert.equal(await read(), `Sing ${marker}these words${marker} aloud`, 'Cmd+8 cycles emphasis markers');
      assert.equal(await page.evaluate(() => editor.value.slice(editor.selectionStart, editor.selectionEnd)), 'these words', 'Words remain selected for cycling');
    }
    await page.keyboard.press(`${shortcut}+z`);
    assert.equal(await read(), 'Sing **these words** aloud', 'Each cycle is independently undoable');
    await page.keyboard.press(`${shortcut}+Shift+z`);
    assert.equal(await read(), 'Sing these words aloud');
    for (const [input, output] of [['*words*', '**words**'], ['**words**', 'words']]) {
      await load(input);
      await page.evaluate(() => editor.setSelectionRange(0, editor.value.length));
      await page.keyboard.press('Meta+8');
      assert.equal(await read(), output, 'Selections including markers also cycle');
    }
    await page.evaluate(() => editor.setSelectionRange(2));
    await page.keyboard.press('Meta+8');
    assert.equal(await read(), 'words', 'An empty selection is unchanged');
    await load('');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Tab');
    assert.match(await read(), /^---\nTitle: Untitled/);
    assert.equal(await page.evaluate(() => editor.value.slice(editor.selectionStart, editor.selectionEnd)), 'Untitled');
    await page.keyboard.type('CodeMirror Song');
    assert.match(await read(), /Title: CodeMirror Song/);
    await page.keyboard.press(`${shortcut}+z`);
    assert.match(await read(), /Title: Untitled/);
    await page.keyboard.press(`${shortcut}+Shift+z`);
    assert.match(await read(), /Title: CodeMirror Song/);

    await load('[Verse]\nOriginal');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(editor.value.length); });
    await page.keyboard.type(' lyric');
    await page.evaluate(() => replaceEditorText(editor.value.replace('Verse', 'Chorus')));
    await page.keyboard.press(`${shortcut}+z`);
    assert.equal(await read(), '[Verse]\nOriginal lyric', 'Undo programmatic edit independently of typing');
    await page.keyboard.press(`${shortcut}+z`);
    assert.equal(await read(), '[Verse]\nOriginal', 'Typing shares CodeMirror history');
    await page.keyboard.press(`${shortcut}+Shift+z`);
    assert.equal(await read(), '[Verse]\nOriginal lyric');
    await load('[Other song]');
    assert.equal(await page.evaluate(() => editor.undo()), false, 'New song has no previous undo history');
    assert.equal(await read(), '[Other song]');

    await load('');
    await page.evaluate(() => editor.focus());
    await page.keyboard.type('gen');
    await page.keyboard.press('Tab');
    assert.equal(await read(), '[Generation]\nStyles: ');
    assert.equal(await page.evaluate(() => editor.selectionStart), '[Generation]\nStyles: '.length);
    await page.keyboard.press(`${shortcut}+z`);
    assert.equal(await read(), 'gen', 'Trigger expansion is one undo step');
    await page.keyboard.press(`${shortcut}+Shift+z`);
    assert.equal(await read(), '[Generation]\nStyles: ');
    for (const text of ['oxygen', 'a gen', 'genesis']) {
      await load(text);
      await page.evaluate(() => { editor.focus(); editor.setSelectionRange(editor.value.length); });
      await page.keyboard.press('Tab');
      assert.equal(await read(), text + '    ', 'Ordinary Tab inserts four spaces without expanding triggers');
      assert.equal(await page.evaluate(() => editor.hasFocus), true, 'Tab keeps editor focus');
      await page.keyboard.press(`${shortcut}+z`);
      assert.equal(await read(), text, 'Tab insertion is undoable');
    }

    await load('a  b\n c ');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(1, 7); });
    assert.equal(await page.locator('.cm-selected-space').count(), 3, 'Only selected spaces have dots, across lines');
    assert.ok(await page.locator('.cm-selected-space').first().evaluate(element =>
      Math.abs(parseFloat(getComputedStyle(element, '::after').top) - element.getBoundingClientRect().height / 2) < 1
    ), 'Dots are vertically centered');
    assert.equal(await read(), 'a  b\n c ', 'Dots do not alter the document');
    await page.keyboard.press('Tab');
    assert.equal(await read(), 'a     ', 'Tab replaces selected text with four spaces');
    assert.equal(await page.locator('.cm-selected-space').count(), 0, 'Dots disappear when selection collapses');
    await page.keyboard.press(`${shortcut}+z`);
    assert.equal(await read(), 'a  b\n c ', 'Undo restores replaced selection text');

    for (const exitKey of ['Enter', 'Tab']) {
      await load('');
      await page.evaluate(() => editor.focus());
      await page.keyboard.type('ff');
      await page.keyboard.press('Tab');
      assert.equal(await read(), '[{&}]');
      assert.equal(await page.evaluate(() => editor.selectionStart), 4);
      await page.keyboard.type('Freeflow');
      await page.keyboard.press(exitKey);
      assert.equal(await read(), '[{&}Freeflow]\n');
      assert.equal(await page.evaluate(() => editor.selectionStart), '[{&}Freeflow]\n'.length);
    }
    await load('ff\nExisting line');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(2); });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    assert.equal(await read(), '[{&}]\nExisting line', 'Reuse the next line without inserting a duplicate newline');
    assert.equal(await page.evaluate(() => editor.selectionStart), 6);

    await load('&');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(1); });
    await page.keyboard.press('Tab');
    assert.equal(await read(), '[{&}]');
    await page.keyboard.press('Tab');
    assert.equal(await read(), '[{&}]\n');
    await page.keyboard.press(`${shortcut}+Shift+Semicolon`);
    assert.equal(await read(), '[{&}]\n:::\n');

    // Paste is observed before insertion, preserving the duplicate-timestamp index.
    await load('1\n00:01.000\n[Verse]\nLyric\n\n');
    await page.evaluate(() => {
      pendingAddedEpicxTimestamps = [];
      editor.focus(); editor.setSelectionRange(editor.value.length);
      const data = new DataTransfer(); data.setData('text/plain', '2\n00:01.000\n[Chorus]\nPasted');
      editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    assert.ok((await read()).endsWith('[Chorus]\nPasted'));
    assert.deepEqual(await page.evaluate(() => pendingAddedEpicxTimestamps), [{ timestamp: '00:01.000', occurrence: 1 }]);
    await page.keyboard.press(`${shortcut}+z`);
    assert.ok(!(await read()).includes('Pasted'), 'Paste is undoable');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('editor-history:action', 'redo'));
    await page.waitForFunction(() => editor.value.includes('Pasted'));

    const song = '---\nTitle: Test\nAuthor: Writer\n---\n\n1\n00:01.000\n[Verse {{open}}]\n' + 'A wrapped lyric line '.repeat(90) + '\n\n2\n00:02.000\n[Chorus {{energetic}}]\n**Strong** and *soft*, `code`, [link](https://example.com)\n';
    await load(song);
    assert.ok(await page.locator('.epic-header').count());
    assert.ok(await page.locator('.epic-time').count());
    assert.ok(await page.locator('.epic-instruction').count());
    await page.evaluate(() => { tocDrawer.classList.add('open'); renderSectionToc(); });
    await page.locator('.toc-item').filter({ hasText: 'Chorus' }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => getEditorCaretLineIndex()), 12, 'Drawer uses logical lines despite wrapping');
    assert.ok(await page.locator('.cm-epic-flash').count());
    const lyric = page.locator('.cm-line').filter({ hasText: '**Strong**' });
    assert.ok(await lyric.isVisible());
    const box = await lyric.boundingBox();
    assert.equal(await page.evaluate(y => editor.lineIndexAtClientY(y), box.y + box.height / 2), 13);

    await page.evaluate(() => openEmotiveRecipeDialog(7));
    assert.equal(await page.locator('.emo-footer button').count(), 0, 'No footer actions before assignment changes');
    await page.locator('.emo-recipe').filter({ hasText: 'energetic' }).click();
    assert.ok((await read()).includes('[Verse {{energetic}}]'));
    await page.locator('[data-action="undo-recipe"]').click();
    assert.equal(await read(), song, 'Recipe Undo restores the original assignment');
    assert.equal(await page.locator('.emo-dialog').count(), 1, 'Undo keeps the panel open');
    assert.equal(await page.locator('.emo-footer button').count(), 0, 'Undo disappears after restoring the assignment');
    await page.keyboard.press('Escape');
    await page.evaluate(() => openEmotiveRecipeDialog(7));
    await page.locator('.emo-recipe').filter({ hasText: 'energetic' }).click();
    await page.locator('.emo-header [data-action="close"]').click();
    assert.ok((await read()).includes('[Verse {{energetic}}]'));
    await page.evaluate(() => openEmotiveRecipeDialog(7));
    await page.locator('[data-action="remove-section-recipe"]').click();
    assert.equal(await page.locator('[data-action="undo-recipe"]').count(), 1, 'Removing the assignment offers Undo');
    await page.locator('[data-action="undo-recipe"]').focus();
    await page.keyboard.press(`${shortcut}+z`);
    await page.waitForFunction(() => document.querySelector('.emo-recipe[aria-current="true"]')?.textContent.includes('energetic'));
    assert.equal(await page.locator('[data-action="undo-recipe"]').count(), 0, 'Keyboard undo refreshes the assignment and panel Undo state');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('editor-history:action', 'redo'));
    await page.waitForFunction(() => !document.querySelector('.emo-recipe[aria-current="true"]'));
    assert.equal(await page.locator('[data-action="undo-recipe"]').count(), 1, 'Menu redo refreshes the panel');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('editor-history:action', 'undo'));
    await page.waitForFunction(() => !!document.querySelector('.emo-recipe[aria-current="true"]'));
    await page.locator('.emo-header [data-action="close"]').focus();
    await page.keyboard.press(`${shortcut}+Shift+z`);
    await page.waitForFunction(() => !document.querySelector('.emo-recipe[aria-current="true"]'));
    await page.locator('.emo-overlay').click({ position: { x: 5, y: 5 } });
    assert.equal(await page.locator('.emo-dialog').count(), 0, 'Outside click closes the panel');
    assert.ok(!(await read()).includes('[Verse {{energetic}}]'), 'Outside dismissal retains assignment changes');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(getOffsetForLine(editor.value, 12)); });
    await page.keyboard.press(`${shortcut}+e`);
    assert.equal(await page.locator('.emo-dialog').count(), 1, 'Emotive shortcut recognizes CodeMirror focus');
    await page.keyboard.press('Escape');

    // The existing IPC file-opening path resets history and round-trips text.
    await page.evaluate(() => { sourceEditorText = editor.value; });
    await application.evaluate(() => global.setNextFile({ filePath: '/test/other.epic', kind: 'text', text: '[Bridge]\nNew song' }));
    await page.locator('#openBtn').click();
    await page.waitForFunction(() => editor.value === '[Bridge]\nNew song');
    assert.equal(await page.evaluate(() => editor.undo()), false);
    await page.evaluate(() => saveSessionState());
    await page.reload();
    await page.waitForSelector('.cm-content');
    assert.equal(await read(), '[Bridge]\nNew song', 'Session restore round-trips through CodeMirror');
    assert.equal(await page.evaluate(() => editor.undo()), false);

    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(editor.value.length); });
    await page.keyboard.type(' saved');
    await page.evaluate(() => performSave());
    assert.deepEqual(await application.evaluate(() => global.lastSave), { filePath: '/test/other.epic', text: '[Bridge]\nNew song saved' });
    assert.equal(await page.evaluate(() => hasUnsavedChanges()), false);
    await page.waitForFunction(() => validationStatusEl.textContent === 'EPIC/EPICX valid.');

    // A timing update uses the same undoable edit path, with no focus theft.
    await page.evaluate(() => {
      currentFilePath = '/test/project.epicx';
      editor.load('1\n00:01.000\n[Verse]\nWords');
      sourceEditorText = editor.value;
      receiveStudioProject({ project: { filePath: currentFilePath, session: 'test', text: '1\n00:03.000\n[Verse]\nWords' } }, { initial: true });
      stopStudioTimingPolling();
    });
    assert.ok((await read()).includes('00:03.000'));
    await page.evaluate(() => editor.undo());
    assert.ok((await read()).includes('00:01.000'), 'Studio timing merge remains undoable');
    await page.evaluate(() => { studioTimingLink = null; });

    await load('');
    await page.evaluate(() => editor.focus());
    await page.waitForSelector('.cm-placeholder');
    assert.ok(await page.locator('.cm-line:has(.cm-placeholder)').evaluate(line =>
      line.getBoundingClientRect().height <= parseFloat(getComputedStyle(line).lineHeight) + 1
    ), 'Multiline placeholder must not stretch the empty line or native caret');
    await page.screenshot({ path: path.join(userData, 'empty-editor.png') });
    await load('');
    assert.ok(await page.locator('.cm-placeholder').isVisible(), 'Placeholder survives loading another empty document');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => editor.selectionStart > editor.value.indexOf('Title:')), 'Header Tab navigation survives');

    await load(Array.from({ length: 180 }, (_, i) => i % 60 === 0 ? 'match' : `Line ${i}`).join('\n'));
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(0, 5); });
    for (const key of ['d', 'k']) {
      await page.keyboard.press(`${shortcut}+${key}`);
      await page.waitForFunction(() => {
        const view = editor.view;
        const caret = view.coordsAtPos(view.state.selection.main.head);
        const viewport = view.scrollDOM.getBoundingClientRect();
        return caret && Math.abs((caret.top + caret.bottom) / 2 - (viewport.top + viewport.bottom) / 2) < 25;
      });
    }

    const largeSong = Array.from({ length: 1500 }, (_, i) => `${i + 1}\n00:01.000\n[Verse]\nLyric ${i}\n`).join('\n');
    await load(largeSong);
    assert.equal(await read(), largeSong);
    assert.ok(await page.locator('.cm-line').count() < 500, 'Large songs use viewport rendering');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(editor.value.length); editor.scrollToLine(editor.view.state.doc.lines - 1); });
    await page.keyboard.type('End');
    assert.ok((await read()).endsWith('End'));

    await load(song.replace('A wrapped lyric line '.repeat(90), 'A wrapped lyric line '.repeat(12)) + '\n[{&}Freeflow]\nFreeform writing\n:::\n');
    await page.evaluate(() => { tocDrawer.classList.add('open'); renderSectionToc(); });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(userData, 'editor.png') });
    // Manual scrolling can bring the last two lines to the top, even after resizing.
    await load(Array.from({ length: 80 }, (_, i) => `Scroll line ${i}`).join('\n'));
    for (const height of [900, 650]) {
      await application.evaluate(({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0].setSize(1300, height), height);
      await page.waitForFunction(() => {
        const view = editor.view;
        const expected = view.scrollDOM.clientHeight - view.defaultLineHeight * 2 - view.documentPadding.top;
        return Math.abs(view.documentPadding.bottom - expected) < 2;
      });
      await page.evaluate(() => { editor.scrollTop = editor.view.scrollDOM.scrollHeight; });
      await page.waitForFunction(() => {
        const view = editor.view, secondLast = view.state.doc.line(view.state.doc.lines - 1);
        const rect = view.coordsAtPos(secondLast.from), bounds = view.scrollDOM.getBoundingClientRect();
        return rect && rect.top >= bounds.top && rect.top < bounds.top + 25;
      });
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1300, 900));

    // Typing and custom Tab/Enter commands keep the caret above the bottom edge.
    await load(Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n'));
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(editor.value.length); });
    const caretHasRoom = () => {
      const view = editor.view, caret = view.coordsAtPos(view.state.selection.main.head);
      const bounds = view.scrollDOM.getBoundingClientRect();
      return caret && caret.top >= bounds.top && caret.bottom <= bounds.bottom - 90;
    };
    for (let line = 0; line < 4; line++) {
      await page.keyboard.press('Enter');
      await page.keyboard.type('Another lyric line');
      await page.waitForFunction(caretHasRoom);
    }
    const previousScroll = await page.evaluate(() => editor.scrollTop);
    await page.keyboard.type(' wrapped words'.repeat(90));
    await page.waitForFunction(caretHasRoom);
    assert.ok(await page.evaluate(() => editor.scrollTop) > previousScroll, 'Soft wrapping scrolls automatically');
    await page.keyboard.press('Enter');
    await page.keyboard.type('gen');
    await page.keyboard.press('Tab');
    await page.waitForFunction(caretHasRoom);
    await page.keyboard.press('Enter');
    await page.keyboard.type('ff');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForFunction(caretHasRoom);
    await page.screenshot({ path: path.join(userData, 'caret-follow.png') });

    await load(song);
    const beforeHelp = await read();
    await page.evaluate(() => editor.focus());
    const beforeDrawerShortcut = await page.evaluate(() => ({ open: tocDrawer.classList.contains('open'), caret: editor.selectionStart }));
    for (const key of ['ArrowUp', 'ArrowDown']) {
      await page.keyboard.press(`Meta+Alt+${key}`);
      assert.equal(await page.evaluate(() => tocDrawer.classList.contains('open')), key === 'ArrowUp' ? !beforeDrawerShortcut.open : beforeDrawerShortcut.open, 'Both vertical shortcuts toggle the drawer');
      assert.equal(await page.evaluate(() => editor.selectionStart), beforeDrawerShortcut.caret, 'Drawer shortcut leaves caret unchanged');
      assert.equal(await page.evaluate(() => editor.hasFocus), true, 'Drawer shortcut keeps editor focus');
    }
    await page.keyboard.press('Meta+/');
    await page.waitForSelector('#shortcutHelp[open]');
    assert.ok((await page.locator('#shortcutHelp').innerText()).includes('plain → *emphasis* → **bold** → plain'), 'Help lists emphasis cycling');
    await page.keyboard.press('Meta+/');
    assert.equal(await page.locator('#shortcutHelp').count(), 1, 'Repeated help shortcut keeps a single panel');
    assert.ok(await page.locator('#shortcutHelp').innerText().then(text => text.includes('gen → Tab') && text.includes('[Generation]\nStyles:')));
    const drawerWasOpen = await page.evaluate(() => tocDrawer.classList.contains('open'));
    await page.keyboard.press('n');
    await page.keyboard.press('Meta+Alt+ArrowUp');
    assert.equal(await page.evaluate(() => tocDrawer.classList.contains('open')), drawerWasOpen, 'Help blocks background shortcuts');
    await page.screenshot({ path: path.join(userData, 'shortcuts.png') });
    await page.keyboard.press('Escape');
    await page.locator('#shortcutHelp').waitFor({ state: 'detached' });
    assert.equal(await read(), beforeHelp, 'Help leaves the song unchanged');
    assert.equal(await page.evaluate(() => editor.hasFocus), true, 'Help restores focus');
    await page.evaluate(() => openEmotiveRecipeDialog(7));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('shortcuts:show'));
    await page.waitForSelector('#shortcutHelp[open]');
    await page.keyboard.press('Escape');
    await page.locator('#shortcutHelp').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.emo-dialog').count(), 1, 'Escape closes help without dismissing the underlying recipe popup');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], 'No renderer errors');
    console.log('CodeMirror integration passed: editing, shortcuts, unified undo, file isolation, highlighting, wrapped-line navigation, recipes, paste, save, Studio updates, large songs and restore.');
    console.log(`Screenshot: ${path.join(userData, 'editor.png')}`);
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
