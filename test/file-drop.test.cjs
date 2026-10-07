const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readOpenFile } = require('../lib/open-file.cjs');

(async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-drop-test-'));
  const alpha = path.join(userData, 'Alpha.EPIC');
  const beta = path.join(userData, 'Beta.md');
  const unsupported = path.join(userData, 'Nope.pdf');
  const audio = path.join(userData, 'Audio.wav');
  await Promise.all([fs.writeFile(alpha, '[Verse]\nAlpha'), fs.writeFile(beta, '[Chorus]\nBeta'), fs.writeFile(unsupported, 'Not supported'), fs.writeFile(audio, 'Test audio placeholder')]);
  assert.equal((await readOpenFile(alpha)).text, '[Verse]\nAlpha');
  await assert.rejects(readOpenFile(unsupported), /Unsupported/);
  await assert.rejects(readOpenFile('relative.epic'), /local file path/);
  await assert.rejects(readOpenFile(path.join(userData, 'missing.epic')), /ENOENT/);
  const directory = path.join(userData, 'Folder.epic'); await fs.mkdir(directory);
  await assert.rejects(readOpenFile(directory), /not folders/);
  const env = { ...process.env, EPIC_TEST_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [path.join(__dirname, 'editor-electron-main.cjs')], env });
  try {
    const page = await application.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('.cm-content');
    const url = page.url();
    await page.evaluate(() => { editor.value = '[Verse]\nUnsaved draft'; saveSessionState(); });
    const draftId = await page.evaluate(() => activeFileTabId);
    await page.evaluate(() => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'dropTestFiles'; input.hidden = true; document.body.append(input);
    });
    const drop = async files => {
      await page.locator('#dropTestFiles').setInputFiles(files);
      const prevented = await page.evaluate(() => {
        const transfer = new DataTransfer();
        for (const file of document.getElementById('dropTestFiles').files) transfer.items.add(file);
        const target = document.querySelector('.cm-content');
        target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
        target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
        const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
        target.dispatchEvent(event); return event.defaultPrevented;
      });
      assert.equal(prevented, true, 'File drop is intercepted before editor insertion or navigation');
      await page.waitForFunction(() => fileOperationDepth === 0);
    };
    await drop([alpha, unsupported, beta, audio]);
    assert.equal(await page.locator('.file-tab').count(), 4);
    assert.equal(page.url(), url);
    assert.equal(await page.evaluate(() => currentFilePath), audio);
    assert.equal(await page.evaluate(() => editor.value), '[Verse]\nAudio test');
    assert.ok((await page.locator('#status').innerText()).includes('Nope.pdf'));
    assert.equal(await page.evaluate(() => document.body.classList.contains('file-drop-active')), false);
    await page.evaluate(id => activateFileTab(id), draftId);
    assert.equal(await page.evaluate(() => editor.value), '[Verse]\nUnsaved draft');
    await drop([alpha]);
    await page.evaluate(() => { editor.value += ' modified'; saveSessionState(); });
    await drop([beta, alpha]);
    assert.equal(await page.locator('.file-tab').count(), 4, 'Duplicate drops do not create duplicate tabs');
    assert.equal(await page.evaluate(() => editor.value), '[Verse]\nAlpha modified', 'Duplicate drop preserves unsaved edits');
    assert.equal(await page.locator('#confirmModal:not(.hidden)').count(), 0);
    assert.deepEqual(errors, []);
    console.log('File drops passed: native paths, multiple files, audio, unsupported/folder/missing rejection, existing tabs, unsaved edits, and navigation prevention.');
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
