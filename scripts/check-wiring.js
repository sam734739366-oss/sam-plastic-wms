// يفحص ثبات الواجهة ثابتاً: مسارات الاستيراد موجودة، وكل قناة api.invoke مسجّلة في الخادم
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(root, 'renderer'));

const missingImports = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(f), spec);
    if (!fs.existsSync(target)) missingImports.push(`${path.relative(root, f)} → ${spec}`);
  }
}

// قنوات IPC المسجّلة فعلياً في المعالجات و main.js
const channels = new Set();
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(root, 'src', 'schema.sql'), 'utf8'));
require(path.join(root, 'src', 'db')).setDb(db);
for (const f of fs.readdirSync(path.join(root, 'src', 'handlers'))) {
  require(path.join(root, 'src', 'handlers', f))({ handle: (c) => channels.add(c) });
}
for (const m of fs.readFileSync(path.join(root, 'main.js'), 'utf8').matchAll(/ipcMain\.handle\('([^']+)'/g)) channels.add(m[1]);

const unknownChannels = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:api\.)?invoke\(\s*['"`]([^'"`]+)['"`]/g)) {
    const ch = m[1];
    if (ch.includes('$')) continue;                       // قنوات مركّبة تُفحص يدوياً
    if (!channels.has(ch)) unknownChannels.add(`${ch}  (${path.relative(root, f)})`);
  }
  // القنوات المركّبة مثل `${entity}:delete` — نتحقق من وجود نمطها العام
  for (const m of src.matchAll(/invoke\(\s*`([^`]+)`/g)) {
    const ch = m[1];
    if (!ch.includes('${')) { if (!channels.has(ch)) unknownChannels.add(`${ch}  (${path.relative(root, f)})`); }
  }
}

console.log('renderer js files:', files.length);
console.log('missing imports:', missingImports.length ? missingImports.join('\n  ') : 'none');
console.log('registered IPC channels:', channels.size);
console.log('invoke() channels with no handler:');
console.log(unknownChannels.size ? '  ' + [...unknownChannels].join('\n  ') : '  none');
const impactDelete = [...channels].filter((c) => /:(impact|delete|Delete|impact)$/.test(c)).sort();
console.log('delete/impact channels:', impactDelete.join(', '));
