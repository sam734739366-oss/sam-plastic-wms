const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const templates = require('./src/print/templates');
const backup = require('./src/backup');

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1366, height: 850, minWidth: 1100, minHeight: 700,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    autoHideMenuBar: true
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

const KIND_TEMPLATE = {
  purchase: templates.purchaseTemplate,
  issue: templates.issueTemplate,
  receive: templates.receiveTemplate,
  invoice: templates.invoiceTemplate,
  exit: templates.exitTemplate,
  toll_receipt: templates.tollReceiptTemplate,
  toll_delivery: templates.tollDeliveryTemplate,
  scrap: templates.scrapTemplate,
  transfer: templates.transferTemplate,
};

ipcMain.handle('print:open', (e, payload) => {
  const settings = payload.settings || {};
  const title = payload.title || 'طباعة';
  let html;
  if (payload.kind === 'report') {
    html = templates.reportTemplate(settings, title, payload.metaLines || [], payload.headers || [], payload.rows || [], payload.foot || '');
  } else {
    const tpl = KIND_TEMPLATE[payload.kind];
    if (!tpl) throw new Error('نوع مستند غير معروف للطباعة');
    html = tpl(payload.doc, settings);
  }
  const win = new BrowserWindow({
    width: 800, height: 950, parent: BrowserWindow.getFocusedWindow() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'print', 'print-preload.js'),
      contextIsolation: true, nodeIntegration: false
    },
    autoHideMenuBar: true
  });
  win.loadFile(path.join(__dirname, 'renderer', 'print', 'print.html'));
  win.webContents.on('did-finish-load', () => win.webContents.send('print:content', { html, title }));
  return { ok: true };
});

app.whenReady().then(() => {
  require('./src/db').getDb();
  require('./src/ipc')(ipcMain);
  createMainWindow();
  setInterval(() => { try { backup.createBackup(); } catch { /* ignore */ } }, 24 * 60 * 60 * 1000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('before-quit', () => { try { backup.createBackup(); } catch { /* ignore */ } });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
