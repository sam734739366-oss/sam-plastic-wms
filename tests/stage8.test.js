const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const backup = require('../src/backup');

function makeFileDb(dir) {
  const d = new DatabaseSync(path.join(dir, 'samplastic.db'));
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  return d;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sampl-'));
}

test('backup: create, list and restore roundtrip', () => {
  const dir = tmpDir();
  let d;
  try {
    d = makeFileDb(dir);
    d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن تجريبي');

    const r = backup.createBackup(d, dir);
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(r.path));
    assert.ok(r.name.includes('سام-بلاستيك-نسخة-'));

    const list = backup.listBackups(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, r.name);

    d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن مؤقت بعد النسخة');
    backup.restoreBackup(r.path, d, dir);
    d = null;

    const d2 = new DatabaseSync(path.join(dir, 'samplastic.db'));
    const rows = d2.prepare('SELECT name FROM warehouses ORDER BY id').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'مخزن تجريبي');
    d2.close();
  } finally {
    try { d && d.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup: copies to cloud folder from settings', () => {
  const dir = tmpDir();
  const cloud = tmpDir();
  let d;
  try {
    d = makeFileDb(dir);
    d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('cloud_folder', cloud);
    const r = backup.createBackup(d, dir);
    assert.ok(r.cloud_path, 'expected cloud_path');
    assert.ok(fs.existsSync(r.cloud_path));
    assert.equal(fs.readdirSync(cloud).length, 1);
  } finally {
    try { d && d.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cloud, { recursive: true, force: true });
  }
});

test('backup: ignores cloud folder when setting is empty or missing', () => {
  const dir = tmpDir();
  let d;
  try {
    d = makeFileDb(dir);
    const r = backup.createBackup(d, dir);
    assert.equal(r.cloud_path, null);
  } finally {
    try { d && d.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
