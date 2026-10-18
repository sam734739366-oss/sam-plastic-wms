const { shell } = require('electron');
const backup = require('../backup');

module.exports = function register(ipcMain) {
  ipcMain.handle('backup:now', () => backup.createBackup());
  ipcMain.handle('backup:list', () => backup.listBackups());
  ipcMain.handle('backup:openFolder', () => shell.openPath(backup.backupsDir()));
  ipcMain.handle('backup:restore', (e, filePath) => backup.restoreBackup(filePath));
};
