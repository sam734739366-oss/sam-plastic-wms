# خطة تنفيذ إعادة تصميم واجهة «سام بلاستيك» 2026-10-24

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** تحويل واجهة البرنامج إلى هوية «أزرق ملكي وذهبي» احترافية مع مشهد خط إنتاج متحرك، وإصلاح عدم استجابة تعديل الأصناف، وإعادة تنظيم التقارير مع اختيار الأعمدة (الوزن مخفي افتراضياً).

**Architecture:** تعديلات واجهة (CSS/HTML/JS في `renderer/`) فوق المعالجات الخلفية القائمة دون تغيير بنية قاعدة البيانات؛ استثناء وحيد هو معالج الأصناف `src/handlers/items.js` الذي يستوعب فروق الكميات في الحركة الافتتاحية ويعيد حساب الأوزان. التحريك CSS/SVG خالص بلا مكتبات.

**Tech Stack:** Electron 44.9.0، node:sqlite، وحدات ES في renderer، اختبارات `node --test`، لقطات فحص عبر SHOT_DIR مؤقت في main.js.

**Spec:** `docs/superpowers/specs/2026-10-24-redesign-warehouse-ui-design.md`

## Global Constraints

- لا وحدات أصلية: قاعدة البيانات عبر `node:sqlite` فقط، ولا يُضاف أي تبعية npm جديدة.
- التباين ملزم: نص داكن `#0f172a` على كل خلفية فاتحة؛ أبيض فقط على الأزرق الداكن؛ نص داكن `#3a2a07` على الذهبي `#d9a441`.
- الألوان: أساسي `#1e40af`، داكن `#14265c`/`#1e3a8a`، ذهبي `#d9a441`، خلفية `#f5f7fb`، نص `#0f172a`.
- الالتزامات git: `git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit` برسائل عربية conventional. لا تعديل لإعدادات git.
- الاختبارات: `cd "/c/Users/Elite/Desktop/سام بلاستيك" && export PATH="/c/Program Files/nodejs:$PATH" && node --test tests/*.test.js` — يجب أن تبقى 151+ خضراء.
- تشغيل الفحص البصري: `unset ELECTRON_RUN_AS_NODE && npx electron .` مع متغير SHOT_DIR مؤقت في main.js (يُزال بعد الالتقاط).
- فخ العربية: لا ZWNJ في النصوص؛ خانات التاريخ تحافظ على معالجة `.date-box` القائمة.
- القاعدة الحية ممسوحة بالفعل (التزام `a6e1f3d`) — أي فحص على مسار الحفظ يكون على قواعد اختبار فقط.

---

### Task 1: إصلاح معالج الأصناف الخلفي — تعديل الكميات والوزن لأصناف لها حركات

**Files:**
- Modify: `src/handlers/items.js` (دالة التسجيل `items:save` كاملة)
- Test: `tests/items.test.js` (إضافة 3 اختبارات في نهاية الملف)

**Interfaces:**
- Consumes: `getDb`, `withTransaction`, `audit` (موجودة)، `syncOpeningMoves(db, itemId, userId)` (في الملف نفسه).
- Produces: سلوك `items:save` الجديد — `qty_salem/qty_talef/qty_muharraz` مقبولة دائماً حتى مع حركات؛ خطأ عربي عند `الرصيد < صافي حركات السلة`؛ إعادة حساب `weight_in_kg/weight_out_kg` لكل حركات الصنف عند تغيير `weight_grams`؛ فرق الكميات يُستوعب في صف `doc_type='opening'` للسلة.

- [ ] **Step 1: اكتب الاختبارات الفاشلة**

ألحق بنهاية `tests/items.test.js`:

```js
// ===== تعديل صنف له حركات: الكميات والوزن ينتشران لكل ما يرتبط بالصنف =====

// ثبات: عداد كل سلة == صافي حركاتها (بكل المخازن)
function netOf(db, itemId, bucket) {
  return db.prepare(`SELECT COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) n
    FROM stock_moves WHERE item_id=? AND bucket=?`).get(itemId, bucket).n;
}

function seedMovedItem(db, h) {
  db.prepare("INSERT INTO warehouses (id, name) VALUES (1, 'المخزن الرئيسي')").run();
  const { id } = h['items:save'](null, {
    code: '201', name: 'عبوة اختبار', unit_name: 'حبة', weight_grams: 10, qty_salem: 1000,
  }, 1);
  // شراء +500 ثم صرف -200 (صافي 300) مع تحديث العداد يدوياً كالمعالجات الحقيقية
  db.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
    qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket) VALUES
    ('purchase', 1, 'P1', '2026-10-23', ?, 1, 500, 0, 5, 0, 'salem'),
    ('issue', 1, 'I1', '2026-10-23', ?, 1, 0, 200, 0, 2, 'salem')`).run(id, id);
  db.prepare('UPDATE items SET qty_salem = 1300 WHERE id=?').run(id);
  return id;
}

test('items:save على صنف له حركات: تعديل الكمية يستوعب الفرق في الافتتاح ويبقى العداد مطابقاً', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const id = seedMovedItem(db, h);
  // رفع السليم 1300 → 1500: الفرق +200 يُضاف للافتتاح (1000 + 200 = 1200)
  h['items:save'](null, {
    id, code: '201', name: 'عبوة اختبار', unit_name: 'حبة', weight_grams: 10, qty_salem: 1500,
  }, 1);
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=?').get(id).qty_salem, 1500);
  assert.equal(netOf(db, id, 'salem'), 1500, 'العداد يطابق صافي الحركات بعد التعديل');
  const op = db.prepare(`SELECT qty_in_pieces q FROM stock_moves
    WHERE doc_type='opening' AND item_id=? AND bucket='salem'`).get(id).q;
  assert.equal(op, 1200, 'الفرق يُستوعب في الحركة الافتتاحية');
  // خفض إلى 1400: الافتتاح ينقص إلى 1100
  h['items:save'](null, {
    id, code: '201', name: 'عبوة اختبار', unit_name: 'حبة', weight_grams: 10, qty_salem: 1400,
  }, 1);
  assert.equal(netOf(db, id, 'salem'), 1400);
  assert.equal(db.prepare(`SELECT qty_in_pieces q FROM stock_moves
    WHERE doc_type='opening' AND item_id=? AND bucket='salem'`).get(id).q, 1100);
});

test('items:save يرفض رصيداً أقل من صافي حركات السلة برسالة واضحة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const id = seedMovedItem(db, h);
  assert.throws(() => h['items:save'](null, {
    id, code: '201', name: 'عبوة اختبار', unit_name: 'حبة', weight_grams: 10, qty_salem: 100,
  }, 1), /أقل من صافي حركات/);
  // القاعدة لم تتغير بعد الرفض
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=?').get(id).qty_salem, 1300);
});

test('items:save: تغيير وزن الحبة يعيد حساب أوزان كل حركات الصنف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const id = seedMovedItem(db, h);
  // الوزن 10 → 20 جم: كل الحركات تُعاد أوزانها = الحبات × 20 / 1000
  h['items:save'](null, {
    id, code: '201', name: 'عبوة اختبار', unit_name: 'حبة', weight_grams: 20, qty_salem: 1300,
  }, 1);
  const p1 = db.prepare(`SELECT weight_in_kg w FROM stock_moves WHERE doc_number='P1'`).get().w;
  const i1 = db.prepare(`SELECT weight_out_kg w FROM stock_moves WHERE doc_number='I1'`).get().w;
  const op = db.prepare(`SELECT weight_in_kg w FROM stock_moves
    WHERE doc_type='opening' AND item_id=?`).get(id).w;
  assert.ok(Math.abs(p1 - 500 * 20 / 1000) < 1e-9, 'وزن الشراء مُعاد حسابه');
  assert.ok(Math.abs(i1 - 200 * 20 / 1000) < 1e-9, 'وزن الصرف مُعاد حسابه');
  assert.ok(Math.abs(op - 1000 * 20 / 1000) < 1e-9, 'وزن الافتتاح مُعاد حسابه');
});
```

- [ ] **Step 2: شغّل الاختبارات لتأكيد الفشل**

Run: `node --test tests/items.test.js`
Expected: الثلاثة الجدد FAIL (الكمية لا تتغير/لا خطأ/الأوزان كما هي).

- [ ] **Step 3: نفّذ الإصلاح في `src/handlers/items.js`**

استبدل كامل جسم `ipcMain.handle('items:save', ...)` (من سطر `const isNew = !row.id;` حتى `return { id };`) بالكود التالي:

```js
    const isNew = !row.id;
    const before = isNew ? null : db.prepare('SELECT * FROM items WHERE id=?').get(row.id);
    if (!isNew && !before) throw new Error('الصنف غير موجود');
    // الكميات قابلة للتعديل دائماً: لأصناف لها حركات يُستوعب الفرق في الحركة
    // الافتتاحية (الافتتاح = العداد − صافي الحركات) ويُعاد حساب الأوزان المخزنة.
    const hasMoves = !isNew && db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE item_id=? AND doc_type != 'opening'").get(row.id).c > 0;
    let id = row.id;
    const fields = {
      code, name, unit_name: unit,
      weight_grams: row.weight_grams || null,
      pieces_per_carton: row.pieces_per_carton || null,
      pieces_per_shadda: row.pieces_per_shadda || null,
      pieces_per_bag: row.pieces_per_bag || null,
      qty_salem: Number(row.qty_salem) || 0,
      qty_talef: Number(row.qty_talef) || 0,
      qty_muharraz: Number(row.qty_muharraz) || 0,
      is_complement: row.is_complement ? 1 : 0,
      notes: row.notes || null,
    };
    let netOf = () => 0;
    if (hasMoves) {
      const netRows = db.prepare(`SELECT bucket, COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) net
        FROM stock_moves WHERE doc_type != 'opening' AND item_id=? GROUP BY bucket`).all(row.id);
      netOf = (bucket) => { const r = netRows.find(x => x.bucket === bucket); return r ? r.net : 0; };
      for (const [key, label] of [['salem', 'سليم'], ['talef', 'تالف'], ['muharraz', 'محرز']]) {
        const counter = fields[`qty_${key}`];
        const net = netOf(key);
        if (counter < net) throw new Error(`رصيد ${label} المطلوب (${counter}) أقل من صافي حركات السلة (${net}) — اعكس الحركات أولاً أو ارفع الرصيد`);
      }
    }
    if (id) {
      db.prepare(`UPDATE items SET code=@code,name=@name,unit_name=@unit_name,weight_grams=@weight_grams,
        pieces_per_carton=@pieces_per_carton,pieces_per_shadda=@pieces_per_shadda,pieces_per_bag=@pieces_per_bag,
        qty_salem=@qty_salem,qty_talef=@qty_talef,qty_muharraz=@qty_muharraz,
        is_complement=@is_complement,notes=@notes WHERE id=@id`).run({ ...fields, id });
    } else {
      id = db.prepare(`INSERT INTO items (code,name,item_group,unit_name,weight_grams,pieces_per_carton,
        pieces_per_shadda,pieces_per_bag,qty_salem,qty_talef,qty_muharraz,is_complement,notes)
        VALUES (@code,@name,2,@unit_name,@weight_grams,@pieces_per_carton,@pieces_per_shadda,@pieces_per_bag,
        @qty_salem,@qty_talef,@qty_muharraz,@is_complement,@notes)`)
        .run(fields).lastInsertRowid;
    }
    if (hasMoves) {
      const qtyChanged = ['salem', 'talef', 'muharraz'].some(k => Number(before[`qty_${k}`]) !== fields[`qty_${k}`]);
      const weightChanged = Number(before.weight_grams || 0) !== Number(fields.weight_grams || 0);
      // وزن الحبة الجديد ينعكس على كل حركات الصنف المخزنة (الحبات × الوزن / 1000)
      if (weightChanged && Number(fields.weight_grams) > 0) {
        db.prepare(`UPDATE stock_moves SET weight_in_kg = qty_in_pieces * ? / 1000,
          weight_out_kg = qty_out_pieces * ? / 1000 WHERE item_id=?`).run(fields.weight_grams, fields.weight_grams, row.id);
      }
      // فرق الكميات يُستوعب في الحركة الافتتاحية لكل سلة
      if (qtyChanged || weightChanged) {
        const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
        if (wh) {
          const today = new Date().toISOString().slice(0, 10);
          const ins = db.prepare(`INSERT INTO stock_moves
            (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
             qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
            VALUES ('opening',?,?,?,?,?,?,0,?,0,?,?)`);
          const upd = db.prepare('UPDATE stock_moves SET qty_in_pieces=?, weight_in_kg=? WHERE id=?');
          for (const [key, label] of [['salem', 'سليم'], ['talef', 'تالف'], ['muharraz', 'محرز']]) {
            const qty = fields[`qty_${key}`] - netOf(key);
            const w = qty * (Number(fields.weight_grams) || 0) / 1000;
            const existing = db.prepare(`SELECT id FROM stock_moves
              WHERE doc_type='opening' AND item_id=? AND bucket=?`).get(row.id, key);
            if (qty > 0) {
              if (existing) upd.run(qty, w, existing.id);
              else ins.run(row.id, `افتتاحي-${fields.code}`, today, row.id, wh.id, qty, w, key, `رصيد افتتاحي (${label})`);
            } else if (existing) {
              db.prepare('DELETE FROM stock_moves WHERE id=?').run(existing.id);
            }
          }
          audit(db, userId, 'stock_write', 'opening', row.id, null, {
            resynced: true, qty_changed: qtyChanged, weight_changed: weightChanged,
          });
        }
      }
    } else {
      // الأرصدة الافتتاحية تنعكس كحركة مخزون حتى تظهر في الجرد والتقارير وتصبح قابلة للصرف والبيع
      syncOpeningMoves(db, id, userId);
    }
    audit(db, userId, isNew ? 'create' : 'update', 'item', id, before, fields);
    return { id };
```

ملاحظة: `syncOpeningMoves` تكتب صف افتتاح لكل سلة موجبة (من كمية العداد الكاملة — صحيح لأن الصنف بلا حركات). التعليق أعلى الدالة يبقى كما هو.

- [ ] **Step 4: شغّل الاختبارات لتأكيد النجاح**

Run: `node --test tests/items.test.js tests/fullcycle.test.js`
Expected: PASS بالكامل (الدورة الكاملة لا تتأثر لأنها لا تعدل أصنافاً لها حركات عبر items:save).

- [ ] **Step 5: Commit**

```bash
git add src/handlers/items.js tests/items.test.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "fix: تعديل كميات ووزن الأصناف ذات الحركات — الفرق يُستوعب في الافتتاح والأوزان تُعاد حسابها"
```

---

### Task 2: تحرير حقول الكميات في شاشة الأصناف

**Files:**
- Modify: `renderer/js/screens/items.js` (دالتا `collect` و`edit`)

**Interfaces:**
- Consumes: سلوك `items:save` الجديد من Task 1.
- Produces: `collect(back)` يرسل دائماً `qty_salem/qty_talef/qty_muharraz` أرقاماً (بلا `undefined`).

- [ ] **Step 1: عدّل `collect`**

استبدل:

```js
function collect(back) {
  const v = (id) => back.querySelector(`#${id}`)?.value ?? '';
  const locked = back.dataset.lock === '1';
  return {
    id: back.dataset.editId ? Number(back.dataset.editId) : null,
    code: digitsOnly(v('f-code')),
    name: v('f-name').trim(),
    unit_name: v('f-unit'),
    weight_grams: num(v('f-weight')) || null,
    pieces_per_carton: num(v('f-carton')) || null,
    pieces_per_shadda: num(v('f-shadda')) || null,
    pieces_per_bag: num(v('f-bag')) || null,
    qty_salem: locked ? undefined : (num(v('f-salem')) || 0),
    qty_talef: locked ? undefined : (num(v('f-talef')) || 0),
    qty_muharraz: locked ? undefined : (num(v('f-muharraz')) || 0),
    is_complement: back.querySelector('#f-complement')?.checked ? 1 : 0,
    notes: v('f-notes').trim() || null,
  };
}
```

بـ:

```js
function collect(back) {
  const v = (id) => back.querySelector(`#${id}`)?.value ?? '';
  return {
    id: back.dataset.editId ? Number(back.dataset.editId) : null,
    code: digitsOnly(v('f-code')),
    name: v('f-name').trim(),
    unit_name: v('f-unit'),
    weight_grams: num(v('f-weight')) || null,
    pieces_per_carton: num(v('f-carton')) || null,
    pieces_per_shadda: num(v('f-shadda')) || null,
    pieces_per_bag: num(v('f-bag')) || null,
    qty_salem: num(v('f-salem')) || 0,
    qty_talef: num(v('f-talef')) || 0,
    qty_muharraz: num(v('f-muharraz')) || 0,
    is_complement: back.querySelector('#f-complement')?.checked ? 1 : 0,
    notes: v('f-notes').trim() || null,
  };
}
```

- [ ] **Step 2: عدّل `edit` — إزالة التعطيل**

في `edit(row, onSaved)` استبدل:

```js
    function edit(row, onSaved) {
      const locked = !!row?.has_moves;
```

بـ:

```js
    function edit(row, onSaved) {
      const hasMoves = !!row?.has_moves;
```

وفي قالب النموذج استبدل الحقول الثلاثة المعطلة:

```js
          <div class="field"><label>رصيد افتتاحي سليم</label><input id="f-salem" inputmode="numeric" value="${esc(row?.qty_salem || '')}" ${locked ? 'disabled' : ''}></div>
          <div class="field"><label>رصيد افتتاحي تالف</label><input id="f-talef" inputmode="numeric" value="${esc(row?.qty_talef || '')}" ${locked ? 'disabled' : ''}></div>
          <div class="field"><label>رصيد افتتاحي محرز</label><input id="f-muharraz" inputmode="numeric" value="${esc(row?.qty_muharraz || '')}" ${locked ? 'disabled' : ''}></div>
```

بـ:

```js
          <div class="field"><label>رصيد سليم الحالي</label><input id="f-salem" inputmode="numeric" value="${esc(row?.qty_salem || '')}"></div>
          <div class="field"><label>رصيد تالف الحالي</label><input id="f-talef" inputmode="numeric" value="${esc(row?.qty_talef || '')}"></div>
          <div class="field"><label>رصيد محرز الحالي</label><input id="f-muharraz" inputmode="numeric" value="${esc(row?.qty_muharraz || '')}"></div>
```

واستبدل فقرة التلميح الشرطية:

```js
        ${locked
          ? '<p class="muted" style="margin:10px 0 0">هذا الصنف له حركات مخزون، لذلك تُحدَّث كميات سليم/تالف/محرز تلقائياً من المستندات ولا يمكن تعديلها يدوياً.</p>'
          : '<p class="muted" style="margin:10px 0 0">الأرصدة الافتتاحية تُسجَّل كحركة مخزون في «المخزن الرئيسي» وتظهر فوراً في الجرد والتقارير وتصبح قابلة للصرف والبيع.</p>'}
```

بـ:

```js
        ${hasMoves
          ? '<p class="muted" style="margin:10px 0 0">لهذا الصنف حركات مخزون: تعديل الكميات يضبط الرصيد الافتتاحي تلقائياً ويظهر فوراً في كل التقارير والمخازن، ولا يُقبل رصيد أقل من صافي حركات السلة.</p>'
          : '<p class="muted" style="margin:10px 0 0">الأرصدة الافتتاحية تُسجَّل كحركة مخزون في «المخزن الرئيسي» وتظهر فوراً في الجرد والتقارير وتصبح قابلة للصرف والبيع.</p>'}
```

واستبدل نهاية الدالة:

```js
      if (row) back.dataset.editId = String(row.id);
      if (locked) back.dataset.lock = '1';
```

بـ:

```js
      if (row) back.dataset.editId = String(row.id);
```

- [ ] **Step 3: تحقق من عدم بقاء مراجع `locked`**

Run: `grep -n "locked\|dataset.lock" renderer/js/screens/items.js`
Expected: لا نتائج.

- [ ] **Step 4: Commit**

```bash
git add renderer/js/screens/items.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: تحرير حقول كميات الأصناف دائماً مع تلميح استيعاب الفرق في الافتتاح"
```

---

### Task 3: إعادة تنظيم التقارير — تبويبات واختيار أعمدة (الوزن مخفي افتراضياً)

**Files:**
- Modify: `renderer/js/screens/reports.js` (إعادة كتابة `mount` بالكامل مع بقاء `REPORTS` بتعديلات الأعمدة)

**Interfaces:**
- Consumes: `api.invoke('reports:'+kind, filters)` — أشكال البيانات كما في `src/handlers/reports.js` (بدون تغيير خلفي).
- Produces: `REPORTS[kind].columns` بكل عمود `{ key, label, cell, weight? }`؛ التخزين `localStorage['report-cols:'+kind]` مصفوفة مفاتيح JSON.

- [ ] **Step 1: أضف `key` و`weight` لكل أعمدة REPORTS**

في تعريفات `REPORTS` أضف لكل عمود `key`، وعلّم أعمدة الوزن بـ `weight: true`:

- inventory: `{ key: 'code', ... }`, `name`, `unit_name`, `balance_label`, `qty_salem`, `qty_talef`, `qty_muharraz`, ثم `{ key: 'balance_kg', label: 'الوزن كجم', weight: true, cell: r => N(r.balance_kg, 2) }`.
- movement: `doc_date`, `doc_type`, `doc_number`, `item`, `warehouse_name`, `qty_in_pieces`, `qty_out_pieces`, `balance_label`, ثم ثلاثة أعمدة وزن `weight: true` بمفاتيح `weight_in_kg` و`weight_out_kg` و`balance_kg`.
- production: `result_date`, `carton_number`, `item`, `issue_number`, `machine_name`, `shift_name`, `good_pieces`, `defect_before`, `defect_after`, `total_pieces`, `notes` (بلا وزن).
- scrap: `doc_number`, `doc_date`, `item`, `disposition`, `warehouse_name`, `party_name`, `pieces`, ثم `{ key: 'weight_kg', label: 'الوزن كجم', weight: true, cell: r => N(r.weight_kg, 2) }`, `price`.
- purchases: `doc_number`, `doc_date`, `party_name`, `total_pieces`, `total` (بلا وزن).
- audit: `created_at`, `user_name`, `action`, `entity`, `entity_id` (بلا وزن).

مثال للعمود `item` في movement (موجود حالياً بمفتاح ضمني): أضف `key: 'item'`.

- [ ] **Step 2: أعد كتابة `mount`**

استبدل كامل `async mount(el)` بدالة جديدة (مع بقاء مساعدات `dateInput/selectHtml/tableHtml/N` كما هي):

```js
  async mount(el) {
    const [items, warehouses, parties, machines, users] = await Promise.all([
      api.invoke('items:list'),
      api.invoke('warehouses:list'),
      api.invoke('parties:list'),
      api.invoke('machines:list'),
      api.invoke('users:list'),
    ]);
    // تعريفات التقارير والفلاتر والأعمدة كما كانت (انظر أعلى الملف) ...

    const COL_KEY = (kind) => `report-cols:${kind}`;
    const visibleOf = (kind) => {
      const all = REPORTS[kind].columns;
      try {
        const saved = JSON.parse(localStorage.getItem(COL_KEY(kind)) || 'null');
        if (Array.isArray(saved)) {
          const keys = saved.filter(k => all.some(c => c.key === k));
          if (keys.length) return keys;
        }
      } catch { /* تجاهل */ }
      return all.filter(c => !c.weight).map(c => c.key);
    };
    const saveCols = (kind, keys) => localStorage.setItem(COL_KEY(kind), JSON.stringify(keys));

    let kind = 'inventory';
    let last = null;

    el.innerHTML = `
      <div class="report-tabs" id="r-tabs"></div>
      <div class="card">
        <div class="toolbar" id="filters"></div>
        <div class="toolbar">
          <button class="btn primary" id="btn-run">عرض التقرير</button>
          <button class="btn" id="btn-cols">الأعمدة</button>
          <span class="spacer"></span>
          <button class="btn" id="btn-print" disabled>طباعة A4</button>
          <button class="btn" id="btn-export" disabled>تصدير CSV</button>
        </div>
        <div id="table-wrap"></div>
      </div>`;

    const tabsEl = el.querySelector('#r-tabs');
    const filtersEl = el.querySelector('#filters');
    const tableWrap = el.querySelector('#table-wrap');
    const btnPrint = el.querySelector('#btn-print');
    const btnExport = el.querySelector('#btn-export');

    function renderTabs() {
      tabsEl.innerHTML = Object.entries(REPORTS)
        .map(([k, r]) => `<button class="tab-btn${k === kind ? ' active' : ''}" data-kind="${k}">${esc(r.label)}</button>`)
        .join('');
      tabsEl.querySelectorAll('.tab-btn').forEach(b => {
        b.onclick = () => { kind = b.dataset.kind; renderTabs(); renderFilters(); run(); };
      });
    }
    function renderFilters() {
      filtersEl.innerHTML = `<div class="form-grid inline">${REPORTS[kind].filterHtml()}</div>`;
    }
    function visibleCols() {
      const keys = visibleOf(kind);
      return REPORTS[kind].columns.filter(c => keys.includes(c.key));
    }
    async function run() {
      const r = REPORTS[kind];
      const cols = visibleCols();
      try {
        const data = await api.invoke('reports:' + kind, r.getFilters(el));
        const rows = Array.isArray(data) ? data : data.rows;
        last = { kind, data, cols, cells: rows.map(row => cols.map(c => c.cell(row))) };
        tableWrap.innerHTML = tableHtml(cols, last.cells);
        if (r.foot) tableWrap.insertAdjacentHTML('beforeend', r.foot(data));
        btnPrint.disabled = false;
        btnExport.disabled = false;
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    // نافذة اختيار الأعمدة: خانات اختيار لكل تقرير، أعمدة الوزن غير مفعلة افتراضياً
    el.querySelector('#btn-cols').onclick = () => {
      const cols = REPORTS[kind].columns;
      const keys = visibleOf(kind);
      const back = openModal('الأعمدة الظاهرة في التقرير', `
        <p class="muted" style="margin:0 0 10px">اختر الأعمدة التي تظهر في جدول التقرير وطباعته وتصديره — تُحفظ اختياراتك لكل تقرير.</p>
        ${cols.map(c => `<label class="col-line"><input type="checkbox" data-key="${esc(c.key)}" ${keys.includes(c.key) ? 'checked' : ''}>
          ${esc(c.label)}${c.weight ? ' <span class="tag muharraz">وزن</span>' : ''}</label>`).join('')}
      `, [
        {
          label: 'حفظ', class: 'primary',
          onClick: async (b) => {
            const picked = [...b.querySelectorAll('input[data-key]:checked')].map(i => i.dataset.key);
            if (!picked.length) { toast('اختر عموداً واحداً على الأقل', 'err'); return; }
            saveCols(kind, picked);
            b.remove();
            await run();
            toast('تم حفظ اختيار الأعمدة', 'ok');
          },
        },
        {
          label: 'الافتراضي',
          onClick: async (b) => {
            localStorage.removeItem(COL_KEY(kind));
            b.remove();
            await run();
            toast('عاد التقرير للأعمدة الافتراضية (بدون الوزن)', 'ok');
          },
        },
        { label: 'إلغاء', onClick: (b) => b.remove() },
      ]);
    };

    renderTabs();
    renderFilters();
    el.querySelector('#btn-run').onclick = run;

    btnPrint.onclick = async () => {
      if (!last) return;
      try {
        const settings = await api.invoke('settings:get');
        await api.invoke('print:open', {
          kind: 'report',
          title: REPORTS[last.kind].label,
          metaLines: ['تاريخ الطباعة: ' + new Date().toLocaleString('ar')],
          headers: last.cols.map(c => c.label),
          rows: last.cells.map(row => row.map(v => esc(v))),
          foot: REPORTS[last.kind].foot ? REPORTS[last.kind].foot(last.data) : '',
          settings,
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    btnExport.onclick = async () => {
      if (!last) return;
      try {
        const res = await api.invoke('reports:export', {
          defaultName: `${REPORTS[last.kind].label}.csv`,
          columns: last.cols.map(c => c.label),
          rows: last.cells,
        });
        if (res.ok) toast('تم التصدير: ' + res.path, 'ok');
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    await run();
  },
```

ملاحظات تنفيذية:
- استورد `openModal` من `../ui.js` في أعلى الملف (سطر الاستيراد الحالي: `import { toast, esc } from '../ui.js';` → أضف `openModal`).
- الفلاتر تُقرأ من `el` كله كما الآن (`r.getFilters(el)` يبحث بـ `#r-warehouse` إلخ داخل شريط الفلاتر)، والأسماء تبقى كما هي.
- أبقِ متغيرات `items, warehouses, parties, machines, users` داخل `mount` كما هي، فـ`filterHtml` بحاجة إليها.
- `tableHtml(columns, rows)` يبقى كما هو — الأعمدة الممررة هي `cols` المرئية فقط.

- [ ] **Step 3: تحقق سريع بالتشغيل التجريبي (اختبار يدوي منطقي)**

لا توجد اختبارات آلية للواجهة هنا؛ تحقق بالقراءة أن كل `filterHtml` يستخدم معرّفات فريدة (`r-warehouse` يتكرر بين inventory وmovement — مقبول لأنهما لا يعرضان معاً، والشاشة تعيد بناء الفلاتر عند تبديل التبويب).

- [ ] **Step 4: Commit**

```bash
git add renderer/js/screens/reports.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: تقارير بتبويبات واختيار أعمدة محفوظ — الوزن مخفي افتراضياً"
```

---

### Task 4: الهوية البصرية الجديدة (أزرق ملكي وذهبي) لكل الشاشات

**Files:**
- Modify: `renderer/css/app.css` (تعديلات مستهدفة + فئات جديدة)

**Interfaces:**
- Consumes: أسماء الفئات القائمة في `app.html` وكل شاشات `renderer/js/screens/*.js` — لا تتغير أسماؤها.
- Produces: فئات جديدة تستخدمها Task 3 (`report-tabs`, `tab-btn`, `col-line`) وTask 5 (`factory-scene`, `factory-strip` وعناصرها).

- [ ] **Step 1: استبدل متغيرات الجذر والجسم**

استبدل كتلة `:root {...}` و`body {...}` بـ:

```css
:root {
  --bg: #f5f7fb;
  --card: #ffffff;
  --primary: #1e40af;
  --primary-dark: #1e3a8a;
  --primary-soft: #e4edff;
  --accent: #3b82f6;
  --gold: #d9a441;
  --gold-soft: #fdf4e3;
  --navy-1: #14265c;
  --navy-2: #1e3a8a;
  --text: #0f172a;
  --muted: #475569;
  --border: #dbe3f0;
  --danger: #dc2626;
  --ok: #16a34a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: "Segoe UI", "Segoe UI Variable", Tahoma, Arial, sans-serif;
  background: var(--bg); color: var(--text); font-size: 14px;
}
```

- [ ] **Step 2: الشريط الجانبي وترويسات النوافذ**

- `.sidebar` الخلفية: `linear-gradient(180deg, #1e3a8a, #14265c 70%, #0f1e4d)`.
- `.nav-group` اللون: `#e5c988` (تدرج ذهبي فاتح على الأزرق الداكن — تباين مقبول).
- `.nav-item.active`: الخلفية `linear-gradient(90deg, rgba(217,164,65,.18), rgba(217,164,65,.04))` والخط `#fff`، و`::before` بلون `var(--gold)` وظل `0 0 9px rgba(217,164,65,.7)`.
- `.brand-logo` التدرج: `linear-gradient(135deg, #4f7df0, #1e40af 58%, #14265c)`.
- `.win-bar` و`.modal-head` التدرج: `linear-gradient(115deg, #14265c, #1e3a8a 60%, #2b55d4)` مع بقاء الحد الذهبي.
- `.page-help` الخلفية: `linear-gradient(180deg, #1e3a8a, #14265c)`.

- [ ] **Step 3: البطاقات والجداول والحقول**

- `.card`: أضف `border-top: 2px solid var(--gold);` وظل `0 2px 8px rgba(15,23,42,.07)`.
- `.page-head h2::before`: `linear-gradient(180deg, #e7b95c, #d9a441)`.
- `table.data th`: الخلفية `#e8eefc`، اللون `#1e3a8a`، الحد السفلي `2px solid #c7d7f7`. أضف قاعدة جديدة:

```css
table.data tbody tr:nth-child(even) { background: #f8fafc; }
table.data tbody tr:hover { background: #eef3ff; }
```

(استبدل قاعدة `tbody tr:hover` الحالية).
- `table.data th` في `.doc-lines` بنفس الألوان.
- `input, select, textarea`: الخلفية `#fff`، و`:focus` الظل `0 0 0 3px rgba(30, 64, 175, .16)`.

- [ ] **Step 4: الأزرار والأقراص**

- `.btn.primary`: `linear-gradient(180deg, #2b55d4, #1e40af)` وظل `rgba(30,64,175,.35)`.
- أضف زراً ذهبياً جديداً بعد `.btn.primary`:

```css
.btn.gold {
  background: linear-gradient(180deg, #e7b95c, #d9a441);
  border-color: transparent; color: #3a2a07;
  box-shadow: 0 2px 7px rgba(217, 164, 65, .4);
}
.btn.gold:hover { filter: brightness(1.06); box-shadow: 0 5px 14px rgba(217, 164, 65, .5); }
```

- `.pill.active`: `linear-gradient(180deg, #2b55d4, #1e40af)`.
- `.guide-btn`: `linear-gradient(180deg, #2b55d4, #1e40af)`.
- `.stat .icon.t1`: الخلفية `#e4edff` واللون `#1e40af`؛ `.t2`: الخلفية `#fdf4e3` واللون `#b7791f`.
- ألوان رسومات الرئيسية في `renderer/js/screens/dashboard.js`: سلسلة المشتريات `#3b6cf0` → `#1e40af`، والمحرز في الدونات `#6d28d9` → `#d9a441` (عدّل سطرَي `color` في `renderCharts`).

- [ ] **Step 5: صفحة الدخول — إزاحة الألوان للملكي**

- `.login-body` الخلفية: `linear-gradient(160deg, #10204f, #0a1536 62%, #060d24)` مع بقاء التدرجين الشعاعيين (استبدل `rgba(63,116,255,...)` → `rgba(59,130,246,...)`).
- `.login-card::before` التدرج: `linear-gradient(115deg, #1e40af, #3b82f6, #d9a441, #1e40af)`.
- `.login-logo` التدرج: `linear-gradient(135deg, #4f7df0, #1e40af 58%, #14265c)`.
- زر الدخول: `linear-gradient(115deg, #2b55d4, #1e40af 55%, #2b55d4)`.

- [ ] **Step 6: فئات جديدة (تبويبات التقارير + نافذة الأعمدة + خط الإنتاج)**

أضف في نهاية الملف (قبل `@media (prefers-reduced-motion)` إن وُجد، أو في النهاية):

```css
/* ===== تبويبات التقارير واختيار الأعمدة ===== */
.report-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.tab-btn {
  position: relative; overflow: hidden;
  padding: 9px 18px; border-radius: 10px 10px 0 0;
  border: 1px solid var(--border); border-bottom: none;
  background: #fff; color: var(--muted);
  font-size: 13.5px; font-weight: 700; font-family: inherit; cursor: pointer;
  transition: background .15s ease, color .15s ease, transform .15s ease;
}
.tab-btn:hover { color: var(--primary); transform: translateY(-1px); }
.tab-btn.active {
  background: linear-gradient(180deg, #2b55d4, #1e40af); color: #fff;
  border-color: transparent; box-shadow: 0 3px 10px rgba(30, 64, 175, .35);
}
.col-line {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px;
  margin-bottom: 7px; font-size: 13.5px; color: var(--text); cursor: pointer;
  background: #fff; transition: background .15s ease, border-color .15s ease;
}
.col-line:hover { background: var(--primary-soft); border-color: #b9ccff; }
.col-line input { width: auto; accent-color: #1e40af; }

/* ===== مشهد خط الإنتاج (الدخول + شريط الرئيسية) ===== */
.factory-scene {
  position: absolute; bottom: 0; left: 0; right: 0; height: 235px;
  z-index: 1; pointer-events: none; opacity: .92;
}
.factory-scene svg { width: 100%; height: 100%; display: block; }
.factory-strip {
  height: 66px; overflow: hidden; position: relative;
  border-radius: 12px; margin-bottom: 16px;
  background: linear-gradient(90deg, #10204f, #1e3a8a 50%, #10204f);
  border-bottom: 2px solid var(--gold);
  box-shadow: 0 4px 14px rgba(15, 23, 42, .18);
}
.factory-strip svg { width: 100%; height: 100%; display: block; }
.fx-belt { stroke: rgba(255,255,255,.35); stroke-dasharray: 10 8; animation: fxBelt .9s linear infinite; }
@keyframes fxBelt { to { stroke-dashoffset: -18; } }
.fx-bottle { animation: fxRun 7s linear infinite; }
.fx-bottle.b2 { animation-delay: -2.3s; }
.fx-bottle.b3 { animation-delay: -4.6s; }
.fx-bottle.b4 { animation-delay: -5.8s; }
@keyframes fxRun {
  0% { transform: translateX(-120px); }
  100% { transform: translateX(calc(100vw + 120px)); }
}
.fx-gear { transform-origin: center; animation: fxSpin 6s linear infinite; }
.fx-gear.slow { animation-duration: 9s; animation-direction: reverse; }
@keyframes fxSpin { to { transform: rotate(360deg); } }
.fx-oven { animation: fxGlow 2.8s ease-in-out infinite; }
@keyframes fxGlow { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
.fx-mold { animation: fxMold 2.6s ease-in-out infinite; }
@keyframes fxMold { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(14deg); } }
@media (prefers-reduced-motion: reduce) {
  .factory-scene *, .factory-strip *, .factory-scene *::after, .factory-strip *::after { animation: none !important; }
}
```

- [ ] **Step 7: Commit**

```bash
git add renderer/css/app.css renderer/js/screens/dashboard.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: هوية بصرية جديدة — أزرق ملكي وذهبي مع تباين صارم لكل الشاشات"
```

---

### Task 5: مشهد خط الإنتاج المتحرك — الدخول + شريط الرئيسية

**Files:**
- Modify: `renderer/index.html` (إضافة مشهد SVG خلف بطاقة الدخول)
- Modify: `renderer/js/screens/dashboard.js` (إدراج الشريط أعلى `mount`)
- Modify: `renderer/js/login.js` (ألوان الجزيئات فقط — اختياري)

**Interfaces:**
- Consumes: فئات CSS من Task 4 (`factory-scene`, `fx-*`).
- Produces: عناصر SVG بمعرّفات لا تتعارض مع أي شاشة أخرى.

- [ ] **Step 1: أضف المشهد إلى `renderer/index.html`**

بعد وسم `</div>` الخاص بـ `.login-bg` (سطر `</div>` الذي يغلق `<div class="login-bg">`) أدخل:

```html
  <div class="factory-scene" aria-hidden="true">
    <svg viewBox="0 0 1440 235" preserveAspectRatio="xMidYMax slice" fill="none">
      <!-- فرن التسخين -->
      <g>
        <rect x="80" y="40" width="170" height="120" rx="14" fill="#0d1a40" stroke="rgba(122,158,255,.25)"/>
        <circle class="fx-oven" cx="165" cy="100" r="42" fill="url(#ovenGrad)"/>
        <defs>
          <radialGradient id="ovenGrad"><stop offset="0%" stop-color="#ffd98a"/><stop offset="55%" stop-color="#d9a441"/><stop offset="100%" stop-color="rgba(217,164,65,0)"/></radialGradient>
        </defs>
      </g>
      <!-- المكينة 1: قالبان يفتحان ويغلقان -->
      <g>
        <rect x="330" y="55" width="150" height="105" rx="12" fill="#0d1a40" stroke="rgba(122,158,255,.25)"/>
        <g class="fx-mold" style="transform-origin:405px 108px">
          <path d="M382 60 h30 v48 a16 16 0 0 1 -16 16 h-14 z" fill="#2b55d4" stroke="#7fa6f5" stroke-width="2"/>
        </g>
        <g class="fx-mold" style="transform-origin:428px 108px; animation-direction:reverse">
          <path d="M428 60 h30 v48 a16 16 0 0 0 -16 16 h-14 z" fill="#1e40af" stroke="#7fa6f5" stroke-width="2"/>
        </g>
        <rect x="390" y="132" width="50" height="6" rx="3" fill="#d9a441"/>
      </g>
      <!-- المكينة 2 -->
      <g>
        <rect x="1150" y="55" width="150" height="105" rx="12" fill="#0d1a40" stroke="rgba(122,158,255,.25)"/>
        <g class="fx-mold" style="transform-origin:1225px 108px">
          <path d="M1202 60 h30 v48 a16 16 0 0 1 -16 16 h-14 z" fill="#2b55d4" stroke="#7fa6f5" stroke-width="2"/>
        </g>
        <g class="fx-mold" style="transform-origin:1248px 108px; animation-direction:reverse">
          <path d="M1248 60 h30 v48 a16 16 0 0 0 -16 16 h-14 z" fill="#1e40af" stroke="#7fa6f5" stroke-width="2"/>
        </g>
        <rect x="1210" y="132" width="50" height="6" rx="3" fill="#d9a441"/>
      </g>
      <!-- السير الناقل والعبوات -->
      <line class="fx-belt" x1="0" y1="196" x2="1440" y2="196" stroke-width="4"/>
      <line x1="0" y1="204" x2="1440" y2="204" stroke="rgba(122,158,255,.18)" stroke-width="14"/>
      <g class="fx-bottle"><path d="M0 0 l2 10 v38 a9 9 0 0 1 -9 9 h-1 a9 9 0 0 1 -9 -9 v-38 z" transform="translate(60,142) scale(1.1)" fill="#3b82f6" stroke="#9db9f5" stroke-width="1.5"/></g>
      <g class="fx-bottle b2"><path d="M0 0 l2 10 v30 a8 8 0 0 1 -8 8 h-1 a8 8 0 0 1 -8 -8 v-30 z" transform="translate(40,150) scale(1.3)" fill="#d9a441" stroke="#f0d9a8" stroke-width="1.5"/></g>
      <g class="fx-bottle b3"><path d="M0 0 l2 10 v38 a9 9 0 0 1 -9 9 h-1 a9 9 0 0 1 -9 -9 v-38 z" transform="translate(60,142) scale(.95)" fill="#2b55d4" stroke="#9db9f5" stroke-width="1.5"/></g>
      <g class="fx-bottle b4"><path d="M0 0 l2 10 v30 a8 8 0 0 1 -8 8 h-1 a8 8 0 0 1 -8 -8 v-30 z" transform="translate(40,150) scale(1.15)" fill="#3b82f6" stroke="#9db9f5" stroke-width="1.5"/></g>
      <!-- تروس -->
      <g class="fx-gear" style="transform-origin:520px 175px">
        <circle cx="520" cy="175" r="16" stroke="#d9a441" stroke-width="5" stroke-dasharray="6 5"/>
        <circle cx="520" cy="175" r="6" fill="#d9a441"/>
      </g>
      <g class="fx-gear slow" style="transform-origin:900px 175px">
        <circle cx="900" cy="175" r="12" stroke="#d9a441" stroke-width="5" stroke-dasharray="5 4"/>
        <circle cx="900" cy="175" r="4.5" fill="#d9a441"/>
      </g>
    </svg>
  </div>
```

- [ ] **Step 2: أدرج الشريط في `renderer/js/screens/dashboard.js`**

في `mount`، قبل سطر `<div class="stats">` أضف:

```html
      <div class="factory-strip" aria-hidden="true">
        <svg viewBox="0 0 1440 66" preserveAspectRatio="xMidYMid slice" fill="none">
          <line class="fx-belt" x1="0" y1="46" x2="1440" y2="46" stroke-width="3"/>
          <line x1="0" y1="52" x2="1440" y2="52" stroke="rgba(122,158,255,.16)" stroke-width="10"/>
          <g class="fx-bottle"><path d="M0 0 l2 9 v26 a7 7 0 0 1 -7 7 h-1 a7 7 0 0 1 -7 -7 v-26 z" transform="translate(30,12) scale(.9)" fill="#d9a441" stroke="#f0d9a8" stroke-width="1.5"/></g>
          <g class="fx-bottle b2"><path d="M0 0 l2 9 v26 a7 7 0 0 1 -7 7 h-1 a7 7 0 0 1 -7 -7 v-26 z" transform="translate(30,12)" fill="#3b82f6" stroke="#9db9f5" stroke-width="1.5"/></g>
          <g class="fx-bottle b3"><path d="M0 0 l2 9 v26 a7 7 0 0 1 -7 7 h-1 a7 7 0 0 1 -7 -7 v-26 z" transform="translate(30,14) scale(1.1)" fill="#2b55d4" stroke="#9db9f5" stroke-width="1.5"/></g>
          <g class="fx-gear" style="transform-origin:640px 33px">
            <circle cx="640" cy="33" r="11" stroke="#d9a441" stroke-width="4.5" stroke-dasharray="5 4"/>
            <circle cx="640" cy="33" r="4" fill="#d9a441"/>
          </g>
          <g class="fx-gear slow" style="transform-origin:820px 33px">
            <circle cx="820" cy="33" r="8" stroke="#d9a441" stroke-width="4.5" stroke-dasharray="4 3"/>
            <circle cx="820" cy="33" r="3" fill="#d9a441"/>
          </g>
        </svg>
      </div>
```

- [ ] **Step 3: ألوان جزيئات الدخول (اختياري)**

في `renderer/js/login.js` استبدل سطر الألوان:

```js
  const colors = ['rgba(151,184,255,.6)', 'rgba(122,158,255,.4)', 'rgba(217,164,65,.5)'];
```

بـ:

```js
  const colors = ['rgba(127,166,245,.6)', 'rgba(217,164,65,.5)', 'rgba(255,214,130,.4)'];
```

- [ ] **Step 4: Commit**

```bash
git add renderer/index.html renderer/js/screens/dashboard.js renderer/js/login.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: مشهد خط إنتاج متحرك في الدخول وشريط علوي متحرك في الرئيسية"
```

---

### Task 6: الفحص الشامل — اختبارات، لقطات بصرية، إعادة تشغيل، إبلاغ

**Files:**
- Modify: `main.js` (خطاف SHOT_DIR مؤقت — يُضاف ثم يُزال قبل الالتزام النهائي)

**Interfaces:**
- Consumes: كل المهام السابقة.
- Produces: لقطات PNG تحت `%TEMP%\samplastic-shots\` للفحص البصري، ثم إزالة الخطاف.

- [ ] **Step 1: الاختبارات الكاملة**

Run: `node --test tests/*.test.js`
Expected: كلها PASS (151 + 3 الجديدة = 154).

- [ ] **Step 2: خطاف اللقطات المؤقت**

أضف في `main.js` داخل `whenReady` (بعد إنشاء `mainWin`) الخطاف المعتاد: إذا وُجد متغير البيئة `SHOT_DIR`:
1. عند `did-finish-load`: (مرحلة 0) نفّذ دخول `admin/admin123` عبر `executeJavaScript` ثم بعد 900ms انتقل إلى `app.html`؛ (مرحلة 1) التقط لقطة الصفحة عبر `capturePage` مع 5 محاولات (تأخير 500ms لـ UnknownVizError)، ثم انتقل بشاشات `dashboard`, `items`, `reports` بالضغط على `.nav-item[data-screen=...]` والتقط لقطة لكل واحدة.
2. احفظ اللقطات في `shotDir` بأسماء `01-login.png`, `02-dashboard.png`, `03-items.png`, `04-reports.png`.

- [ ] **Step 3: التشغيل والتقاط**

Run: `SHOT_DIR="$TEMP/samplastic-shots2" unset ELECTRON_RUN_AS_NODE && npx electron .` (ثم أغلق تلقائياً بعد الالتقاط أو `taskkill //IM electron.exe //F`)
Expected: 4 لقطات محفوظة.

- [ ] **Step 4: الفحص البصري بالقراءة**

Read كل لقطة (تصغيرها بـ PowerShell System.Drawing إلى 60% إن تجاوزت 60 ثانية قراءة) وتأكد من:
1. صفحة الدخول: مشهد المكاين والسير ظاهر خلف البطاقة، الألوان ملكية/ذهبية، النص أبيض واضح.
2. الرئيسية: الشريط المتحرك أعلى الصفحة، بطاقات بحدود ذهبية، نص داكن على خلفية فاتحة.
3. الأصناف: فتح نموذج تعديل لصنف له حركات (إن وُجد) — الحقول نشطة بلا تعطيل.
4. التقارير: تبويبات ظاهرة، نافذة «الأعمدة» تعمل، أعمدة الوزن غير ظاهرة افتراضياً.

إن ظهرت مشكلة بصرية: سجّلها، أصلحها بأقل تغيير، أعد الالتقاط.

- [ ] **Step 5: إزالة الخطاف والالتزام الأخير**

احذف كتلة SHOT_DIR من `main.js` بالكامل وأعد `git diff main.js` للتأكد أنها نظيفة.

```bash
git add -A main.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "chore: إزالة خطاف لقطات الفحص المؤقت"
```

- [ ] **Step 6: إعادة التشغيل للمستخدم**

Run: `unset ELECTRON_RUN_AS_NODE && npx electron .` في الخلفية وانتظر حتى إقلاع النافذة، ثم أبلغ المستخدم بتقرير عربي واحد شامل (ما تم، النتائج، والملاحظات) حسب ذاكرة «أكمل الكل ثم أبلغ».

---

## Self-Review Notes

- **Spec coverage:** أولاً→Task 4؛ ثانياً→Task 5؛ ثالثاً→Tasks 1-2؛ رابعاً→Task 3؛ خامساً (نطاق)→Task 6 والتزامات كل مهمة.
- **Placeholder scan:** لا TBD؛ كل خطوة تحمل الكود الفعلي أو الأمر الفعلي.
- **Type consistency:** `visibleOf/visibleCols/saveCols/COL_KEY` معرفة في Task 3 وتُستخدم داخله فقط؛ فئات `fx-*` معرفة في Task 4 وتُستخدم في Task 5؛ `resync` في Task 1 لا يصدر أسماء يستخدمها غيرها.
- **تتابع:** Task 1→2 (الواجهة تعتمد السلوك الخلفي)، 3 و4 مستقلان، 5 يعتمد 4، 6 أخير.
