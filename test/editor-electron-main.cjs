// Isolated renderer integration harness. No user files or application session are opened.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
app.setPath('userData', process.env.EPIC_TEST_USER_DATA);
app.dock?.hide();
let nextFile = null;
ipcMain.handle('open-media', () => nextFile);
ipcMain.handle('parse-epic', (_, { source }) => ({ ok: !!source, empty: !source }));
ipcMain.handle('studio-timing:update-menu-state', () => ({}));
ipcMain.handle('save-text', (_, payload) => { global.lastSave = payload; return { ...payload, saved: true }; });
global.setNextFile = file => { nextFile = file; };
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: {
    preload: path.join(__dirname, '../preload.cjs'), contextIsolation: true, nodeIntegration: false
  }});
  win.loadFile(path.join(__dirname, '../index.html'));
});
