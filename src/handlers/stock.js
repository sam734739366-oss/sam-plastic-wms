const { getDb } = require('../db');
const { getBalance } = require('../stock');

module.exports = function register(ipcMain) {
  ipcMain.handle('stock:balance', (e, itemId, warehouseId) =>
    getBalance(getDb(), itemId, warehouseId));
};
