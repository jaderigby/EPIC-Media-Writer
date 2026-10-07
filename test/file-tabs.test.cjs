const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-tabs-test-'));
  const env = { ...process.env, EPIC_TEST_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [path.join(__dirname, 'editor-electron-main.cjs')], env });
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForSelector('.cm-content');
    const text = () => page.evaluate(() => editor.value);
    const tab = name => page.locator('.file-tab-select').filter({ hasText: name });
    const open = async (filePath, text, metadata = null) => {
      await application.evaluate((_, file) => global.setNextFile(file), metadata
        ? { filePath, kind: 'audio', epicx: text, metadata }
        : { filePath, kind: 'text', text });
      await page.locator('#openBtn').click();
      await page.waitForFunction(filePath => currentFilePath === filePath && fileOperationDepth === 0, filePath);
    };
    const typeAtEnd = async value => {
      await page.evaluate(() => { editor.focus(); editor.setSelectionRange(editor.value.length); });
      await page.keyboard.type(value);
    };
    const originalA = '[Verse]\n' + Array.from({ length: 100 }, (_, i) => `Lyric ${i}`).join('\n');
    if (process.env.EPIC_ACTION_CHECK) {
      const headerBottom = () => page.locator('header').evaluate(el => el.getBoundingClientRect().bottom);
      const initialBottom = await headerBottom();
      assert.equal(await page.locator('#openBtn').getAttribute('aria-label'), 'Open Media');
      assert.equal(await page.locator('#newFileTab').isVisible(), false);
      await page.locator('.cm-content').fill('Draft');
      await page.waitForFunction(() => openBtn.classList.contains('is-add'));
      assert.equal(await page.locator('#openBtn').getAttribute('aria-label'), 'Open another document');
      assert.equal(await page.locator('#newFileTab').isVisible(), false);
      assert.equal(await headerBottom(), initialBottom);
      await application.evaluate(() => global.setNextFile({ filePath: '/test/Added.epic', kind: 'text', text: '[Verse]\nExisting document' }));
      await page.locator('#openBtn').click();
      assert.equal(await text(), '[Verse]\nExisting document', 'Header plus opens an existing document');
      assert.equal(await page.locator('.file-tab').count(), 2);
      assert.equal(await page.locator('#openBtn').isVisible(), true);
      assert.equal(await page.locator('#newFileTab').count(), 0);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('document:new-blank'));
      await page.waitForFunction(() => fileTabs.length === 3);
      assert.equal(await page.locator('.file-tab').count(), 3);
      assert.equal(await text(), '', 'New Blank Document creates an empty document');
      await page.locator('.file-tab.is-active .file-tab-close').click();
      await page.locator('.file-tab.is-active .file-tab-close').click();
      assert.equal(await text(), 'Draft');
      assert.equal(await page.locator('#openBtn').isVisible(), true);
      assert.equal(await page.locator('#newFileTab').isVisible(), false);
      await page.locator('.cm-content').fill('');
      await page.waitForFunction(() => !openBtn.classList.contains('is-add'));
      await open('/test/Empty.epic', '');
      assert.equal(await page.locator('#openBtn').getAttribute('aria-label'), 'Open another document');
      assert.deepEqual(errors, []);
      console.log('Blank, single-document, and multi-document actions passed, including reverse transitions and opening an empty saved file.');
      return;
    }
    if (process.env.EPIC_CLOSE_CHECK) {
      await open('/test/Linked.epicx', '[Verse]\nLinked');
      await page.evaluate(() => { studioTimingLink = { session: 'test' }; updateHeaderState(); saveSessionState(); });
      await page.locator('.file-tab.is-active .file-tab-close').click();
      await page.waitForFunction(() => !currentFilePath && !studioTimingLink);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('document:new-blank'));
      await page.locator('.cm-content').click();
      await page.keyboard.type('Still editable');
      assert.equal(await text(), 'Still editable');
      await open('/test/Reopened.epic', '[Verse]\nReopened');
      await page.reload();
      await page.waitForSelector('.cm-content');
      await page.locator('.file-tab.is-active .file-tab-close').click();
      await page.locator('#studioTimingLinkButton').click();
      await open('/test/Again.epic', '[Verse]\nAgain');
      assert.deepEqual(errors, []);
      console.log('Close-last-linked-tab, editing, reopening, and reload passed.');
      return;
    }
    await open('/test/Alpha.epic', originalA);
    assert.equal(await page.locator('.file-tab').count(), 1, 'First file replaces pristine initial tab');
    const headerLayout = () => page.evaluate(() => {
      const button = document.querySelector('#clearSessionBtn').getBoundingClientRect();
      const icon = document.querySelector('#clearSessionBtn .icon').getBoundingClientRect();
      return {
        tabTop: document.querySelector('#fileTabBar').getBoundingClientRect().top,
        iconOffsetX: icon.x + icon.width / 2 - button.x - button.width / 2,
        iconOffsetY: icon.y + icon.height / 2 - button.y - button.height / 2,
      };
    });
    const savedLayout = await headerLayout();
    assert.equal(savedLayout.iconOffsetX, 0, 'Close icon is horizontally centered');
    assert.equal(savedLayout.iconOffsetY, 0, 'Close icon is vertically centered');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('document:new-blank'));
    assert.equal((await headerLayout()).tabTop, savedLayout.tabTop, 'Untitled tab preserves header height');
    await page.locator('.file-tab.is-active .file-tab-close').click();
    if (process.env.EPIC_HEADER_CHECK) {
      console.log(await page.evaluate(() => Object.fromEntries(['header', '#openBtn', '#sessionInfo', '#fileTabBar'].map(selector => {
        const el = document.querySelector(selector), css = getComputedStyle(el), rect = el.getBoundingClientRect();
        return [selector, { top: rect.top, height: rect.height, padding: css.padding, fontSize: css.fontSize }];
      }))));
      await page.screenshot({ path: path.join(userData, 'header.png') });
      console.log(`Header alignment and tab stability passed. Screenshot: ${path.join(userData, 'header.png')}`);
      return;
    }
    await typeAtEnd(' A edit');
    await page.evaluate(() => { emotiveSessionRecipes.push(['open']); editor.setSelectionRange(10); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => { editor.scrollTop = 350; });
    await open('/test/Beta.epic', '[Chorus]\nBeta');
    assert.equal(await page.locator('.file-tab').count(), 2);
    assert.equal(await page.locator('#confirmModal:not(.hidden)').count(), 0, 'Opening a second file keeps unsaved first file without prompting');
    assert.equal(await page.evaluate(() => editor.undo()), false);
    await typeAtEnd(' B edit');
    await page.evaluate(() => emotiveSessionRecipes.push(['swell']));
    await tab('Alpha').click();
    assert.equal(await text(), originalA + ' A edit');
    assert.equal(await page.evaluate(() => editor.selectionStart), 10);
    await page.waitForFunction(() => Math.abs(editor.scrollTop - 350) < 2);
    assert.deepEqual(await page.evaluate(() => emotiveSessionRecipes), [['open']]);
    assert.equal(await page.evaluate(() => editor.undo()), true);
    assert.equal(await text(), originalA);
    await page.evaluate(() => editor.redo());
    assert.equal(await text(), originalA + ' A edit');
    await tab('Beta').click();
    assert.equal(await text(), '[Chorus]\nBeta B edit');
    assert.deepEqual(await page.evaluate(() => emotiveSessionRecipes), [['swell']]);
    await page.evaluate(() => editor.undo());
    assert.equal(await text(), '[Chorus]\nBeta');
    await page.evaluate(() => editor.redo());
    // A duplicate open activates the edited document, not its disk contents.
    await open('/test/Alpha.epic', 'Stale disk contents');
    assert.equal(await page.locator('.file-tab').count(), 2);
    assert.equal(await text(), originalA + ' A edit');
    await page.evaluate(() => performSave());
    assert.deepEqual(await application.evaluate(() => global.lastSave), { filePath: '/test/Alpha.epic', text: originalA + ' A edit' });
    assert.ok(!(await tab('Alpha').innerText()).includes('•'));
    assert.ok((await tab('Beta').innerText()).includes('•'));
    await tab('Beta').click();
    await page.getByRole('button', { name: 'Close Beta.epic', exact: true }).click();
    await page.waitForSelector('#confirmModal:not(.hidden)');
    await page.locator('#confirmModalCancelBtn').click();
    assert.equal(await page.locator('.file-tab').count(), 2);
    assert.equal(await text(), '[Chorus]\nBeta B edit');
    await page.evaluate(() => saveSessionState());
    await page.reload();
    await page.waitForSelector('.cm-content');
    assert.equal(await page.locator('.file-tab').count(), 2);
    assert.equal(await text(), '[Chorus]\nBeta B edit');
    assert.deepEqual(await page.evaluate(() => emotiveSessionRecipes), [['swell']]);
    await tab('Alpha').click();
    assert.equal(await text(), originalA + ' A edit');
    assert.deepEqual(await page.evaluate(() => emotiveSessionRecipes), [['open']]);
    await tab('Beta').click();
    await page.getByRole('button', { name: 'Close Beta.epic', exact: true }).click();
    await page.locator('#confirmModalYesBtn').click();
    await page.waitForFunction(() => fileTabs.length === 1);
    assert.equal(await text(), originalA + ' A edit');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('document:new-blank'));
    await typeAtEnd('Untitled draft');
    await tab('Alpha').click();
    await tab('Untitled').click();
    assert.equal(await text(), 'Untitled draft');
    assert.equal(await page.evaluate(() => editor.undo()), true);
    assert.equal(await text(), '');

    // Audio metadata remains attached to its tab, including an unfinished form.
    await open('/test/Audio.wav', '[Verse]\nAudio', { format: 'wav', listInfo: { INAM: 'Audio title' }, wavChunks: [] });
    await page.evaluate(() => renderMetadataEditForm(currentMetadata));
    await page.locator('#standardTitle').fill('Draft title');
    await tab('Alpha').click();
    await tab('Audio.wav').click();
    assert.equal(await page.locator('#standardTitle').inputValue(), 'Draft title');
    assert.equal(await page.evaluate(() => currentMetadata.listInfo.INAM), 'Audio title');
    await page.evaluate(() => saveSessionState());
    await page.reload();
    await page.waitForSelector('#standardTitle');
    assert.equal(await page.locator('#standardTitle').inputValue(), 'Draft title');
    await page.getByRole('button', { name: 'Close Audio.wav', exact: true }).click();
    await page.waitForSelector('#confirmModal:not(.hidden)');
    await page.locator('#confirmModalCancelBtn').click();
    await tab('Alpha').click();
    // A save remains attached to its tab; later typing is still marked unsaved.
    await typeAtEnd(' submitted');
    const submitted = await text();
    await application.evaluate(() => global.delayNextSave());
    await page.evaluate(() => { window.pendingTestSave = performSave(); });
    await page.waitForFunction(() => fileOperationDepth > 0);
    assert.equal(await tab('Audio.wav').isDisabled(), true);
    const savingTab = await page.evaluate(() => activeFileTabId);
    await page.evaluate(() => activateFileTab(fileTabs.find(tab => tab.currentFilePath === '/test/Audio.wav').id));
    assert.equal(await page.evaluate(() => activeFileTabId), savingTab);
    await typeAtEnd(' later typing');
    await application.evaluate(() => global.finishSave());
    await page.evaluate(() => window.pendingTestSave);
    assert.equal(await page.evaluate(() => sourceEditorText), submitted);
    assert.equal(await page.evaluate(() => hasUnsavedChanges()), true);
    assert.equal((await application.evaluate(() => global.lastSave)).filePath, '/test/Alpha.epic');
    assert.equal(await tab('Audio.wav').isDisabled(), false);
    await page.screenshot({ path: path.join(userData, 'tabs.png') });
    assert.deepEqual(errors, []);
    console.log('File tabs passed: independent edits, undo, scroll, recipes, duplicate open, save routing, close confirmation, drafts and restart restoration.');
    console.log(`Screenshot: ${path.join(userData, 'tabs.png')}`);
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
