const { shell } = require('electron');
const { getDb } = require('../db');
const { audit } = require('../audit');
const backup = require('../backup');
const legacy = require('../legacyFix');

module.exports = function register(ipcMain) {
  ipcMain.handle('backup:now', () => backup.createBackup());
  ipcMain.handle('backup:list', () => backup.listBackups());
  ipcMain.handle('backup:openFolder', () => shell.openPath(backup.backupsDir()));
  ipcMain.handle('backup:restore', (e, filePath) => backup.restoreBackup(filePath));

  // تقرير «إصلاح البيانات القديمة»: تحليل بلا كتابة — يعرض ما سيُصلح قبل أي تنفيذ
  ipcMain.handle('backup:legacyReport', () => legacy.analyze(getDb()));

  // التنفيذ: نسخة احتياطية إلزامية أولاً، ثم الخصم والحذف، ثم التحقق
  ipcMain.handle('backup:legacyFix', (e, opts, userId) => {
    const db = getDb();
    const report = legacy.analyze(db);
    if (!report.items.length) return { report, backup: null, done: { removed: 0, subtracted: 0, createdScrap: 0, skipped: [], perItem: [] }, check: legacy.verify(db, []) };
    const created = backup.createBackup(db);
    const createScrap = !(opts && opts.skipScrapDocs);
    const done = legacy.apply(db, { createScrap });
    const check = legacy.verify(db, done.perItem.map((p) => p.itemId));
    audit(db, userId, 'update', 'legacy_fix', null,
      { rows: report.rowCount, totalDefects: report.totalDefects, items: report.items.map((i) => ({ code: i.code, total: i.total })) },
      { ...done, createScrap, backup: created && created.name });
    return { report, backup: created, done, check };
  });
};
