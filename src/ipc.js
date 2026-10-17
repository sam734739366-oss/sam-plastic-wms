const fs = require('fs');
const path = require('path');

module.exports = function registerAll(ipcMain) {
  const dir = path.join(__dirname, 'handlers');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js')) require(path.join(dir, f))(ipcMain);
  }
};
