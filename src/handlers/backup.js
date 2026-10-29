const { shell } = require('electron');
const backup = require('../backup');

// النسخ الاحتياطي: محلي في backups/ + نسخة إلى المجلد السحابي المتزامن (من الإعدادات)،
// والاستعادة من أي ملف .db في backups/.
module.exports = function register(ipcMain) {
  ipcMain.handle('backup:now', () => backup.createBackup());
  ipcMain.handle('backup:list', () => backup.listBackups());
  ipcMain.handle('backup:openFolder', () => shell.openPath(backup.backupsDir()));
  ipcMain.handle('backup:restore', (e, filePath) => backup.restoreBackup(filePath));
};
