export function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
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
    <tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${c.render ? c.render(r) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
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
