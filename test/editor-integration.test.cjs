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
      assert.equal(await read(), text, 'Trigger does not expand inside ordinary text');
    }

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
    await page.locator('.emo-recipe').filter({ hasText: 'energetic' }).click();
    assert.ok((await read()).includes('[Verse {{energetic}}]'));
    await page.locator('[data-action="cancel"]').click();
    assert.equal(await read(), song, 'Recipe Cancel restores original text');
    await page.evaluate(() => openEmotiveRecipeDialog(7));
    await page.locator('.emo-recipe').filter({ hasText: 'energetic' }).click();
    await page.locator('.emo-footer [data-action="close"]').click();
    assert.ok((await read()).includes('[Verse {{energetic}}]'));
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
    const beforeHelp = await read();
    await page.evaluate(() => editor.focus());
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('shortcuts:show'));
    await page.waitForSelector('#shortcutHelp[open]');
    assert.ok(await page.locator('#shortcutHelp').innerText().then(text => text.includes('gen → Tab') && text.includes('[Generation]\nStyles:')));
    const drawerWasOpen = await page.evaluate(() => tocDrawer.classList.contains('open'));
    await page.keyboard.press('n');
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
