import { api, currentUser } from './api.js';
import { fmtMoney, fmtNum } from './fmt.js';

export function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ===== صلاحية الكتابة =====
// دور «عرض فقط» يقرأ ولا يحرّر: لا أزرار حفظ ولا حذف في أي شاشة.
// الأدوار الأخرى (مدير/إدخال/مخازن) تكتب، والخلفية هي الحكم النهائي في كل عملية.
export function canWrite() {
  const u = currentUser();
  return !!u && u.role !== 'viewer';
}

// ===== تسمية وحدة الصنف =====
// «الحبة» هي الوحدة المرجعية في القاعدة، لكن ما يراه المستخدم هو unit_name للصنف
// (زجاجة/غطاء/كيس/أمبولة…). إن لم تُعرف القطعة المُقصودة بقيت «حبة» كمجمع عام.
export function unitOf(item) {
  return (item && (item.unit_name || item.raw_unit || item.fg_unit_name)) || 'حبة';
}

export function piecesText(pieces, item) {
  return `${fmtNum(pieces, 0)} ${unitOf(item)}`;
}

export function confirmDialog(msg) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" style="min-width:360px">
      <div class="modal-head"><span class="mh-dot"></span><h3>تأكيد العملية</h3></div>
      <div class="modal-body"><p style="line-height:1.9">${msg}</p></div>
      <div class="modal-foot actions">
        <button class="btn danger" id="c-yes">نعم</button>
        <button class="btn" id="c-no">إلغاء</button>
      </div></div>`;
    back.querySelector('#c-yes').onclick = () => { back.remove(); resolve(true); };
    back.querySelector('#c-no').onclick = () => { back.remove(); resolve(false); };
    document.body.appendChild(back);
  });
}

export function implicationsDialog(title, lines) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">
      <div class="modal-head"><span class="mh-dot"></span><h3>${title}</h3></div>
      <div class="modal-body">
        <ul style="padding-right:20px;line-height:2">${lines.map(l => `<li>${l}</li>`).join('')}</ul>
      </div>
      <div class="modal-foot actions">
        <button class="btn primary" id="i-ok">فهمت، متابعة</button>
        <button class="btn" id="i-cancel">إلغاء العملية</button>
      </div></div>`;
    back.querySelector('#i-ok').onclick = () => { back.remove(); resolve(true); };
    back.querySelector('#i-cancel').onclick = () => { back.remove(); resolve(false); };
    document.body.appendChild(back);
  });
}

export function explainDialog(title, lines) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" style="min-width:min(600px,94vw)">
      <div class="modal-head"><span class="mh-dot"></span><h3>${title} — شرح العملية</h3></div>
      <div class="modal-body">
        <ul style="padding-right:20px;line-height:2.1">${lines.map(l => `<li>${l}</li>`).join('')}</ul>
      </div>
      <div class="modal-foot actions">
        <button class="btn primary" id="x-ok">فهمت</button>
      </div></div>`;
    back.querySelector('#x-ok').onclick = () => { back.remove(); resolve(true); };
    document.body.appendChild(back);
  });
}

export function renderTable(el, columns, rows) {
  el.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>${columns.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr data-ri="${i}">${columns.map(c => `<td>${c.render ? c.render(r) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ===== خيارات وشارات السلات (سليم/تالف/محرز) =====
export function bucketOptions(selected) {
  const opts = [['salem', 'سليم'], ['talef', 'تالف'], ['muharraz', 'محرز']];
  return opts.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('');
}

export function bucketBadge(bucket) {
  const labels = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' };
  const b = ['salem', 'talef', 'muharraz'].includes(bucket) ? bucket : 'salem';
  return `<span class="tag ${b}">${labels[b]}</span>`;
}

// ===== قائمة كليك يمين لصفوف الجداول =====
// كليك يسار مزدوج على صف = «عرض» المستند (بلا أي حفظ ولا تأثير على البيانات)،
// ونقرة يمنى واحدة تعرض قائمة الإجراءات القياسية: عرض / طباعة / تعديل / حذف نهائي.
// attachRowMenu(عنصر_الجدول, (ri) => [ { label, danger, open, onClick } ])
//   أو (ri) => rowActions({ id, entity, view, print, edit, reload }) — وهي العناصر الثلاثة القياسية.
let ctxMenuEl = null;
function closeCtxMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
if (!document.__ctxWired) {
  document.__ctxWired = true;
  document.addEventListener('mousedown', (ev) => { if (ctxMenuEl && !ctxMenuEl.contains(ev.target)) closeCtxMenu(); });
  document.addEventListener('scroll', () => closeCtxMenu(), true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeCtxMenu(); });
}

// النقر المزدوج بالزر الأيسر على الصف يشغّل مُعالِج العرض فقط.
// النقرة الواحدة لا تُشغّل شيئاً، والضغط على زر أو حقل داخل الجدول لا يُحتسب نقرًا مزدوجًا.
export function bindRowDblClick(container, handler) {
  if (!container || container.__rowDbl) return;
  container.__rowDbl = true;
  container.addEventListener('dblclick', (ev) => {
    if (ev.button !== 0) return;                 // الزر الأيسر فقط
    if (ev.target.closest('button, input, select, textarea, a, .ctx-menu')) return;
    const tr = ev.target.closest('tr[data-ri]');
    if (!tr) return;
    ev.preventDefault();
    handler(Number(tr.dataset.ri));
  });
}

function resolveActions(actionOf, ri) {
  const out = actionOf(ri);
  return Array.isArray(out) ? out : [];
}

export function attachRowMenu(tableWrapEl, actionOf) {
  if (!tableWrapEl) return;
  // إعادة الاستدعاء بعد كل عرض للجدول تُحدّث مصفوفة الإجراءات فقط،
  // ولا تُضيف مستمعاً جديداً (حتى لا تتراكم المستمعات مع كل بحث أو عرض تقرير).
  if (tableWrapEl.__rowMenu) {
    tableWrapEl.__rowMenu.actionOf = actionOf;
    return;
  }
  const state = { actionOf };
  tableWrapEl.__rowMenu = state;
  // كليك يسار مزدوج على الصف = إجراء «الفتح» (عرض فقط دون أي حفظ)
  bindRowDblClick(tableWrapEl, (ri) => {
    const actions = resolveActions(state.actionOf, ri);
    const open = actions.find(a => a.open) || actions[0];
    if (open && open.onClick) open.onClick();
  });
  tableWrapEl.addEventListener('contextmenu', (ev) => {
    const tr = ev.target.closest('tr[data-ri]');
    if (!tr) return;
    ev.preventDefault();
    const actions = resolveActions(state.actionOf, Number(tr.dataset.ri));
    if (!actions.length) return;
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
}

// ===== العناصر القياسية لصف مستند: عرض / طباعة / تعديل / حذف نهائي =====
// confirmHardDelete تُرجع true عند نجاح الحذف فيُعاد تحميل الجدول تلقائياً.
// دور «عرض فقط» يحذف «تعديل» و«حذف» من القائمة ويبقى العرض والطباعة.
// payloadOf: للمستندات التي تُعرَّف بأكتر من رقم (مثل returns: { type, id }).
export function rowActions(opts) {
  const { id, entity, valueKind, impactChannel, deleteChannel, label, payloadOf } = opts;
  const readOnly = opts.readOnly === undefined ? !canWrite() : !!opts.readOnly;
  const items = [];
  if (opts.view) items.push({ label: 'عرض', open: true, onClick: () => opts.view(id) });
  if (opts.print) items.push({ label: 'طباعة', onClick: () => opts.print(id) });
  for (const x of (opts.extra || [])) if (x) items.push(x);
  if (opts.edit && !readOnly) items.push({ label: 'تعديل', onClick: () => opts.edit(id) });
  if (!readOnly && (entity || opts.del || opts.impactChannel)) {
    items.push({
      label: 'حذف', danger: true,
      onClick: async () => {
        const done = opts.del
          ? await opts.del(id)
          : await confirmHardDelete({ entity, id, valueKind, impactChannel, deleteChannel, label, payloadOf });
        if (done && opts.reload) await opts.reload();
      },
    });
  }
  return items;
}

// ===== الحذف النهائي للمستند (نافذة الأثر) =====
// الكيانات التي تُرجع <entity>:impact قيمة نقدية في حقل value؛ الباقي كميات بالحبات.
const MONEY_ENTITIES = new Set(['purchases', 'sales', 'payments', 'returns', 'tolling']);

function missingChannelError(channel, err) {
  const msg = String(err && err.message || err);
  if (/No handler registered/i.test(msg)) {
    toast(`خدمة الحذف النهائي (${channel}) غير مفعّلة بعد في قاعدة هذا الإصدار — لا يمكن حذف المستند من هنا`, 'err');
    return true;
  }
  toast(msg, 'err');
  return true;
}

function deleteDialogHtml(imp, entity, valueKind) {
  const lines = Array.isArray(imp.impact) ? imp.impact : [];
  const deps = Array.isArray(imp.deps) ? imp.deps : [];
  const blocked = !!imp.blocked || deps.length > 0;
  const ENTITY_LABEL = {
    purchases: 'فاتورة شراء', issues: 'تصريح صرف', production: 'استلام إنتاج',
    sales: 'فاتورة', exits: 'تصريح خروج', scrap: 'سند تالف', transfers: 'سند نقل',
    returns: 'مرتجع', payments: 'سند نقدية', tolling: 'سند نفخ للغير',
  };
  const docTitle = ENTITY_LABEL[entity] || 'المستند';
  const valueText = imp.value === null || imp.value === undefined
    ? ''
    : (valueKind === 'money' ? fmtMoney(imp.value) : `${fmtNum(imp.value, 0)} حبة`);
  return `
    <p class="del-doc">${docTitle}: <b dir="ltr">${esc(imp.doc_number || '—')}</b></p>
    <p class="del-warn">الحذف نهائي ولا يمكن التراجع عنه</p>
    <p class="del-note">يُمحى المستند مع حركات مخزونه وقيود دفتره، وتُردّ الكميات إلى أرصدتها في نفس اللحظة.</p>
    <h4 class="del-h">الأثر الذي سيرتدّ عند الحذف</h4>
    ${lines.length
      ? `<ul class="del-impact">${lines.map(l => `<li>${esc(l.text || l.code || '')}</li>`).join('')}</ul>`
      : '<p class="muted">لا حركة مخزون لهذا المستند (لا شيء يُردّ).</p>'}
    ${valueText ? `<p class="del-value">${valueKind === 'money' ? 'القيمة المالية للمستند' : 'الكمية المرجعية'}: <b>${valueText}</b></p>` : ''}
    ${blocked ? `<h4 class="del-h danger-text">موانع الحذف — مستندات أحدث مرتبطة به</h4>
      <ul class="del-deps">${deps.map(d => `<li>${esc(d.label || '')}${d.number ? ` — <b dir="ltr">${esc(d.number)}</b>` : ''}</li>`).join('')}</ul>
      <p class="del-note">احذف الأحدث أولاً ثم أعد المحاولة. لا يُعرض زر الحذف ما دام المانع موجوداً.</p>` : ''}`;
}

export async function confirmHardDelete({ entity, id, valueKind, impactChannel, deleteChannel, label, payloadOf }) {
  const impChannel = impactChannel || `${entity}:impact`;
  const delChannel = deleteChannel || `${entity}:delete`;
  const kind = valueKind || (MONEY_ENTITIES.has(entity) ? 'money' : 'pieces');
  const arg = payloadOf ? payloadOf(id) : id;
  let imp = null;
  try {
    imp = await api.invoke(impChannel, arg);
  } catch (e) {
    missingChannelError(impChannel, e);
    return false;
  }
  if (!imp) { toast('لم يُرجع فحص الأثر أي بيانات', 'err'); return false; }
  const deps = Array.isArray(imp.deps) ? imp.deps : [];
  const blocked = !!imp.blocked || deps.length > 0;
  const title = label ? `حذف ${label}` : 'تأكيد الحذف النهائي';
  return await new Promise((resolve) => {
    const buttons = blocked
      ? [{ label: 'حسناً', class: 'primary', onClick: (b) => { b.remove(); resolve(false); } }]
      : [
        { label: 'تأكيد الحذف النهائي', class: 'danger', onClick: async (b) => {
          b.remove();
          try {
            const res = await api.invoke(delChannel, arg, (currentUser() || {}).id);
            const num = res && res.doc_number ? ` ${res.doc_number}` : '';
            toast(`تم حذف المستند${num} — رُدّ أثر ${res && res.reverted != null ? res.reverted : 0} حركة`, 'ok');
            resolve(true);
          } catch (e) {
            missingChannelError(delChannel, e);
            resolve(false);
          }
        } },
        { label: 'إلغاء', onClick: (b) => { b.remove(); resolve(false); } },
      ];
    openModal(title, `<div class="del-modal">${deleteDialogHtml(imp, entity, kind)}</div>`, buttons);
  });
}

// فاتح النوافذ المنبثقة — يضبطه مدير النوافذ (wm.js) عند التشغيل،
// فتُفتح النماذج كنوافذ بشرائط تصغير/تكبير/إغلاق ويمكن فتح أكثر من واحدة معاً.
let popupOpener = null;
export function setPopupOpener(fn) { popupOpener = fn; }

export function openModal(title, bodyHtml, buttons) {
  if (popupOpener) {
    const pop = popupOpener(title, bodyHtml, buttons);
    if (pop) return pop;
  }
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">
    <div class="modal-head"><span class="mh-dot"></span><h3>${title}</h3><button class="mh-close" title="إغلاق">✕</button></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot actions"></div></div>`;
  const act = back.querySelector('.actions');
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = `btn ${b.class || ''}`; btn.textContent = b.label;
    btn.onclick = () => b.onClick(back);
    act.appendChild(btn);
  }
  back.querySelector('.mh-close').onclick = () => back.remove();
  document.body.appendChild(back);
  return back;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== حقل بحث الصنف الذكي =====
// خانة تبدأ فارغة، تُظهر قائمة منسدلة تُفلتر بكل حرف يطابق الكود أو الاسم،
// وتحفظ المعرّف في حقل مخفي بكلاس .p-item ليتوافق مع باقي الشاشات.
const comboRegistry = new Set();
let comboDocInit = false;
function comboGlobalHide() {
  if (comboDocInit) return;
  comboDocInit = true;
  document.addEventListener('mousedown', (ev) => {
    for (const c of comboRegistry) {
      if (!c.box.contains(ev.target)) c.hide();
    }
  });
}

export function itemCombo(items, onChange) {
  let selectedId = null;
  const box = document.createElement('div');
  box.className = 'item-combo';
  box.innerHTML = `
    <input type="text" class="ic-input" placeholder="ابحث باسم الصنف أو الكود…" autocomplete="off">
    <input type="hidden" class="p-item">
    <div class="ic-list" style="display:none"></div>`;
  const input = box.querySelector('.ic-input');
  const valueEl = box.querySelector('.p-item');
  const list = box.querySelector('.ic-list');

  function find(q) {
    q = String(q || '').trim();
    if (!q) return items;
    return items.filter(i => String(i.code).includes(q) || String(i.name || '').includes(q));
  }

  function renderList() {
    const found = find(input.value).slice(0, 60);
    list.innerHTML = found.length
      ? found.map(i => `<div class="ic-opt${i.id === selectedId ? ' sel' : ''}" data-id="${i.id}"><span class="ic-code" dir="ltr">${esc(i.code)}</span><span class="ic-name">${esc(i.name)}</span></div>`).join('')
      : '<div class="ic-empty">لا توجد أصناف مطابقة — أنشئ الصنف أولاً من شاشة الأصناف</div>';
    list.querySelectorAll('.ic-opt').forEach(o => {
      o.addEventListener('mousedown', (ev) => { ev.preventDefault(); select(Number(o.dataset.id)); });
    });
    list.style.display = 'block';
  }

  function select(id) {
    const item = items.find(i => i.id === Number(id));
    if (!item) return;
    selectedId = item.id;
    valueEl.value = String(item.id);
    input.value = `${item.code} — ${item.name}`;
    list.style.display = 'none';
    if (onChange) onChange(item.id, item);
  }

  function hide() { list.style.display = 'none'; }

  input.addEventListener('focus', () => { input.select(); renderList(); });
  input.addEventListener('input', () => { selectedId = null; valueEl.value = ''; renderList(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const first = list.querySelector('.ic-opt');
      if (first) select(Number(first.dataset.id));
    } else if (ev.key === 'Escape') {
      hide();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { if (!selectedId) { input.value = ''; valueEl.value = ''; } }, 150);
  });

  const combo = {
    box,
    hide,
    setValue(id) {
      const item = items.find(i => i.id === Number(id));
      if (!item) return;
      selectedId = item.id;
      valueEl.value = String(item.id);
      input.value = `${item.code} — ${item.name}`;
    },
    getValue: () => valueEl.value,
  };
  box._combo = combo;
  comboRegistry.add(combo);
  comboGlobalHide();
  return combo;
}

export function itemComboIn(container, items, onChange) {
  const combo = itemCombo(items, onChange);
  container.appendChild(combo.box);
  return combo;
}
