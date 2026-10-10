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
    const tab = name => page.locator('.file-tab-select').filter({ hasText: name });
    const open = async (filePath, text, metadata = null) => {
      await application.evaluate((_, file) => global.setNextFile(file), metadata
        ? { filePath, kind: 'audio', epicx: text, metadata }
        : { filePath, kind: 'text', text });
      await page.locator('#openBtn').click();
      await page.waitForFunction(filePath => currentFilePath === filePath && fileOperationDepth === 0, filePath);
    };
    const longText = Array.from({ length: 240 }, (_, i) => `Line ${i}`).join('\n');
    const settle = () => page.waitForTimeout(150);
    await open('/test/One.epic', longText);
    await settle();
    await page.evaluate(() => { editor.scrollTop = 450; });
    await settle();
    const firstScroll = await page.evaluate(() => editor.scrollTop);
    await open('/test/Two.epic', longText);
    await settle();
    assert.ok(Math.abs(await page.evaluate(() => editor.scrollTop)) < 2, 'New document starts at top');
    await page.evaluate(() => { editor.scrollTop = 2100; });
    await settle();
    const secondScroll = await page.evaluate(() => editor.scrollTop);
    assert.ok(secondScroll > firstScroll + 1000);
    for (let i = 0; i < 3; i++) {
      await tab('One').click();
      await settle();
      assert.ok(Math.abs(await page.evaluate(() => editor.scrollTop) - firstScroll) < 2, 'First document retains its scroll position');
      await tab('Two').click();
      await settle();
      assert.ok(Math.abs(await page.evaluate(() => editor.scrollTop) - secondScroll) < 2, 'Second document retains its scroll position');
    }
    assert.deepEqual(errors, []);
    console.log('Independent tab scroll positions passed.');
    return;
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
