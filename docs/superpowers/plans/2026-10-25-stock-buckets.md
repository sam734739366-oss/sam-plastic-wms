# خطة تنفيذ: سلة (سليم/تالف/محرز) لكل بند + كليك يسار مزدوج للعرض

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** إتاحة اختيار السلة (سليم/تالف/محرز) لكل بند في كل مستندات دخول وخروج المخازن، مع ظهور السلة في التقارير والمطبوعات، وتحويل الكليك المزدوج إلى يسار للعرض فقط دون أي حفظ.

**Architecture:** عمود `bucket` جديد في جداول البنود الثمانية مع ترحيل آمن للبيانات القديمة، ودالة `applyBucketsDelta` في stock.js تجمّع الدلتا لكل زوج (صنف × سلة)، وفحوص كفاية الرصيد لكل سلة على بنود الخروج، وعمود «السلة» في شاشات المستندات وتقرير الحركة وقوالب الطباعة، وإعادة بناء `attachRowMenu` في ui.js ليعمل الكليك المزدوج الأيسر كإجراء «فتح» للعرض فقط.

**Tech Stack:** Electron + node:sqlite (DatabaseSync) + واجهة Vanilla JS (ES modules) + node:test.

**Spec:** `docs/superpowers/specs/2026-10-25-stock-buckets-design.md`

## Global Constraints

- قاعدة البيانات عبر `node:sqlite` المدمج فقط — ممنوع أي وحدات أصلية أو MSVC.
- الالتزام git حصراً عبر `git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit` برسائل عربية conventional، ودون أي تعديل على إعدادات git.
- لا تُلتَزم أبداً: `data/` و `*.tar.gz` و `.shots/`.
- ممنوع تلويث القاعدة الحية بعمليات تجريبية — الاختبارات على `:memory:` والفحص البصري على نسخة آمنة.
- الألوان: أزرق ملكي `#1e3a8a/#2450c8` وذهبي `#d9a441`، خلفيات فاتحة `#f5f7fb/#f8fafc` ونص داكن `#0f172a` — تباين صارم بين الخلفية والخط.
- أي تعديل على الصنف يمتد لكل ما يرتبط به في التقارير والمخازن (تقرير الحركة + الجرد يعتمدان على `stock_moves.bucket`).
- ملفات الواجهة ES modules — فحص الصياغة بنسخها إلى `/tmp/x.mjs` ثم `node --check`.
- أوامر Bash تبدأ دائماً بـ `cd "/c/Users/Elite/Desktop/سام بلاستيك" && export PATH="/c/Program Files/nodejs:$PATH"`.
- تسميات السلات العربية: سليم/تالف/محرز؛ القيم `salem`/`talef`/`muharraz`؛ أصناف tags في CSS: `salem`/`talef`/`muharraz`.
- تشغيل الاختبارات: `node --test tests/`.

---

### Task 1: عمود bucket في جداول البنود الثمانية + الترحيل

**Files:**
- Modify: `src/schema.sql`
- Modify: `src/db.js:18-165` (داخل migrate، قبل قسم أدوار المستخدمين)
- Test: `tests/buckets.test.js`

**Interfaces:**
- Consumes: لا شيء (أساس).
- Produces: كل جداول البنود الثمانية تحوي `bucket TEXT NOT NULL DEFAULT 'salem'` — تعتمد عليها كل المهام اللاحقة (القراءات عبر `SELECT *` ترجع الحقل تلقائياً).

- [ ] **Step 1: إضافة العمود في schema.sql**

أضف بعد سطر `notes TEXT` في كل من الجداول الثمانية السطر: `  bucket TEXT NOT NULL DEFAULT 'salem'` — الجداول: `purchase_items` (بعد سطر 92)، `issue_items` (بعد 132)، `receive_items` (بعد 175)، `exit_items` (بعد 230)، `transfer_items` (بعد 375)، `invoice_items` (بعد 204)، `sales_return_items` (بعد 324)، `purchase_return_items` (بعد 352).

مثال في `purchase_items` — يصبح آخر عمودين:

```sql
  total_price REAL,
  notes TEXT,
  bucket TEXT NOT NULL DEFAULT 'salem'
);
```

- [ ] **Step 2: إضافة كتلة الترحيل في db.js**

أدخل في `migrate(d)` قبل كتلة «أدوار المستخدمين» (قبل سطر `const userTbl = ...`):

```js
  // سلة كل بند (سليم/تالف/محرز): عمود يخزن اختيار المستخدم لكل سطر في مستندات المخازن
  const bucketTables = ['purchase_items', 'issue_items', 'receive_items', 'exit_items',
    'transfer_items', 'invoice_items', 'sales_return_items', 'purchase_return_items'];
  let hadAnyBucket = false;
  for (const t of bucketTables) {
    const cols = d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    if (!cols.includes('bucket')) {
      d.exec(`ALTER TABLE ${t} ADD COLUMN bucket TEXT NOT NULL DEFAULT 'salem'`);
    } else {
      hadAnyBucket = true;
    }
  }
  if (!hadAnyBucket) {
    // ترحيل البيانات القديمة: بنود فواتير الخردة → تالف، ومرتجع البيع يرث سلة بند فاتورته الأصلية
    d.exec(`UPDATE invoice_items SET bucket='talef'
      WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_type='scrap')`);
    d.exec(`UPDATE sales_return_items SET bucket = COALESCE(
      (SELECT ii.bucket FROM invoice_items ii
       JOIN sales_returns sr ON sr.invoice_id = ii.invoice_id
       WHERE sr.id = sales_return_items.return_id AND ii.item_id = sales_return_items.item_id
       ORDER BY ii.id LIMIT 1), 'salem')`);
  }
```

- [ ] **Step 3: كتابة اختبار الترحيل الفاشل أولاً**

أضف في `tests/buckets.test.js` بعد test «النقل بين مخزنين…»:

```js
test('ترحيل أعمدة السلة: بنود الخردة تالف ومرتجع البيع يرث سلة فاتورته', () => {
  const db = makeDb();
  for (const t of ['purchase_items', 'issue_items', 'receive_items', 'exit_items',
    'transfer_items', 'invoice_items', 'sales_return_items', 'purchase_return_items']) {
    db.exec(`ALTER TABLE ${t} DROP COLUMN bucket`);
  }
  db.prepare("INSERT INTO items (code, name, unit_name) VALUES ('901', 'علبة', 'حبة')").run();
  db.prepare("INSERT INTO warehouses (name) VALUES ('المخزن الرئيسي')").run();
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  db.prepare("INSERT INTO invoices (doc_number, doc_date, invoice_type) VALUES ('INV-1', '2026-10-25', 'sale')").run();
  db.prepare("INSERT INTO invoices (doc_number, doc_date, invoice_type) VALUES ('INV-2', '2026-10-25', 'scrap')").run();
  db.prepare(`INSERT INTO invoice_items (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg)
    VALUES (1, 1, ${wh}, 100, 'حبة', 100, 0.5)`).run();
  db.prepare(`INSERT INTO invoice_items (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg)
    VALUES (2, 1, ${wh}, 10, 'حبة', 10, 0.05)`).run();
  db.prepare("INSERT INTO sales_returns (doc_number, doc_date, invoice_id) VALUES ('R-1', '2026-10-25', 1)").run();
  db.prepare(`INSERT INTO sales_return_items (return_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg)
    VALUES (1, 1, ${wh}, 5, 'حبة', 5, 0.025)`).run();
  const { migrate } = require('../src/db');
  migrate(db);
  assert.equal(db.prepare('SELECT bucket FROM invoice_items WHERE invoice_id=1').get().bucket, 'salem');
  assert.equal(db.prepare('SELECT bucket FROM invoice_items WHERE invoice_id=2').get().bucket, 'talef');
  assert.equal(db.prepare('SELECT bucket FROM sales_return_items WHERE return_id=1').get().bucket, 'salem');
  assert.equal(db.prepare('SELECT bucket FROM purchase_items').all().length, 0);
});
```

- [ ] **Step 4: تشغيل الاختبار للتحقق من فشله**

Run: `cd "/c/Users/Elite/Desktop/سام بلاستيك" && export PATH="/c/Program Files/nodejs:$PATH" && node --test tests/buckets.test.js`
Expected: FAIL — الاختبار الجديد يفشل برسالة خطأ (العمود غير موجود/القيمة مختلفة) بينما تنجح الاختبارات القديمة.

- [ ] **Step 5: تنفيذ التعديلين (Step 1 + Step 2)**

- [ ] **Step 6: إعادة تشغيل الاختبارات حتى النجاح**

Run: نفس أمر Step 4.
Expected: PASS للاختبارات الثلاثة (الجرد، النقل، الترحيل).

- [ ] **Step 7: Commit**

```bash
cd "/c/Users/Elite/Desktop/سام بلاستيك" && git add src/schema.sql src/db.js tests/buckets.test.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: عمود سلة البنود في جداول المستندات الثمانية مع ترحيل البيانات القديمة"
```

---

### Task 2: applyBucketsDelta في stock.js

**Files:**
- Modify: `src/stock.js`
- Test: `tests/buckets.test.js`

**Interfaces:**
- Consumes: `bucketsDelta(db, itemId, deltas)` (موجودة).
- Produces: `applyBucketsDelta(db, rows, sign)` — تُصدَّر من stock.js وتستخدمها المهام 3-9. `rows` بنود تحمل `item_id` و `bucket` و `pieces` (أو `qty_in_pieces`/`qty_out_pieces`).

- [ ] **Step 1: كتابة اختبار الدالة مباشرة**

```js
test('applyBucketsDelta تجمّع دلتا كل سلة لصنف مكرر بنود بسلات مختلفة', () => {
  const db = makeDb();
  db.prepare("INSERT INTO items (code, name, unit_name) VALUES ('902', 'عبوة', 'حبة')").run();
  const { applyBucketsDelta } = require('../src/stock');
  applyBucketsDelta(db, [
    { item_id: 1, pieces: 10, bucket: 'salem' },
    { item_id: 1, pieces: 4, bucket: 'talef' },
    { item_id: 1, pieces: 2, bucket: 'talef' },
    { item_id: 1, pieces: 1, bucket: 'muharraz' },
  ], 1);
  const it = db.prepare('SELECT * FROM items WHERE id=1').get();
  assert.equal(it.qty_salem, 10);
  assert.equal(it.qty_talef, 6);
  assert.equal(it.qty_muharraz, 1);
  // عكس الإشارة يعيد العدادات للصفر
  applyBucketsDelta(db, [{ item_id: 1, pieces: 10, bucket: 'salem' }, { item_id: 1, pieces: 6, bucket: 'talef' }, { item_id: 1, pieces: 1, bucket: 'muharraz' }], -1);
  const it2 = db.prepare('SELECT * FROM items WHERE id=1').get();
  assert.equal(it2.qty_salem + it2.qty_talef + it2.qty_muharraz, 0);
});
```

- [ ] **Step 2: تشغيل الاختبار للتحقق من فشله**

Run: `node --test tests/buckets.test.js`
Expected: FAIL — `applyBucketsDelta` غير معرّفة.

- [ ] **Step 3: إضافة الدالة وتصديرها**

أضف في `src/stock.js` بعد `applySalemDelta` (السطر 46):

```js
// تطبيق دلتا سلات مزدوجة (صنف × سلة) لبند قد يحوي سلات مختلفة: +داخل أو -خارج.
// يقبل بنود المستندات (pieces + bucket) وحركات المخزون (qty_in/out + bucket).
function applyBucketsDelta(db, rows, sign) {
  const byPair = new Map();
  for (const it of rows) {
    const itemId = it.item_id;
    const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
    const pieces = Math.abs(it.pieces != null ? it.pieces : ((it.qty_in_pieces || 0) - (it.qty_out_pieces || 0)));
    if (!itemId || !pieces) continue;
    const key = `${itemId}:${bucket}`;
    byPair.set(key, (byPair.get(key) || 0) + pieces);
  }
  for (const [key, pieces] of byPair) {
    const [itemId, bucket] = key.split(':');
    bucketsDelta(db, Number(itemId), { [bucket]: sign * pieces });
  }
}
```

وحدّث التصدير في آخر الملف:

```js
module.exports = { writeMoves, voidDoc, getBalance, bucketsDelta, applyBucketDelta, applySalemDelta, applyTalefDelta, applyBucketsDelta };
```

- [ ] **Step 4: تشغيل الاختبارات للتحقق من النجاح**

Expected: PASS — الاختبار الجديد وكل اختبارات buckets.

- [ ] **Step 5: Commit**

```bash
git add src/stock.js tests/buckets.test.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: دالة تجميع دلتا السلات applyBucketsDelta لكل صنف × سلة"
```

---

### Task 3: فواتير الشراء — سلة لكل بند

**Files:**
- Modify: `src/handlers/purchases.js`
- Test: `tests/buckets.test.js`

**Interfaces:**
- Consumes: `applyBucketsDelta(db, rows, sign)` (Task 2).
- Produces: `purchases:save` يقبل `items[].bucket` (`salem|talef|muharraz`، افتراضي `salem`) ويخزنها في `purchase_items.bucket` ويطبقها على العدادات.

- [ ] **Step 1: كتابة اختبار فاتورة سلات مختلطة**

```js
test('فاتورة شراء بسلات مختلفة تزيد كل عداد سلة على حدة وتنعكس عند الإلغاء', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'purchases', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '601', name: 'عبوة', unit_name: 'حبة', qty_salem: 0, qty_talef: 0, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const { id: pid } = h['purchases:save'](null, {
    doc_number: 'ش-1', doc_date: '2026-10-25',
    items: [
      { item_id: id, warehouse_id: wh, quantity: 100, unit: 'حبة', unit_price: 10, bucket: 'salem' },
      { item_id: id, warehouse_id: wh, quantity: 30, unit: 'حبة', unit_price: 0, bucket: 'talef' },
      { item_id: id, warehouse_id: wh, quantity: 5, unit: 'حبة', unit_price: 0, bucket: 'muharraz' },
    ],
  }, 1);
  const inv = () => h['reports:inventory'](null, {}).find(r => r.id === id);
  assert.equal(inv().qty_salem, 100);
  assert.equal(inv().qty_talef, 30);
  assert.equal(inv().qty_muharraz, 5);
  const line = db.prepare('SELECT bucket FROM purchase_items WHERE purchase_id=? AND item_id=?').get(pid, id);
  assert.equal(line.bucket, 'salem');
  // إلغاء الفاتورة يعيد العدادات كلها للصفر
  h['purchases:void'](null, pid, 1);
  assert.equal(inv().qty_salem + inv().qty_talef + inv().qty_muharraz, 0);
});
```

- [ ] **Step 2: تشغيل الاختبار للتحقق من فشله**

Expected: FAIL — العداد التالف يبقى صفراً (الشراء الحالي يزيد السليم فقط).

- [ ] **Step 3: تعديل المعالج**

في `src/handlers/purchases.js`:

1. سطر الاستيراد 4:
```js
const { writeMoves, voidDoc, applySalemDelta } = require('../stock');
```
يصبح:
```js
const { writeMoves, voidDoc, applyBucketsDelta } = require('../stock');
```

2. إدراج البند (السطور 71-81):
```js
      const insItem = db.prepare(`INSERT INTO purchase_items
        (purchase_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, unit_price, total_price, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const pieces = toPieces(it.quantity, it.unit, item);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg,
          it.unit_price || null, (it.unit_price || 0) * it.quantity, it.notes || null, bucket);
        moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, bucket, notes: it.notes });
      }
```

3. أثر السلات (السطور 84-86):
```js
      // أرصدة سليم/تالف/محرز: الشراء يزيد سلة كل بند (وعكس القديم عند التعديل)
      if (oldItems.length) applyBucketsDelta(db, oldItems, -1);
      applyBucketsDelta(db, moves, 1);
```

4. الإلغاء (السطر 117): `applySalemDelta(db, oldItems, -1);` → `applyBucketsDelta(db, oldItems, -1);`

- [ ] **Step 4: تشغيل الاختبارات للتحقق**

Expected: PASS — الاختبار الجديد وكل اختبارات الملف (بما فيها أي اختبارات شراء قديمة إن وجدت).

- [ ] **Step 5: Commit**

```bash
git add src/handlers/purchases.js tests/buckets.test.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: سلة لكل بند في فواتير الشراء مع أثرها على العدادات"
```

---

### Task 4: تصاريح الصرف — سلة + فحص كفاية لكل سلة

**Files:**
- Modify: `src/handlers/issues.js`
- Test: `tests/buckets.test.js`

**Interfaces:**
- Consumes: `applyBucketsDelta`, `getBalance` (يحوي `qty_salem/qty_talef/qty_muharraz`).
- Produces: `issues:save` يقبل `items[].bucket`؛ صرف «خام المصنع» يفحص كفاية السلة المختارة ويخصمها؛ «خام عميل» بلا أثر مخزني.

- [ ] **Step 1: كتابة اختبار فحص الكفاية**

```js
test('صرف بند تالف يتجاوز الرصيد التالف يُرفض برسالة السلة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'issues');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '603', name: 'عبوة', unit_name: 'حبة', qty_salem: 100, qty_talef: 10, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  assert.throws(() => h['issues:save'](null, {
    doc_number: 'ص-1', doc_date: '2026-10-25', source: 'own',
    items: [{ item_id: id, warehouse_id: wh, quantity: 50, unit: 'حبة', bucket: 'talef' }],
  }, 1), /غير كاف/);
  // صرف تالف ضمن المتاح ينجح ويخصم التالف فقط
  const { id: iid } = h['issues:save'](null, {
    doc_number: 'ص-2', doc_date: '2026-10-25', source: 'own',
    items: [{ item_id: id, warehouse_id: wh, quantity: 5, unit: 'حبة', bucket: 'talef' }],
  }, 1);
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 100);
  assert.equal(it.qty_talef, 5);
  // عكس الأثر: إلغاء التصريح يعيد التالف
  h['issues:void'](null, iid, 1);
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=?').get(id).qty_talef, 10);
});
```

- [ ] **Step 2: تشغيل الاختبار للتحقق من فشله**

Expected: FAIL — الصرف الحالي يفحص الرصيد الإجمالي فقط ويخصم السليم.

- [ ] **Step 3: تعديل المعالج**

في `src/handlers/issues.js`:

1. الاستيراد (سطر 4): `applySalemDelta` → `applyBucketsDelta`.

2. الإدراج (السطور 81-84):
```js
      const insItem = db.prepare(`INSERT INTO issue_items
        (issue_permit_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, carton_ids, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
```

3. حلقة البنود (السطور 86-103) — استبدل:
```js
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const cartonIds = (it.carton_ids || []).filter(Boolean);
        if (doc.source === 'own') {
          const bal = getBalance(db, it.item_id, it.warehouse_id);
          const available = bal[`qty_${bucket}`] || 0;
          const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
          if (available < pieces) throw new Error(`رصيد ${bucketLabel} غير كافٍ للصنف ${item.code} (المطلوب ${pieces} حبة والمتوفر ${available})`);
          moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
          for (const cn of cartonIds) {
            const r = issueCarton.run(doc.doc_date, id, cn);
            if (r.changes === 0) throw new Error(`الكرتون ${cn} غير متاح في المخزن`);
          }
        }
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg,
          cartonIds.length ? JSON.stringify(cartonIds) : null, it.notes || null, bucket);
      }
```

4. أثر السلات (السطور 105-107):
```js
      // أرصدة سليم/تالف/محرز: صرف المصنع يخصم سلة كل بند (وعكس القديم عند التعديل — وخام العميل بلا أثر مخزني)
      if (oldItems.length && before.source === 'own') applyBucketsDelta(db, oldItems, 1);
      applyBucketsDelta(db, moves, -1);
```

5. الإلغاء (السطر 127): `if (before.source === 'own') applySalemDelta(db, oldItems, 1);` → `if (before.source === 'own') applyBucketsDelta(db, oldItems, 1);`

- [ ] **Step 4: تشغيل الاختبارات للتحقق**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/issues.js tests/buckets.test.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: سلة لكل بند في تصاريح الصرف مع فحص كفاية السلة المختارة"
```

---

### Task 5: استلام الإنتاج التام — سلة لكل بند

**Files:**
- Modify: `src/handlers/receives.js`

**Interfaces:**
- Consumes: `applyBucketsDelta`.
- Produces: `receives:save` يقبل `items[].bucket` (افتراضي `salem`)، يخزنها ويزيد سلة كل بند لمصدر «إنتاج المصنع».

- [ ] **Step 1: تعديل المعالج**

في `src/handlers/receives.js`:

1. الاستيراد (سطر 4): `applySalemDelta` → `applyBucketsDelta`.

2. الإدراج (السطور 72-74):
```js
      const insItem = db.prepare(`INSERT INTO receive_items
        (receive_permit_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?)`);
```

3. حلقة البنود (السطور 75-85):
```js
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        if (doc.source === 'own') {
          moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, bucket, notes: it.notes });
        }
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg, it.notes || null, bucket);
      }
```

4. أثر السلات (السطور 87-89):
```js
      // استلام إنتاج المصنع يزيد سلة كل بند (وعكس القديم عند التعديل — وخام العميل بلا أثر مخزني)
      if (oldItems.length && before.source === 'own') applyBucketsDelta(db, oldItems, -1);
      applyBucketsDelta(db, moves, 1);
```

5. الإلغاء (السطر 102): `if (before.source === 'own') applySalemDelta(db, oldItems, -1);` → `if (before.source === 'own') applyBucketsDelta(db, oldItems, -1);`

- [ ] **Step 2: فحص سريع عبر الاختبارات**

Run: `node --test tests/buckets.test.js` — Expected: PASS (لا اختبار جديد هنا؛ تغطية الاستلام عبر دورة التكامل في الاختبارات القائمة).

- [ ] **Step 3: Commit**

```bash
git add src/handlers/receives.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: سلة لكل بند في استلام الإنتاج التام"
```

---

### Task 6: تصاريح الخروج — سلة + فحص كفاية لكل سلة

**Files:**
- Modify: `src/handlers/exits.js`
- Test: `tests/buckets.test.js`

**Interfaces:**
- Consumes: `applyBucketsDelta`, `getBalance`.
- Produces: `exits:save` يقبل `items[].bucket` ويفحص كفاية السلة المختارة في المخزن ويخصمها.

- [ ] **Step 1: كتابة اختبار**

```js
test('خروج بند محرز يتجاوز الرصيد المحرز يُرفض والمحرز المتاح يخصم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'exits');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '604', name: 'عبوة', unit_name: 'حبة', qty_salem: 50, qty_talef: 0, qty_muharraz: 20 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  assert.throws(() => h['exits:save'](null, {
    doc_number: 'خ-1', doc_date: '2026-10-25', warehouse_id: wh, driver_name: 'أحمد',
    items: [{ item_id: id, warehouse_id: wh, quantity: 30, unit: 'حبة', bucket: 'muharraz' }],
  }, 1), /غير كاف/);
  h['exits:save'](null, {
    doc_number: 'خ-2', doc_date: '2026-10-25', warehouse_id: wh, driver_name: 'أحمد',
    items: [{ item_id: id, warehouse_id: wh, quantity: 10, unit: 'حبة', bucket: 'muharraz' }],
  }, 1);
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 50);
  assert.equal(it.qty_muharraz, 10);
});
```

- [ ] **Step 2: تشغيل الاختبار للتحقق من فشله**

Expected: FAIL — الخروج الحالي يفحص الإجمالي ويخصم السليم.

- [ ] **Step 3: تعديل المعالج**

في `src/handlers/exits.js`:

1. الاستيراد (سطر 4): `applySalemDelta` → `applyBucketsDelta`.

2. الإدراج (السطور 57-59):
```js
      const insItem = db.prepare(`INSERT INTO exit_items
        (exit_permit_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?)`);
```

3. حلقة البنود (السطور 60-70):
```js
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const bal = getBalance(db, it.item_id, it.warehouse_id);
        const available = bal[`qty_${bucket}`] || 0;
        const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
        if (available < pieces) throw new Error(`رصيد ${bucketLabel} غير كافٍ للصنف ${item.code} (المطلوب ${pieces} حبة والمتوفر ${available})`);
        moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg, it.notes || null, bucket);
      }
```

4. أثر السلات (السطور 72-74):
```js
      // الخروج يخصم سلة كل بند: عكس أثر البنود القديمة ثم تطبيق الجديدة
      if (oldItems.length) applyBucketsDelta(db, oldItems, 1);
      applyBucketsDelta(db, moves, -1);
```

5. الإلغاء (السطر 87): `applySalemDelta(db, oldItems, 1);` → `applyBucketsDelta(db, oldItems, 1);`

- [ ] **Step 4: تشغيل الاختبارات للتحقق**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/exits.js tests/buckets.test.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: سلة لكل بند في تصاريح الخروج مع فحص كفاية السلة"
```

---

### Task 7: النقل بين المخازن — سلة لكل بند بلا أثر على العدادات

**Files:**
- Modify: `src/handlers/transfers.js`
- Test: `tests/buckets.test.js`

**Interfaces:**
- Consumes: `getBalance`.
- Produces: `transfers:save` يقبل `items[].bucket`، يفحص كفاية السلة في مخزن المصدر، ويسجل الحركتين (خروج/دخول) بنفس السلة — دون أي تغيير على عدادات الأصناف (النقل لا يغير الإجمالي).

- [ ] **Step 1: كتابة اختبار**

```js
test('نقل بند تالف بين مخزنين ينقل السلة مع الكمية دون تغيير العدادات', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'reports', 'transfers');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  h['warehouses:save'](null, { name: 'مخزن الصابون' }, 1);
  const { id } = h['items:save'](null, { code: '605', name: 'عبوة', unit_name: 'حبة', qty_salem: 0, qty_talef: 500, qty_muharraz: 0 }, 1);
  const mainWh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const soapWh = db.prepare("SELECT id FROM warehouses WHERE name='مخزن الصابون'").get().id;
  h['transfers:save'](null, {
    doc_number: 'نقل-2', doc_date: '2026-10-21',
    from_warehouse_id: mainWh, to_warehouse_id: soapWh,
    items: [{ item_id: id, quantity: 200, unit: 'حبة', bucket: 'talef' }],
  }, 1);
  const main = h['reports:inventory'](null, { warehouseId: mainWh }).find(r => r.id === id);
  const soap = h['reports:inventory'](null, { warehouseId: soapWh }).find(r => r.id === id);
  assert.equal(main.qty_talef, 300);
  assert.equal(soap.qty_talef, 200);
  // نقل تالف أكثر من المتاح يُرفض
  assert.throws(() => h['transfers:save'](null, {
    doc_number: 'نقل-3', doc_date: '2026-10-21',
    from_warehouse_id: soapWh, to_warehouse_id: mainWh,
    items: [{ item_id: id, quantity: 500, unit: 'حبة', bucket: 'talef' }],
  }, 1), /غير كاف/);
});
```

- [ ] **Step 2: تشغيل الاختبار للتحقق من فشله**

Expected: FAIL — النقل الحالي يفحص الإجمالي ويسجل السليم.

- [ ] **Step 3: تعديل المعالج**

في `src/handlers/transfers.js`:

1. الإدراج (السطور 55-57):
```js
      const insItem = db.prepare(`INSERT INTO transfer_items
        (transfer_id, item_id, quantity, unit, pieces, weight_kg, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?)`);
```

2. حلقة البنود (السطور 58-69):
```js
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const bal = getBalance(db, it.item_id, doc.from_warehouse_id);
        const available = bal[`qty_${bucket}`] || 0;
        const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
        if (available < pieces) throw new Error(`رصيد ${bucketLabel} غير كافٍ للصنف ${item.code} في مخزن المصدر (المتوفر ${available} حبة)`);
        moves.push({ item_id: item.id, warehouse_id: doc.from_warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
        moves.push({ item_id: item.id, warehouse_id: doc.to_warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, bucket, notes: it.notes });
        insItem.run(id, item.id, it.quantity, it.unit, pieces, kg, it.notes || null, bucket);
      }
```

(لا تعديل على أثر السلات — النقل بلا دلتا عدادات، كما هو الحال اليوم.)

- [ ] **Step 4: تشغيل الاختبارات للتحقق**

Expected: PASS — الاختبار الجديد + «النقل بين مخزنين ينقل تخصيص السليم» القديم (يعمل افتراضياً salem).

- [ ] **Step 5: Commit**

```bash
git add src/handlers/transfers.js tests/buckets.test.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: سلة لكل بند في النقل بين المخازن مع فحص كفاية سلة المصدر"
```

---

### Task 8: فواتير البيع — سلة لكل بند (افتراضي حسب النوع)

**Files:**
- Modify: `src/handlers/sales.js`
- Test: `tests/buckets.test.js`

**Interfaces:**
- Consumes: `applyBucketsDelta`, `getBalance`.
- Produces: `sales:save` يقبل `items[].bucket`؛ الافتراضي `salem` لبيع و `talef` لخردة؛ أجرة النفخ بلا حركات؛ فحص كفاية السلة المختارة.

- [ ] **Step 1: كتابة اختبار**

```js
test('فاتورة خردة تخصم التالف افتراضياً وبيع بسلة مختلفة يخصم سلة البند', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'sales', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '606', name: 'عبوة', unit_name: 'حبة', qty_salem: 100, qty_talef: 100, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  h['sales:save'](null, {
    doc_number: 'ف-1', doc_date: '2026-10-25', invoice_type: 'scrap',
    items: [{ item_id: id, warehouse_id: wh, quantity: 20, unit: 'حبة', unit_price: 1 }],
  }, 1);
  let it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 100);
  assert.equal(it.qty_talef, 80);
  // بيع يخصم سلة البند (تالف هنا) بدل السليم
  h['sales:save'](null, {
    doc_number: 'ف-2', doc_date: '2026-10-25', invoice_type: 'sale',
    items: [{ item_id: id, warehouse_id: wh, quantity: 10, unit: 'حبة', unit_price: 0.5, bucket: 'talef' }],
  }, 1);
  it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 100);
  assert.equal(it.qty_talef, 70);
});
```

- [ ] **Step 2: تشغيل الاختبار للتحقق من فشله**

Expected: FAIL — الخردة الحالية تعمل (TYPE_BUCKET) لكن بيع بسلة تالف يخصم السليم.

- [ ] **Step 3: تعديل المعالج**

في `src/handlers/sales.js`:

1. الاستيراد (سطر 4): `applyBucketDelta` → `applyBucketsDelta`.

2. احذف `applyTypeDelta` (السطور 12-16) و `TYPE_BUCKET` (سطر 10) وأبقِ `TYPE_LABEL` فقط.

3. الإدراج (السطور 70-72):
```js
      const insItem = db.prepare(`INSERT INTO invoice_items
        (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, unit_price, total_price, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
```

4. حلقة البنود (السطور 73-86):
```js
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const price = Number(it.unit_price) || 0;
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket)
          ? it.bucket : (doc.invoice_type === 'scrap' ? 'talef' : 'salem');
        if (doc.invoice_type !== 'blowing_fee') {
          const bal = getBalance(db, it.item_id, it.warehouse_id);
          const available = bal[`qty_${bucket}`] || 0;
          const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
          if (available < pieces) throw new Error(`رصيد ${bucketLabel} غير كافٍ للصنف ${item.code} (المطلوب ${pieces} حبة والمتوفر ${available})`);
          moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
        }
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg, price, price * it.quantity, it.notes || null, bucket);
      }
```

5. أثر السلات (السطور 88-90):
```js
      // أرصدة سليم/تالف/محرز: عكس أثر البنود القديمة ثم تطبيق الجديدة (الفاتورة تخصم سلة كل بند)
      if (oldItems.length && before.invoice_type !== 'blowing_fee') applyBucketsDelta(db, oldItems, 1);
      if (doc.invoice_type !== 'blowing_fee') applyBucketsDelta(db, moves, -1);
```

6. الإلغاء (السطر 110): `applyTypeDelta(db, oldItems, 1, before.invoice_type);` → `if (before.invoice_type !== 'blowing_fee') applyBucketsDelta(db, oldItems, 1);`

- [ ] **Step 4: تشغيل الاختبارات للتحقق**

Expected: PASS — الاختبار الجديد + أي اختبارات مبيعات قائمة.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/sales.js tests/buckets.test.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: سلة لكل بند في الفواتير بافتراض حسب النوع مع فحص كفاية السلة"
```

---

### Task 9: المرتجعات — سلة لكل بند ترث من السند الأصلي

**Files:**
- Modify: `src/handlers/returns.js`
- Test: `tests/buckets.test.js`

**Interfaces:**
- Consumes: `applyBucketsDelta`, `getBalance`.
- Produces: `returns:save` يقبل `items[].bucket`؛ مرتجع البيع يرث سلة بند فاتورة البيع افتراضياً ويزيدها؛ مرتجع الشراء يفحص كفاية السلة المختارة ويخصمها؛ `returns:available` يعيد `bucket` لكل بند.

- [ ] **Step 1: كتابة اختبار**

```js
test('مرتجع بيع لبند خردة يزيد التالف ومرتجع شراء يخصم السلة المختارة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'sales', 'returns', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '607', name: 'عبوة', unit_name: 'حبة', qty_salem: 0, qty_talef: 0, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const { id: invId } = h['sales:save'](null, {
    doc_number: 'ف-9', doc_date: '2026-10-25', invoice_type: 'scrap',
    items: [{ item_id: id, warehouse_id: wh, quantity: 50, unit: 'حبة', unit_price: 1 }],
  }, 1);
  // مرتجع بيع على فاتورة خردة بلا تحديد سلة يرث التالف من سطر الفاتورة
  const { id: rid } = h['returns:save'](null, {
    type: 'sale', doc_number: 'مر-1', doc_date: '2026-10-25', invoice_id: invId,
    items: [{ item_id: id, warehouse_id: wh, quantity: 10, unit: 'حبة' }],
  }, 1);
  let it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_talef, 40);
  assert.equal(db.prepare('SELECT bucket FROM sales_return_items WHERE return_id=?').get(rid).bucket, 'talef');
  // مرتجع شراء بلا سلة محدد يفترض السليم ويخصمه
  const { id: pid } = h['purchases:save'](null, {
    doc_number: 'ش-9', doc_date: '2026-10-25',
    items: [{ item_id: id, warehouse_id: wh, quantity: 30, unit: 'حبة', bucket: 'salem' }],
  }, 1);
  h['returns:save'](null, {
    type: 'purchase', doc_number: 'مر-2', doc_date: '2026-10-25', purchase_id: pid,
    items: [{ item_id: id, warehouse_id: wh, quantity: 5, unit: 'حبة' }],
  }, 1);
  it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 25);
  assert.equal(it.qty_talef, 40);
});
```

- [ ] **Step 2: تشغيل الاختبار للتحقق من فشله**

Expected: FAIL — مرتجع البيع على خردة يخصم/يزيد السليم حالياً (saleBucketOf تالفة لكن الاستيراد سيتغير)؛ التأكد من فشل التوكيدات.

- [ ] **Step 3: تعديل المعالج**

في `src/handlers/returns.js`:

1. الاستيراد (سطر 4):
```js
const { writeMoves, voidDoc, getBalance, applyBucketsDelta } = require('../stock');
```

2. أضف بعد `saleBucketOf` (سطر 15):
```js
// سلة بند فاتورة البيع المطابق للصنف — يرثها مرتجع البيع افتراضياً
function saleLineBucketOf(db, invoiceId, itemId) {
  const line = db.prepare(`SELECT bucket FROM invoice_items WHERE invoice_id=? AND item_id=? ORDER BY id LIMIT 1`)
    .get(invoiceId, itemId);
  return line && line.bucket ? line.bucket : (saleBucketOf(db, invoiceId) || 'salem');
}
```

3. `returns:available` (السطور 80-83): أضف `pi.bucket` بعد `pi.pieces_per_bag`:
```js
    const items = db.prepare(`SELECT pi.*, i.code, i.name, i.weight_grams, i.pieces_per_carton,
        i.pieces_per_bag, i.unit_name
      FROM ...`).all(refId);
```
يصبح تحديد البنود بلا تغيير بنيوي لأن `pi.*` يشمل `bucket` بعد Task 1 — لا حاجة لتعديل (تحقق فقط من أن `pi.*` في الاستعلام؛ نعم هو كذلك، لذا لا تعديل).

4. حلقة البنود في save (السطور 145-169) — استبدل:
```js
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        // لا يجوز إرجاع أكثر من كمية الفاتورة الأصلية (بعد خصم المرتجعات السابقة)
        const remaining = maxReturnable(db,
          isSale ? 'invoice_items' : 'purchase_items', refCol,
          isSale ? doc.invoice_id : doc.purchase_id, item.id, doc.id);
        if (pieces > remaining) {
          throw new Error(`كمية الإرجاع للصنف ${item.code} تتجاوز المتبقي من الفاتورة الأصلية (المتبقي ${remaining} حبة)`);
        }
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket)
          ? it.bucket
          : (isSale ? saleLineBucketOf(db, doc.invoice_id, item.id) : 'salem');
        if (!isSale) {
          const bal = getBalance(db, item.id, it.warehouse_id);
          const available = bal[`qty_${bucket}`] || 0;
          const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
          if (available < pieces) {
            throw new Error(`رصيد ${bucketLabel} غير كافٍ لإرجاع الصنف ${item.code} للمورد (المطلوب ${pieces} والمتوفر ${available})`);
          }
        }
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const price = Number(it.unit_price) || 0;
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg, price, price * it.quantity, it.notes || null, bucket);
        moves.push(isSale
          ? { item_id: item.id, warehouse_id: it.warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, bucket, notes: it.notes }
          : { item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
      }
```

5. الإدراج (السطور 142-144):
```js
      const insItem = db.prepare(`INSERT INTO ${itemsTable}
        (return_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, unit_price, total_price, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
```

6. عكس الأثر القديم عند التعديل (السطور 128-131):
```js
        // عكس الأثر القديم كاملاً قبل تطبيق الجديد (كل بند يحمل سلة خاصة)
        applyBucketsDelta(db, oldItems, isSale ? -1 : 1);
        ledger.voidDoc(db, isSale ? 'sale_return' : 'purchase_return', id);
```
(حذف سطري `const oldKey = ...` و `if (oldKey) applyBucketDelta(...)`.)

7. أثر السلات الجديد (السطور 171-173):
```js
      // أثر السلات: مرتجع البيع يزيد سلة كل بند، ومرتجع الشراء يخصمها
      applyBucketsDelta(db, moves, isSale ? 1 : -1);
```
(حذف `const key = isSale ? saleBucketOf(db, source.id) : 'salem';` و `if (key) applyBucketDelta(...)`.)

8. الإلغاء (السطور 200-201):
```js
      if (key) applyBucketDelta(db, oldItems, isSale ? -1 : 1, key);
```
يصبح:
```js
      applyBucketsDelta(db, oldItems, isSale ? -1 : 1);
```
(حذف سطر `const key = ...`.)

- [ ] **Step 4: تشغيل الاختبارات للتحقق**

Expected: PASS — الاختبار الجديد + اختبارات المرتجعات القائمة في `tests/`.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/returns.js tests/buckets.test.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: سلة لكل بند في المرتجعات ترث من السند الأصلي مع فحص كفاية السلة"
```

---

### Task 10: أعمدة السلة في شاشات المستندات الثمانية

**Files:**
- Modify: `renderer/js/ui.js` (دالتا `bucketOptions` و `bucketBadge`)
- Modify: `renderer/js/screens/purchases.js`, `issues.js`, `receives.js`, `exits.js`, `transfers.js`, `sales.js`, `salesreturns.js`, `returns.js`

**Interfaces:**
- Consumes: معالجات المهام 3-9 (تقبل `items[].bucket`).
- Produces: `bucketOptions(selected)` — `<option>`s لاختيار سلة؛ `bucketBadge(bucket)` — شارة HTML للعرض.

- [ ] **Step 1: إضافة الدالتين في ui.js**

أضف بعد دالة `renderTable` في `renderer/js/ui.js`:

```js
export function bucketOptions(selected) {
  const opts = [['salem', 'سليم'], ['talef', 'تالف'], ['muharraz', 'محرز']];
  return opts.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('');
}

export function bucketBadge(bucket) {
  const labels = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' };
  const b = ['salem', 'talef', 'muharraz'].includes(bucket) ? bucket : 'salem';
  return `<span class="tag ${b}">${labels[b]}</span>`;
}
```

- [ ] **Step 2: شاشة فواتير الشراء**

في `renderer/js/screens/purchases.js` — أضف `bucketOptions, bucketBadge` للاستيراد من ui.js:

1. استيراد (سطر 3): `import { toast, confirmDialog, implicationsDialog, renderTable, attachRowMenu, openModal, esc , itemCombo, bucketOptions, bucketBadge} from '../ui.js';`

2. رأس الجدول (سطر 126): بعد `<th>المخزن</th>` أضف `<th>السلة</th>`.

3. حفظ (بعد سطر 140): أضف `bucket: r.querySelector('.p-bucket').value,`.

4. addRow (بعد سطر 178):
```js
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
```

5. تعبئة التعديل (سطر 235): أضف `bucket: it.bucket,`.

6. عرض المستند view (سطر 53-56): أضف `<th>السلة</th>` بعد `<th>المخزن</th>` و `<td>${bucketBadge(it.bucket)}</td>` بعد `<td>${esc(it.warehouse_name)}</td>`.

- [ ] **Step 3: شاشة تصاريح الصرف**

في `renderer/js/screens/issues.js`:

1. استيراد (سطر 3): أضف `bucketOptions, bucketBadge`.

2. رأس الجدول (سطر 138): بعد `<th>المخزن</th>` أضف `<th>السلة</th>`.

3. حفظ (سطر 151): أضف `bucket: r.querySelector('.p-bucket').value,`.

4. addRow (بعد سطر 198):
```js
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
```

5. في `refreshRow` (فرع خام المصنع، الأسطر 243-249) استبدل نص الرصيد:
```js
            try {
              const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
              const b = row.querySelector('.p-bucket').value;
              const av = bal['qty_' + b] || 0;
              const bl = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' }[b];
              balText.textContent = `الرصيد ${bl}: ${fmtNum(av, 0)} حبة`;
            } catch { balText.textContent = ''; }
```
وأضف `row.querySelector('.p-bucket').onchange = refreshRow;` بعد `qty.oninput = updateTotal;` (سطر 273).

6. تعبئة التعديل (سطر 284): أضف `bucket: it.bucket,`.

7. view (سطر 58-61): أضف `<th>السلة</th>` بعد `<th>المخزن</th>` و `<td>${bucketBadge(it.bucket)}</td>` بعد `<td>${esc(it.warehouse_name)}</td>`.

- [ ] **Step 4: شاشة استلام الإنتاج التام**

في `renderer/js/screens/receives.js`:

1. استيراد (سطر 3): أضف `bucketOptions, bucketBadge`.

2. رأس الجدول (سطر 134): بعد `<th>المخزن</th>` أضف `<th>السلة</th>`.

3. حفظ (سطر 147): أضف `bucket: r.querySelector('.p-bucket').value,`.

4. addRow (بعد سطر 193):
```js
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
```

5. تعبئة التعديل (سطر 241): أضف `bucket: it.bucket,`.

6. view (سطر 57-60): أضف `<th>السلة</th>` بعد `<th>المخزن</th>` و `<td>${bucketBadge(it.bucket)}</td>` بعد `<td>${esc(it.warehouse_name)}</td>`.

- [ ] **Step 5: شاشة تصاريح الخروج**

في `renderer/js/screens/exits.js`:

1. استيراد (سطر 3): أضف `bucketOptions, bucketBadge`.

2. رأس الجدول: بعد `<th>المخزن</th>` أضف `<th>السلة</th>`.

3. حفظ: أضف `bucket: r.querySelector('.p-bucket').value,`.

4. addRow (بعد سطر السلة المخزن):
```js
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
```

5. في `update()` (دالة الرصيد) استبدل:
```js
            const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
            balText.textContent = `الرصيد: ${fmtNum(bal.balance_pieces, 0)} حبة`;
```
بـ:
```js
            const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
            const b = row.querySelector('.p-bucket').value;
            const av = bal['qty_' + b] || 0;
            const bl = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' }[b];
            balText.textContent = `الرصيد ${bl}: ${fmtNum(av, 0)} حبة`;
```
وأضف `row.querySelector('.p-bucket').onchange = update;` بعد `qty.oninput = update;`.

6. تعبئة التعديل: أضف `bucket: it.bucket,`.

7. view: أضف `<th>السلة</th>` بعد `<th>المخزن</th>` و `<td>${bucketBadge(it.bucket)}</td>` بعد `<td>${esc(it.warehouse_name)}</td>`.

- [ ] **Step 6: شاشة النقل بين المخازن**

في `renderer/js/screens/transfers.js`:

1. استيراد (سطر 3): أضف `bucketOptions, bucketBadge`.

2. رأس الجدول: بعد `<th>الصنف</th>` أضف `<th>السلة</th>`.

3. حفظ: أضف `bucket: r.querySelector('.p-bucket').value,`.

4. addRow (بعد خلية الصنف):
```js
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
```

5. في `update()` استبدل نص الرصيد:
```js
            const bal = await api.invoke('stock:balance', item.id, fromWh());
            balText.textContent = `الرصيد: ${fmtNum(bal.balance_pieces, 0)} حبة`;
```
بـ:
```js
            const bal = await api.invoke('stock:balance', item.id, fromWh());
            const b = row.querySelector('.p-bucket').value;
            const av = bal['qty_' + b] || 0;
            const bl = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' }[b];
            balText.textContent = `الرصيد ${bl}: ${fmtNum(av, 0)} حبة`;
```
وأضف `row.querySelector('.p-bucket').onchange = update;` بعد `qty.oninput = update;`.

6. تعبئة التعديل: أضف `bucket: it.bucket,`.

7. view: أضف `<th>السلة</th>` بعد `<th>الصنف</th>` و `<td>${bucketBadge(it.bucket)}</td>` بعد `<td>${esc(it.code)} — ${esc(it.name)}</td>`.

- [ ] **Step 7: شاشة فواتير البيع (مع تحويل أعمدة الأزرار لقائمة صف)**

في `renderer/js/screens/sales.js`:

1. استيراد (سطر 3): `import { toast, implicationsDialog, renderTable, attachRowMenu, openModal, esc, itemCombo, bucketOptions, bucketBadge } from '../ui.js';`

2. استبدل عمود `actions` (الأسطر 32-43) — احذفه كلياً، واستبدل:
```js
      el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view(Number(b.dataset.view)));
      el.querySelectorAll('[data-print]').forEach(b => b.onclick = () => printDoc(Number(b.dataset.print)));
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(Number(b.dataset.edit)));
      el.querySelectorAll('[data-void]').forEach(b => b.onclick = () => voidDoc(Number(b.dataset.void)));
```
بـ:
```js
      attachRowMenu(el.querySelector('#table-wrap'), (ri) => {
        const r = rows[ri];
        return [
          { label: 'عرض', open: true, onClick: () => view(r.id) },
          { label: 'طباعة', onClick: () => printDoc(r.id) },
          { label: 'تعديل', onClick: () => edit(r.id) },
          { label: 'إلغاء', danger: true, onClick: () => voidDoc(r.id) },
        ];
      });
```

3. رأس جدول البنود (سطر 130): بعد `<th>المخزن</th>` أضف `<th>السلة</th>`.

4. حفظ (سطر 142): أضف `bucket: r.querySelector('.p-bucket').value,`.

5. addRow (بعد سطر 184):
```js
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
```
وعند بناء الصف أضف `row._bucketTouched = false;` بعد `row.className = 'irow';` و:
```js
        row.querySelector('.p-bucket').addEventListener('change', () => { row._bucketTouched = true; });
```

6. في `update()` (فرع غير الخدمة، الأسطر 218-223) استبدل:
```js
              const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
              balText.textContent = `الرصيد: ${fmtNum(bal.balance_pieces, 0)} حبة`;
```
بـ:
```js
              const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
              const b = row.querySelector('.p-bucket').value;
              const av = bal['qty_' + b] || 0;
              const bl = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' }[b];
              balText.textContent = `الرصيد ${bl}: ${fmtNum(av, 0)} حبة`;
```

7. معالج تغيير النوع (الأسطر 246-247) — استبدل:
```js
      back.querySelector('#f-type').onchange = () =>
        rowsWrap.querySelectorAll('.irow').forEach(r => r._refresh && r._refresh());
```
بـ:
```js
      back.querySelector('#f-type').onchange = () =>
        rowsWrap.querySelectorAll('.irow').forEach(r => {
          if (!r._bucketTouched) r.querySelector('.p-bucket').value =
            back.querySelector('#f-type').value === 'scrap' ? 'talef' : 'salem';
          r._refresh && r._refresh();
        });
```

8. تعبئة التعديل (سطر 250): أضف `bucket: it.bucket,`.

9. view (سطر 60-64): أضف `<th>السلة</th>` بعد `<th>المخزن</th>` و `<td>${bucketBadge(it.bucket)}</td>` بعد `<td>${esc(it.warehouse_name)}</td>`.

- [ ] **Step 8: شاشة مرتجعات الفواتير (بيع)**

في `renderer/js/screens/salesreturns.js`:

1. استيراد (سطر 3): أضف `bucketOptions, bucketBadge`.

2. رأس الجدول (سطر 159): بعد `<th>المخزن</th>` أضف `<th>السلة</th>`.

3. حفظ (سطر 172): أضف `bucket: r.querySelector('.p-bucket').value,`.

4. addRow (بعد سطر 257):
```js
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
```
وعند بناء الصف أضف `row._bucketTouched = false;` و:
```js
        row.querySelector('.p-bucket').addEventListener('change', () => { row._bucketTouched = true; });
```

5. في `refresh()` (سطر 277-290) بعد `const a = itemOf(itemSel.value); if (!a) return;` أضف:
```js
          if (!row._bucketTouched && a.bucket) row.querySelector('.p-bucket').value = a.bucket;
```

6. تعبئة التعديل (سطر 326): أضف `bucket: it.bucket,`.

7. view (سطر 59-63): أضف `<th>السلة</th>` بعد `<th>المخزن</th>` و `<td>${bucketBadge(it.bucket)}</td>` بعد `<td>${esc(it.warehouse_name)}</td>`.

- [ ] **Step 9: شاشة مرتجعات الشراء**

في `renderer/js/screens/returns.js`:

1. استيراد (سطر 3): أضف `bucketOptions, bucketBadge`.

2. رأس الجدول (سطر 120): بعد `<th>المخزن</th>` أضف `<th>السلة</th>`.

3. حفظ (سطر 132): أضف `bucket: r.querySelector('.p-bucket').value,`.

4. addRow (بعد سطر 171):
```js
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
```
وعند بناء الصف أضف `row._bucketTouched = false;` و:
```js
        row.querySelector('.p-bucket').addEventListener('change', () => { row._bucketTouched = true; });
```

5. في `refresh()` (سطر 192-204) بعد `const src = srcItems.find(...); if (!src) return;` أضف:
```js
          if (!row._bucketTouched && src.bucket) row.querySelector('.p-bucket').value = src.bucket;
```

6. تعبئة التعديل (سطر 245): أضف `bucket: it.bucket,`.

7. view (سطر 64-67): أضف `<th>السلة</th>` بعد `<th>المخزن</th>` و `<td>${bucketBadge(it.bucket)}</td>` بعد `<td>${esc(it.warehouse_name)}</td>`.

- [ ] **Step 10: فحص صياغة ملفات الواجهة المعدلة**

```bash
cd "/c/Users/Elite/Desktop/سام بلاستيك" && for f in ui purchases issues receives exits transfers sales salesreturns returns; do cp "renderer/js/screens/$f.js" /tmp/x.mjs 2>/dev/null || cp "renderer/js/ui.js" /tmp/x.mjs; node --check /tmp/x.mjs || echo "FAIL $f"; done
```
(نفّذ لكل ملف على حدة بصيغة `cp renderer/js/screens/purchases.js /tmp/p.mjs && node --check /tmp/p.mjs`.)

Expected: لا أخطاء صياغة.

- [ ] **Step 11: تشغيل الاختبارات كاملة**

Run: `node --test tests/`
Expected: PASS كاملة.

- [ ] **Step 12: Commit**

```bash
git add renderer/js/ui.js renderer/js/screens/purchases.js renderer/js/screens/issues.js renderer/js/screens/receives.js renderer/js/screens/exits.js renderer/js/screens/transfers.js renderer/js/screens/sales.js renderer/js/screens/salesreturns.js renderer/js/screens/returns.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: عمود السلة في نماذج الشاشات الثمانية مع شارة في العرض ورصيد السلة المختارة"
```

---

### Task 11: عمود السلة في تقرير حركة الصنف

**Files:**
- Modify: `src/handlers/reports.js:54-58`
- Modify: `renderer/js/screens/reports.js:74-87`

**Interfaces:**
- Consumes: `stock_moves.bucket` (موجود).
- Produces: `reports:movement` يعيد `bucket` لكل صف؛ عمود «السلة» في جدول التقرير.

- [ ] **Step 1: تعديل المعالج**

في `src/handlers/reports.js` أضف `m.bucket` إلى قائمة SELECT (سطر 57 بعد `m.qty_out_pieces`):

```js
        m.qty_in_pieces, m.qty_out_pieces, m.bucket, m.weight_in_kg, m.weight_out_kg, m.notes
```

- [ ] **Step 2: تعديل شاشة التقرير**

في `renderer/js/screens/reports.js` أضف للاستيراد `bucketBadge` من ui.js، ثم أضف في أعمدة movement (بعد عمود `warehouse_name` سطر 79):

```js
          { key: 'bucket', label: 'السلة', cell: r => bucketBadge(r.bucket) },
```

- [ ] **Step 3: فحص وتشغيل**

Run: `node --check` لملف reports.js المنسوخ + `node --test tests/`.
Expected: لا أخطاء وكل الاختبارات PASS.

- [ ] **Step 4: Commit**

```bash
git add src/handlers/reports.js renderer/js/screens/reports.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: عمود السلة في تقرير حركة الصنف"
```

---

### Task 12: عمود السلة في قوالب الطباعة

**Files:**
- Modify: `src/print/templates.js`

**Interfaces:**
- Consumes: `doc.items[].bucket` (تأتي تلقائياً عبر `SELECT *` في معالجات get).
- Produces: أعمدة «السلة» في قوالب: purchase, issue, receive, invoice, exit, transfer, return.

- [ ] **Step 1: إضافة دالة مساعدة وتعديل القوالب السبعة**

في `src/print/templates.js` أضف بعد `num`:

```js
const BUCKET_LABEL = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' };
function bucketCell(bucket) {
  const b = BUCKET_LABEL[bucket] ? bucket : 'salem';
  const color = { salem: '#15803d', talef: '#b91c1c', muharraz: '#b45309' }[b];
  return `<b style="color:${color}">${BUCKET_LABEL[b]}</b>`;
}
```

ثم عدّل القوالب السبعة:

1. `purchaseTemplate` (السطور 56-62):
```js
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    fmt(r.quantity, 3), esc(r.unit), bucketCell(r.bucket), num(r.pieces), fmt(r.weight_kg, 2),
    money(r.unit_price, settings), money(r.total_price, settings)]);
  const total = (doc.items || []).reduce((s, r) => s + (r.total_price || 0), 0);
  rows.push(['', 'الإجمالي', '', '', '', '', '', '', `<b>${money(total, settings)}</b>`]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'فاتورة شراء'],
    meta(doc) + tableHtml(['#', 'الصنف', 'الكمية', 'الوحدة', 'السلة', 'الحبات', 'الوزن كجم', 'السعر', 'الإجمالي'], rows)
```

2. `issueTemplate` (السطور 67-72): أضف بعد `esc(r.warehouse_name)` القيمة `bucketCell(r.bucket)` وبعد `'المخزن'` في رأس الأعمدة `'السلة'`.

3. `receiveTemplate` (السطور 77-82): أضف `bucketCell(r.bucket)` بعد `esc(r.warehouse_name)` و `'السلة'` بعد `'المخزن'` في الرأس.

4. `invoiceTemplate` (السطور 88-93): أضف `bucketCell(r.bucket)` بعد `esc(r.warehouse_name)`؛ صف الإجمالي يصبح `['', 'الإجمالي', '', '', '', '', '', '<b>…</b>']`؛ الرأس `['#', 'الصنف', 'المخزن', 'الكمية', 'الوحدة', 'السلة', 'السعر', 'الإجمالي']`.

5. `exitTemplate` (السطور 98-102): أضف `bucketCell(r.bucket)` بعد `esc(r.name)` و `'السلة'` بعد `'الصنف'` في الرأس.

6. `transferTemplate` (السطور 134-138): أضف `bucketCell(r.bucket)` بعد `esc(r.name)` و `'السلة'` بعد `'الصنف'`.

7. `returnTemplate` (السطور 160-166): أضف `bucketCell(r.bucket)` بعد `esc(r.warehouse_name)`؛ الإجمالي `['', 'الإجمالي', '', '', '', '', '', '<b>…</b>']`؛ الرأس `['#', 'الصنف', 'المخزن', 'الكمية', 'الوحدة', 'السلة', 'السعر', 'الإجمالي']`.

- [ ] **Step 2: فحص الصياغة**

Run: `cp src/print/templates.js /tmp/t.mjs && node --check /tmp/t.mjs`
Expected: لا أخطاء.

- [ ] **Step 3: Commit**

```bash
git add src/print/templates.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: عمود السلة في قوالب طباعة المستندات السبعة"
```

---

### Task 13: كليك يسار مزدوج = عرض فقط (بلا أي حفظ)

**Files:**
- Modify: `renderer/js/ui.js` (attachRowMenu)
- Modify: `renderer/js/screens/items.js`, `parties.js`, `machines.js`, `warehouses.js`, `shifts.js`, `users.js`, `production.js`

**Interfaces:**
- Consumes: `attachRowMenu(tableWrapEl, actionOf)` — نفس التوقيع الحالي.
- Produces: نقرة يسار مزدوجة على صف تشغّل إجراء `open: true` (عرض فقط)، والنقرة اليمنى تعرض القائمة كما هي؛ شاشات البيانات الأساسية تحصل على نوافذ عرض للقراءة فقط وتفصل «تعديل» عنها.

- [ ] **Step 1: إعادة بناء attachRowMenu**

في `renderer/js/ui.js` استبدل جسم `attachRowMenu` (بعد سطر `tableWrapEl.__rowMenu = state;` حتى نهاية الدالة):

```js
  const state = { actionOf };
  tableWrapEl.__rowMenu = state;
  // كليك يسار مزدوج على الصف = إجراء «الفتح» (عرض المستند فقط دون أي حفظ)
  tableWrapEl.addEventListener('dblclick', (ev) => {
    const tr = ev.target.closest('tr[data-ri]');
    if (!tr) return;
    const actions = state.actionOf(Number(tr.dataset.ri));
    const open = Array.isArray(actions) && actions.find(a => a.open);
    if (open) open.onClick();
  });
  tableWrapEl.addEventListener('contextmenu', (ev) => {
    const tr = ev.target.closest('tr[data-ri]');
    if (!tr) return;
    ev.preventDefault();
    const actions = state.actionOf(Number(tr.dataset.ri));
    if (!Array.isArray(actions) || !actions.length) return;
    closeCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = actions.map(a => `<button class="ctx-item${a.danger ? ' danger' : ''}">${esc(a.label)}</button>`).join('');
    menu.querySelectorAll('.ctx-item').forEach((btn, i) => {
      btn.onclick = () => { closeCtxMenu(); actions[i].onClick(); };
    });
    document.body.appendChild(menu);
    menu.style.left = `${Math.max(4, Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(4, Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 8))}px`;
    ctxMenuEl = menu;
  });
```

وحذف `state.lastId/lastT` والمنطق القديم المرتبط بها كلياً.

- [ ] **Step 2: شاشة الأصناف — نافذة عرض للقراءة فقط**

في `renderer/js/screens/items.js` أضف دالة `view(row)` قبل `edit`:

```js
    function view(row) {
      openModal(`عرض صنف ${esc(row.code)}`, `
        <div class="form-grid">
          <div class="field"><label>كود الصنف</label><span class="muted">${esc(row.code)}</span></div>
          <div class="field"><label>الاسم</label><span class="muted">${esc(row.name)}</span></div>
          <div class="field"><label>الوحدة</label><span class="muted">${esc(row.unit_name)}</span></div>
          <div class="field"><label>النوع</label><span class="muted">${row.is_complement ? 'صنف مكمل' : 'صنف أساسي'}</span></div>
          <div class="field"><label>وزن الوحدة</label><span class="muted">${row.weight_grams ? fmt(row.weight_grams) + ' جم' : '—'}</span></div>
          <div class="field"><label>التعبئة</label><span class="muted">${packCell(row).replace(/<[^>]*>/g, '')}</span></div>
          <div class="field"><label>سليم</label>${qtyCell(row, 'qty_salem', 'salem', 'سليم')}</div>
          <div class="field"><label>تالف</label>${qtyCell(row, 'qty_talef', 'talef', 'تالف')}</div>
          <div class="field"><label>محرز</label>${qtyCell(row, 'qty_muharraz', 'muharraz', 'محرز')}</div>
          <div class="field full"><label>ملاحظات</label><span class="muted">${esc(row.notes || '—')}</span></div>
        </div>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
    }
```

وغيّر قائمة الصف (الأسطر 181-194) إلى:
```js
        return [
          { label: 'عرض', open: true, onClick: () => view(r) },
          { label: 'تعديل', onClick: () => edit(r, () => refresh()) },
          { label: 'حذف', danger: true, onClick: async () => { ... كما هو ... } },
        ];
```
(أزل `open: true` من «تعديل» وأضفه لـ«عرض» الجديد.)

- [ ] **Step 3: شاشات الأطراف والمكائن والمخازن والورديات والمستخدمين — نوافذ عرض**

نفس النمط لكل شاشة — أضف دالة عرض للقراءة فقط وغيّر عنصر القائمة:

`parties.js`:
```js
    function view(row) {
      openModal(`عرض طرف ${esc(row.name)}`, `
        <div class="form-grid">
          <div class="field"><label>الاسم</label><span class="muted">${esc(row.name)}</span></div>
          <div class="field"><label>النوع</label><span class="tag ${TYPE_TAG[row.type] || 'muharraz'}">${TYPE_NAMES[row.type] || row.type}</span></div>
          <div class="field"><label>الهاتف</label><span class="muted" dir="ltr">${esc(row.phone || '—')}</span></div>
          <div class="field full"><label>العنوان</label><span class="muted">${esc(row.address || '—')}</span></div>
          <div class="field full"><label>ملاحظات</label><span class="muted">${esc(row.notes || '—')}</span></div>
        </div>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
    }
```
والقائمة:
```js
        return [
          { label: 'عرض', open: true, onClick: () => view(r) },
          { label: 'تعديل', onClick: () => edit(r, refresh) },
          { label: 'حذف', danger: true, onClick: async () => { ... كما هو ... } },
        ];
```

`machines.js`:
```js
    function view(row) {
      openModal(`عرض مكينة ${esc(row.name)}`, `
        <div class="form-grid">
          <div class="field full"><label>الاسم</label><span class="muted">${esc(row.name)}</span></div>
          <div class="field full"><label>ملاحظات</label><span class="muted">${esc(row.notes || '—')}</span></div>
        </div>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
    }
```
والقائمة: `{ label: 'عرض', open: true, onClick: () => view(r) }, { label: 'تعديل', onClick: () => edit(r, refresh) }, { label: 'حذف', ... }`.

`warehouses.js`:
```js
    function view(row) {
      openModal(`عرض مخزن ${esc(row.name)}`, `
        <div class="form-grid">
          <div class="field"><label>الاسم</label><span class="muted">${esc(row.name)}</span></div>
          <div class="field"><label>الموقع</label><span class="muted">${esc(row.location || '—')}</span></div>
          <div class="field full"><label>ملاحظات</label><span class="muted">${esc(row.notes || '—')}</span></div>
        </div>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
    }
```
والقائمة: `{ label: 'عرض', open: true, onClick: () => view(r) }, { label: 'تعديل', onClick: () => edit(r, refresh) }, { label: 'حذف', ... }`.

`shifts.js` — مثل machines.js بنص «وردية».

`users.js`:
```js
    function view(row) {
      openModal(`عرض مستخدم ${esc(row.username)}`, `
        <div class="form-grid">
          <div class="field"><label>اسم المستخدم</label><span class="muted" dir="ltr">${esc(row.username)}</span></div>
          <div class="field"><label>الاسم الكامل</label><span class="muted">${esc(row.full_name)}</span></div>
          <div class="field"><label>الدور</label><span class="tag ${ROLE_TAG[row.role] || 'muharraz'}">${ROLE_LABEL[row.role] || row.role}</span></div>
        </div>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
    }
```
والقائمة: `{ label: 'عرض', open: true, onClick: () => view(r) }, { label: 'تعديل', onClick: () => edit(r, refresh) },` + الحذف كما هو.

`production.js`:
- جدول الانتظار: القائمة تصبح:
```js
        return [
          { label: 'عرض الكرتون', open: true, onClick: () => viewCarton(r) },
          { label: 'تسجيل النتيجة', onClick: () => resultForm(r.carton_id, false) },
        ];
```
- جدول النتائج: القائمة تصبح:
```js
        return [
          { label: 'عرض النتيجة', open: true, onClick: () => viewResult(r.carton_id) },
          { label: 'تعديل', onClick: () => resultForm(r.carton_id, true) },
          { label: 'طباعة', onClick: async () => { ... كما هو ... } },
          { label: 'حذف', danger: true, onClick: () => delResult(r.carton_id) },
        ];
```
وأضف دالتي العرض:
```js
    function viewCarton(r) {
      openModal(`كرتون ${esc(r.carton_number)}`, `
        <p style="line-height:2"><b>الصنف:</b> ${esc(r.item_code)} — ${esc(r.item_name)}<br>
        <b>تصريح الصرف:</b> ${esc(r.issue_number || '—')} &nbsp; <b>تاريخ الصرف:</b> ${esc(r.issue_date || '—')}<br>
        <b>المكينة:</b> ${esc(r.machine_name || '—')} &nbsp; <b>الوردية:</b> ${esc(r.shift_name || '—')}<br>
        <b>الحبات:</b> ${fmtNum(r.pieces, 0)}</p>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
    }
    async function viewResult(cartonId) {
      try {
        const row = await api.invoke('production:get', cartonId);
        const rest = row.pieces - ((row.good_pieces || 0) + (row.defect_before || 0) + (row.defect_after || 0));
        openModal(`نتيجة كرتون ${esc(row.carton_number)}`, `
          <p style="line-height:2"><b>الصنف:</b> ${esc(row.item_code)} — ${esc(row.item_name)} &nbsp; <b>التاريخ:</b> ${esc(row.result_date)}<br>
          <b>سليم:</b> ${fmtNum(row.good_pieces, 0)} &nbsp; <b>تالف قبل:</b> ${fmtNum(row.defect_before, 0)} &nbsp; <b>تالف بعد:</b> ${fmtNum(row.defect_after, 0)} &nbsp;
          <b>غير محسوب:</b> ${rest > 0 ? '+' : ''}${fmtNum(rest, 0)}<br>
          <b>ملاحظات:</b> ${esc(row.notes || '—')}</p>`,
          [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }
```

- [ ] **Step 4: فحص صياغة كل الملفات المعدلة**

Run: `node --check` لكل ملف منسوخ إلى /tmp.
Expected: لا أخطاء.

- [ ] **Step 5: تشغيل الاختبارات**

Run: `node --test tests/` — Expected: PASS (لا تغيير خلفي هنا).

- [ ] **Step 6: Commit**

```bash
git add renderer/js/ui.js renderer/js/screens/items.js renderer/js/screens/parties.js renderer/js/screens/machines.js renderer/js/screens/warehouses.js renderer/js/screens/shifts.js renderer/js/screens/users.js renderer/js/screens/production.js && git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: كليك يسار مزدوج يفتح العرض فقط ونوافذ عرض للقراءة في شاشات البيانات الأساسية"
```

---

### Task 14: التحقق النهائي والفحص البصري والالتزام وإعادة التشغيل

**Files:**
- لا تعديلات كود — تحقق فقط.

- [ ] **Step 1: الاختبارات كاملة**

```bash
cd "/c/Users/Elite/Desktop/سام بلاستيك" && export PATH="/c/Program Files/nodejs:$PATH" && node --test tests/
```
Expected: كل الاختبارات PASS (173 سابقة + الجديدة).

- [ ] **Step 2: فحص صياغة كل ملفات الواجهة**

```bash
for f in renderer/js/ui.js renderer/js/screens/*.js src/print/templates.js; do cp "$f" /tmp/chk.mjs && node --check /tmp/chk.mjs || echo "FAIL: $f"; done
```
Expected: لا إخراج FAIL.

- [ ] **Step 3: فحص بصري على نسخة آمنة من القاعدة (CDP)**

انسخ `data/samplastic.db` إلى `data/check-buckets.db`، وأضف مؤقتاً في main.js رمز capturePage (كما في الجولات السابقة)، وشغّل مع `--remote-debugging-port=9222` وافحص:
1. نموذج فاتورة شراء: عمود «السلة» بقائمة اختيار (سليم/تالف/محرز) افتراضياً سليم.
2. نموذج فاتورة بيع: تغيير النوع إلى «خردة» يجعل افتراضي السلة «تالف»؛ سطر عرض «الرصيد السليم/التالف».
3. نموذج خروج/نقل: «الرصيد السليم: N حبة» حسب السلة المختارة.
4. عرض مستند موجود: شارة السلة في جدول العرض.
5. تقرير حركة صنف: عمود «السلة».
6. معاينة طباعة فاتورة شراء: عمود «السلة» ملوّن.
7. كليك يسار مزدوج على صف في فواتير الشراء يفتح نافذة «عرض» فقط (بلا حفظ)؛ وكليك يسار مزدوج في الأصناف يفتح عرض الصنف للقراءة، و«تعديل» في القائمة يفتح التعديل.
8. كليك يمين مفرد يعرض القائمة كما كانت.
ثم احذف كود capturePage المؤقت وملف النسخة المؤقتة، وأعد تشغيل البرنامج على القاعدة الحية — الهجرة ستضيف الأعمدة للقاعدة الحية تلقائياً عند أول تشغيل (تتحقق من ظهور البرنامج سليماً بعدها).

- [ ] **Step 4: الالتزام النهائي (إن وُجدت تعديلات متبقية)**

```bash
git status --short
```
وتأكد من استبعاد `data/` و `*.tar.gz` و `.shots/` ثم إن وجدت تعديلات: الالتزام بنفس هوية الرسائل السابقة.

- [ ] **Step 5: إعادة التشغيل والتقرير النهائي**

```bash
taskkill //F //IM electron.exe 2>/dev/null; cd "/c/Users/Elite/Desktop/سام بلاستيك" && cmd //c start "" "تشغيل البرنامج.bat"
```
ثم تقرير عربي واحد موجز يغطي: ما تم، الملفات، الاختبارات، الفحص البصري، وكيفية الاستخدام الجديد (سلة لكل بند + كليك يسار مزدوج للعرض).

---

## Self-Review

**1. تغطية المواصفة:** السلات لكل بند (Tasks 3-10) ✓ — العرض في التقرير (Task 11) والمطبوعات (Task 12) ✓ — عمود تخزين في جداول البنود (Task 1) ✓ — فحص كفاية السلة على الخروج (Tasks 4, 6, 7, 8, 9) ✓ — الافتراضات (شراء/استلام/خروج/نقل سليم؛ خردة تالف؛ مرتجع بيع يرث سطر الفاتورة؛ مرتجع شراء سليم) ✓ — تعديل المستخدم: كليك يسار مزدوج للعرض فقط بلا حفظ مع بقاء التعديل كبند قائمة مستقل (Task 13) ✓ — شاشة المبيعات القديمة بأزرار تتحول لقائمة الصفوف (Task 10 Step 7) ✓.

**2. فحص الفراغات:** لا TBD/TODO؛ كل مهمة تحوي الكود الكامل المطلوب.

**3. تناسق الأنواع:** `applyBucketsDelta(db, rows, sign)` معرفة في Task 2 وتستخدم بنفس التوقيع في 3-9؛ `bucketOptions(selected)`/`bucketBadge(bucket)` معرفتان في Task 10 Step 1 وتستخدمان في 10-11؛ أسماء الأعمدة `bucket` و `qty_salem/qty_talef/qty_muharraz` موحدة عبر كل المهام؛ `p-bucket` هو اسم class الحقل في كل الشاشات.
