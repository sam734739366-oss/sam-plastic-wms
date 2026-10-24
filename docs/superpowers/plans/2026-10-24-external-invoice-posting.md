# خطة تنفيذ ترحيل الفواتير الخارجة ومرتجعاتها

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** إضافة شاشتي «ترحيل الفواتير» و«مرتجعات الفواتير» لمجموعة «المبيعات» تعملان على معالجات الفواتير والمرتجعات الجاهزة، بأسعار اختيارية (بلا أسعار = أثر مخزني فقط).

**Architecture:** واجهة جديدة فوق خلفية موجودة ومُختبَرة (sales:*/returns:*). تعديلات خلفية محدودة بعمود `total_pieces` في `sales:list` و`reports:sales`. شاشتان جديدتان بنمط الشاشات الحالية (router register + openModal + itemCombo)، وتبويب «فواتير» في التقارير.

**Tech Stack:** Electron 44.9.0، node:sqlite، وحدات ES في renderer، node --test في الخلفية.

**Spec:** `docs/superpowers/specs/2026-10-24-external-invoice-posting-design.md`

## Global Constraints

- ممنوع أي وحدات أصلية أو MSVC — node:sqlite فقط.
- الالتزام حصراً عبر `git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit` برسائل عربية conventional؛ ممنوع تعديل إعدادات git.
- ممنوع الالتزام بملفات النسخ الاحتياطي (data/، *.tar.gz، .shots/).
- ممنوع كتابة بيانات تجريبية في القاعدة الحية؛ الفحص البصري يلتقط شاشات فقط بلا حفظ.
- رندرر ES modules: فحص صياغة أي ملف جديد عبر نسخه إلى /tmp/س.mjs ثم `node --check`.
- هوية التصميم: أزرق ملكي #1e40af + ذهبي #d9a441 على فاتح #f5f7fb، نص داكن #0f172a، وتباين صارم.
- الاختبارات: `node --test tests/*.test.js` (154 حالياً) يجب أن تبقى كلها خضراء.

---

### Task 1: عمود الحبات في قوائم الفواتير (خلفية)

**Files:**
- Modify: `src/handlers/sales.js:23-28` (استعلام sales:list)
- Modify: `src/handlers/reports.js:127-133` (استعلام reports:sales)
- Test: `tests/posting.test.js` (إنشاء أولي باختبار واحد)

**Interfaces:**
- Consumes: لا شيء جديد — معالجات جاهزة.
- Produces: `sales:list` يعيد لكل صف `total_pieces` (مجموع حبات البنود)، وكذلك `reports:sales`.

- [ ] **Step 1: اكتب الاختبار الفاشل**

أنشئ `tests/posting.test.js` بالهيكل التالي:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { loadSchema, setDb } = require('../src/db');
const { registerHandlers } = require('../src/ipc');

const h = {};
const ipc = { handle: (name, fn) => { h[name] = fn; } };
const d = new DatabaseSync(':memory:');
loadSchema(d);
setDb(d);
registerHandlers(ipc);
```

ثم في نفس الملف أضف أول اختبار يتحقق من وجود `total_pieces`:

```js
test('sales:list يعيد مجموع حبات كل فاتورة', () => {
  const u = h['users:save'](null, { username: 'm', password: '123456', role: 'manager', full_name: 'م' }, 1);
  const p = h['parties:save'](null, { name: 'عميل', type: 'customer' }, 1);
  const it = h['items:save'](null, { code: '11', name: 'عبوة', unit_name: 'حبة', qty_salem: 100, qty_talef: 0, qty_muharraz: 0 }, 1);
  const w = h['warehouses:list']()[0];
  h['sales:save'](null, {
    doc_number: 'INV-1', doc_date: '2026-10-24', invoice_type: 'sale',
    party_id: p.id, payment_method: 'credit',
    items: [{ item_id: it.id, warehouse_id: w.id, quantity: 30, unit: 'pieces', unit_price: 0 }],
  }, u.id);
  const row = h['sales:list']().find(r => r.doc_number === 'INV-1');
  assert.equal(row.total_pieces, 30);
});
```

- [ ] **Step 2: شغّل الاختبار وتأكد أنه يفشل**

Run: `cd "/c/Users/Elite/Desktop/سام بلاستيك" && export PATH="/c/Program Files/nodejs:$PATH" && node --test tests/posting.test.js`
Expected: FAIL — `row.total_pieces` غير معرّف (undefined ≠ 30).

- [ ] **Step 3: أضف عمود الحبات للاستعلامين**

في `src/handlers/sales.js` غيّر استعلام `sales:list` إلى:

```js
return db.prepare(`SELECT p.*, pa.name party_name,
  (SELECT COALESCE(SUM(total_price),0) FROM invoice_items WHERE invoice_id=p.id) total,
  (SELECT COUNT(*) FROM invoice_items WHERE invoice_id=p.id) items_count,
  (SELECT COALESCE(SUM(pieces),0) FROM invoice_items WHERE invoice_id=p.id) total_pieces
  FROM invoices p LEFT JOIN parties pa ON pa.id=p.party_id
  ORDER BY p.id DESC`).all();
```

وفي `src/handlers/reports.js` أضف داخل `reports:sales` بنفس الأسلوب:

```js
(SELECT COALESCE(SUM(pieces),0) FROM invoice_items ii WHERE ii.invoice_id = inv.id) total_pieces
```

بعد `total` مباشرة في نفس قائمة الأعمدة.

- [ ] **Step 4: شغّل الاختبار وتأكد أنه يمر**

Run: `node --test tests/posting.test.js`
Expected: PASS.

- [ ] **Step 5: التزم**

```bash
git add src/handlers/sales.js src/handlers/reports.js tests/posting.test.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: إضافة مجموع الحبات لقوائم الفواتير وتقريرها"
```

---

### Task 2: شاشة «ترحيل الفواتير»

**Files:**
- Create: `renderer/js/screens/posting.js`
- Test: فحص صياغة (node --check) — لا اختبارات وحدة للرندرر في هذا المشروع.

**Interfaces:**
- Consumes: `sales:list` (بأعمدة منها `total_pieces` من المهمة 1), `sales:suggest`, `sales:get`, `sales:save`, `sales:void`, `parties:list`, `parties:save`, `items:list`, `warehouses:list`, `stock:balance`, `print:open` بنوع `invoice`, وأدوات `ui.js`: `toast, esc, renderTable, openModal, implicationsDialog, itemCombo`، و`fmt.js`: `fmtMoney, fmtNum, today`، و`units.js`: `unitOptionsFor, toPieces, piecesToWeightKg`، و`currentUser` من `api.js`.
- Produces: `register('posting', { title: 'ترحيل الفواتير', async mount(el) {...} })` — الشاشة التي تربطها المهمة 4.

- [ ] **Step 1: اكتب الشاشة كاملة**

أنشئ `renderer/js/screens/posting.js` بالمحتوى التالي (نمط شاشة المبيعات القديمة مع تبسيطات المهمة):

```js
import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, esc, renderTable, openModal, implicationsDialog, itemCombo } from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtMoney, fmtNum, today } from '../fmt.js';

register('posting', {
  title: 'ترحيل الفواتير',
  async mount(el) {
    async function load() {
      const rows = (await api.invoke('sales:list')).filter(r => r.invoice_type === 'sale');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ ترحيل فاتورة</button></div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      const active = rows.filter(r => r.status !== 'void');
      const pieces = rows.reduce((s, r) => s + (Number(r.total_pieces) || 0), 0);
      const money = active.reduce((s, r) => s + (Number(r.total) || 0), 0);
      el.querySelector('#summary').innerHTML =
        `عدد الفواتير: <b>${rows.length}</b> — النشطة: <b>${active.length}</b> — الحبات المرحلة: <b>${fmtNum(pieces, 0)} حبة</b>${money ? ` — الإجمالي: <b>${fmtMoney(money)}</b>` : ''}`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'party_name', label: 'العميل', render: r => r.party_name || '—' },
        { key: 'items_count', label: 'البنود' },
        { key: 'total_pieces', label: 'الحبات', render: r => fmtNum(r.total_pieces, 0) },
        { key: 'total', label: 'الإجمالي', render: r => fmtMoney(r.total) },
        { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغاة</span>' : '<span class="tag salem">نشطة</span>' },
        {
          key: 'actions', label: '',
          render: (r) => `<button class="btn mini" data-view="${r.id}">عرض</button>
            <button class="btn mini" data-print="${r.id}">طباعة</button>
            <button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-void="${r.id}">إلغاء</button>`,
        },
      ], rows);
      el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view(Number(b.dataset.view)));
      el.querySelectorAll('[data-print]').forEach(b => b.onclick = () => printDoc(Number(b.dataset.print)));
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(Number(b.dataset.edit)));
      el.querySelectorAll('[data-void]').forEach(b => b.onclick = () => voidDoc(Number(b.dataset.void)));
    }

    async function printDoc(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        await api.invoke('print:open', { kind: 'invoice', doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        openModal(`فاتورة ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>العميل:</b> ${esc(doc.party_name || '—')}
            &nbsp; <b>طريقة الدفع:</b> ${doc.payment_method === 'cash' ? 'نقدي' : 'آجل'}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الحبات</th><th>السعر</th><th>الإجمالي</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td>
            <td>${fmtMoney(it.unit_price)}</td>
            <td>${fmtMoney(it.total_price)}</td></tr>`).join('')}</tbody></table>
          <p style="margin-top:8px"><b>الإجمالي العام:</b> ${fmtMoney(doc.items.reduce((a, it) => a + (Number(it.total_price) || 0), 0))}</p>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'invoice', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        if (!(await implicationsDialog('تعديل فاتورة', [
          'ستُعكس حركة المخزون وأثر السلات الحالي ويُعاد تطبيق الفاتورة بالقيم الجديدة.',
        ]))) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        if (!(await implicationsDialog('إلغاء فاتورة', [
          `سيُلغى أثر الفاتورة ${esc(doc.doc_number)} على المخزون والسلات وتُعاد الكميات.`,
          'إن كانت بأسعار فسيُشطب أثرها المحاسبي أيضاً.',
        ]))) return;
        await api.invoke('sales:void', id, currentUser().id);
        toast('تم إلغاء الفاتورة', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    // حقل عميل ببحث ذكي + زر إضافة سريعة
    function partyField(box, parties, selectedId) {
      const field = document.createElement('div');
      field.className = 'party-combo';
      field.innerHTML = `
        <input type="text" class="ic-input" placeholder="ابحث باسم العميل…" autocomplete="off">
        <input type="hidden" class="p-party">
        <div class="ic-list" style="display:none"></div>
        <button type="button" class="btn mini" id="party-add">+ عميل جديد</button>`;
      const input = field.querySelector('.ic-input');
      const valueEl = field.querySelector('.p-party');
      const list = field.querySelector('.ic-list');
      let sel = null;
      function render() {
        const q = String(input.value || '').trim();
        const found = (q ? parties.filter(p => (p.name || '').includes(q)) : parties).slice(0, 60);
        list.innerHTML = found.length
          ? found.map(p => `<div class="ic-opt${p.id === sel ? ' sel' : ''}" data-id="${p.id}"><span class="ic-name">${esc(p.name)}</span></div>`).join('')
          : '<div class="ic-empty">لا يوجد عملاء مطابقون — أضف العميل بزر «+ عميل جديد»</div>';
        list.querySelectorAll('.ic-opt').forEach(o => {
          o.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(Number(o.dataset.id)); });
        });
        list.style.display = 'block';
      }
      function pick(id) {
        const p = parties.find(x => x.id === Number(id));
        if (!p) return;
        sel = p.id; valueEl.value = String(p.id); input.value = p.name; list.style.display = 'none';
      }
      input.addEventListener('focus', () => { input.select(); render(); });
      input.addEventListener('input', () => { sel = null; valueEl.value = ''; render(); });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); const first = list.querySelector('.ic-opt'); if (first) pick(Number(first.dataset.id)); }
        else if (ev.key === 'Escape') list.style.display = 'none';
      });
      input.addEventListener('blur', () => setTimeout(() => { if (!sel) { input.value = ''; valueEl.value = ''; } list.style.display = 'none'; }, 150));
      if (selectedId) pick(selectedId);
      field.querySelector('#party-add').onclick = async () => {
        const name = String(input.value || '').trim();
        const back = openModal('عميل جديد', `
          <div class="form-grid">
            <div class="field full"><label>اسم العميل *</label><input id="np-name" value="${esc(name)}"></div>
            <div class="field full"><label>الهاتف</label><input id="np-phone"></div>
          </div>`,
          [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
            const nm = String(b.querySelector('#np-name').value || '').trim();
            if (!nm) { toast('اسم العميل مطلوب', 'err'); return; }
            try {
              const saved = await api.invoke('parties:save', { id: null, name: nm, phone: b.querySelector('#np-phone').value, type: 'customer' }, currentUser().id);
              parties.push(saved);
              pick(saved.id);
              b.remove(); toast('تمت إضافة العميل', 'ok');
            } catch (e) { toast(String(e.message || e), 'err'); }
          } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
        if (back) back.querySelector('#np-name').focus();
      };
      return { box: field, getValue: () => valueEl.value };
    }

    async function form(doc) {
      const [items, partiesAll, warehouses] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('parties:list', null),
        api.invoke('warehouses:list'),
      ]);
      let parties = partiesAll.filter(p => p.type === 'customer' || p.type === 'both');
      const suggest = doc ? null : await api.invoke('sales:suggest');

      const back = openModal(doc ? `تعديل فاتورة ${esc(doc.doc_number)}` : 'ترحيل فاتورة جديدة', `
        <div class="form-grid">
          <div class="field"><label>رقم الفاتورة *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>العميل</label><span id="party-box"></span></div>
          <div class="field"><label>طريقة الدفع (عند إدخال أسعار)</label>
            <select id="f-pay">
              <option value="credit" ${doc && doc.payment_method !== 'cash' ? 'selected' : ''}>آجل (يُسجل على ذمة العميل)</option>
              <option value="cash" ${doc && doc.payment_method === 'cash' ? 'selected' : ''}>نقدي</option>
            </select></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الوحدة</th><th>الرصيد</th><th>السعر (اختياري)</th><th>الإجمالي</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="6"><b>الإجمالي العام</b></td>
            <td id="f-total">0</td><td colspan="2"></td>
          </tr></tfoot>
        </table>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const itemsData = [...b.querySelectorAll('#irows .irow')].map(r => ({
              item_id: Number(r.querySelector('.p-item').value),
              warehouse_id: Number(r.querySelector('.p-wh').value),
              quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
              unit: r.querySelector('.p-unit').value,
              unit_price: parseFloat(r.querySelector('.p-price').value) || 0,
              notes: r.querySelector('.p-notes').value,
            })).filter(x => x.item_id);
            await api.invoke('sales:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              invoice_type: 'sale',
              party_id: b.querySelector('.p-party').value ? Number(b.querySelector('.p-party').value) : null,
              payment_method: b.querySelector('#f-pay').value,
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الترحيل', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);

      const partyWrap = back.querySelector('#party-box');
      const pcombo = partyField(partyWrap, parties, doc ? doc.party_id : null);
      partyWrap.appendChild(pcombo.box);

      const rowsWrap = back.querySelector('#irows');
      const totalEl = back.querySelector('#f-total');
      const itemById = (id) => items.find(i => i.id === id);

      function updateTotal() {
        const total = [...rowsWrap.querySelectorAll('.irow')].reduce((s, r) => {
          const q = parseFloat(r.querySelector('.p-qty').value) || 0;
          const p = parseFloat(r.querySelector('.p-price').value) || 0;
          return s + q * p;
        }, 0);
        totalEl.textContent = fmtMoney(total);
      }

      function addRow(data = {}) {
        const row = document.createElement('tr');
        row.className = 'irow';
        row.innerHTML = `
          <td class="p-item-td"></td>
          <td><select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></td>
          <td><input class="p-qty num" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}"></td>
          <td><select class="p-unit"></select></td>
          <td><span class="bal-text muted"></span></td>
          <td><input class="p-price num" type="number" min="0" step="any" placeholder="اختياري" value="${esc(data.unit_price ?? '')}"></td>
          <td><span class="p-calc muted"></span></td>
          <td><input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}"></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        rowsWrap.appendChild(row);
        const combo = itemCombo(items, () => row.querySelector('.p-item').dispatchEvent(new Event('change')));
        row.querySelector('.p-item-td').appendChild(combo.box);
        row.querySelector('.p-del').onclick = () => { row.remove(); updateTotal(); };

        const itemSel = row.querySelector('.p-item');
        const whSel = row.querySelector('.p-wh');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
        const price = row.querySelector('.p-price');
        const balText = row.querySelector('.bal-text');
        const calc = row.querySelector('.p-calc');

        function refresh() {
          const item = itemById(Number(itemSel.value));
          if (!item) return;
          const cur = unitSel.value;
          const opts = unitOptionsFor(item);
          unitSel.innerHTML = opts.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
          if (opts.some(o => o.value === cur)) unitSel.value = cur;
          else if (data.unit && opts.some(o => o.value === data.unit)) unitSel.value = data.unit;
          update();
        }
        async function update() {
          const item = itemById(Number(itemSel.value));
          if (!item) return;
          balText.textContent = '…';
          try {
            const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
            balText.textContent = `الرصيد: ${fmtNum(bal.balance_pieces, 0)} حبة`;
          } catch { balText.textContent = ''; }
          const pieces = toPieces(qty.value, unitSel.value, item);
          const kg = piecesToWeightKg(pieces || 0, item?.weight_grams || 0);
          const p = parseFloat(price.value) || 0;
          const q = parseFloat(qty.value) || 0;
          calc.textContent = `${pieces != null ? fmtNum(pieces, 0) + ' حبة' + (kg ? ' — ' + fmtNum(kg) + ' كجم' : '') : '—'}${p && q ? ' — ' + fmtMoney(p * q) : ''}`;
          updateTotal();
        }
        itemSel.onchange = refresh;
        whSel.onchange = update;
        unitSel.onchange = update;
        qty.oninput = update;
        price.oninput = update;
        row._refresh = update;
        if (data.item_id) combo.setValue(data.item_id);
        if (data.warehouse_id) whSel.value = String(data.warehouse_id);
        refresh();
      }

      if (doc && doc.items.length) {
        for (const it of doc.items) {
          addRow({ item_id: it.item_id, warehouse_id: it.warehouse_id, quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, notes: it.notes });
        }
      } else {
        addRow();
      }
      back.querySelector('#add-row').onclick = () => addRow();
      updateTotal();
    }

    await load();
  },
});
```

ملاحظة على الوحدات: عند الاختبار ستمرر `unit: 'pieces'` أو أي وحدة يقبلها `toPieces` — انظر استدعاءات `sales:save` في الاختبارات القائمة (tests/stage6.test.js) لاختيار قيمة سليمة للوحدة، وإن كانت تختلف عن `pieces` عدّل أمثلة الاختبارات في المهمة 6 لتطابقها.

- [ ] **Step 2: افحص الصياغة**

Run: `cd "/c/Users/Elite/Desktop/سام بلاستيك" && cp renderer/js/screens/posting.js /tmp/posting.mjs && export PATH="/c/Program Files/nodejs:$PATH" && node --check /tmp/posting.mjs`
Expected: بلا أخطاء.

- [ ] **Step 3: التزم**

```bash
git add renderer/js/screens/posting.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: شاشة ترحيل الفواتير الخارجة بأسعار اختيارية"
```

---

### Task 3: شاشة «مرتجعات الفواتير»

**Files:**
- Create: `renderer/js/screens/salesreturns.js`

**Interfaces:**
- Consumes: `returns:list` (جزء `sales`), `returns:suggest` (`.sale`), `returns:getSale`, `returns:available`, `returns:save`, `returns:void`, `sales:list` (لفواتير sale النشطة), `print:open` بنوع `sale_return`، وأدوات `ui.js`/`units.js`/`fmt.js` كما في المهمة 2.
- Produces: `register('salesreturns', { title: 'مرتجعات الفواتير', async mount(el) {...} })`.

- [ ] **Step 1: اكتب الشاشة كاملة**

أنشئ `renderer/js/screens/salesreturns.js` بالنمط التالي (نفس بنية المهمة 2 مع اختلافات المرتجع):

- `load()`: `const { sales } = await api.invoke('returns:list');` ثم عرض الجدول بأعمدة: الرقم، التاريخ، `invoice_number` (رقم الفاتورة)، `party_name`، عدد البنود (من استعلام items؟ — إن لم يتوفر اجمع `items_count` بنفس أسلوب المهمة 1؟ لا: استخدم الحقول المتاحة من `returns:list` وهي `total` و`party_name` و`invoice_number`؛ أضف عمود «الإجمالي» و«الحالة» وأزرار عرض/طباعة/إلغاء).
  - ملاحظة: `returns:list` لا يعيد `items_count` ولا الحبات — يكفي الإجمالي المالي، وأضف في الملخص عدد المرتجعات النشطة ومجموع الإجمالي.
- `printDoc(id)`: `returns:getSale` ثم `print:open` بنوع `sale_return`.
- `view(id)`: نافذة ببيانات المرتجع وبنوده (رقم الفاتورة الأصلية، التاريخ، العميل، البنود مع الكمية والحبات).
- `voidDoc(id)`: `implicationsDialog` ثم `returns:void` مع `{ type: 'sale', id }`.
- `form(doc)`: تحميل `returns:suggest` (إن كان جديداً) و`sales:list` مصفاة إلى `invoice_type === 'sale' && status === 'active'`.
  - النموذج: رقم المرتجع (يدوي، `dir="ltr"`)، التاريخ، **اختيار الفاتورة** عبر `partyField`-مثيل مبسط على قائمة الفواتير (العرض: `رقم الفاتورة — اسم العميل`، والقيمة المخفية `invoice_id`)، طريقة الدفع، ملاحظات.
  - عند اختيار فاتورة: `const avail = await api.invoke('returns:available', 'sale', invoiceId);` ثم عرض جدول صغير للأصناف المتاحة مع المتبقي، وزر «+ إضافة بند» يعرض قائمة منسدلة من الأصناف ذات `remain > 0` فقط، وصف البند: صنف (ثابت بعد الاختيار)، الكمية، الوحدة، المتبقي، سعر اختياري مسبق التعبئة من `it.unit_price` إن وُجد، إجمالي، ملاحظات، حذف.
  - فحص الواجهة: الكمية بالحبات ≤ `remain` (رسالة `toast` فورية عند التجاوز وعدم السماح بالحفظ).
  - الحفظ: `returns:save` مع `{ id, type: 'sale', invoice_id, doc_number, doc_date, party_id: null, payment_method, notes, items }`.
  - إعادة عرض المتاح بعد الحفظ التعديلي (إلغاء الاختيار ثم إعادة التحميل) — في التعديل: اعرض الفاتورة الأصلية وبنود المرتجع الحالية مع السماح بتعديلها ضمن المتبقي المحسوب مع استبعاد المرتجع نفسه (الخلفية `returns:available` تقبل `excludeId`).
- زر `#add-row` يضيف بنداً باختيار الصنف من قائمة `select` مبنية من `avail` (الأصناف ذات المتبقي)، وعند اختيار الصنف تظهر وحدته ومتبقيه.

- [ ] **Step 2: افحص الصياغة**

Run: `cp renderer/js/screens/salesreturns.js /tmp/salesreturns.mjs && node --check /tmp/salesreturns.mjs`
Expected: بلا أخطاء.

- [ ] **Step 3: التزم**

```bash
git add renderer/js/screens/salesreturns.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: شاشة مرتجعات الفواتير المربوطة بالفاتورة الأصلية"
```

---

### Task 4: ربط القائمة والأدوار والاستيراد والشروحات

**Files:**
- Modify: `renderer/app.html:32-33` (إضافة مجموعة «المبيعات» وبنديها بعد «النفخ للغير»)
- Modify: `renderer/js/app.js` (الاستيرادات + ROLE_SCREENS)
- Modify: `renderer/js/help.js` (إدخالان جديدان)

**Interfaces:**
- Consumes: الشاشتان المسجلتان من المهمتين 2 و3 بأسمي `posting` و`salesreturns`.
- Produces: بندا القائمة `data-screen="posting"` و`data-screen="salesreturns"` يفتحان الشاشتين، و`helpFor('posting'/'salesreturns')` يعيد شروحاً.

- [ ] **Step 1: أضف بندي القائمة**

في `renderer/app.html` بعد سطر «النفخ للغير» (قبل `<div class="nav-group">المخازن</div>`) أدخل:

```html
      <div class="nav-group">المبيعات</div>
      <a data-screen="posting" class="nav-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14v18H5z"/><path d="M9 3v4h6V3"/><path d="M9 10h6M9 14h6M9 18h4"/></svg>ترحيل الفواتير</a>
      <a data-screen="salesreturns" class="nav-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-2 3h-2z"/><path d="M4 7h16v13H4z"/><path d="M9 13h6"/><path d="M12 11l-3 2 3 2"/></svg>مرتجعات الفواتير</a>
```

- [ ] **Step 2: استورد الشاشتين وأضف الأدوار**

في `renderer/js/app.js` أضف بعد استيراد `./screens/returns.js`:

```js
import './screens/posting.js';
import './screens/salesreturns.js';
```

وأضف `'posting', 'salesreturns'` إلى قوائم `clerk` و`viewer` و`warehouse` في `ROLE_SCREENS` (مثلاً بعد `'returns'` في كل قائمة).

- [ ] **Step 3: أضف الشروحات**

في `renderer/js/help.js` أضف بعد إدخال `returns`:

```js
  posting: {
    title: 'ترحيل الفواتير',
    lines: [
      'ترحيل فواتير صادرة من نظام المبيعات الخارجي: أدخل رقم الفاتورة يدوياً واسم العميل وأصنافها بكمياتها ومخازنها، فيخصم البرنامج السليم من المخازن فوراً.',
      'السعر اختياري: إن تركته فارغاً فلا أثر محاسبياً — مجرد خصم مخزني. وإن أدخلت أسعاراً يُسجل الإجمالي على ذمة العميل (آجل) أو يُقبض نقداً.',
      'لا يمكن الترحيل بكمية أكبر من رصيد المخزن، والرقم المكرر مرفوض، والتعديل والإلغاء يعكسان أثر المخزون تلقائياً.',
    ],
  },
  salesreturns: {
    title: 'مرتجعات الفواتير',
    lines: [
      'مرتجع بضاعة من عميل على فاتورة مرحلة سابقاً: اختر الفاتورة برقمها وتظهر أصنافها مع المتبقي القابل للإرجاع.',
      'الكمية المرتجعة تعود للمخزون والسلة فوراً، ولا يمكن إرجاع أكثر من كمية الفاتورة بعد خصم المرتجعات السابقة.',
      'لا يمكن إلغاء فاتورة عليها مرتجع نشط — ألغِ المرتجع أولاً. السعر اختياري كما في الترحيل.',
    ],
  },
```

- [ ] **Step 4: التزم**

```bash
git add renderer/app.html renderer/js/app.js renderer/js/help.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: ربط شاشتي المبيعات بالقائمة والأدوار مع شروحات"
```

---

### Task 5: تبويب «فواتير» في التقارير

**Files:**
- Modify: `renderer/js/screens/reports.js:35-193` (إضافة kind جديد في REPORTS)

**Interfaces:**
- Consumes: `reports:sales` (مع `total_pieces` من المهمة 1) وبنية REPORTS القائمة.
- Produces: تبويب `sales` يعمل عبر `api.invoke('reports:' + kind, ...)` القائم، مع حفظ أعمدة عبر `report-cols:sales`.

- [ ] **Step 1: أضف kind «فواتير»**

في `REPORTS` (بعد `purchases` وقبل `audit`) أضف:

```js
      sales: {
        label: 'فواتير البيع المرحلة',
        filterHtml: () => `
          <div class="field"><label>من تاريخ</label>${dateInput('r-from')}</div>
          <div class="field"><label>إلى تاريخ</label>${dateInput('r-to')}</div>
          <div class="field"><label>العميل</label>${selectHtml('r-party', [{ value: '', label: 'كل العملاء' }, ...parties.filter(p => p.type !== 'supplier').map(p => ({ value: p.id, label: p.name }))])}</div>`,
        getFilters: (el) => ({
          from: el.querySelector('#r-from').value || null,
          to: el.querySelector('#r-to').value || null,
          partyId: Number(el.querySelector('#r-party').value) || null,
        }),
        columns: [
          { key: 'doc_number', label: 'الرقم', cell: r => r.doc_number },
          { key: 'doc_date', label: 'التاريخ', cell: r => r.doc_date },
          { key: 'party_name', label: 'العميل', cell: r => r.party_name || '—' },
          { key: 'invoice_type', label: 'النوع', cell: r => r.invoice_type === 'sale' ? 'بيع' : r.invoice_type },
          { key: 'total_pieces', label: 'الحبات', cell: r => N(r.total_pieces) },
          { key: 'total', label: 'الإجمالي', cell: r => fmtMoney(r.total) },
          { key: 'notes', label: 'ملاحظات', cell: r => r.notes || '' },
        ],
        foot: (data) => `<div class="notes"><b>إجمالي الفواتير: ${fmtMoney(data.total)} — عددها: ${data.rows.length} — الحبات: ${N(data.rows.reduce((s, r) => s + (Number(r.total_pieces) || 0), 0))}</b></div>`,
      },
```

- [ ] **Step 2: افحص الصياغة**

Run: `cp renderer/js/screens/reports.js /tmp/reports.mjs && node --check /tmp/reports.mjs`
Expected: بلا أخطاء.

- [ ] **Step 3: التزم**

```bash
git add renderer/js/screens/reports.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "feat: تبويب فواتير البيع المرحلة في التقارير"
```

---

### Task 6: اختبارات الترحيل والمرتجع

**Files:**
- Modify: `tests/posting.test.js` (إكمال الاختبارات بعد اختبار المهمة 1)

**Interfaces:**
- Consumes: معالجات `sales:*` و`returns:*` و`items:save` و`parties:save` و`warehouses:list` و`users:save` (كما في أمثلة الاختبارات القائمة في tests/stage6.test.js وtests/returns.test.js — اطّلع عليهما لاستخدام نفس القيم السليمة للوحدات وحقول items).
- Produces: تغطية انحدار لسلوك الترحيل المطلوب.

- [ ] **Step 1: اكتب الاختبارات**

أضف إلى `tests/posting.test.js` (بعد اختبار المهمة 1، مع عامل مساعد `seed()` يجهز مستخدماً وعميلاً وصنفاً برصيد 100 حبة ومخزناً ويعيد المراجع):

1. `ترحيل بلا أسعار: خصم مخزني فقط بلا قيود محاسبية` — `sales:save` بسعر 0 ثم تحقق: `stock:balance` نقص 30، `party_ledger` بلا صفوف للفاتورة، وعدادات السلات سليمة (قارن `items.qty_salem` مع صافي الحركات بنمط items.test.js).
2. `ترحيل آجل بأسعار: ذمة مدين على العميل` — سعر 50 × 30 = 1500 → صف `party_ledger` بجانب `debit` وقيمة 1500.
3. `ترحيل نقدي بأسعار: قبض نقدي` — `payment_method: 'cash'` → `cash_in = total`.
4. `رقم الفاتورة مكرر مرفوض` — محاولة ثانية بنفس الرقم ترمي برسالة «مكرر».
5. `رصيد غير كافٍ مرفوض` — كمية أكبر من الرصيد ترمي «الرصيد غير كافٍ».
6. `تعديل الفاتورة يعكس القديم ويطبق الجديد` — حفظ ثم تعديل بكمية مختلفة → الرصيد = الأصلي − الكمية الجديدة، وحركات الفاتورة القديمة `void` (بنمط voidDoc في stock.js).
7. `إلغاء الفاتورة يعيد الكمية` — `sales:void` → الرصيد يعود 100.
8. `مرتجع مربوط بالفاتورة يعيد الكمية` — `returns:save` نوع `sale` على فاتورة مرحلة → الرصيد يرتفع بالمُرجَع، و`returns:available` يعرض المتبقي متناقصاً.
9. `منع تجاوز المتبقي في المرتجع` — إرجاع أكثر من كمية الفاتورة يرمي «تتجاوز المتبقي».
10. `مرتجع بأسعار يخفض الذمة` — فاتورة آجلة بأسعار ثم مرتجع بأسعار → صف `sale_return` دائن بنصف الإجمالي مثلاً.
11. `رفض إلغاء فاتورة عليها مرتجع نشط` — `sales:void` بعد مرتجع نشط يرمي «مرتجعات نشطة».

- [ ] **Step 2: شغّل اختبارات الملف**

Run: `node --test tests/posting.test.js`
Expected: PASS كاملة (وإن فشل أي اختبار فافحص الخلفية قبل تعديل الاختبار — السلوك الخلفي هو المرجع لأنه مُختبَر منذ إصدار المبيعات الأصلي).

- [ ] **Step 3: شغّل المجموعة كاملة**

Run: `node --test tests/*.test.js`
Expected: كل الاختبارات خضراء (154 + الجديدة).

- [ ] **Step 4: التزم**

```bash
git add tests/posting.test.js
git -c user.name="سام بلاستيك" -c user.email="dev@samplastic.local" commit -m "test: تغطية ترحيل الفواتير والمرتجعات بأسعار اختيارية"
```

---

### Task 7: الفحص البصري والتحقق النهائي وإعادة التشغيل

**Files:**
- Modify مؤقتاً ثم يعود لحاله: `main.js` (خطاف SHOT_DIR بلقطات دون أي حفظ بيانات)

**Interfaces:**
- لا واجهات جديدة. التحقق: اختبارات كاملة + لقطات + إعادة تشغيل.

- [ ] **Step 1: أضف خطاف اللقطات المؤقت**

في `main.js` داخل `app.whenReady()` أضف كتلة `if (process.env.SHOT_DIR) { ... }` بنمط الفحص السابق: إنشاء المجلد، `did-finish-load` ثم: لقطة 01-posting (شاشة الترحيل فارغة)، فتح النموذج بزر `#btn-add` ثم لقطة 02-posting-form، إغلاق النموذج، الانتقال لشاشة `salesreturns` ثم لقطة 03-salesreturns، فتح النموذج ولقطة 04-salesreturns-form، ثم `app.quit()`. **دون استدعاء أي حفظ أو كتابة في القاعدة** — فقط فتح نوافذ النماذج والتقاطها (حلقة إعادة المحاولة 5 مرات لكل capture كما سبق). الوصول للشاشات عبر `go('posting')` مباشرة أو بالنقر على `.nav-item[data-screen="posting"]`.

- [ ] **Step 2: شغّل البرنامج باللقطات**

Run: `cd "/c/Users/Elite/Desktop/سام بلاستيك" && export PATH="/c/Program Files/nodejs:$PATH" && unset ELECTRON_RUN_AS_NODE && SHOT_DIR=/c/Users/Elite/AppData/Local/Temp/samplastic-shots3 npm start`
Expected: 4 ملفات PNG في مجلد اللقطات.

- [ ] **Step 3: افحص اللقطات بصرياً**

اقرأ اللقطات الأربع وتحقق: الشاشتان تظهران بمجموعة «المبيعات» نشطة في القائمة، الجدول والفارغ سليمان، النموذجان منبثقان بحقول سليمة الاتجاه (رقم الفاتورة LTR، التاريخ بلا حروف معكوسة)، ألوان الهوية سليمة، وتباين النصوص مقبول.

- [ ] **Step 4: أزل الخطاف وتأكد من نظافة الملف**

احذف كتلة SHOT_DIR من `main.js` ثم: `git diff --stat main.js` — إن كان نظيفاً فلا التزام.

- [ ] **Step 5: الاختبارات النهائية**

Run: `node --test tests/*.test.js`
Expected: كلها خضراء.

- [ ] **Step 6: أعد تشغيل البرنامج وأبلغ المستخدم**

أعد تشغيل التطبيق بنمط التشغيل المعتاد، ثم أرسل تقريراً عربياً واحداً شاملاً: ما أُنجز، الشاشتان الجديدتان وكيفية الاستخدام، نتائج الاختبارات واللقطات، وأي قيود.
